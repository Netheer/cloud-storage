import { randomUUID } from 'node:crypto';
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
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OBJECT_STORAGE)
      .useValue(objectStorageMock)
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
  });

  afterAll(async () => {
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
  ): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/folders')
      .set(authorization(accessToken))
      .send({
        name,
        parentId: null,
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
      status: 'READY',
      mimeType: 'text/plain',
      size: Buffer.byteLength('Root file content').toString(),
    });

    expect(nestedFile).toMatchObject({
      name: 'nested-file.txt',
      ownerId: owner.id,
      folderId,
      status: 'READY',
    });

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

  it('creates a temporary download URL only for the owner', async () => {
    const file = await uploadFile(
      owner.accessToken,
      'download-me.txt',
      Buffer.from('Download content'),
    );

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

  it('renames a file without replacing its stored object', async () => {
    const file = await uploadFile(
      owner.accessToken,
      'before-rename.txt',
      Buffer.from('Rename content'),
    );

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

  it('deletes the file and its stored object', async () => {
    const file = await uploadFile(
      owner.accessToken,
      'delete-me.txt',
      Buffer.from('Delete content'),
    );

    const fileMetadata = await prisma.file.findUnique({
      where: {
        id: file.id,
      },
      select: {
        currentVersion: {
          select: {
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

    await request(app.getHttpServer())
      .delete(`/files/${file.id}`)
      .set(authorization(owner.accessToken))
      .expect(204);

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

  it('can retry deletion after object storage becomes available', async () => {
    const file = await uploadFile(
      owner.accessToken,
      'retry-delete.txt',
      Buffer.from('Retry delete content'),
    );

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
});
