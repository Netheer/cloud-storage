import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../database/prisma.service';
import type { ObjectStorage } from '../storage/object-storage.interface';
import { FileProcessingWorker } from './file-processing.worker';
import { UnrecoverableError, type Job } from 'bullmq';
import type { ProcessFileJob } from './file-processing.constants';

type RelinkInput = {
  versionId: string;
  duplicateStoredObjectId: string;
  duplicateObjectKey: string;
  canonicalStoredObject: {
    id: string;
    objectKey: string;
    size: bigint;
    sha256: string | null;
  };
};

type RelinkResult = RelinkInput['canonicalStoredObject'];

type FileProcessingWorkerTestAccessor = {
  relinkVersionToStoredObject(input: RelinkInput): Promise<RelinkResult>;

  handleFailedJob(job: Job<ProcessFileJob>, error: Error): Promise<void>;
};

describe('FileProcessingWorker', () => {
  const fileVersionUpdateManyMock = jest.fn();
  const fileVersionFindUniqueMock = jest.fn();

  const storedObjectUpdateMock = jest.fn();
  const storedObjectFindUniqueMock = jest.fn();
  const storedObjectDeleteManyMock = jest.fn();
  const processingFailureCreateMock = jest.fn();

  const fileUpdateManyMock = jest.fn();
  const fileFindUniqueMock = jest.fn();

  const deleteObjectMock = jest.fn<ObjectStorage['deleteObject']>();

  const transactionMock = {
    fileVersion: {
      updateMany: fileVersionUpdateManyMock,
      findUnique: fileVersionFindUniqueMock,
    },
    storedObject: {
      update: storedObjectUpdateMock,
      findUnique: storedObjectFindUniqueMock,
      deleteMany: storedObjectDeleteManyMock,
    },
  };

  const transactionRunnerMock = jest.fn(
    async (
      callback: (transaction: typeof transactionMock) => Promise<unknown>,
    ) => callback(transactionMock),
  );

  const prismaMock = {
    $transaction: transactionRunnerMock,

    processingFailure: {
      create: processingFailureCreateMock,
    },

    file: {
      updateMany: fileUpdateManyMock,
      findUnique: fileFindUniqueMock,
    },
  } as unknown as PrismaService;

  const objectStorageMock = {
    deleteObject: deleteObjectMock,
  } as unknown as ObjectStorage;

  const configServiceMock = {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'REDIS_HOST') {
        return '127.0.0.1';
      }

      if (key === 'REDIS_PORT') {
        return '6379';
      }

      throw new Error(`Unexpected config key: ${key}`);
    }),
  } as unknown as ConfigService;

  let worker: FileProcessingWorker;
  let workerAccessor: FileProcessingWorkerTestAccessor;

  beforeEach(() => {
    fileUpdateManyMock.mockResolvedValue({
      count: 1,
    });

    fileFindUniqueMock.mockResolvedValue(null);

    processingFailureCreateMock.mockResolvedValue({
      id: 'failure-id',
    });
    jest.clearAllMocks();

    worker = new FileProcessingWorker(
      configServiceMock,
      prismaMock,
      objectStorageMock,
    );

    workerAccessor = worker as unknown as FileProcessingWorkerTestAccessor;
  });

  function createJob(input: {
    id?: string;
    attemptsMade: number;
    attempts?: number;
  }): Job<ProcessFileJob> {
    return {
      id: input.id ?? 'job-id',
      data: {
        fileId: 'file-id',
        versionId: 'version-id',
        storedObjectId: 'stored-object-id',
      },
      attemptsMade: input.attemptsMade,
      opts: {
        attempts: input.attempts ?? 4,
      },
    } as Job<ProcessFileJob>;
  }

  it('keeps deduplicated DB state when duplicate physical object deletion fails', async () => {
    const canonicalStoredObject = {
      id: 'canonical-object-id',
      objectKey: 'users/user-1/objects/canonical-object',
      size: 1024n,
      sha256: 'test-sha256',
    };

    fileVersionUpdateManyMock.mockResolvedValue({
      count: 1,
    });

    storedObjectUpdateMock.mockResolvedValue({
      id: canonicalStoredObject.id,
    });

    storedObjectFindUniqueMock.mockResolvedValue({
      referenceCount: 1,
      _count: {
        versions: 0,
      },
    });

    storedObjectDeleteManyMock.mockResolvedValue({
      count: 1,
    });

    deleteObjectMock.mockRejectedValue(
      new Error('Temporary MinIO delete failure'),
    );

    const result = await workerAccessor.relinkVersionToStoredObject({
      versionId: 'version-id',
      duplicateStoredObjectId: 'duplicate-object-id',
      duplicateObjectKey: 'users/user-1/objects/duplicate-object',
      canonicalStoredObject,
    });

    expect(result).toEqual(canonicalStoredObject);

    expect(fileVersionUpdateManyMock).toHaveBeenCalledWith({
      where: {
        id: 'version-id',
        storedObjectId: 'duplicate-object-id',
      },
      data: {
        storedObjectId: 'canonical-object-id',
      },
    });

    expect(storedObjectUpdateMock).toHaveBeenCalledWith({
      where: {
        id: 'canonical-object-id',
      },
      data: {
        referenceCount: {
          increment: 1,
        },
      },
    });

    expect(storedObjectDeleteManyMock).toHaveBeenCalledWith({
      where: {
        id: 'duplicate-object-id',
        versions: {
          none: {},
        },
      },
    });

    expect(deleteObjectMock).toHaveBeenCalledWith(
      'users/user-1/objects/duplicate-object',
    );
  });

  it('does not record a processing failure before retries are exhausted', async () => {
    const job = createJob({
      attemptsMade: 1,
      attempts: 4,
    });

    await workerAccessor.handleFailedJob(
      job,
      new Error('Temporary MinIO error'),
    );

    expect(processingFailureCreateMock).not.toHaveBeenCalled();
    expect(fileUpdateManyMock).not.toHaveBeenCalled();
  });

  it('records recoverable failure after all retries are exhausted', async () => {
    const job = createJob({
      id: 'job-retry-exhausted',
      attemptsMade: 4,
      attempts: 4,
    });

    await workerAccessor.handleFailedJob(
      job,
      new Error('MinIO is unavailable'),
    );

    expect(processingFailureCreateMock).toHaveBeenCalledWith({
      data: {
        fileId: 'file-id',
        versionId: 'version-id',
        jobId: 'job-retry-exhausted',
        kind: 'RECOVERABLE_EXHAUSTED',
        reason: 'MinIO is unavailable',
        attempts: 4,
      },
    });

    expect(fileUpdateManyMock).toHaveBeenCalledWith({
      where: {
        id: 'file-id',
        currentVersionId: 'version-id',
        status: 'PROCESSING',
      },
      data: {
        status: 'FAILED',
      },
    });
  });

  it('records an unrecoverable processing failure immediately', async () => {
    const job = createJob({
      id: 'job-unrecoverable',
      attemptsMade: 1,
      attempts: 4,
    });

    await workerAccessor.handleFailedJob(
      job,
      new UnrecoverableError('Stored object was not found'),
    );

    expect(processingFailureCreateMock).toHaveBeenCalledWith({
      data: {
        fileId: 'file-id',
        versionId: 'version-id',
        jobId: 'job-unrecoverable',
        kind: 'UNRECOVERABLE',
        reason: 'Stored object was not found',
        attempts: 1,
      },
    });

    expect(fileUpdateManyMock).toHaveBeenCalledWith({
      where: {
        id: 'file-id',
        currentVersionId: 'version-id',
        status: 'PROCESSING',
      },
      data: {
        status: 'FAILED',
      },
    });
  });
});
