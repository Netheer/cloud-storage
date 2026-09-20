import {
  INestApplication,
  INestApplicationContext,
  ValidationPipe,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule as ApiAppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from '../src/storage/object-storage.interface';
import { AppModule as WorkerAppModule } from '../../worker/src/app.module';

type UploadBody = {
  id: string;
  status: string;
};

type PreviewBody = {
  url: string;
  expiresAt: string;
  mimeType: string;
  width: number;
  height: number;
};

jest.setTimeout(30_000);

describe('File processing integration', () => {
  let apiApp: INestApplication<App>;
  let workerApp: INestApplicationContext;

  let prisma: PrismaService;
  let objectStorage: ObjectStorage;

  let createdUserId: string | null = null;
  let createdFileId: string | null = null;
  let createdStoredObjectId: string | null = null;
  let createdObjectKey: string | null = null;
  let createdPreviewObjectKey: string | null = null;

  const password = 'StrongPassword123!';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiAppModule],
    }).compile();

    apiApp = moduleFixture.createNestApplication();

    apiApp.use(cookieParser());
    apiApp.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    await apiApp.init();

    prisma = apiApp.get(PrismaService);
    objectStorage = apiApp.get<ObjectStorage>(OBJECT_STORAGE);

    workerApp = await NestFactory.createApplicationContext(WorkerAppModule, {
      logger: false,
    });
  });

  afterAll(async () => {
    await workerApp?.close();

    if (createdFileId) {
      await prisma.outboxEvent.deleteMany({
        where: {
          aggregateId: createdFileId,
        },
      });
    }

    if (createdPreviewObjectKey) {
      await objectStorage.deleteObject(createdPreviewObjectKey);
    }

    if (createdObjectKey) {
      await objectStorage.deleteObject(createdObjectKey);
    }

    if (createdUserId) {
      await prisma.user.deleteMany({
        where: {
          id: createdUserId,
        },
      });
    }

    if (createdStoredObjectId) {
      await prisma.storedObject.deleteMany({
        where: {
          id: createdStoredObjectId,
        },
      });
    }

    await apiApp?.close();
  });

  async function waitForReady(
    fileId: string,
    timeoutMs = 15_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const file = await prisma.file.findUnique({
        where: {
          id: fileId,
        },
        select: {
          status: true,
        },
      });

      if (file?.status === 'READY') {
        return;
      }

      if (file?.status === 'FAILED') {
        throw new Error(`File ${fileId} entered FAILED state`);
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }

    throw new Error(
      `File ${fileId} did not become READY within ${timeoutMs} ms`,
    );
  }

  it('processes an uploaded file through outbox, BullMQ and worker', async () => {
    const email =
      `processing.integration.${randomUUID()}@example.com`.toLowerCase();

    const registrationResponse = await request(apiApp.getHttpServer())
      .post('/auth/register')
      .send({
        email,
        password,
        displayName: 'Processing Integration User',
      })
      .expect(201);

    const registrationBody = registrationResponse.body as {
      id?: unknown;
    };

    if (typeof registrationBody.id !== 'string') {
      throw new Error('Registered user ID is missing');
    }

    createdUserId = registrationBody.id;

    const loginResponse = await request(apiApp.getHttpServer())
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

    const content = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );

    const expectedSha256 = createHash('sha256').update(content).digest('hex');

    const uploadResponse = await request(apiApp.getHttpServer())
      .post('/files/upload')
      .set({
        Authorization: `Bearer ${loginBody.accessToken}`,
      })
      .attach('file', content, {
        filename: 'processing-integration.png',
        contentType: 'image/png',
      })
      .expect(201);

    const uploadedFile = uploadResponse.body as UploadBody;

    expect(uploadedFile.status).toBe('PROCESSING');

    createdFileId = uploadedFile.id;

    const initialOutboxEvent = await prisma.outboxEvent.findFirst({
      where: {
        aggregateId: uploadedFile.id,
        type: 'PROCESS_FILE',
      },
    });

    expect(initialOutboxEvent).not.toBeNull();

    await waitForReady(uploadedFile.id);

    const processedFile = await prisma.file.findUnique({
      where: {
        id: uploadedFile.id,
      },
      select: {
        status: true,
        currentVersion: {
          select: {
            id: true,
            storedObjectId: true,
            previewObjectKey: true,
            previewMimeType: true,
            previewWidth: true,
            previewHeight: true,
            storedObject: {
              select: {
                id: true,
                objectKey: true,
                sha256: true,
                size: true,
              },
            },
          },
        },
      },
    });

    expect(processedFile?.status).toBe('READY');

    if (!processedFile?.currentVersion) {
      throw new Error('Processed file current version is missing');
    }

    const storedObject = processedFile.currentVersion.storedObject;

    createdStoredObjectId = storedObject.id;
    createdObjectKey = storedObject.objectKey;

    expect(storedObject.sha256).toBe(expectedSha256);

    expect(processedFile.currentVersion.previewObjectKey).not.toBeNull();
    expect(processedFile.currentVersion.previewMimeType).toBe('image/webp');
    expect(processedFile.currentVersion.previewWidth).toBe(1);
    expect(processedFile.currentVersion.previewHeight).toBe(1);

    createdPreviewObjectKey = processedFile.currentVersion.previewObjectKey;
    expect(storedObject.size).toBe(BigInt(content.length));

    const previewResponse = await request(apiApp.getHttpServer())
      .get(`/files/${uploadedFile.id}/preview`)
      .set({
        Authorization: `Bearer ${loginBody.accessToken}`,
      })
      .expect(200);

    const previewBody = previewResponse.body as PreviewBody;

    expect(previewBody.mimeType).toBe('image/webp');
    expect(previewBody.width).toBe(1);
    expect(previewBody.height).toBe(1);
    expect(typeof previewBody.url).toBe('string');
    expect(typeof previewBody.expiresAt).toBe('string');

    const previewDownloadResponse = await fetch(previewBody.url);

    expect(previewDownloadResponse.ok).toBe(true);
    expect(previewDownloadResponse.headers.get('content-type')).toBe(
      'image/webp',
    );

    const previewBytes = await previewDownloadResponse.arrayBuffer();

    expect(previewBytes.byteLength).toBeGreaterThan(0);

    const publishedEvent = await prisma.outboxEvent.findFirst({
      where: {
        aggregateId: uploadedFile.id,
        type: 'PROCESS_FILE',
      },
    });

    expect(publishedEvent).not.toBeNull();
    expect(publishedEvent?.publishedAt).toBeInstanceOf(Date);
    expect(publishedEvent?.attempts).toBe(0);
    expect(publishedEvent?.lastError).toBeNull();

    expect(publishedEvent?.payload).toMatchObject({
      fileId: uploadedFile.id,
      versionId: processedFile.currentVersion.id,
      storedObjectId: processedFile.currentVersion.storedObjectId,
    });
  });
});
