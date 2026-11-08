import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import redisConfig from '../config/redis.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoLifecycleService } from './video-lifecycle.service';
import { VideoProcessingQueue } from './video-processing.queue';
import { VIDEO_PROCESSING_QUEUE } from './video-queue.constants';
import { VideosController } from './videos.controller';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosModule', () => {
  it('should compile with the Video repository, channels, storage and the processing queue', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, redisConfig],
        }),
        QueueModule,
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    try {
      expect(module.get(getRepositoryToken(Video))).toBeDefined();
      expect(module.get(VideosService)).toBeInstanceOf(VideosService);
      expect(module.get(VideosController)).toBeInstanceOf(VideosController);
      expect(module.get(VideoLifecycleService)).toBeInstanceOf(
        VideoLifecycleService,
      );
      expect(module.get(VideoProcessingQueue)).toBeInstanceOf(
        VideoProcessingQueue,
      );
      const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
      expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
      expect(queue.defaultJobOptions).toMatchObject({ attempts: 3 });
    } finally {
      await module.close();
    }
  }, 30000);
});
