import {
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';

export class ServiceHealthDto {
  @ApiProperty({
    enum: ['up', 'down'],
    example: 'up',
  })
  status!: 'up' | 'down';

  @ApiPropertyOptional({
    example: 2,
    minimum: 0,
  })
  latencyMs?: number;
}

export class HealthServicesDto {
  @ApiProperty({
    type: ServiceHealthDto,
  })
  postgres!: ServiceHealthDto;

  @ApiProperty({
    type: ServiceHealthDto,
  })
  redis!: ServiceHealthDto;

  @ApiProperty({
    type: ServiceHealthDto,
  })
  storage!: ServiceHealthDto;
}

export class HealthResponseDto {
  @ApiProperty({
    enum: ['ok', 'error'],
    example: 'ok',
  })
  status!: 'ok' | 'error';

  @ApiProperty({
    format: 'date-time',
    example: '2026-07-27T12:00:00.000Z',
  })
  timestamp!: string;

  @ApiProperty({
    type: HealthServicesDto,
  })
  services!: HealthServicesDto;
}