import { MultipartCleanupService } from './multipart-cleanup.service';
import type { PrismaService } from '../database/prisma.service';
import type { ObjectStorage } from '../storage/object-storage.interface';

type CleanupCandidate = {
  id: string;
  status: string;
  objectKey: string;
  multipartUploadId: string | null;
  expiresAt: Date;
  updatedAt: Date;
};

type FindManyArgs = {
  where?: {
    OR?: Array<{
      status?: string;
      expiresAt?: {
        lte: Date;
      };
      updatedAt?: {
        lte: Date;
      };
    }>;
  };
  orderBy?: unknown;
  take?: number;
};

type UpdateManyArgs = {
  where: {
    id: string;
    status: string;
    updatedAt?: Date;
  };
  data: {
    status?: string;
    updatedAt?: Date;
  };
};

type FindUniqueArgs = {
  where: {
    id: string;
  };
  select: {
    status: true;
  };
};

type FindUniqueResult = {
  status: string;
} | null;

describe('MultipartCleanupService', () => {
  const findManyMock =
    jest.fn<(args: FindManyArgs) => Promise<CleanupCandidate[]>>();

  const updateManyMock =
    jest.fn<(args: UpdateManyArgs) => Promise<{ count: number }>>();

  const findUniqueMock =
    jest.fn<(args: FindUniqueArgs) => Promise<FindUniqueResult>>();

  const abortMultipartUploadMock =
    jest.fn<ObjectStorage['abortMultipartUpload']>();

  const prismaMock = {
    uploadSession: {
      findMany: findManyMock,
      updateMany: updateManyMock,
      findUnique: findUniqueMock,
    },
  } as unknown as PrismaService;

  const objectStorageMock = {
    abortMultipartUpload: abortMultipartUploadMock,
  } as unknown as ObjectStorage;

  let service: MultipartCleanupService;

  beforeEach(() => {
    jest.clearAllMocks();

    service = new MultipartCleanupService(prismaMock, objectStorageMock);

    abortMultipartUploadMock.mockResolvedValue(undefined);
    findUniqueMock.mockResolvedValue(null);
  });

  it('cleans an expired UPLOADING multipart session', async () => {
    const now = new Date();

    findManyMock.mockResolvedValue([
      {
        id: 'session-1',
        status: 'UPLOADING',
        objectKey: 'users/user-1/objects/object-1',
        multipartUploadId: 'upload-1',
        expiresAt: new Date(now.getTime() - 60_000),
        updatedAt: new Date(now.getTime() - 60_000),
      },
    ]);

    updateManyMock
      .mockResolvedValueOnce({
        count: 1,
      })
      .mockResolvedValueOnce({
        count: 1,
      });

    const result = await service.cleanupBatch();

    expect(abortMultipartUploadMock).toHaveBeenCalledTimes(1);
    expect(abortMultipartUploadMock).toHaveBeenCalledWith({
      objectKey: 'users/user-1/objects/object-1',
      uploadId: 'upload-1',
    });

    expect(updateManyMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          id: 'session-1',
          status: 'UPLOADING',
        },
        data: {
          status: 'ABORTING',
        },
      }),
    );

    expect(updateManyMock).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'session-1',
        status: 'ABORTING',
      },
      data: {
        status: 'ABORTED',
      },
    });

    expect(result).toEqual({
      scanned: 1,
      cleaned: 1,
      skipped: 0,
      failed: 0,
    });
  });

  it('cleans an expired CREATED session without calling object storage', async () => {
    const now = new Date();

    findManyMock.mockResolvedValue([
      {
        id: 'session-2',
        status: 'CREATED',
        objectKey: 'users/user-1/objects/object-2',
        multipartUploadId: null,
        expiresAt: new Date(now.getTime() - 60_000),
        updatedAt: new Date(now.getTime() - 60_000),
      },
    ]);

    updateManyMock
      .mockResolvedValueOnce({
        count: 1,
      })
      .mockResolvedValueOnce({
        count: 1,
      });

    const result = await service.cleanupBatch();

    expect(abortMultipartUploadMock).not.toHaveBeenCalled();

    expect(result).toEqual({
      scanned: 1,
      cleaned: 1,
      skipped: 0,
      failed: 0,
    });
  });

  it('recovers a stale ABORTING session', async () => {
    const updatedAt = new Date(Date.now() - 60_000);

    findManyMock.mockResolvedValue([
      {
        id: 'session-3',
        status: 'ABORTING',
        objectKey: 'users/user-1/objects/object-3',
        multipartUploadId: 'upload-3',
        expiresAt: new Date(Date.now() - 120_000),
        updatedAt,
      },
    ]);

    updateManyMock
      .mockImplementationOnce((args: UpdateManyArgs) => {
        expect(args.where).toEqual({
          id: 'session-3',
          status: 'ABORTING',
          updatedAt,
        });

        expect(args.data.updatedAt).toBeInstanceOf(Date);

        return Promise.resolve({
          count: 1,
        });
      })
      .mockResolvedValueOnce({
        count: 1,
      });

    const result = await service.cleanupBatch();

    expect(abortMultipartUploadMock).toHaveBeenCalledWith({
      objectKey: 'users/user-1/objects/object-3',
      uploadId: 'upload-3',
    });

    expect(result.cleaned).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('leaves the session ABORTING when object storage temporarily fails', async () => {
    const now = new Date();

    findManyMock.mockResolvedValue([
      {
        id: 'session-4',
        status: 'EXPIRED',
        objectKey: 'users/user-1/objects/object-4',
        multipartUploadId: 'upload-4',
        expiresAt: new Date(now.getTime() - 60_000),
        updatedAt: new Date(now.getTime() - 60_000),
      },
    ]);

    updateManyMock.mockResolvedValueOnce({
      count: 1,
    });

    abortMultipartUploadMock.mockRejectedValueOnce(
      new Error('MinIO unavailable'),
    );

    const result = await service.cleanupBatch();

    expect(updateManyMock).toHaveBeenCalledTimes(1);

    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        id: 'session-4',
        status: 'EXPIRED',
      },
      data: {
        status: 'ABORTING',
      },
    });

    expect(result).toEqual({
      scanned: 1,
      cleaned: 0,
      skipped: 0,
      failed: 1,
    });
  });

  it('skips a session when another worker claims it first', async () => {
    const now = new Date();

    findManyMock.mockResolvedValue([
      {
        id: 'session-5',
        status: 'FAILED',
        objectKey: 'users/user-1/objects/object-5',
        multipartUploadId: 'upload-5',
        expiresAt: new Date(now.getTime() - 60_000),
        updatedAt: new Date(now.getTime() - 60_000),
      },
    ]);

    updateManyMock.mockResolvedValueOnce({
      count: 0,
    });

    const result = await service.cleanupBatch();

    expect(abortMultipartUploadMock).not.toHaveBeenCalled();

    expect(result).toEqual({
      scanned: 1,
      cleaned: 0,
      skipped: 1,
      failed: 0,
    });
  });

  it('treats an already ABORTED session as an idempotent success after finalization race', async () => {
    const now = new Date();

    findManyMock.mockResolvedValue([
      {
        id: 'session-6',
        status: 'EXPIRED',
        objectKey: 'users/user-1/objects/object-6',
        multipartUploadId: 'upload-6',
        expiresAt: new Date(now.getTime() - 60_000),
        updatedAt: new Date(now.getTime() - 60_000),
      },
    ]);

    updateManyMock
      .mockResolvedValueOnce({
        count: 1,
      })
      .mockResolvedValueOnce({
        count: 0,
      });

    findUniqueMock.mockResolvedValueOnce({
      status: 'ABORTED',
    });

    const result = await service.cleanupBatch();

    expect(result).toEqual({
      scanned: 1,
      cleaned: 1,
      skipped: 0,
      failed: 0,
    });
  });

  it('continues processing the batch after one session fails', async () => {
    const now = new Date();

    findManyMock.mockResolvedValue([
      {
        id: 'session-7',
        status: 'EXPIRED',
        objectKey: 'users/user-1/objects/object-7',
        multipartUploadId: 'upload-7',
        expiresAt: new Date(now.getTime() - 120_000),
        updatedAt: new Date(now.getTime() - 120_000),
      },
      {
        id: 'session-8',
        status: 'EXPIRED',
        objectKey: 'users/user-1/objects/object-8',
        multipartUploadId: 'upload-8',
        expiresAt: new Date(now.getTime() - 60_000),
        updatedAt: new Date(now.getTime() - 60_000),
      },
    ]);

    updateManyMock
      // claim session-7
      .mockResolvedValueOnce({
        count: 1,
      })
      // claim session-8
      .mockResolvedValueOnce({
        count: 1,
      })
      // finalize session-8
      .mockResolvedValueOnce({
        count: 1,
      });

    abortMultipartUploadMock
      .mockRejectedValueOnce(new Error('Temporary storage failure'))
      .mockResolvedValueOnce(undefined);

    const result = await service.cleanupBatch();

    expect(abortMultipartUploadMock).toHaveBeenCalledTimes(2);

    expect(result).toEqual({
      scanned: 2,
      cleaned: 1,
      skipped: 0,
      failed: 1,
    });
  });

  it('uses the requested batch size', async () => {
    findManyMock.mockResolvedValue([]);

    const result = await service.cleanupBatch(25);

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 25,
      }),
    );

    expect(result).toEqual({
      scanned: 0,
      cleaned: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it('uses 100 sessions as the default batch size', async () => {
    findManyMock.mockResolvedValue([]);

    await service.cleanupBatch();

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
      }),
    );
  });

  it('rejects an invalid batch size', async () => {
    await expect(service.cleanupBatch(0)).rejects.toThrow(
      'Multipart cleanup batch size must be a positive integer',
    );

    expect(findManyMock).not.toHaveBeenCalled();
  });

  it('does not select COMPLETING, COMPLETED or ABORTED sessions', async () => {
    findManyMock.mockImplementationOnce((args: FindManyArgs) => {
      const statuses =
        args.where?.OR?.map((condition) => condition.status).filter(
          (status): status is string => status !== undefined,
        ) ?? [];

      expect(statuses).toContain('CREATED');
      expect(statuses).toContain('UPLOADING');
      expect(statuses).toContain('EXPIRED');
      expect(statuses).toContain('FAILED');
      expect(statuses).toContain('ABORTING');

      expect(statuses).not.toContain('COMPLETING');
      expect(statuses).not.toContain('COMPLETED');
      expect(statuses).not.toContain('ABORTED');

      return Promise.resolve([]);
    });

    await service.cleanupBatch();

    expect(findManyMock).toHaveBeenCalledTimes(1);
  });
});
