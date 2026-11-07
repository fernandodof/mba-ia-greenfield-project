import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { UnrecoverableError, type Job } from 'bullmq';
import videoConfig from '../config/video.config';
import {
  VideoLifecycleService,
  type ProcessingFailureReason,
} from '../videos/video-lifecycle.service';
import {
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from '../videos/video-queue.constants';
import { VideoProcessingFailure } from './video-processing.errors';
import { VideoProcessingService } from './video-processing.service';

/**
 * BullMQ consumer of `video-processing`, registered only in the worker
 * process (TD-08). Errors thrown by the service drive BullMQ: a
 * `VideoProcessingFailure` fails the job at once, anything else is retried.
 * Once a job fails for good, `onFailed` records the terminal state (TD-12).
 */
// The static decorator options cannot read config; `onApplicationBootstrap`
// applies VIDEO_WORKER_CONCURRENCY at runtime.
@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1 })
export class VideoProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    private readonly processing: VideoProcessingService,
    private readonly lifecycle: VideoLifecycleService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {
    super();
  }

  /** `WorkerHost.worker` is assigned during module init, so it exists here. */
  onApplicationBootstrap(): void {
    this.worker.concurrency = this.config.workerConcurrency;
    this.logger.log(
      `${VIDEO_PROCESSING_QUEUE} worker concurrency: ${this.config.workerConcurrency}`,
    );
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    await this.processing.process(job.data.videoId);
  }

  /**
   * Runs after every failed attempt (TD-12 AMB-1/AMB-6/AMB-10). Writes
   * `processing → failed` only when the job will not run again: an
   * unrecoverable error, or the last attempt. Event handler: it logs its own
   * errors and never throws.
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<VideoProcessingJobData> | undefined,
    error: Error,
  ): Promise<void> {
    // `job` is undefined e.g. for jobs failed as stalled; the sweeper
    // reconciles those. An undefined id would also be dropped from the
    // TypeORM `where`, failing every `processing` video.
    const videoId: unknown = job?.data?.videoId;
    if (!job || typeof videoId !== 'string' || videoId.length === 0) {
      return;
    }
    if (!isUnrecoverable(error) && !isLastAttempt(job)) {
      return;
    }

    const reason: ProcessingFailureReason =
      error instanceof VideoProcessingFailure
        ? error.reason
        : 'PROCESSING_FAILED';
    try {
      const updated = await this.lifecycle.markProcessingFailed(
        videoId,
        reason,
      );
      if (updated) {
        this.logger.warn(
          `Video ${videoId} failed with ${reason}: ${error.message}`,
        );
      } else {
        this.logger.log(
          `Video ${videoId} is no longer processing; ${reason} not recorded`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Could not record ${reason} for video ${videoId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}

// BullMQ's own check (bullmq `Job.shouldRetryJob`) accepts the class or the name.
function isUnrecoverable(error: Error): boolean {
  return (
    error instanceof UnrecoverableError || error.name === 'UnrecoverableError'
  );
}

// `attemptsMade` already counts the failed attempt when `failed` is emitted;
// BullMQ treats missing `attempts` as a single attempt.
function isLastAttempt(job: Job): boolean {
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}
