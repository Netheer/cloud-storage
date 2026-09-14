import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { FileProcessingWorker } from './file-processing.worker';

@Module({
  imports: [DatabaseModule],
  providers: [FileProcessingWorker],
})
export class FileProcessingModule {}
