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

  /** `draft → failed` with the given reason, clearing the upload session. */
  async failDraft(id: string, reason: DraftFailureReason): Promise<boolean> {
    const result = await this.videoRepository.update(
      { id, status: VideoStatus.DRAFT },
      { status: VideoStatus.FAILED, failure_reason: reason, upload_id: null },
    );
    // The postgres driver always reports `affected` (pg `rowCount`).
    return (result.affected ?? 0) > 0;
  }
}
