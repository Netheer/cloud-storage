import {
  BadRequestException,
  ConflictException,
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
import type { InitiateMultipartUploadDto } from './dto/initiate-multipart-upload.dto';
import type { MultipartUploadSessionResponseDto } from './dto/multipart-upload-session-response.dto';
import type { RenameFileDto } from './dto/rename-file.dto';
import type { DownloadFileResponseDto } from './dto/download-file-response.dto';
import type { FileResponseDto } from './dto/file-response.dto';
import type { UploadFileDto } from './dto/upload-file.dto';
import type { MoveFileDto } from './dto/move-file.dto';

const SIMPLE_UPLOAD_MAX_SIZE_BYTES = 10n * 1024n * 1024n;
const MULTIPART_UPLOAD_PART_SIZE_BYTES = 8n * 1024n * 1024n;
const MULTIPART_UPLOAD_MAX_SIZE_BYTES = 5n * 1024n * 1024n * 1024n;
const MULTIPART_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MULTIPART_PARTS = 10_000;

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

const MULTIPART_SESSION_SELECT = {
  id: true,
  clientRequestId: true,
  originalName: true,
  mimeType: true,
  folderId: true,
  totalSize: true,
  partSize: true,
  totalParts: true,
  status: true,
  expiresAt: true,
  fileId: true,
  objectKey: true,
} as const;

type MultipartSessionRecord = {
  id: string;
  clientRequestId: string;
  originalName: string;
  mimeType: string | null;
  folderId: string | null;
  totalSize: bigint;
  partSize: bigint;
  totalParts: number;
  status: string;
  expiresAt: Date;
  fileId: string | null;
  objectKey: string;
};

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

  async initiateMultipartUpload(
    ownerId: string,
    dto: InitiateMultipartUploadDto,
  ): Promise<MultipartUploadSessionResponseDto> {
    const folderId = dto.folderId ?? null;
    const originalName = this.normalizeFileName(dto.fileName);
    const mimeType = this.normalizeMimeType(dto.mimeType);
    const totalSize = this.parseMultipartTotalSize(dto.totalSize);

    if (folderId) {
      await this.ensureOwnedFolderExists(ownerId, folderId);
    }

    const partSize = MULTIPART_UPLOAD_PART_SIZE_BYTES;
    const totalParts = Number((totalSize + partSize - 1n) / partSize);

    if (totalParts > MAX_MULTIPART_PARTS) {
      throw new BadRequestException(
        'File requires too many multipart upload parts',
      );
    }

    const candidateObjectKey = `users/${ownerId}/objects/${randomUUID()}`;

    const session = await this.prisma.uploadSession.upsert({
      where: {
        ownerId_clientRequestId: {
          ownerId,
          clientRequestId: dto.clientRequestId,
        },
      },
      create: {
        ownerId,
        folderId,
        clientRequestId: dto.clientRequestId,
        objectKey: candidateObjectKey,
        originalName,
        mimeType,
        totalSize,
        partSize,
        totalParts,
        status: 'CREATED',
        expiresAt: new Date(Date.now() + MULTIPART_UPLOAD_TTL_MS),
      },
      update: {},
      select: MULTIPART_SESSION_SELECT,
    });

    const requestMatchesSession =
      session.originalName === originalName &&
      session.mimeType === mimeType &&
      session.folderId === folderId &&
      session.totalSize === totalSize;

    if (!requestMatchesSession) {
      throw new ConflictException(
        'Client request ID is already used with different upload parameters',
      );
    }

    const createdByCurrentRequest = session.objectKey === candidateObjectKey;

    if (!createdByCurrentRequest) {
      return this.toMultipartUploadSessionResponseDto(session);
    }

    let multipartUploadId: string;

    try {
      const multipartUpload = await this.objectStorage.createMultipartUpload({
        objectKey: session.objectKey,
        contentType: mimeType ?? undefined,
      });

      multipartUploadId = multipartUpload.uploadId;
    } catch {
      await this.markMultipartSessionFailed(session.id);

      throw new ServiceUnavailableException(
        'Object storage is temporarily unavailable',
      );
    }

    try {
      const updatedSession = await this.prisma.uploadSession.update({
        where: {
          id: session.id,
        },
        data: {
          multipartUploadId,
          status: 'UPLOADING',
        },
        select: MULTIPART_SESSION_SELECT,
      });

      return this.toMultipartUploadSessionResponseDto(updatedSession);
    } catch (error: unknown) {
      await this.abortOrphanedMultipartUpload(
        session.objectKey,
        multipartUploadId,
      );
      await this.markMultipartSessionFailed(session.id);

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

  private normalizeMimeType(mimeType?: string): string | null {
    const normalizedMimeType = mimeType?.trim() ?? '';

    return normalizedMimeType || null;
  }

  private parseMultipartTotalSize(totalSizeValue: string): bigint {
    let totalSize: bigint;

    try {
      totalSize = BigInt(totalSizeValue);
    } catch {
      throw new BadRequestException('File size is invalid');
    }

    if (totalSize <= SIMPLE_UPLOAD_MAX_SIZE_BYTES) {
      throw new BadRequestException(
        'Multipart upload is only available for files larger than 10 MiB',
      );
    }

    if (totalSize > MULTIPART_UPLOAD_MAX_SIZE_BYTES) {
      throw new BadRequestException(
        'Multipart upload file size must not exceed 5 GiB',
      );
    }

    return totalSize;
  }

  private toMultipartUploadSessionResponseDto(
    session: MultipartSessionRecord,
  ): MultipartUploadSessionResponseDto {
    return {
      id: session.id,
      clientRequestId: session.clientRequestId,
      originalName: session.originalName,
      mimeType: session.mimeType,
      folderId: session.folderId,
      totalSize: session.totalSize.toString(),
      partSize: session.partSize.toString(),
      totalParts: session.totalParts,
      status: session.status,
      expiresAt: session.expiresAt,
      fileId: session.fileId,
    };
  }

  private async markMultipartSessionFailed(
    uploadSessionId: string,
  ): Promise<void> {
    try {
      await this.prisma.uploadSession.updateMany({
        where: {
          id: uploadSessionId,
          status: 'CREATED',
        },
        data: {
          status: 'FAILED',
        },
      });
    } catch (error: unknown) {
      const trace = error instanceof Error ? error.stack : undefined;

      this.logger.error(
        'Failed to mark multipart upload session as failed',
        trace,
      );
    }
  }

  private async abortOrphanedMultipartUpload(
    objectKey: string,
    uploadId: string,
  ): Promise<void> {
    try {
      await this.objectStorage.abortMultipartUpload({
        objectKey,
        uploadId,
      });
    } catch (error: unknown) {
      const trace = error instanceof Error ? error.stack : undefined;

      this.logger.error('Failed to abort an orphaned multipart upload', trace);
    }
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
