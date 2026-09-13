import { Module } from '@nestjs/common';
import { FileProcessingWorker } from './file-processing.worker';

@Module({
  providers: [FileProcessingWorker],
})
export class FileProcessingModule {}
