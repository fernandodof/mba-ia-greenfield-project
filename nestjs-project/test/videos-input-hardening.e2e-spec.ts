import { randomBytes } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, IsNull, Not, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import {
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from '../src/videos/video-queue.constants';
import { originalKey } from '../src/videos/video-storage-keys';
import { VideoStatus } from '../src/videos/video.types';
import {
  createAuthenticatedUser,
  type AuthenticatedUser,
} from './helpers/authenticated-user';

// Post-QA regression (bug 4): malformed input used to escape validation and
// answer 500 (null title → `null.trim()`, NUL → PostgreSQL `invalid byte
// sequence`, CR/LF/non-ASCII contentType → SDK header error, NUL etag →
// storage MalformedXML). Each must now be a 4xx in the error envelope.
// Real Postgres, Redis (QUEUE_PREFIX=bull-test) and minio.

interface UploadSessionBody {
  id: string;
  slug: string;
}

interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string | string[];
}

const VALID_BODY = {
  filename: 'clip.mp4',
  size: 1024,
  contentType: 'video/mp4',
};

describe('videos-input-hardening', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue<VideoProcessingJobData>;
  let videoRepository: Repository<Video>;
  let owner: AuthenticatedUser;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    storage = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    queue = app.get<Queue<VideoProcessingJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await releaseStorage();
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    await app.close();
  });

  beforeEach(async () => {
    await releaseStorage();
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    await queue.obliterate({ force: true });
    owner = await createAuthenticatedUser(app, dataSource, 'owner@example.com');
  });

  // Aborts sessions still referenced by a row and deletes leftover originals.
  async function releaseStorage(): Promise<void> {
    const open = await videoRepository.find({
      where: { upload_id: Not(IsNull()) },
    });
    for (const row of open) {
      await storage.abortMultipartUpload(originalKey(row.id), row.upload_id!);
    }
    for (const row of await videoRepository.find()) {
      await storage.deleteObject(originalKey(row.id));
    }
  }

  function postVideo(body: object): request.Test {
    return request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send(body);
  }

  async function expectValidationError(res: request.Response): Promise<void> {
    expect(res.status).toBe(400);
    const body = res.body as ErrorResponseBody;
    expect(body.statusCode).toBe(400);
    expect(body.error).toBe('VALIDATION_ERROR');
    expect(Array.isArray(body.message)).toBe(true);
    await expect(videoRepository.count()).resolves.toBe(0);
  }

  describe('POST /videos', () => {
    it('rejects-a-null-title-instead-of-defaulting-it', async () => {
      const res = await postVideo({ ...VALID_BODY, title: null });

      await expectValidationError(res);
      expect((res.body as ErrorResponseBody).message).toEqual(
        expect.arrayContaining(['title must be a string']),
      );
    });

    it.each([
      ['NUL in title', { title: 'My\u0000video' }],
      ['NUL-only title', { title: '\u0000' }],
      ['LF in title', { title: 'line\nbreak' }],
      ['CR in title', { title: 'carriage\rreturn' }],
      ['TAB in title', { title: 'tab\tbed' }],
      ['ESC in title', { title: 'esc\u001B[31m' }],
      ['DEL in title', { title: 'del\u007F' }],
      ['NUL in filename', { filename: 'clip\u0000.mp4' }],
      ['LF in filename', { filename: 'clip\n.mp4' }],
      ['DEL in filename', { filename: 'clip\u007F.mp4' }],
    ])('rejects-%s', async (_label, override) => {
      await expectValidationError(
        await postVideo({ ...VALID_BODY, ...override }),
      );
    });

    it.each([
      ['CRLF header injection', 'video/mp4\r\nX-Injected: 1'],
      ['a bare LF', 'video/mp4\n'],
      ['a NUL byte', 'video/mp4\u0000'],
      ['non-ASCII', 'video/mp4é'],
      ['a non-ASCII parameter', 'video/mp4; name=vídeo'],
      ['an emoji', 'video/\u{1F3AC}'],
      ['a missing subtype', 'video/'],
      ['a space in the subtype', 'video/mp 4'],
      ['leading whitespace', ' video/mp4'],
      ['a dangling parameter', 'video/mp4;'],
    ])('rejects-a-contentType-with-%s', async (_label, contentType) => {
      const res = await postVideo({ ...VALID_BODY, contentType });

      await expectValidationError(res);
      expect((res.body as ErrorResponseBody).message).toEqual([
        'contentType must be a video/* media type in visible ASCII (optional ; parameters)',
      ]);
    });

    it('accepts-contentType-parameters-and-opens-the-session', async () => {
      const contentType = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';

      const res = await postVideo({ ...VALID_BODY, contentType }).expect(201);

      const row = await videoRepository.findOneByOrFail({
        id: (res.body as UploadSessionBody).id,
      });
      expect(row.content_type).toBe(contentType);
      await expect(
        storage.listParts(originalKey(row.id), row.upload_id!),
      ).resolves.toEqual([]);
    });

    it('keeps-accepting-emoji-accented-and-rtl-titles-and-filenames', async () => {
      const title = '\u{1F3AC} Férias à noite — فيديو עברית 動画';
      const filename = '\u{1F600} vídeo_مقطع.mp4';

      const explicit = await postVideo({
        ...VALID_BODY,
        title,
        filename,
      }).expect(201);
      const derived = await postVideo({ ...VALID_BODY, filename }).expect(201);

      const explicitRow = await videoRepository.findOneByOrFail({
        id: (explicit.body as UploadSessionBody).id,
      });
      expect(explicitRow.title).toBe(title);
      expect(explicitRow.original_filename).toBe(filename);
      const derivedRow = await videoRepository.findOneByOrFail({
        id: (derived.body as UploadSessionBody).id,
      });
      expect(derivedRow.title).toBe('\u{1F600} vídeo_مقطع');
      expect(derivedRow.original_filename).toBe(filename);
    });
  });

  describe('GET /videos/:slug/stream and /download', () => {
    it.each([
      ['%00', 'stream'],
      ['%00', 'download'],
      ['abcd%00efghij', 'stream'],
      ['tooshort', 'download'],
      ['AbCdEfGhIjKl', 'stream'],
      ['AbCdE.GhIjK', 'download'],
    ])(
      'answers-404-for-the-impossible-slug-%s-on-%s-without-auth',
      async (slug, mode) => {
        const res = await request(app.getHttpServer())
          .get(`/videos/${slug}/${mode}`)
          .expect(404);

        expect(res.body).toEqual({
          statusCode: 404,
          error: 'VIDEO_NOT_FOUND',
          message: 'Video not found',
        });
      },
    );
  });

  describe('POST /videos/:id/upload/complete', () => {
    const ETAG_SHAPE =
      'parts.0.etag must be an S3 ETag (visible ASCII, optionally quoted)';
    const ETAG_TOO_LONG =
      'parts.0.etag must be shorter than or equal to 128 characters';

    it.each([
      ['a NUL byte', '"9b2cf535f27731c974343645a3985328\u0000"', ETAG_SHAPE],
      ['a LF', '"9b2cf535f27731c974343645a3985328"\n', ETAG_SHAPE],
      ['non-ASCII', '"9b2cf535f27731c97434364ñ"', ETAG_SHAPE],
      ['an inner space', '"9b2cf535 f27731c974343645a3985328"', ETAG_SHAPE],
      ['an unbalanced quote', '"9b2cf535f27731c974343645a3985328', ETAG_SHAPE],
      ['more than 128 characters', `"${'a'.repeat(127)}"`, ETAG_TOO_LONG],
    ])(
      'rejects-an-etag-with-%s-and-keeps-the-draft',
      async (_label, etag, expectedMessage) => {
        const started = await postVideo(VALID_BODY).expect(201);
        const { id } = started.body as UploadSessionBody;
        const [signed] = (
          (
            await request(app.getHttpServer())
              .post(`/videos/${id}/upload/parts`)
              .set('Authorization', `Bearer ${owner.accessToken}`)
              .send({ partNumbers: [1] })
              .expect(200)
          ).body as { parts: { url: string }[] }
        ).parts;
        const put = await fetch(signed.url, {
          method: 'PUT',
          body: new Uint8Array(randomBytes(VALID_BODY.size)),
        });
        expect(put.status).toBe(200);

        const res = await request(app.getHttpServer())
          .post(`/videos/${id}/upload/complete`)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send({ parts: [{ partNumber: 1, etag }] })
          .expect(400);

        expect((res.body as ErrorResponseBody).error).toBe('VALIDATION_ERROR');
        expect((res.body as ErrorResponseBody).message).toEqual([
          expectedMessage,
        ]);
        const row = await videoRepository.findOneByOrFail({ id });
        expect(row.status).toBe(VideoStatus.DRAFT);
        expect(row.upload_id).toEqual(expect.any(String));
        await expect(queue.getJob(id)).resolves.toBeUndefined();

        // The real MinIO ETag (`"<32 hex>"`) still passes the new rule.
        await request(app.getHttpServer())
          .post(`/videos/${id}/upload/complete`)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send({ parts: [{ partNumber: 1, etag: put.headers.get('etag') }] })
          .expect(200);
      },
    );
  });
});
