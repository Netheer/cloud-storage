import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, type TransformFnParams } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  NotContains,
} from 'class-validator';

export class CreateFolderDto {
  @ApiProperty({
    example: 'Documents',
    minLength: 1,
    maxLength: 255,
  })
  @Transform((params: TransformFnParams): unknown => {
    const value: unknown = params.value;

    return typeof value === 'string' ? value.trim() : value;
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @NotContains('/', {
    message: 'Folder name must not contain "/"',
  })
  @NotContains('\\', {
    message: 'Folder name must not contain "\\"',
  })
  name!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Parent folder ID. Omit or send null to create a root folder.',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string | null;
}
