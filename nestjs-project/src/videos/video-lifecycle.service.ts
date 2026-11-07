import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Video } from './entities/video.entity';
import { VideoStatus, type VideoFailureReason } from './video.types';

/** The reasons a `draft` can end in `failed` (TD-03, TD-04). */
export type DraftFailureReason = Extract<
  VideoFailureReason,
  'UPLOAD_ABORTED' | 'UPLOAD_EXPIRED' | 'UPLOAD_SIZE_MISMATCH'
>;

/** What the worker writes on `processing → ready` (TD-09 AMB-2/AMB-3). */
export interface VideoReadyMetadata {
  durationMs: number;
  width: number;
  height: number;
  videoCodec: string;
  thumbnailKey: string;
}

/**
 * Single home of the guarded status writes (TD-12). Every transition is an
 * `UPDATE … WHERE id = :id AND status = :expected`; `false` means another
 * actor moved the video first, so the caller lost the race.
 */
@Injectable()
export class VideoLifecycleService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
  ) {}

  findById(id: string): Promise<Video | null> {
    return this.videoRepository.findOneBy({ id });
  }

  /** `draft → failed` with the given reason, clearing the upload session. */
  async failDraft(id: string, reason: DraftFailureReason): Promise<boolean> {
    const result = await this.videoRepository.update(
      { id, status: VideoStatus.DRAFT },
      { status: VideoStatus.FAILED, failure_reason: reason, upload_id: null },
    );
    // The postgres driver always reports `affected` (pg `rowCount`).
    return (result.affected ?? 0) > 0;
  }

  /**
   * `draft → processing` once the upload is stored (TD-03, TD-13): clears the
   * upload session and stamps `processing_started_at` with the DB clock, which
   * the sweeper compares against `now()` to find stuck videos.
   */
  async markProcessing(id: string): Promise<boolean> {
    const result = await this.videoRepository.update(
      { id, status: VideoStatus.DRAFT },
      {
        status: VideoStatus.PROCESSING,
        upload_id: null,
        processing_started_at: () => 'now()',
      },
    );
    return (result.affected ?? 0) > 0;
  }

  /**
   * `processing → ready` with the extracted metadata and the thumbnail key
   * (TD-09, TD-12). A `ready` video always has both.
   */
  async markReady(id: string, metadata: VideoReadyMetadata): Promise<boolean> {
    const result = await this.videoRepository.update(
      { id, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        duration_ms: metadata.durationMs,
        width: metadata.width,
        height: metadata.height,
        video_codec: metadata.videoCodec,
        thumbnail_key: metadata.thumbnailKey,
      },
    );
    return (result.affected ?? 0) > 0;
  }
}
