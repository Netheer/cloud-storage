import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { CreateShareDto, ShareRole } from './dto/create-share.dto';
import type { ShareResponseDto } from './dto/share-response.dto';
import type { UpdateShareDto } from './dto/update-share.dto';
import type { SharedFolderResponseDto } from './dto/shared-folder-response.dto';
import type { SharedFileResponseDto } from './dto/shared-file-response.dto';

export type EffectiveAccessRole = 'OWNER' | 'EDITOR' | 'VIEWER';

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

const ACCESS_ROLE_WEIGHT: Record<EffectiveAccessRole, number> = {
  VIEWER: 1,
  EDITOR: 2,
  OWNER: 3,
};

@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  async getFolderRole(
    userId: string,
    folderId: string,
  ): Promise<EffectiveAccessRole | null> {
    return this.resolveFolderRole(userId, folderId);
  }

  async getFileRole(
    userId: string,
    fileId: string,
  ): Promise<EffectiveAccessRole | null> {
    const file = (await this.prisma.file.findFirst({
      where: {
        id: fileId,
        deletedAt: null,
      },
      select: {
        ownerId: true,
        folderId: true,
        accessGrants: {
          where: {
            userId,
          },
          take: 1,
          select: {
            role: true,
          },
        },
      },
    })) as FileAccessRecord | null;

    if (!file) {
      return null;
    }

    /*
     * Ownership всегда имеет максимальный приоритет.
     */
    if (file.ownerId === userId) {
      return 'OWNER';
    }

    /*
     * Direct file grant имеет приоритет
     * над доступом, унаследованным от папки.
     */
    const directRole = this.normalizeGrantedRole(file.accessGrants[0]?.role);

    if (directRole) {
      return directRole;
    }

    if (!file.folderId) {
      return null;
    }

    return this.resolveFolderRole(userId, file.folderId);
  }

  async requireFolderRole(
    userId: string,
    folderId: string,
    minimumRole: EffectiveAccessRole = 'VIEWER',
  ): Promise<EffectiveAccessRole> {
    const role = await this.getFolderRole(userId, folderId);

    if (!role) {
      /*
       * Не раскрываем существование чужого ресурса.
       */
      throw new NotFoundException('Folder not found');
    }

    if (!this.hasRequiredRole(role, minimumRole)) {
      throw new ForbiddenException('Insufficient folder permissions');
    }

    return role;
  }

  async listFolderShares(
    userId: string,
    folderId: string,
  ): Promise<ShareResponseDto[]> {
    await this.requireFolderRole(userId, folderId, 'OWNER');

    const grants = await this.prisma.folderAccessGrant.findMany({
      where: {
        folderId,
      },
      orderBy: {
        createdAt: 'asc',
      },
      select: {
        id: true,
        role: true,
        createdAt: true,
        updatedAt: true,
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
          },
        },
      },
    });

    return grants.map((grant) => ({
      id: grant.id,
      userId: grant.user.id,
      email: grant.user.email,
      displayName: grant.user.displayName,
      role: this.normalizeShareRole(grant.role),
      createdAt: grant.createdAt,
      updatedAt: grant.updatedAt,
    }));
  }

  async listSharedFiles(userId: string): Promise<SharedFileResponseDto[]> {
    const grants = await this.prisma.fileAccessGrant.findMany({
      where: {
        userId,
        file: {
          deletedAt: null,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        role: true,
        createdAt: true,
        file: {
          select: {
            id: true,
            name: true,
            ownerId: true,
            folderId: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            currentVersion: {
              select: {
                mimeType: true,
                size: true,
              },
            },
          },
        },
      },
    });

    return grants.map((grant) => ({
      id: grant.file.id,
      name: grant.file.name,
      ownerId: grant.file.ownerId,
      folderId: grant.file.folderId,
      status: grant.file.status,
      mimeType: grant.file.currentVersion?.mimeType ?? null,
      size: grant.file.currentVersion?.size.toString() ?? null,
      role: this.normalizeShareRole(grant.role),
      sharedAt: grant.createdAt,
      createdAt: grant.file.createdAt,
      updatedAt: grant.file.updatedAt,
    }));
  }

  async createFolderShare(
    userId: string,
    folderId: string,
    dto: CreateShareDto,
  ): Promise<ShareResponseDto> {
    await this.requireFolderRole(userId, folderId, 'OWNER');

    const targetUser = await this.prisma.user.findUnique({
      where: {
        email: dto.email,
      },
      select: {
        id: true,
        email: true,
        displayName: true,
      },
    });

    if (!targetUser) {
      throw new NotFoundException('User not found');
    }

    if (targetUser.id === userId) {
      throw new BadRequestException(
        'Resource owner cannot be added as a share',
      );
    }

    const existingGrant = await this.prisma.folderAccessGrant.findUnique({
      where: {
        folderId_userId: {
          folderId,
          userId: targetUser.id,
        },
      },
      select: {
        id: true,
      },
    });

    if (existingGrant) {
      throw new ConflictException('Folder is already shared with this user');
    }

    const grant = await this.prisma.folderAccessGrant.create({
      data: {
        folderId,
        userId: targetUser.id,
        role: dto.role,
      },
      select: {
        id: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      id: grant.id,
      userId: targetUser.id,
      email: targetUser.email,
      displayName: targetUser.displayName,
      role: this.normalizeShareRole(grant.role),
      createdAt: grant.createdAt,
      updatedAt: grant.updatedAt,
    };
  }

  async updateFolderShare(
    userId: string,
    folderId: string,
    grantId: string,
    dto: UpdateShareDto,
  ): Promise<ShareResponseDto> {
    await this.requireFolderRole(userId, folderId, 'OWNER');

    const existingGrant = await this.prisma.folderAccessGrant.findFirst({
      where: {
        id: grantId,
        folderId,
      },
      select: {
        id: true,
      },
    });

    if (!existingGrant) {
      throw new NotFoundException('Folder share not found');
    }

    const grant = await this.prisma.folderAccessGrant.update({
      where: {
        id: grantId,
      },
      data: {
        role: dto.role,
      },
      select: {
        id: true,
        role: true,
        createdAt: true,
        updatedAt: true,
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
          },
        },
      },
    });

    return {
      id: grant.id,
      userId: grant.user.id,
      email: grant.user.email,
      displayName: grant.user.displayName,
      role: this.normalizeShareRole(grant.role),
      createdAt: grant.createdAt,
      updatedAt: grant.updatedAt,
    };
  }

  async removeFolderShare(
    userId: string,
    folderId: string,
    grantId: string,
  ): Promise<void> {
    await this.requireFolderRole(userId, folderId, 'OWNER');

    const result = await this.prisma.folderAccessGrant.deleteMany({
      where: {
        id: grantId,
        folderId,
      },
    });

    if (result.count === 0) {
      throw new NotFoundException('Folder share not found');
    }
  }

  async listFileShares(
    userId: string,
    fileId: string,
  ): Promise<ShareResponseDto[]> {
    await this.requireFileRole(userId, fileId, 'OWNER');

    const grants = await this.prisma.fileAccessGrant.findMany({
      where: {
        fileId,
      },
      orderBy: {
        createdAt: 'asc',
      },
      select: {
        id: true,
        role: true,
        createdAt: true,
        updatedAt: true,
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
          },
        },
      },
    });

    return grants.map((grant) => ({
      id: grant.id,
      userId: grant.user.id,
      email: grant.user.email,
      displayName: grant.user.displayName,
      role: this.normalizeShareRole(grant.role),
      createdAt: grant.createdAt,
      updatedAt: grant.updatedAt,
    }));
  }

  async createFileShare(
    userId: string,
    fileId: string,
    dto: CreateShareDto,
  ): Promise<ShareResponseDto> {
    await this.requireFileRole(userId, fileId, 'OWNER');

    const targetUser = await this.prisma.user.findUnique({
      where: {
        email: dto.email,
      },
      select: {
        id: true,
        email: true,
        displayName: true,
      },
    });

    if (!targetUser) {
      throw new NotFoundException('User not found');
    }

    if (targetUser.id === userId) {
      throw new BadRequestException(
        'Resource owner cannot be added as a share',
      );
    }

    /*
     * Проверяем только direct file grant.
     *
     * Наличие inherited folder grant
     * НЕ является конфликтом:
     *
     * folder EDITOR + file VIEWER
     * => effective role VIEWER
     */
    const existingGrant = await this.prisma.fileAccessGrant.findUnique({
      where: {
        fileId_userId: {
          fileId,
          userId: targetUser.id,
        },
      },
      select: {
        id: true,
      },
    });

    if (existingGrant) {
      throw new ConflictException('File is already shared with this user');
    }

    const grant = await this.prisma.fileAccessGrant.create({
      data: {
        fileId,
        userId: targetUser.id,
        role: dto.role,
      },
      select: {
        id: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      id: grant.id,
      userId: targetUser.id,
      email: targetUser.email,
      displayName: targetUser.displayName,
      role: this.normalizeShareRole(grant.role),
      createdAt: grant.createdAt,
      updatedAt: grant.updatedAt,
    };
  }

  async updateFileShare(
    userId: string,
    fileId: string,
    grantId: string,
    dto: UpdateShareDto,
  ): Promise<ShareResponseDto> {
    await this.requireFileRole(userId, fileId, 'OWNER');

    const existingGrant = await this.prisma.fileAccessGrant.findFirst({
      where: {
        id: grantId,
        fileId,
      },
      select: {
        id: true,
      },
    });

    if (!existingGrant) {
      throw new NotFoundException('File share not found');
    }

    const grant = await this.prisma.fileAccessGrant.update({
      where: {
        id: grantId,
      },
      data: {
        role: dto.role,
      },
      select: {
        id: true,
        role: true,
        createdAt: true,
        updatedAt: true,
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
          },
        },
      },
    });

    return {
      id: grant.id,
      userId: grant.user.id,
      email: grant.user.email,
      displayName: grant.user.displayName,
      role: this.normalizeShareRole(grant.role),
      createdAt: grant.createdAt,
      updatedAt: grant.updatedAt,
    };
  }

  async removeFileShare(
    userId: string,
    fileId: string,
    grantId: string,
  ): Promise<void> {
    await this.requireFileRole(userId, fileId, 'OWNER');

    const result = await this.prisma.fileAccessGrant.deleteMany({
      where: {
        id: grantId,
        fileId,
      },
    });

    if (result.count === 0) {
      throw new NotFoundException('File share not found');
    }
  }

  async requireFileRole(
    userId: string,
    fileId: string,
    minimumRole: EffectiveAccessRole = 'VIEWER',
  ): Promise<EffectiveAccessRole> {
    const role = await this.getFileRole(userId, fileId);

    if (!role) {
      /*
       * Не раскрываем существование чужого ресурса.
       */
      throw new NotFoundException('File not found');
    }

    if (!this.hasRequiredRole(role, minimumRole)) {
      throw new ForbiddenException('Insufficient file permissions');
    }

    return role;
  }

  async listSharedFolders(userId: string): Promise<SharedFolderResponseDto[]> {
    const grants = await this.prisma.folderAccessGrant.findMany({
      where: {
        userId,
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        role: true,
        createdAt: true,
        folder: {
          select: {
            id: true,
            name: true,
            ownerId: true,
            parentId: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });

    return grants.map((grant) => ({
      id: grant.folder.id,
      name: grant.folder.name,
      ownerId: grant.folder.ownerId,
      parentId: grant.folder.parentId,
      role: this.normalizeShareRole(grant.role),
      sharedAt: grant.createdAt,
      createdAt: grant.folder.createdAt,
      updatedAt: grant.folder.updatedAt,
    }));
  }

  private async resolveFolderRole(
    userId: string,
    folderId: string,
  ): Promise<EffectiveAccessRole | null> {
    let currentFolderId: string | null = folderId;

    const visitedFolderIds = new Set<string>();

    while (currentFolderId) {
      /*
       * Это не должно происходить, потому что move
       * уже защищает иерархию от циклов.
       * Но AccessService не должен зависнуть,
       * если данные в БД окажутся повреждены.
       */
      if (visitedFolderIds.has(currentFolderId)) {
        throw new InternalServerErrorException('Folder hierarchy is invalid');
      }

      visitedFolderIds.add(currentFolderId);

      const folder = (await this.prisma.folder.findUnique({
        where: {
          id: currentFolderId,
        },
        select: {
          ownerId: true,
          parentId: true,
          accessGrants: {
            where: {
              userId,
            },
            take: 1,
            select: {
              role: true,
            },
          },
        },
      })) as FolderAccessRecord | null;

      if (!folder) {
        return null;
      }

      /*
       * Для исходной или любой родительской
       * папки ownership означает OWNER.
       */
      if (folder.ownerId === userId) {
        return 'OWNER';
      }

      /*
       * Идём снизу вверх.
       *
       * Поэтому первый найденный grant —
       * grant ближайшего предка.
       */
      const grantedRole = this.normalizeGrantedRole(
        folder.accessGrants[0]?.role,
      );

      if (grantedRole) {
        return grantedRole;
      }

      currentFolderId = folder.parentId;
    }

    return null;
  }

  private normalizeGrantedRole(
    role: string | undefined,
  ): EffectiveAccessRole | null {
    /*
     * OWNER не разрешаем получать через AccessGrant.
     * Ownership определяется только ownerId.
     */
    if (role === 'EDITOR' || role === 'VIEWER') {
      return role;
    }

    return null;
  }

  private hasRequiredRole(
    actualRole: EffectiveAccessRole,
    minimumRole: EffectiveAccessRole,
  ): boolean {
    return ACCESS_ROLE_WEIGHT[actualRole] >= ACCESS_ROLE_WEIGHT[minimumRole];
  }

  private normalizeShareRole(role: string): ShareRole {
    if (role === 'EDITOR' || role === 'VIEWER') {
      return role;
    }

    throw new InternalServerErrorException('Stored access role is invalid');
  }
}
