import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { StorageModule } from '../storage/storage.module';
import { FileProcessingWorker } from './file-processing.worker';

@Module({
  imports: [DatabaseModule, StorageModule],
  providers: [FileProcessingWorker],
})
export class FileProcessingModule {}
