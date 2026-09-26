import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { FoldersController } from './folders.controller';
import { FoldersService } from './folders.service';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [DatabaseModule, AccessModule, AuditModule],
  controllers: [FoldersController],
  providers: [FoldersService],
  exports: [FoldersService],
})
export class FoldersModule {}
