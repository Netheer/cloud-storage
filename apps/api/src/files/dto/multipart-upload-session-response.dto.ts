import { ApiProperty } from '@nestjs/swagger';

export class MultipartUploadSessionResponseDto {
  @ApiProperty({
    format: 'uuid',
  })
  id!: string;

  @ApiProperty({
    format: 'uuid',
  })
  clientRequestId!: string;

  @ApiProperty({
    example: 'large-video.mp4',
  })
  originalName!: string;

  @ApiProperty({
    example: 'video/mp4',
    nullable: true,
  })
  mimeType!: string | null;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
  })
  folderId!: string | null;

  @ApiProperty({
    example: '524288000',
  })
  totalSize!: string;

  @ApiProperty({
    example: '8388608',
    description: 'Part size in bytes.',
  })
  partSize!: string;

  @ApiProperty({
    example: 63,
  })
  totalParts!: number;

  @ApiProperty({
    enum: [
      'CREATED',
      'UPLOADING',
      'COMPLETING',
      'COMPLETED',
      'ABORTED',
      'EXPIRED',
      'FAILED',
    ],
  })
  status!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
  })
  expiresAt!: Date;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description: 'Created file ID after successful completion.',
  })
  fileId!: string | null;
}
