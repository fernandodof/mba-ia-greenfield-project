import { ApiProperty } from '@nestjs/swagger';

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({
    example: '"5d41402abc4b2a76b9719d911017c592"',
    description: 'ETag stored for the part, as returned by the part PUT',
  })
  etag: string;

  @ApiProperty({ example: 67108864, description: 'Part size in bytes' })
  size: number;
}

export class UploadedPartsDto {
  @ApiProperty({
    type: [UploadedPartDto],
    description: 'Parts already stored, in ascending part number order',
  })
  parts: UploadedPartDto[];
}
