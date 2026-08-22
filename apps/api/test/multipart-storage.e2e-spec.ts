import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from '../src/storage/object-storage.interface';

type TestUser = {
  id: string;
  accessToken: string;
};

type MultipartInitiationBody = {
  id: string;
  partSize: string;
  totalParts: number;
};

type PartUrlBody = {
  url: string;
};

type CompletedFileBody = {
  id: string;
  name: string;
  status: string;
  size: string;
};

type DownloadBody = {
  url: string;
};

jest.setTimeout(120_000);

describe('Multipart storage integration (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let objectStorage: ObjectStorage;
  let owner: TestUser;

  const password = 'StrongPassword123!';
  const email = `multipart.storage.${randomUUID()}@example.com`.toLowerCase();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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
    objectStorage = app.get<ObjectStorage>(OBJECT_STORAGE);

    const registrationResponse = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email,
        password,
        displayName: 'Multipart Storage E2E User',
      })
      .expect(201);

    const registrationBody = registrationResponse.body as {
      id?: unknown;
    };

    if (typeof registrationBody.id !== 'string') {
      throw new Error('Registered user ID is missing');
    }

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

    owner = {
      id: registrationBody.id,
      accessToken: loginBody.accessToken,
    };
  });

  afterAll(async () => {
    try {
      if (owner) {
        const sessions = await prisma.uploadSession.findMany({
          where: {
            ownerId: owner.id,
          },
          select: {
            objectKey: true,
            multipartUploadId: true,
          },
        });

        await Promise.all(
          sessions.map(async (session) => {
            if (session.multipartUploadId) {
              await objectStorage.abortMultipartUpload({
                objectKey: session.objectKey,
                uploadId: session.multipartUploadId,
              });
            }

            await objectStorage.deleteObject(session.objectKey);
          }),
        );

        await prisma.user.deleteMany({
          where: {
            id: owner.id,
          },
        });

        if (sessions.length > 0) {
          await prisma.storedObject.deleteMany({
            where: {
              objectKey: {
                in: sessions.map((session) => session.objectKey),
              },
              versions: {
                none: {},
              },
            },
          });
        }
      }
    } finally {
      await app.close();
    }
  });

  function authorization() {
    return {
      Authorization: `Bearer ${owner.accessToken}`,
    };
  }

  it('uploads, resumes, completes, downloads and deletes a real multipart object', async () => {
    const totalSize = 11 * 1024 * 1024;
    const originalContent = randomBytes(totalSize);

    const initiationResponse = await request(app.getHttpServer())
      .post('/files/multipart')
      .set(authorization())
      .send({
        clientRequestId: randomUUID(),
        fileName: 'real-multipart.bin',
        mimeType: 'application/octet-stream',
        totalSize: totalSize.toString(),
        folderId: null,
      })
      .expect(201);

    const initiationBody = initiationResponse.body as MultipartInitiationBody;

    expect(initiationBody).toMatchObject({
      partSize: (8 * 1024 * 1024).toString(),
      totalParts: 2,
    });

    const partSize = Number(initiationBody.partSize);

    for (
      let partNumber = 1;
      partNumber <= initiationBody.totalParts;
      partNumber += 1
    ) {
      const start = (partNumber - 1) * partSize;
      const end = Math.min(start + partSize, totalSize);
      const part = originalContent.subarray(start, end);

      const partUrlResponse = await request(app.getHttpServer())
        .post(`/files/multipart/${initiationBody.id}` + `/parts/${partNumber}`)
        .set(authorization())
        .expect(201);

      const partUrlBody = partUrlResponse.body as PartUrlBody;

      const uploadResponse = await fetch(partUrlBody.url, {
        method: 'PUT',
        body: part,
      });

      if (!uploadResponse.ok) {
        throw new Error(
          `Part ${partNumber} upload failed with ` +
            `HTTP ${uploadResponse.status}: ` +
            `${await uploadResponse.text()}`,
        );
      }
    }

    const statusResponse = await request(app.getHttpServer())
      .get(`/files/multipart/${initiationBody.id}`)
      .set(authorization())
      .expect(200);

    expect(statusResponse.body).toMatchObject({
      id: initiationBody.id,
      status: 'UPLOADING',
      uploadedParts: [
        {
          partNumber: 1,
          size: (8 * 1024 * 1024).toString(),
        },
        {
          partNumber: 2,
          size: (3 * 1024 * 1024).toString(),
        },
      ],
    });

    const completionResponse = await request(app.getHttpServer())
      .post(`/files/multipart/${initiationBody.id}/complete`)
      .set(authorization())
      .expect(200);

    const completedFile = completionResponse.body as CompletedFileBody;

    expect(completedFile).toMatchObject({
      name: 'real-multipart.bin',
      status: 'READY',
      size: totalSize.toString(),
    });

    const repeatedCompletionResponse = await request(app.getHttpServer())
      .post(`/files/multipart/${initiationBody.id}/complete`)
      .set(authorization())
      .expect(200);

    expect(repeatedCompletionResponse.body).toMatchObject({
      id: completedFile.id,
      status: 'READY',
    });

    const downloadResponse = await request(app.getHttpServer())
      .get(`/files/${completedFile.id}/download`)
      .set(authorization())
      .expect(200);

    const downloadBody = downloadResponse.body as DownloadBody;
    const objectResponse = await fetch(downloadBody.url);

    if (!objectResponse.ok) {
      throw new Error(
        `Completed object download failed with ` +
          `HTTP ${objectResponse.status}`,
      );
    }

    const downloadedContent = Buffer.from(await objectResponse.arrayBuffer());

    expect(downloadedContent.equals(originalContent)).toBe(true);

    await request(app.getHttpServer())
      .delete(`/files/${completedFile.id}`)
      .set(authorization())
      .expect(204);
  });
});
