import { PreviewCleanupService } from './preview-cleanup.service';
import type { PrismaService } from '../database/prisma.service';
import type { ObjectStorage } from '../storage/object-storage.interface';

type FindManyArgs = {
  where?: {
    previewObjectKey?: {
      not: null;
    };
  };
  orderBy?: {
    createdAt: 'asc';
  };
  take?: number;
  select?: {
    id: true;
    previewObjectKey: true;
  };
};

type PreviewCandidate = {
  id: string;
  previewObjectKey: string | null;
};

type UpdateManyArgs = {
  where: {
    id: string;
    previewObjectKey: string;
  };
  data: {
    previewObjectKey: null;
    previewMimeType: null;
    previewWidth: null;
    previewHeight: null;
  };
};

describe('PreviewCleanupService', () => {
  const findManyMock =
    jest.fn<(args: FindManyArgs) => Promise<PreviewCandidate[]>>();

  const updateManyMock =
    jest.fn<(args: UpdateManyArgs) => Promise<{ count: number }>>();

  const objectExistsMock = jest.fn<ObjectStorage['objectExists']>();

  const prismaMock = {
    fileVersion: {
      findMany: findManyMock,
      updateMany: updateManyMock,
    },
  } as unknown as PrismaService;

  const objectStorageMock = {
    objectExists: objectExistsMock,
  } as unknown as ObjectStorage;

  let service: PreviewCleanupService;

  beforeEach(() => {
    jest.clearAllMocks();

    service = new PreviewCleanupService(prismaMock, objectStorageMock);
  });

  it('keeps preview metadata when physical preview exists', async () => {
    findManyMock.mockResolvedValue([
      {
        id: 'version-1',
        previewObjectKey: 'users/user-1/objects/object.preview.version-1.webp',
      },
    ]);

    objectExistsMock.mockResolvedValue(true);

    const result = await service.cleanupBatch();

    expect(updateManyMock).not.toHaveBeenCalled();

    expect(result).toEqual({
      scanned: 1,
      cleaned: 0,
      skipped: 1,
      failed: 0,
    });
  });

  it('clears preview metadata when physical preview is missing', async () => {
    const previewObjectKey =
      'users/user-1/objects/object.preview.version-2.webp';

    findManyMock.mockResolvedValue([
      {
        id: 'version-2',
        previewObjectKey,
      },
    ]);

    objectExistsMock.mockResolvedValue(false);

    updateManyMock.mockResolvedValue({
      count: 1,
    });

    const result = await service.cleanupBatch();

    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        id: 'version-2',
        previewObjectKey,
      },
      data: {
        previewObjectKey: null,
        previewMimeType: null,
        previewWidth: null,
        previewHeight: null,
      },
    });

    expect(result).toEqual({
      scanned: 1,
      cleaned: 1,
      skipped: 0,
      failed: 0,
    });
  });

  it('skips cleanup when preview metadata changed concurrently', async () => {
    findManyMock.mockResolvedValue([
      {
        id: 'version-3',
        previewObjectKey: 'users/user-1/objects/old-preview.webp',
      },
    ]);

    objectExistsMock.mockResolvedValue(false);

    updateManyMock.mockResolvedValue({
      count: 0,
    });

    const result = await service.cleanupBatch();

    expect(result).toEqual({
      scanned: 1,
      cleaned: 0,
      skipped: 1,
      failed: 0,
    });
  });

  it('continues when object storage verification fails', async () => {
    findManyMock.mockResolvedValue([
      {
        id: 'version-4',
        previewObjectKey: 'users/user-1/objects/preview-4.webp',
      },
      {
        id: 'version-5',
        previewObjectKey: 'users/user-1/objects/preview-5.webp',
      },
    ]);

    objectExistsMock
      .mockRejectedValueOnce(new Error('MinIO unavailable'))
      .mockResolvedValueOnce(false);

    updateManyMock.mockResolvedValueOnce({
      count: 1,
    });

    const result = await service.cleanupBatch();

    expect(result).toEqual({
      scanned: 2,
      cleaned: 1,
      skipped: 0,
      failed: 1,
    });
  });

  it('uses the requested batch size', async () => {
    findManyMock.mockResolvedValue([]);

    await service.cleanupBatch(25);

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 25,
      }),
    );
  });

  it('uses 100 as the default batch size', async () => {
    findManyMock.mockResolvedValue([]);

    await service.cleanupBatch();

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
      }),
    );
  });

  it('rejects invalid batch size', async () => {
    await expect(service.cleanupBatch(0)).rejects.toThrow(
      'Preview cleanup batch size must be a positive integer',
    );

    expect(findManyMock).not.toHaveBeenCalled();
  });
});
