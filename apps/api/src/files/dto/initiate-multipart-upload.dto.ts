import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

export class InitiateMultipartUploadDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Client-generated idempotency key. Reuse it when retrying the request.',
  })
  @IsUUID()
  clientRequestId!: string;

  @ApiProperty({
    example: 'large-video.mp4',
    maxLength: 255,
  })
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @ApiPropertyOptional({
    example: 'video/mp4',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  mimeType?: string;

  @ApiProperty({
    example: '524288000',
    description: 'Total file size in bytes represented as a decimal string.',
  })
  @Matches(/^[1-9]\d*$/, {
    message: 'totalSize must be a positive integer represented as a string',
  })
  totalSize!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Destination folder ID. Omit or use null for root.',
  })
  @IsOptional()
  @IsUUID()
  folderId?: string | null;
}
