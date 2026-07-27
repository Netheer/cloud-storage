import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import { OBJECT_STORAGE } from '../storage/object-storage.interface';
import type { ObjectStorage } from '../storage/object-storage.interface';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { HealthResponseDto } from './dto/health-response.dto';

type ServiceHealth =
  | {
      status: 'up';
      latencyMs: number;
    }
  | {
      status: 'down';
    };

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,

    @Inject(OBJECT_STORAGE)
    private readonly objectStorage: ObjectStorage,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Check infrastructure health',
    description: 'Checks PostgreSQL, Redis and object storage availability.',
  })
  @ApiOkResponse({
    description: 'All infrastructure services are available.',
    type: HealthResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'At least one infrastructure service is unavailable.',
    type: HealthResponseDto,
  })
  async check() {
    const [postgres, redis, storage] = await Promise.all([
      this.checkPostgres(),
      this.checkRedis(),
      this.checkObjectStorage(),
    ]);

    const services = {
      postgres,
      redis,
      storage,
    };

    const isHealthy = Object.values(services).every(
      (service) => service.status === 'up',
    );

    const response = {
      status: isHealthy ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      services,
    };

    if (!isHealthy) {
      throw new ServiceUnavailableException(response);
    }

    return response;
  }

  private async checkPostgres(): Promise<ServiceHealth> {
    const startedAt = Date.now();

    try {
      await this.prisma.$queryRaw`SELECT 1`;

      return {
        status: 'up',
        latencyMs: Date.now() - startedAt,
      };
    } catch {
      return {
        status: 'down',
      };
    }
  }

  private async checkRedis(): Promise<ServiceHealth> {
    const startedAt = Date.now();

    try {
      await this.redis.ping();

      return {
        status: 'up',
        latencyMs: Date.now() - startedAt,
      };
    } catch {
      return {
        status: 'down',
      };
    }
  }

  private async checkObjectStorage(): Promise<ServiceHealth> {
    const startedAt = Date.now();

    try {
      await this.objectStorage.checkHealth();

      return {
        status: 'up',
        latencyMs: Date.now() - startedAt,
      };
    } catch {
      return {
        status: 'down',
      };
    }
  }
}
