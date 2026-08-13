import { ApiProperty } from '@nestjs/swagger';

export class DownloadFileResponseDto {
  @ApiProperty({
    format: 'uri',
    description: 'Temporary URL for downloading the file.',
  })
  url!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
  })
  expiresAt!: Date;
}
