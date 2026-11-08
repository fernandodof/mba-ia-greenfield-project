import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../video.types';

export class VideoProcessingStartedDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ', description: '11-char base64url' })
  slug: string;

  @ApiProperty({
    enum: [VideoStatus.PROCESSING],
    example: VideoStatus.PROCESSING,
  })
  status: VideoStatus.PROCESSING;
}
