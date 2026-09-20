import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { OutboxPublisherService } from './outbox-publisher.service';

@Module({
  imports: [DatabaseModule],
  providers: [OutboxPublisherService],
})
export class OutboxModule {}
