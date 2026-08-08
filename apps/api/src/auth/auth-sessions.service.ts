import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

type CreateAuthSessionData = {
  id: string;
  userId: string;
  refreshTokenHash: string;
  expiresAt: Date;
};

type RotateAuthSessionData = {
  id: string;
  currentRefreshTokenHash: string;
  newRefreshTokenHash: string;
  newExpiresAt: Date;
};

@Injectable()
export class AuthSessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateAuthSessionData): Promise<void> {
    await this.prisma.authSession.create({
      data,
    });
  }

  findById(id: string) {
    return this.prisma.authSession.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        refreshTokenHash: true,
        expiresAt: true,
        revokedAt: true,
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });
  }

  async rotate(data: RotateAuthSessionData): Promise<boolean> {
    const result = await this.prisma.authSession.updateMany({
      where: {
        id: data.id,
        refreshTokenHash: data.currentRefreshTokenHash,
        revokedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
      data: {
        refreshTokenHash: data.newRefreshTokenHash,
        expiresAt: data.newExpiresAt,
      },
    });

    return result.count === 1;
  }

  async revoke(id: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: {
        id,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
  }
}
