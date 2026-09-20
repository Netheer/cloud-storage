import { ApiProperty } from '@nestjs/swagger';

export class PreviewFileResponseDto {
  @ApiProperty({
    format: 'uri',
    description: 'Temporary URL for displaying the generated file preview.',
  })
  url!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
  })
  expiresAt!: Date;

  @ApiProperty({
    example: 'image/webp',
  })
  mimeType!: string;

  @ApiProperty({
    example: 512,
  })
  width!: number;

  @ApiProperty({
    example: 341,
  })
  height!: number;
}
