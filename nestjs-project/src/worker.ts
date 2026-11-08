import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { VideoWorkerModule } from './video-worker/video-worker.module';

// Video worker entrypoint: a standalone application context (no HTTP
// listener). Shutdown hooks make SIGTERM (`docker compose stop`) close the
// BullMQ queues/workers, Redis and the DB connection before exiting.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(VideoWorkerModule);
  app.enableShutdownHooks();
  new Logger('VideoWorker').log('Video worker application context started');
}
void bootstrap();
