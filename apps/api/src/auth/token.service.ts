import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

export type RefreshTokenPayload = {
  sub: string;
  sid: string;
  type: 'refresh';
  jti: string;
  iat?: number;
  exp?: number;
};

export type IssuedTokenPair = {
  sessionId: string;
  accessToken: string;
  accessExpiresIn: number;
  refreshToken: string;
  refreshTokenHash: string;
  refreshExpiresAt: Date;
};

@Injectable()
export class TokenService {
  private readonly refreshSecret: string;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;

  constructor(
    private readonly jwtService: JwtService,
    configService: ConfigService,
  ) {
    this.refreshSecret = configService.getOrThrow<string>('JWT_REFRESH_SECRET');

    this.accessTtlSeconds = Number(
      configService.getOrThrow<string>('JWT_ACCESS_TTL_SECONDS'),
    );

    this.refreshTtlSeconds = Number(
      configService.getOrThrow<string>('JWT_REFRESH_TTL_SECONDS'),
    );
  }

  async issueTokenPair(
    userId: string,
    email: string,
    sessionId: string = randomUUID(),
  ): Promise<IssuedTokenPair> {
    const accessPayload = {
      sub: userId,
      sid: sessionId,
      email,
      type: 'access',
      jti: randomUUID(),
    };

    const refreshPayload = {
      sub: userId,
      sid: sessionId,
      type: 'refresh',
      jti: randomUUID(),
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(accessPayload),
      this.jwtService.signAsync(refreshPayload, {
        secret: this.refreshSecret,
        expiresIn: this.refreshTtlSeconds,
      }),
    ]);

    return {
      sessionId,
      accessToken,
      accessExpiresIn: this.accessTtlSeconds,
      refreshToken,
      refreshTokenHash: this.hashRefreshToken(refreshToken),
      refreshExpiresAt: new Date(Date.now() + this.refreshTtlSeconds * 1000),
    };
  }

  async verifyRefreshToken(refreshToken: string): Promise<RefreshTokenPayload> {
    const payload = await this.jwtService.verifyAsync<RefreshTokenPayload>(
      refreshToken,
      {
        secret: this.refreshSecret,
      },
    );

    if (
      payload.type !== 'refresh' ||
      typeof payload.sub !== 'string' ||
      typeof payload.sid !== 'string' ||
      typeof payload.jti !== 'string'
    ) {
      throw new Error('Invalid refresh token payload');
    }

    return payload;
  }

  hashRefreshToken(refreshToken: string): string {
    return createHash('sha256').update(refreshToken).digest('hex');
  }

  refreshTokenMatches(refreshToken: string, expectedHash: string): boolean {
    const actualHash = this.hashRefreshToken(refreshToken);

    const actualBuffer = Buffer.from(actualHash, 'utf8');
    const expectedBuffer = Buffer.from(expectedHash, 'utf8');

    return (
      actualBuffer.length === expectedBuffer.length &&
      timingSafeEqual(actualBuffer, expectedBuffer)
    );
  }
}
