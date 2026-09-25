import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Inject,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { AccessService } from '../access/access.service';
import { PrismaService } from '../database/prisma.service';
import type { CreatePublicLinkDto } from './dto/create-public-link.dto';
import type {
  CreatedPublicLinkResponseDto,
  PublicLinkResponseDto,
} from './dto/public-link-response.dto';
import type { DownloadFileResponseDto } from '../files/dto/download-file-response.dto';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from '../storage/object-storage.interface';
import type { PublicFileResponseDto } from './dto/public-file-response.dto';
import type { PublicFolderResponseDto } from './dto/public-folder-response.dto';

const PUBLIC_LINK_SELECT = {
  id: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

@Injectable()
export class PublicLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessService: AccessService,
    @Inject(OBJECT_STORAGE)
    private readonly objectStorage: ObjectStorage,
  ) {}

  async createFolderLink(
    userId: string,
    folderId: string,
    dto: CreatePublicLinkDto,
  ): Promise<CreatedPublicLinkResponseDto> {
    await this.accessService.requireFolderRole(userId, folderId, 'OWNER');

    const expiresAt = this.parseExpiresAt(dto.expiresAt);

    const token = this.generateToken();

    const link = await this.prisma.folderPublicLink.create({
      data: {
        folderId,
        tokenHash: this.hashToken(token),
        expiresAt,
      },
      select: PUBLIC_LINK_SELECT,
    });

    return {
      ...link,
      token,
    };
  }

  async listFolderLinks(
    userId: string,
    folderId: string,
  ): Promise<PublicLinkResponseDto[]> {
    await this.accessService.requireFolderRole(userId, folderId, 'OWNER');

    return this.prisma.folderPublicLink.findMany({
      where: {
        folderId,
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: PUBLIC_LINK_SELECT,
    });
  }

  async revokeFolderLink(
    userId: string,
    folderId: string,
    linkId: string,
  ): Promise<void> {
    await this.accessService.requireFolderRole(userId, folderId, 'OWNER');

    const link = await this.prisma.folderPublicLink.findFirst({
      where: {
        id: linkId,
        folderId,
      },
      select: {
        id: true,
        revokedAt: true,
      },
    });

    if (!link) {
      throw new NotFoundException('Public link not found');
    }

    if (link.revokedAt) {
      return;
    }

    await this.prisma.folderPublicLink.update({
      where: {
        id: link.id,
      },
      data: {
        revokedAt: new Date(),
      },
    });
  }

  async createFileLink(
    userId: string,
    fileId: string,
    dto: CreatePublicLinkDto,
  ): Promise<CreatedPublicLinkResponseDto> {
    await this.accessService.requireFileRole(userId, fileId, 'OWNER');

    const expiresAt = this.parseExpiresAt(dto.expiresAt);

    const token = this.generateToken();

    const link = await this.prisma.filePublicLink.create({
      data: {
        fileId,
        tokenHash: this.hashToken(token),
        expiresAt,
      },
      select: PUBLIC_LINK_SELECT,
    });

    return {
      ...link,
      token,
    };
  }

  async listFileLinks(
    userId: string,
    fileId: string,
  ): Promise<PublicLinkResponseDto[]> {
    await this.accessService.requireFileRole(userId, fileId, 'OWNER');

    return this.prisma.filePublicLink.findMany({
      where: {
        fileId,
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: PUBLIC_LINK_SELECT,
    });
  }

  async revokeFileLink(
    userId: string,
    fileId: string,
    linkId: string,
  ): Promise<void> {
    await this.accessService.requireFileRole(userId, fileId, 'OWNER');

    const link = await this.prisma.filePublicLink.findFirst({
      where: {
        id: linkId,
        fileId,
      },
      select: {
        id: true,
        revokedAt: true,
      },
    });

    if (!link) {
      throw new NotFoundException('Public link not found');
    }

    if (link.revokedAt) {
      return;
    }

    await this.prisma.filePublicLink.update({
      where: {
        id: link.id,
      },
      data: {
        revokedAt: new Date(),
      },
    });
  }

  async getPublicFile(token: string): Promise<PublicFileResponseDto> {
    const file = await this.findPublicFile(token);

    return {
      id: file.id,
      name: file.name,
      mimeType: file.currentVersion.mimeType,
      size: file.currentVersion.size.toString(),
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    };
  }

  async createPublicFileDownloadUrl(
    token: string,
  ): Promise<DownloadFileResponseDto> {
    const file = await this.findPublicFile(token);

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

  async getPublicFolderRoot(token: string): Promise<PublicFolderResponseDto> {
    const rootFolderId = await this.getActivePublicFolderRootId(token);

    return this.getPublicFolderContents(rootFolderId, rootFolderId);
  }

  async getPublicFolder(
    token: string,
    folderId: string,
  ): Promise<PublicFolderResponseDto> {
    const rootFolderId = await this.getActivePublicFolderRootId(token);

    const isInside = await this.isFolderInsidePublicRoot(
      folderId,
      rootFolderId,
    );

    if (!isInside) {
      throw new NotFoundException('Public folder not found');
    }

    return this.getPublicFolderContents(rootFolderId, folderId);
  }

  async createPublicFolderFileDownloadUrl(
    token: string,
    fileId: string,
  ): Promise<DownloadFileResponseDto> {
    const rootFolderId = await this.getActivePublicFolderRootId(token);

    const file = await this.prisma.file.findFirst({
      where: {
        id: fileId,
        status: 'READY',
        deletedAt: null,
      },
      select: {
        name: true,
        folderId: true,
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

    if (!file || !file.folderId || !file.currentVersion) {
      throw new NotFoundException('Public file not found');
    }

    const isInside = await this.isFolderInsidePublicRoot(
      file.folderId,
      rootFolderId,
    );

    if (!isInside) {
      throw new NotFoundException('Public file not found');
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

  private generateToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private parseExpiresAt(value?: string | null): Date | null {
    if (!value) {
      return null;
    }

    const expiresAt = new Date(value);

    if (expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException(
        'Public link expiration must be in the future',
      );
    }

    return expiresAt;
  }

  private async findPublicFile(token: string) {
    const tokenHash = this.hashToken(token);
    const now = new Date();

    const link = await this.prisma.filePublicLink.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        OR: [
          {
            expiresAt: null,
          },
          {
            expiresAt: {
              gt: now,
            },
          },
        ],
        file: {
          is: {
            status: 'READY',
            deletedAt: null,
          },
        },
      },
      select: {
        file: {
          select: {
            id: true,
            name: true,
            createdAt: true,
            updatedAt: true,
            currentVersion: {
              select: {
                mimeType: true,
                size: true,
                storedObject: {
                  select: {
                    objectKey: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!link?.file.currentVersion) {
      throw new NotFoundException('Public link not found');
    }

    return {
      ...link.file,
      currentVersion: link.file.currentVersion,
    };
  }

  private async getActivePublicFolderRootId(token: string): Promise<string> {
    const tokenHash = this.hashToken(token);

    const link = await this.prisma.folderPublicLink.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        OR: [
          {
            expiresAt: null,
          },
          {
            expiresAt: {
              gt: new Date(),
            },
          },
        ],
      },
      select: {
        folderId: true,
      },
    });

    if (!link) {
      throw new NotFoundException('Public link not found');
    }

    return link.folderId;
  }

  private async isFolderInsidePublicRoot(
    folderId: string,
    rootFolderId: string,
  ): Promise<boolean> {
    let currentFolderId: string | null = folderId;

    while (currentFolderId !== null) {
      if (currentFolderId === rootFolderId) {
        return true;
      }

      const lookupFolderId: string = currentFolderId;

      const currentFolder = await this.prisma.folder.findUnique({
        where: {
          id: lookupFolderId,
        },
        select: {
          parentId: true,
        },
      });

      if (!currentFolder) {
        return false;
      }

      currentFolderId = currentFolder.parentId;
    }

    return false;
  }

  private async getPublicFolderContents(
    rootFolderId: string,
    folderId: string,
  ): Promise<PublicFolderResponseDto> {
    const folder = await this.prisma.folder.findUnique({
      where: {
        id: folderId,
      },
      select: {
        id: true,
        name: true,
        parentId: true,
      },
    });

    if (!folder) {
      throw new NotFoundException('Public folder not found');
    }

    const childFolders = await this.prisma.folder.findMany({
      where: {
        parentId: folderId,
      },
      orderBy: [
        {
          name: 'asc',
        },
        {
          createdAt: 'asc',
        },
      ],
      select: {
        id: true,
        name: true,
        parentId: true,
      },
    });

    const files = await this.prisma.file.findMany({
      where: {
        folderId,
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
      select: {
        id: true,
        name: true,
        currentVersion: {
          select: {
            mimeType: true,
            size: true,
          },
        },
      },
    });

    return {
      rootFolderId,

      folder: {
        id: folder.id,
        name: folder.name,
        parentId: folder.id === rootFolderId ? null : folder.parentId,
      },

      folders: childFolders,

      files: files
        .filter(
          (
            file,
          ): file is typeof file & {
            currentVersion: NonNullable<typeof file.currentVersion>;
          } => file.currentVersion !== null,
        )
        .map((file) => ({
          id: file.id,
          name: file.name,
          mimeType: file.currentVersion.mimeType,
          size: file.currentVersion.size.toString(),
        })),
    };
  }
}
