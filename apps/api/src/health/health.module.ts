import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { HealthController } from './health.controller';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [DatabaseModule, RedisModule, StorageModule],
  controllers: [HealthController],
})
export class HealthModule {}