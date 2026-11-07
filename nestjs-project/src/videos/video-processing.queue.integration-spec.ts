import { randomUUID } from 'node:crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import redisConfig from '../config/redis.config';
import { QueueModule } from '../queue/queue.module';
import { VideoProcessingQueue } from './video-processing.queue';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESSING_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from './video-queue.constants';

// Real `redis` Compose service (Phase 03 override IC-1), `bull-test` prefix
// from the Jest setup file. No worker runs, so added jobs stay `waiting`.

describe('VideoProcessingQueue (integration)', () => {
  let module: TestingModule;
  let producer: VideoProcessingQueue;
  let queue: Queue<VideoProcessingJobData>;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [redisConfig] }),
        QueueModule,
        BullModule.registerQueue({
          name: VIDEO_PROCESSING_QUEUE,
          defaultJobOptions: VIDEO_PROCESSING_JOB_OPTIONS,
        }),
      ],
      providers: [VideoProcessingQueue],
    }).compile();

    producer = module.get(VideoProcessingQueue);
    queue = module.get<Queue<VideoProcessingJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  describe('enqueue', () => {
    it('stores one process job with jobId = videoId and payload { videoId }, even when called twice', async () => {
      const videoId = randomUUID();

      await producer.enqueue(videoId);
      await producer.enqueue(videoId);

      const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(videoId);
      expect(jobs[0].name).toBe(VIDEO_PROCESS_JOB);
      expect(jobs[0].data).toEqual({ videoId });
      expect(jobs[0].opts).toMatchObject({
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
      });
    });
  });

  describe('getJobState', () => {
    it("returns 'missing' for a video without a job", async () => {
      await expect(producer.getJobState(randomUUID())).resolves.toBe('missing');
    });

    it("returns 'waiting' after enqueue", async () => {
      const videoId = randomUUID();
      await producer.enqueue(videoId);

      await expect(producer.getJobState(videoId)).resolves.toBe('waiting');
    });
  });

  describe('removeJob', () => {
    it('removes the stored job so the video can be enqueued again', async () => {
      const videoId = randomUUID();
      await producer.enqueue(videoId);

      await producer.removeJob(videoId);

      await expect(producer.getJobState(videoId)).resolves.toBe('missing');
    });
  });
});
