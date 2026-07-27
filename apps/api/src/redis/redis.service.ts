import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly client: ReturnType<typeof createClient>;

  constructor(configService: ConfigService) {
    const host = configService.getOrThrow<string>('REDIS_HOST');
    const port = Number(configService.getOrThrow<string>('REDIS_PORT'));

    if (!Number.isInteger(port)) {
      throw new Error('REDIS_PORT must be an integer');
    }

    this.client = createClient({
      socket: {
        host,
        port,
        connectTimeout: 1000,
        reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 3000),
      },

      disableOfflineQueue: true,
    });

    this.client.on('error', () => undefined);
  }

  onModuleInit(): void {
    void this.client.connect().catch(() => undefined);
  }

  async ping(): Promise<string> {
    if (!this.client.isReady) {
      throw new Error('Redis is not ready');
    }

    return this.client.ping();
  }

  onModuleDestroy(): void {
    if (this.client.isOpen) {
      this.client.destroy();
    }
  }
}
