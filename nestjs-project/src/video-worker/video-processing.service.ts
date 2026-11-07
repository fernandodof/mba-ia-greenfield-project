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
    if ((await this.storage.headObject(sourceKey)) === null) {
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
        throw new VideoProcessingFailure('INVALID_MEDIA', err.message, {
          cause: err,
        });
      }
      throw err;
    }

    const jpeg = await this.extractThumbnail(
      url,
      thumbnailOffsetSeconds(metadata.durationMs),
    );
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

  /** Frame at `t`, then once at `t = 0`; a transient error skips the fallback. */
  private async extractThumbnail(url: string, t: number): Promise<Buffer> {
    const frame = await this.ffmpeg.extractFrame(url, t);
    if (frame !== null) {
      return frame;
    }
    if (t > 0) {
      const fallback = await this.ffmpeg.extractFrame(url, 0);
      if (fallback !== null) {
        return fallback;
      }
    }
    throw new VideoProcessingFailure(
      'THUMBNAIL_FAILED',
      'ffmpeg returned no frame for the thumbnail',
    );
  }
}
