import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Worker, UnrecoverableError } from 'bullmq';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { PrismaService } from '../database/prisma.service';
import {
  OBJECT_STORAGE,
  ObjectNotFoundError,
  type ObjectStorage,
} from '../storage/object-storage.interface';
import {
  FILE_PROCESSING_QUEUE_NAME,
  PROCESS_FILE_JOB_NAME,
  type ProcessFileJob,
} from './file-processing.constants';
import sharp from 'sharp';
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

class PermanentFileProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentFileProcessingError';
  }
}

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
        if (job.name !== PROCESS_FILE_JOB_NAME) {
          throw new UnrecoverableError(`Unsupported job name: ${job.name}`);
        }

        try {
          await this.processJob(job);
        } catch (error: unknown) {
          if (
            error instanceof PermanentFileProcessingError ||
            error instanceof ObjectNotFoundError
          ) {
            throw new UnrecoverableError(error.message);
          }

          throw error;
        }
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

      if (!job) {
        return;
      }

      void this.handleFailedJob(job, error).catch((failureError: unknown) => {
        const stack =
          failureError instanceof Error
            ? failureError.stack
            : String(failureError);

        this.logger.error(
          `Failed to update file state after job ${job.id} failure`,
          stack,
        );
      });
    });

    this.worker.on('error', (error) => {
      this.logger.error('BullMQ worker error', error.stack);
    });

    this.logger.log(`Listening on queue "${FILE_PROCESSING_QUEUE_NAME}"`);
  }

  private async processJob(job: Job<ProcessFileJob>): Promise<void> {
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

        mimeType: true,
        imageWidth: true,
        imageHeight: true,
        imageFormat: true,

        previewObjectKey: true,
        previewMimeType: true,
        previewWidth: true,
        previewHeight: true,

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
      throw new PermanentFileProcessingError(
        `File version ${job.data.versionId} was not found`,
      );
    }

    if (version.fileId !== job.data.fileId) {
      throw new PermanentFileProcessingError(
        `Job fileId does not match version ${version.id}`,
      );
    }

    if (version.storedObjectId !== job.data.storedObjectId) {
      if (!version.storedObject.sha256) {
        throw new PermanentFileProcessingError(
          `Job storedObjectId does not match version ${version.id}`,
        );
      }

      this.logger.log(
        `Version ${version.id} already references ` +
          `processed stored object ${version.storedObjectId}; ` +
          `continuing idempotently`,
      );
    }

    let storedObject = version.storedObject;

    if (storedObject.sha256) {
      this.logger.log(
        `Stored object ${storedObject.id} already has SHA-256 ` +
          `${storedObject.sha256}`,
      );
    } else {
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
        throw new PermanentFileProcessingError(
          `Stored object size mismatch: ` +
            `expected=${storedObject.size.toString()}, ` +
            `actual=${calculated.size.toString()}`,
        );
      }

      storedObject = await this.resolveStoredObjectDeduplication({
        versionId: version.id,
        storedObjectId: storedObject.id,
        objectKey: storedObject.objectKey,
        size: calculated.size,
        sha256: calculated.sha256,
      });
    }

    await this.processImageMetadata({
      versionId: version.id,
      objectKey: storedObject.objectKey,
      mimeType: version.mimeType,
      imageWidth: version.imageWidth,
      imageHeight: version.imageHeight,
      imageFormat: version.imageFormat,
    });

    await this.processImagePreview({
      versionId: version.id,
      objectKey: storedObject.objectKey,
      mimeType: version.mimeType,
      previewObjectKey: version.previewObjectKey,
      previewMimeType: version.previewMimeType,
      previewWidth: version.previewWidth,
      previewHeight: version.previewHeight,
    });

    await this.markFileReady(job.data.fileId, job.data.versionId);
  }

  private async resolveStoredObjectDeduplication(input: {
    versionId: string;
    storedObjectId: string;
    objectKey: string;
    size: bigint;
    sha256: string;
  }): Promise<{
    id: string;
    objectKey: string;
    size: bigint;
    sha256: string | null;
  }> {
    const existingObject = await this.prisma.storedObject.findFirst({
      where: {
        sha256: input.sha256,
        size: input.size,
        id: {
          not: input.storedObjectId,
        },
      },
      select: {
        id: true,
        objectKey: true,
        size: true,
        sha256: true,
      },
    });

    if (existingObject) {
      this.logger.log(
        `Dedup hit for stored object ` +
          `${input.storedObjectId}: ` +
          `reusing ${existingObject.id}`,
      );

      return this.relinkVersionToStoredObject({
        versionId: input.versionId,
        duplicateStoredObjectId: input.storedObjectId,
        duplicateObjectKey: input.objectKey,
        canonicalStoredObject: existingObject,
      });
    }

    try {
      const updateResult = await this.prisma.storedObject.updateMany({
        where: {
          id: input.storedObjectId,
          sha256: null,
        },
        data: {
          sha256: input.sha256,
        },
      });

      if (updateResult.count > 0) {
        this.logger.log(
          `Dedup miss for stored object ` +
            `${input.storedObjectId}: ` +
            `stored SHA-256 ${input.sha256}`,
        );

        return {
          id: input.storedObjectId,
          objectKey: input.objectKey,
          size: input.size,
          sha256: input.sha256,
        };
      }

      const currentObject = await this.prisma.storedObject.findUnique({
        where: {
          id: input.storedObjectId,
        },
        select: {
          id: true,
          objectKey: true,
          size: true,
          sha256: true,
        },
      });

      if (
        currentObject?.sha256 === input.sha256 &&
        currentObject.size === input.size
      ) {
        this.logger.log(
          `Stored object ${input.storedObjectId} ` + `was already processed`,
        );

        return currentObject;
      }

      throw new PermanentFileProcessingError(
        `Stored object ${input.storedObjectId} ` + `could not be finalized`,
      );
    } catch (error: unknown) {
      if (!this.isPrismaUniqueConstraintError(error)) {
        throw error;
      }

      /*
       * Другой worker успел первым записать
       * тот же sha256 + size.
       */
      const canonicalObject = await this.prisma.storedObject.findFirst({
        where: {
          sha256: input.sha256,
          size: input.size,
          id: {
            not: input.storedObjectId,
          },
        },
        select: {
          id: true,
          objectKey: true,
          size: true,
          sha256: true,
        },
      });

      if (!canonicalObject) {
        throw error;
      }

      this.logger.log(
        `Dedup race resolved for stored object ` +
          `${input.storedObjectId}: ` +
          `reusing ${canonicalObject.id}`,
      );

      return this.relinkVersionToStoredObject({
        versionId: input.versionId,
        duplicateStoredObjectId: input.storedObjectId,
        duplicateObjectKey: input.objectKey,
        canonicalStoredObject: canonicalObject,
      });
    }
  }

  private async relinkVersionToStoredObject(input: {
    versionId: string;
    duplicateStoredObjectId: string;
    duplicateObjectKey: string;
    canonicalStoredObject: {
      id: string;
      objectKey: string;
      size: bigint;
      sha256: string | null;
    };
  }): Promise<{
    id: string;
    objectKey: string;
    size: bigint;
    sha256: string | null;
  }> {
    const result = await this.prisma.$transaction(async (transaction) => {
      const updatedVersion = await transaction.fileVersion.updateMany({
        where: {
          id: input.versionId,
          storedObjectId: input.duplicateStoredObjectId,
        },
        data: {
          storedObjectId: input.canonicalStoredObject.id,
        },
      });

      if (updatedVersion.count === 0) {
        const currentVersion = await transaction.fileVersion.findUnique({
          where: {
            id: input.versionId,
          },
          select: {
            storedObjectId: true,
          },
        });

        if (currentVersion?.storedObjectId === input.canonicalStoredObject.id) {
          return {
            shouldDeletePhysicalObject: false,
          };
        }

        throw new PermanentFileProcessingError(
          `File version ${input.versionId} ` +
            `could not be relinked during deduplication`,
        );
      }

      await transaction.storedObject.update({
        where: {
          id: input.canonicalStoredObject.id,
        },
        data: {
          referenceCount: {
            increment: 1,
          },
        },
      });

      const duplicateObject = await transaction.storedObject.findUnique({
        where: {
          id: input.duplicateStoredObjectId,
        },
        select: {
          referenceCount: true,
          _count: {
            select: {
              versions: true,
            },
          },
        },
      });

      if (!duplicateObject) {
        return {
          shouldDeletePhysicalObject: false,
        };
      }

      if (duplicateObject._count.versions === 0) {
        const deletedObject = await transaction.storedObject.deleteMany({
          where: {
            id: input.duplicateStoredObjectId,
            versions: {
              none: {},
            },
          },
        });

        return {
          shouldDeletePhysicalObject: deletedObject.count > 0,
        };
      }

      await transaction.storedObject.update({
        where: {
          id: input.duplicateStoredObjectId,
        },
        data: {
          referenceCount: {
            decrement: 1,
          },
        },
      });

      return {
        shouldDeletePhysicalObject: false,
      };
    });

    if (result.shouldDeletePhysicalObject) {
      try {
        await this.objectStorage.deleteObject(input.duplicateObjectKey);

        this.logger.log(
          `Deleted duplicate physical object ` + `${input.duplicateObjectKey}`,
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        this.logger.warn(
          `Could not delete duplicate physical object ` +
            `${input.duplicateObjectKey}: ${message}`,
        );
      }
    }

    return input.canonicalStoredObject;
  }

  private isPrismaUniqueConstraintError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    return Reflect.get(error, 'code') === 'P2002';
  }

  private async handleFailedJob(
    job: Job<ProcessFileJob>,
    error: Error,
  ): Promise<void> {
    if (error instanceof UnrecoverableError) {
      this.logger.warn(
        `Job ${job.id} failed with an unrecoverable error; ` +
          `file will be marked FAILED`,
      );

      await this.recordProcessingFailure({
        job,
        error,
        kind: 'UNRECOVERABLE',
      });

      await this.markFileFailed(job.data.fileId, job.data.versionId);

      return;
    }

    const maxAttempts = job.opts.attempts ?? 1;

    if (job.attemptsMade < maxAttempts) {
      this.logger.warn(
        `Job ${job.id} failed attempt ` +
          `${job.attemptsMade}/${maxAttempts}; ` +
          `file remains PROCESSING`,
      );

      return;
    }

    await this.recordProcessingFailure({
      job,
      error,
      kind: 'RECOVERABLE_EXHAUSTED',
    });

    await this.markFileFailed(job.data.fileId, job.data.versionId);
  }

  private async recordProcessingFailure(input: {
    job: Job<ProcessFileJob>;
    error: Error;
    kind: 'RECOVERABLE_EXHAUSTED' | 'UNRECOVERABLE';
  }): Promise<void> {
    await this.prisma.processingFailure.create({
      data: {
        fileId: input.job.data.fileId,
        versionId: input.job.data.versionId,
        jobId: input.job.id ?? null,
        kind: input.kind,
        reason: input.error.message,
        attempts: input.job.attemptsMade,
      },
    });

    this.logger.warn(
      `Recorded processing failure for job ${input.job.id ?? 'unknown'}: ` +
        `kind=${input.kind}, ` +
        `attempts=${input.job.attemptsMade}, ` +
        `reason=${input.error.message}`,
    );
  }

  private async markFileFailed(
    fileId: string,
    versionId: string,
  ): Promise<void> {
    const result = await this.prisma.file.updateMany({
      where: {
        id: fileId,
        currentVersionId: versionId,
        status: 'PROCESSING',
      },
      data: {
        status: 'FAILED',
      },
    });

    if (result.count > 0) {
      this.logger.log(`File ${fileId} transitioned PROCESSING -> FAILED`);

      return;
    }

    const file = await this.prisma.file.findUnique({
      where: {
        id: fileId,
      },
      select: {
        currentVersionId: true,
        status: true,
      },
    });

    if (file?.currentVersionId === versionId && file.status === 'FAILED') {
      this.logger.log(`File ${fileId} is already FAILED`);

      return;
    }

    if (file?.currentVersionId === versionId && file.status === 'READY') {
      this.logger.warn(
        `File ${fileId} is already READY; ` +
          `FAILED state will not overwrite it`,
      );

      return;
    }

    if (file && file.currentVersionId !== versionId) {
      this.logger.warn(
        `File version ${versionId} is historical; ` +
          `FAILED transition is not required`,
      );

      return;
    }

    throw new Error(`File ${fileId} cannot transition to FAILED`);
  }

  private async processImageMetadata(input: {
    versionId: string;
    objectKey: string;
    mimeType: string | null;
    imageWidth: number | null;
    imageHeight: number | null;
    imageFormat: string | null;
  }): Promise<void> {
    const normalizedMimeType = input.mimeType?.toLowerCase() ?? null;

    if (
      !normalizedMimeType ||
      !SUPPORTED_IMAGE_MIME_TYPES.has(normalizedMimeType)
    ) {
      this.logger.log(
        `Skipping image metadata for version ${input.versionId}: ` +
          `unsupported MIME type ${normalizedMimeType ?? 'null'}`,
      );

      return;
    }

    if (
      input.imageWidth !== null &&
      input.imageHeight !== null &&
      input.imageFormat !== null
    ) {
      this.logger.log(
        `Image metadata for version ${input.versionId} is already stored: ` +
          `${input.imageWidth}x${input.imageHeight}, ${input.imageFormat}`,
      );

      return;
    }

    this.logger.log(
      `Reading image metadata for version ${input.versionId}: ` +
        `objectKey=${input.objectKey}`,
    );

    const stream = await this.objectStorage.getObjectStream(input.objectKey);

    const image = sharp();

    stream.pipe(image);

    try {
      const metadata = await image.metadata();

      const width = metadata.autoOrient?.width ?? metadata.width;

      const height = metadata.autoOrient?.height ?? metadata.height;

      const format = metadata.format;

      if (width === undefined || height === undefined || format === undefined) {
        throw new PermanentFileProcessingError(
          `Image metadata is incomplete for version ${input.versionId}`,
        );
      }
      const updateResult = await this.prisma.fileVersion.updateMany({
        where: {
          id: input.versionId,
          imageWidth: null,
          imageHeight: null,
          imageFormat: null,
        },
        data: {
          imageWidth: width,
          imageHeight: height,
          imageFormat: format,
        },
      });

      if (updateResult.count === 0) {
        const currentVersion = await this.prisma.fileVersion.findUnique({
          where: {
            id: input.versionId,
          },
          select: {
            imageWidth: true,
            imageHeight: true,
            imageFormat: true,
          },
        });

        if (
          currentVersion?.imageWidth !== width ||
          currentVersion.imageHeight !== height ||
          currentVersion.imageFormat !== format
        ) {
          throw new PermanentFileProcessingError(
            `Image metadata conflict for version ${input.versionId}`,
          );
        }

        this.logger.log(
          `Image metadata for version ${input.versionId} ` +
            `was already stored by another worker`,
        );

        return;
      }

      this.logger.log(
        `Stored image metadata for version ${input.versionId}: ` +
          `${width}x${height}, ${format}`,
      );
    } finally {
      stream.unpipe(image);
      stream.destroy();
      image.destroy();
    }
  }

  private async processImagePreview(input: {
    versionId: string;
    objectKey: string;
    mimeType: string | null;
    previewObjectKey: string | null;
    previewMimeType: string | null;
    previewWidth: number | null;
    previewHeight: number | null;
  }): Promise<void> {
    const normalizedMimeType = input.mimeType?.toLowerCase() ?? null;

    if (
      !normalizedMimeType ||
      !SUPPORTED_IMAGE_MIME_TYPES.has(normalizedMimeType)
    ) {
      this.logger.log(
        `Skipping image preview for version ${input.versionId}: ` +
          `unsupported MIME type ${normalizedMimeType ?? 'null'}`,
      );

      return;
    }

    if (
      input.previewObjectKey !== null &&
      input.previewMimeType !== null &&
      input.previewWidth !== null &&
      input.previewHeight !== null
    ) {
      this.logger.log(
        `Image preview for version ${input.versionId} is already stored: ` +
          `${input.previewWidth}x${input.previewHeight}`,
      );

      return;
    }

    const previewObjectKey = `${input.objectKey}.preview.${input.versionId}.webp`;

    this.logger.log(
      `Generating image preview for version ${input.versionId}: ` +
        `objectKey=${previewObjectKey}`,
    );

    const stream = await this.objectStorage.getObjectStream(input.objectKey);

    const transformer = sharp()
      .autoOrient()
      .resize({
        width: 512,
        height: 512,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({
        quality: 80,
      });

    stream.pipe(transformer);

    try {
      const { data, info } = await transformer.toBuffer({
        resolveWithObject: true,
      });

      await this.objectStorage.putObject({
        objectKey: previewObjectKey,
        body: data,
        contentType: 'image/webp',
      });

      await this.prisma.fileVersion.update({
        where: {
          id: input.versionId,
        },
        data: {
          previewObjectKey,
          previewMimeType: 'image/webp',
          previewWidth: info.width,
          previewHeight: info.height,
        },
      });

      this.logger.log(
        `Stored image preview for version ${input.versionId}: ` +
          `${info.width}x${info.height}, webp, ` +
          `objectKey=${previewObjectKey}`,
      );
    } finally {
      stream.unpipe(transformer);
      stream.destroy();
      transformer.destroy();
    }
  }

  private async markFileReady(
    fileId: string,
    versionId: string,
  ): Promise<void> {
    const result = await this.prisma.file.updateMany({
      where: {
        id: fileId,
        currentVersionId: versionId,
        status: 'PROCESSING',
      },
      data: {
        status: 'READY',
      },
    });

    if (result.count > 0) {
      this.logger.log(`File ${fileId} transitioned PROCESSING -> READY`);

      return;
    }

    const file = await this.prisma.file.findUnique({
      where: {
        id: fileId,
      },
      select: {
        currentVersionId: true,
        status: true,
      },
    });

    if (file?.currentVersionId === versionId && file.status === 'READY') {
      this.logger.log(`File ${fileId} is already READY`);

      return;
    }

    if (file && file.currentVersionId !== versionId) {
      this.logger.log(
        `File version ${versionId} is historical; ` +
          `READY transition is not required`,
      );

      return;
    }

    throw new PermanentFileProcessingError(
      `File ${fileId} cannot transition to READY`,
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
