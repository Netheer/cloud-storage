import { ApiProperty } from '@nestjs/swagger';

export class FileVersionResponseDto {
  @ApiProperty({
    format: 'uuid',
  })
  id!: string;

  @ApiProperty({
    example: 2,
  })
  versionNumber!: number;

  @ApiProperty({
    example: 'document-v2.pdf',
  })
  originalName!: string;

  @ApiProperty({
    example: 'application/pdf',
    nullable: true,
  })
  mimeType!: string | null;

  @ApiProperty({
    description: 'File size in bytes',
    example: '1048576',
  })
  size!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
  })
  createdAt!: Date;

  @ApiProperty({
    example: true,
  })
  isCurrent!: boolean;
}
