import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import { VideoProcessingQueue } from '../videos/video-processing.queue';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
} from '../videos/video-queue.constants';
import { VideoWorkerModule } from './video-worker.module';

describe('VideoWorkerModule', () => {
  it('should compile with the real config, DB, storage and both video queues, and release them on close', async () => {
    const module = await Test.createTestingModule({
      imports: [VideoWorkerModule],
    }).compile();
    const dataSource = module.get(DataSource);

    try {
      expect(dataSource.isInitialized).toBe(true);
      expect(module.get(StorageService)).toBeInstanceOf(StorageService);
      expect(module.get(VideoProcessingQueue)).toBeInstanceOf(
        VideoProcessingQueue,
      );
      expect(module.get(VideoLifecycleService)).toBeInstanceOf(
        VideoLifecycleService,
      );

      const processing = module.get<Queue>(
        getQueueToken(VIDEO_PROCESSING_QUEUE),
      );
      expect(processing.opts.prefix).toBe('bull-test');
      expect(processing.defaultJobOptions).toMatchObject({ attempts: 3 });

      const maintenance = module.get<Queue>(
        getQueueToken(VIDEO_MAINTENANCE_QUEUE),
      );
      expect(maintenance.name).toBe(VIDEO_MAINTENANCE_QUEUE);
      expect(maintenance.opts.prefix).toBe('bull-test');
      expect(maintenance.defaultJobOptions).toMatchObject({
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { count: 100 },
      });
    } finally {
      await module.close();
    }

    expect(dataSource.isInitialized).toBe(false);
  }, 30000);
});
