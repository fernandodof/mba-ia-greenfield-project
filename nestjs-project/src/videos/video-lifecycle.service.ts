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

/**
 * The reasons a `processing` video can end in `failed` (TD-09, TD-12):
 * a permanent media problem, or `PROCESSING_FAILED` once retries run out.
 */
export type ProcessingFailureReason = Extract<
  VideoFailureReason,
  'INVALID_MEDIA' | 'THUMBNAIL_FAILED' | 'SOURCE_MISSING' | 'PROCESSING_FAILED'
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

  /**
   * `processing` videos whose `processing_started_at` is older than
   * `olderThanMs` (TD-13 AMB-1). The threshold is computed in SQL, so the DB
   * clock is the only clock; the column is `timestamptz`, compared to `now()`.
   */
  findStuckProcessing(olderThanMs: number): Promise<Video[]> {
    return this.videoRepository
      .createQueryBuilder('video')
      .where('video.status = :status', { status: VideoStatus.PROCESSING })
      .andWhere(
        "video.processing_started_at < now() - CAST(:olderThanMs AS double precision) * interval '1 millisecond'",
        { olderThanMs },
      )
      .orderBy('video.processing_started_at', 'ASC')
      .getMany();
  }

  /**
   * `draft` videos created more than `olderThanMs` ago (TD-04 AMB-6).
   * `created_at` is a `timestamp` written by the DB default `now()` in the
   * session time zone, so it is compared to `LOCALTIMESTAMP` (same type, same
   * zone): no implicit cast on the column, and the DB clock stays the only clock.
   */
  findExpiredDrafts(olderThanMs: number): Promise<Video[]> {
    return this.videoRepository
      .createQueryBuilder('video')
      .where('video.status = :status', { status: VideoStatus.DRAFT })
      .andWhere(
        "video.created_at < LOCALTIMESTAMP - CAST(:olderThanMs AS double precision) * interval '1 millisecond'",
        { olderThanMs },
      )
      .orderBy('video.created_at', 'ASC')
      .getMany();
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

  /**
   * `processing → failed` with the given reason (TD-12 AMB-1): the terminal
   * write of the worker's `failed` handler and of the sweeper.
   */
  async markProcessingFailed(
    id: string,
    reason: ProcessingFailureReason,
  ): Promise<boolean> {
    const result = await this.videoRepository.update(
      { id, status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, failure_reason: reason },
    );
    return (result.affected ?? 0) > 0;
  }
}
