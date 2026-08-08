import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';

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
  ): Promise<IssuedTokenPair> {
    const sessionId = randomUUID();

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

  hashRefreshToken(refreshToken: string): string {
    return createHash('sha256').update(refreshToken).digest('hex');
  }
}
