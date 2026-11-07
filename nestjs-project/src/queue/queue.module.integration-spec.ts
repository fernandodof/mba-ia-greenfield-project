import { randomUUID } from 'node:crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import Redis from 'ioredis';
import redisConfig from '../config/redis.config';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESSING_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from '../videos/video-queue.constants';
import { QueueModule } from './queue.module';

// Runs against the real `redis` Compose service (Phase 03 testing override
// IC-1). The Jest setup file sets QUEUE_PREFIX=bull-test, so these keys never
// collide with the Compose video-worker's `bull` prefix. No worker consumes
// this queue in the test, so added jobs stay `waiting` until cleanup.

const TEST_PREFIX = 'bull-test';

const compileQueueModule = async (): Promise<TestingModule> =>
  Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [redisConfig] }),
      QueueModule,
      BullModule.registerQueue({
        name: VIDEO_PROCESSING_QUEUE,
        defaultJobOptions: VIDEO_PROCESSING_JOB_OPTIONS,
      }),
    ],
  }).compile();

describe('QueueModule (integration)', () => {
  let module: TestingModule;
  let queue: Queue<VideoProcessingJobData>;
  // Independent connection used only to inspect the raw keys.
  let redis: Redis;

  beforeAll(async () => {
    module = await compileQueueModule();
    queue = module.get<Queue<VideoProcessingJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
    const cfg = module.get<ConfigType<typeof redisConfig>>(redisConfig.KEY);
    redis = new Redis({ host: cfg.host, port: cfg.port });
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await redis.quit();
    await module.close();
  });

  it('should resolve the video-processing queue with the configured prefix', () => {
    expect(queue).toBeDefined();
    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
    expect(queue.opts.prefix).toBe(TEST_PREFIX);
  });

  it('should store an added job under keys prefixed by QUEUE_PREFIX', async () => {
    const videoId = randomUUID();

    await queue.add(VIDEO_PROCESS_JOB, { videoId }, { jobId: videoId });

    const keys = await redis.keys(`${TEST_PREFIX}:${VIDEO_PROCESSING_QUEUE}:*`);
    expect(keys).toContain(
      `${TEST_PREFIX}:${VIDEO_PROCESSING_QUEUE}:${videoId}`,
    );
    expect(
      await redis.exists(`bull:${VIDEO_PROCESSING_QUEUE}:${videoId}`),
    ).toBe(0);
  });

  it('should apply the shared processing job options as queue defaults', async () => {
    const videoId = randomUUID();

    const job = await queue.add(
      VIDEO_PROCESS_JOB,
      { videoId },
      { jobId: videoId },
    );
    const stored = await queue.getJob(videoId);

    for (const opts of [job.opts, stored!.opts]) {
      expect(opts).toMatchObject({
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: true,
        removeOnFail: { count: 1000 },
      });
    }
  });

  it('should not create a second job when the jobId already exists', async () => {
    const videoId = randomUUID();
    const first = await queue.add(
      VIDEO_PROCESS_JOB,
      { videoId },
      { jobId: videoId },
    );
    const waitingBefore = await queue.getWaitingCount();

    const second = await queue.add(
      VIDEO_PROCESS_JOB,
      { videoId: 'ignored-duplicate' },
      { jobId: videoId },
    );

    expect(second.id).toBe(first.id);
    expect(await queue.getWaitingCount()).toBe(waitingBefore);
    const stored = await queue.getJob(videoId);
    expect(stored!.data).toEqual({ videoId });
  });

  it('should release the Redis connection on module.close()', async () => {
    const ownModule = await compileQueueModule();
    const ownQueue = ownModule.get<Queue>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
    const client = await ownQueue.getBackend().client;
    try {
      expect(client.status).toBe('ready');
    } finally {
      await ownModule.close();
    }

    expect(client.status).toBe('end');
  });
});
