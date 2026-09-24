import {
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AccessService, type EffectiveAccessRole } from './access.service';

type AccessGrantRecord = {
  role: string;
};

type FileAccessRecord = {
  ownerId: string;
  folderId: string | null;
  accessGrants: AccessGrantRecord[];
};

type FolderAccessRecord = {
  ownerId: string;
  parentId: string | null;
  accessGrants: AccessGrantRecord[];
};

describe('AccessService', () => {
  const userId = 'user-1';
  const ownerId = 'owner-1';

  const fileFindFirstMock = jest.fn((): Promise<FileAccessRecord | null> =>
    Promise.resolve(null),
  );

  const folderFindUniqueMock = jest.fn((): Promise<FolderAccessRecord | null> =>
    Promise.resolve(null),
  );

  let service: AccessService;

  beforeEach(() => {
    fileFindFirstMock.mockReset();
    folderFindUniqueMock.mockReset();

    const prisma = {
      file: {
        findFirst: fileFindFirstMock,
      },
      folder: {
        findUnique: folderFindUniqueMock,
      },
    } as unknown as PrismaService;

    service = new AccessService(prisma);
  });

  describe('getFileRole', () => {
    it('returns OWNER for the file owner', async () => {
      fileFindFirstMock.mockResolvedValue({
        ownerId: userId,
        folderId: null,
        accessGrants: [],
      });

      await expect(service.getFileRole(userId, 'file-1')).resolves.toBe(
        'OWNER',
      );

      expect(folderFindUniqueMock).not.toHaveBeenCalled();
    });

    it('uses a direct file grant before inherited folder access', async () => {
      fileFindFirstMock.mockResolvedValue({
        ownerId,
        folderId: 'folder-1',
        accessGrants: [
          {
            role: 'VIEWER',
          },
        ],
      });

      await expect(service.getFileRole(userId, 'file-1')).resolves.toBe(
        'VIEWER',
      );

      expect(folderFindUniqueMock).not.toHaveBeenCalled();
    });

    it('inherits access from the containing folder', async () => {
      fileFindFirstMock.mockResolvedValue({
        ownerId,
        folderId: 'folder-1',
        accessGrants: [],
      });

      folderFindUniqueMock.mockResolvedValue({
        ownerId,
        parentId: null,
        accessGrants: [
          {
            role: 'EDITOR',
          },
        ],
      });

      await expect(service.getFileRole(userId, 'file-1')).resolves.toBe(
        'EDITOR',
      );
    });

    it('returns null when the file does not exist', async () => {
      fileFindFirstMock.mockResolvedValue(null);

      await expect(service.getFileRole(userId, 'file-1')).resolves.toBeNull();
    });
  });

  describe('getFolderRole', () => {
    it('returns OWNER for the folder owner', async () => {
      folderFindUniqueMock.mockResolvedValue({
        ownerId: userId,
        parentId: null,
        accessGrants: [],
      });

      await expect(service.getFolderRole(userId, 'folder-1')).resolves.toBe(
        'OWNER',
      );
    });

    it('uses the nearest inherited folder grant', async () => {
      folderFindUniqueMock
        .mockResolvedValueOnce({
          ownerId,
          parentId: 'folder-parent',
          accessGrants: [],
        })
        .mockResolvedValueOnce({
          ownerId,
          parentId: 'folder-root',
          accessGrants: [
            {
              role: 'VIEWER',
            },
          ],
        })
        .mockResolvedValueOnce({
          ownerId,
          parentId: null,
          accessGrants: [
            {
              role: 'EDITOR',
            },
          ],
        });

      await expect(service.getFolderRole(userId, 'folder-child')).resolves.toBe(
        'VIEWER',
      );

      /*
       * После ближайшего grant выше по дереву
       * идти уже не должны.
       */
      expect(folderFindUniqueMock).toHaveBeenCalledTimes(2);
    });

    it('returns null when no grant exists in the hierarchy', async () => {
      folderFindUniqueMock
        .mockResolvedValueOnce({
          ownerId,
          parentId: 'folder-root',
          accessGrants: [],
        })
        .mockResolvedValueOnce({
          ownerId,
          parentId: null,
          accessGrants: [],
        });

      await expect(
        service.getFolderRole(userId, 'folder-child'),
      ).resolves.toBeNull();
    });

    it('protects against a corrupted cyclic hierarchy', async () => {
      folderFindUniqueMock
        .mockResolvedValueOnce({
          ownerId,
          parentId: 'folder-2',
          accessGrants: [],
        })
        .mockResolvedValueOnce({
          ownerId,
          parentId: 'folder-1',
          accessGrants: [],
        });

      await expect(
        service.getFolderRole(userId, 'folder-1'),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('required roles', () => {
    it.each<[EffectiveAccessRole, EffectiveAccessRole]>([
      ['OWNER', 'OWNER'],
      ['OWNER', 'EDITOR'],
      ['OWNER', 'VIEWER'],
      ['EDITOR', 'EDITOR'],
      ['EDITOR', 'VIEWER'],
      ['VIEWER', 'VIEWER'],
    ])('allows %s when %s is required', async (actualRole, requiredRole) => {
      folderFindUniqueMock.mockResolvedValue({
        ownerId: actualRole === 'OWNER' ? userId : ownerId,
        parentId: null,
        accessGrants:
          actualRole === 'OWNER'
            ? []
            : [
                {
                  role: actualRole,
                },
              ],
      });

      await expect(
        service.requireFolderRole(userId, 'folder-1', requiredRole),
      ).resolves.toBe(actualRole);
    });

    it('rejects VIEWER when EDITOR is required', async () => {
      folderFindUniqueMock.mockResolvedValue({
        ownerId,
        parentId: null,
        accessGrants: [
          {
            role: 'VIEWER',
          },
        ],
      });

      await expect(
        service.requireFolderRole(userId, 'folder-1', 'EDITOR'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns 404 semantics when the user has no access', async () => {
      fileFindFirstMock.mockResolvedValue({
        ownerId,
        folderId: null,
        accessGrants: [],
      });

      await expect(
        service.requireFileRole(userId, 'file-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
