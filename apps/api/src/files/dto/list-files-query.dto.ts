import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class ListFilesQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Folder ID. Omit to list root files.',
  })
  @IsOptional()
  @IsUUID()
  folderId?: string;
}
