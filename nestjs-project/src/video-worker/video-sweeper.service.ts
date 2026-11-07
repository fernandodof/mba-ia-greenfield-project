import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import type { Video } from '../videos/entities/video.entity';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import { VideoProcessingQueue } from '../videos/video-processing.queue';
import { originalKey } from '../videos/video-storage-keys';

/**
 * The scheduled maintenance sweep (TD-04, TD-13), run by the
 * `video-maintenance` processor. Background task: every row is handled in
 * isolation, and an error on one row is logged and left for the next tick
 * instead of stopping the sweep (nestjs-services background-task exception).
 */
@Injectable()
export class VideoSweeperService {
  private readonly logger = new Logger(VideoSweeperService.name);

  constructor(
    private readonly lifecycle: VideoLifecycleService,
    private readonly processingQueue: VideoProcessingQueue,
    private readonly storage: StorageService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async sweep(): Promise<void> {
    await this.reconcileStuckProcessing();
    await this.expireDrafts();
  }

  /** TD-13 AMB-1: branch on the stored job's state for each stuck video. */
  private async reconcileStuckProcessing(): Promise<void> {
    const videos = await this.lifecycle.findStuckProcessing(
      this.config.processingStuckAfterMs,
    );
    for (const video of videos) {
      try {
        await this.reconcile(video);
      } catch (err) {
        this.logError(`Could not reconcile stuck video ${video.id}`, err);
      }
    }
  }

  private async reconcile(video: Video): Promise<void> {
    const state = await this.processingQueue.getJobState(video.id);
    switch (state) {
      case 'missing':
      case 'unknown':
        // Dual-write gap or evicted job: add it again (jobId = videoId).
        await this.processingQueue.enqueue(video.id);
        this.logger.warn(`Re-enqueued stuck video ${video.id} (job ${state})`);
        return;
      case 'failed': {
        // A retained failed job would make a re-add a no-op; no reprocess (TD-12).
        const updated = await this.lifecycle.markProcessingFailed(
          video.id,
          'PROCESSING_FAILED',
        );
        if (updated) {
          this.logger.warn(
            `Stuck video ${video.id} has a failed job; marked PROCESSING_FAILED`,
          );
        }
        return;
      }
      case 'completed':
        // Anomaly: the job finished but the row is still processing.
        await this.processingQueue.removeJob(video.id);
        await this.processingQueue.enqueue(video.id);
        this.logger.warn(
          `Re-enqueued stuck video ${video.id} (job completed, row processing)`,
        );
        return;
      case 'waiting':
      case 'delayed':
      case 'prioritized':
      case 'active':
      case 'waiting-children':
        // The job is still on its way; leave it alone.
        return;
    }
  }

  /** TD-04 AMB-6: abort → delete the original → `failed`/`UPLOAD_EXPIRED`. */
  private async expireDrafts(): Promise<void> {
    const drafts = await this.lifecycle.findExpiredDrafts(
      this.config.uploadExpireAfterMs,
    );
    for (const draft of drafts) {
      try {
        await this.expire(draft);
      } catch (err) {
        this.logError(
          `Could not expire draft ${draft.id}; retrying next tick`,
          err,
        );
      }
    }
  }

  private async expire(draft: Video): Promise<void> {
    const key = originalKey(draft.id);
    if (draft.upload_id) {
      // `NoSuchUpload` is already a no-op in StorageService.
      await this.storage.abortMultipartUpload(key, draft.upload_id);
    }
    // The original can exist after the TD-03 AMB-7 crash window.
    await this.storage.deleteObject(key);
    const updated = await this.lifecycle.failDraft(draft.id, 'UPLOAD_EXPIRED');
    if (updated) {
      this.logger.log(`Expired abandoned draft ${draft.id}`);
    }
  }

  private logError(message: string, err: unknown): void {
    this.logger.error(message, err instanceof Error ? err.stack : String(err));
  }
}
