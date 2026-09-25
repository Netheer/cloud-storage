import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

export class CreatePublicLinkDto {
  @ApiPropertyOptional({
    description: 'Optional expiration date of the public link',
    example: '2026-10-01T12:00:00.000Z',
    nullable: true,
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;
}
