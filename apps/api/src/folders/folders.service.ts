import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { AccessService } from '../access/access.service';
import { PrismaService } from '../database/prisma.service';
import type { CreateFolderDto } from './dto/create-folder.dto';
import type { FolderResponseDto } from './dto/folder-response.dto';
import type { MoveFolderDto } from './dto/move-folder.dto';
import type { RenameFolderDto } from './dto/rename-folder.dto';
import { AuditService } from '../audit/audit.service';

const FOLDER_SELECT = {
  id: true,
  name: true,
  ownerId: true,
  parentId: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class FoldersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessService: AccessService,
    private readonly auditService: AuditService,
  ) {}

  async create(
    userId: string,
    dto: CreateFolderDto,
  ): Promise<FolderResponseDto> {
    const parentId = dto.parentId ?? null;

    if (!parentId) {
      const folder = await this.prisma.folder.create({
        data: {
          name: dto.name,
          ownerId: userId,
          parentId: null,
        },
        select: FOLDER_SELECT,
      });

      await this.auditService.write({
        actorUserId: userId,
        action: 'FOLDER_CREATE',
        resourceType: 'FOLDER',
        resourceId: folder.id,
        metadata: {
          name: folder.name,
          parentId: null,
        },
      });

      return folder;
    }

    await this.accessService.requireFolderRole(userId, parentId, 'EDITOR');

    const parent: {
      ownerId: string;
    } | null = await this.prisma.folder.findUnique({
      where: {
        id: parentId,
      },
      select: {
        ownerId: true,
      },
    });

    if (!parent) {
      throw new NotFoundException('Parent folder not found');
    }

    const folder = await this.prisma.folder.create({
      data: {
        name: dto.name,
        ownerId: parent.ownerId,
        parentId,
      },
      select: FOLDER_SELECT,
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'FOLDER_CREATE',
      resourceType: 'FOLDER',
      resourceId: folder.id,
      metadata: {
        name: folder.name,
        parentId,
      },
    });

    return folder;
  }

  async list(userId: string, parentId?: string): Promise<FolderResponseDto[]> {
    const normalizedParentId = parentId ?? null;

    if (parentId) {
      await this.accessService.requireFolderRole(userId, parentId, 'VIEWER');

      return this.prisma.folder.findMany({
        where: {
          parentId,
        },
        orderBy: [
          {
            name: 'asc',
          },
          {
            createdAt: 'asc',
          },
        ],
        select: FOLDER_SELECT,
      });
    }
    return this.prisma.folder.findMany({
      where: {
        ownerId: userId,
        parentId: normalizedParentId,
      },
      orderBy: [
        {
          name: 'asc',
        },
        {
          createdAt: 'asc',
        },
      ],
      select: FOLDER_SELECT,
    });
  }

  async rename(
    userId: string,
    folderId: string,
    dto: RenameFolderDto,
  ): Promise<FolderResponseDto> {
    await this.accessService.requireFolderRole(userId, folderId, 'EDITOR');

    const currentFolder = await this.prisma.folder.findUnique({
      where: {
        id: folderId,
      },
      select: {
        name: true,
      },
    });

    if (!currentFolder) {
      throw new NotFoundException('Folder not found');
    }

    const folder = await this.prisma.folder.update({
      where: {
        id: folderId,
      },
      data: {
        name: dto.name,
      },
      select: FOLDER_SELECT,
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'FOLDER_RENAME',
      resourceType: 'FOLDER',
      resourceId: folder.id,
      metadata: {
        oldName: currentFolder.name,
        newName: folder.name,
      },
    });

    return folder;
  }

  async move(
    userId: string,
    folderId: string,
    dto: MoveFolderDto,
  ): Promise<FolderResponseDto> {
    await this.accessService.requireFolderRole(userId, folderId, 'EDITOR');

    const sourceFolder: {
      ownerId: string;
    } | null = await this.prisma.folder.findUnique({
      where: {
        id: folderId,
      },
      select: {
        ownerId: true,
      },
    });

    if (!sourceFolder) {
      throw new NotFoundException('Folder not found');
    }

    if (dto.parentId === null) {
      if (sourceFolder.ownerId !== userId) {
        throw new ForbiddenException(
          'Only the owner can move a folder to root',
        );
      }

      const folder = await this.prisma.folder.update({
        where: {
          id: folderId,
        },
        data: {
          parentId: null,
        },
        select: FOLDER_SELECT,
      });

      await this.auditService.write({
        actorUserId: userId,
        action: 'FOLDER_MOVE',
        resourceType: 'FOLDER',
        resourceId: folder.id,
        metadata: {
          destinationParentId: null,
        },
      });

      return folder;
    }

    await this.accessService.requireFolderRole(userId, dto.parentId, 'EDITOR');

    const destinationFolder: {
      ownerId: string;
    } | null = await this.prisma.folder.findUnique({
      where: {
        id: dto.parentId,
      },
      select: {
        ownerId: true,
      },
    });

    if (!destinationFolder) {
      throw new NotFoundException('Destination folder not found');
    }

    if (destinationFolder.ownerId !== sourceFolder.ownerId) {
      throw new BadRequestException(
        'Folders with different owners cannot be combined',
      );
    }

    await this.ensureMoveDoesNotCreateCycle(
      sourceFolder.ownerId,
      folderId,
      dto.parentId,
    );

    const folder = await this.prisma.folder.update({
      where: {
        id: folderId,
      },
      data: {
        parentId: dto.parentId,
      },
      select: FOLDER_SELECT,
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'FOLDER_MOVE',
      resourceType: 'FOLDER',
      resourceId: folder.id,
      metadata: {
        destinationParentId: dto.parentId,
      },
    });

    return folder;
  }

  async remove(ownerId: string, folderId: string): Promise<void> {
    await this.accessService.requireFolderRole(ownerId, folderId, 'OWNER');
    const result = await this.prisma.folder.deleteMany({
      where: {
        id: folderId,
        ownerId,
        children: {
          none: {},
        },
        files: {
          none: {},
        },
        uploads: {
          none: {},
        },
      },
    });

    if (result.count === 1) {
      await this.auditService.write({
        actorUserId: ownerId,
        action: 'FOLDER_DELETE',
        resourceType: 'FOLDER',
        resourceId: folderId,
      });

      return;
    }

    const folder = await this.prisma.folder.findFirst({
      where: {
        id: folderId,
        ownerId,
      },
      select: {
        id: true,
      },
    });

    if (!folder) {
      throw new NotFoundException('Folder not found');
    }

    throw new ConflictException('Folder is not empty');
  }

  private async ensureMoveDoesNotCreateCycle(
    ownerId: string,
    folderId: string,
    destinationId: string,
  ): Promise<void> {
    let currentId: string | null = destinationId;
    const visitedIds = new Set<string>();

    while (currentId) {
      if (currentId === folderId) {
        throw new BadRequestException(
          'A folder cannot be moved into itself or its descendant',
        );
      }

      if (visitedIds.has(currentId)) {
        throw new BadRequestException('Folder hierarchy contains a cycle');
      }

      visitedIds.add(currentId);

      const currentFolder: {
        parentId: string | null;
      } | null = await this.prisma.folder.findFirst({
        where: {
          id: currentId,
          ownerId,
        },
        select: {
          parentId: true,
        },
      });

      if (!currentFolder) {
        throw new NotFoundException('Destination folder not found');
      }

      currentId = currentFolder.parentId;
    }
  }
}
