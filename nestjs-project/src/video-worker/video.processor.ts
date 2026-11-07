import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import {
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from '../videos/video-queue.constants';
import { VideoProcessingService } from './video-processing.service';

/**
 * BullMQ consumer of `video-processing`, registered only in the worker
 * process (TD-08). Errors thrown by the service drive BullMQ: a
 * `VideoProcessingFailure` fails the job at once, anything else is retried.
 */
@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1 })
export class VideoProcessor extends WorkerHost {
  constructor(private readonly processing: VideoProcessingService) {
    super();
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    await this.processing.process(job.data.videoId);
  }
}
