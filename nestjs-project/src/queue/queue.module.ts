import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import redisConfig from '../config/redis.config';

// Global BullMQ root config: every queue registered with
// `BullModule.registerQueue` (and every `@Processor` worker, which reuses the
// queue's resolved options) connects to the Compose `redis` service and
// namespaces its keys with QUEUE_PREFIX.
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [redisConfig.KEY],
      useFactory: (cfg: ConfigType<typeof redisConfig>) => ({
        connection: { host: cfg.host, port: cfg.port },
        prefix: cfg.queuePrefix,
      }),
    }),
  ],
})
export class QueueModule {}
