import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';
import { VIDEO_MAX_PART_COUNT } from '../video.constants';

export class SignUploadPartsDto {
  /**
   * Part numbers to sign (1..160 unique integers ≥ 1). Each must also be at
   * most the video's `partCount`.
   * @example [1, 2]
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(VIDEO_MAX_PART_COUNT)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  partNumbers: number[];
}
