import { ApiProperty } from '@nestjs/swagger';

export class FolderResponseDto {
  @ApiProperty({
    format: 'uuid',
  })
  id!: string;

  @ApiProperty({
    example: 'Documents',
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
  parentId!: string | null;

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
