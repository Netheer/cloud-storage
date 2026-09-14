import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import {
  FILE_PROCESSING_QUEUE_NAME,
  PROCESS_FILE_JOB_NAME,
  type ProcessFileJob,
} from './file-processing.constants';

@Injectable()
export class FileProcessingQueueService implements OnModuleDestroy {
  private readonly queue: Queue<ProcessFileJob>;

  constructor(configService: ConfigService) {
    const host = configService.getOrThrow<string>('REDIS_HOST');
    const port = Number(configService.getOrThrow<string>('REDIS_PORT'));

    if (!Number.isInteger(port)) {
      throw new Error('REDIS_PORT must be an integer');
    }

    this.queue = new Queue<ProcessFileJob>(FILE_PROCESSING_QUEUE_NAME, {
      connection: {
        host,
        port,
      },
    });
  }

  async enqueue(input: ProcessFileJob): Promise<string | undefined> {
    const job = await this.queue.add(PROCESS_FILE_JOB_NAME, input, {
      jobId: input.versionId,
    });

    return job.id;
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
