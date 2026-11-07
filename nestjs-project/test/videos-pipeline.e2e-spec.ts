import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
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
import { createTestVideo } from '../src/test/video-fixtures';
import { VideoWorkerModule } from '../src/video-worker/video-worker.module';
import { VideoProcessor } from '../src/video-worker/video.processor';
import { Video } from '../src/videos/entities/video.entity';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
  VIDEO_SWEEPER_SCHEDULER_ID,
  type VideoProcessingJobData,
} from '../src/videos/video-queue.constants';
import { originalKey, thumbnailKey } from '../src/videos/video-storage-keys';
import {
  createAuthenticatedUser,
  type AuthenticatedUser,
} from './helpers/authenticated-user';

// SI-03.16: the whole phase over HTTP. The API (AppModule) and the video
// worker (VideoWorkerModule with its BullMQ workers running) share this Jest
// process. Real Postgres, Redis and minio via Compose service names; the
// queues use QUEUE_PREFIX=bull-test (setup file), so the Compose video-worker
// (prefix `bull`) never takes these jobs.

const PIPELINE_TIMEOUT_MS = 60000;
const POLL_INTERVAL_MS = 250;
const TEST_TIMEOUT_MS = 90000;
const HOOK_TIMEOUT_MS = 30000;

interface UploadSessionBody {
  id: string;
  slug: string;
  status: string;
}

interface SignedPartsBody {
  parts: { partNumber: number; url: string }[];
}

interface VideoBody {
  id: string;
  slug: string;
  title: string;
  status: string;
  failureReason: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
}

interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string;
}

interface UploadInput {
  bytes: Buffer;
  filename: string;
  contentType: string;
}

const VIDEO_NOT_FOUND = {
  statusCode: 404,
  error: 'VIDEO_NOT_FOUND',
  message: 'Video not found',
};

describe('videos-pipeline', () => {
  let app: INestApplication<App>;
  let worker: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let processingQueue: Queue<VideoProcessingJobData>;
  let processor: VideoProcessor;
  let videoRepository: Repository<Video>;
  let owner: AuthenticatedUser;
  let mp4Path: string;
  let mp4: Buffer;

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
    processingQueue = app.get<Queue<VideoProcessingJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
    videoRepository = dataSource.getRepository(Video);

    // Stale `bull-test` jobs would otherwise be consumed by the worker.
    await processingQueue.obliterate({ force: true });

    // `init()` starts the BullMQ workers (processing + maintenance), the
    // same as `createApplicationContext` in src/worker.ts.
    worker = await Test.createTestingModule({
      imports: [VideoWorkerModule],
    }).compile();
    await worker.init();
    processor = worker.get(VideoProcessor);

    mp4Path = await createTestVideo({
      durationSeconds: 2,
      width: 320,
      height: 240,
    });
    mp4 = await readFile(mp4Path);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await releaseStorage();
      await cleanAllTables(dataSource);
      await processingQueue.obliterate({ force: true });
      await removeSweeperScheduler();
      await rm(mp4Path, { force: true });
    } finally {
      await worker.close();
      await app.close();
    }
  }, HOOK_TIMEOUT_MS);

  beforeEach(async () => {
    await releaseStorage();
    await cleanAllTables(dataSource);
    await processingQueue.obliterate({ force: true });
    throttlerStorage.storage.clear();
    owner = await createAuthenticatedUser(
      app,
      dataSource,
      'pipeline@example.com',
    );
  });

  // Every worker `init()` registers the `video-sweeper` scheduler on
  // `bull-test` and runs one sweep at once (SI-03.15); remove both so nothing
  // outlives the suite.
  async function removeSweeperScheduler(): Promise<void> {
    const maintenance = worker.get<Queue>(
      getQueueToken(VIDEO_MAINTENANCE_QUEUE),
    );
    await maintenance.removeJobScheduler(VIDEO_SWEEPER_SCHEDULER_ID);
    await maintenance.obliterate({ force: true });
  }

  // Aborts multipart sessions still referenced by a row and deletes every
  // object the pipeline wrote (deleting a missing key is a no-op).
  async function releaseStorage(): Promise<void> {
    const open = await videoRepository.find({
      where: { upload_id: Not(IsNull()) },
    });
    for (const row of open) {
      await storage.abortMultipartUpload(originalKey(row.id), row.upload_id!);
    }
    for (const row of await videoRepository.find()) {
      await storage.deleteObject(originalKey(row.id));
      await storage.deleteObject(thumbnailKey(row.id));
    }
  }

  function getVideo(id: string): Promise<VideoBody> {
    return request(app.getHttpServer())
      .get(`/videos/${id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200)
      .then((res) => res.body as VideoBody);
  }

  // POST /videos → sign part 1 → PUT the bytes to the presigned URL.
  async function uploadPart(
    input: UploadInput,
  ): Promise<{ session: UploadSessionBody; etag: string }> {
    const server = app.getHttpServer();
    const auth = `Bearer ${owner.accessToken}`;
    const created = await request(server)
      .post('/videos')
      .set('Authorization', auth)
      .send({
        filename: input.filename,
        contentType: input.contentType,
        size: input.bytes.length,
      })
      .expect(201);
    const session = created.body as UploadSessionBody;

    const signed = await request(server)
      .post(`/videos/${session.id}/upload/parts`)
      .set('Authorization', auth)
      .send({ partNumbers: [1] })
      .expect(200);
    const put = await fetch((signed.body as SignedPartsBody).parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(input.bytes),
    });
    expect(put.status).toBe(200);
    await put.arrayBuffer();
    return { session, etag: put.headers.get('etag')! };
  }

  async function completeUpload(id: string, etag: string): Promise<void> {
    const res = await request(app.getHttpServer())
      .post(`/videos/${id}/upload/complete`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ parts: [{ partNumber: 1, etag }] })
      .expect(200);
    expect((res.body as { status: string }).status).toBe('processing');
  }

  async function uploadAndComplete(input: UploadInput): Promise<string> {
    const { session, etag } = await uploadPart(input);
    await completeUpload(session.id, etag);
    return session.id;
  }

  // Polls `GET /videos/:id` until the status leaves `processing`; no fixed
  // sleeps beyond the poll interval, hard deadline of 60 s.
  async function waitForTerminalStatus(id: string): Promise<VideoBody> {
    const deadline = Date.now() + PIPELINE_TIMEOUT_MS;
    for (;;) {
      const video = await getVideo(id);
      if (video.status !== 'processing') return video;
      if (Date.now() > deadline) {
        throw new Error(`video ${id} still processing after 60 s`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  function play(slug: string, mode: 'stream' | 'download'): request.Test {
    return request(app.getHttpServer()).get(`/videos/${slug}/${mode}`);
  }

  it(
    'valid-video-reaches-ready-and-plays',
    async () => {
      const input = {
        bytes: mp4,
        filename: 'pipeline.mp4',
        contentType: 'video/mp4',
      };
      const { session, etag } = await uploadPart(input);
      expect(session.status).toBe('draft');
      expect((await getVideo(session.id)).status).toBe('draft');

      // Hold the in-process worker so `processing` is observable over HTTP.
      await processor.worker.pause();
      try {
        await completeUpload(session.id, etag);
        expect((await getVideo(session.id)).status).toBe('processing');
      } finally {
        await processor.worker.resume();
      }

      const ready = await waitForTerminalStatus(session.id);
      expect(ready).toMatchObject({
        id: session.id,
        slug: session.slug,
        title: 'pipeline',
        status: 'ready',
        failureReason: null,
        width: 320,
        height: 240,
        videoCodec: 'h264',
      });
      expect(ready.durationMs).toBeGreaterThanOrEqual(1900);
      expect(ready.durationMs).toBeLessThanOrEqual(2100);
      await expect(
        storage.headObject(thumbnailKey(session.id)),
      ).resolves.not.toBeNull();

      // Stream: 302 to a presigned URL that serves a byte range.
      const stream = await play(session.slug, 'stream').expect(302);
      expect(stream.headers['cache-control']).toBe('no-store');
      const ranged = await fetch(stream.headers.location, {
        redirect: 'manual',
        headers: { Range: 'bytes=0-1023' },
      });
      expect(ranged.status).toBe(206);
      const chunk = Buffer.from(await ranged.arrayBuffer());
      expect(chunk.equals(mp4.subarray(0, 1024))).toBe(true);
      expect(ranged.headers.get('content-range')).toBe(
        `bytes 0-1023/${mp4.length}`,
      );

      // Download: 302 to a presigned URL that answers as an attachment.
      const download = await play(session.slug, 'download').expect(302);
      const file = await fetch(download.headers.location, {
        redirect: 'manual',
      });
      expect(file.status).toBe(200);
      const body = Buffer.from(await file.arrayBuffer());
      expect(body.equals(mp4)).toBe(true);
      expect(file.headers.get('content-disposition')).toBe(
        `attachment; filename="pipeline.mp4"; filename*=UTF-8''pipeline.mp4`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'invalid-media-ends-failed-and-is-not-playable',
    async () => {
      const id = await uploadAndComplete({
        bytes: randomBytes(4096),
        filename: 'not-a-video.mp4',
        contentType: 'video/mp4',
      });

      const failed = await waitForTerminalStatus(id);
      expect(failed).toMatchObject({
        id,
        status: 'failed',
        failureReason: 'INVALID_MEDIA',
        durationMs: null,
        width: null,
        height: null,
        videoCodec: null,
      });

      for (const mode of ['stream', 'download'] as const) {
        const res = await play(failed.slug, mode).expect(404);
        expect(res.body as ErrorResponseBody).toEqual(VIDEO_NOT_FOUND);
        expect(res.headers.location).toBeUndefined();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'two-uploads-get-distinct-slugs',
    async () => {
      const input = {
        bytes: mp4,
        filename: 'twin.mp4',
        contentType: 'video/mp4',
      };
      const firstId = await uploadAndComplete(input);
      const secondId = await uploadAndComplete(input);

      const first = await waitForTerminalStatus(firstId);
      const second = await waitForTerminalStatus(secondId);

      expect(first.status).toBe('ready');
      expect(second.status).toBe('ready');
      expect(first.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(second.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(first.slug).not.toBe(second.slug);

      const firstStream = await play(first.slug, 'stream').expect(302);
      const secondStream = await play(second.slug, 'stream').expect(302);
      expect(new URL(firstStream.headers.location).pathname).toContain(
        originalKey(firstId),
      );
      expect(new URL(secondStream.headers.location).pathname).toContain(
        originalKey(secondId),
      );
    },
    TEST_TIMEOUT_MS,
  );
});
