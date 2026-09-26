import { StoredObjectCleanupService } from './stored-object-cleanup.service';
import type { PrismaService } from '../database/prisma.service';
import type {
  ListObjectsResult,
  ObjectStorage,
} from '../storage/object-storage.interface';

type StoredObjectFindManyArgs = {
  where?: {
    createdAt?: {
      lte: Date;
    };
    versions?: {
      none: Record<string, never>;
    };
  };
  orderBy?: {
    createdAt: 'asc';
  };
  take?: number;
  select?: {
    id: true;
    objectKey: true;
    createdAt: true;
  };
};

type StoredObjectCandidate = {
  id: string;
  objectKey: string;
  createdAt: Date;
};

type StoredObjectDeleteManyArgs = {
  where: {
    id: string;
    versions: {
      none: Record<string, never>;
    };
  };
};

type FindStoredObjectArgs = {
  where: {
    objectKey: string;
  };
  select: {
    id: true;
  };
};

type FindUploadSessionArgs = {
  where: {
    objectKey: string;
    status: {
      in: string[];
    };
  };
  select: {
    id: true;
  };
};

type FindPreviewVersionArgs = {
  where: {
    previewObjectKey: string;
  };
  select: {
    id: true;
  };
};

describe('StoredObjectCleanupService', () => {
  const storedObjectFindManyMock =
    jest.fn<
      (args: StoredObjectFindManyArgs) => Promise<StoredObjectCandidate[]>
    >();

  const storedObjectDeleteManyMock =
    jest.fn<(args: StoredObjectDeleteManyArgs) => Promise<{ count: number }>>();

  const storedObjectFindUniqueMock =
    jest.fn<(args: FindStoredObjectArgs) => Promise<{ id: string } | null>>();

  const uploadSessionFindFirstMock =
    jest.fn<(args: FindUploadSessionArgs) => Promise<{ id: string } | null>>();

  const fileVersionFindFirstMock =
    jest.fn<(args: FindPreviewVersionArgs) => Promise<{ id: string } | null>>();

  const deleteObjectMock = jest.fn<ObjectStorage['deleteObject']>();

  const listObjectsMock = jest.fn<ObjectStorage['listObjects']>();

  const prismaMock = {
    storedObject: {
      findMany: storedObjectFindManyMock,
      deleteMany: storedObjectDeleteManyMock,
      findUnique: storedObjectFindUniqueMock,
    },
    uploadSession: {
      findFirst: uploadSessionFindFirstMock,
    },
    fileVersion: {
      findFirst: fileVersionFindFirstMock,
    },
  } as unknown as PrismaService;

  const objectStorageMock = {
    deleteObject: deleteObjectMock,
    listObjects: listObjectsMock,
  } as unknown as ObjectStorage;

  let service: StoredObjectCleanupService;

  beforeEach(() => {
    jest.clearAllMocks();

    service = new StoredObjectCleanupService(prismaMock, objectStorageMock);

    storedObjectFindUniqueMock.mockResolvedValue(null);
    uploadSessionFindFirstMock.mockResolvedValue(null);
    fileVersionFindFirstMock.mockResolvedValue(null);

    deleteObjectMock.mockResolvedValue(undefined);

    listObjectsMock.mockResolvedValue({
      objects: [],
      nextContinuationToken: null,
    });
  });

  it('cleans a database orphan StoredObject', async () => {
    const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000);

    storedObjectFindManyMock.mockResolvedValue([
      {
        id: 'stored-object-1',
        objectKey: 'users/user-1/objects/object-1',
        createdAt,
      },
    ]);

    storedObjectDeleteManyMock.mockResolvedValue({
      count: 1,
    });

    const result = await service.cleanupDatabaseOrphans();

    expect(storedObjectDeleteManyMock).toHaveBeenCalledWith({
      where: {
        id: 'stored-object-1',
        versions: {
          none: {},
        },
      },
    });

    expect(deleteObjectMock).toHaveBeenCalledWith(
      'users/user-1/objects/object-1',
    );

    expect(result).toEqual({
      scanned: 1,
      cleaned: 1,
      skipped: 0,
      failed: 0,
    });
  });

  it('skips a database orphan when another operation references it before deletion', async () => {
    storedObjectFindManyMock.mockResolvedValue([
      {
        id: 'stored-object-2',
        objectKey: 'users/user-1/objects/object-2',
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    ]);

    storedObjectDeleteManyMock.mockResolvedValue({
      count: 0,
    });

    const result = await service.cleanupDatabaseOrphans();

    expect(deleteObjectMock).not.toHaveBeenCalled();

    expect(result).toEqual({
      scanned: 1,
      cleaned: 0,
      skipped: 1,
      failed: 0,
    });
  });

  it('leaves a physical orphan for later retry when storage deletion fails', async () => {
    storedObjectFindManyMock.mockResolvedValue([
      {
        id: 'stored-object-3',
        objectKey: 'users/user-1/objects/object-3',
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    ]);

    storedObjectDeleteManyMock.mockResolvedValue({
      count: 1,
    });

    deleteObjectMock.mockRejectedValueOnce(new Error('MinIO unavailable'));

    const result = await service.cleanupDatabaseOrphans();

    expect(result).toEqual({
      scanned: 1,
      cleaned: 0,
      skipped: 0,
      failed: 1,
    });
  });

  it('cleans an old physical orphan', async () => {
    const listResult: ListObjectsResult = {
      objects: [
        {
          objectKey: 'users/user-1/objects/orphan-object',
          size: 123,
          lastModified: new Date(Date.now() - 2 * 60 * 60 * 1000),
        },
      ],
      nextContinuationToken: null,
    };

    listObjectsMock.mockResolvedValue(listResult);

    const result = await service.cleanupPhysicalOrphans();

    expect(deleteObjectMock).toHaveBeenCalledWith(
      'users/user-1/objects/orphan-object',
    );

    expect(result).toEqual({
      scanned: 1,
      cleaned: 1,
      skipped: 0,
      failed: 0,
    });
  });

  it('does not delete a recent physical object because of the grace period', async () => {
    listObjectsMock.mockResolvedValue({
      objects: [
        {
          objectKey: 'users/user-1/objects/recent-object',
          size: 123,
          lastModified: new Date(),
        },
      ],
      nextContinuationToken: null,
    });

    const result = await service.cleanupPhysicalOrphans();

    expect(storedObjectFindUniqueMock).not.toHaveBeenCalled();

    expect(deleteObjectMock).not.toHaveBeenCalled();

    expect(result).toEqual({
      scanned: 1,
      cleaned: 0,
      skipped: 1,
      failed: 0,
    });
  });

  it('does not delete a physical object referenced by StoredObject', async () => {
    listObjectsMock.mockResolvedValue({
      objects: [
        {
          objectKey: 'users/user-1/objects/object-4',
          size: 123,
          lastModified: new Date(Date.now() - 2 * 60 * 60 * 1000),
        },
      ],
      nextContinuationToken: null,
    });

    storedObjectFindUniqueMock.mockResolvedValueOnce({
      id: 'stored-object-4',
    });

    const result = await service.cleanupPhysicalOrphans();

    expect(deleteObjectMock).not.toHaveBeenCalled();

    expect(result.skipped).toBe(1);
    expect(result.cleaned).toBe(0);
  });

  it('does not delete a physical object protected by an active UploadSession', async () => {
    listObjectsMock.mockResolvedValue({
      objects: [
        {
          objectKey: 'users/user-1/objects/uploading-object',
          size: 123,
          lastModified: new Date(Date.now() - 2 * 60 * 60 * 1000),
        },
      ],
      nextContinuationToken: null,
    });

    uploadSessionFindFirstMock.mockImplementationOnce(
      (args: FindUploadSessionArgs) => {
        expect(args.where.objectKey).toBe(
          'users/user-1/objects/uploading-object',
        );

        expect(args.where.status.in).toEqual([
          'CREATED',
          'UPLOADING',
          'COMPLETING',
          'ABORTING',
        ]);

        return Promise.resolve({
          id: 'upload-session-1',
        });
      },
    );

    const result = await service.cleanupPhysicalOrphans();

    expect(deleteObjectMock).not.toHaveBeenCalled();

    expect(result.skipped).toBe(1);
    expect(result.cleaned).toBe(0);
  });

  it('does not delete a physical preview referenced by FileVersion', async () => {
    const previewObjectKey =
      'users/user-1/objects/object-5.preview.version-1.webp';

    listObjectsMock.mockResolvedValue({
      objects: [
        {
          objectKey: previewObjectKey,
          size: 123,
          lastModified: new Date(Date.now() - 2 * 60 * 60 * 1000),
        },
      ],
      nextContinuationToken: null,
    });

    fileVersionFindFirstMock.mockImplementationOnce(
      (args: FindPreviewVersionArgs) => {
        expect(args.where.previewObjectKey).toBe(previewObjectKey);

        return Promise.resolve({
          id: 'version-1',
        });
      },
    );

    const result = await service.cleanupPhysicalOrphans();

    expect(deleteObjectMock).not.toHaveBeenCalled();

    expect(result).toEqual({
      scanned: 1,
      cleaned: 0,
      skipped: 1,
      failed: 0,
    });
  });

  it('follows object storage pagination', async () => {
    listObjectsMock
      .mockResolvedValueOnce({
        objects: [
          {
            objectKey: 'users/user-1/objects/orphan-1',
            size: 100,
            lastModified: new Date(Date.now() - 2 * 60 * 60 * 1000),
          },
        ],
        nextContinuationToken: 'page-2',
      })
      .mockResolvedValueOnce({
        objects: [
          {
            objectKey: 'users/user-1/objects/orphan-2',
            size: 100,
            lastModified: new Date(Date.now() - 2 * 60 * 60 * 1000),
          },
        ],
        nextContinuationToken: null,
      });

    const result = await service.cleanupPhysicalOrphans();

    expect(listObjectsMock).toHaveBeenNthCalledWith(1, {
      continuationToken: undefined,
      maxKeys: 100,
    });

    expect(listObjectsMock).toHaveBeenNthCalledWith(2, {
      continuationToken: 'page-2',
      maxKeys: 99,
    });

    expect(deleteObjectMock).toHaveBeenCalledTimes(2);

    expect(result).toEqual({
      scanned: 2,
      cleaned: 2,
      skipped: 0,
      failed: 0,
    });
  });

  it('rejects invalid cleanup batch sizes', async () => {
    await expect(service.cleanupDatabaseOrphans(0)).rejects.toThrow(
      'Stored object cleanup batch size must be a positive integer',
    );

    await expect(service.cleanupPhysicalOrphans(0)).rejects.toThrow(
      'Physical object cleanup batch size must be a positive integer',
    );
  });
});
