import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { VIDEO_MAX_PART_COUNT } from '../video.constants';

// S3 ETag shape: visible ASCII without `"`, optionally wrapped in one pair of
// quotes (MinIO answers `"<32 hex>"`, or `"<32 hex>-N"` for a completed
// multipart object). Controls such as NUL would make storage reject the
// CompleteMultipartUpload XML as malformed.
const ETAG_PATTERN = /^(?:"[\x21\x23-\x7E]+"|[\x21\x23-\x7E]+)$/;
const ETAG_MAX_LENGTH = 128;

export class CompletedPartDto {
  /**
   * Part number, as signed and uploaded.
   * @example 1
   */
  @IsInt()
  @Min(1)
  partNumber: number;

  /**
   * The `ETag` header storage returned for the part PUT (quotes included).
   * @example "\"9b2cf535f27731c974343645a3985328\""
   */
  @IsString()
  @IsNotEmpty()
  @Matches(ETAG_PATTERN, {
    message: '$property must be an S3 ETag (visible ASCII, optionally quoted)',
  })
  @MaxLength(ETAG_MAX_LENGTH)
  etag: string;
}

export class CompleteUploadDto {
  /**
   * Every uploaded part (1..160 entries). The list must hold exactly the
   * video's `partCount` parts in ascending `partNumber` order.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(VIDEO_MAX_PART_COUNT)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
