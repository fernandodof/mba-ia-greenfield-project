import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Job, Queue } from 'bullmq';
import { DataSource, type Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { createTestVideo } from '../test/video-fixtures';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingQueue } from '../videos/video-processing.queue';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from '../videos/video-queue.constants';
import { originalKey, thumbnailKey } from '../videos/video-storage-keys';
import { VideoStatus, type VideoFailureReason } from '../videos/video.types';
import { VideoWorkerModule } from './video-worker.module';
import { VideoProcessor } from './video.processor';

const WAIT_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 100;

/**
 * Boots the real worker module with its BullMQ worker running (`init()`),
 * on the `bull-test` prefix. Stale jobs are removed first so the in-process
 * worker only consumes the jobs of this suite.
 */
async function startWorker(): Promise<TestingModule> {
  const module = await Test.createTestingModule({
    imports: [VideoWorkerModule],
  }).compile();
  await module
    .get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE))
    .obliterate({ force: true });
  await module.init();
  return module;
}

/** Runs `fn` with VIDEO_WORKER_CONCURRENCY set (or unset), then restores it. */
async function withConcurrencyEnv<T>(
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = process.env.VIDEO_WORKER_CONCURRENCY;
  if (value === undefined) {
    delete process.env.VIDEO_WORKER_CONCURRENCY;
  } else {
    process.env.VIDEO_WORKER_CONCURRENCY = value;
  }
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.VIDEO_WORKER_CONCURRENCY;
    } else {
      process.env.VIDEO_WORKER_CONCURRENCY = previous;
    }
  }
}

// Real Redis (`bull-test`), Postgres, `minio` and ffmpeg (Phase 03 IC-1).
describe('VideoProcessor (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let producer: VideoProcessingQueue;
  let queue: Queue<VideoProcessingJobData>;
  let processor: VideoProcessor;
  let videoRepository: Repository<Video>;
  let channelId: string;
  const videoIds: string[] = [];
  const tempFiles: string[] = [];

  beforeAll(async () => {
    // Boots without the variable, so the default concurrency applies.
    module = await withConcurrencyEnv(undefined, startWorker);
    dataSource = module.get(DataSource);
    storage = module.get(StorageService);
    producer = module.get(VideoProcessingQueue);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    processor = module.get(VideoProcessor);
    videoRepository = dataSource.getRepository(Video);
  }, 30000);

  afterAll(async () => {
    try {
      await queue.obliterate({ force: true });
      for (const id of videoIds) {
        await storage.deleteObject(originalKey(id));
        await storage.deleteObject(thumbnailKey(id));
      }
      await Promise.all(tempFiles.map((path) => rm(path, { force: true })));
      await cleanAllTables(dataSource);
    } finally {
      await module.close();
    }
  }, 30000);

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const users = dataSource.getRepository(User);
    const channels = dataSource.getRepository(Channel);
    const user = await users.save(
      users.create({ email: 'processor@example.com', password: 'hashed' }),
    );
    const channel = await channels.save(
      channels.create({
        name: 'processor',
        nickname: 'processor',
        user_id: user.id,
      }),
    );
    channelId = channel.id;
  });

  let slugCounter = 0;
  async function insertProcessingVideo(): Promise<string> {
    const id = randomUUID();
    videoIds.push(id);
    await videoRepository.insert({
      id,
      channel_id: channelId,
      slug: `wrk${String(++slugCounter).padStart(8, '0')}`,
      title: 'clip',
      status: VideoStatus.PROCESSING,
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      upload_id: null,
      processing_started_at: new Date(),
    });
    return id;
  }

  /** Polls the row until it leaves `processing` (the handler writes async). */
  async function waitForTerminalRow(id: string): Promise<Video> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    for (;;) {
      const row = await videoRepository.findOneByOrFail({ id });
      if (row.status !== VideoStatus.PROCESSING) {
        return row;
      }
      if (Date.now() > deadline) {
        throw new Error(`Video ${id} still processing after timeout`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  /**
   * Resolves on the worker's `failed` event for `jobId`. Listeners run in
   * registration order, so the processor's handler (registered at init) has
   * already run its synchronous guards when this resolves.
   */
  function nextFailedEvent(jobId: string): Promise<Job | undefined> {
    return new Promise((resolve) => {
      const listener = (job: Job | undefined): void => {
        if (job?.id === jobId) {
          processor.worker.off('failed', listener);
          resolve(job);
        }
      };
      processor.worker.on('failed', listener);
    });
  }

  async function expectTerminalFailure(
    id: string,
    reason: VideoFailureReason,
  ): Promise<void> {
    await expect(waitForTerminalRow(id)).resolves.toEqual(
      expect.objectContaining({
        status: VideoStatus.FAILED,
        failure_reason: reason,
      }),
    );
    // Unrecoverable: a single attempt, no retry scheduled.
    const job = await queue.getJob(id);
    expect(job?.attemptsMade).toBe(1);
    await expect(job?.getState()).resolves.toBe('failed');
  }

  it('runs the worker with concurrency 1 when VIDEO_WORKER_CONCURRENCY is unset', () => {
    expect(processor.worker.concurrency).toBe(1);
  });

  it('ends a job whose original is not a video with the row failed/INVALID_MEDIA after a single attempt', async () => {
    const id = await insertProcessingVideo();
    await storage.putObject(originalKey(id), randomBytes(4096), 'video/mp4');

    await producer.enqueue(id);

    await expectTerminalFailure(id, 'INVALID_MEDIA');
  }, 60000);

  it('ends a job whose original does not exist with the row failed/SOURCE_MISSING', async () => {
    const id = await insertProcessingVideo();

    await producer.enqueue(id);

    await expectTerminalFailure(id, 'SOURCE_MISSING');
  }, 60000);

  it('moves a video with a valid MP4 to ready', async () => {
    const id = await insertProcessingVideo();
    const path = await createTestVideo();
    tempFiles.push(path);
    await storage.putObject(originalKey(id), await readFile(path), 'video/mp4');

    await producer.enqueue(id);

    await expect(waitForTerminalRow(id)).resolves.toEqual(
      expect.objectContaining({
        status: VideoStatus.READY,
        failure_reason: null,
        thumbnail_key: thumbnailKey(id),
      }),
    );
  }, 60000);

  it('writes nothing for a failed job without videoId, leaving other processing rows untouched', async () => {
    const otherId = await insertProcessingVideo();
    const jobId = `no-video-id-${randomUUID()}`;
    const failed = nextFailedEvent(jobId);

    await queue.add(VIDEO_PROCESS_JOB, {} as VideoProcessingJobData, {
      jobId,
    });

    await failed;
    await expect(
      videoRepository.findOneByOrFail({ id: otherId }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: VideoStatus.PROCESSING,
        failure_reason: null,
      }),
    );
  }, 60000);
});

describe('VideoProcessor concurrency (integration)', () => {
  it('runs the worker with concurrency 2 when VIDEO_WORKER_CONCURRENCY=2', async () => {
    const module = await withConcurrencyEnv('2', startWorker);
    try {
      expect(module.get(VideoProcessor).worker.concurrency).toBe(2);
    } finally {
      await module.close();
    }
  }, 30000);
});
