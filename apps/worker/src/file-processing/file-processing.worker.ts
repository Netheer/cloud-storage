import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';
import {
  FILE_PROCESSING_QUEUE_NAME,
  PROCESS_FILE_JOB_NAME,
  type ProcessFileJob,
} from './file-processing.constants';

@Injectable()
export class FileProcessingWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FileProcessingWorker.name);

  private readonly redisHost: string;
  private readonly redisPort: number;

  private worker: Worker<ProcessFileJob> | null = null;

  constructor(configService: ConfigService) {
    this.redisHost = configService.getOrThrow<string>('REDIS_HOST');
    this.redisPort = Number(configService.getOrThrow<string>('REDIS_PORT'));

    if (!Number.isInteger(this.redisPort)) {
      throw new Error('REDIS_PORT must be an integer');
    }
  }

  onModuleInit(): void {
    this.worker = new Worker<ProcessFileJob>(
      FILE_PROCESSING_QUEUE_NAME,
      (job: Job<ProcessFileJob>): Promise<void> => {
        if (job.name !== PROCESS_FILE_JOB_NAME) {
          return Promise.reject(new Error(`Unsupported job name: ${job.name}`));
        }

        this.logger.log(
          `Processing job ${job.id}: ` +
            `fileId=${job.data.fileId}, ` +
            `versionId=${job.data.versionId}, ` +
            `storedObjectId=${job.data.storedObjectId}`,
        );

        return Promise.resolve();
      },
      {
        connection: {
          host: this.redisHost,
          port: this.redisPort,
        },
      },
    );

    this.worker.on('completed', (job) => {
      this.logger.log(`Job ${job.id} completed`);
    });

    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `Job ${job?.id ?? 'unknown'} failed: ${error.message}`,
        error.stack,
      );
    });

    this.worker.on('error', (error) => {
      this.logger.error('BullMQ worker error', error.stack);
    });

    this.logger.log(`Listening on queue "${FILE_PROCESSING_QUEUE_NAME}"`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
