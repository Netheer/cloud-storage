import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';

type FolderBody = {
  id: string;
  name: string;
  ownerId: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
};

describe('Folders (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let ownerToken: string;
  let otherUserToken: string;

  const password = 'StrongPassword123!';
  const createdEmails: string[] = [];

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

    const ownerEmail = createTestEmail('folders.owner');
    const otherEmail = createTestEmail('folders.other');

    ownerToken = await registerAndLogin(ownerEmail);
    otherUserToken = await registerAndLogin(otherEmail);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: {
        email: {
          in: createdEmails,
        },
      },
    });

    await app.close();
  });

  function createTestEmail(prefix: string): string {
    const email = `${prefix}.${randomUUID()}@example.com`.toLowerCase();

    createdEmails.push(email);

    return email;
  }

  async function registerAndLogin(email: string): Promise<string> {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email,
        password,
        displayName: 'Folders E2E User',
      })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email,
        password,
      })
      .expect(200);

    const body = response.body as {
      accessToken?: unknown;
    };

    if (typeof body.accessToken !== 'string') {
      throw new Error('Access token is missing');
    }

    return body.accessToken;
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
  ): Promise<FolderBody> {
    const response = await request(app.getHttpServer())
      .post('/folders')
      .set(authorization(accessToken))
      .send({
        name,
        parentId,
      })
      .expect(201);

    return response.body as FolderBody;
  }

  it('creates and lists root and nested folders with owner isolation', async () => {
    const root = await createFolder(ownerToken, 'Owner Root');

    const child = await createFolder(ownerToken, 'Owner Child', root.id);

    const rootList = await request(app.getHttpServer())
      .get('/folders')
      .set(authorization(ownerToken))
      .expect(200);

    expect(rootList.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: root.id,
          name: 'Owner Root',
          parentId: null,
        }),
      ]),
    );

    const childList = await request(app.getHttpServer())
      .get('/folders')
      .query({
        parentId: root.id,
      })
      .set(authorization(ownerToken))
      .expect(200);

    expect(childList.body).toEqual([
      expect.objectContaining({
        id: child.id,
        name: 'Owner Child',
        parentId: root.id,
      }),
    ]);

    const otherRootList = await request(app.getHttpServer())
      .get('/folders')
      .set(authorization(otherUserToken))
      .expect(200);

    expect(otherRootList.body).toEqual([]);

    await request(app.getHttpServer())
      .get('/folders')
      .query({
        parentId: root.id,
      })
      .set(authorization(otherUserToken))
      .expect(404);

    await request(app.getHttpServer())
      .post('/folders')
      .set(authorization(otherUserToken))
      .send({
        name: 'Foreign Child',
        parentId: root.id,
      })
      .expect(404);

    await request(app.getHttpServer())
      .patch(`/folders/${root.id}`)
      .set(authorization(otherUserToken))
      .send({
        name: 'Foreign Rename',
      })
      .expect(404);

    await request(app.getHttpServer())
      .patch(`/folders/${root.id}/move`)
      .set(authorization(otherUserToken))
      .send({
        parentId: null,
      })
      .expect(404);

    await request(app.getHttpServer())
      .delete(`/folders/${child.id}`)
      .set(authorization(otherUserToken))
      .expect(404);
  });

  it('renames and moves folders while preventing cycles', async () => {
    const root = await createFolder(ownerToken, 'Move Root');

    const child = await createFolder(ownerToken, 'Move Child', root.id);

    const renameResponse = await request(app.getHttpServer())
      .patch(`/folders/${child.id}`)
      .set(authorization(ownerToken))
      .send({
        name: 'Renamed Child',
      })
      .expect(200);

    expect(renameResponse.body).toMatchObject({
      id: child.id,
      name: 'Renamed Child',
      parentId: root.id,
    });

    await request(app.getHttpServer())
      .patch(`/folders/${child.id}/move`)
      .set(authorization(ownerToken))
      .send({
        parentId: null,
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          id: child.id,
          parentId: null,
        });
      });

    await request(app.getHttpServer())
      .patch(`/folders/${child.id}/move`)
      .set(authorization(ownerToken))
      .send({
        parentId: root.id,
      })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/folders/${root.id}/move`)
      .set(authorization(ownerToken))
      .send({
        parentId: child.id,
      })
      .expect(400);

    await request(app.getHttpServer())
      .patch(`/folders/${child.id}/move`)
      .set(authorization(ownerToken))
      .send({
        parentId: child.id,
      })
      .expect(400);
  });

  it('deletes only empty folders', async () => {
    const root = await createFolder(ownerToken, 'Delete Root');

    const child = await createFolder(ownerToken, 'Delete Child', root.id);

    await request(app.getHttpServer())
      .delete(`/folders/${root.id}`)
      .set(authorization(ownerToken))
      .expect(409);

    await request(app.getHttpServer())
      .delete(`/folders/${child.id}`)
      .set(authorization(ownerToken))
      .expect(204);

    await request(app.getHttpServer())
      .delete(`/folders/${child.id}`)
      .set(authorization(ownerToken))
      .expect(404);

    await request(app.getHttpServer())
      .delete(`/folders/${root.id}`)
      .set(authorization(ownerToken))
      .expect(204);
  });

  it('validates folder requests and requires authentication', async () => {
    await request(app.getHttpServer())
      .post('/folders')
      .send({
        name: 'Unauthorized',
        parentId: null,
      })
      .expect(401);

    await request(app.getHttpServer())
      .post('/folders')
      .set(authorization(ownerToken))
      .send({
        name: 'Bad/Name',
        parentId: null,
      })
      .expect(400);

    await request(app.getHttpServer())
      .get('/folders')
      .query({
        parentId: 'not-a-uuid',
      })
      .set(authorization(ownerToken))
      .expect(400);

    await request(app.getHttpServer())
      .patch('/folders/00000000-0000-4000-8000-000000000001')
      .set(authorization(ownerToken))
      .send({
        name: 'Missing',
      })
      .expect(404);

    const folder = await createFolder(ownerToken, 'Move Validation');

    await request(app.getHttpServer())
      .patch(`/folders/${folder.id}/move`)
      .set(authorization(ownerToken))
      .send({})
      .expect(400);
  });
});
