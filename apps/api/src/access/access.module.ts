import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AccessService } from './access.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [DatabaseModule, AuditModule],
  providers: [AccessService],
  exports: [AccessService],
})
export class AccessModule {}
