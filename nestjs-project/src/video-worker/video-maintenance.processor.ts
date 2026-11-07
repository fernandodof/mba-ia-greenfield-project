import { Processor, WorkerHost } from '@nestjs/bullmq';
import { VIDEO_MAINTENANCE_QUEUE } from '../videos/video-queue.constants';
import { VideoSweeperService } from './video-sweeper.service';

/**
 * BullMQ consumer of `video-maintenance` (TD-04 AMB-6), worker process only.
 * Each scheduler tick runs one sweep. No `failed` handler: a failed sweep is
 * not retried (`attempts: 1`) and the next tick simply sweeps again.
 */
@Processor(VIDEO_MAINTENANCE_QUEUE, { concurrency: 1 })
export class VideoMaintenanceProcessor extends WorkerHost {
  constructor(private readonly sweeper: VideoSweeperService) {
    super();
  }

  async process(): Promise<void> {
    await this.sweeper.sweep();
  }
}
