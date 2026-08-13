import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from '../storage/object-storage.interface';
import type { RenameFileDto } from './dto/rename-file.dto';
import type { DownloadFileResponseDto } from './dto/download-file-response.dto';
import type { FileResponseDto } from './dto/file-response.dto';
import type { UploadFileDto } from './dto/upload-file.dto';
import type { MoveFileDto } from './dto/move-file.dto';

const FILE_SELECT = {
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
} as const;

type FileRecord = {
  id: string;
  name: string;
  ownerId: string;
  folderId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  currentVersion: {
    mimeType: string | null;
    size: bigint;
  } | null;
};

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE)
    private readonly objectStorage: ObjectStorage,
  ) {}

  async upload(
    ownerId: string,
    file: Express.Multer.File,
    dto: UploadFileDto,
  ): Promise<FileResponseDto> {
    const folderId = dto.folderId ?? null;
    const fileName = this.normalizeFileName(file.originalname);

    if (folderId) {
      await this.ensureOwnedFolderExists(ownerId, folderId);
    }

    const objectKey = `users/${ownerId}/objects/${randomUUID()}`;
    const mimeType = file.mimetype.trim() || null;

    await this.objectStorage.putObject({
      objectKey,
      body: file.buffer,
      contentType: mimeType ?? undefined,
    });

    try {
      const createdFile = await this.prisma.$transaction(
        async (transaction) => {
          const fileMetadata = await transaction.file.create({
            data: {
              name: fileName,
              ownerId,
              folderId,
              status: 'UPLOADING',
            },
            select: {
              id: true,
            },
          });

          const storedObject = await transaction.storedObject.create({
            data: {
              objectKey,
              size: BigInt(file.size),
              referenceCount: 1,
            },
            select: {
              id: true,
            },
          });

          const version = await transaction.fileVersion.create({
            data: {
              fileId: fileMetadata.id,
              storedObjectId: storedObject.id,
              versionNumber: 1,
              originalName: fileName,
              mimeType,
              size: BigInt(file.size),
            },
            select: {
              id: true,
            },
          });

          return transaction.file.update({
            where: {
              id: fileMetadata.id,
            },
            data: {
              currentVersionId: version.id,
              status: 'READY',
            },
            select: FILE_SELECT,
          });
        },
      );

      return this.toResponseDto(createdFile);
    } catch (error: unknown) {
      await this.removeOrphanedObject(objectKey);
      throw error;
    }
  }

  async list(ownerId: string, folderId?: string): Promise<FileResponseDto[]> {
    const normalizedFolderId = folderId ?? null;

    if (folderId) {
      await this.ensureOwnedFolderExists(ownerId, folderId);
    }

    const files = await this.prisma.file.findMany({
      where: {
        ownerId,
        folderId: normalizedFolderId,
        status: 'READY',
        deletedAt: null,
      },
      orderBy: [
        {
          name: 'asc',
        },
        {
          createdAt: 'asc',
        },
      ],
      select: FILE_SELECT,
    });

    return files.map((file) => this.toResponseDto(file));
  }

  async createDownloadUrl(
    ownerId: string,
    fileId: string,
  ): Promise<DownloadFileResponseDto> {
    const file = await this.prisma.file.findFirst({
      where: {
        id: fileId,
        ownerId,
        status: 'READY',
        deletedAt: null,
      },
      select: {
        name: true,
        currentVersion: {
          select: {
            mimeType: true,
            storedObject: {
              select: {
                objectKey: true,
              },
            },
          },
        },
      },
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    if (!file.currentVersion) {
      throw new InternalServerErrorException('File metadata is incomplete');
    }

    const expiresInSeconds = 10 * 60;

    const url = await this.objectStorage.createPresignedDownloadUrl({
      objectKey: file.currentVersion.storedObject.objectKey,
      downloadFileName: file.name,
      contentType: file.currentVersion.mimeType ?? undefined,
      expiresInSeconds,
    });

    return {
      url,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    };
  }

  async rename(
    ownerId: string,
    fileId: string,
    dto: RenameFileDto,
  ): Promise<FileResponseDto> {
    const file = await this.prisma.file.findFirst({
      where: {
        id: fileId,
        ownerId,
        status: 'READY',
        deletedAt: null,
      },
      select: {
        id: true,
      },
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    const name = this.normalizeFileName(dto.name);

    const updatedFile = await this.prisma.file.update({
      where: {
        id: file.id,
      },
      data: {
        name,
      },
      select: FILE_SELECT,
    });

    return this.toResponseDto(updatedFile);
  }

  async move(
    ownerId: string,
    fileId: string,
    dto: MoveFileDto,
  ): Promise<FileResponseDto> {
    const file = await this.prisma.file.findFirst({
      where: {
        id: fileId,
        ownerId,
        status: 'READY',
        deletedAt: null,
      },
      select: {
        id: true,
      },
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    if (dto.folderId !== null) {
      await this.ensureOwnedFolderExists(ownerId, dto.folderId);
    }

    const movedFile = await this.prisma.file.update({
      where: {
        id: file.id,
      },
      data: {
        folderId: dto.folderId,
      },
      select: FILE_SELECT,
    });

    return this.toResponseDto(movedFile);
  }

  async remove(ownerId: string, fileId: string): Promise<void> {
    const file = await this.prisma.file.findFirst({
      where: {
        id: fileId,
        ownerId,
        status: {
          in: ['READY', 'DELETED'],
        },
      },
      select: {
        id: true,
        status: true,
        currentVersion: {
          select: {
            storedObject: {
              select: {
                id: true,
                objectKey: true,
                _count: {
                  select: {
                    versions: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    if (!file.currentVersion) {
      throw new InternalServerErrorException('File metadata is incomplete');
    }

    if (file.status === 'READY') {
      await this.prisma.file.update({
        where: {
          id: file.id,
        },
        data: {
          status: 'DELETED',
          deletedAt: new Date(),
        },
      });
    }

    const storedObject = file.currentVersion.storedObject;
    const shouldDeleteStoredObject = storedObject._count.versions === 1;

    if (shouldDeleteStoredObject) {
      try {
        await this.objectStorage.deleteObject(storedObject.objectKey);
      } catch {
        throw new ServiceUnavailableException(
          'Object storage is temporarily unavailable',
        );
      }
    }

    await this.prisma.$transaction(async (transaction) => {
      const deletedFile = await transaction.file.deleteMany({
        where: {
          id: file.id,
          ownerId,
          status: 'DELETED',
        },
      });

      if (deletedFile.count === 0) {
        return;
      }

      if (shouldDeleteStoredObject) {
        await transaction.storedObject.deleteMany({
          where: {
            id: storedObject.id,
            versions: {
              none: {},
            },
          },
        });

        return;
      }

      await transaction.storedObject.update({
        where: {
          id: storedObject.id,
        },
        data: {
          referenceCount: {
            decrement: 1,
          },
        },
      });
    });
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

  private normalizeFileName(originalName: string): string {
    const normalizedPath = originalName.replace(/\\/g, '/');
    const fileName = normalizedPath.split('/').pop()?.trim() ?? '';

    if (!fileName || fileName === '.' || fileName === '..') {
      throw new BadRequestException('File name is invalid');
    }

    if (fileName.length > 255) {
      throw new BadRequestException(
        'File name must not be longer than 255 characters',
      );
    }

    const containsControlCharacter = Array.from(fileName).some(
      (character) => character.charCodeAt(0) < 32,
    );

    if (containsControlCharacter) {
      throw new BadRequestException(
        'File name must not contain control characters',
      );
    }

    return fileName;
  }

  private toResponseDto(file: FileRecord): FileResponseDto {
    if (!file.currentVersion) {
      throw new InternalServerErrorException('File metadata is incomplete');
    }

    return {
      id: file.id,
      name: file.name,
      ownerId: file.ownerId,
      folderId: file.folderId,
      status: file.status,
      mimeType: file.currentVersion.mimeType,
      size: file.currentVersion.size.toString(),
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    };
  }

  private async removeOrphanedObject(objectKey: string): Promise<void> {
    try {
      await this.objectStorage.deleteObject(objectKey);
    } catch (cleanupError: unknown) {
      const trace =
        cleanupError instanceof Error ? cleanupError.stack : undefined;

      this.logger.error(
        'Failed to remove an orphaned object from storage',
        trace,
      );
    }
  }
}
