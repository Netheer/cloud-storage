import { createHash, randomUUID } from 'node:crypto';
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
  let otherUserId: string;
  let noAccessUserToken: string;

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
    const noAccessEmail = createTestEmail('folders.no-access');

    ownerToken = await registerAndLogin(ownerEmail);
    otherUserToken = await registerAndLogin(otherEmail);
    noAccessUserToken = await registerAndLogin(noAccessEmail);

    const otherUser = await prisma.user.findUnique({
      where: {
        email: otherEmail,
      },
      select: {
        id: true,
      },
    });

    if (!otherUser) {
      throw new Error('Other test user was not created');
    }

    otherUserId = otherUser.id;
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

  it('manages folder sharing lifecycle for a registered user', async () => {
    const targetEmail = createTestEmail('folders.share.target');
    const targetToken = await registerAndLogin(targetEmail);

    const sharedRoot = await createFolder(ownerToken, 'Managed Shared Root');

    const existingChild = await createFolder(
      ownerToken,
      'Existing Shared Child',
      sharedRoot.id,
    );

    /*
     * До выдачи доступа ресурс для targetUser
     * вообще не существует с точки зрения API.
     */
    await request(app.getHttpServer())
      .get('/folders')
      .query({
        parentId: sharedRoot.id,
      })
      .set(authorization(targetToken))
      .expect(404);

    /*
     * OWNER выдаёт VIEWER.
     */
    const createShareResponse = await request(app.getHttpServer())
      .post(`/folders/${sharedRoot.id}/shares`)
      .set(authorization(ownerToken))
      .send({
        email: `  ${targetEmail.toUpperCase()}  `,
        role: 'VIEWER',
      })
      .expect(201);

    const createdShare = createShareResponse.body as {
      id?: unknown;
      userId?: unknown;
      email?: unknown;
      displayName?: unknown;
      role?: unknown;
      createdAt?: unknown;
      updatedAt?: unknown;
    };

    expect(typeof createdShare.id).toBe('string');
    expect(typeof createdShare.userId).toBe('string');

    expect(createdShare).toMatchObject({
      email: targetEmail,
      role: 'VIEWER',
    });

    if (typeof createdShare.id !== 'string') {
      throw new Error('Folder share ID is missing');
    }

    const grantId = createdShare.id;

    /*
     * Duplicate direct grant запрещён.
     */
    await request(app.getHttpServer())
      .post(`/folders/${sharedRoot.id}/shares`)
      .set(authorization(ownerToken))
      .send({
        email: targetEmail,
        role: 'EDITOR',
      })
      .expect(409);

    /*
     * OWNER видит список direct grants.
     */
    const sharesResponse = await request(app.getHttpServer())
      .get(`/folders/${sharedRoot.id}/shares`)
      .set(authorization(ownerToken))
      .expect(200);

    expect(sharesResponse.body).toEqual([
      expect.objectContaining({
        id: grantId,
        email: targetEmail,
        role: 'VIEWER',
      }),
    ]);

    /*
     * VIEWER получает inherited read-доступ
     * к содержимому shared root.
     */
    const viewerListResponse = await request(app.getHttpServer())
      .get('/folders')
      .query({
        parentId: sharedRoot.id,
      })
      .set(authorization(targetToken))
      .expect(200);

    expect(viewerListResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: existingChild.id,
          parentId: sharedRoot.id,
        }),
      ]),
    );

    /*
     * Но VIEWER не может создавать дочерние папки.
     */
    await request(app.getHttpServer())
      .post('/folders')
      .set(authorization(targetToken))
      .send({
        name: 'Viewer Denied Child',
        parentId: sharedRoot.id,
      })
      .expect(403);

    /*
     * И не может управлять sharing.
     */
    await request(app.getHttpServer())
      .get(`/folders/${sharedRoot.id}/shares`)
      .set(authorization(targetToken))
      .expect(403);

    /*
     * OWNER повышает VIEWER -> EDITOR.
     */
    const updateShareResponse = await request(app.getHttpServer())
      .patch(`/folders/${sharedRoot.id}/shares/${grantId}`)
      .set(authorization(ownerToken))
      .send({
        role: 'EDITOR',
      })
      .expect(200);

    expect(updateShareResponse.body).toMatchObject({
      id: grantId,
      email: targetEmail,
      role: 'EDITOR',
    });

    /*
     * EDITOR теперь может изменять shared tree.
     */
    const editorChildResponse = await request(app.getHttpServer())
      .post('/folders')
      .set(authorization(targetToken))
      .send({
        name: 'Created By Editor',
        parentId: sharedRoot.id,
      })
      .expect(201);

    expect(editorChildResponse.body).toMatchObject({
      name: 'Created By Editor',
      ownerId: sharedRoot.ownerId,
      parentId: sharedRoot.id,
    });

    /*
     * Даже EDITOR не может управлять sharing:
     * это исключительно OWNER operation.
     */
    await request(app.getHttpServer())
      .patch(`/folders/${sharedRoot.id}/shares/${grantId}`)
      .set(authorization(targetToken))
      .send({
        role: 'VIEWER',
      })
      .expect(403);

    /*
     * OWNER отзывает direct grant.
     */
    await request(app.getHttpServer())
      .delete(`/folders/${sharedRoot.id}/shares/${grantId}`)
      .set(authorization(ownerToken))
      .expect(204);

    /*
     * После revoke доступ исчезает полностью.
     */
    await request(app.getHttpServer())
      .get('/folders')
      .query({
        parentId: sharedRoot.id,
      })
      .set(authorization(targetToken))
      .expect(404);

    await request(app.getHttpServer())
      .post('/folders')
      .set(authorization(targetToken))
      .send({
        name: 'Revoked User Child',
        parentId: sharedRoot.id,
      })
      .expect(404);

    /*
     * Direct grant действительно удалён.
     */
    const sharesAfterRevoke = await request(app.getHttpServer())
      .get(`/folders/${sharedRoot.id}/shares`)
      .set(authorization(ownerToken))
      .expect(200);

    expect(sharesAfterRevoke.body).toEqual([]);
  });

  it('allows VIEWER to read a shared folder hierarchy', async () => {
    const root = await createFolder(ownerToken, 'Shared Root');

    const child = await createFolder(ownerToken, 'Shared Child', root.id);

    const grandchild = await createFolder(
      ownerToken,
      'Shared Grandchild',
      child.id,
    );

    await prisma.folderAccessGrant.create({
      data: {
        folderId: root.id,
        userId: otherUserId,
        role: 'VIEWER',
      },
    });

    const sharedUserRootList = await request(app.getHttpServer())
      .get('/folders')
      .set(authorization(otherUserToken))
      .expect(200);

    expect(sharedUserRootList.body).toEqual([]);

    const childList = await request(app.getHttpServer())
      .get('/folders')
      .query({
        parentId: root.id,
      })
      .set(authorization(otherUserToken))
      .expect(200);

    expect(childList.body).toEqual([
      expect.objectContaining({
        id: child.id,
        name: 'Shared Child',
        parentId: root.id,
      }),
    ]);

    const grandchildList = await request(app.getHttpServer())
      .get('/folders')
      .query({
        parentId: child.id,
      })
      .set(authorization(otherUserToken))
      .expect(200);

    expect(grandchildList.body).toEqual([
      expect.objectContaining({
        id: grandchild.id,
        name: 'Shared Grandchild',
        parentId: child.id,
      }),
    ]);

    await request(app.getHttpServer())
      .get('/folders')
      .query({
        parentId: root.id,
      })
      .set(authorization(noAccessUserToken))
      .expect(404);
  });

  it('lists only folders shared directly with the current user', async () => {
    const targetEmail = createTestEmail('folders.shared-with-me');
    const targetToken = await registerAndLogin(targetEmail);

    const sharedRoot = await createFolder(ownerToken, 'Shared Discovery Root');

    const sharedChild = await createFolder(
      ownerToken,
      'Shared Discovery Child',
      sharedRoot.id,
    );

    /*
     * Собственная папка targetUser не должна
     * попадать в Shared with me.
     */
    const targetOwnFolder = await createFolder(
      targetToken,
      'Target Own Folder',
    );

    /*
     * До выдачи grant список пуст.
     */
    const emptyResponse = await request(app.getHttpServer())
      .get('/folders/shared-with-me')
      .set(authorization(targetToken))
      .expect(200);

    expect(emptyResponse.body).toEqual([]);

    /*
     * OWNER делится только root-папкой.
     */
    const shareResponse = await request(app.getHttpServer())
      .post(`/folders/${sharedRoot.id}/shares`)
      .set(authorization(ownerToken))
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

    /*
     * В discovery появляется только direct-shared root.
     *
     * sharedChild доступен по inheritance,
     * но отдельной строкой здесь быть не должен.
     */
    const response = await request(app.getHttpServer())
      .get('/folders/shared-with-me')
      .set(authorization(targetToken))
      .expect(200);

    const body = response.body as Array<{
      id?: unknown;
      name?: unknown;
      ownerId?: unknown;
      parentId?: unknown;
      role?: unknown;
      sharedAt?: unknown;
      createdAt?: unknown;
      updatedAt?: unknown;
    }>;

    expect(body).toHaveLength(1);

    expect(body[0]).toMatchObject({
      id: sharedRoot.id,
      name: 'Shared Discovery Root',
      ownerId: sharedRoot.ownerId,
      parentId: null,
      role: 'VIEWER',
    });

    expect(typeof body[0]?.sharedAt).toBe('string');
    expect(typeof body[0]?.createdAt).toBe('string');
    expect(typeof body[0]?.updatedAt).toBe('string');

    expect(body.some((folder) => folder.id === sharedChild.id)).toBe(false);

    expect(body.some((folder) => folder.id === targetOwnFolder.id)).toBe(false);

    /*
     * При этом inherited child остаётся
     * доступен через обычную навигацию.
     */
    const childListResponse = await request(app.getHttpServer())
      .get('/folders')
      .query({
        parentId: sharedRoot.id,
      })
      .set(authorization(targetToken))
      .expect(200);

    expect(childListResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: sharedChild.id,
        }),
      ]),
    );

    /*
     * После revoke ресурс исчезает
     * из Shared with me.
     */
    if (typeof share.id !== 'string') {
      throw new Error('Folder share ID is missing');
    }

    await request(app.getHttpServer())
      .delete(`/folders/${sharedRoot.id}/shares/${share.id}`)
      .set(authorization(ownerToken))
      .expect(204);

    const afterRevokeResponse = await request(app.getHttpServer())
      .get('/folders/shared-with-me')
      .set(authorization(targetToken))
      .expect(200);

    expect(afterRevokeResponse.body).toEqual([]);
  });

  it('allows EDITOR to modify a shared folder hierarchy', async () => {
    const root = await createFolder(ownerToken, 'Editor Shared Root');

    const destination = await createFolder(
      ownerToken,
      'Editor Destination',
      root.id,
    );

    const grant = await prisma.folderAccessGrant.create({
      data: {
        folderId: root.id,
        userId: otherUserId,
        role: 'VIEWER',
      },
      select: {
        id: true,
      },
    });

    await request(app.getHttpServer())
      .post('/folders')
      .set(authorization(otherUserToken))
      .send({
        name: 'Viewer Cannot Create',
        parentId: root.id,
      })
      .expect(403);

    await request(app.getHttpServer())
      .patch(`/folders/${destination.id}`)
      .set(authorization(otherUserToken))
      .send({
        name: 'Viewer Cannot Rename',
      })
      .expect(403);

    await request(app.getHttpServer())
      .patch(`/folders/${destination.id}/move`)
      .set(authorization(otherUserToken))
      .send({
        parentId: root.id,
      })
      .expect(403);

    await prisma.folderAccessGrant.update({
      where: {
        id: grant.id,
      },
      data: {
        role: 'EDITOR',
      },
    });

    const createdByEditor = await createFolder(
      otherUserToken,
      'Created By Editor',
      root.id,
    );

    expect(createdByEditor.ownerId).toBe(root.ownerId);

    expect(createdByEditor.parentId).toBe(root.id);

    const renamed = await request(app.getHttpServer())
      .patch(`/folders/${createdByEditor.id}`)
      .set(authorization(otherUserToken))
      .send({
        name: 'Renamed By Editor',
      })
      .expect(200);

    expect(renamed.body).toMatchObject({
      id: createdByEditor.id,
      name: 'Renamed By Editor',
      ownerId: root.ownerId,
    });

    const moved = await request(app.getHttpServer())
      .patch(`/folders/${createdByEditor.id}/move`)
      .set(authorization(otherUserToken))
      .send({
        parentId: destination.id,
      })
      .expect(200);

    expect(moved.body).toMatchObject({
      id: createdByEditor.id,
      parentId: destination.id,
      ownerId: root.ownerId,
    });

    await request(app.getHttpServer())
      .patch(`/folders/${createdByEditor.id}/move`)
      .set(authorization(otherUserToken))
      .send({
        parentId: null,
      })
      .expect(403);

    /*
     * И delete пока остаётся OWNER-only.
     */
    await request(app.getHttpServer())
      .delete(`/folders/${createdByEditor.id}`)
      .set(authorization(otherUserToken))
      .expect(403);
  });

  it('returns 403 when VIEWER tries to delete a shared folder', async () => {
    const viewerEmail = createTestEmail('folders.viewer.delete');

    const viewerToken = await registerAndLogin(viewerEmail);

    const sharedFolder = await createFolder(
      ownerToken,
      'Viewer Delete Forbidden',
    );

    await request(app.getHttpServer())
      .post(`/folders/${sharedFolder.id}/shares`)
      .set(authorization(ownerToken))
      .send({
        email: viewerEmail,
        role: 'VIEWER',
      })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/folders/${sharedFolder.id}`)
      .set(authorization(viewerToken))
      .expect(403);
  });

  it('manages folder public link lifecycle for the owner', async () => {
    const folder = await createFolder(ownerToken, 'Public Link Folder');

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const createResponse = await request(app.getHttpServer())
      .post(`/folders/${folder.id}/public-links`)
      .set(authorization(ownerToken))
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

    const storedLink = await prisma.folderPublicLink.findUnique({
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
      .get(`/folders/${folder.id}/public-links`)
      .set(authorization(ownerToken))
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
      .delete(`/folders/${folder.id}/public-links/${createdLink.id}`)
      .set(authorization(ownerToken))
      .expect(204);

    const revokedLink = await prisma.folderPublicLink.findUnique({
      where: {
        id: createdLink.id,
      },
      select: {
        revokedAt: true,
      },
    });

    expect(revokedLink?.revokedAt).toBeInstanceOf(Date);

    // Повторный revoke должен быть идемпотентным.
    await request(app.getHttpServer())
      .delete(`/folders/${folder.id}/public-links/${createdLink.id}`)
      .set(authorization(ownerToken))
      .expect(204);
  });

  it('allows only OWNER to manage folder public links', async () => {
    const viewerEmail = createTestEmail('folders.public-link.viewer');

    const viewerToken = await registerAndLogin(viewerEmail);

    const folder = await createFolder(ownerToken, 'Owner Public Link Folder');

    await request(app.getHttpServer())
      .post(`/folders/${folder.id}/shares`)
      .set(authorization(ownerToken))
      .send({
        email: viewerEmail,
        role: 'VIEWER',
      })
      .expect(201);

    // VIEWER видит папку, но public links — OWNER-only.
    await request(app.getHttpServer())
      .post(`/folders/${folder.id}/public-links`)
      .set(authorization(viewerToken))
      .send({})
      .expect(403);

    await request(app.getHttpServer())
      .get(`/folders/${folder.id}/public-links`)
      .set(authorization(viewerToken))
      .expect(403);

    // Пользователь без доступа вообще получает 404.
    await request(app.getHttpServer())
      .get(`/folders/${folder.id}/public-links`)
      .set(authorization(otherUserToken))
      .expect(404);

    // Просроченную ссылку создавать нельзя.
    await request(app.getHttpServer())
      .post(`/folders/${folder.id}/public-links`)
      .set(authorization(ownerToken))
      .send({
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      })
      .expect(400);
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

  it('prevents moving a folder into itself or its descendant', async () => {
    const root = await createFolder(ownerToken, 'Cycle Root');

    const child = await createFolder(ownerToken, 'Cycle Child', root.id);

    const grandchild = await createFolder(
      ownerToken,
      'Cycle Grandchild',
      child.id,
    );

    await request(app.getHttpServer())
      .patch(`/folders/${root.id}/move`)
      .set(authorization(ownerToken))
      .send({
        parentId: root.id,
      })
      .expect(400);

    await request(app.getHttpServer())
      .patch(`/folders/${root.id}/move`)
      .set(authorization(ownerToken))
      .send({
        parentId: child.id,
      })
      .expect(400);

    await request(app.getHttpServer())
      .patch(`/folders/${root.id}/move`)
      .set(authorization(ownerToken))
      .send({
        parentId: grandchild.id,
      })
      .expect(400);

    const storedRoot = await prisma.folder.findUnique({
      where: {
        id: root.id,
      },
      select: {
        parentId: true,
      },
    });

    const storedChild = await prisma.folder.findUnique({
      where: {
        id: child.id,
      },
      select: {
        parentId: true,
      },
    });

    const storedGrandchild = await prisma.folder.findUnique({
      where: {
        id: grandchild.id,
      },
      select: {
        parentId: true,
      },
    });

    expect(storedRoot?.parentId).toBeNull();
    expect(storedChild?.parentId).toBe(root.id);
    expect(storedGrandchild?.parentId).toBe(child.id);
  });

  it('validates folder names on create and rename', async () => {
    await request(app.getHttpServer())
      .post('/folders')
      .set(authorization(ownerToken))
      .send({
        name: '   ',
        parentId: null,
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/folders')
      .set(authorization(ownerToken))
      .send({
        name: 'a'.repeat(256),
        parentId: null,
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/folders')
      .set(authorization(ownerToken))
      .send({
        name: 'invalid/name',
        parentId: null,
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/folders')
      .set(authorization(ownerToken))
      .send({
        name: 'invalid\\name',
        parentId: null,
      })
      .expect(400);

    const folder = await createFolder(ownerToken, '  Trimmed Folder  ');

    expect(folder.name).toBe('Trimmed Folder');

    await request(app.getHttpServer())
      .patch(`/folders/${folder.id}`)
      .set(authorization(ownerToken))
      .send({
        name: '   ',
      })
      .expect(400);

    await request(app.getHttpServer())
      .patch(`/folders/${folder.id}`)
      .set(authorization(ownerToken))
      .send({
        name: 'a'.repeat(256),
      })
      .expect(400);

    const renameResponse = await request(app.getHttpServer())
      .patch(`/folders/${folder.id}`)
      .set(authorization(ownerToken))
      .send({
        name: '  Renamed Folder  ',
      })
      .expect(200);

    expect(renameResponse.body).toMatchObject({
      id: folder.id,
      name: 'Renamed Folder',
    });
  });

  it('removes a moved folder from an existing public folder tree', async () => {
    const publicRoot = await createFolder(ownerToken, 'Public Move Root');

    const outsideFolder = await createFolder(ownerToken, 'Public Move Outside');

    const child = await createFolder(
      ownerToken,
      'Public Move Child',
      publicRoot.id,
    );

    const linkResponse = await request(app.getHttpServer())
      .post(`/folders/${publicRoot.id}/public-links`)
      .set(authorization(ownerToken))
      .send({})
      .expect(201);

    const link = linkResponse.body as {
      token?: unknown;
    };

    if (typeof link.token !== 'string') {
      throw new Error('Public link token is missing');
    }

    await request(app.getHttpServer())
      .get(`/public/folders/${link.token}/folders/${child.id}`)
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/folders/${child.id}/move`)
      .set(authorization(ownerToken))
      .send({
        parentId: outsideFolder.id,
      })
      .expect(200);

    await request(app.getHttpServer())
      .get(`/public/folders/${link.token}/folders/${child.id}`)
      .expect(404);
  });
});
