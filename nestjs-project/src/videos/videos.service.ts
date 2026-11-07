import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { UploadSessionNotFoundError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import type { CreateVideoDto } from './dto/create-video.dto';
import type { SignedUploadPartsDto } from './dto/signed-upload-parts.dto';
import type { UploadedPartsDto } from './dto/uploaded-parts.dto';
import type { VideoUploadSessionDto } from './dto/video-upload-session.dto';
import { Video } from './entities/video.entity';
import {
  computePartCount,
  UPLOAD_PART_URL_TTL_SECONDS,
  VIDEO_PART_SIZE_BYTES,
} from './video.constants';
import { generateVideoSlug } from './video-slug.util';
import { originalKey } from './video-storage-keys';
import { deriveVideoTitle } from './video-title.util';
import { VideoStatus } from './video.types';
import {
  UploadPartsInvalidException,
  VideoNotFoundException,
  VideoUploadNotActiveException,
} from './videos.exceptions';

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

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storage: StorageService,
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

  /** Owner-scoped read: a missing video and another channel's video both 404. */
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
    const key = originalKey(id);
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
      const parts = await this.storage.listParts(originalKey(id), uploadId);
      return { parts };
    } catch (err) {
      if (err instanceof UploadSessionNotFoundError) {
        throw new VideoUploadNotActiveException();
      }
      throw err;
    }
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
