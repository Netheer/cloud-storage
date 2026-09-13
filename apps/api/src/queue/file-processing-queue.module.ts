import { Module } from '@nestjs/common';
import { FileProcessingQueueService } from './file-processing-queue.service';

@Module({
  providers: [FileProcessingQueueService],
  exports: [FileProcessingQueueService],
})
export class FileProcessingQueueModule {}
