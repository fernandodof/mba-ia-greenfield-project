import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { VIDEO_MAX_PART_COUNT } from '../video.constants';

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
