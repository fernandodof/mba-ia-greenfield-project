import { ApiProperty } from '@nestjs/swagger';
import type { Video } from '../entities/video.entity';
import { VideoStatus, type VideoFailureReason } from '../video.types';

const FAILURE_REASONS: VideoFailureReason[] = [
  'UPLOAD_EXPIRED',
  'UPLOAD_ABORTED',
  'UPLOAD_SIZE_MISMATCH',
  'INVALID_MEDIA',
  'THUMBNAIL_FAILED',
  'SOURCE_MISSING',
  'PROCESSING_FAILED',
];

/**
 * Owner view of a video. `upload_id`, `thumbnail_key` and
 * `processing_started_at` are internal and never exposed.
 */
export class VideoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  slug: string;

  @ApiProperty({ example: 'clip' })
  title: string;

  @ApiProperty({ enum: VideoStatus, enumName: 'VideoStatus' })
  status: VideoStatus;

  @ApiProperty({
    type: String,
    enum: FAILURE_REASONS,
    required: false,
    nullable: true,
  })
  failureReason: VideoFailureReason | null;

  @ApiProperty({ example: 'clip.mp4' })
  originalFilename: string;

  @ApiProperty({ example: 'video/mp4' })
  contentType: string;

  @ApiProperty({ example: 1048576 })
  sizeBytes: number;

  @ApiProperty({ type: Number, required: false, nullable: true })
  durationMs: number | null;

  @ApiProperty({ type: Number, required: false, nullable: true })
  width: number | null;

  @ApiProperty({ type: Number, required: false, nullable: true })
  height: number | null;

  @ApiProperty({ type: String, required: false, nullable: true })
  videoCodec: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static fromEntity(video: Video): VideoDto {
    const dto = new VideoDto();
    dto.id = video.id;
    dto.slug = video.slug;
    dto.title = video.title;
    dto.status = video.status;
    dto.failureReason = video.failure_reason;
    dto.originalFilename = video.original_filename;
    dto.contentType = video.content_type;
    dto.sizeBytes = video.size_bytes;
    dto.durationMs = video.duration_ms;
    dto.width = video.width;
    dto.height = video.height;
    dto.videoCodec = video.video_codec;
    dto.createdAt = video.created_at;
    dto.updatedAt = video.updated_at;
    return dto;
  }
}
