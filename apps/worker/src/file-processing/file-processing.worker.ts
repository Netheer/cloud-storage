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
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class FileProcessingWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FileProcessingWorker.name);

  private readonly redisHost: string;
  private readonly redisPort: number;

  private worker: Worker<ProcessFileJob> | null = null;

  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.redisHost = configService.getOrThrow<string>('REDIS_HOST');
    this.redisPort = Number(configService.getOrThrow<string>('REDIS_PORT'));

    if (!Number.isInteger(this.redisPort)) {
      throw new Error('REDIS_PORT must be an integer');
    }
  }

  onModuleInit(): void {
    this.worker = new Worker<ProcessFileJob>(
      FILE_PROCESSING_QUEUE_NAME,

      async (job: Job<ProcessFileJob>): Promise<void> => {
        if (job.name !== PROCESS_FILE_JOB_NAME) {
          throw new Error(`Unsupported job name: ${job.name}`);
        }

        this.logger.log(
          `Processing job ${job.id}: ` +
            `fileId=${job.data.fileId}, ` +
            `versionId=${job.data.versionId}, ` +
            `storedObjectId=${job.data.storedObjectId}`,
        );

        const version = await this.prisma.fileVersion.findUnique({
          where: {
            id: job.data.versionId,
          },
          select: {
            id: true,
            fileId: true,
            storedObjectId: true,
            storedObject: {
              select: {
                id: true,
                objectKey: true,
                size: true,
                sha256: true,
              },
            },
          },
        });

        if (!version) {
          throw new Error(`File version ${job.data.versionId} was not found`);
        }

        if (version.fileId !== job.data.fileId) {
          throw new Error(`Job fileId does not match version ${version.id}`);
        }

        if (version.storedObjectId !== job.data.storedObjectId) {
          throw new Error(
            `Job storedObjectId does not match version ${version.id}`,
          );
        }

        this.logger.log(
          `Resolved stored object ${version.storedObject.id}: ` +
            `objectKey=${version.storedObject.objectKey}, ` +
            `size=${version.storedObject.size.toString()}, ` +
            `sha256=${version.storedObject.sha256 ?? 'null'}`,
        );
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
