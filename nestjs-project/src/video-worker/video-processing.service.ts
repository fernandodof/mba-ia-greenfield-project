import { Injectable, Logger } from '@nestjs/common';
import { FfmpegService } from '../media/ffmpeg.service';
import { InvalidMediaError } from '../media/media.errors';
import { StorageService } from '../storage/storage.service';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import { originalKey, thumbnailKey } from '../videos/video-storage-keys';
import { WORKER_SOURCE_URL_TTL_SECONDS } from '../videos/video.constants';
import { VideoStatus } from '../videos/video.types';
import { VideoProcessingFailure } from './video-processing.errors';

/** Thumbnail offset in seconds: `min(1 s, duration / 2)` (TD-09 AMB-3). */
export function thumbnailOffsetSeconds(durationMs: number): number {
  return Math.min(1, durationMs / 2000);
}

/**
 * One processing attempt of a `video-processing` job (TD-09, TD-12):
 * verify the original, probe it, store a thumbnail and move the video to
 * `ready`. Permanent media problems throw `VideoProcessingFailure` (no
 * retry); transient storage/ffmpeg errors propagate as-is (retried).
 *
 * Before reporting `INVALID_MEDIA` or `THUMBNAIL_FAILED`, the original is
 * checked again: if it was deleted while ffprobe/ffmpeg read it (an abort
 * racing a winning `complete`), ffmpeg sees an HTTP 404, and the honest
 * reason is `SOURCE_MISSING`.
 */
@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    private readonly lifecycle: VideoLifecycleService,
    private readonly storage: StorageService,
    private readonly ffmpeg: FfmpegService,
  ) {}

  async process(videoId: string): Promise<void> {
    const video = await this.lifecycle.findById(videoId);
    if (video?.status !== VideoStatus.PROCESSING) {
      // Redelivered or stale job: the video already left `processing`.
      return;
    }

    const sourceKey = originalKey(videoId);
    if (!(await this.sourceExists(sourceKey))) {
      throw new VideoProcessingFailure(
        'SOURCE_MISSING',
        `Original ${sourceKey} does not exist`,
      );
    }

    // Signed fresh on every attempt (TD-09 AMB-10).
    const url = await this.storage.presignGetObject(sourceKey, {
      client: 'internal',
      expiresIn: WORKER_SOURCE_URL_TTL_SECONDS,
    });

    let metadata: Awaited<ReturnType<FfmpegService['probe']>>;
    try {
      metadata = await this.ffmpeg.probe(url);
    } catch (err) {
      if (err instanceof InvalidMediaError) {
        throw await this.permanentFailure(sourceKey, 'INVALID_MEDIA', err);
      }
      throw err;
    }

    const jpeg = await this.extractThumbnail(
      url,
      thumbnailOffsetSeconds(metadata.durationMs),
    );
    if (jpeg === null) {
      throw await this.permanentFailure(sourceKey, 'THUMBNAIL_FAILED');
    }
    const key = thumbnailKey(videoId);
    await this.storage.putObject(key, jpeg, 'image/jpeg');

    const updated = await this.lifecycle.markReady(videoId, {
      ...metadata,
      thumbnailKey: key,
    });
    if (!updated) {
      this.logger.warn(
        `Video ${videoId} left processing before it could be marked ready`,
      );
    }
  }

  private async sourceExists(sourceKey: string): Promise<boolean> {
    return (await this.storage.headObject(sourceKey)) !== null;
  }

  /**
   * `reason`, or `SOURCE_MISSING` when the original is gone by now. A
   * `HeadObject` error propagates (retryable), as on the first check.
   */
  private async permanentFailure(
    sourceKey: string,
    reason: 'INVALID_MEDIA' | 'THUMBNAIL_FAILED',
    cause?: InvalidMediaError,
  ): Promise<VideoProcessingFailure> {
    if (!(await this.sourceExists(sourceKey))) {
      return new VideoProcessingFailure(
        'SOURCE_MISSING',
        `Original ${sourceKey} disappeared during processing`,
        { cause },
      );
    }
    return new VideoProcessingFailure(
      reason,
      cause?.message ?? 'ffmpeg returned no frame for the thumbnail',
      { cause },
    );
  }

  /**
   * Frame at `t`, then once at `t = 0`; `null` when neither yields one. A
   * transient error propagates and skips the fallback.
   */
  private async extractThumbnail(
    url: string,
    t: number,
  ): Promise<Buffer | null> {
    const frame = await this.ffmpeg.extractFrame(url, t);
    if (frame !== null || t <= 0) {
      return frame;
    }
    return this.ffmpeg.extractFrame(url, 0);
  }
}
