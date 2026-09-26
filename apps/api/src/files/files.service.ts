import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  GoneException,
  ForbiddenException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import {
  OBJECT_STORAGE,
  type MultipartUploadPart,
  type ObjectStorage,
} from '../storage/object-storage.interface';
import { AccessService } from '../access/access.service';
import type { PreviewFileResponseDto } from './dto/preview-file-response.dto';
import type {
  MultipartUploadedPartResponseDto,
  MultipartUploadStatusResponseDto,
} from './dto/multipart-upload-status-response.dto';
import type { InitiateMultipartUploadDto } from './dto/initiate-multipart-upload.dto';
import type { MultipartUploadSessionResponseDto } from './dto/multipart-upload-session-response.dto';
import type { MultipartUploadPartUrlResponseDto } from './dto/multipart-upload-part-url-response.dto';
import type { RenameFileDto } from './dto/rename-file.dto';
import type { DownloadFileResponseDto } from './dto/download-file-response.dto';
import type { FileResponseDto } from './dto/file-response.dto';
import type { UploadFileDto } from './dto/upload-file.dto';
import type { MoveFileDto } from './dto/move-file.dto';
import type { FileVersionResponseDto } from './dto/file-version-response.dto';
import { AuditService } from '../audit/audit.service';

const SIMPLE_UPLOAD_MAX_SIZE_BYTES = 10n * 1024n * 1024n;
const MULTIPART_UPLOAD_PART_SIZE_BYTES = 8n * 1024n * 1024n;
const MULTIPART_UPLOAD_MAX_SIZE_BYTES = 5n * 1024n * 1024n * 1024n;
const MULTIPART_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MULTIPART_PARTS = 10_000;
const MULTIPART_PART_URL_TTL_SECONDS = 15 * 60;
const MULTIPART_COMPLETION_RECOVERY_DELAY_MS = 30 * 1000;
const MULTIPART_ABORT_RECOVERY_DELAY_MS = 30 * 1000;
const PROCESS_FILE_OUTBOX_EVENT_TYPE = 'PROCESS_FILE';

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

type MultipartStatusSessionRecord = MultipartSessionRecord & {
  multipartUploadId: string | null;
};

type StoredMultipartPartRecord = {
  partNumber: number;
  etag: string;
  size: bigint;
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

type FinalizeMultipartUploadInput = {
  actorUserId: string;
  resourceOwnerId: string;
  uploadSessionId: string;
  folderId: string | null;
  objectKey: string;
  originalName: string;
  mimeType: string | null;
  totalSize: bigint;
};

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accessService: AccessService,
    @Inject(OBJECT_STORAGE)
    private readonly objectStorage: ObjectStorage,
    private readonly auditService: AuditService,
  ) {}

  async upload(
    userId: string,
    file: Express.Multer.File,
    dto: UploadFileDto,
  ): Promise<FileResponseDto> {
    const folderId = dto.folderId ?? null;
    const fileName = this.normalizeFileName(file.originalname);

    let fileOwnerId = userId;

    if (folderId) {
      await this.accessService.requireFolderRole(userId, folderId, 'EDITOR');

      const folder = await this.prisma.folder.findUnique({
        where: {
          id: folderId,
        },
        select: {
          ownerId: true,
        },
      });

      if (!folder) {
        throw new NotFoundException('Folder not found');
      }

      fileOwnerId = folder.ownerId;
    }

    const objectKey = `users/${fileOwnerId}/objects/${randomUUID()}`;

    const mimeType = file.mimetype.trim() || null;

    await this.objectStorage.putObject({
      objectKey,
      body: file.buffer,
      contentType: mimeType ?? undefined,
    });

    let createdFile: FileRecord;

    try {
      createdFile = await this.prisma.$transaction(async (transaction) => {
        const fileMetadata = await transaction.file.create({
          data: {
            name: fileName,
            ownerId: fileOwnerId,
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

        const processingFile = await transaction.file.update({
          where: {
            id: fileMetadata.id,
          },
          data: {
            currentVersionId: version.id,
            status: 'PROCESSING',
          },
          select: FILE_SELECT,
        });

        await transaction.outboxEvent.create({
          data: {
            type: PROCESS_FILE_OUTBOX_EVENT_TYPE,
            aggregateId: fileMetadata.id,
            payload: {
              fileId: fileMetadata.id,
              versionId: version.id,
              storedObjectId: storedObject.id,
            },
          },
        });

        return processingFile;
      });
    } catch (error: unknown) {
      await this.removeOrphanedObject(objectKey);

      throw error;
    }

    await this.auditService.write({
      actorUserId: userId,
      action: 'FILE_UPLOAD',
      resourceType: 'FILE',
      resourceId: createdFile.id,
      metadata: {
        name: createdFile.name,
        folderId: createdFile.folderId,
        size: createdFile.currentVersion?.size.toString(),
      },
    });

    return this.toResponseDto(createdFile);
  }

  async uploadVersion(
    userId: string,
    fileId: string,
    file: Express.Multer.File,
  ): Promise<FileResponseDto> {
    await this.accessService.requireFileRole(userId, fileId, 'EDITOR');

    const fileName = this.normalizeFileName(file.originalname);
    const mimeType = file.mimetype.trim() || null;

    const existingFile = await this.prisma.file.findFirst({
      where: {
        id: fileId,
        deletedAt: null,
      },
      select: {
        ownerId: true,
        status: true,
      },
    });

    if (!existingFile) {
      throw new NotFoundException('File not found');
    }

    if (existingFile.status !== 'READY') {
      throw new ConflictException('File is not ready to accept a new version');
    }

    /*
     * Новая версия физически хранится
     * в namespace владельца logical File,
     * а не пользователя-редактора.
     */
    const fileOwnerId = existingFile.ownerId;

    const objectKey = `users/${fileOwnerId}/objects/${randomUUID()}`;

    await this.objectStorage.putObject({
      objectKey,
      body: file.buffer,
      contentType: mimeType ?? undefined,
    });

    let updatedFile: FileRecord;

    try {
      updatedFile = await this.prisma.$transaction(async (transaction) => {
        /*
         * Lock нужен для безопасного вычисления
         * следующего versionNumber.
         */
        const lockedFiles = await transaction.$queryRaw<Array<{ id: string }>>`
              SELECT "id"
              FROM "File"
              WHERE "id" = ${fileId}::uuid
                AND "ownerId" = ${fileOwnerId}::uuid
                AND "deletedAt" IS NULL
              FOR UPDATE
            `;

        if (lockedFiles.length === 0) {
          throw new NotFoundException('File not found');
        }

        const currentFile = await transaction.file.findUnique({
          where: {
            id: fileId,
          },
          select: {
            status: true,
            versions: {
              orderBy: {
                versionNumber: 'desc',
              },
              take: 1,
              select: {
                versionNumber: true,
              },
            },
          },
        });

        if (!currentFile) {
          throw new NotFoundException('File not found');
        }

        if (currentFile.status !== 'READY') {
          throw new ConflictException(
            'File is not ready to accept a new version',
          );
        }

        const nextVersionNumber =
          (currentFile.versions[0]?.versionNumber ?? 0) + 1;

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
            fileId,
            storedObjectId: storedObject.id,
            versionNumber: nextVersionNumber,
            originalName: fileName,
            mimeType,
            size: BigInt(file.size),
          },
          select: {
            id: true,
          },
        });

        const processingFile = await transaction.file.update({
          where: {
            id: fileId,
          },
          data: {
            currentVersionId: version.id,
            status: 'PROCESSING',
          },
          select: FILE_SELECT,
        });

        await transaction.outboxEvent.create({
          data: {
            type: PROCESS_FILE_OUTBOX_EVENT_TYPE,
            aggregateId: fileId,
            payload: {
              fileId,
              versionId: version.id,
              storedObjectId: storedObject.id,
            },
          },
        });

        return processingFile;
      });
    } catch (error: unknown) {
      await this.removeOrphanedObject(objectKey);

      throw error;
    }

    await this.auditService.write({
      actorUserId: userId,
      action: 'FILE_VERSION_UPLOAD',
      resourceType: 'FILE',
      resourceId: fileId,
      metadata: {
        name: fileName,
        size: file.size,
      },
    });

    return this.toResponseDto(updatedFile);
  }

  async initiateMultipartUpload(
    userId: string,
    dto: InitiateMultipartUploadDto,
    targetFileId?: string,
  ): Promise<MultipartUploadSessionResponseDto> {
    let folderId = dto.folderId ?? null;
    let resourceOwnerId = userId;

    const originalName = this.normalizeFileName(dto.fileName);
    const mimeType = this.normalizeMimeType(dto.mimeType);
    const totalSize = this.parseMultipartTotalSize(dto.totalSize);

    /*
     * Multipart новой версии.
     */
    if (targetFileId) {
      if (dto.folderId !== undefined) {
        throw new BadRequestException(
          'folderId is not allowed when uploading a new file version',
        );
      }

      await this.accessService.requireFileRole(userId, targetFileId, 'EDITOR');

      const targetFile = await this.prisma.file.findFirst({
        where: {
          id: targetFileId,
          deletedAt: null,
        },
        select: {
          ownerId: true,
          folderId: true,
          status: true,
        },
      });

      if (!targetFile) {
        throw new NotFoundException('File not found');
      }

      if (targetFile.status !== 'READY') {
        throw new ConflictException(
          'File is not ready to accept a new version',
        );
      }

      folderId = targetFile.folderId;
      resourceOwnerId = targetFile.ownerId;
    } else if (folderId) {
      /*
       * Обычный multipart upload
       * внутрь shared folder.
       */
      await this.accessService.requireFolderRole(userId, folderId, 'EDITOR');

      const folder = await this.prisma.folder.findUnique({
        where: {
          id: folderId,
        },
        select: {
          ownerId: true,
        },
      });

      if (!folder) {
        throw new NotFoundException('Folder not found');
      }

      resourceOwnerId = folder.ownerId;
    }

    const partSize = MULTIPART_UPLOAD_PART_SIZE_BYTES;
    const totalParts = Number((totalSize + partSize - 1n) / partSize);

    if (totalParts > MAX_MULTIPART_PARTS) {
      throw new BadRequestException(
        'File requires too many multipart upload parts',
      );
    }

    const candidateObjectKey = `users/${resourceOwnerId}/objects/${randomUUID()}`;

    const session = await this.prisma.uploadSession.upsert({
      where: {
        ownerId_clientRequestId: {
          ownerId: userId,
          clientRequestId: dto.clientRequestId,
        },
      },
      create: {
        ownerId: userId,
        folderId,
        fileId: targetFileId ?? null,
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
      session.fileId === (targetFileId ?? null) &&
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

  async createMultipartUploadPartUrl(
    ownerId: string,
    uploadSessionId: string,
    partNumber: number,
  ): Promise<MultipartUploadPartUrlResponseDto> {
    const session = await this.prisma.uploadSession.findFirst({
      where: {
        id: uploadSessionId,
        ownerId,
      },
      select: {
        id: true,
        status: true,
        expiresAt: true,
        totalParts: true,
        objectKey: true,
        multipartUploadId: true,
      },
    });

    if (!session) {
      throw new NotFoundException('Multipart upload session not found');
    }

    if (session.status === 'EXPIRED') {
      throw new GoneException('Multipart upload session has expired');
    }

    if (session.status !== 'UPLOADING') {
      throw new ConflictException(
        'Multipart upload session is not accepting parts',
      );
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      await this.prisma.uploadSession.updateMany({
        where: {
          id: session.id,
          ownerId,
          status: 'UPLOADING',
        },
        data: {
          status: 'EXPIRED',
        },
      });

      throw new GoneException('Multipart upload session has expired');
    }

    if (
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > session.totalParts
    ) {
      throw new BadRequestException(
        `Part number must be between 1 and ${session.totalParts}`,
      );
    }

    if (!session.multipartUploadId) {
      throw new InternalServerErrorException(
        'Multipart upload session metadata is incomplete',
      );
    }

    try {
      const url = await this.objectStorage.createPresignedUploadPartUrl({
        objectKey: session.objectKey,
        uploadId: session.multipartUploadId,
        partNumber,
        expiresInSeconds: MULTIPART_PART_URL_TTL_SECONDS,
      });

      return {
        partNumber,
        url,
        expiresAt: new Date(Date.now() + MULTIPART_PART_URL_TTL_SECONDS * 1000),
      };
    } catch {
      throw new ServiceUnavailableException(
        'Object storage is temporarily unavailable',
      );
    }
  }

  async getMultipartUploadStatus(
    ownerId: string,
    uploadSessionId: string,
  ): Promise<MultipartUploadStatusResponseDto> {
    const session = await this.prisma.uploadSession.findFirst({
      where: {
        id: uploadSessionId,
        ownerId,
      },
      select: {
        ...MULTIPART_SESSION_SELECT,
        multipartUploadId: true,
      },
    });

    if (!session) {
      throw new NotFoundException('Multipart upload session not found');
    }

    let responseSession: MultipartStatusSessionRecord = session;
    let uploadedParts: MultipartUploadedPartResponseDto[];

    if (
      session.status === 'UPLOADING' &&
      session.expiresAt.getTime() <= Date.now()
    ) {
      await this.prisma.uploadSession.updateMany({
        where: {
          id: session.id,
          ownerId,
          status: 'UPLOADING',
        },
        data: {
          status: 'EXPIRED',
        },
      });

      responseSession = {
        ...session,
        status: 'EXPIRED',
      };

      const storedParts = await this.getStoredMultipartParts(session.id);
      uploadedParts = this.toStoredMultipartPartResponseDtos(storedParts);
    } else if (session.status === 'UPLOADING') {
      if (!session.multipartUploadId) {
        throw new InternalServerErrorException(
          'Multipart upload session metadata is incomplete',
        );
      }

      let storageParts: MultipartUploadPart[];

      try {
        storageParts = await this.objectStorage.listMultipartUploadParts({
          objectKey: session.objectKey,
          uploadId: session.multipartUploadId,
        });
      } catch {
        throw new ServiceUnavailableException(
          'Object storage is temporarily unavailable',
        );
      }

      const normalizedParts = this.normalizeMultipartParts(
        storageParts,
        session.totalParts,
      );

      await this.replaceStoredMultipartParts(session.id, normalizedParts);

      uploadedParts = normalizedParts.map((part) => ({
        partNumber: part.partNumber,
        etag: part.etag,
        size: part.size.toString(),
      }));
    } else {
      const storedParts = await this.getStoredMultipartParts(session.id);
      uploadedParts = this.toStoredMultipartPartResponseDtos(storedParts);
    }

    return {
      ...this.toMultipartUploadSessionResponseDto(responseSession),
      uploadedParts,
    };
  }

  async completeMultipartUpload(
    ownerId: string,
    uploadSessionId: string,
  ): Promise<FileResponseDto> {
    const session = await this.prisma.uploadSession.findFirst({
      where: {
        id: uploadSessionId,
        ownerId,
      },
      select: {
        id: true,
        folderId: true,
        fileId: true,
        originalName: true,
        mimeType: true,
        totalSize: true,
        partSize: true,
        totalParts: true,
        objectKey: true,
        multipartUploadId: true,
        status: true,
        expiresAt: true,
        updatedAt: true,
      },
    });

    if (!session) {
      throw new NotFoundException('Multipart upload session not found');
    }

    const resourceOwnerId = await this.resolveMultipartResourceOwnerId(
      ownerId,
      session.fileId,
      session.folderId,
    );

    if (session.status === 'COMPLETED') {
      if (!session.fileId) {
        throw new InternalServerErrorException(
          'Completed multipart upload has no file metadata',
        );
      }

      return this.getCompletedMultipartFile(session.fileId);
    }

    if (session.status === 'EXPIRED') {
      throw new GoneException('Multipart upload session has expired');
    }

    if (
      session.status === 'UPLOADING' &&
      session.expiresAt.getTime() <= Date.now()
    ) {
      await this.prisma.uploadSession.updateMany({
        where: {
          id: session.id,
          ownerId,
          status: 'UPLOADING',
        },
        data: {
          status: 'EXPIRED',
        },
      });

      throw new GoneException('Multipart upload session has expired');
    }

    if (
      session.status === 'COMPLETING' &&
      Date.now() - session.updatedAt.getTime() <
        MULTIPART_COMPLETION_RECOVERY_DELAY_MS
    ) {
      throw new ConflictException(
        'Multipart upload completion is already in progress',
      );
    }

    if (session.status !== 'UPLOADING' && session.status !== 'COMPLETING') {
      throw new ConflictException(
        'Multipart upload session cannot be completed',
      );
    }

    if (!session.multipartUploadId) {
      throw new InternalServerErrorException(
        'Multipart upload session metadata is incomplete',
      );
    }

    if (session.status === 'UPLOADING') {
      const claimedSession = await this.prisma.uploadSession.updateMany({
        where: {
          id: session.id,
          ownerId,
          status: 'UPLOADING',
        },
        data: {
          status: 'COMPLETING',
        },
      });

      if (claimedSession.count === 0) {
        const currentSession = await this.prisma.uploadSession.findFirst({
          where: {
            id: session.id,
            ownerId,
          },
          select: {
            status: true,
            fileId: true,
          },
        });

        if (currentSession?.status === 'COMPLETED' && currentSession.fileId) {
          return this.getCompletedMultipartFile(currentSession.fileId);
        }

        throw new ConflictException(
          'Multipart upload completion is already in progress',
        );
      }
    }

    const existingObject = await this.getMultipartObjectMetadata(
      session.objectKey,
    );

    if (existingObject) {
      this.ensureCompletedObjectSize(existingObject.size, session.totalSize);

      return this.finalizeMultipartUploadMetadata({
        actorUserId: ownerId,
        resourceOwnerId,
        uploadSessionId: session.id,
        folderId: session.folderId,
        objectKey: session.objectKey,
        originalName: session.originalName,
        mimeType: session.mimeType,
        totalSize: session.totalSize,
      });
    }

    let storageParts: MultipartUploadPart[];

    try {
      storageParts = await this.objectStorage.listMultipartUploadParts({
        objectKey: session.objectKey,
        uploadId: session.multipartUploadId,
      });
    } catch {
      throw new ServiceUnavailableException(
        'Object storage is temporarily unavailable',
      );
    }

    const normalizedParts = this.normalizeMultipartParts(
      storageParts,
      session.totalParts,
    );

    if (
      !this.isCompleteMultipartPartSet(
        normalizedParts,
        session.totalSize,
        session.partSize,
        session.totalParts,
      )
    ) {
      await this.returnMultipartSessionToUploading(session.id);

      throw new ConflictException(
        'Not all multipart upload parts have been uploaded',
      );
    }

    await this.replaceStoredMultipartParts(session.id, normalizedParts);

    try {
      await this.objectStorage.completeMultipartUpload({
        objectKey: session.objectKey,
        uploadId: session.multipartUploadId,
        parts: normalizedParts.map((part) => ({
          partNumber: part.partNumber,
          etag: part.etag,
        })),
      });
    } catch {
      throw new ServiceUnavailableException(
        'Object storage is temporarily unavailable',
      );
    }

    const completedObject = await this.getMultipartObjectMetadata(
      session.objectKey,
    );

    if (!completedObject) {
      throw new ServiceUnavailableException(
        'Completed object is temporarily unavailable',
      );
    }

    this.ensureCompletedObjectSize(completedObject.size, session.totalSize);

    return this.finalizeMultipartUploadMetadata({
      actorUserId: ownerId,
      resourceOwnerId,
      uploadSessionId: session.id,
      folderId: session.folderId,
      objectKey: session.objectKey,
      originalName: session.originalName,
      mimeType: session.mimeType,
      totalSize: session.totalSize,
    });
  }

  async retryProcessing(
    userId: string,
    fileId: string,
  ): Promise<FileResponseDto> {
    await this.accessService.requireFileRole(userId, fileId, 'EDITOR');

    const retriedFile = await this.prisma.$transaction(async (transaction) => {
      const file = await transaction.file.findFirst({
        where: {
          id: fileId,
          status: 'FAILED',
          deletedAt: null,
        },
        select: {
          id: true,
          currentVersionId: true,
          currentVersion: {
            select: {
              id: true,
              storedObjectId: true,
            },
          },
        },
      });

      if (!file) {
        throw new ConflictException('Only a failed file can be reprocessed');
      }

      if (!file.currentVersionId || !file.currentVersion) {
        throw new InternalServerErrorException('File metadata is incomplete');
      }

      const updatedFile = await transaction.file.update({
        where: {
          id: file.id,
        },
        data: {
          status: 'PROCESSING',
        },
        select: FILE_SELECT,
      });

      await transaction.outboxEvent.create({
        data: {
          type: PROCESS_FILE_OUTBOX_EVENT_TYPE,
          aggregateId: file.id,
          payload: {
            fileId: file.id,
            versionId: file.currentVersion.id,
            storedObjectId: file.currentVersion.storedObjectId,
          },
        },
      });

      return updatedFile;
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'FILE_PROCESSING_RETRY',
      resourceType: 'FILE',
      resourceId: fileId,
    });

    return this.toResponseDto(retriedFile);
  }

  async abortMultipartUpload(
    ownerId: string,
    uploadSessionId: string,
  ): Promise<void> {
    const session = await this.prisma.uploadSession.findFirst({
      where: {
        id: uploadSessionId,
        ownerId,
      },
      select: {
        id: true,
        status: true,
        objectKey: true,
        multipartUploadId: true,
        updatedAt: true,
      },
    });

    if (!session) {
      throw new NotFoundException('Multipart upload session not found');
    }

    if (session.status === 'ABORTED') {
      return;
    }

    if (session.status === 'COMPLETED') {
      throw new ConflictException(
        'Completed multipart upload cannot be aborted',
      );
    }

    if (session.status === 'COMPLETING') {
      throw new ConflictException(
        'Multipart upload completion is already in progress',
      );
    }

    if (session.status === 'ABORTING') {
      if (
        Date.now() - session.updatedAt.getTime() <
        MULTIPART_ABORT_RECOVERY_DELAY_MS
      ) {
        throw new ConflictException(
          'Multipart upload cancellation is already in progress',
        );
      }

      const recoveredClaim = await this.prisma.uploadSession.updateMany({
        where: {
          id: session.id,
          ownerId,
          status: 'ABORTING',
          updatedAt: session.updatedAt,
        },
        data: {
          updatedAt: new Date(),
        },
      });

      if (recoveredClaim.count === 0) {
        throw new ConflictException(
          'Multipart upload cancellation is already in progress',
        );
      }
    } else {
      const abortableStatuses = [
        'CREATED',
        'UPLOADING',
        'EXPIRED',
        'FAILED',
      ] as const;

      if (!abortableStatuses.includes(session.status)) {
        throw new ConflictException(
          'Multipart upload session cannot be aborted',
        );
      }

      const claimedSession = await this.prisma.uploadSession.updateMany({
        where: {
          id: session.id,
          ownerId,
          status: session.status,
        },
        data: {
          status: 'ABORTING',
        },
      });

      if (claimedSession.count === 0) {
        const currentSession = await this.prisma.uploadSession.findFirst({
          where: {
            id: session.id,
            ownerId,
          },
          select: {
            status: true,
          },
        });

        if (currentSession?.status === 'ABORTED') {
          return;
        }

        throw new ConflictException(
          'Multipart upload session state has changed',
        );
      }
    }

    if (session.multipartUploadId) {
      try {
        await this.objectStorage.abortMultipartUpload({
          objectKey: session.objectKey,
          uploadId: session.multipartUploadId,
        });
      } catch {
        throw new ServiceUnavailableException(
          'Object storage is temporarily unavailable',
        );
      }
    }

    await this.prisma.uploadSession.updateMany({
      where: {
        id: session.id,
        ownerId,
        status: 'ABORTING',
      },
      data: {
        status: 'ABORTED',
      },
    });
  }

  async list(userId: string, folderId?: string): Promise<FileResponseDto[]> {
    if (folderId) {
      await this.accessService.requireFolderRole(userId, folderId, 'VIEWER');

      const files = await this.prisma.file.findMany({
        where: {
          folderId,
          status: {
            in: ['PROCESSING', 'READY', 'FAILED'],
          },
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

    const files = await this.prisma.file.findMany({
      where: {
        ownerId: userId,
        folderId: null,
        status: {
          in: ['PROCESSING', 'READY', 'FAILED'],
        },
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

  async listVersions(
    userId: string,
    fileId: string,
  ): Promise<FileVersionResponseDto[]> {
    await this.accessService.requireFileRole(userId, fileId, 'VIEWER');

    const file = await this.prisma.file.findFirst({
      where: {
        id: fileId,
        status: {
          in: ['PROCESSING', 'READY', 'FAILED'],
        },
        deletedAt: null,
      },
      select: {
        currentVersionId: true,
        versions: {
          orderBy: {
            versionNumber: 'desc',
          },
          select: {
            id: true,
            versionNumber: true,
            originalName: true,
            mimeType: true,
            size: true,
            createdAt: true,
          },
        },
      },
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    return file.versions.map((version) => ({
      id: version.id,
      versionNumber: version.versionNumber,
      originalName: version.originalName,
      mimeType: version.mimeType,
      size: version.size.toString(),
      createdAt: version.createdAt,
      isCurrent: version.id === file.currentVersionId,
    }));
  }

  async createVersionDownloadUrl(
    userId: string,
    fileId: string,
    versionId: string,
  ): Promise<DownloadFileResponseDto> {
    await this.accessService.requireFileRole(userId, fileId, 'VIEWER');

    const version = await this.prisma.fileVersion.findFirst({
      where: {
        id: versionId,
        fileId,
        file: {
          deletedAt: null,
        },
      },
      select: {
        originalName: true,
        mimeType: true,
        storedObject: {
          select: {
            objectKey: true,
          },
        },
      },
    });

    if (!version) {
      throw new NotFoundException('File version not found');
    }

    const expiresInSeconds = 10 * 60;

    const url = await this.objectStorage.createPresignedDownloadUrl({
      objectKey: version.storedObject.objectKey,
      downloadFileName: version.originalName,
      contentType: version.mimeType ?? undefined,
      expiresInSeconds,
    });

    return {
      url,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    };
  }

  async restoreVersion(
    userId: string,
    fileId: string,
    versionId: string,
  ): Promise<FileResponseDto> {
    await this.accessService.requireFileRole(userId, fileId, 'EDITOR');

    const restoredFile = await this.prisma.$transaction(async (transaction) => {
      /*
       * Блокируем logical File, чтобы одновременно
       * не вычислить одинаковый versionNumber.
       */
      const lockedFiles = await transaction.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM "File"
            WHERE "id" = ${fileId}::uuid
              AND "deletedAt" IS NULL
            FOR UPDATE
          `;

      if (lockedFiles.length === 0) {
        throw new NotFoundException('File not found');
      }

      const currentFile = await transaction.file.findUnique({
        where: {
          id: fileId,
        },
        select: {
          status: true,
          currentVersionId: true,
          versions: {
            orderBy: {
              versionNumber: 'desc',
            },
            take: 1,
            select: {
              versionNumber: true,
            },
          },
        },
      });

      if (!currentFile) {
        throw new NotFoundException('File not found');
      }

      if (currentFile.status !== 'READY') {
        throw new ConflictException('File is not ready to restore a version');
      }

      /*
       * Текущую версию восстанавливать бессмысленно.
       */
      if (currentFile.currentVersionId === versionId) {
        throw new ConflictException('Selected version is already current');
      }

      /*
       * Source version обязательно должна
       * принадлежать этому logical File.
       */
      const sourceVersion = await transaction.fileVersion.findFirst({
        where: {
          id: versionId,
          fileId,
        },
        select: {
          storedObjectId: true,
          originalName: true,
          mimeType: true,
          size: true,
        },
      });

      if (!sourceVersion) {
        throw new NotFoundException('File version not found');
      }

      const nextVersionNumber =
        (currentFile.versions[0]?.versionNumber ?? 0) + 1;

      /*
       * Restore не копирует physical object.
       * Новая версия ссылается на тот же
       * StoredObject.
       */
      await transaction.storedObject.update({
        where: {
          id: sourceVersion.storedObjectId,
        },
        data: {
          referenceCount: {
            increment: 1,
          },
        },
      });

      const restoredVersion = await transaction.fileVersion.create({
        data: {
          fileId,
          storedObjectId: sourceVersion.storedObjectId,
          versionNumber: nextVersionNumber,
          originalName: sourceVersion.originalName,
          mimeType: sourceVersion.mimeType,
          size: sourceVersion.size,

          /*
           * Preview намеренно не копируем.
           * Worker создаст новый preview
           * для новой immutable версии.
           */
        },
        select: {
          id: true,
        },
      });

      const processingFile = await transaction.file.update({
        where: {
          id: fileId,
        },
        data: {
          currentVersionId: restoredVersion.id,
          status: 'PROCESSING',
        },
        select: FILE_SELECT,
      });

      await transaction.outboxEvent.create({
        data: {
          type: PROCESS_FILE_OUTBOX_EVENT_TYPE,
          aggregateId: fileId,
          payload: {
            fileId,
            versionId: restoredVersion.id,
            storedObjectId: sourceVersion.storedObjectId,
          },
        },
      });

      return processingFile;
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'FILE_VERSION_RESTORE',
      resourceType: 'FILE',
      resourceId: fileId,
      metadata: {
        sourceVersionId: versionId,
      },
    });

    return this.toResponseDto(restoredFile);
  }

  async createDownloadUrl(
    userId: string,
    fileId: string,
  ): Promise<DownloadFileResponseDto> {
    await this.accessService.requireFileRole(userId, fileId, 'VIEWER');

    const file = await this.prisma.file.findFirst({
      where: {
        id: fileId,
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

  async createPreviewUrl(
    userId: string,
    fileId: string,
  ): Promise<PreviewFileResponseDto> {
    await this.accessService.requireFileRole(userId, fileId, 'VIEWER');

    const file = await this.prisma.file.findFirst({
      where: {
        id: fileId,
        status: 'READY',
        deletedAt: null,
      },
      select: {
        currentVersion: {
          select: {
            previewObjectKey: true,
            previewMimeType: true,
            previewWidth: true,
            previewHeight: true,
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

    const { previewObjectKey, previewMimeType, previewWidth, previewHeight } =
      file.currentVersion;

    if (
      !previewObjectKey ||
      !previewMimeType ||
      previewWidth === null ||
      previewHeight === null
    ) {
      throw new NotFoundException('File preview not found');
    }

    const expiresInSeconds = 10 * 60;

    const url = await this.objectStorage.createPresignedDownloadUrl({
      objectKey: previewObjectKey,
      downloadFileName: 'preview.webp',
      contentType: previewMimeType,
      expiresInSeconds,
      contentDisposition: 'inline',
    });

    return {
      url,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
      mimeType: previewMimeType,
      width: previewWidth,
      height: previewHeight,
    };
  }

  async rename(
    userId: string,
    fileId: string,
    dto: RenameFileDto,
  ): Promise<FileResponseDto> {
    await this.accessService.requireFileRole(userId, fileId, 'EDITOR');

    const file = await this.prisma.file.findFirst({
      where: {
        id: fileId,
        status: {
          in: ['PROCESSING', 'READY', 'FAILED'],
        },
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
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

    await this.auditService.write({
      actorUserId: userId,
      action: 'FILE_RENAME',
      resourceType: 'FILE',
      resourceId: file.id,
      metadata: {
        oldName: file.name,
        newName: updatedFile.name,
      },
    });

    return this.toResponseDto(updatedFile);
  }

  async move(
    userId: string,
    fileId: string,
    dto: MoveFileDto,
  ): Promise<FileResponseDto> {
    await this.accessService.requireFileRole(userId, fileId, 'EDITOR');

    const file = await this.prisma.file.findFirst({
      where: {
        id: fileId,
        status: 'READY',
        deletedAt: null,
      },
      select: {
        id: true,
        ownerId: true,
      },
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    /*
     * В root чужой File может вынести
     * только его владелец.
     */
    if (dto.folderId === null) {
      if (file.ownerId !== userId) {
        throw new ForbiddenException('Only the owner can move a file to root');
      }

      const movedFile = await this.prisma.file.update({
        where: {
          id: file.id,
        },
        data: {
          folderId: null,
        },
        select: FILE_SELECT,
      });

      await this.auditService.write({
        actorUserId: userId,
        action: 'FILE_MOVE',
        resourceType: 'FILE',
        resourceId: file.id,
        metadata: {
          destinationFolderId: null,
        },
      });

      return this.toResponseDto(movedFile);
    }

    /*
     * Для destination требуется EDITOR.
     */
    await this.accessService.requireFolderRole(userId, dto.folderId, 'EDITOR');

    const destinationFolder = await this.prisma.folder.findUnique({
      where: {
        id: dto.folderId,
      },
      select: {
        ownerId: true,
      },
    });

    if (!destinationFolder) {
      throw new NotFoundException('Destination folder not found');
    }

    /*
     * Файл нельзя перенести из пространства
     * одного владельца в пространство другого.
     */
    if (destinationFolder.ownerId !== file.ownerId) {
      throw new BadRequestException(
        'File and destination folder must have the same owner',
      );
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

    await this.auditService.write({
      actorUserId: userId,
      action: 'FILE_MOVE',
      resourceType: 'FILE',
      resourceId: file.id,
      metadata: {
        destinationFolderId: dto.folderId,
      },
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
        versions: {
          select: {
            previewObjectKey: true,
            storedObject: {
              select: {
                id: true,
                objectKey: true,
                referenceCount: true,
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

    if (file.versions.length === 0) {
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

    const previewObjectKeys = [
      ...new Set(
        file.versions
          .map((version) => version.previewObjectKey)
          .filter((objectKey): objectKey is string => objectKey !== null),
      ),
    ];

    for (const previewObjectKey of previewObjectKeys) {
      try {
        await this.objectStorage.deleteObject(previewObjectKey);
      } catch {
        throw new ServiceUnavailableException(
          'Object storage is temporarily unavailable',
        );
      }
    }

    const storedObjects = new Map<
      string,
      {
        id: string;
        objectKey: string;
        referenceCount: number;
        totalVersionReferences: number;
        fileVersionReferences: number;
      }
    >();

    for (const version of file.versions) {
      const storedObject = version.storedObject;

      const existing = storedObjects.get(storedObject.id);

      if (existing) {
        existing.fileVersionReferences += 1;
        continue;
      }

      storedObjects.set(storedObject.id, {
        id: storedObject.id,
        objectKey: storedObject.objectKey,
        referenceCount: storedObject.referenceCount,
        totalVersionReferences: storedObject._count.versions,
        fileVersionReferences: 1,
      });
    }

    for (const storedObject of storedObjects.values()) {
      const shouldDeleteStoredObject =
        storedObject.totalVersionReferences ===
        storedObject.fileVersionReferences;

      if (!shouldDeleteStoredObject) {
        continue;
      }

      try {
        await this.objectStorage.deleteObject(storedObject.objectKey);
      } catch {
        throw new ServiceUnavailableException(
          'Object storage is temporarily unavailable',
        );
      }
    }

    let fileDeleted = false;

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

      fileDeleted = true;

      for (const storedObject of storedObjects.values()) {
        const shouldDeleteStoredObject =
          storedObject.totalVersionReferences ===
          storedObject.fileVersionReferences;

        if (shouldDeleteStoredObject) {
          await transaction.storedObject.deleteMany({
            where: {
              id: storedObject.id,
              versions: {
                none: {},
              },
            },
          });

          continue;
        }

        await transaction.storedObject.update({
          where: {
            id: storedObject.id,
          },
          data: {
            referenceCount: {
              decrement: storedObject.fileVersionReferences,
            },
          },
        });
      }
    });

    if (fileDeleted) {
      await this.auditService.write({
        actorUserId: ownerId,
        action: 'FILE_DELETE',
        resourceType: 'FILE',
        resourceId: fileId,
      });
    }
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

  private normalizeMultipartParts(
    parts: MultipartUploadPart[],
    totalParts: number,
  ): MultipartUploadPart[] {
    const normalizedParts = [...parts].sort(
      (left, right) => left.partNumber - right.partNumber,
    );

    for (const part of normalizedParts) {
      if (
        !Number.isInteger(part.partNumber) ||
        part.partNumber < 1 ||
        part.partNumber > totalParts ||
        !Number.isSafeInteger(part.size) ||
        part.size < 0 ||
        !part.etag
      ) {
        throw new InternalServerErrorException(
          'Object storage returned invalid multipart part metadata',
        );
      }
    }

    return normalizedParts;
  }

  private async replaceStoredMultipartParts(
    uploadSessionId: string,
    parts: MultipartUploadPart[],
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.uploadPart.deleteMany({
        where: {
          uploadSessionId,
        },
      });

      if (parts.length === 0) {
        return;
      }

      await transaction.uploadPart.createMany({
        data: parts.map((part) => ({
          uploadSessionId,
          partNumber: part.partNumber,
          etag: part.etag,
          size: BigInt(part.size),
        })),
      });
    });
  }

  private getStoredMultipartParts(
    uploadSessionId: string,
  ): Promise<StoredMultipartPartRecord[]> {
    return this.prisma.uploadPart.findMany({
      where: {
        uploadSessionId,
      },
      orderBy: {
        partNumber: 'asc',
      },
      select: {
        partNumber: true,
        etag: true,
        size: true,
      },
    });
  }

  private toStoredMultipartPartResponseDtos(
    parts: StoredMultipartPartRecord[],
  ): MultipartUploadedPartResponseDto[] {
    return parts.map((part) => ({
      partNumber: part.partNumber,
      etag: part.etag,
      size: part.size.toString(),
    }));
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

  private async resolveMultipartResourceOwnerId(
    userId: string,
    fileId: string | null,
    folderId: string | null,
  ): Promise<string> {
    if (fileId) {
      await this.accessService.requireFileRole(userId, fileId, 'EDITOR');

      const file = await this.prisma.file.findFirst({
        where: {
          id: fileId,
          deletedAt: null,
        },
        select: {
          ownerId: true,
        },
      });

      if (!file) {
        throw new NotFoundException('File not found');
      }

      return file.ownerId;
    }

    if (folderId) {
      await this.accessService.requireFolderRole(userId, folderId, 'EDITOR');

      const folder = await this.prisma.folder.findUnique({
        where: {
          id: folderId,
        },
        select: {
          ownerId: true,
        },
      });

      if (!folder) {
        throw new NotFoundException('Folder not found');
      }

      return folder.ownerId;
    }

    /*
     * Multipart в собственный root.
     */
    return userId;
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

  private async getMultipartObjectMetadata(
    objectKey: string,
  ): Promise<{ size: number } | null> {
    try {
      return await this.objectStorage.getObjectMetadata(objectKey);
    } catch {
      throw new ServiceUnavailableException(
        'Object storage is temporarily unavailable',
      );
    }
  }

  private ensureCompletedObjectSize(
    actualSize: number,
    expectedSize: bigint,
  ): void {
    if (
      !Number.isSafeInteger(actualSize) ||
      actualSize < 0 ||
      BigInt(actualSize) !== expectedSize
    ) {
      throw new InternalServerErrorException(
        'Completed object size does not match upload metadata',
      );
    }
  }

  private isCompleteMultipartPartSet(
    parts: MultipartUploadPart[],
    totalSize: bigint,
    partSize: bigint,
    totalParts: number,
  ): boolean {
    if (parts.length !== totalParts) {
      return false;
    }

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const expectedPartNumber = index + 1;

      if (!part || part.partNumber !== expectedPartNumber) {
        return false;
      }

      const expectedSize =
        expectedPartNumber === totalParts
          ? totalSize - partSize * BigInt(totalParts - 1)
          : partSize;

      if (BigInt(part.size) !== expectedSize) {
        return false;
      }
    }

    return true;
  }

  private async returnMultipartSessionToUploading(
    uploadSessionId: string,
  ): Promise<void> {
    await this.prisma.uploadSession.updateMany({
      where: {
        id: uploadSessionId,
        status: 'COMPLETING',
      },
      data: {
        status: 'UPLOADING',
      },
    });
  }

  private async getCompletedMultipartFile(
    fileId: string,
  ): Promise<FileResponseDto> {
    const file = await this.prisma.file.findFirst({
      where: {
        id: fileId,
        status: {
          in: ['PROCESSING', 'READY', 'FAILED'],
        },
        deletedAt: null,
      },
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
            id: true,
            storedObjectId: true,
            mimeType: true,
            size: true,
          },
        },
      },
    });

    if (!file) {
      throw new InternalServerErrorException(
        'Completed multipart file metadata is missing',
      );
    }

    if (!file.currentVersion) {
      throw new InternalServerErrorException(
        'Completed multipart file version is missing',
      );
    }

    return this.toResponseDto(file);
  }

  private async finalizeMultipartUploadMetadata(
    input: FinalizeMultipartUploadInput,
  ): Promise<FileResponseDto> {
    const fileId = await this.prisma.$transaction(async (transaction) => {
      const lockedSessions = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "UploadSession"
        WHERE "id" = ${input.uploadSessionId}::uuid
        FOR UPDATE
      `;

      if (lockedSessions.length === 0) {
        throw new NotFoundException('Multipart upload session not found');
      }

      const lockedSession = await transaction.uploadSession.findUnique({
        where: {
          id: input.uploadSessionId,
        },
        select: {
          status: true,
          fileId: true,
        },
      });

      if (!lockedSession) {
        throw new NotFoundException('Multipart upload session not found');
      }

      if (lockedSession.status === 'COMPLETED') {
        if (!lockedSession.fileId) {
          throw new InternalServerErrorException(
            'Completed multipart upload has no file metadata',
          );
        }

        return lockedSession.fileId;
      }

      if (lockedSession.status !== 'COMPLETING') {
        throw new ConflictException(
          'Multipart upload session cannot be finalized',
        );
      }

      /*
       * If fileId is already present before completion, this session belongs
       * to a new version of an existing logical file.
       */
      if (lockedSession.fileId) {
        const targetFileId = lockedSession.fileId;

        const lockedFiles = await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "File"
          WHERE "id" = ${targetFileId}::uuid
            AND "ownerId" = ${input.resourceOwnerId}::uuid
            AND "deletedAt" IS NULL
          FOR UPDATE
        `;

        if (lockedFiles.length === 0) {
          throw new NotFoundException('File not found');
        }

        const targetFile = await transaction.file.findUnique({
          where: {
            id: targetFileId,
          },
          select: {
            status: true,
            versions: {
              orderBy: {
                versionNumber: 'desc',
              },
              take: 1,
              select: {
                versionNumber: true,
              },
            },
          },
        });

        if (!targetFile) {
          throw new NotFoundException('File not found');
        }

        if (targetFile.status !== 'READY') {
          throw new ConflictException(
            'File is not ready to accept a new version',
          );
        }

        const nextVersionNumber =
          (targetFile.versions[0]?.versionNumber ?? 0) + 1;

        const storedObject = await transaction.storedObject.create({
          data: {
            objectKey: input.objectKey,
            size: input.totalSize,
            referenceCount: 1,
          },
          select: {
            id: true,
          },
        });

        const version = await transaction.fileVersion.create({
          data: {
            fileId: targetFileId,
            storedObjectId: storedObject.id,
            versionNumber: nextVersionNumber,
            originalName: input.originalName,
            mimeType: input.mimeType,
            size: input.totalSize,
          },
          select: {
            id: true,
          },
        });

        await transaction.file.update({
          where: {
            id: targetFileId,
          },
          data: {
            currentVersionId: version.id,
            status: 'PROCESSING',
          },
        });

        await transaction.uploadSession.update({
          where: {
            id: input.uploadSessionId,
          },
          data: {
            status: 'COMPLETED',
          },
        });

        await transaction.outboxEvent.create({
          data: {
            type: PROCESS_FILE_OUTBOX_EVENT_TYPE,
            aggregateId: targetFileId,
            payload: {
              fileId: targetFileId,
              versionId: version.id,
              storedObjectId: storedObject.id,
            },
          },
        });

        await this.auditService.write(
          {
            actorUserId: input.actorUserId,
            action: 'FILE_VERSION_UPLOAD',
            resourceType: 'FILE',
            resourceId: targetFileId,
            metadata: {
              multipart: true,
              versionId: version.id,
              versionNumber: nextVersionNumber,
              name: input.originalName,
              size: input.totalSize.toString(),
            },
          },
          transaction,
        );

        return targetFileId;
      }

      /*
       * Ordinary multipart upload: create a brand-new logical File.
       */
      const fileMetadata = await transaction.file.create({
        data: {
          name: input.originalName,
          ownerId: input.resourceOwnerId,
          folderId: input.folderId,
          status: 'UPLOADING',
        },
        select: {
          id: true,
        },
      });

      const storedObject = await transaction.storedObject.create({
        data: {
          objectKey: input.objectKey,
          size: input.totalSize,
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
          originalName: input.originalName,
          mimeType: input.mimeType,
          size: input.totalSize,
        },
        select: {
          id: true,
        },
      });

      await transaction.file.update({
        where: {
          id: fileMetadata.id,
        },
        data: {
          currentVersionId: version.id,
          status: 'PROCESSING',
        },
      });

      await transaction.uploadSession.update({
        where: {
          id: input.uploadSessionId,
        },
        data: {
          fileId: fileMetadata.id,
          status: 'COMPLETED',
        },
      });

      await transaction.outboxEvent.create({
        data: {
          type: PROCESS_FILE_OUTBOX_EVENT_TYPE,
          aggregateId: fileMetadata.id,
          payload: {
            fileId: fileMetadata.id,
            versionId: version.id,
            storedObjectId: storedObject.id,
          },
        },
      });

      await this.auditService.write(
        {
          actorUserId: input.actorUserId,
          action: 'FILE_UPLOAD',
          resourceType: 'FILE',
          resourceId: fileMetadata.id,
          metadata: {
            multipart: true,
            name: input.originalName,
            folderId: input.folderId,
            size: input.totalSize.toString(),
          },
        },
        transaction,
      );

      return fileMetadata.id;
    });

    return this.getCompletedMultipartFile(fileId);
  }
}
