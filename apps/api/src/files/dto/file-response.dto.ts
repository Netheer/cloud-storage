import { ApiProperty } from '@nestjs/swagger';

export class FileResponseDto {
  @ApiProperty({
    format: 'uuid',
  })
  id!: string;

  @ApiProperty({
    example: 'document.pdf',
  })
  name!: string;

  @ApiProperty({
    format: 'uuid',
  })
  ownerId!: string;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
  })
  folderId!: string | null;

  @ApiProperty({
    example: 'READY',
  })
  status!: string;

  @ApiProperty({
    example: 'application/pdf',
    nullable: true,
  })
  mimeType!: string | null;

  @ApiProperty({
    example: '1048576',
    description: 'File size in bytes represented as a string.',
  })
  size!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
  })
  createdAt!: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
  })
  updatedAt!: Date;
}
