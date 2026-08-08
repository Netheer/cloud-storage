import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';

type AuthResponseBody = {
  accessToken: unknown;
  expiresIn: unknown;
  user: {
    id: unknown;
    email: unknown;
    displayName: unknown;
    createdAt: unknown;
    updatedAt: unknown;
  };
};

describe('Authentication (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const createdEmails: string[] = [];
  const password = 'StrongPassword123!';

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
  });

  afterAll(async () => {
    if (createdEmails.length > 0) {
      await prisma.user.deleteMany({
        where: {
          email: {
            in: createdEmails,
          },
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

  function registerUser(email: string) {
    return request(app.getHttpServer()).post('/auth/register').send({
      email,
      password,
      displayName: 'E2E Test User',
    });
  }

  function getRefreshCookieHeader(setCookieHeaders: unknown): string {
    if (!Array.isArray(setCookieHeaders)) {
      throw new Error('Set-Cookie headers are missing');
    }

    const refreshCookieHeader = setCookieHeaders.find(
      (header): header is string =>
        typeof header === 'string' && header.startsWith('refresh_token='),
    );

    if (!refreshCookieHeader) {
      throw new Error('Refresh cookie is missing');
    }

    return refreshCookieHeader;
  }

  function getRefreshCookie(setCookieHeaders: unknown): string {
    return getRefreshCookieHeader(setCookieHeaders).split(';', 1)[0];
  }

  async function getLatestAuthSession(email: string) {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (!user) {
      throw new Error(`Test user ${email} was not found`);
    }

    return prisma.authSession.findFirst({
      where: {
        userId: user.id,
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        revokedAt: true,
      },
    });
  }

  it('registers a user and normalizes the email', async () => {
    const normalizedEmail = createTestEmail('auth.register');
    const submittedEmail = normalizedEmail.replace(
      '@example.com',
      '@Example.COM',
    );

    const response = await registerUser(submittedEmail).expect(201);

    const body = response.body as {
      id: unknown;
      email: unknown;
      displayName: unknown;
      createdAt: unknown;
      updatedAt: unknown;
    };

    expect(body).toMatchObject({
      email: normalizedEmail,
      displayName: 'E2E Test User',
    });
    expect(typeof body.id).toBe('string');
    expect(body).not.toHaveProperty('password');
    expect(body).not.toHaveProperty('passwordHash');

    await registerUser(normalizedEmail).expect(409);
  });

  it('logs in with valid credentials and rejects an invalid password', async () => {
    const email = createTestEmail('auth.login');

    await registerUser(email).expect(201);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email,
        password: 'WrongPassword123!',
      })
      .expect(401);

    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email,
        password,
      })
      .expect(200);

    const body = response.body as AuthResponseBody;

    expect(typeof body.accessToken).toBe('string');
    expect(body.expiresIn).toBe(900);
    expect(body.user).toMatchObject({
      email,
      displayName: 'E2E Test User',
    });
    expect(body).not.toHaveProperty('refreshToken');

    const setCookieHeaders = response.headers['set-cookie'] as
      string[] | undefined;

    const refreshCookieHeader = setCookieHeaders?.find((header) =>
      header.startsWith('refresh_token='),
    );

    expect(refreshCookieHeader).toBeDefined();
    expect(refreshCookieHeader).toContain('HttpOnly');
    expect(refreshCookieHeader).toContain('Path=/auth');
    expect(refreshCookieHeader).toContain('SameSite=Lax');
  });

  it('returns the current user for a valid access token', async () => {
    const email = createTestEmail('auth.me');

    await registerUser(email).expect(201);

    const loginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email,
        password,
      })
      .expect(200);

    const loginBody = loginResponse.body as AuthResponseBody;

    expect(typeof loginBody.accessToken).toBe('string');

    const accessToken = loginBody.accessToken as string;

    const meResponse = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(meResponse.body).toMatchObject({
      email,
      displayName: 'E2E Test User',
    });
    expect(meResponse.body).not.toHaveProperty('password');
    expect(meResponse.body).not.toHaveProperty('passwordHash');

    await request(app.getHttpServer()).get('/auth/me').expect(401);

    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer invalid-token')
      .expect(401);
  });

  it('rotates refresh tokens and revokes the session when an old token is reused', async () => {
    const email = createTestEmail('auth.refresh-reuse');

    await registerUser(email).expect(201);

    const loginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email,
        password,
      })
      .expect(200);

    const oldRefreshCookie = getRefreshCookie(
      loginResponse.headers['set-cookie'],
    );

    const refreshResponse = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', oldRefreshCookie)
      .expect(200);

    const newRefreshCookie = getRefreshCookie(
      refreshResponse.headers['set-cookie'],
    );

    expect(newRefreshCookie).not.toBe(oldRefreshCookie);

    const refreshBody = refreshResponse.body as AuthResponseBody;

    expect(typeof refreshBody.accessToken).toBe('string');
    expect(refreshBody.expiresIn).toBe(900);
    expect(refreshBody).not.toHaveProperty('refreshToken');

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', oldRefreshCookie)
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', newRefreshCookie)
      .expect(401);

    const authSession = await getLatestAuthSession(email);

    expect(authSession).not.toBeNull();
    expect(authSession?.revokedAt).toBeInstanceOf(Date);
  });

  it('revokes the session, clears the cookie, and supports repeated logout', async () => {
    const email = createTestEmail('auth.logout');

    await registerUser(email).expect(201);

    const loginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email,
        password,
      })
      .expect(200);

    const refreshCookie = getRefreshCookie(loginResponse.headers['set-cookie']);

    const logoutResponse = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Cookie', refreshCookie)
      .expect(204);

    const clearedCookieHeader = getRefreshCookieHeader(
      logoutResponse.headers['set-cookie'],
    );

    expect(clearedCookieHeader).toContain('refresh_token=;');
    expect(clearedCookieHeader).toContain('Path=/auth');
    expect(clearedCookieHeader).toContain('Expires=Thu, 01 Jan 1970');
    expect(clearedCookieHeader).toContain('HttpOnly');

    const authSession = await getLatestAuthSession(email);

    expect(authSession).not.toBeNull();
    expect(authSession?.revokedAt).toBeInstanceOf(Date);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', refreshCookie)
      .expect(401);

    await request(app.getHttpServer()).post('/auth/logout').expect(204);
  });
});
