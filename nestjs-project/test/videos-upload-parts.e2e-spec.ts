import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, IsNull, Not, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
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

// Spec: specs/videos-upload-parts.plan.md (SI-03.7). Real Postgres, Redis and
// minio via Compose service names; the Jest setup file sets
// S3_PUBLIC_ENDPOINT = S3_ENDPOINT, so signed URLs can be PUT from here.

interface UploadSessionBody {
  id: string;
  partCount: number;
}

interface SignedPartsBody {
  parts: { partNumber: number; url: string }[];
  expiresAt: string;
}

interface UploadedPartsBody {
  parts: { partNumber: number; etag: string; size: number }[];
}

interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string | string[];
}

const VIDEO_BODY = {
  filename: 'clip.mp4',
  size: 1048576,
  contentType: 'video/mp4',
};

const ONE_HOUR_MS = 3600 * 1000;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const UPLOAD_NOT_ACTIVE = {
  statusCode: 409,
  error: 'VIDEO_UPLOAD_NOT_ACTIVE',
  message: 'Video has no active upload session',
};

describe('Videos — part signing and upload resume (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let videoRepository: Repository<Video>;
  let userA: AuthenticatedUser;
  let userB: AuthenticatedUser;
  let videoId: string;

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
    videoId = (await startDraft(VIDEO_BODY)).id;
  });

  // Rows that still carry an upload_id may keep a multipart session open in
  // minio (aborting one that is already gone is a no-op).
  async function abortOpenUploads(): Promise<void> {
    const rows = await videoRepository.find({
      where: { upload_id: Not(IsNull()) },
    });
    for (const row of rows) {
      await storage.abortMultipartUpload(originalKey(row.id), row.upload_id!);
    }
  }

  async function startDraft(body: object): Promise<UploadSessionBody> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send(body)
      .expect(201);
    return res.body as UploadSessionBody;
  }

  function signParts(
    id: string,
    body: object | undefined,
    token?: string,
  ): request.Test {
    const req = request(app.getHttpServer()).post(`/videos/${id}/upload/parts`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  }

  function listParts(id: string, token?: string): request.Test {
    const req = request(app.getHttpServer()).get(`/videos/${id}/upload/parts`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  async function putPart(url: string, bytes: Buffer): Promise<Response> {
    return fetch(url, { method: 'PUT', body: new Uint8Array(bytes) });
  }

  // ── 1. POST /videos/:id/upload/parts ───────────────────────────────

  it('1.1 sign-part-returns-public-url-with-one-hour-expiry', async () => {
    const before = Date.now();
    const res = await signParts(
      videoId,
      { partNumbers: [1] },
      userA.accessToken,
    ).expect(200);

    const body = res.body as SignedPartsBody;
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'parts']);
    expect(body.parts).toHaveLength(1);
    expect(body.parts[0].partNumber).toBe(1);

    const url = new URL(body.parts[0].url);
    expect(url.host).toBe(new URL(process.env.S3_PUBLIC_ENDPOINT!).host);
    expect(url.pathname.endsWith(`/${originalKey(videoId)}`)).toBe(true);
    const row = await videoRepository.findOneByOrFail({ id: videoId });
    expect(url.searchParams.get('partNumber')).toBe('1');
    expect(url.searchParams.get('uploadId')).toBe(row.upload_id);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    const queryKeys = [...url.searchParams.keys()].map((k) => k.toLowerCase());
    expect(queryKeys).not.toContain('x-amz-sdk-checksum-algorithm');
    expect(queryKeys.filter((k) => k.startsWith('x-amz-checksum-'))).toEqual(
      [],
    );

    expect(body.expiresAt).toMatch(ISO_8601);
    const expiresAt = Date.parse(body.expiresAt);
    expect(Math.abs(expiresAt - (before + ONE_HOUR_MS))).toBeLessThanOrEqual(
      60_000,
    );
  });

  it('1.2 sign-multiple-parts-for-multi-part-video', async () => {
    const session = await startDraft({ ...VIDEO_BODY, size: 67108865 });
    expect(session.partCount).toBe(2);

    const res = await signParts(
      session.id,
      { partNumbers: [1, 2] },
      userA.accessToken,
    ).expect(200);

    const { parts } = res.body as SignedPartsBody;
    expect(parts.map((p) => p.partNumber)).toEqual([1, 2]);
    expect(parts[0].url).not.toBe(parts[1].url);
  });

  it('1.3 signed-url-accepts-plain-put', async () => {
    const res = await signParts(
      videoId,
      { partNumbers: [1] },
      userA.accessToken,
    ).expect(200);
    const { parts } = res.body as SignedPartsBody;

    const put = await putPart(parts[0].url, randomBytes(1024));

    expect(put.status).toBe(200);
    expect(put.headers.get('etag')).toBeTruthy();
  });

  it('1.4 sign-rejects-part-above-part-count', async () => {
    const above = await signParts(
      videoId,
      { partNumbers: [2] },
      userA.accessToken,
    ).expect(400);
    expect(above.body).toEqual({
      statusCode: 400,
      error: 'UPLOAD_PARTS_INVALID',
      message: 'Upload parts are invalid',
    });

    const mixed = await signParts(
      videoId,
      { partNumbers: [1, 2] },
      userA.accessToken,
    ).expect(400);
    expect((mixed.body as ErrorResponseBody).error).toBe(
      'UPLOAD_PARTS_INVALID',
    );
    expect(mixed.body).not.toHaveProperty('parts');
  });

  it('1.5 sign-rejects-invalid-part-numbers-body', async () => {
    const invalidBodies: (object | undefined)[] = [
      { partNumbers: [] },
      { partNumbers: [1, 1] },
      { partNumbers: [0] },
      undefined,
    ];

    for (const body of invalidBodies) {
      const res = await signParts(videoId, body, userA.accessToken).expect(400);
      expect((res.body as ErrorResponseBody).error).toBe('VALIDATION_ERROR');
    }

    const malformed = await signParts(
      'not-a-uuid',
      { partNumbers: [1] },
      userA.accessToken,
    ).expect(400);
    expect((malformed.body as ErrorResponseBody).error).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('1.6 sign-rejects-non-draft-video', async () => {
    for (const status of [
      VideoStatus.PROCESSING,
      VideoStatus.READY,
      VideoStatus.FAILED,
    ]) {
      await videoRepository.update({ id: videoId }, { status });

      const res = await signParts(
        videoId,
        { partNumbers: [1] },
        userA.accessToken,
      ).expect(409);

      expect(res.body).toEqual(UPLOAD_NOT_ACTIVE);
    }
  });

  it('1.7 sign-hides-other-users-video', async () => {
    const notOwned = await signParts(
      videoId,
      { partNumbers: [1] },
      userB.accessToken,
    ).expect(404);
    expect((notOwned.body as ErrorResponseBody).error).toBe('VIDEO_NOT_FOUND');

    const unknown = await signParts(
      randomUUID(),
      { partNumbers: [1] },
      userA.accessToken,
    ).expect(404);
    expect((unknown.body as ErrorResponseBody).error).toBe('VIDEO_NOT_FOUND');

    await signParts(videoId, { partNumbers: [1] }).expect(401);
  });

  // ── 2. GET /videos/:id/upload/parts ────────────────────────────────

  it('2.1 list-parts-empty-before-any-upload', async () => {
    const res = await listParts(videoId, userA.accessToken).expect(200);

    expect(res.body).toEqual({ parts: [] });
  });

  it('2.2 list-parts-returns-uploaded-part-for-resume', async () => {
    const signed = await signParts(
      videoId,
      { partNumbers: [1] },
      userA.accessToken,
    ).expect(200);
    const put = await putPart(
      (signed.body as SignedPartsBody).parts[0].url,
      randomBytes(1024),
    );
    expect(put.status).toBe(200);
    const etag = put.headers.get('etag');

    const res = await listParts(videoId, userA.accessToken).expect(200);

    expect(res.body as UploadedPartsBody).toEqual({
      parts: [{ partNumber: 1, etag, size: 1024 }],
    });
  });

  it('2.3 list-parts-rejects-non-draft-video', async () => {
    await videoRepository.update(
      { id: videoId },
      { status: VideoStatus.PROCESSING },
    );

    const res = await listParts(videoId, userA.accessToken).expect(409);

    expect((res.body as ErrorResponseBody).error).toBe(
      'VIDEO_UPLOAD_NOT_ACTIVE',
    );
  });

  it('2.4 list-parts-409-when-storage-upload-gone', async () => {
    const row = await videoRepository.findOneByOrFail({ id: videoId });
    await storage.abortMultipartUpload(originalKey(videoId), row.upload_id!);

    const res = await listParts(videoId, userA.accessToken).expect(409);

    expect(res.body).toEqual(UPLOAD_NOT_ACTIVE);
    const after = await videoRepository.findOneByOrFail({ id: videoId });
    expect(after.status).toBe(VideoStatus.DRAFT);
  });

  it('2.5 list-parts-hides-other-users-video', async () => {
    const notOwned = await listParts(videoId, userB.accessToken).expect(404);
    expect((notOwned.body as ErrorResponseBody).error).toBe('VIDEO_NOT_FOUND');

    const malformed = await listParts('not-a-uuid', userA.accessToken).expect(
      400,
    );
    expect((malformed.body as ErrorResponseBody).error).toBe(
      'VALIDATION_ERROR',
    );

    await listParts(videoId).expect(401);
  });
});
