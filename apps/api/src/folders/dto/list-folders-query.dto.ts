import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class ListFoldersQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Parent folder ID. Omit to list root folders.',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;
}
