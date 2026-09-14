import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { StorageModule } from '../storage/storage.module';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { FileProcessingQueueModule } from '../queue/file-processing-queue.module';

@Module({
  imports: [DatabaseModule, StorageModule, FileProcessingQueueModule],
  controllers: [FilesController],
  providers: [FilesService],
})
export class FilesModule {}
