import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { PrismaService } from '../database/prisma.service';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from '../storage/object-storage.interface';
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

  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE)
    private readonly objectStorage: ObjectStorage,
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
        await this.processJob(job);
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

  private async processJob(job: Job<ProcessFileJob>): Promise<void> {
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

    const storedObject = version.storedObject;

    if (storedObject.sha256) {
      this.logger.log(
        `Stored object ${storedObject.id} already has SHA-256 ` +
          `${storedObject.sha256}`,
      );

      return;
    }

    this.logger.log(
      `Reading stored object ${storedObject.id}: ` +
        `objectKey=${storedObject.objectKey}, ` +
        `expectedSize=${storedObject.size.toString()}`,
    );

    const stream = await this.objectStorage.getObjectStream(
      storedObject.objectKey,
    );

    const calculated = await this.calculateSha256(stream);

    if (calculated.size !== storedObject.size) {
      throw new Error(
        `Stored object size mismatch: ` +
          `expected=${storedObject.size.toString()}, ` +
          `actual=${calculated.size.toString()}`,
      );
    }

    const updateResult = await this.prisma.storedObject.updateMany({
      where: {
        id: storedObject.id,
        sha256: null,
      },
      data: {
        sha256: calculated.sha256,
      },
    });

    if (updateResult.count === 0) {
      const currentObject = await this.prisma.storedObject.findUnique({
        where: {
          id: storedObject.id,
        },
        select: {
          sha256: true,
        },
      });

      if (currentObject?.sha256 !== calculated.sha256) {
        throw new Error(
          `Stored object ${storedObject.id} SHA-256 changed concurrently`,
        );
      }

      this.logger.log(
        `SHA-256 for stored object ${storedObject.id} ` +
          `was already stored by another worker`,
      );

      return;
    }

    this.logger.log(
      `Calculated SHA-256 for stored object ${storedObject.id}: ` +
        `${calculated.sha256}`,
    );
  }

  private async calculateSha256(stream: Readable): Promise<{
    sha256: string;
    size: bigint;
  }> {
    const hash = createHash('sha256');
    let size = 0n;

    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      size += BigInt(chunk.byteLength);
    }

    return {
      sha256: hash.digest('hex'),
      size,
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
