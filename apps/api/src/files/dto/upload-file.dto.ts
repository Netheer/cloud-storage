import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class UploadFileDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Destination folder ID. Omit to upload to root.',
  })
  @IsOptional()
  @IsUUID()
  folderId?: string;
}
