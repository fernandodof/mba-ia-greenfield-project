import { ApiProperty } from '@nestjs/swagger';

export class SignedUploadPartDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({
    description:
      'Presigned UploadPart URL; PUT the part bytes to it with no extra headers',
  })
  url: string;
}

export class SignedUploadPartsDto {
  @ApiProperty({ type: [SignedUploadPartDto] })
  parts: SignedUploadPartDto[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'When the URLs expire (signing time + 3600 s)',
  })
  expiresAt: string;
}
