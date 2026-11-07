import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoLifecycleService } from './video-lifecycle.service';
import { VideoProcessingQueue } from './video-processing.queue';
import {
  VIDEO_PROCESSING_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from './video-queue.constants';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

// The only `video-processing` registration: the API produces jobs here and
// the worker imports VideosModule, so both share these job options (TD-12).
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    BullModule.registerQueue({
      name: VIDEO_PROCESSING_QUEUE,
      defaultJobOptions: VIDEO_PROCESSING_JOB_OPTIONS,
    }),
    ChannelsModule,
    StorageModule,
  ],
  controllers: [VideosController],
  providers: [VideosService, VideoLifecycleService, VideoProcessingQueue],
  exports: [VideoLifecycleService, VideoProcessingQueue],
})
export class VideosModule {}
