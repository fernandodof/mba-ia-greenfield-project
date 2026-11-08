import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  InvalidUploadPartsError,
  UploadSessionNotFoundError,
} from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import type { CompletedPartDto } from './dto/complete-upload.dto';
import type { CreateVideoDto } from './dto/create-video.dto';
import type { SignedUploadPartsDto } from './dto/signed-upload-parts.dto';
import type { UploadedPartsDto } from './dto/uploaded-parts.dto';
import type { VideoProcessingStartedDto } from './dto/video-processing-started.dto';
import type { VideoUploadSessionDto } from './dto/video-upload-session.dto';
import { buildDownloadContentDisposition } from './download-filename.util';
import { Video } from './entities/video.entity';
import {
  computePartCount,
  PLAYBACK_URL_TTL_SECONDS,
  UPLOAD_PART_URL_TTL_SECONDS,
  VIDEO_PART_SIZE_BYTES,
} from './video.constants';
import { VideoLifecycleService } from './video-lifecycle.service';
import { VideoProcessingQueue } from './video-processing.queue';
import { generateVideoSlug, isVideoSlug } from './video-slug.util';
import { originalKey } from './video-storage-keys';
import { deriveVideoTitle } from './video-title.util';
import { VideoStatus } from './video.types';
import {
  UploadPartsInvalidException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoUploadNotActiveException,
} from './videos.exceptions';

export type PlaybackMode = 'stream' | 'download';

type NewDraft = Pick<
  Video,
  | 'id'
  | 'channel_id'
  | 'title'
  | 'original_filename'
  | 'content_type'
  | 'size_bytes'
  | 'upload_id'
>;

const PG_UNIQUE_VIOLATION = '23505';
const SLUG_COLUMN = 'slug';
// TD-10: 64-bit random slugs make a collision rare; 3 attempts is plenty.
const MAX_SLUG_ATTEMPTS = 3;

interface PgDriverErrorFields {
  code?: unknown;
  detail?: unknown;
}

function isSlugUniqueViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err as QueryFailedError & PgDriverErrorFields;
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(`(${SLUG_COLUMN})`)
  );
}

// `complete` needs every part, once, in order: exactly 1..partCount.
function isCompletePartList(
  parts: CompletedPartDto[],
  partCount: number,
): boolean {
  return (
    parts.length === partCount &&
    parts.every((part, index) => part.partNumber === index + 1)
  );
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storage: StorageService,
    private readonly lifecycle: VideoLifecycleService,
    private readonly processingQueue: VideoProcessingQueue,
  ) {}

  /**
   * Pre-registers a `draft` in the caller's channel and opens the S3
   * multipart session for `videos/{id}/original` (TD-03). The id is generated
   * here because the storage key must exist before the insert (TD-05).
   */
  async startUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<VideoUploadSessionDto> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      // Phase-02 invariant: every registered user owns exactly one channel.
      throw new Error(`User ${userId} has no channel`);
    }

    const id = randomUUID();
    const key = originalKey(id);
    const uploadId = await this.storage.createMultipartUpload(
      key,
      dto.contentType,
    );

    try {
      const slug = await this.insertDraftWithUniqueSlug({
        id,
        channel_id: channel.id,
        title: deriveVideoTitle(dto.title, dto.filename),
        original_filename: dto.filename,
        content_type: dto.contentType,
        size_bytes: dto.size,
        upload_id: uploadId,
      });
      return {
        id,
        slug,
        status: VideoStatus.DRAFT,
        partSize: VIDEO_PART_SIZE_BYTES,
        partCount: computePartCount(dto.size),
      };
    } catch (err) {
      // No row references the session: release it before rethrowing.
      await this.storage.abortMultipartUpload(key, uploadId);
      throw err;
    }
  }

  /**
   * Owner-scoped read: a missing video and another channel's video both 404.
   * Postgres matches a `uuid` in any case, so callers must use the returned
   * `video.id` (canonical lowercase), never the request id, for storage keys,
   * job ids and lifecycle writes.
   */
  async findOwnedById(userId: string, id: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id, channel: { user_id: userId } },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  /**
   * Public playback by slug (TD-11, TD-14): a presigned public `GetObject`
   * URL (1 h) for the original, so storage serves `Range`/`206` itself. Only
   * `ready` videos resolve; an unknown slug and a `draft`/`processing`/
   * `failed` video both answer VIDEO_NOT_FOUND, so the state is not revealed.
   * `download` adds an attachment `Content-Disposition`; `stream` has no
   * response overrides. A value that is not an 11-char base64url slug
   * cannot exist, so it answers VIDEO_NOT_FOUND before any query.
   */
  async getPlaybackUrl(slug: string, mode: PlaybackMode): Promise<string> {
    if (!isVideoSlug(slug)) {
      throw new VideoNotFoundException();
    }
    const video = await this.videoRepository.findOne({
      where: { slug, status: VideoStatus.READY },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return this.storage.presignGetObject(originalKey(video.id), {
      client: 'public',
      expiresIn: PLAYBACK_URL_TTL_SECONDS,
      responseContentDisposition:
        mode === 'download'
          ? buildDownloadContentDisposition(
              video.title,
              video.original_filename,
            )
          : undefined,
    });
  }

  /**
   * Presigns `UploadPart` URLs (public client, 1 h TTL) for the owner's draft,
   * so the bytes go straight to storage (TD-02). Every part number is checked
   * against `partCount` before anything is signed.
   */
  async signUploadParts(
    userId: string,
    id: string,
    partNumbers: number[],
  ): Promise<SignedUploadPartsDto> {
    const video = await this.findOwnedById(userId, id);
    const uploadId = this.activeUploadId(video);

    const partCount = computePartCount(video.size_bytes);
    if (partNumbers.some((partNumber) => partNumber > partCount)) {
      throw new UploadPartsInvalidException();
    }

    const expiresAt = new Date(Date.now() + UPLOAD_PART_URL_TTL_SECONDS * 1000);
    const key = originalKey(video.id);
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storage.presignUploadPart(
          key,
          uploadId,
          partNumber,
          UPLOAD_PART_URL_TTL_SECONDS,
        ),
      })),
    );
    return { parts, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Lists the parts already stored for the owner's draft, so an interrupted
   * upload can resume. A storage session that no longer exists means the
   * upload is not active (TD-03 AMB-7 revision); the row is left unchanged.
   */
  async listUploadedParts(
    userId: string,
    id: string,
  ): Promise<UploadedPartsDto> {
    const video = await this.findOwnedById(userId, id);
    const uploadId = this.activeUploadId(video);

    try {
      const parts = await this.storage.listParts(
        originalKey(video.id),
        uploadId,
      );
      return { parts };
    } catch (err) {
      if (err instanceof UploadSessionNotFoundError) {
        throw new VideoUploadNotActiveException();
      }
      throw err;
    }
  }

  /**
   * User abort of the owner's draft (TD-03 AMB-5/AMB-7 revisions): release the
   * multipart session, delete any original left by the completion crash
   * window, then move the row to `failed`/`UPLOAD_ABORTED` with a guarded
   * update. A non-draft video is rejected before any storage call; a guarded
   * update that matches no row means a concurrent actor (e.g. `complete`)
   * moved the video first, which also answers VIDEO_UPLOAD_NOT_ACTIVE.
   */
  async abortUpload(userId: string, id: string): Promise<void> {
    const video = await this.findOwnedById(userId, id);
    const uploadId = this.activeUploadId(video);

    const key = originalKey(video.id);
    await this.storage.abortMultipartUpload(key, uploadId);
    await this.storage.deleteObject(key);

    const failed = await this.lifecycle.failDraft(video.id, 'UPLOAD_ABORTED');
    if (!failed) {
      throw new VideoUploadNotActiveException();
    }
  }

  /**
   * Completes the owner's upload and starts processing (TD-03, TD-13):
   * `CompleteMultipartUpload` → `HeadObject` size check → guarded
   * `draft → processing` → enqueue (after the commit, `jobId = videoId`).
   * Idempotent: a `processing` video re-adds its deterministic job, and a
   * `NoSuchUpload` whose object already exists (storage completed, DB commit
   * lost) continues from the size check (AMB-7).
   */
  async completeUpload(
    userId: string,
    id: string,
    parts: CompletedPartDto[],
  ): Promise<VideoProcessingStartedDto> {
    const video = await this.findOwnedById(userId, id);
    if (video.status === VideoStatus.PROCESSING) {
      await this.processingQueue.enqueue(video.id);
      return this.processingStarted(video);
    }

    const uploadId = this.activeUploadId(video);
    if (!isCompletePartList(parts, computePartCount(video.size_bytes))) {
      throw new UploadPartsInvalidException();
    }

    const key = originalKey(video.id);
    await this.completeStoredUpload(key, uploadId, parts);

    const stored = await this.storage.headObject(key);
    if (!stored) {
      // The session is gone and nothing was stored: the sweeper expires it.
      throw new VideoUploadNotActiveException();
    }
    if (stored.size !== video.size_bytes) {
      await this.storage.deleteObject(key);
      await this.lifecycle.failDraft(video.id, 'UPLOAD_SIZE_MISMATCH');
      throw new UploadSizeMismatchException();
    }

    const moved = await this.lifecycle.markProcessing(video.id);
    if (!moved) {
      // Another actor moved the row first; only a concurrent `complete`
      // (now `processing`) is a success for this call.
      const current = await this.findOwnedById(userId, video.id);
      if (current.status !== VideoStatus.PROCESSING) {
        throw new VideoUploadNotActiveException();
      }
    }

    await this.processingQueue.enqueue(video.id);
    return this.processingStarted(video);
  }

  // `NoSuchUpload` is not an error here: storage may have completed the
  // upload before a crash, so the following HeadObject decides (AMB-7).
  private async completeStoredUpload(
    key: string,
    uploadId: string,
    parts: CompletedPartDto[],
  ): Promise<void> {
    try {
      await this.storage.completeMultipartUpload(key, uploadId, parts);
    } catch (err) {
      if (err instanceof InvalidUploadPartsError) {
        throw new UploadPartsInvalidException();
      }
      if (!(err instanceof UploadSessionNotFoundError)) {
        throw err;
      }
    }
  }

  private processingStarted(video: Video): VideoProcessingStartedDto {
    return { id: video.id, slug: video.slug, status: VideoStatus.PROCESSING };
  }

  // Only a `draft` has an upload session; any other status (or a draft whose
  // session was already cleared) answers VIDEO_UPLOAD_NOT_ACTIVE.
  private activeUploadId(video: Video): string {
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoUploadNotActiveException();
    }
    return video.upload_id;
  }

  // Standalone inserts (no transaction), so a failed attempt never aborts the
  // next one. Only a collision on the `slug` constraint is retried.
  private async insertDraftWithUniqueSlug(draft: NewDraft): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      const slug = generateVideoSlug();
      try {
        await this.videoRepository.insert({
          ...draft,
          slug,
          status: VideoStatus.DRAFT,
        });
        return slug;
      } catch (err) {
        if (!isSlugUniqueViolation(err) || attempt >= MAX_SLUG_ATTEMPTS) {
          throw err;
        }
      }
    }
  }
}
