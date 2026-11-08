import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import redisConfig from '../config/redis.config';
import videoConfig from '../config/video.config';
import { QueueModule } from '../queue/queue.module';
import {
  VIDEO_MAINTENANCE_JOB_OPTIONS,
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_SWEEP_JOB,
  VIDEO_SWEEPER_SCHEDULER_ID,
} from '../videos/video-queue.constants';
import { VideoSweeperScheduler } from './video-sweeper.scheduler';

const INTERVAL_MS = 123000;

/**
 * Real Redis on the `bull-test` prefix. Only the queue and the scheduler are
 * registered (no maintenance processor), so the scheduler's first job is
 * never consumed and no sweep touches the shared DB.
 */
async function bootScheduler(): Promise<TestingModule> {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [redisConfig] }),
      QueueModule,
      BullModule.registerQueue({
        name: VIDEO_MAINTENANCE_QUEUE,
        defaultJobOptions: VIDEO_MAINTENANCE_JOB_OPTIONS,
      }),
    ],
    providers: [
      VideoSweeperScheduler,
      {
        provide: videoConfig.KEY,
        useValue: { sweeperIntervalMs: INTERVAL_MS },
      },
    ],
  }).compile();
  await module.init();
  return module;
}

describe('VideoSweeperScheduler (integration)', () => {
  const modules: TestingModule[] = [];
  let queue: Queue;

  beforeAll(async () => {
    const first = await bootScheduler();
    modules.push(first);
    queue = first.get(getQueueToken(VIDEO_MAINTENANCE_QUEUE));
  }, 30000);

  afterAll(async () => {
    try {
      await queue.removeJobScheduler(VIDEO_SWEEPER_SCHEDULER_ID);
      await queue.obliterate({ force: true });
    } finally {
      for (const module of modules) {
        await module.close();
      }
    }
  }, 30000);

  it('registers the video-sweeper Job Scheduler repeating every configured interval with the sweep job template', async () => {
    const scheduler = await queue.getJobScheduler(VIDEO_SWEEPER_SCHEDULER_ID);

    expect(scheduler).toEqual(
      expect.objectContaining({
        key: VIDEO_SWEEPER_SCHEDULER_ID,
        name: VIDEO_SWEEP_JOB,
        every: INTERVAL_MS,
      }),
    );
  });

  it('leaves exactly one scheduler after a second bootstrap', async () => {
    modules.push(await bootScheduler());

    const schedulers = await queue.getJobSchedulers();

    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toEqual(
      expect.objectContaining({
        key: VIDEO_SWEEPER_SCHEDULER_ID,
        every: INTERVAL_MS,
      }),
    );
  }, 30000);
});
