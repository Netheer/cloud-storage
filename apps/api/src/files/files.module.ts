import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { StorageModule } from '../storage/storage.module';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { AccessModule } from '../access/access.module';

@Module({
  imports: [DatabaseModule, StorageModule, AccessModule],
  controllers: [FilesController],
  providers: [FilesService],
})
export class FilesModule {}
