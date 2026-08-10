import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { CreateFolderDto } from './dto/create-folder.dto';
import type { FolderResponseDto } from './dto/folder-response.dto';
import type { MoveFolderDto } from './dto/move-folder.dto';
import type { RenameFolderDto } from './dto/rename-folder.dto';

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
  constructor(private readonly prisma: PrismaService) {}

  async create(
    ownerId: string,
    dto: CreateFolderDto,
  ): Promise<FolderResponseDto> {
    const parentId = dto.parentId ?? null;

    if (parentId) {
      await this.ensureOwnedFolderExists(ownerId, parentId);
    }

    return this.prisma.folder.create({
      data: {
        name: dto.name,
        ownerId,
        parentId,
      },
      select: FOLDER_SELECT,
    });
  }

  async list(ownerId: string, parentId?: string): Promise<FolderResponseDto[]> {
    const normalizedParentId = parentId ?? null;

    if (parentId) {
      await this.ensureOwnedFolderExists(ownerId, parentId);
    }

    return this.prisma.folder.findMany({
      where: {
        ownerId,
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
    ownerId: string,
    folderId: string,
    dto: RenameFolderDto,
  ): Promise<FolderResponseDto> {
    await this.ensureOwnedFolderExists(ownerId, folderId);

    return this.prisma.folder.update({
      where: {
        id: folderId,
      },
      data: {
        name: dto.name,
      },
      select: FOLDER_SELECT,
    });
  }

  async move(
    ownerId: string,
    folderId: string,
    dto: MoveFolderDto,
  ): Promise<FolderResponseDto> {
    await this.ensureOwnedFolderExists(ownerId, folderId);

    if (dto.parentId !== null) {
      await this.ensureMoveDoesNotCreateCycle(ownerId, folderId, dto.parentId);
    }

    return this.prisma.folder.update({
      where: {
        id: folderId,
      },
      data: {
        parentId: dto.parentId,
      },
      select: FOLDER_SELECT,
    });
  }

  async remove(ownerId: string, folderId: string): Promise<void> {
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

  private async ensureOwnedFolderExists(
    ownerId: string,
    folderId: string,
  ): Promise<void> {
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
