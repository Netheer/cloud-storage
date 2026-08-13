import { ApiProperty } from '@nestjs/swagger';
import { Transform, type TransformFnParams } from 'class-transformer';
import { IsString, MaxLength, MinLength, NotContains } from 'class-validator';

export class RenameFileDto {
  @ApiProperty({
    example: 'renamed-document.pdf',
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
    message: 'File name must not contain "/"',
  })
  @NotContains('\\', {
    message: 'File name must not contain "\\"',
  })
  name!: string;
}
