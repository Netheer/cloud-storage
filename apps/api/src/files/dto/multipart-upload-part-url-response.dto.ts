import { ApiProperty } from '@nestjs/swagger';

export class MultipartUploadPartUrlResponseDto {
  @ApiProperty({
    example: 1,
  })
  partNumber!: number;

  @ApiProperty({
    example: 'https://storage.example/upload-part',
    description: 'Temporary URL for uploading this part with HTTP PUT.',
  })
  url!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
  })
  expiresAt!: Date;
}
