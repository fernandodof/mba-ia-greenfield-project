import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Queue } from 'bullmq';
import videoConfig from '../config/video.config';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_SWEEP_JOB,
  VIDEO_SWEEPER_SCHEDULER_ID,
} from '../videos/video-queue.constants';

/**
 * Registers the `video-sweeper` Job Scheduler on `video-maintenance` at every
 * worker boot (TD-04, TD-13 AMB-6). `upsertJobScheduler` is idempotent by
 * id, so restarts keep exactly one scheduler and pick up a changed interval.
 */
@Injectable()
export class VideoSweeperScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(VideoSweeperScheduler.name);

  constructor(
    @InjectQueue(VIDEO_MAINTENANCE_QUEUE)
    private readonly queue: Queue,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      VIDEO_SWEEPER_SCHEDULER_ID,
      { every: this.config.sweeperIntervalMs },
      { name: VIDEO_SWEEP_JOB, data: {} },
    );
    this.logger.log(
      `${VIDEO_SWEEPER_SCHEDULER_ID} scheduled every ${this.config.sweeperIntervalMs} ms`,
    );
  }
}
