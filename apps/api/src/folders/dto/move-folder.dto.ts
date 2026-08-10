import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, ValidateIf } from 'class-validator';

export class MoveFolderDto {
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description: 'Destination folder ID. Send null to move to root.',
  })
  @ValidateIf((_object: object, value: unknown) => value !== null)
  @IsUUID()
  parentId!: string | null;
}
