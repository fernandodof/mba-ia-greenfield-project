import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configModuleOptions } from '../config/config-module.options';
import { DatabaseModule } from '../database/database.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import {
  VIDEO_MAINTENANCE_JOB_OPTIONS,
  VIDEO_MAINTENANCE_QUEUE,
} from '../videos/video-queue.constants';
import { VideosModule } from '../videos/videos.module';

// Root module of the video worker process (src/worker.ts): no HTTP server and
// no API-only modules (auth, mail, throttler). `video-processing` comes from
// VideosModule; `video-maintenance` is worker-only (sweeper, TD-04).
// UsersModule is imported only so `autoLoadEntities` registers `User`, the
// target of `Channel.user` (Video -> Channel -> User); without it TypeORM
// cannot build the entity metadata. AppModule gets it through AuthModule.
@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    DatabaseModule,
    QueueModule,
    StorageModule,
    UsersModule,
    VideosModule,
    BullModule.registerQueue({
      name: VIDEO_MAINTENANCE_QUEUE,
      defaultJobOptions: VIDEO_MAINTENANCE_JOB_OPTIONS,
    }),
  ],
})
export class VideoWorkerModule {}
