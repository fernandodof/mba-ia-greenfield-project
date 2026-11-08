import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../video.types';

export class VideoUploadSessionDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ', description: '11-char base64url' })
  slug: string;

  @ApiProperty({ enum: [VideoStatus.DRAFT], example: VideoStatus.DRAFT })
  status: VideoStatus.DRAFT;

  @ApiProperty({ example: 67108864, description: 'Part size in bytes' })
  partSize: number;

  @ApiProperty({ example: 1, description: 'ceil(size / partSize)' })
  partCount: number;
}
