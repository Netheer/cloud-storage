import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';

type ServiceHealth =
  | {
      status: 'up';
      latencyMs: number;
    }
  | {
      status: 'down';
    };

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async check() {
    const [postgres, redis] = await Promise.all([
      this.checkPostgres(),
      this.checkRedis(),
    ]);

    const services = {
      postgres,
      redis,
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
}