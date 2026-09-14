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
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import {
  OBJECT_STORAGE,
  type MultipartUploadPart,
  type ObjectStorage,
} from '../storage/object-storage.interface';
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
import { FileProcessingQueueService } from '../queue/file-processing-queue.service';
import type { ProcessFileJob } from '../queue/file-processing.constants';

const SIMPLE_UPLOAD_MAX_SIZE_BYTES = 10n * 1024n * 1024n;
const MULTIPART_UPLOAD_PART_SIZE_BYTES = 8n * 1024n * 1024n;
const MULTIPART_UPLOAD_MAX_SIZE_BYTES = 5n * 1024n * 1024n * 1024n;
const MULTIPART_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MULTIPART_PARTS = 10_000;
const MULTIPART_PART_URL_TTL_SECONDS = 15 * 60;
const MULTIPART_COMPLETION_RECOVERY_DELAY_MS = 30 * 1000;
const MULTIPART_ABORT_RECOVERY_DELAY_MS = 30 * 1000;

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
  ownerId: string;
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
    @Inject(OBJECT_STORAGE)
    private readonly objectStorage: ObjectStorage,
    private readonly fileProcessingQueue: FileProcessingQueueService,
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

    let created: {
      file: FileRecord;
      job: ProcessFileJob;
    };

    try {
      created = await this.prisma.$transaction(async (transaction) => {
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

        return {
          file: processingFile,
          job: {
            fileId: fileMetadata.id,
            versionId: version.id,
            storedObjectId: storedObject.id,
          },
        };
      });
    } catch (error: unknown) {
      await this.removeOrphanedObject(objectKey);
      throw error;
    }

    await this.fileProcessingQueue.enqueue(created.job);

    return this.toResponseDto(created.file);
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

    if (session.status === 'COMPLETED') {
      if (!session.fileId) {
        throw new InternalServerErrorException(
          'Completed multipart upload has no file metadata',
        );
      }

      return this.getCompletedMultipartFile(ownerId, session.fileId);
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
          return this.getCompletedMultipartFile(ownerId, currentSession.fileId);
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
        ownerId,
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
      ownerId,
      uploadSessionId: session.id,
      folderId: session.folderId,
      objectKey: session.objectKey,
      originalName: session.originalName,
      mimeType: session.mimeType,
      totalSize: session.totalSize,
    });
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
        fileId: null,
      },
      data: {
        status: 'UPLOADING',
      },
    });
  }

  private async getCompletedMultipartFile(
    ownerId: string,
    fileId: string,
  ): Promise<FileResponseDto> {
    const file = await this.prisma.file.findFirst({
      where: {
        id: fileId,
        ownerId,
        status: 'READY',
        deletedAt: null,
      },
      select: FILE_SELECT,
    });

    if (!file) {
      throw new InternalServerErrorException(
        'Completed multipart file metadata is missing',
      );
    }

    return this.toResponseDto(file);
  }

  private async finalizeMultipartUploadMetadata(
    input: FinalizeMultipartUploadInput,
  ): Promise<FileResponseDto> {
    return this.prisma.$transaction(async (transaction) => {
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

        const completedFile = await transaction.file.findFirst({
          where: {
            id: lockedSession.fileId,
            ownerId: input.ownerId,
            status: 'READY',
            deletedAt: null,
          },
          select: FILE_SELECT,
        });

        if (!completedFile) {
          throw new InternalServerErrorException(
            'Completed multipart file metadata is missing',
          );
        }

        return this.toResponseDto(completedFile);
      }

      if (lockedSession.status !== 'COMPLETING') {
        throw new ConflictException(
          'Multipart upload session cannot be finalized',
        );
      }

      const fileMetadata = await transaction.file.create({
        data: {
          name: input.originalName,
          ownerId: input.ownerId,
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

      const completedFile = await transaction.file.update({
        where: {
          id: fileMetadata.id,
        },
        data: {
          currentVersionId: version.id,
          status: 'READY',
        },
        select: FILE_SELECT,
      });

      await transaction.uploadSession.update({
        where: {
          id: input.uploadSessionId,
        },
        data: {
          fileId: completedFile.id,
          status: 'COMPLETED',
        },
      });

      return this.toResponseDto(completedFile);
    });
  }
}
