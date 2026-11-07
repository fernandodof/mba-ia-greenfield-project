import { UnrecoverableError } from 'bullmq';
import type { VideoFailureReason } from '../videos/video.types';

/** Permanent processing failures: retrying the job cannot help (TD-09, TD-12). */
export type VideoProcessingFailureReason = Extract<
  VideoFailureReason,
  'INVALID_MEDIA' | 'THUMBNAIL_FAILED' | 'SOURCE_MISSING'
>;

/**
 * Thrown by the processing job for a permanent failure. As an
 * `UnrecoverableError`, BullMQ moves the job to `failed` without using the
 * remaining attempts; the `failed` handler records `reason` (SI-03.14).
 */
export class VideoProcessingFailure extends UnrecoverableError {
  constructor(
    readonly reason: VideoProcessingFailureReason,
    message: string = reason,
    options?: ErrorOptions,
  ) {
    super(message);
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
