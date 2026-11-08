import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, IsNull, Not, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { originalKey } from '../src/videos/video-storage-keys';
import { VideoStatus } from '../src/videos/video.types';
import {
  createAuthenticatedUser,
  type AuthenticatedUser,
} from './helpers/authenticated-user';

// Spec: specs/videos-start-upload.plan.md (SI-03.6). Real Postgres, Redis and
// minio via Compose service names; the Jest setup file signs URLs for the
// internal endpoint and isolates the BullMQ prefix.

interface UploadSessionBody {
  id: string;
  slug: string;
  status: string;
  partSize: number;
  partCount: number;
}

interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string | string[];
}

type VideoBody = Record<string, unknown>;

const VALID_BODY = {
  filename: 'clip.mp4',
  size: 1048576,
  contentType: 'video/mp4',
};

const VIDEO_FIELDS = [
  'id',
  'slug',
  'title',
  'status',
  'failureReason',
  'originalFilename',
  'contentType',
  'sizeBytes',
  'durationMs',
  'width',
  'height',
  'videoCodec',
  'createdAt',
  'updatedAt',
].sort();

const HIDDEN_FIELDS = [
  'uploadId',
  'upload_id',
  'thumbnailKey',
  'thumbnail_key',
  'processingStartedAt',
  'processing_started_at',
];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

describe('Videos — start upload and owner read (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let videoRepository: Repository<Video>;
  let userA: AuthenticatedUser;
  let userB: AuthenticatedUser;

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
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await abortOpenUploads();
    await cleanAllTables(dataSource);
    await app.close();
  });

  beforeEach(async () => {
    await abortOpenUploads();
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    userA = await createAuthenticatedUser(app, dataSource, 'owner@example.com');
    userB = await createAuthenticatedUser(app, dataSource, 'other@example.com');
  });

  // Drafts left by a test keep a multipart session open in minio.
  async function abortOpenUploads(): Promise<void> {
    const drafts = await videoRepository.find({
      where: { upload_id: Not(IsNull()) },
    });
    for (const draft of drafts) {
      await storage.abortMultipartUpload(
        originalKey(draft.id),
        draft.upload_id!,
      );
    }
  }

  function postVideo(body: object, token?: string): request.Test {
    const req = request(app.getHttpServer()).post('/videos').send(body);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  function getVideo(id: string, token?: string): request.Test {
    const req = request(app.getHttpServer()).get(`/videos/${id}`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  async function startDraft(): Promise<UploadSessionBody> {
    const res = await postVideo(VALID_BODY, userA.accessToken).expect(201);
    return res.body as UploadSessionBody;
  }

  // ── 1. POST /videos ────────────────────────────────────────────────

  it('1.1 start-upload-creates-draft-with-derived-title', async () => {
    const res = await postVideo(VALID_BODY, userA.accessToken).expect(201);

    const body = res.body as UploadSessionBody;
    expect(Object.keys(body).sort()).toEqual(
      ['id', 'slug', 'status', 'partSize', 'partCount'].sort(),
    );
    expect(body.id).toMatch(UUID_PATTERN);
    expect(body.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(body).toMatchObject({
      status: 'draft',
      partSize: 67108864,
      partCount: 1,
    });

    const row = await videoRepository.findOneByOrFail({ id: body.id });
    expect(row).toMatchObject({
      title: 'clip',
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 1048576,
      status: VideoStatus.DRAFT,
    });
    expect(row.upload_id).not.toBeNull();
    const channel = await dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: userA.userId });
    expect(row.channel_id).toBe(channel.id);
  });

  it('1.2 start-upload-keeps-explicit-title-and-computes-part-count', async () => {
    const res = await postVideo(
      {
        title: '  My first video  ',
        filename: 'raw.mov',
        size: 67108865,
        contentType: 'video/quicktime',
      },
      userA.accessToken,
    ).expect(201);
    const body = res.body as UploadSessionBody;
    expect(body.partCount).toBe(2);
    const row = await videoRepository.findOneByOrFail({ id: body.id });
    expect(row.title).toBe('My first video');

    const emojiTitle = '🎬'.repeat(100);
    expect(emojiTitle.length).toBe(200);
    const emojiRes = await postVideo(
      { ...VALID_BODY, title: emojiTitle },
      userA.accessToken,
    ).expect(201);
    const emojiRow = await videoRepository.findOneByOrFail({
      id: (emojiRes.body as UploadSessionBody).id,
    });
    expect(emojiRow.title).toBe(emojiTitle);
  });

  it('1.3 start-upload-opens-multipart-session-in-storage', async () => {
    const body = await startDraft();

    const row = await videoRepository.findOneByOrFail({ id: body.id });
    await expect(
      storage.listParts(`videos/${body.id}/original`, row.upload_id!),
    ).resolves.toEqual([]);
  });

  it('1.4 start-upload-rejects-invalid-body', async () => {
    const invalidBodies: object[] = [
      { ...VALID_BODY, title: 'a'.repeat(101) },
      { ...VALID_BODY, size: 10737418241 },
      { ...VALID_BODY, contentType: 'image/png' },
      { ...VALID_BODY, title: '   ' },
      { ...VALID_BODY, uploadId: 'x' },
    ];

    for (const body of invalidBodies) {
      const res = await postVideo(body, userA.accessToken).expect(400);
      const error = res.body as ErrorResponseBody;
      expect(error.error).toBe('VALIDATION_ERROR');
      expect(Array.isArray(error.message)).toBe(true);
    }

    await expect(videoRepository.count()).resolves.toBe(0);
  });

  it('1.5 start-upload-requires-access-token', async () => {
    await postVideo(VALID_BODY).expect(401);
    await postVideo(VALID_BODY, 'not-a-jwt').expect(401);

    await expect(videoRepository.count()).resolves.toBe(0);
  });

  it('1.6 start-upload-not-rate-limited', async () => {
    for (let i = 0; i < 11; i++) {
      await postVideo(VALID_BODY, userA.accessToken).expect(201);
    }

    await expect(videoRepository.count()).resolves.toBe(11);
  });

  // ── 2. GET /videos/:id ─────────────────────────────────────────────

  it('2.1 owner-reads-fresh-draft', async () => {
    const { id, slug } = await startDraft();

    const res = await getVideo(id, userA.accessToken).expect(200);

    const body = res.body as VideoBody;
    expect(Object.keys(body).sort()).toEqual(VIDEO_FIELDS);
    expect(body).toMatchObject({
      id,
      slug,
      status: 'draft',
      title: 'clip',
      originalFilename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1048576,
      failureReason: null,
      durationMs: null,
      width: null,
      height: null,
      videoCodec: null,
    });
    expect(typeof body.sizeBytes).toBe('number');
    expect(body.createdAt).toMatch(ISO_8601);
    expect(body.updatedAt).toMatch(ISO_8601);
    for (const field of HIDDEN_FIELDS) {
      expect(body).not.toHaveProperty(field);
    }
  });

  it('2.2 owner-reads-video-in-any-status', async () => {
    const { id } = await startDraft();
    const draft = await videoRepository.findOneByOrFail({ id });
    // The test changes the status itself, so close the storage session now.
    await storage.abortMultipartUpload(originalKey(id), draft.upload_id!);

    await videoRepository.update(
      { id },
      {
        status: VideoStatus.FAILED,
        failure_reason: 'UPLOAD_ABORTED',
        upload_id: null,
      },
    );
    const failed = await getVideo(id, userA.accessToken).expect(200);
    expect(failed.body).toMatchObject({
      status: 'failed',
      failureReason: 'UPLOAD_ABORTED',
    });

    await videoRepository.update(
      { id },
      {
        status: VideoStatus.READY,
        failure_reason: null,
        duration_ms: 5000,
        width: 640,
        height: 360,
        video_codec: 'h264',
        thumbnail_key: `videos/${id}/thumbnail.jpg`,
      },
    );
    const ready = await getVideo(id, userA.accessToken).expect(200);
    const body = ready.body as VideoBody;
    expect(body).toMatchObject({
      status: 'ready',
      durationMs: 5000,
      width: 640,
      height: 360,
      videoCodec: 'h264',
    });
    expect(Object.keys(body).sort()).toEqual(VIDEO_FIELDS);
    expect(JSON.stringify(body)).not.toContain('thumbnail');
  });

  it('2.3 non-owner-and-unknown-id-get-404', async () => {
    const { id } = await startDraft();

    const notOwned = await getVideo(id, userB.accessToken).expect(404);
    expect(notOwned.body).toEqual({
      statusCode: 404,
      error: 'VIDEO_NOT_FOUND',
      message: 'Video not found',
    });

    const unknown = await getVideo(randomUUID(), userA.accessToken).expect(404);
    expect(unknown.body).toEqual(notOwned.body);
  });

  it('2.4 malformed-id-and-missing-token-rejected', async () => {
    const { id } = await startDraft();

    const malformed = await getVideo('not-a-uuid', userA.accessToken).expect(
      400,
    );
    expect((malformed.body as ErrorResponseBody).error).toBe(
      'VALIDATION_ERROR',
    );

    await getVideo(id).expect(401);
  });
});
