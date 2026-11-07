import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MaxCodePoints } from '../../common/validators/max-code-points.validator';
import { VIDEO_MAX_SIZE_BYTES } from '../video.constants';
import { VIDEO_TITLE_MAX_CODE_POINTS } from '../video-title.util';

const FILENAME_MAX_CODE_POINTS = 255;
const CONTENT_TYPE_MAX_LENGTH = 127;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateVideoDto {
  /**
   * Video title, 1–100 Unicode code points after trimming. Defaults to the
   * filename without its extension.
   * @example 'My first video'
   */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxCodePoints(VIDEO_TITLE_MAX_CODE_POINTS)
  title?: string;

  /**
   * Original file name (1–255 code points), stored unchanged.
   * @example 'clip.mp4'
   */
  @IsString()
  @Matches(/\S/)
  @MaxCodePoints(FILENAME_MAX_CODE_POINTS)
  filename: string;

  /**
   * File size in bytes (at most 10 GiB).
   * @example 1048576
   */
  @IsInt()
  @Min(1)
  @Max(VIDEO_MAX_SIZE_BYTES)
  size: number;

  /**
   * `video/*` content type of the file.
   * @example 'video/mp4'
   */
  @IsString()
  @Matches(/^video\//)
  @MaxLength(CONTENT_TYPE_MAX_LENGTH)
  contentType: string;
}
