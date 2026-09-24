import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AccessService } from './access.service';

@Module({
  imports: [DatabaseModule],
  providers: [AccessService],
  exports: [AccessService],
})
export class AccessModule {}
