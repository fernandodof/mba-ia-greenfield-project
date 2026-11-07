import type { JobsOptions } from 'bullmq';

// Shared queue contract: the API producer and the video worker both import
// these names, payloads and job options, so the queues are declared once.

export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const VIDEO_PROCESS_JOB = 'process';
export const VIDEO_MAINTENANCE_QUEUE = 'video-maintenance';
export const VIDEO_SWEEP_JOB = 'sweep';
export const VIDEO_SWEEPER_SCHEDULER_ID = 'video-sweeper';

export interface VideoProcessingJobData {
  videoId: string;
}

// TD-12: 3 attempts with exponential backoff; failed jobs are retained (and
// keep deduplicating their `jobId = videoId`) up to the last 1000.
export const VIDEO_PROCESSING_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 10000 },
  removeOnComplete: true,
  removeOnFail: { count: 1000 },
} satisfies JobsOptions;

// TD-04: a failed sweep is not retried; the next scheduler tick redoes it.
export const VIDEO_MAINTENANCE_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: { count: 100 },
} satisfies JobsOptions;
