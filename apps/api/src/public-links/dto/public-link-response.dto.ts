import { ApiProperty } from '@nestjs/swagger';

export class PublicLinkResponseDto {
  @ApiProperty({
    format: 'uuid',
  })
  id!: string;

  @ApiProperty({
    nullable: true,
  })
  expiresAt!: Date | null;

  @ApiProperty({
    nullable: true,
  })
  revokedAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;
}

export class CreatedPublicLinkResponseDto extends PublicLinkResponseDto {
  @ApiProperty({
    description: 'Raw public token. Returned only when the link is created.',
  })
  token!: string;
}
