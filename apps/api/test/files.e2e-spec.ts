import { createHash, randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from '../src/storage/object-storage.interface';
import { OutboxPublisherService } from '../src/outbox/outbox-publisher.service';

type FileBody = {
  id: string;
  name: string;
  ownerId: string;
  folderId: string | null;
  status: string;
  mimeType: string | null;
  size: string;
  createdAt: string;
  updatedAt: string;
};

type TestUser = {
  id: string;
  accessToken: string;
};

describe('Files (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let owner: TestUser;
  let otherUser: TestUser;

  const password = 'StrongPassword123!';
  const createdEmails: string[] = [];
  const createdUserIds: string[] = [];

  const checkHealthMock = jest.fn<ObjectStorage['checkHealth']>();
  const putObjectMock = jest.fn<ObjectStorage['putObject']>();
  const deleteObjectMock = jest.fn<ObjectStorage['deleteObject']>();
  const createPresignedDownloadUrlMock =
    jest.fn<ObjectStorage['createPresignedDownloadUrl']>();

  const createMultipartUploadMock =
    jest.fn<ObjectStorage['createMultipartUpload']>();

  const createPresignedUploadPartUrlMock =
    jest.fn<ObjectStorage['createPresignedUploadPartUrl']>();

  const listMultipartUploadPartsMock =
    jest.fn<ObjectStorage['listMultipartUploadParts']>();

  const completeMultipartUploadMock =
    jest.fn<ObjectStorage['completeMultipartUpload']>();

  const abortMultipartUploadMock =
    jest.fn<ObjectStorage['abortMultipartUpload']>();

  const getObjectMetadataMock = jest.fn<ObjectStorage['getObjectMetadata']>();

  const objectStorageMock: ObjectStorage = {
    checkHealth: checkHealthMock,
    putObject: putObjectMock,
    deleteObject: deleteObjectMock,
    createPresignedDownloadUrl: createPresignedDownloadUrlMock,
    createMultipartUpload: createMultipartUploadMock,
    createPresignedUploadPartUrl: createPresignedUploadPartUrlMock,
    listMultipartUploadParts: listMultipartUploadPartsMock,
    completeMultipartUpload: completeMultipartUploadMock,
    abortMultipartUpload: abortMultipartUploadMock,
    getObjectMetadata: getObjectMetadataMock,
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OBJECT_STORAGE)
      .useValue(objectStorageMock)
      .overrideProvider(OutboxPublisherService)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication();

    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    await app.init();

    prisma = app.get(PrismaService);

    owner = await registerAndLogin(createTestEmail('files.owner'));
    otherUser = await registerAndLogin(createTestEmail('files.other'));
  });

  beforeEach(() => {
    checkHealthMock.mockReset();
    checkHealthMock.mockResolvedValue(undefined);

    putObjectMock.mockReset();
    putObjectMock.mockResolvedValue(undefined);

    deleteObjectMock.mockReset();
    deleteObjectMock.mockResolvedValue(undefined);

    createPresignedDownloadUrlMock.mockReset();
    createPresignedDownloadUrlMock.mockResolvedValue(
      'https://storage.test/download',
    );
    createMultipartUploadMock.mockReset();
    createMultipartUploadMock.mockResolvedValue({
      uploadId: 'test-multipart-upload-id',
    });

    createPresignedUploadPartUrlMock.mockReset();
    createPresignedUploadPartUrlMock.mockResolvedValue(
      'https://storage.test/upload-part',
    );

    listMultipartUploadPartsMock.mockReset();
    listMultipartUploadPartsMock.mockResolvedValue([]);

    completeMultipartUploadMock.mockReset();
    completeMultipartUploadMock.mockResolvedValue(undefined);

    abortMultipartUploadMock.mockReset();
    abortMultipartUploadMock.mockResolvedValue(undefined);

    getObjectMetadataMock.mockReset();
    getObjectMetadataMock.mockResolvedValue(null);
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      const files = await prisma.file.findMany({
        where: {
          ownerId: {
            in: createdUserIds,
          },
        },
        select: {
          id: true,
        },
      });

      if (files.length > 0) {
        await prisma.outboxEvent.deleteMany({
          where: {
            aggregateId: {
              in: files.map((file) => file.id),
            },
          },
        });
      }
    }

    await prisma.user.deleteMany({
      where: {
        email: {
          in: createdEmails,
        },
      },
    });

    if (createdUserIds.length > 0) {
      await prisma.storedObject.deleteMany({
        where: {
          OR: createdUserIds.map((userId) => ({
            objectKey: {
              startsWith: `users/${userId}/`,
            },
          })),
        },
      });
    }

    await app.close();
  });

  function createTestEmail(prefix: string): string {
    const email = `${prefix}.${randomUUID()}@example.com`.toLowerCase();

    createdEmails.push(email);

    return email;
  }

  async function registerAndLogin(email: string): Promise<TestUser> {
    const registrationResponse = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email,
        password,
        displayName: 'Files E2E User',
      })
      .expect(201);

    const registrationBody = registrationResponse.body as {
      id?: unknown;
    };

    if (typeof registrationBody.id !== 'string') {
      throw new Error('Registered user ID is missing');
    }

    createdUserIds.push(registrationBody.id);

    const loginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email,
        password,
      })
      .expect(200);

    const loginBody = loginResponse.body as {
      accessToken?: unknown;
    };

    if (typeof loginBody.accessToken !== 'string') {
      throw new Error('Access token is missing');
    }

    return {
      id: registrationBody.id,
      accessToken: loginBody.accessToken,
    };
  }

  function authorization(accessToken: string) {
    return {
      Authorization: `Bearer ${accessToken}`,
    };
  }

  async function createFolder(
  accessToken: string,
  name: string,
  parentId: string | null = null,
): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/folders')
    .set(authorization(accessToken))
    .send({
      name,
      parentId,
    })
    .expect(201);

  const body = response.body as {
    id?: unknown;
  };

  if (typeof body.id !== 'string') {
    throw new Error('Folder ID is missing');
  }

  return body.id;
}

async function uploadFile(
  accessToken: string,
  fileName: string,
  content: Buffer,
  folderId?: string,
): Promise<FileBody> {
  const uploadRequest = request(app.getHttpServer())
    .post('/files/upload')
    .set(authorization(accessToken));

  if (folderId) {
    uploadRequest.field('folderId', folderId);
  }

  const response = await uploadRequest
    .attach('file', content, {
      filename: fileName,
      contentType: 'text/plain',
    })
    .expect(201);

  return response.body as FileBody;
}

  async function markFileReady(fileId: string): Promise<void> {
    await prisma.file.update({
      where: {
        id: fileId,
      },
      data: {
        status: 'READY',
      },
    });
  }

  it('uploads and lists root and nested files with owner isolation', async () => {
    const folderId = await createFolder(
      owner.accessToken,
      'File Upload Folder',
    );

    const rootFile = await uploadFile(
      owner.accessToken,
      'root-file.txt',
      Buffer.from('Root file content'),
    );

    const nestedFile = await uploadFile(
      owner.accessToken,
      'nested-file.txt',
      Buffer.from('Nested file content'),
      folderId,
    );

    expect(rootFile).toMatchObject({
      name: 'root-file.txt',
      ownerId: owner.id,
      folderId: null,
      status: 'PROCESSING',
      mimeType: 'text/plain',
      size: Buffer.byteLength('Root file content').toString(),
    });

    expect(nestedFile).toMatchObject({
      name: 'nested-file.txt',
      ownerId: owner.id,
      folderId,
      status: 'PROCESSING',
    });

    const outboxEvents = await prisma.outboxEvent.findMany({
      where: {
        aggregateId: {
          in: [rootFile.id, nestedFile.id],
        },
        type: 'PROCESS_FILE',
      },
    });

    expect(outboxEvents).toHaveLength(2);

    expect(outboxEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          aggregateId: rootFile.id,
          publishedAt: null,
        }),
        expect.objectContaining({
          aggregateId: nestedFile.id,
          publishedAt: null,
        }),
      ]),
    );

    await markFileReady(rootFile.id);
    await markFileReady(nestedFile.id);

    expect(putObjectMock).toHaveBeenCalledTimes(2);

    const storedObjects = await prisma.storedObject.findMany({
      where: {
        versions: {
          some: {
            fileId: {
              in: [rootFile.id, nestedFile.id],
            },
          },
        },
      },
      select: {
        objectKey: true,
      },
    });

    expect(storedObjects).toHaveLength(2);

    for (const storedObject of storedObjects) {
      expect(storedObject.objectKey).toMatch(
        new RegExp(`^users/${owner.id}/objects/`),
      );
    }

    const rootList = await request(app.getHttpServer())
      .get('/files')
      .set(authorization(owner.accessToken))
      .expect(200);

    expect(rootList.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: rootFile.id,
          folderId: null,
        }),
      ]),
    );

    expect(rootList.body).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: nestedFile.id,
        }),
      ]),
    );

    const nestedList = await request(app.getHttpServer())
      .get('/files')
      .query({
        folderId,
      })
      .set(authorization(owner.accessToken))
      .expect(200);

    expect(nestedList.body).toEqual([
      expect.objectContaining({
        id: nestedFile.id,
        folderId,
      }),
    ]);

    const otherUserList = await request(app.getHttpServer())
      .get('/files')
      .set(authorization(otherUser.accessToken))
      .expect(200);

    expect(otherUserList.body).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: rootFile.id,
        }),
      ]),
    );

    await request(app.getHttpServer())
      .get('/files')
      .query({
        folderId,
      })
      .set(authorization(otherUser.accessToken))
      .expect(404);

    await request(app.getHttpServer())
      .post('/files/upload')
      .set(authorization(otherUser.accessToken))
      .field('folderId', folderId)
      .attach('file', Buffer.from('Foreign upload'), {
        filename: 'foreign.txt',
        contentType: 'text/plain',
      })
      .expect(404);

    expect(putObjectMock).toHaveBeenCalledTimes(2);
  });

  it('uploads a new version of an existing file', async () => {
    const originalContent = Buffer.from('Original version content');
    const newContent = Buffer.from('Updated version content');

    const file = await uploadFile(
      owner.accessToken,
      'versioned-file.txt',
      originalContent,
    );

    await markFileReady(file.id);

    const originalMetadata = await prisma.file.findUnique({
      where: {
        id: file.id,
      },
      select: {
        id: true,
        name: true,
        currentVersionId: true,
        versions: {
          orderBy: {
            versionNumber: 'asc',
          },
          select: {
            id: true,
            versionNumber: true,
            originalName: true,
            mimeType: true,
            size: true,
            storedObject: {
              select: {
                id: true,
                objectKey: true,
                size: true,
                referenceCount: true,
              },
            },
          },
        },
      },
    });

    expect(originalMetadata).not.toBeNull();
    expect(originalMetadata?.versions).toHaveLength(1);
    expect(originalMetadata?.versions[0]).toMatchObject({
      versionNumber: 1,
      originalName: 'versioned-file.txt',
      mimeType: 'text/plain',
      size: BigInt(originalContent.length),
    });

    const originalVersionId = originalMetadata?.currentVersionId;
    const originalStoredObjectId =
      originalMetadata?.versions[0]?.storedObject.id;

    if (!originalVersionId || !originalStoredObjectId) {
      throw new Error('Original file version metadata is missing');
    }

    putObjectMock.mockClear();

    const response = await request(app.getHttpServer())
      .post(`/files/${file.id}/versions`)
      .set(authorization(owner.accessToken))
      .attach('file', newContent, {
        filename: 'replacement-name.txt',
        contentType: 'text/plain',
      })
      .expect(201);

    const updatedFile = response.body as FileBody;

    expect(updatedFile).toMatchObject({
      id: file.id,
      name: 'versioned-file.txt',
      ownerId: owner.id,
      folderId: null,
      status: 'PROCESSING',
      mimeType: 'text/plain',
      size: newContent.length.toString(),
    });

    expect(putObjectMock).toHaveBeenCalledTimes(1);

    const updatedMetadata = await prisma.file.findUnique({
      where: {
        id: file.id,
      },
      select: {
        id: true,
        name: true,
        status: true,
        currentVersionId: true,
        versions: {
          orderBy: {
            versionNumber: 'asc',
          },
          select: {
            id: true,
            versionNumber: true,
            originalName: true,
            mimeType: true,
            size: true,
            storedObject: {
              select: {
                id: true,
                objectKey: true,
                size: true,
                referenceCount: true,
              },
            },
          },
        },
      },
    });

    expect(updatedMetadata).not.toBeNull();
    expect(updatedMetadata?.id).toBe(file.id);
    expect(updatedMetadata?.name).toBe('versioned-file.txt');
    expect(updatedMetadata?.status).toBe('PROCESSING');
    expect(updatedMetadata?.versions).toHaveLength(2);

    const firstVersion = updatedMetadata?.versions[0];
    const secondVersion = updatedMetadata?.versions[1];

    expect(firstVersion).toMatchObject({
      id: originalVersionId,
      versionNumber: 1,
      originalName: 'versioned-file.txt',
      mimeType: 'text/plain',
      size: BigInt(originalContent.length),
    });

    expect(firstVersion?.storedObject.id).toBe(originalStoredObjectId);

    expect(secondVersion).toMatchObject({
      versionNumber: 2,
      originalName: 'replacement-name.txt',
      mimeType: 'text/plain',
      size: BigInt(newContent.length),
    });

    expect(secondVersion?.storedObject.id).not.toBe(originalStoredObjectId);
    expect(secondVersion?.storedObject.objectKey).toMatch(
      new RegExp(`^users/${owner.id}/objects/`),
    );
    expect(secondVersion?.storedObject).toMatchObject({
      size: BigInt(newContent.length),
      referenceCount: 1,
    });

    expect(updatedMetadata?.currentVersionId).toBe(secondVersion?.id);

    const outboxEvents = await prisma.outboxEvent.findMany({
      where: {
        aggregateId: file.id,
        type: 'PROCESS_FILE',
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    expect(outboxEvents).toHaveLength(2);

    expect(outboxEvents[1]?.payload).toMatchObject({
      fileId: file.id,
      versionId: secondVersion?.id,
      storedObjectId: secondVersion?.storedObject.id,
    });

    await request(app.getHttpServer())
      .post(`/files/${file.id}/versions`)
      .set(authorization(otherUser.accessToken))
      .attach('file', Buffer.from('Foreign version'), {
        filename: 'foreign-version.txt',
        contentType: 'text/plain',
      })
      .expect(404);

    await request(app.getHttpServer())
      .post(`/files/${file.id}/versions`)
      .set(authorization(owner.accessToken))
      .attach('file', Buffer.from('Too early'), {
        filename: 'too-early.txt',
        contentType: 'text/plain',
      })
      .expect(409);

    expect(putObjectMock).toHaveBeenCalledTimes(1);
  });

  it('validates upload requests and enforces the size limit', async () => {
    await request(app.getHttpServer())
      .post('/files/upload')
      .attach('file', Buffer.from('Unauthorized'), {
        filename: 'unauthorized.txt',
        contentType: 'text/plain',
      })
      .expect(401);

    await request(app.getHttpServer())
      .post('/files/upload')
      .set(authorization(owner.accessToken))
      .expect(400);

    await request(app.getHttpServer())
      .post('/files/upload')
      .set(authorization(owner.accessToken))
      .field('folderId', 'not-a-uuid')
      .attach('file', Buffer.from('Invalid folder'), {
        filename: 'invalid-folder.txt',
        contentType: 'text/plain',
      })
      .expect(400);

    const oversizedFile = Buffer.alloc(10 * 1024 * 1024 + 1);

    await request(app.getHttpServer())
      .post('/files/upload')
      .set(authorization(owner.accessToken))
      .attach('file', oversizedFile, {
        filename: 'oversized.bin',
        contentType: 'application/octet-stream',
      })
      .expect(413);
  });

  it('lists all file versions with the current version marked', async () => {
    const originalContent = Buffer.from('Original history content');
    const updatedContent = Buffer.from('Updated history content');

    const file = await uploadFile(
      owner.accessToken,
      'history-file.txt',
      originalContent,
    );

    await markFileReady(file.id);

    await request(app.getHttpServer())
      .post(`/files/${file.id}/versions`)
      .set(authorization(owner.accessToken))
      .attach('file', updatedContent, {
        filename: 'history-file-v2.txt',
        contentType: 'text/plain',
      })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get(`/files/${file.id}/versions`)
      .set(authorization(owner.accessToken))
      .expect(200);

    const versions = response.body as Array<{
      id: string;
      versionNumber: number;
      originalName: string;
      mimeType: string | null;
      size: string;
      createdAt: string;
      isCurrent: boolean;
    }>;

    expect(versions).toHaveLength(2);

    expect(versions[0]).toMatchObject({
      versionNumber: 2,
      originalName: 'history-file-v2.txt',
      mimeType: 'text/plain',
      size: updatedContent.length.toString(),
      isCurrent: true,
    });

    expect(versions[1]).toMatchObject({
      versionNumber: 1,
      originalName: 'history-file.txt',
      mimeType: 'text/plain',
      size: originalContent.length.toString(),
      isCurrent: false,
    });

    expect(typeof versions[0]?.id).toBe('string');
    expect(typeof versions[1]?.id).toBe('string');

    expect(typeof versions[0]?.createdAt).toBe('string');
    expect(typeof versions[1]?.createdAt).toBe('string');

    await request(app.getHttpServer())
      .get(`/files/${file.id}/versions`)
      .set(authorization(otherUser.accessToken))
      .expect(404);

    await request(app.getHttpServer())
      .get('/files/not-a-uuid/versions')
      .set(authorization(owner.accessToken))
      .expect(400);
  });

  it('creates a temporary download URL only for the owner', async () => {
    const file = await uploadFile(
      owner.accessToken,
      'download-me.txt',
      Buffer.from('Download content'),
    );

    await markFileReady(file.id);

    const response = await request(app.getHttpServer())
      .get(`/files/${file.id}/download`)
      .set(authorization(owner.accessToken))
      .expect(200);

    const body = response.body as {
      url?: unknown;
      expiresAt?: unknown;
    };

    expect(body.url).toBe('https://storage.test/download');
    expect(typeof body.expiresAt).toBe('string');

    expect(createPresignedDownloadUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        downloadFileName: 'download-me.txt',
        contentType: 'text/plain',
        expiresInSeconds: 600,
      }),
    );

    await request(app.getHttpServer())
      .get(`/files/${file.id}/download`)
      .set(authorization(otherUser.accessToken))
      .expect(404);

    await request(app.getHttpServer())
      .get('/files/not-a-uuid/download')
      .set(authorization(owner.accessToken))
      .expect(400);
  });

  it('creates a temporary preview URL only for the owner', async () => {
    const file = await uploadFile(
      owner.accessToken,
      'preview-image.png',
      Buffer.from('Preview image content'),
    );

    await markFileReady(file.id);

    const fileMetadata = await prisma.file.findUnique({
      where: {
        id: file.id,
      },
      select: {
        currentVersionId: true,
      },
    });

    if (!fileMetadata?.currentVersionId) {
      throw new Error('File current version is missing');
    }

    const previewObjectKey = `users/${owner.id}/previews/${file.id}.webp`;

    await prisma.fileVersion.update({
      where: {
        id: fileMetadata.currentVersionId,
      },
      data: {
        previewObjectKey,
        previewMimeType: 'image/webp',
        previewWidth: 512,
        previewHeight: 341,
      },
    });

    const response = await request(app.getHttpServer())
      .get(`/files/${file.id}/preview`)
      .set(authorization(owner.accessToken))
      .expect(200);

    const body = response.body as {
      url: string;
      expiresAt: string;
      mimeType: string;
      width: number;
      height: number;
    };

    expect(response.body).toMatchObject({
      url: 'https://storage.test/download',
      mimeType: 'image/webp',
      width: 512,
      height: 341,
    });

    expect(typeof body.expiresAt).toBe('string');

    expect(createPresignedDownloadUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        objectKey: previewObjectKey,
        downloadFileName: 'preview.webp',
        contentType: 'image/webp',
        expiresInSeconds: 600,
        contentDisposition: 'inline',
      }),
    );

    await request(app.getHttpServer())
      .get(`/files/${file.id}/preview`)
      .set(authorization(otherUser.accessToken))
      .expect(404);
  });

  it('creates download URLs for specific file versions', async () => {
    const originalContent = Buffer.from('Version download original content');
    const updatedContent = Buffer.from('Version download updated content');

    const file = await uploadFile(
      owner.accessToken,
      'download-version-v1.txt',
      originalContent,
    );

    await markFileReady(file.id);

    await request(app.getHttpServer())
      .post(`/files/${file.id}/versions`)
      .set(authorization(owner.accessToken))
      .attach('file', updatedContent, {
        filename: 'download-version-v2.txt',
        contentType: 'text/plain',
      })
      .expect(201);

    const fileMetadata = await prisma.file.findUnique({
      where: {
        id: file.id,
      },
      select: {
        currentVersionId: true,
        versions: {
          orderBy: {
            versionNumber: 'asc',
          },
          select: {
            id: true,
            versionNumber: true,
            originalName: true,
            storedObject: {
              select: {
                objectKey: true,
              },
            },
          },
        },
      },
    });

    if (!fileMetadata?.currentVersionId || fileMetadata.versions.length !== 2) {
      throw new Error('File version metadata is missing');
    }

    const firstVersion = fileMetadata.versions[0];
    const secondVersion = fileMetadata.versions[1];

    if (!firstVersion || !secondVersion) {
      throw new Error('Expected two file versions');
    }

    expect(firstVersion.versionNumber).toBe(1);
    expect(secondVersion.versionNumber).toBe(2);
    expect(fileMetadata.currentVersionId).toBe(secondVersion.id);

    createPresignedDownloadUrlMock.mockClear();

    await request(app.getHttpServer())
      .get(`/files/${file.id}/versions/${firstVersion.id}/download`)
      .set(authorization(owner.accessToken))
      .expect(200);

    expect(createPresignedDownloadUrlMock).toHaveBeenLastCalledWith({
      objectKey: firstVersion.storedObject.objectKey,
      downloadFileName: 'download-version-v1.txt',
      contentType: 'text/plain',
      expiresInSeconds: 600,
    });

    await request(app.getHttpServer())
      .get(`/files/${file.id}/versions/${secondVersion.id}/download`)
      .set(authorization(owner.accessToken))
      .expect(200);

    expect(createPresignedDownloadUrlMock).toHaveBeenLastCalledWith({
      objectKey: secondVersion.storedObject.objectKey,
      downloadFileName: 'download-version-v2.txt',
      contentType: 'text/plain',
      expiresInSeconds: 600,
    });

    const metadataAfterDownloads = await prisma.file.findUnique({
      where: {
        id: file.id,
      },
      select: {
        currentVersionId: true,
      },
    });

    expect(metadataAfterDownloads?.currentVersionId).toBe(secondVersion.id);

    await request(app.getHttpServer())
      .get(`/files/${file.id}/versions/${firstVersion.id}/download`)
      .set(authorization(otherUser.accessToken))
      .expect(404);

    const anotherFile = await uploadFile(
      owner.accessToken,
      'another-versioned-file.txt',
      Buffer.from('Another file content'),
    );

    const anotherFileMetadata = await prisma.file.findUnique({
      where: {
        id: anotherFile.id,
      },
      select: {
        currentVersionId: true,
      },
    });

    if (!anotherFileMetadata?.currentVersionId) {
      throw new Error('Another file version metadata is missing');
    }

    await request(app.getHttpServer())
      .get(
        `/files/${file.id}/versions/${anotherFileMetadata.currentVersionId}/download`,
      )
      .set(authorization(owner.accessToken))
      .expect(404);

    await request(app.getHttpServer())
      .get(`/files/not-a-uuid/versions/${firstVersion.id}/download`)
      .set(authorization(owner.accessToken))
      .expect(400);

    await request(app.getHttpServer())
      .get(`/files/${file.id}/versions/not-a-uuid/download`)
      .set(authorization(owner.accessToken))
      .expect(400);
  });

  it('returns 404 when the file has no preview', async () => {
    const file = await uploadFile(
      owner.accessToken,
      'without-preview.txt',
      Buffer.from('File without preview'),
    );

    await markFileReady(file.id);

    await request(app.getHttpServer())
      .get(`/files/${file.id}/preview`)
      .set(authorization(owner.accessToken))
      .expect(404);

    expect(createPresignedDownloadUrlMock).not.toHaveBeenCalled();
  });

  it('renames a file without replacing its stored object', async () => {
    const file = await uploadFile(
      owner.accessToken,
      'before-rename.txt',
      Buffer.from('Rename content'),
    );

    await markFileReady(file.id);

    putObjectMock.mockClear();

    const response = await request(app.getHttpServer())
      .patch(`/files/${file.id}`)
      .set(authorization(owner.accessToken))
      .send({
        name: 'after-rename.txt',
      })
      .expect(200);

    expect(response.body).toMatchObject({
      id: file.id,
      name: 'after-rename.txt',
    });

    expect(putObjectMock).not.toHaveBeenCalled();

    await request(app.getHttpServer())
      .get(`/files/${file.id}/download`)
      .set(authorization(owner.accessToken))
      .expect(200);

    expect(createPresignedDownloadUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        downloadFileName: 'after-rename.txt',
      }),
    );

    await request(app.getHttpServer())
      .patch(`/files/${file.id}`)
      .set(authorization(otherUser.accessToken))
      .send({
        name: 'foreign-rename.txt',
      })
      .expect(404);

    await request(app.getHttpServer())
      .patch(`/files/${file.id}`)
      .set(authorization(owner.accessToken))
      .send({
        name: 'invalid/name.txt',
      })
      .expect(400);
  });

  it('moves a file between folders and root with owner isolation', async () => {
    const ownerFolderId = await createFolder(
      owner.accessToken,
      'File Move Destination',
    );

    const foreignFolderId = await createFolder(
      otherUser.accessToken,
      'Foreign File Destination',
    );

    const file = await uploadFile(
      owner.accessToken,
      'move-me.txt',
      Buffer.from('Move content'),
    );

    await markFileReady(file.id);

    putObjectMock.mockClear();

    const moveResponse = await request(app.getHttpServer())
      .patch(`/files/${file.id}/move`)
      .set(authorization(owner.accessToken))
      .send({
        folderId: ownerFolderId,
      })
      .expect(200);

    expect(moveResponse.body).toMatchObject({
      id: file.id,
      name: 'move-me.txt',
      folderId: ownerFolderId,
    });

    expect(putObjectMock).not.toHaveBeenCalled();
    expect(deleteObjectMock).not.toHaveBeenCalled();

    const rootList = await request(app.getHttpServer())
      .get('/files')
      .set(authorization(owner.accessToken))
      .expect(200);

    const rootFiles = rootList.body as FileBody[];

    expect(rootFiles.some((listedFile) => listedFile.id === file.id)).toBe(
      false,
    );

    const folderList = await request(app.getHttpServer())
      .get('/files')
      .query({
        folderId: ownerFolderId,
      })
      .set(authorization(owner.accessToken))
      .expect(200);

    const folderFiles = folderList.body as FileBody[];

    expect(folderFiles.some((listedFile) => listedFile.id === file.id)).toBe(
      true,
    );

    await request(app.getHttpServer())
      .patch(`/files/${file.id}/move`)
      .set(authorization(otherUser.accessToken))
      .send({
        folderId: null,
      })
      .expect(404);

    await request(app.getHttpServer())
      .patch(`/files/${file.id}/move`)
      .set(authorization(owner.accessToken))
      .send({
        folderId: foreignFolderId,
      })
      .expect(404);

    await request(app.getHttpServer())
      .patch(`/files/${file.id}/move`)
      .set(authorization(owner.accessToken))
      .send({
        folderId: 'not-a-uuid',
      })
      .expect(400);

    await request(app.getHttpServer())
      .patch(`/files/${file.id}/move`)
      .set(authorization(owner.accessToken))
      .send({})
      .expect(400);

    const moveToRootResponse = await request(app.getHttpServer())
      .patch(`/files/${file.id}/move`)
      .set(authorization(owner.accessToken))
      .send({
        folderId: null,
      })
      .expect(200);

    expect(moveToRootResponse.body).toMatchObject({
      id: file.id,
      folderId: null,
    });
  });

  it('deletes the file, its preview and stored object', async () => {
    const file = await uploadFile(
      owner.accessToken,
      'delete-me.txt',
      Buffer.from('Delete content'),
    );

    await markFileReady(file.id);

    const fileMetadata = await prisma.file.findUnique({
      where: {
        id: file.id,
      },
      select: {
        currentVersion: {
          select: {
            id: true,
            storedObject: {
              select: {
                id: true,
                objectKey: true,
              },
            },
          },
        },
      },
    });

    if (!fileMetadata?.currentVersion) {
      throw new Error('Stored object metadata is missing');
    }

    const storedObject = fileMetadata.currentVersion.storedObject;

    const previewObjectKey = `users/${owner.id}/previews/${file.id}.webp`;

    await prisma.fileVersion.update({
      where: {
        id: fileMetadata.currentVersion.id,
      },
      data: {
        previewObjectKey,
        previewMimeType: 'image/webp',
        previewWidth: 512,
        previewHeight: 341,
      },
    });

    await request(app.getHttpServer())
      .delete(`/files/${file.id}`)
      .set(authorization(owner.accessToken))
      .expect(204);

    expect(deleteObjectMock).toHaveBeenCalledTimes(2);

    expect(deleteObjectMock).toHaveBeenCalledWith(previewObjectKey);

    expect(deleteObjectMock).toHaveBeenCalledWith(storedObject.objectKey);

    expect(
      await prisma.file.findUnique({
        where: {
          id: file.id,
        },
      }),
    ).toBeNull();

    expect(
      await prisma.storedObject.findUnique({
        where: {
          id: storedObject.id,
        },
      }),
    ).toBeNull();

    await request(app.getHttpServer())
      .get(`/files/${file.id}/download`)
      .set(authorization(owner.accessToken))
      .expect(404);

    await request(app.getHttpServer())
      .delete(`/files/${file.id}`)
      .set(authorization(owner.accessToken))
      .expect(404);
  });

  it('deletes all versions, previews and unique stored objects of a versioned file', async () => {
    const originalContent = Buffer.from('Versioned delete original content');
    const updatedContent = Buffer.from('Versioned delete updated content');

    const file = await uploadFile(
      owner.accessToken,
      'versioned-delete.txt',
      originalContent,
    );

    await markFileReady(file.id);

    await request(app.getHttpServer())
      .post(`/files/${file.id}/versions`)
      .set(authorization(owner.accessToken))
      .attach('file', updatedContent, {
        filename: 'versioned-delete-v2.txt',
        contentType: 'text/plain',
      })
      .expect(201);

    await markFileReady(file.id);

    const metadataBeforeRestore = await prisma.file.findUnique({
      where: {
        id: file.id,
      },
      select: {
        versions: {
          orderBy: {
            versionNumber: 'asc',
          },
          select: {
            id: true,
            versionNumber: true,
            storedObjectId: true,
          },
        },
      },
    });

    if (!metadataBeforeRestore || metadataBeforeRestore.versions.length !== 2) {
      throw new Error('Expected two versions before restore');
    }

    const firstVersion = metadataBeforeRestore.versions[0];
    const secondVersion = metadataBeforeRestore.versions[1];

    if (!firstVersion || !secondVersion) {
      throw new Error('File versions are missing');
    }

    await request(app.getHttpServer())
      .post(`/files/${file.id}/versions/${firstVersion.id}/restore`)
      .set(authorization(owner.accessToken))
      .expect(201);

    await markFileReady(file.id);

    const metadataBeforeDelete = await prisma.file.findUnique({
      where: {
        id: file.id,
      },
      select: {
        versions: {
          orderBy: {
            versionNumber: 'asc',
          },
          select: {
            id: true,
            versionNumber: true,
            storedObject: {
              select: {
                id: true,
                objectKey: true,
                referenceCount: true,
              },
            },
          },
        },
      },
    });

    if (!metadataBeforeDelete || metadataBeforeDelete.versions.length !== 3) {
      throw new Error('Expected three versions before deletion');
    }

    const version1 = metadataBeforeDelete.versions[0];
    const version2 = metadataBeforeDelete.versions[1];
    const version3 = metadataBeforeDelete.versions[2];

    if (!version1 || !version2 || !version3) {
      throw new Error('Version metadata is missing');
    }

    /*
     * Restore must have reused the physical object from V1.
     */
    expect(version1.storedObject.id).toBe(version3.storedObject.id);
    expect(version1.storedObject.referenceCount).toBe(2);

    expect(version2.storedObject.id).not.toBe(version1.storedObject.id);
    expect(version2.storedObject.referenceCount).toBe(1);

    const previewV1 = `users/${owner.id}/previews/${version1.id}.webp`;
    const previewV2 = `users/${owner.id}/previews/${version2.id}.webp`;
    const previewV3 = `users/${owner.id}/previews/${version3.id}.webp`;

    await prisma.fileVersion.update({
      where: {
        id: version1.id,
      },
      data: {
        previewObjectKey: previewV1,
        previewMimeType: 'image/webp',
        previewWidth: 512,
        previewHeight: 341,
      },
    });

    await prisma.fileVersion.update({
      where: {
        id: version2.id,
      },
      data: {
        previewObjectKey: previewV2,
        previewMimeType: 'image/webp',
        previewWidth: 512,
        previewHeight: 341,
      },
    });

    await prisma.fileVersion.update({
      where: {
        id: version3.id,
      },
      data: {
        previewObjectKey: previewV3,
        previewMimeType: 'image/webp',
        previewWidth: 512,
        previewHeight: 341,
      },
    });

    const firstStoredObjectId = version1.storedObject.id;
    const secondStoredObjectId = version2.storedObject.id;

    const firstStoredObjectKey = version1.storedObject.objectKey;
    const secondStoredObjectKey = version2.storedObject.objectKey;

    deleteObjectMock.mockClear();

    await request(app.getHttpServer())
      .delete(`/files/${file.id}`)
      .set(authorization(owner.accessToken))
      .expect(204);

    /*
     * Three unique previews + two unique physical file objects.
     *
     * O1 is referenced by both V1 and V3 but must be physically deleted
     * only once.
     */
    expect(deleteObjectMock).toHaveBeenCalledTimes(5);

    expect(deleteObjectMock).toHaveBeenCalledWith(previewV1);
    expect(deleteObjectMock).toHaveBeenCalledWith(previewV2);
    expect(deleteObjectMock).toHaveBeenCalledWith(previewV3);

    expect(deleteObjectMock).toHaveBeenCalledWith(firstStoredObjectKey);
    expect(deleteObjectMock).toHaveBeenCalledWith(secondStoredObjectKey);

    expect(
      deleteObjectMock.mock.calls.filter(
        ([objectKey]) => objectKey === firstStoredObjectKey,
      ),
    ).toHaveLength(1);

    expect(
      await prisma.file.findUnique({
        where: {
          id: file.id,
        },
      }),
    ).toBeNull();

    expect(
      await prisma.fileVersion.count({
        where: {
          fileId: file.id,
        },
      }),
    ).toBe(0);

    const remainingStoredObjects = await prisma.storedObject.findMany({
      where: {
        id: {
          in: [firstStoredObjectId, secondStoredObjectId],
        },
      },
    });

    expect(remainingStoredObjects).toHaveLength(0);
  });

  it('can retry deletion after object storage becomes available', async () => {
    const file = await uploadFile(
      owner.accessToken,
      'retry-delete.txt',
      Buffer.from('Retry delete content'),
    );

    await markFileReady(file.id);

    deleteObjectMock.mockRejectedValueOnce(new Error('Storage is unavailable'));

    await request(app.getHttpServer())
      .delete(`/files/${file.id}`)
      .set(authorization(owner.accessToken))
      .expect(503);

    const deletedFile = await prisma.file.findUnique({
      where: {
        id: file.id,
      },
      select: {
        status: true,
        deletedAt: true,
      },
    });

    expect(deletedFile?.status).toBe('DELETED');
    expect(deletedFile?.deletedAt).toBeInstanceOf(Date);

    await request(app.getHttpServer())
      .get(`/files/${file.id}/download`)
      .set(authorization(owner.accessToken))
      .expect(404);

    await request(app.getHttpServer())
      .delete(`/files/${file.id}`)
      .set(authorization(owner.accessToken))
      .expect(204);

    expect(deleteObjectMock).toHaveBeenCalledTimes(2);
  });

  it('initiates a multipart upload idempotently', async () => {
    const folderId = await createFolder(
      owner.accessToken,
      'Multipart Upload Folder',
    );

    const clientRequestId = randomUUID();
    const totalSize = (11 * 1024 * 1024).toString();

    const requestBody = {
      clientRequestId,
      fileName: 'large-file.bin',
      mimeType: 'application/octet-stream',
      totalSize,
      folderId,
    };

    const firstResponse = await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send(requestBody)
      .expect(201);

    const firstBody = firstResponse.body as {
      id?: unknown;
      clientRequestId?: unknown;
      originalName?: unknown;
      mimeType?: unknown;
      folderId?: unknown;
      totalSize?: unknown;
      partSize?: unknown;
      totalParts?: unknown;
      status?: unknown;
      fileId?: unknown;
    };

    expect(firstBody).toMatchObject({
      clientRequestId,
      originalName: 'large-file.bin',
      mimeType: 'application/octet-stream',
      folderId,
      totalSize,
      partSize: (8 * 1024 * 1024).toString(),
      totalParts: 2,
      status: 'UPLOADING',
      fileId: null,
    });

    expect(typeof firstBody.id).toBe('string');

    expect(createMultipartUploadMock).toHaveBeenCalledTimes(1);

    const storedSession = await prisma.uploadSession.findUnique({
      where: {
        ownerId_clientRequestId: {
          ownerId: owner.id,
          clientRequestId,
        },
      },
    });

    if (!storedSession) {
      throw new Error('Multipart upload session is missing');
    }

    expect(storedSession.objectKey).toMatch(
      new RegExp(`^users/${owner.id}/objects/`),
    );

    expect(createMultipartUploadMock).toHaveBeenCalledWith({
      objectKey: storedSession.objectKey,
      contentType: 'application/octet-stream',
    });

    expect(storedSession).toMatchObject({
      ownerId: owner.id,
      folderId,
      clientRequestId,
      originalName: 'large-file.bin',
      mimeType: 'application/octet-stream',
      totalSize: BigInt(totalSize),
      partSize: BigInt(8 * 1024 * 1024),
      totalParts: 2,
      multipartUploadId: 'test-multipart-upload-id',
      status: 'UPLOADING',
    });

    const repeatedResponse = await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send(requestBody)
      .expect(201);

    expect(repeatedResponse.body).toMatchObject({
      id: firstBody.id,
      clientRequestId,
      status: 'UPLOADING',
    });

    expect(createMultipartUploadMock).toHaveBeenCalledTimes(1);
  });

  it('validates multipart upload parameters and folder ownership', async () => {
    const clientRequestId = randomUUID();
    const totalSize = (11 * 1024 * 1024).toString();

    await request(app.getHttpServer())
      .post('/files/multipart')
      .send({
        clientRequestId,
        fileName: 'unauthorized.bin',
        totalSize,
      })
      .expect(401);

    await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId: 'not-a-uuid',
        fileName: 'invalid-request-id.bin',
        totalSize,
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId: randomUUID(),
        fileName: 'invalid-size.bin',
        totalSize: 123,
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId: randomUUID(),
        fileName: 'small-file.bin',
        totalSize: (10 * 1024 * 1024).toString(),
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId: randomUUID(),
        fileName: 'too-large.bin',
        totalSize: (5 * 1024 * 1024 * 1024 + 1).toString(),
      })
      .expect(400);

    const foreignFolderId = await createFolder(
      otherUser.accessToken,
      'Foreign Multipart Folder',
    );

    await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId: randomUUID(),
        fileName: 'foreign-folder.bin',
        totalSize,
        folderId: foreignFolderId,
      })
      .expect(404);

    const conflictRequestId = randomUUID();

    await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId: conflictRequestId,
        fileName: 'original-name.bin',
        totalSize,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId: conflictRequestId,
        fileName: 'different-name.bin',
        totalSize,
      })
      .expect(409);
  });

  it('marks the multipart session as failed when storage is unavailable', async () => {
    const clientRequestId = randomUUID();
    const requestBody = {
      clientRequestId,
      fileName: 'storage-failure.bin',
      mimeType: 'application/octet-stream',
      totalSize: (11 * 1024 * 1024).toString(),
      folderId: null,
    };

    createMultipartUploadMock.mockRejectedValueOnce(
      new Error('Storage is unavailable'),
    );

    await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send(requestBody)
      .expect(503);

    const failedSession = await prisma.uploadSession.findUnique({
      where: {
        ownerId_clientRequestId: {
          ownerId: owner.id,
          clientRequestId,
        },
      },
    });

    expect(failedSession).toMatchObject({
      ownerId: owner.id,
      multipartUploadId: null,
      status: 'FAILED',
    });

    expect(createMultipartUploadMock).toHaveBeenCalledTimes(1);
    expect(abortMultipartUploadMock).not.toHaveBeenCalled();

    const repeatedResponse = await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send(requestBody)
      .expect(201);

    expect(repeatedResponse.body).toMatchObject({
      id: failedSession?.id,
      clientRequestId,
      status: 'FAILED',
    });

    expect(createMultipartUploadMock).toHaveBeenCalledTimes(1);
  });

  it('creates a multipart part URL only for the session owner', async () => {
    const initiationResponse = await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId: randomUUID(),
        fileName: 'part-url-file.bin',
        mimeType: 'application/octet-stream',
        totalSize: (11 * 1024 * 1024).toString(),
        folderId: null,
      })
      .expect(201);

    const initiationBody = initiationResponse.body as {
      id?: unknown;
    };

    if (typeof initiationBody.id !== 'string') {
      throw new Error('Multipart upload session ID is missing');
    }

    const session = await prisma.uploadSession.findUnique({
      where: {
        id: initiationBody.id,
      },
    });

    if (!session?.multipartUploadId) {
      throw new Error('Multipart upload metadata is missing');
    }

    const response = await request(app.getHttpServer())
      .post(`/files/multipart/${session.id}/parts/2`)
      .set(authorization(owner.accessToken))
      .expect(201);

    const body = response.body as {
      partNumber?: unknown;
      url?: unknown;
      expiresAt?: unknown;
    };

    expect(body).toMatchObject({
      partNumber: 2,
      url: 'https://storage.test/upload-part',
    });
    expect(typeof body.expiresAt).toBe('string');

    expect(createPresignedUploadPartUrlMock).toHaveBeenCalledWith({
      objectKey: session.objectKey,
      uploadId: session.multipartUploadId,
      partNumber: 2,
      expiresInSeconds: 900,
    });

    await request(app.getHttpServer())
      .post(`/files/multipart/${session.id}/parts/1`)
      .set(authorization(otherUser.accessToken))
      .expect(404);

    await request(app.getHttpServer())
      .post(`/files/multipart/${session.id}/parts/0`)
      .set(authorization(owner.accessToken))
      .expect(400);

    await request(app.getHttpServer())
      .post(`/files/multipart/${session.id}/parts/3`)
      .set(authorization(owner.accessToken))
      .expect(400);

    await request(app.getHttpServer())
      .post(`/files/multipart/${session.id}/parts/not-a-number`)
      .set(authorization(owner.accessToken))
      .expect(400);

    await request(app.getHttpServer())
      .post('/files/multipart/not-a-uuid/parts/1')
      .set(authorization(owner.accessToken))
      .expect(400);

    expect(createPresignedUploadPartUrlMock).toHaveBeenCalledTimes(1);
  });

  it('rejects expired multipart sessions when creating a part URL', async () => {
    const initiationResponse = await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId: randomUUID(),
        fileName: 'expired-upload.bin',
        totalSize: (11 * 1024 * 1024).toString(),
      })
      .expect(201);

    const initiationBody = initiationResponse.body as {
      id?: unknown;
    };

    if (typeof initiationBody.id !== 'string') {
      throw new Error('Multipart upload session ID is missing');
    }

    await prisma.uploadSession.update({
      where: {
        id: initiationBody.id,
      },
      data: {
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    await request(app.getHttpServer())
      .post(`/files/multipart/${initiationBody.id}/parts/1`)
      .set(authorization(owner.accessToken))
      .expect(410);

    const expiredSession = await prisma.uploadSession.findUnique({
      where: {
        id: initiationBody.id,
      },
      select: {
        status: true,
      },
    });

    expect(expiredSession?.status).toBe('EXPIRED');
    expect(createPresignedUploadPartUrlMock).not.toHaveBeenCalled();

    await request(app.getHttpServer())
      .post(`/files/multipart/${initiationBody.id}/parts/1`)
      .set(authorization(owner.accessToken))
      .expect(410);
  });

  it('returns 503 when a multipart part URL cannot be created', async () => {
    const initiationResponse = await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId: randomUUID(),
        fileName: 'part-url-storage-failure.bin',
        totalSize: (11 * 1024 * 1024).toString(),
      })
      .expect(201);

    const initiationBody = initiationResponse.body as {
      id?: unknown;
    };

    if (typeof initiationBody.id !== 'string') {
      throw new Error('Multipart upload session ID is missing');
    }

    createPresignedUploadPartUrlMock.mockRejectedValueOnce(
      new Error('Storage is unavailable'),
    );

    await request(app.getHttpServer())
      .post(`/files/multipart/${initiationBody.id}/parts/1`)
      .set(authorization(owner.accessToken))
      .expect(503);
  });

  it('returns and persists uploaded multipart parts', async () => {
    const initiationResponse = await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId: randomUUID(),
        fileName: 'multipart-status.bin',
        mimeType: 'application/octet-stream',
        totalSize: (11 * 1024 * 1024).toString(),
      })
      .expect(201);

    const initiationBody = initiationResponse.body as {
      id?: unknown;
    };

    if (typeof initiationBody.id !== 'string') {
      throw new Error('Multipart upload session ID is missing');
    }

    listMultipartUploadPartsMock.mockResolvedValue([
      {
        partNumber: 2,
        etag: '"etag-2"',
        size: 3 * 1024 * 1024,
      },
      {
        partNumber: 1,
        etag: '"etag-1"',
        size: 8 * 1024 * 1024,
      },
    ]);

    const response = await request(app.getHttpServer())
      .get(`/files/multipart/${initiationBody.id}`)
      .set(authorization(owner.accessToken))
      .expect(200);

    const body = response.body as {
      id?: unknown;
      status?: unknown;
      uploadedParts?: unknown;
    };

    expect(body).toMatchObject({
      id: initiationBody.id,
      status: 'UPLOADING',
      uploadedParts: [
        {
          partNumber: 1,
          etag: '"etag-1"',
          size: (8 * 1024 * 1024).toString(),
        },
        {
          partNumber: 2,
          etag: '"etag-2"',
          size: (3 * 1024 * 1024).toString(),
        },
      ],
    });

    const storedParts = await prisma.uploadPart.findMany({
      where: {
        uploadSessionId: initiationBody.id,
      },
      orderBy: {
        partNumber: 'asc',
      },
    });

    expect(storedParts).toMatchObject([
      {
        partNumber: 1,
        etag: '"etag-1"',
        size: BigInt(8 * 1024 * 1024),
      },
      {
        partNumber: 2,
        etag: '"etag-2"',
        size: BigInt(3 * 1024 * 1024),
      },
    ]);

    await request(app.getHttpServer())
      .get(`/files/multipart/${initiationBody.id}`)
      .set(authorization(otherUser.accessToken))
      .expect(404);

    await request(app.getHttpServer())
      .get('/files/multipart/not-a-uuid')
      .set(authorization(owner.accessToken))
      .expect(400);

    await request(app.getHttpServer())
      .get(`/files/multipart/${initiationBody.id}`)
      .expect(401);

    listMultipartUploadPartsMock.mockResolvedValue([
      {
        partNumber: 1,
        etag: '"replaced-etag-1"',
        size: 8 * 1024 * 1024,
      },
    ]);

    await request(app.getHttpServer())
      .get(`/files/multipart/${initiationBody.id}`)
      .set(authorization(owner.accessToken))
      .expect(200);

    const replacedParts = await prisma.uploadPart.findMany({
      where: {
        uploadSessionId: initiationBody.id,
      },
      orderBy: {
        partNumber: 'asc',
      },
    });

    expect(replacedParts).toHaveLength(1);
    expect(replacedParts[0]).toMatchObject({
      partNumber: 1,
      etag: '"replaced-etag-1"',
      size: BigInt(8 * 1024 * 1024),
    });

    expect(listMultipartUploadPartsMock).toHaveBeenCalledTimes(2);
  });

  it('returns stored parts for an expired multipart session', async () => {
    const initiationResponse = await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId: randomUUID(),
        fileName: 'expired-status.bin',
        totalSize: (11 * 1024 * 1024).toString(),
      })
      .expect(201);

    const initiationBody = initiationResponse.body as {
      id?: unknown;
    };

    if (typeof initiationBody.id !== 'string') {
      throw new Error('Multipart upload session ID is missing');
    }

    await prisma.uploadPart.create({
      data: {
        uploadSessionId: initiationBody.id,
        partNumber: 1,
        etag: '"stored-etag-1"',
        size: BigInt(8 * 1024 * 1024),
      },
    });

    await prisma.uploadSession.update({
      where: {
        id: initiationBody.id,
      },
      data: {
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const response = await request(app.getHttpServer())
      .get(`/files/multipart/${initiationBody.id}`)
      .set(authorization(owner.accessToken))
      .expect(200);

    expect(response.body).toMatchObject({
      id: initiationBody.id,
      status: 'EXPIRED',
      uploadedParts: [
        {
          partNumber: 1,
          etag: '"stored-etag-1"',
          size: (8 * 1024 * 1024).toString(),
        },
      ],
    });

    expect(listMultipartUploadPartsMock).not.toHaveBeenCalled();
  });

  it('returns 503 when uploaded multipart parts cannot be listed', async () => {
    const initiationResponse = await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId: randomUUID(),
        fileName: 'status-storage-failure.bin',
        totalSize: (11 * 1024 * 1024).toString(),
      })
      .expect(201);

    const initiationBody = initiationResponse.body as {
      id?: unknown;
    };

    if (typeof initiationBody.id !== 'string') {
      throw new Error('Multipart upload session ID is missing');
    }

    listMultipartUploadPartsMock.mockRejectedValueOnce(
      new Error('Storage is unavailable'),
    );

    await request(app.getHttpServer())
      .get(`/files/multipart/${initiationBody.id}`)
      .set(authorization(owner.accessToken))
      .expect(503);

    const storedParts = await prisma.uploadPart.count({
      where: {
        uploadSessionId: initiationBody.id,
      },
    });

    expect(storedParts).toBe(0);
  });

  it('completes a multipart upload idempotently', async () => {
    const totalSize = 11 * 1024 * 1024;

    const initiationResponse = await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId: randomUUID(),
        fileName: 'completed-multipart.bin',
        mimeType: 'application/octet-stream',
        totalSize: totalSize.toString(),
        folderId: null,
      })
      .expect(201);

    const initiationBody = initiationResponse.body as {
      id?: unknown;
    };

    if (typeof initiationBody.id !== 'string') {
      throw new Error('Multipart upload session ID is missing');
    }

    const sessionBeforeCompletion = await prisma.uploadSession.findUnique({
      where: {
        id: initiationBody.id,
      },
    });

    if (!sessionBeforeCompletion?.multipartUploadId) {
      throw new Error('Multipart upload metadata is missing');
    }

    listMultipartUploadPartsMock.mockResolvedValue([
      {
        partNumber: 1,
        etag: '"complete-etag-1"',
        size: 8 * 1024 * 1024,
      },
      {
        partNumber: 2,
        etag: '"complete-etag-2"',
        size: 3 * 1024 * 1024,
      },
    ]);

    getObjectMetadataMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      size: totalSize,
      contentType: 'application/octet-stream',
      etag: '"completed-object-etag"',
    });

    const completionResponse = await request(app.getHttpServer())
      .post(`/files/multipart/${initiationBody.id}/complete`)
      .set(authorization(owner.accessToken))
      .expect(200);

    const completedFile = completionResponse.body as FileBody;

    expect(completedFile).toMatchObject({
      name: 'completed-multipart.bin',
      ownerId: owner.id,
      folderId: null,
      status: 'PROCESSING',
      mimeType: 'application/octet-stream',
      size: totalSize.toString(),
    });

    expect(completeMultipartUploadMock).toHaveBeenCalledWith({
      objectKey: sessionBeforeCompletion.objectKey,
      uploadId: sessionBeforeCompletion.multipartUploadId,
      parts: [
        {
          partNumber: 1,
          etag: '"complete-etag-1"',
        },
        {
          partNumber: 2,
          etag: '"complete-etag-2"',
        },
      ],
    });

    const completedSession = await prisma.uploadSession.findUnique({
      where: {
        id: initiationBody.id,
      },
    });

    expect(completedSession).toMatchObject({
      status: 'COMPLETED',
      fileId: completedFile.id,
    });

    const completedFileMetadata = await prisma.file.findUnique({
      where: {
        id: completedFile.id,
      },
      select: {
        currentVersion: {
          select: {
            storedObject: {
              select: {
                objectKey: true,
                size: true,
                referenceCount: true,
              },
            },
          },
        },
      },
    });

    expect(completedFileMetadata?.currentVersion?.storedObject).toMatchObject({
      objectKey: sessionBeforeCompletion.objectKey,
      size: BigInt(totalSize),
      referenceCount: 1,
    });

    const repeatedResponse = await request(app.getHttpServer())
      .post(`/files/multipart/${initiationBody.id}/complete`)
      .set(authorization(owner.accessToken))
      .expect(200);

    expect(repeatedResponse.body).toMatchObject({
      id: completedFile.id,
      status: 'PROCESSING',
    });

    expect(completeMultipartUploadMock).toHaveBeenCalledTimes(1);
    expect(listMultipartUploadPartsMock).toHaveBeenCalledTimes(1);
    expect(getObjectMetadataMock).toHaveBeenCalledTimes(2);

    expect(
      await prisma.file.count({
        where: {
          id: completedFile.id,
        },
      }),
    ).toBe(1);

    await request(app.getHttpServer())
      .post(`/files/multipart/${initiationBody.id}/complete`)
      .set(authorization(otherUser.accessToken))
      .expect(404);
  });

  it('uploads a new file version through multipart upload', async () => {
    const originalContent = Buffer.from('Original multipart version content');

    const file = await uploadFile(
      owner.accessToken,
      'multipart-versioned-file.txt',
      originalContent,
    );

    await markFileReady(file.id);

    const originalMetadata = await prisma.file.findUnique({
      where: {
        id: file.id,
      },
      select: {
        id: true,
        name: true,
        currentVersionId: true,
        versions: {
          orderBy: {
            versionNumber: 'asc',
          },
          select: {
            id: true,
            versionNumber: true,
            storedObjectId: true,
          },
        },
      },
    });

    if (
      !originalMetadata ||
      !originalMetadata.currentVersionId ||
      originalMetadata.versions.length !== 1
    ) {
      throw new Error('Original file version metadata is missing');
    }

    const originalVersion = originalMetadata.versions[0];

    if (!originalVersion) {
      throw new Error('Original file version is missing');
    }

    const totalSize = 11 * 1024 * 1024;
    const clientRequestId = randomUUID();

    const foreignResponse = await request(app.getHttpServer())
      .post(`/files/${file.id}/versions/multipart`)
      .set(authorization(otherUser.accessToken))
      .send({
        clientRequestId: randomUUID(),
        fileName: 'foreign-version.bin',
        mimeType: 'application/octet-stream',
        totalSize: totalSize.toString(),
      })
      .expect(404);

    expect(foreignResponse.body).toBeDefined();

    const initiationResponse = await request(app.getHttpServer())
      .post(`/files/${file.id}/versions/multipart`)
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId,
        fileName: 'multipart-version-v2.bin',
        mimeType: 'application/octet-stream',
        totalSize: totalSize.toString(),
      })
      .expect(201);

    const initiationBody = initiationResponse.body as {
      id?: unknown;
      fileId?: unknown;
      status?: unknown;
      folderId?: unknown;
      totalParts?: unknown;
    };

    expect(initiationBody).toMatchObject({
      fileId: file.id,
      status: 'UPLOADING',
      folderId: null,
      totalParts: 2,
    });

    if (typeof initiationBody.id !== 'string') {
      throw new Error('Multipart version upload session ID is missing');
    }

    const sessionBeforeCompletion = await prisma.uploadSession.findUnique({
      where: {
        id: initiationBody.id,
      },
    });

    if (!sessionBeforeCompletion?.multipartUploadId) {
      throw new Error('Multipart version upload metadata is missing');
    }

    expect(sessionBeforeCompletion).toMatchObject({
      ownerId: owner.id,
      fileId: file.id,
      originalName: 'multipart-version-v2.bin',
      mimeType: 'application/octet-stream',
      totalSize: BigInt(totalSize),
      status: 'UPLOADING',
    });

    expect(sessionBeforeCompletion.objectKey).toMatch(
      new RegExp(`^users/${owner.id}/objects/`),
    );

    listMultipartUploadPartsMock.mockResolvedValue([
      {
        partNumber: 1,
        etag: '"version-etag-1"',
        size: 8 * 1024 * 1024,
      },
      {
        partNumber: 2,
        etag: '"version-etag-2"',
        size: 3 * 1024 * 1024,
      },
    ]);

    getObjectMetadataMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      size: totalSize,
      contentType: 'application/octet-stream',
      etag: '"version-completed-object"',
    });

    const completionResponse = await request(app.getHttpServer())
      .post(`/files/multipart/${initiationBody.id}/complete`)
      .set(authorization(owner.accessToken))
      .expect(200);

    const completedFile = completionResponse.body as FileBody;

    expect(completedFile).toMatchObject({
      id: file.id,
      name: 'multipart-versioned-file.txt',
      ownerId: owner.id,
      folderId: null,
      status: 'PROCESSING',
      mimeType: 'application/octet-stream',
      size: totalSize.toString(),
    });

    expect(completeMultipartUploadMock).toHaveBeenCalledWith({
      objectKey: sessionBeforeCompletion.objectKey,
      uploadId: sessionBeforeCompletion.multipartUploadId,
      parts: [
        {
          partNumber: 1,
          etag: '"version-etag-1"',
        },
        {
          partNumber: 2,
          etag: '"version-etag-2"',
        },
      ],
    });

    const completedSession = await prisma.uploadSession.findUnique({
      where: {
        id: initiationBody.id,
      },
      select: {
        status: true,
        fileId: true,
      },
    });

    expect(completedSession).toEqual({
      status: 'COMPLETED',
      fileId: file.id,
    });

    const updatedMetadata = await prisma.file.findUnique({
      where: {
        id: file.id,
      },
      select: {
        id: true,
        name: true,
        status: true,
        currentVersionId: true,
        versions: {
          orderBy: {
            versionNumber: 'asc',
          },
          select: {
            id: true,
            versionNumber: true,
            originalName: true,
            mimeType: true,
            size: true,
            storedObject: {
              select: {
                id: true,
                objectKey: true,
                size: true,
                referenceCount: true,
              },
            },
          },
        },
      },
    });

    if (!updatedMetadata) {
      throw new Error('Updated file metadata is missing');
    }

    expect(updatedMetadata.id).toBe(file.id);
    expect(updatedMetadata.name).toBe('multipart-versioned-file.txt');
    expect(updatedMetadata.status).toBe('PROCESSING');
    expect(updatedMetadata.versions).toHaveLength(2);

    const firstVersion = updatedMetadata.versions[0];
    const secondVersion = updatedMetadata.versions[1];

    if (!firstVersion || !secondVersion) {
      throw new Error('Expected two file versions');
    }

    expect(firstVersion).toMatchObject({
      id: originalVersion.id,
      versionNumber: 1,
      storedObject: {
        id: originalVersion.storedObjectId,
      },
    });

    expect(secondVersion).toMatchObject({
      versionNumber: 2,
      originalName: 'multipart-version-v2.bin',
      mimeType: 'application/octet-stream',
      size: BigInt(totalSize),
      storedObject: {
        objectKey: sessionBeforeCompletion.objectKey,
        size: BigInt(totalSize),
        referenceCount: 1,
      },
    });

    expect(secondVersion.storedObject.id).not.toBe(
      originalVersion.storedObjectId,
    );

    expect(updatedMetadata.currentVersionId).toBe(secondVersion.id);

    expect(
      await prisma.file.count({
        where: {
          id: file.id,
        },
      }),
    ).toBe(1);

    const outboxEvents = await prisma.outboxEvent.findMany({
      where: {
        aggregateId: file.id,
        type: 'PROCESS_FILE',
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    expect(outboxEvents).toHaveLength(2);

    expect(outboxEvents[1]?.payload).toMatchObject({
      fileId: file.id,
      versionId: secondVersion.id,
      storedObjectId: secondVersion.storedObject.id,
    });

    const repeatedResponse = await request(app.getHttpServer())
      .post(`/files/multipart/${initiationBody.id}/complete`)
      .set(authorization(owner.accessToken))
      .expect(200);

    expect(repeatedResponse.body).toMatchObject({
      id: file.id,
      status: 'PROCESSING',
    });

    expect(completeMultipartUploadMock).toHaveBeenCalledTimes(1);
    expect(listMultipartUploadPartsMock).toHaveBeenCalledTimes(1);

    expect(
      await prisma.fileVersion.count({
        where: {
          fileId: file.id,
        },
      }),
    ).toBe(2);

    await request(app.getHttpServer())
      .post(`/files/multipart/${initiationBody.id}/complete`)
      .set(authorization(otherUser.accessToken))
      .expect(404);
  });

  it('allows VIEWER to read files through folder and direct file grants', async () => {
    const sharedFolderId = await createFolder(
      owner.accessToken,
      'Shared Files Folder',
    );

    const inheritedFile = await uploadFile(
      owner.accessToken,
      'inherited-access.txt',
      Buffer.from('Inherited access content'),
      sharedFolderId,
    );

    const directFile = await uploadFile(
      owner.accessToken,
      'direct-access.txt',
      Buffer.from('Direct access content'),
    );

    const inaccessibleFile = await uploadFile(
      owner.accessToken,
      'no-access.txt',
      Buffer.from('No access content'),
    );

    await markFileReady(inheritedFile.id);
    await markFileReady(directFile.id);
    await markFileReady(inaccessibleFile.id);

    const inheritedMetadata = await prisma.file.findUnique({
      where: {
        id: inheritedFile.id,
      },
      select: {
        currentVersion: {
          select: {
            id: true,
          },
        },
      },
    });

    const directMetadata = await prisma.file.findUnique({
      where: {
        id: directFile.id,
      },
      select: {
        currentVersion: {
          select: {
            id: true,
          },
        },
      },
    });

    if (!inheritedMetadata?.currentVersion || !directMetadata?.currentVersion) {
      throw new Error('Test file version metadata is missing');
    }

    /*
     * Для preview вручную имитируем уже завершённую
     * обработку изображения worker-ом.
     */
    await prisma.fileVersion.update({
      where: {
        id: directMetadata.currentVersion.id,
      },
      data: {
        previewObjectKey: `users/${owner.id}/previews/direct-access.webp`,
        previewMimeType: 'image/webp',
        previewWidth: 320,
        previewHeight: 200,
      },
    });

    /*
     * Первый доступ наследуется от папки.
     */
    await prisma.folderAccessGrant.create({
      data: {
        folderId: sharedFolderId,
        userId: otherUser.id,
        role: 'VIEWER',
      },
    });

    /*
     * Второй доступ выдан непосредственно файлу.
     */
    await prisma.fileAccessGrant.create({
      data: {
        fileId: directFile.id,
        userId: otherUser.id,
        role: 'VIEWER',
      },
    });

    /*
     * VIEWER shared-папки видит файлы внутри неё.
     */
    const sharedFolderFiles = await request(app.getHttpServer())
      .get('/files')
      .query({
        folderId: sharedFolderId,
      })
      .set(authorization(otherUser.accessToken))
      .expect(200);

    expect(sharedFolderFiles.body).toEqual([
      expect.objectContaining({
        id: inheritedFile.id,
        name: 'inherited-access.txt',
        ownerId: owner.id,
        folderId: sharedFolderId,
      }),
    ]);

    /*
     * Direct FileAccessGrant пока не делает файл
     * видимым в root list.
     * Shared with me появится в 5.7.
     */
    const otherRootFiles = await request(app.getHttpServer())
      .get('/files')
      .set(authorization(otherUser.accessToken))
      .expect(200);

    expect(otherRootFiles.body).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: directFile.id,
        }),
      ]),
    );

    /*
     * Унаследованный VIEWER может скачать файл.
     */
    await request(app.getHttpServer())
      .get(`/files/${inheritedFile.id}/download`)
      .set(authorization(otherUser.accessToken))
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          url: 'https://storage.test/download',
        });
      });

    /*
     * И посмотреть историю версий.
     */
    const inheritedVersions = await request(app.getHttpServer())
      .get(`/files/${inheritedFile.id}/versions`)
      .set(authorization(otherUser.accessToken))
      .expect(200);

    expect(inheritedVersions.body).toEqual([
      expect.objectContaining({
        id: inheritedMetadata.currentVersion.id,
        versionNumber: 1,
        isCurrent: true,
      }),
    ]);

    /*
     * И скачать конкретную историческую версию.
     */
    await request(app.getHttpServer())
      .get(
        `/files/${inheritedFile.id}/versions/${inheritedMetadata.currentVersion.id}/download`,
      )
      .set(authorization(otherUser.accessToken))
      .expect(200);

    /*
     * Direct FileAccessGrant тоже разрешает
     * операции чтения конкретного файла.
     */
    await request(app.getHttpServer())
      .get(`/files/${directFile.id}/download`)
      .set(authorization(otherUser.accessToken))
      .expect(200);

    const directVersions = await request(app.getHttpServer())
      .get(`/files/${directFile.id}/versions`)
      .set(authorization(otherUser.accessToken))
      .expect(200);

    expect(directVersions.body).toEqual([
      expect.objectContaining({
        id: directMetadata.currentVersion.id,
        versionNumber: 1,
        isCurrent: true,
      }),
    ]);

    /*
     * Preview также является VIEWER-операцией.
     */
    const previewResponse = await request(app.getHttpServer())
      .get(`/files/${directFile.id}/preview`)
      .set(authorization(otherUser.accessToken))
      .expect(200);

    expect(previewResponse.body).toMatchObject({
      url: 'https://storage.test/download',
      mimeType: 'image/webp',
      width: 320,
      height: 200,
    });

    /*
     * Файл без direct или inherited grant
     * остаётся полностью недоступным.
     */
    await request(app.getHttpServer())
      .get(`/files/${inaccessibleFile.id}/download`)
      .set(authorization(otherUser.accessToken))
      .expect(404);

    await request(app.getHttpServer())
      .get(`/files/${inaccessibleFile.id}/versions`)
      .set(authorization(otherUser.accessToken))
      .expect(404);
  });

  it('allows EDITOR to upload, rename and move files inside shared folders', async () => {
    const sourceFolderId = await createFolder(
      owner.accessToken,
      'Editor File Source',
    );

    const destinationFolderId = await createFolder(
      owner.accessToken,
      'Editor File Destination',
    );

    /*
     * Начинаем с VIEWER.
     */
    const sourceGrant = await prisma.folderAccessGrant.create({
      data: {
        folderId: sourceFolderId,
        userId: otherUser.id,
        role: 'VIEWER',
      },
      select: {
        id: true,
      },
    });

    /*
     * VIEWER не может загружать файл
     * в shared folder.
     */
    await request(app.getHttpServer())
      .post('/files/upload')
      .set(authorization(otherUser.accessToken))
      .field('folderId', sourceFolderId)
      .attach('file', Buffer.from('Viewer must not upload'), {
        filename: 'viewer-denied.txt',
        contentType: 'text/plain',
      })
      .expect(403);

    /*
     * Повышаем роль до EDITOR.
     */
    await prisma.folderAccessGrant.update({
      where: {
        id: sourceGrant.id,
      },
      data: {
        role: 'EDITOR',
      },
    });

    await prisma.folderAccessGrant.create({
      data: {
        folderId: destinationFolderId,
        userId: otherUser.id,
        role: 'EDITOR',
      },
    });

    /*
     * EDITOR загружает файл в пространство owner.
     */
    const uploadedFile = await uploadFile(
      otherUser.accessToken,
      'editor-upload.txt',
      Buffer.from('Uploaded by editor'),
      sourceFolderId,
    );

    expect(uploadedFile).toMatchObject({
      name: 'editor-upload.txt',
      ownerId: owner.id,
      folderId: sourceFolderId,
      status: 'PROCESSING',
    });

    /*
     * Physical object тоже должен находиться
     * в namespace владельца shared tree.
     */
    const uploadedMetadata = await prisma.file.findUnique({
      where: {
        id: uploadedFile.id,
      },
      select: {
        currentVersion: {
          select: {
            storedObject: {
              select: {
                objectKey: true,
              },
            },
          },
        },
      },
    });

    if (!uploadedMetadata?.currentVersion) {
      throw new Error('Uploaded file version metadata is missing');
    }

    expect(uploadedMetadata.currentVersion.storedObject.objectKey).toMatch(
      new RegExp(`^users/${owner.id}/objects/`),
    );

    /*
     * EDITOR может rename даже пока
     * файл находится в PROCESSING.
     */
    const renameResponse = await request(app.getHttpServer())
      .patch(`/files/${uploadedFile.id}`)
      .set(authorization(otherUser.accessToken))
      .send({
        name: 'renamed-by-editor.txt',
      })
      .expect(200);

    expect(renameResponse.body).toMatchObject({
      id: uploadedFile.id,
      name: 'renamed-by-editor.txt',
      ownerId: owner.id,
      folderId: sourceFolderId,
    });

    /*
     * Move разрешён только READY file.
     */
    await markFileReady(uploadedFile.id);

    const moveResponse = await request(app.getHttpServer())
      .patch(`/files/${uploadedFile.id}/move`)
      .set(authorization(otherUser.accessToken))
      .send({
        folderId: destinationFolderId,
      })
      .expect(200);

    expect(moveResponse.body).toMatchObject({
      id: uploadedFile.id,
      ownerId: owner.id,
      folderId: destinationFolderId,
    });

    /*
     * После move EDITOR по destination grant
     * продолжает видеть файл.
     */
    const destinationFiles = await request(app.getHttpServer())
      .get('/files')
      .query({
        folderId: destinationFolderId,
      })
      .set(authorization(otherUser.accessToken))
      .expect(200);

    expect(destinationFiles.body).toEqual([
      expect.objectContaining({
        id: uploadedFile.id,
        ownerId: owner.id,
        folderId: destinationFolderId,
      }),
    ]);

    /*
     * Но чужой shared file нельзя вынести
     * в root пользователя-редактора.
     */
    await request(app.getHttpServer())
      .patch(`/files/${uploadedFile.id}/move`)
      .set(authorization(otherUser.accessToken))
      .send({
        folderId: null,
      })
      .expect(403);

    /*
     * Delete всё ещё OWNER-only.
     */
    await request(app.getHttpServer())
      .delete(`/files/${uploadedFile.id}`)
      .set(authorization(otherUser.accessToken))
      .expect(404);
  });

  it('allows EDITOR to use multipart uploads for shared resources', async () => {
    const sharedFolderId = await createFolder(
      owner.accessToken,
      'Shared Multipart Folder',
    );

    const targetFile = await uploadFile(
      owner.accessToken,
      'shared-version-target.txt',
      Buffer.from('Version one'),
      sharedFolderId,
    );

    await markFileReady(targetFile.id);

    const grant = await prisma.folderAccessGrant.create({
      data: {
        folderId: sharedFolderId,
        userId: otherUser.id,
        role: 'VIEWER',
      },
      select: {
        id: true,
      },
    });

    const totalSize = 11 * 1024 * 1024;

    /*
     * VIEWER не может начать обычную
     * multipart-загрузку в shared folder.
     */
    await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(otherUser.accessToken))
      .send({
        clientRequestId: randomUUID(),
        fileName: 'viewer-denied.bin',
        mimeType: 'application/octet-stream',
        totalSize: totalSize.toString(),
        folderId: sharedFolderId,
      })
      .expect(403);

    /*
     * VIEWER также не может загружать
     * multipart-версию существующего файла.
     */
    await request(app.getHttpServer())
      .post(`/files/${targetFile.id}/versions/multipart`)
      .set(authorization(otherUser.accessToken))
      .send({
        clientRequestId: randomUUID(),
        fileName: 'viewer-version-denied.bin',
        mimeType: 'application/octet-stream',
        totalSize: totalSize.toString(),
      })
      .expect(403);

    /*
     * Повышаем пользователя до EDITOR.
     */
    await prisma.folderAccessGrant.update({
      where: {
        id: grant.id,
      },
      data: {
        role: 'EDITOR',
      },
    });

    /*
     * Обычная multipart-загрузка
     * в shared folder.
     */
    const uploadRequestId = randomUUID();

    const initiationResponse = await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(otherUser.accessToken))
      .send({
        clientRequestId: uploadRequestId,
        fileName: 'editor-large-file.bin',
        mimeType: 'application/octet-stream',
        totalSize: totalSize.toString(),
        folderId: sharedFolderId,
      })
      .expect(201);

    const initiationBody = initiationResponse.body as {
      id?: unknown;
    };

    if (typeof initiationBody.id !== 'string') {
      throw new Error('Multipart upload session ID is missing');
    }

    const session = await prisma.uploadSession.findUnique({
      where: {
        id: initiationBody.id,
      },
    });

    if (!session) {
      throw new Error('Multipart upload session is missing');
    }

    /*
     * Session принадлежит EDITOR,
     * но physical object — owner shared tree.
     */
    expect(session).toMatchObject({
      ownerId: otherUser.id,
      folderId: sharedFolderId,
      fileId: null,
      status: 'UPLOADING',
    });

    expect(session.objectKey).toMatch(
      new RegExp(`^users/${owner.id}/objects/`),
    );

    listMultipartUploadPartsMock.mockResolvedValue([
      {
        partNumber: 1,
        etag: '"shared-editor-etag-1"',
        size: 8 * 1024 * 1024,
      },
      {
        partNumber: 2,
        etag: '"shared-editor-etag-2"',
        size: 3 * 1024 * 1024,
      },
    ]);

    getObjectMetadataMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      size: totalSize,
      contentType: 'application/octet-stream',
    });

    const completeResponse = await request(app.getHttpServer())
      .post(`/files/multipart/${session.id}/complete`)
      .set(authorization(otherUser.accessToken))
      .expect(200);

    const completedFile = completeResponse.body as FileBody;

    expect(completedFile).toMatchObject({
      name: 'editor-large-file.bin',
      ownerId: owner.id,
      folderId: sharedFolderId,
      status: 'PROCESSING',
    });

    const completedMetadata = await prisma.file.findUnique({
      where: {
        id: completedFile.id,
      },
      select: {
        ownerId: true,
        currentVersion: {
          select: {
            storedObject: {
              select: {
                objectKey: true,
              },
            },
          },
        },
      },
    });

    expect(completedMetadata?.ownerId).toBe(owner.id);

    expect(completedMetadata?.currentVersion?.storedObject.objectKey).toMatch(
      new RegExp(`^users/${owner.id}/objects/`),
    );

    /*
     * Теперь multipart новой версии
     * существующего shared-файла.
     */
    const versionRequestId = randomUUID();

    const versionInitiationResponse = await request(app.getHttpServer())
      .post(`/files/${targetFile.id}/versions/multipart`)
      .set(authorization(otherUser.accessToken))
      .send({
        clientRequestId: versionRequestId,
        fileName: 'editor-large-version.bin',
        mimeType: 'application/octet-stream',
        totalSize: totalSize.toString(),
      })
      .expect(201);

    const versionInitiationBody = versionInitiationResponse.body as {
      id?: unknown;
    };

    if (typeof versionInitiationBody.id !== 'string') {
      throw new Error('Multipart version session ID is missing');
    }

    const versionSession = await prisma.uploadSession.findUnique({
      where: {
        id: versionInitiationBody.id,
      },
    });

    if (!versionSession) {
      throw new Error('Multipart version session is missing');
    }

    expect(versionSession).toMatchObject({
      ownerId: otherUser.id,
      fileId: targetFile.id,
      folderId: sharedFolderId,
      status: 'UPLOADING',
    });

    expect(versionSession.objectKey).toMatch(
      new RegExp(`^users/${owner.id}/objects/`),
    );

    listMultipartUploadPartsMock.mockResolvedValue([
      {
        partNumber: 1,
        etag: '"shared-version-etag-1"',
        size: 8 * 1024 * 1024,
      },
      {
        partNumber: 2,
        etag: '"shared-version-etag-2"',
        size: 3 * 1024 * 1024,
      },
    ]);

    getObjectMetadataMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      size: totalSize,
      contentType: 'application/octet-stream',
    });

    const versionCompleteResponse = await request(app.getHttpServer())
      .post(`/files/multipart/${versionSession.id}/complete`)
      .set(authorization(otherUser.accessToken))
      .expect(200);

    expect(versionCompleteResponse.body).toMatchObject({
      id: targetFile.id,
      ownerId: owner.id,
      folderId: sharedFolderId,
      status: 'PROCESSING',
    });

    /*
     * Logical File не поменял owner,
     * но получил V2.
     */
    const versionedFile = await prisma.file.findUnique({
      where: {
        id: targetFile.id,
      },
      select: {
        ownerId: true,
        currentVersionId: true,
        versions: {
          orderBy: {
            versionNumber: 'asc',
          },
          select: {
            id: true,
            versionNumber: true,
            storedObject: {
              select: {
                objectKey: true,
              },
            },
          },
        },
      },
    });

    expect(versionedFile?.ownerId).toBe(owner.id);

    expect(
      versionedFile?.versions.map((version) => version.versionNumber),
    ).toEqual([1, 2]);

    const secondVersion = versionedFile?.versions[1];

    expect(secondVersion?.id).toBe(versionedFile?.currentVersionId);

    expect(secondVersion?.storedObject.objectKey).toMatch(
      new RegExp(`^users/${owner.id}/objects/`),
    );
  });

  it('restores an old file version as a new version', async () => {
    const originalContent = Buffer.from('Restore original content');
    const updatedContent = Buffer.from('Restore updated content');

    const file = await uploadFile(
      owner.accessToken,
      'restore-file.txt',
      originalContent,
    );

    await markFileReady(file.id);

    await request(app.getHttpServer())
      .post(`/files/${file.id}/versions`)
      .set(authorization(owner.accessToken))
      .attach('file', updatedContent, {
        filename: 'restore-file-v2.txt',
        contentType: 'text/plain',
      })
      .expect(201);

    await markFileReady(file.id);

    const metadataBeforeRestore = await prisma.file.findUnique({
      where: {
        id: file.id,
      },
      select: {
        currentVersionId: true,
        versions: {
          orderBy: {
            versionNumber: 'asc',
          },
          select: {
            id: true,
            versionNumber: true,
            originalName: true,
            mimeType: true,
            size: true,
            storedObject: {
              select: {
                id: true,
                referenceCount: true,
              },
            },
          },
        },
      },
    });

    if (
      !metadataBeforeRestore?.currentVersionId ||
      metadataBeforeRestore.versions.length !== 2
    ) {
      throw new Error('File version metadata is missing');
    }

    const firstVersion = metadataBeforeRestore.versions[0];
    const secondVersion = metadataBeforeRestore.versions[1];

    if (!firstVersion || !secondVersion) {
      throw new Error('Expected two file versions');
    }

    expect(firstVersion).toMatchObject({
      versionNumber: 1,
      originalName: 'restore-file.txt',
      mimeType: 'text/plain',
      size: BigInt(originalContent.length),
    });

    expect(secondVersion).toMatchObject({
      versionNumber: 2,
      originalName: 'restore-file-v2.txt',
      mimeType: 'text/plain',
      size: BigInt(updatedContent.length),
    });

    expect(metadataBeforeRestore.currentVersionId).toBe(secondVersion.id);

    expect(firstVersion.storedObject.referenceCount).toBe(1);
    expect(secondVersion.storedObject.referenceCount).toBe(1);

    putObjectMock.mockClear();

    const restoreResponse = await request(app.getHttpServer())
      .post(`/files/${file.id}/versions/${firstVersion.id}/restore`)
      .set(authorization(owner.accessToken))
      .expect(201);

    const restoredFile = restoreResponse.body as FileBody;

    expect(restoredFile).toMatchObject({
      id: file.id,
      name: 'restore-file.txt',
      ownerId: owner.id,
      folderId: null,
      status: 'PROCESSING',
      mimeType: 'text/plain',
      size: originalContent.length.toString(),
    });

    /*
     * Restore reuses the existing StoredObject.
     * No new bytes should be uploaded to object storage.
     */
    expect(putObjectMock).not.toHaveBeenCalled();

    const metadataAfterRestore = await prisma.file.findUnique({
      where: {
        id: file.id,
      },
      select: {
        currentVersionId: true,
        status: true,
        versions: {
          orderBy: {
            versionNumber: 'asc',
          },
          select: {
            id: true,
            versionNumber: true,
            originalName: true,
            mimeType: true,
            size: true,
            storedObject: {
              select: {
                id: true,
                referenceCount: true,
              },
            },
          },
        },
      },
    });

    if (!metadataAfterRestore) {
      throw new Error('Restored file metadata is missing');
    }

    expect(metadataAfterRestore.status).toBe('PROCESSING');
    expect(metadataAfterRestore.versions).toHaveLength(3);

    const restoredFirstVersion = metadataAfterRestore.versions[0];
    const restoredSecondVersion = metadataAfterRestore.versions[1];
    const thirdVersion = metadataAfterRestore.versions[2];

    if (!restoredFirstVersion || !restoredSecondVersion || !thirdVersion) {
      throw new Error('Expected three file versions');
    }

    /*
     * Existing history must remain unchanged.
     */
    expect(restoredFirstVersion.id).toBe(firstVersion.id);
    expect(restoredFirstVersion.versionNumber).toBe(1);

    expect(restoredSecondVersion.id).toBe(secondVersion.id);
    expect(restoredSecondVersion.versionNumber).toBe(2);

    /*
     * Restore creates a NEW immutable version.
     */
    expect(thirdVersion).toMatchObject({
      versionNumber: 3,
      originalName: 'restore-file.txt',
      mimeType: 'text/plain',
      size: BigInt(originalContent.length),
    });

    expect(thirdVersion.id).not.toBe(firstVersion.id);
    expect(thirdVersion.id).not.toBe(secondVersion.id);

    /*
     * V1 and V3 share the same physical object.
     */
    expect(thirdVersion.storedObject.id).toBe(firstVersion.storedObject.id);

    expect(thirdVersion.storedObject.id).not.toBe(
      secondVersion.storedObject.id,
    );

    expect(restoredFirstVersion.storedObject.referenceCount).toBe(2);
    expect(thirdVersion.storedObject.referenceCount).toBe(2);

    expect(metadataAfterRestore.currentVersionId).toBe(thirdVersion.id);

    const outboxEvents = await prisma.outboxEvent.findMany({
      where: {
        aggregateId: file.id,
        type: 'PROCESS_FILE',
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    expect(outboxEvents).toHaveLength(3);

    expect(outboxEvents[2]?.payload).toMatchObject({
      fileId: file.id,
      versionId: thirdVersion.id,
      storedObjectId: firstVersion.storedObject.id,
    });

    /*
     * Another user cannot restore this file.
     */
    await request(app.getHttpServer())
      .post(`/files/${file.id}/versions/${firstVersion.id}/restore`)
      .set(authorization(otherUser.accessToken))
      .expect(404);

    /*
     * After processing finishes, trying to restore the already-current
     * version must be rejected.
     */
    await markFileReady(file.id);

    await request(app.getHttpServer())
      .post(`/files/${file.id}/versions/${thirdVersion.id}/restore`)
      .set(authorization(owner.accessToken))
      .expect(409);

    await request(app.getHttpServer())
      .post(`/files/not-a-uuid/versions/${firstVersion.id}/restore`)
      .set(authorization(owner.accessToken))
      .expect(400);

    await request(app.getHttpServer())
      .post(`/files/${file.id}/versions/not-a-uuid/restore`)
      .set(authorization(owner.accessToken))
      .expect(400);
  });

  it('uses direct file share before inherited folder access', async () => {
    const targetUser = await prisma.user.findUnique({
      where: {
        id: otherUser.id,
      },
      select: {
        email: true,
      },
    });

    if (!targetUser) {
      throw new Error('Target user is missing');
    }

    const folderId = await createFolder(
      owner.accessToken,
      'File Share Override Folder',
    );

    const file = await uploadFile(
      owner.accessToken,
      'shared-override.txt',
      Buffer.from('Shared override content'),
      folderId,
    );

    await markFileReady(file.id);

    /*
     * Сначала выдаём EDITOR на всю папку.
     */
    await request(app.getHttpServer())
      .post(`/folders/${folderId}/shares`)
      .set(authorization(owner.accessToken))
      .send({
        email: targetUser.email,
        role: 'EDITOR',
      })
      .expect(201);

    /*
     * Inherited EDITOR позволяет менять файл.
     */
    await request(app.getHttpServer())
      .patch(`/files/${file.id}`)
      .set(authorization(otherUser.accessToken))
      .send({
        name: 'renamed-by-inherited-editor.txt',
      })
      .expect(200);

    /*
     * Теперь OWNER создаёт direct VIEWER
     * именно на этот файл.
     */
    const createShareResponse = await request(app.getHttpServer())
      .post(`/files/${file.id}/shares`)
      .set(authorization(owner.accessToken))
      .send({
        email: targetUser.email,
        role: 'VIEWER',
      })
      .expect(201);

    const createdShare = createShareResponse.body as {
      id?: unknown;
      email?: unknown;
      role?: unknown;
    };

    expect(createdShare).toMatchObject({
      email: targetUser.email,
      role: 'VIEWER',
    });

    if (typeof createdShare.id !== 'string') {
      throw new Error('File share ID is missing');
    }

    const grantId = createdShare.id;

    /*
     * Direct VIEWER должен перекрыть
     * inherited EDITOR.
     */
    await request(app.getHttpServer())
      .patch(`/files/${file.id}`)
      .set(authorization(otherUser.accessToken))
      .send({
        name: 'viewer-must-not-rename.txt',
      })
      .expect(403);

    /*
     * Но read остаётся разрешён.
     */
    await request(app.getHttpServer())
      .get(`/files/${file.id}/download`)
      .set(authorization(otherUser.accessToken))
      .expect(200);

    /*
     * VIEWER/EDITOR не управляют sharing.
     */
    await request(app.getHttpServer())
      .get(`/files/${file.id}/shares`)
      .set(authorization(otherUser.accessToken))
      .expect(403);

    /*
     * OWNER видит direct grant.
     */
    const sharesResponse = await request(app.getHttpServer())
      .get(`/files/${file.id}/shares`)
      .set(authorization(owner.accessToken))
      .expect(200);

    expect(sharesResponse.body).toEqual([
      expect.objectContaining({
        id: grantId,
        email: targetUser.email,
        role: 'VIEWER',
      }),
    ]);

    /*
     * Повторный direct grant запрещён.
     */
    await request(app.getHttpServer())
      .post(`/files/${file.id}/shares`)
      .set(authorization(owner.accessToken))
      .send({
        email: targetUser.email,
        role: 'EDITOR',
      })
      .expect(409);

    /*
     * OWNER отзывает direct VIEWER.
     */
    await request(app.getHttpServer())
      .delete(`/files/${file.id}/shares/${grantId}`)
      .set(authorization(owner.accessToken))
      .expect(204);

    /*
     * После удаления direct override
     * снова начинает работать inherited EDITOR.
     */
    await request(app.getHttpServer())
      .patch(`/files/${file.id}`)
      .set(authorization(otherUser.accessToken))
      .send({
        name: 'renamed-after-direct-revoke.txt',
      })
      .expect(200);

    const sharesAfterRevoke = await request(app.getHttpServer())
      .get(`/files/${file.id}/shares`)
      .set(authorization(owner.accessToken))
      .expect(200);

    expect(sharesAfterRevoke.body).toEqual([]);
  });

  it('returns an incomplete multipart session to uploading state', async () => {
    const initiationResponse = await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId: randomUUID(),
        fileName: 'incomplete-multipart.bin',
        totalSize: (11 * 1024 * 1024).toString(),
      })
      .expect(201);

    const initiationBody = initiationResponse.body as {
      id?: unknown;
    };

    if (typeof initiationBody.id !== 'string') {
      throw new Error('Multipart upload session ID is missing');
    }

    listMultipartUploadPartsMock.mockResolvedValue([
      {
        partNumber: 1,
        etag: '"incomplete-etag-1"',
        size: 8 * 1024 * 1024,
      },
    ]);

    await request(app.getHttpServer())
      .post(`/files/multipart/${initiationBody.id}/complete`)
      .set(authorization(owner.accessToken))
      .expect(409);

    const incompleteSession = await prisma.uploadSession.findUnique({
      where: {
        id: initiationBody.id,
      },
      select: {
        status: true,
        fileId: true,
      },
    });

    expect(incompleteSession).toEqual({
      status: 'UPLOADING',
      fileId: null,
    });

    expect(completeMultipartUploadMock).not.toHaveBeenCalled();

    expect(
      await prisma.file.count({
        where: {
          uploads: {
            some: {
              id: initiationBody.id,
            },
          },
        },
      }),
    ).toBe(0);
  });

  it('recovers completion when the object already exists in storage', async () => {
    const totalSize = 11 * 1024 * 1024;

    const initiationResponse = await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId: randomUUID(),
        fileName: 'recovered-multipart.bin',
        mimeType: 'application/octet-stream',
        totalSize: totalSize.toString(),
      })
      .expect(201);

    const initiationBody = initiationResponse.body as {
      id?: unknown;
    };

    if (typeof initiationBody.id !== 'string') {
      throw new Error('Multipart upload session ID is missing');
    }

    await prisma.uploadSession.update({
      where: {
        id: initiationBody.id,
      },
      data: {
        status: 'COMPLETING',
        updatedAt: new Date(Date.now() - 60_000),
      },
    });

    getObjectMetadataMock.mockResolvedValueOnce({
      size: totalSize,
      contentType: 'application/octet-stream',
      etag: '"recovered-object-etag"',
    });

    const response = await request(app.getHttpServer())
      .post(`/files/multipart/${initiationBody.id}/complete`)
      .set(authorization(owner.accessToken))
      .expect(200);

    const recoveredFile = response.body as FileBody;

    expect(recoveredFile).toMatchObject({
      name: 'recovered-multipart.bin',
      ownerId: owner.id,
      status: 'PROCESSING',
      size: totalSize.toString(),
    });

    expect(listMultipartUploadPartsMock).not.toHaveBeenCalled();
    expect(completeMultipartUploadMock).not.toHaveBeenCalled();
    expect(getObjectMetadataMock).toHaveBeenCalledTimes(1);

    const recoveredSession = await prisma.uploadSession.findUnique({
      where: {
        id: initiationBody.id,
      },
      select: {
        status: true,
        fileId: true,
      },
    });

    expect(recoveredSession).toEqual({
      status: 'COMPLETED',
      fileId: recoveredFile.id,
    });
  });

  it('aborts a multipart upload idempotently', async () => {
    const initiationResponse = await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId: randomUUID(),
        fileName: 'abort-multipart.bin',
        totalSize: (11 * 1024 * 1024).toString(),
      })
      .expect(201);

    const initiationBody = initiationResponse.body as {
      id?: unknown;
    };

    if (typeof initiationBody.id !== 'string') {
      throw new Error('Multipart upload session ID is missing');
    }

    const sessionBeforeAbort = await prisma.uploadSession.findUnique({
      where: {
        id: initiationBody.id,
      },
    });

    if (!sessionBeforeAbort?.multipartUploadId) {
      throw new Error('Multipart upload metadata is missing');
    }

    await request(app.getHttpServer())
      .delete(`/files/multipart/${initiationBody.id}`)
      .set(authorization(owner.accessToken))
      .expect(204);

    expect(abortMultipartUploadMock).toHaveBeenCalledWith({
      objectKey: sessionBeforeAbort.objectKey,
      uploadId: sessionBeforeAbort.multipartUploadId,
    });

    const abortedSession = await prisma.uploadSession.findUnique({
      where: {
        id: initiationBody.id,
      },
      select: {
        status: true,
        fileId: true,
      },
    });

    expect(abortedSession).toEqual({
      status: 'ABORTED',
      fileId: null,
    });

    await request(app.getHttpServer())
      .delete(`/files/multipart/${initiationBody.id}`)
      .set(authorization(owner.accessToken))
      .expect(204);

    expect(abortMultipartUploadMock).toHaveBeenCalledTimes(1);

    await request(app.getHttpServer())
      .delete(`/files/multipart/${initiationBody.id}`)
      .set(authorization(otherUser.accessToken))
      .expect(404);

    await request(app.getHttpServer())
      .delete('/files/multipart/not-a-uuid')
      .set(authorization(owner.accessToken))
      .expect(400);

    await request(app.getHttpServer())
      .delete(`/files/multipart/${initiationBody.id}`)
      .expect(401);

    expect(
      await prisma.file.count({
        where: {
          uploads: {
            some: {
              id: initiationBody.id,
            },
          },
        },
      }),
    ).toBe(0);
  });

  it('recovers multipart cancellation after object storage failure', async () => {
    const initiationResponse = await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId: randomUUID(),
        fileName: 'abort-recovery.bin',
        totalSize: (11 * 1024 * 1024).toString(),
      })
      .expect(201);

    const initiationBody = initiationResponse.body as {
      id?: unknown;
    };

    if (typeof initiationBody.id !== 'string') {
      throw new Error('Multipart upload session ID is missing');
    }

    abortMultipartUploadMock.mockRejectedValueOnce(
      new Error('Storage is unavailable'),
    );

    await request(app.getHttpServer())
      .delete(`/files/multipart/${initiationBody.id}`)
      .set(authorization(owner.accessToken))
      .expect(503);

    const abortingSession = await prisma.uploadSession.findUnique({
      where: {
        id: initiationBody.id,
      },
      select: {
        status: true,
      },
    });

    expect(abortingSession?.status).toBe('ABORTING');

    await request(app.getHttpServer())
      .delete(`/files/multipart/${initiationBody.id}`)
      .set(authorization(owner.accessToken))
      .expect(409);

    await prisma.uploadSession.update({
      where: {
        id: initiationBody.id,
      },
      data: {
        updatedAt: new Date(Date.now() - 60_000),
      },
    });

    await request(app.getHttpServer())
      .delete(`/files/multipart/${initiationBody.id}`)
      .set(authorization(owner.accessToken))
      .expect(204);

    const recoveredSession = await prisma.uploadSession.findUnique({
      where: {
        id: initiationBody.id,
      },
      select: {
        status: true,
      },
    });

    expect(recoveredSession?.status).toBe('ABORTED');
    expect(abortMultipartUploadMock).toHaveBeenCalledTimes(2);
  });

  it('does not abort a completed multipart upload', async () => {
    const initiationResponse = await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId: randomUUID(),
        fileName: 'completed-abort-guard.bin',
        totalSize: (11 * 1024 * 1024).toString(),
      })
      .expect(201);

    const initiationBody = initiationResponse.body as {
      id?: unknown;
    };

    if (typeof initiationBody.id !== 'string') {
      throw new Error('Multipart upload session ID is missing');
    }

    await prisma.uploadSession.update({
      where: {
        id: initiationBody.id,
      },
      data: {
        status: 'COMPLETED',
      },
    });

    await request(app.getHttpServer())
      .delete(`/files/multipart/${initiationBody.id}`)
      .set(authorization(owner.accessToken))
      .expect(409);

    expect(abortMultipartUploadMock).not.toHaveBeenCalled();
  });

  it('rejects multipart parts with incorrect sizes', async () => {
    const initiationResponse = await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId: randomUUID(),
        fileName: 'wrong-part-sizes.bin',
        totalSize: (11 * 1024 * 1024).toString(),
      })
      .expect(201);

    const initiationBody = initiationResponse.body as {
      id?: unknown;
    };

    if (typeof initiationBody.id !== 'string') {
      throw new Error('Multipart upload session ID is missing');
    }

    listMultipartUploadPartsMock.mockResolvedValue([
      {
        partNumber: 1,
        etag: '"wrong-size-etag-1"',
        size: 7 * 1024 * 1024,
      },
      {
        partNumber: 2,
        etag: '"wrong-size-etag-2"',
        size: 4 * 1024 * 1024,
      },
    ]);

    await request(app.getHttpServer())
      .post(`/files/multipart/${initiationBody.id}/complete`)
      .set(authorization(owner.accessToken))
      .expect(409);

    const session = await prisma.uploadSession.findUnique({
      where: {
        id: initiationBody.id,
      },
      select: {
        status: true,
        fileId: true,
      },
    });

    expect(session).toEqual({
      status: 'UPLOADING',
      fileId: null,
    });

    expect(completeMultipartUploadMock).not.toHaveBeenCalled();
  });

  it('does not complete an expired multipart session', async () => {
    const initiationResponse = await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId: randomUUID(),
        fileName: 'expired-completion.bin',
        totalSize: (11 * 1024 * 1024).toString(),
      })
      .expect(201);

    const initiationBody = initiationResponse.body as {
      id?: unknown;
    };

    if (typeof initiationBody.id !== 'string') {
      throw new Error('Multipart upload session ID is missing');
    }

    await prisma.uploadSession.update({
      where: {
        id: initiationBody.id,
      },
      data: {
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    await request(app.getHttpServer())
      .post(`/files/multipart/${initiationBody.id}/complete`)
      .set(authorization(owner.accessToken))
      .expect(410);

    const expiredSession = await prisma.uploadSession.findUnique({
      where: {
        id: initiationBody.id,
      },
      select: {
        status: true,
        fileId: true,
      },
    });

    expect(expiredSession).toEqual({
      status: 'EXPIRED',
      fileId: null,
    });

    expect(getObjectMetadataMock).not.toHaveBeenCalled();
    expect(listMultipartUploadPartsMock).not.toHaveBeenCalled();
    expect(completeMultipartUploadMock).not.toHaveBeenCalled();
  });

  it('recovers after an ambiguous multipart completion failure', async () => {
    const totalSize = 11 * 1024 * 1024;

    const initiationResponse = await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization(owner.accessToken))
      .send({
        clientRequestId: randomUUID(),
        fileName: 'ambiguous-completion.bin',
        mimeType: 'application/octet-stream',
        totalSize: totalSize.toString(),
      })
      .expect(201);

    const initiationBody = initiationResponse.body as {
      id?: unknown;
    };

    if (typeof initiationBody.id !== 'string') {
      throw new Error('Multipart upload session ID is missing');
    }

    listMultipartUploadPartsMock.mockResolvedValue([
      {
        partNumber: 1,
        etag: '"ambiguous-etag-1"',
        size: 8 * 1024 * 1024,
      },
      {
        partNumber: 2,
        etag: '"ambiguous-etag-2"',
        size: 3 * 1024 * 1024,
      },
    ]);

    getObjectMetadataMock.mockResolvedValueOnce(null);

    completeMultipartUploadMock.mockRejectedValueOnce(
      new Error('Completion result is unknown'),
    );

    await request(app.getHttpServer())
      .post(`/files/multipart/${initiationBody.id}/complete`)
      .set(authorization(owner.accessToken))
      .expect(503);

    const completingSession = await prisma.uploadSession.findUnique({
      where: {
        id: initiationBody.id,
      },
      select: {
        status: true,
      },
    });

    expect(completingSession?.status).toBe('COMPLETING');

    await request(app.getHttpServer())
      .post(`/files/multipart/${initiationBody.id}/complete`)
      .set(authorization(owner.accessToken))
      .expect(409);

    await prisma.uploadSession.update({
      where: {
        id: initiationBody.id,
      },
      data: {
        updatedAt: new Date(Date.now() - 60_000),
      },
    });

    getObjectMetadataMock.mockResolvedValueOnce({
      size: totalSize,
      contentType: 'application/octet-stream',
      etag: '"ambiguous-completed-object"',
    });

    const recoveredResponse = await request(app.getHttpServer())
      .post(`/files/multipart/${initiationBody.id}/complete`)
      .set(authorization(owner.accessToken))
      .expect(200);

    const recoveredFile = recoveredResponse.body as FileBody;

    expect(recoveredFile).toMatchObject({
      name: 'ambiguous-completion.bin',
      ownerId: owner.id,
      status: 'PROCESSING',
      size: totalSize.toString(),
    });

    expect(completeMultipartUploadMock).toHaveBeenCalledTimes(1);

    const recoveredSession = await prisma.uploadSession.findUnique({
      where: {
        id: initiationBody.id,
      },
      select: {
        status: true,
        fileId: true,
      },
    });

    expect(recoveredSession).toEqual({
      status: 'COMPLETED',
      fileId: recoveredFile.id,
    });
  });

  it('lists only files shared directly with the current user', async () => {
    const targetEmail = createTestEmail('files.shared-with-me');
    const targetUser = await registerAndLogin(targetEmail);

    /*
     * Direct-shared файл.
     */
    const directSharedFile = await uploadFile(
      owner.accessToken,
      'direct-shared.txt',
      Buffer.from('Direct shared content'),
    );

    await markFileReady(directSharedFile.id);

    /*
     * Файл, доступный только через shared folder.
     */
    const sharedFolderId = await createFolder(
      owner.accessToken,
      'Inherited Shared Folder',
    );

    const inheritedFile = await uploadFile(
      owner.accessToken,
      'inherited-file.txt',
      Buffer.from('Inherited content'),
      sharedFolderId,
    );

    await markFileReady(inheritedFile.id);

    /*
     * Собственный файл targetUser тоже не должен
     * попадать в Shared with me.
     */
    const ownFile = await uploadFile(
      targetUser.accessToken,
      'own-target-file.txt',
      Buffer.from('Own content'),
    );

    await markFileReady(ownFile.id);

    /*
     * Пока direct grants нет — discovery пуст.
     */
    const emptyResponse = await request(app.getHttpServer())
      .get('/files/shared-with-me')
      .set(authorization(targetUser.accessToken))
      .expect(200);

    expect(emptyResponse.body).toEqual([]);

    /*
     * Даём EDITOR на папку.
     * inheritedFile становится доступен,
     * но direct file discovery меняться не должен.
     */
    await request(app.getHttpServer())
      .post(`/folders/${sharedFolderId}/shares`)
      .set(authorization(owner.accessToken))
      .send({
        email: targetEmail,
        role: 'EDITOR',
      })
      .expect(201);

    const inheritedOnlyResponse = await request(app.getHttpServer())
      .get('/files/shared-with-me')
      .set(authorization(targetUser.accessToken))
      .expect(200);

    expect(inheritedOnlyResponse.body).toEqual([]);

    /*
     * При этом inherited файл реально доступен.
     */
    const folderFilesResponse = await request(app.getHttpServer())
      .get('/files')
      .query({
        folderId: sharedFolderId,
      })
      .set(authorization(targetUser.accessToken))
      .expect(200);

    expect(folderFilesResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: inheritedFile.id,
        }),
      ]),
    );

    /*
     * Теперь создаём direct FileAccessGrant.
     */
    const shareResponse = await request(app.getHttpServer())
      .post(`/files/${directSharedFile.id}/shares`)
      .set(authorization(owner.accessToken))
      .send({
        email: targetEmail,
        role: 'VIEWER',
      })
      .expect(201);

    const share = shareResponse.body as {
      id?: unknown;
      role?: unknown;
    };

    expect(share.role).toBe('VIEWER');

    if (typeof share.id !== 'string') {
      throw new Error('File share ID is missing');
    }

    /*
     * В discovery теперь должен быть ровно
     * один direct-shared файл.
     */
    const response = await request(app.getHttpServer())
      .get('/files/shared-with-me')
      .set(authorization(targetUser.accessToken))
      .expect(200);

    const body = response.body as Array<{
      id?: unknown;
      name?: unknown;
      ownerId?: unknown;
      folderId?: unknown;
      status?: unknown;
      mimeType?: unknown;
      size?: unknown;
      role?: unknown;
      sharedAt?: unknown;
      createdAt?: unknown;
      updatedAt?: unknown;
    }>;

    expect(body).toHaveLength(1);

    expect(body[0]).toMatchObject({
      id: directSharedFile.id,
      name: 'direct-shared.txt',
      ownerId: owner.id,
      folderId: null,
      status: 'READY',
      mimeType: 'text/plain',
      size: Buffer.byteLength('Direct shared content').toString(),
      role: 'VIEWER',
    });

    expect(typeof body[0]?.sharedAt).toBe('string');
    expect(typeof body[0]?.createdAt).toBe('string');
    expect(typeof body[0]?.updatedAt).toBe('string');

    /*
     * Inherited и собственный файл
     * отсутствуют в discovery.
     */
    expect(body.some((file) => file.id === inheritedFile.id)).toBe(false);

    expect(body.some((file) => file.id === ownFile.id)).toBe(false);

    /*
     * После revoke direct grant файл исчезает
     * из Shared with me.
     */
    await request(app.getHttpServer())
      .delete(`/files/${directSharedFile.id}/shares/${share.id}`)
      .set(authorization(owner.accessToken))
      .expect(204);

    const afterRevokeResponse = await request(app.getHttpServer())
      .get('/files/shared-with-me')
      .set(authorization(targetUser.accessToken))
      .expect(200);

    expect(afterRevokeResponse.body).toEqual([]);

    /*
     * Inherited доступ через папку при этом
     * по-прежнему существует.
     */
    await request(app.getHttpServer())
      .get(`/files/${inheritedFile.id}/download`)
      .set(authorization(targetUser.accessToken))
      .expect(200);
  });

  it('manages file public link lifecycle for the owner', async () => {
    const file = await uploadFile(
      owner.accessToken,
      'public-link-file.txt',
      Buffer.from('Public link content'),
    );

    await markFileReady(file.id);

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const createResponse = await request(app.getHttpServer())
      .post(`/files/${file.id}/public-links`)
      .set(authorization(owner.accessToken))
      .send({
        expiresAt,
      })
      .expect(201);

    const createdLink = createResponse.body as {
      id?: unknown;
      token?: unknown;
      expiresAt?: unknown;
      revokedAt?: unknown;
      createdAt?: unknown;
    };

    if (typeof createdLink.id !== 'string') {
      throw new Error('Created public link ID is missing');
    }

    if (typeof createdLink.token !== 'string') {
      throw new Error('Created public link token is missing');
    }

    expect(createdLink.expiresAt).toBe(expiresAt);
    expect(createdLink.revokedAt).toBeNull();
    expect(typeof createdLink.createdAt).toBe('string');

    const storedLink = await prisma.filePublicLink.findUnique({
      where: {
        id: createdLink.id,
      },
      select: {
        tokenHash: true,
        revokedAt: true,
      },
    });

    expect(storedLink).not.toBeNull();

    const expectedTokenHash = createHash('sha256')
      .update(createdLink.token)
      .digest('hex');

    expect(storedLink?.tokenHash).toBe(expectedTokenHash);

    expect(storedLink?.tokenHash).not.toBe(createdLink.token);

    const listResponse = await request(app.getHttpServer())
      .get(`/files/${file.id}/public-links`)
      .set(authorization(owner.accessToken))
      .expect(200);

    const listedLinks = listResponse.body as Array<Record<string, unknown>>;

    const listedLink = listedLinks.find((link) => link.id === createdLink.id);

    expect(listedLink).toEqual(
      expect.objectContaining({
        id: createdLink.id,
        revokedAt: null,
      }),
    );

    expect(listedLink).not.toHaveProperty('token');

    expect(listedLink).not.toHaveProperty('tokenHash');

    await request(app.getHttpServer())
      .delete(`/files/${file.id}/public-links/${createdLink.id}`)
      .set(authorization(owner.accessToken))
      .expect(204);

    const revokedLink = await prisma.filePublicLink.findUnique({
      where: {
        id: createdLink.id,
      },
      select: {
        revokedAt: true,
      },
    });

    expect(revokedLink?.revokedAt).toBeInstanceOf(Date);

    await request(app.getHttpServer())
      .delete(`/files/${file.id}/public-links/${createdLink.id}`)
      .set(authorization(owner.accessToken))
      .expect(204);
  });

  it('allows only OWNER to manage file public links', async () => {
    const viewerEmail = createTestEmail('files.public-link.viewer');

    const viewer = await registerAndLogin(viewerEmail);

    const file = await uploadFile(
      owner.accessToken,
      'owner-public-link-file.txt',
      Buffer.from('Owner content'),
    );

    await markFileReady(file.id);

    await request(app.getHttpServer())
      .post(`/files/${file.id}/shares`)
      .set(authorization(owner.accessToken))
      .send({
        email: viewerEmail,
        role: 'VIEWER',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/files/${file.id}/public-links`)
      .set(authorization(viewer.accessToken))
      .send({})
      .expect(403);

    await request(app.getHttpServer())
      .get(`/files/${file.id}/public-links`)
      .set(authorization(viewer.accessToken))
      .expect(403);

    await request(app.getHttpServer())
      .get(`/files/${file.id}/public-links`)
      .set(authorization(otherUser.accessToken))
      .expect(404);

    await request(app.getHttpServer())
      .post(`/files/${file.id}/public-links`)
      .set(authorization(owner.accessToken))
      .send({
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      })
      .expect(400);
  });

  it('provides public file metadata and download without authentication', async () => {
    const content = Buffer.from('Public file download content');

    const file = await uploadFile(
      owner.accessToken,
      'public-download.txt',
      content,
    );

    await markFileReady(file.id);

    const createResponse = await request(app.getHttpServer())
      .post(`/files/${file.id}/public-links`)
      .set(authorization(owner.accessToken))
      .send({})
      .expect(201);

    const publicLink = createResponse.body as {
      id?: unknown;
      token?: unknown;
    };

    if (typeof publicLink.token !== 'string') {
      throw new Error('Public link token is missing');
    }

    const metadataResponse = await request(app.getHttpServer())
      .get(`/public/files/${publicLink.token}`)
      .expect(200);

    expect(metadataResponse.body).toMatchObject({
      id: file.id,
      name: 'public-download.txt',
      mimeType: 'text/plain',
      size: content.length.toString(),
    });

    expect(metadataResponse.body).not.toHaveProperty('ownerId');

    expect(metadataResponse.body).not.toHaveProperty('folderId');

    const downloadResponse = await request(app.getHttpServer())
      .get(`/public/files/${publicLink.token}/download`)
      .expect(200);

    const downloadBody = downloadResponse.body as {
      url?: unknown;
      expiresAt?: unknown;
    };

    expect(downloadBody.url).toBe('https://storage.test/download');

    expect(typeof downloadBody.expiresAt).toBe('string');

    expect(createPresignedDownloadUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        downloadFileName: 'public-download.txt',
        contentType: 'text/plain',
        expiresInSeconds: 600,
      }),
    );
  });

  it('returns 404 for invalid, expired and revoked public file links', async () => {
    await request(app.getHttpServer())
      .get('/public/files/invalid-public-token')
      .expect(404);

    const file = await uploadFile(
      owner.accessToken,
      'public-link-invalid-states.txt',
      Buffer.from('Public link states'),
    );

    await markFileReady(file.id);

    // Создаём ссылку, которую затем искусственно
    // делаем просроченной в БД.
    const expiringResponse = await request(app.getHttpServer())
      .post(`/files/${file.id}/public-links`)
      .set(authorization(owner.accessToken))
      .send({
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
      .expect(201);

    const expiringLink = expiringResponse.body as {
      id?: unknown;
      token?: unknown;
    };

    if (
      typeof expiringLink.id !== 'string' ||
      typeof expiringLink.token !== 'string'
    ) {
      throw new Error('Expiring public link data is missing');
    }

    await prisma.filePublicLink.update({
      where: {
        id: expiringLink.id,
      },
      data: {
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    await request(app.getHttpServer())
      .get(`/public/files/${expiringLink.token}`)
      .expect(404);

    // Теперь отдельно проверяем revoke.
    const revokedResponse = await request(app.getHttpServer())
      .post(`/files/${file.id}/public-links`)
      .set(authorization(owner.accessToken))
      .send({})
      .expect(201);

    const revokedLink = revokedResponse.body as {
      id?: unknown;
      token?: unknown;
    };

    if (
      typeof revokedLink.id !== 'string' ||
      typeof revokedLink.token !== 'string'
    ) {
      throw new Error('Revoked public link data is missing');
    }

    await request(app.getHttpServer())
      .delete(`/files/${file.id}/public-links/${revokedLink.id}`)
      .set(authorization(owner.accessToken))
      .expect(204);

    await request(app.getHttpServer())
      .get(`/public/files/${revokedLink.token}`)
      .expect(404);

    await request(app.getHttpServer())
      .get(`/public/files/${revokedLink.token}/download`)
      .expect(404);
  });

  it('browses a public folder tree and prevents access outside it', async () => {
  const publicRootId = await createFolder(
    owner.accessToken,
    'Public Root',
  );

  const publicChildId = await createFolder(
    owner.accessToken,
    'Public Child',
    publicRootId,
  );

  const outsideFolderId = await createFolder(
    owner.accessToken,
    'Outside Folder',
  );

  const rootFile = await uploadFile(
    owner.accessToken,
    'root-public.txt',
    Buffer.from('Root public content'),
    publicRootId,
  );

  const childFile = await uploadFile(
    owner.accessToken,
    'child-public.txt',
    Buffer.from('Child public content'),
    publicChildId,
  );

  const outsideFile = await uploadFile(
    owner.accessToken,
    'outside-secret.txt',
    Buffer.from('Outside secret content'),
    outsideFolderId,
  );

  await markFileReady(rootFile.id);
  await markFileReady(childFile.id);
  await markFileReady(outsideFile.id);

  const createLinkResponse = await request(
    app.getHttpServer(),
  )
    .post(
      `/folders/${publicRootId}/public-links`,
    )
    .set(authorization(owner.accessToken))
    .send({})
    .expect(201);

  const publicLink =
    createLinkResponse.body as {
      token?: unknown;
    };

  if (typeof publicLink.token !== 'string') {
    throw new Error(
      'Public folder link token is missing',
    );
  }

  const token = publicLink.token;

  // Корень публичного дерева.
  const rootResponse = await request(
    app.getHttpServer(),
  )
    .get(`/public/folders/${token}`)
    .expect(200);

  const rootBody = rootResponse.body as {
    rootFolderId?: unknown;
    folder?: {
      id?: unknown;
      name?: unknown;
      parentId?: unknown;
    };
    folders?: Array<{
      id?: unknown;
      name?: unknown;
      parentId?: unknown;
    }>;
    files?: Array<{
      id?: unknown;
      name?: unknown;
      mimeType?: unknown;
      size?: unknown;
    }>;
  };

  expect(rootBody.rootFolderId).toBe(
    publicRootId,
  );

  expect(rootBody.folder).toMatchObject({
    id: publicRootId,
    name: 'Public Root',
    parentId: null,
  });

  expect(rootBody.folders).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: publicChildId,
        name: 'Public Child',
        parentId: publicRootId,
      }),
    ]),
  );

  expect(rootBody.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: rootFile.id,
        name: 'root-public.txt',
      }),
    ]),
  );

  // Переходим во вложенную папку.
  const childResponse = await request(
    app.getHttpServer(),
  )
    .get(
      `/public/folders/${token}/folders/${publicChildId}`,
    )
    .expect(200);

  const childBody = childResponse.body as {
    rootFolderId?: unknown;
    folder?: {
      id?: unknown;
      name?: unknown;
      parentId?: unknown;
    };
    files?: Array<{
      id?: unknown;
      name?: unknown;
    }>;
  };

  expect(childBody.rootFolderId).toBe(
    publicRootId,
  );

  expect(childBody.folder).toMatchObject({
    id: publicChildId,
    name: 'Public Child',
    parentId: publicRootId,
  });

  expect(childBody.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: childFile.id,
        name: 'child-public.txt',
      }),
    ]),
  );

  // Файл внутри опубликованного дерева скачивается.
  const downloadResponse = await request(
    app.getHttpServer(),
  )
    .get(
      `/public/folders/${token}/files/${childFile.id}/download`,
    )
    .expect(200);

  const downloadBody =
    downloadResponse.body as {
      url?: unknown;
      expiresAt?: unknown;
    };

  expect(downloadBody.url).toBe(
    'https://storage.test/download',
  );

  expect(typeof downloadBody.expiresAt).toBe(
    'string',
  );

  expect(
    createPresignedDownloadUrlMock,
  ).toHaveBeenCalledWith(
    expect.objectContaining({
      downloadFileName:
        'child-public.txt',
      contentType: 'text/plain',
      expiresInSeconds: 600,
    }),
  );

  // Попытка вручную открыть соседнюю папку.
  await request(app.getHttpServer())
    .get(
      `/public/folders/${token}/folders/${outsideFolderId}`,
    )
    .expect(404);

  // Попытка скачать файл из соседней папки.
  await request(app.getHttpServer())
    .get(
      `/public/folders/${token}/files/${outsideFile.id}/download`,
    )
    .expect(404);
});

it('returns 404 for invalid, expired and revoked public folder links', async () => {
  // Несуществующий токен.
  await request(app.getHttpServer())
    .get('/public/folders/invalid-public-folder-token')
    .expect(404);

  const rootFolderId = await createFolder(
    owner.accessToken,
    'Invalid States Public Root',
  );

  const childFolderId = await createFolder(
    owner.accessToken,
    'Invalid States Public Child',
    rootFolderId,
  );

  const childFile = await uploadFile(
    owner.accessToken,
    'invalid-states-public-file.txt',
    Buffer.from('Public folder invalid states'),
    childFolderId,
  );

  await markFileReady(childFile.id);

  // -------------------------
  // Expired public link
  // -------------------------

  const expiringResponse = await request(
    app.getHttpServer(),
  )
    .post(
      `/folders/${rootFolderId}/public-links`,
    )
    .set(authorization(owner.accessToken))
    .send({
      expiresAt: new Date(
        Date.now() + 60 * 60 * 1000,
      ).toISOString(),
    })
    .expect(201);

  const expiringLink =
    expiringResponse.body as {
      id?: unknown;
      token?: unknown;
    };

  if (
    typeof expiringLink.id !== 'string' ||
    typeof expiringLink.token !== 'string'
  ) {
    throw new Error(
      'Expiring folder public link data is missing',
    );
  }

  await prisma.folderPublicLink.update({
    where: {
      id: expiringLink.id,
    },
    data: {
      expiresAt: new Date(
        Date.now() - 60_000,
      ),
    },
  });

  await request(app.getHttpServer())
    .get(
      `/public/folders/${expiringLink.token}`,
    )
    .expect(404);

  // -------------------------
  // Revoked public link
  // -------------------------

  const revokedResponse = await request(
    app.getHttpServer(),
  )
    .post(
      `/folders/${rootFolderId}/public-links`,
    )
    .set(authorization(owner.accessToken))
    .send({})
    .expect(201);

  const revokedLink =
    revokedResponse.body as {
      id?: unknown;
      token?: unknown;
    };

  if (
    typeof revokedLink.id !== 'string' ||
    typeof revokedLink.token !== 'string'
  ) {
    throw new Error(
      'Revoked folder public link data is missing',
    );
  }

  // До revoke ссылка должна работать.
  await request(app.getHttpServer())
    .get(
      `/public/folders/${revokedLink.token}`,
    )
    .expect(200);

  await request(app.getHttpServer())
    .get(
      `/public/folders/${revokedLink.token}/folders/${childFolderId}`,
    )
    .expect(200);

  await request(app.getHttpServer())
    .delete(
      `/folders/${rootFolderId}/public-links/${revokedLink.id}`,
    )
    .set(authorization(owner.accessToken))
    .expect(204);

  createPresignedDownloadUrlMock.mockClear();

  // После revoke недоступен корень.
  await request(app.getHttpServer())
    .get(
      `/public/folders/${revokedLink.token}`,
    )
    .expect(404);

  // После revoke нельзя зайти во вложенную папку.
  await request(app.getHttpServer())
    .get(
      `/public/folders/${revokedLink.token}/folders/${childFolderId}`,
    )
    .expect(404);

  // После revoke нельзя скачать файл из дерева.
  await request(app.getHttpServer())
    .get(
      `/public/folders/${revokedLink.token}/files/${childFile.id}/download`,
    )
    .expect(404);

  expect(
    createPresignedDownloadUrlMock,
  ).not.toHaveBeenCalled();
});
});
