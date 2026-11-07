import { randomBytes, randomUUID } from 'node:crypto';
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

// Spec: specs/videos-upload-complete.plan.md (SI-03.9). Real Postgres, Redis
// and minio via Compose service names. The app runs no worker and the queue
// uses QUEUE_PREFIX=bull-test, so enqueued jobs stay `waiting`.

interface UploadSessionBody {
  id: string;
  slug: string;
}

interface SignedPartsBody {
  parts: { partNumber: number; url: string }[];
}

interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string | string[];
}

interface UploadedDraft {
  id: string;
  slug: string;
  etag: string;
}

const UPLOAD_NOT_ACTIVE = {
  statusCode: 409,
  error: 'VIDEO_UPLOAD_NOT_ACTIVE',
  message: 'Video has no active upload session',
};

describe('videos-upload-complete', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue<VideoProcessingJobData>;
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
    // Only `bull-test:video-processing:*` keys (QUEUE_PREFIX=bull-test).
    await queue.obliterate({ force: true });
    userA = await createAuthenticatedUser(app, dataSource, 'owner@example.com');
    userB = await createAuthenticatedUser(app, dataSource, 'other@example.com');
  });

  // Aborts multipart sessions still referenced by a row and deletes any
  // original a test left behind (aborting a gone session is a no-op).
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

  async function startUpload(
    token: string,
    size: number,
  ): Promise<UploadSessionBody> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'clip.mp4', contentType: 'video/mp4', size })
      .expect(201);
    return res.body as UploadSessionBody;
  }

  // POST /videos → sign part 1 → PUT the bytes to storage.
  async function uploadDraft(
    token: string,
    bytes: Buffer = randomBytes(2048),
    declaredSize?: number,
  ): Promise<UploadedDraft> {
    const { id, slug } = await startUpload(token, declaredSize ?? bytes.length);
    const signed = await request(app.getHttpServer())
      .post(`/videos/${id}/upload/parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partNumbers: [1] })
      .expect(200);
    const put = await fetch((signed.body as SignedPartsBody).parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(bytes),
    });
    expect(put.status).toBe(200);
    return { id, slug, etag: put.headers.get('etag')! };
  }

  function complete(id: string, parts: unknown, token?: string): request.Test {
    const req = request(app.getHttpServer()).post(
      `/videos/${id}/upload/complete`,
    );
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.send({ parts });
  }

  function findRow(id: string): Promise<Video> {
    return videoRepository.findOneByOrFail({ id });
  }

  it('complete-moves-draft-to-processing', async () => {
    const draft = await uploadDraft(userA.accessToken);

    const res = await complete(
      draft.id,
      [{ partNumber: 1, etag: draft.etag }],
      userA.accessToken,
    ).expect(200);

    expect(res.body).toEqual({
      id: draft.id,
      slug: draft.slug,
      status: 'processing',
    });
    const row = await findRow(draft.id);
    expect(row.status).toBe(VideoStatus.PROCESSING);
    expect(row.upload_id).toBeNull();
    expect(row.processing_started_at).not.toBeNull();
    await expect(storage.headObject(originalKey(draft.id))).resolves.toEqual({
      size: 2048,
    });
  });

  it('complete-enqueues-deterministic-processing-job', async () => {
    const draft = await uploadDraft(userA.accessToken);

    await complete(
      draft.id,
      [{ partNumber: 1, etag: draft.etag }],
      userA.accessToken,
    ).expect(200);

    const job = await queue.getJob(draft.id);
    expect(job).toBeDefined();
    expect(job!.id).toBe(draft.id);
    expect(job!.name).toBe('process');
    expect(job!.data).toEqual({ videoId: draft.id });
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 10000 });
    await expect(job!.getState()).resolves.toBe('waiting');
  });

  it('complete-is-idempotent', async () => {
    const draft = await uploadDraft(userA.accessToken);
    const parts = [{ partNumber: 1, etag: draft.etag }];
    const first = await complete(draft.id, parts, userA.accessToken).expect(
      200,
    );
    const startedAt = (await findRow(draft.id)).processing_started_at;

    const second = await complete(draft.id, parts, userA.accessToken).expect(
      200,
    );

    expect(second.body).toEqual(first.body);
    const jobs = await queue.getJobs([
      'waiting',
      'active',
      'delayed',
      'completed',
      'failed',
    ]);
    expect(jobs.map((job) => job.id)).toEqual([draft.id]);
    const row = await findRow(draft.id);
    expect(row.status).toBe(VideoStatus.PROCESSING);
    expect(row.processing_started_at).toEqual(startedAt);
  });

  it('complete-rejects-wrong-etag', async () => {
    const draft = await uploadDraft(userA.accessToken);

    const res = await complete(
      draft.id,
      [{ partNumber: 1, etag: '"00000000000000000000000000000000"' }],
      userA.accessToken,
    ).expect(400);

    expect(res.body).toEqual({
      statusCode: 400,
      error: 'UPLOAD_PARTS_INVALID',
      message: 'Upload parts are invalid',
    });
    const row = await findRow(draft.id);
    expect(row.status).toBe(VideoStatus.DRAFT);
    expect(row.upload_id).toEqual(expect.any(String));
    await expect(queue.getJob(draft.id)).resolves.toBeUndefined();

    const retry = await complete(
      draft.id,
      [{ partNumber: 1, etag: draft.etag }],
      userA.accessToken,
    ).expect(200);
    expect((retry.body as { status: string }).status).toBe('processing');
  });

  it('complete-rejects-incomplete-or-unordered-parts', async () => {
    // 64 MiB + 1 byte → partCount 2; the check runs before storage.
    const { id } = await startUpload(userA.accessToken, 67108865);

    const incomplete = await complete(
      id,
      [{ partNumber: 1, etag: '"a"' }],
      userA.accessToken,
    ).expect(400);
    expect((incomplete.body as ErrorResponseBody).error).toBe(
      'UPLOAD_PARTS_INVALID',
    );

    const descending = await complete(
      id,
      [
        { partNumber: 2, etag: '"b"' },
        { partNumber: 1, etag: '"a"' },
      ],
      userA.accessToken,
    ).expect(400);
    expect((descending.body as ErrorResponseBody).error).toBe(
      'UPLOAD_PARTS_INVALID',
    );

    const row = await findRow(id);
    expect(row.status).toBe(VideoStatus.DRAFT);
    expect(row.upload_id).toEqual(expect.any(String));
    await expect(queue.getJob(id)).resolves.toBeUndefined();
  });

  it('complete-rejects-invalid-body-and-id', async () => {
    const draft = await uploadDraft(userA.accessToken);

    for (const parts of [
      [],
      [{ partNumber: 1, etag: '' }],
      [{ partNumber: 0, etag: '"a"' }],
    ]) {
      const res = await complete(draft.id, parts, userA.accessToken).expect(
        400,
      );
      expect((res.body as ErrorResponseBody).error).toBe('VALIDATION_ERROR');
    }

    const badId = await complete(
      'not-a-uuid',
      [{ partNumber: 1, etag: draft.etag }],
      userA.accessToken,
    ).expect(400);
    expect((badId.body as ErrorResponseBody).error).toBe('VALIDATION_ERROR');
    expect((await findRow(draft.id)).status).toBe(VideoStatus.DRAFT);
  });

  it('complete-detects-size-mismatch', async () => {
    const draft = await uploadDraft(userA.accessToken, randomBytes(1024), 2048);

    const res = await complete(
      draft.id,
      [{ partNumber: 1, etag: draft.etag }],
      userA.accessToken,
    ).expect(422);

    expect(res.body).toEqual({
      statusCode: 422,
      error: 'UPLOAD_SIZE_MISMATCH',
      message: 'Uploaded size does not match the declared size',
    });
    const row = await findRow(draft.id);
    expect(row.status).toBe(VideoStatus.FAILED);
    expect(row.failure_reason).toBe('UPLOAD_SIZE_MISMATCH');
    expect(row.upload_id).toBeNull();
    await expect(storage.headObject(originalKey(draft.id))).resolves.toBeNull();
    await expect(queue.getJob(draft.id)).resolves.toBeUndefined();
  });

  it('complete-recovers-when-storage-already-completed', async () => {
    const draft = await uploadDraft(userA.accessToken);
    const parts = [{ partNumber: 1, etag: draft.etag }];
    // Simulated crash between the storage completion and the DB commit.
    const { upload_id } = await findRow(draft.id);
    await storage.completeMultipartUpload(
      originalKey(draft.id),
      upload_id!,
      parts,
    );

    const res = await complete(draft.id, parts, userA.accessToken).expect(200);

    expect((res.body as { status: string }).status).toBe('processing');
    const row = await findRow(draft.id);
    expect(row.status).toBe(VideoStatus.PROCESSING);
    expect(row.upload_id).toBeNull();
    await expect(queue.getJob(draft.id)).resolves.toBeDefined();
  });

  it('complete-409-when-upload-gone-and-no-object', async () => {
    const draft = await uploadDraft(userA.accessToken);
    const { upload_id } = await findRow(draft.id);
    await storage.abortMultipartUpload(originalKey(draft.id), upload_id!);

    const res = await complete(
      draft.id,
      [{ partNumber: 1, etag: draft.etag }],
      userA.accessToken,
    ).expect(409);

    expect(res.body).toEqual(UPLOAD_NOT_ACTIVE);
    expect((await findRow(draft.id)).status).toBe(VideoStatus.DRAFT);
    await expect(queue.getJob(draft.id)).resolves.toBeUndefined();
  });

  it('complete-rejects-ready-or-failed-video', async () => {
    const draft = await uploadDraft(userA.accessToken);

    for (const status of [VideoStatus.READY, VideoStatus.FAILED]) {
      await videoRepository.update(
        { id: draft.id },
        {
          status,
          failure_reason:
            status === VideoStatus.FAILED ? 'UPLOAD_ABORTED' : null,
        },
      );

      const res = await complete(
        draft.id,
        [{ partNumber: 1, etag: draft.etag }],
        userA.accessToken,
      ).expect(409);

      expect((res.body as ErrorResponseBody).error).toBe(
        'VIDEO_UPLOAD_NOT_ACTIVE',
      );
      expect((await findRow(draft.id)).status).toBe(status);
      await expect(queue.getJob(draft.id)).resolves.toBeUndefined();
    }
  });

  it('complete-hides-other-users-video', async () => {
    const draft = await uploadDraft(userA.accessToken);
    const parts = [{ partNumber: 1, etag: draft.etag }];

    const foreign = await complete(draft.id, parts, userB.accessToken).expect(
      404,
    );
    expect((foreign.body as ErrorResponseBody).error).toBe('VIDEO_NOT_FOUND');
    expect((await findRow(draft.id)).status).toBe(VideoStatus.DRAFT);
    await expect(queue.getJob(draft.id)).resolves.toBeUndefined();

    const unknown = await complete(
      randomUUID(),
      parts,
      userA.accessToken,
    ).expect(404);
    expect((unknown.body as ErrorResponseBody).error).toBe('VIDEO_NOT_FOUND');

    await complete(draft.id, parts).expect(401);
  });
});
