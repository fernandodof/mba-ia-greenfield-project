import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { MaxCodePoints } from '../../common/validators/max-code-points.validator';
import { NoControlCharacters } from '../../common/validators/no-control-characters.validator';
import { VIDEO_MAX_SIZE_BYTES } from '../video.constants';
import { VIDEO_TITLE_MAX_CODE_POINTS } from '../video-title.util';

const FILENAME_MAX_CODE_POINTS = 255;
const CONTENT_TYPE_MAX_LENGTH = 127;

// `video/<subtype>[; name=value]*` in visible ASCII only (RFC 6838 subtype
// chars, RFC 9110 token / quoted-string parameters, one optional space
// around `;`). The value becomes the S3 `Content-Type` header, so CR/LF,
// NUL, other controls and non-ASCII must never reach the SDK.
const MIME_SUBTYPE = '[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*';
const MIME_TOKEN = "[A-Za-z0-9!#$%&'*+.^_`|~-]+";
const MIME_QUOTED = '"[ !#-\\[\\]-~]*"';
const VIDEO_CONTENT_TYPE_PATTERN = new RegExp(
  `^video/${MIME_SUBTYPE}(?: ?; ?${MIME_TOKEN}=(?:${MIME_TOKEN}|${MIME_QUOTED}))*$`,
);

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateVideoDto {
  /**
   * Video title, 1–100 Unicode code points after trimming. Defaults to the
   * filename without its extension. Omit it to use the default; `null` is
   * rejected like any other non-string.
   * @example 'My first video'
   */
  // Not `@IsOptional()`: it also skips `null`, which would then reach
  // `deriveVideoTitle`. Only an absent title falls back to the default.
  @ValidateIf((_dto: CreateVideoDto, value: unknown) => value !== undefined)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxCodePoints(VIDEO_TITLE_MAX_CODE_POINTS)
  @NoControlCharacters()
  title?: string;

  /**
   * Original file name (1–255 code points), stored unchanged.
   * @example 'clip.mp4'
   */
  @IsString()
  @Matches(/\S/)
  @MaxCodePoints(FILENAME_MAX_CODE_POINTS)
  @NoControlCharacters()
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
   * `video/*` content type of the file (visible ASCII, optional parameters).
   * @example 'video/mp4'
   */
  @IsString()
  // Explicit message: the default one embeds the pattern, and class-validator
  // builds it with `String.replace`, which mangles the `$&` it contains.
  @Matches(VIDEO_CONTENT_TYPE_PATTERN, {
    message:
      'contentType must be a video/* media type in visible ASCII (optional ; parameters)',
  })
  @MaxLength(CONTENT_TYPE_MAX_LENGTH)
  contentType: string;
}
