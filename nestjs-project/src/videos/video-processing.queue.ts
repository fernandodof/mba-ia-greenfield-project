import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { JobState, Queue } from 'bullmq';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from './video-queue.constants';

/** State of a video's processing job; `'missing'` when no job is stored. */
export type VideoProcessingJobState = JobState | 'unknown' | 'missing';

/**
 * Producer side of the `video-processing` queue (TD-13). The job id is the
 * video id, so adding the same video twice is a no-op while a job for it is
 * stored (including retained completed/failed jobs). Job options come from
 * the queue's `defaultJobOptions` (TD-12).
 */
@Injectable()
export class VideoProcessingQueue {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<VideoProcessingJobData>,
  ) {}

  async enqueue(videoId: string): Promise<void> {
    await this.queue.add(VIDEO_PROCESS_JOB, { videoId }, { jobId: videoId });
  }

  async getJobState(videoId: string): Promise<VideoProcessingJobState> {
    const job = await this.queue.getJob(videoId);
    if (!job) {
      return 'missing';
    }
    return job.getState();
  }

  /** Throws for an active (locked) job; callers only remove finished jobs. */
  async removeJob(videoId: string): Promise<void> {
    await this.queue.remove(videoId);
  }
}
