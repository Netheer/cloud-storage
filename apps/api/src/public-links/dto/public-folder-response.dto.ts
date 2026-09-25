import { ApiProperty } from '@nestjs/swagger';

export class PublicFolderItemDto {
  @ApiProperty({
    format: 'uuid',
  })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
  })
  parentId!: string | null;
}

export class PublicFolderFileDto {
  @ApiProperty({
    format: 'uuid',
  })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({
    nullable: true,
  })
  mimeType!: string | null;

  @ApiProperty({
    description: 'File size in bytes represented as a string.',
  })
  size!: string;
}

export class PublicFolderResponseDto {
  @ApiProperty({
    format: 'uuid',
  })
  rootFolderId!: string;

  @ApiProperty({
    type: PublicFolderItemDto,
  })
  folder!: PublicFolderItemDto;

  @ApiProperty({
    type: PublicFolderItemDto,
    isArray: true,
  })
  folders!: PublicFolderItemDto[];

  @ApiProperty({
    type: PublicFolderFileDto,
    isArray: true,
  })
  files!: PublicFolderFileDto[];
}
