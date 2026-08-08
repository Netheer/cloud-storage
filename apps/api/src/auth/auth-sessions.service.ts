import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

type CreateAuthSessionData = {
  id: string;
  userId: string;
  refreshTokenHash: string;
  expiresAt: Date;
};

@Injectable()
export class AuthSessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateAuthSessionData): Promise<void> {
    await this.prisma.authSession.create({
      data,
    });
  }
}
