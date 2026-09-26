import { Injectable } from '@nestjs/common';
import type {
  AuditAction,
  AuditResourceType,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';

type WriteAuditLogInput = {
  actorUserId: string;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId: string;
  metadata?: Prisma.InputJsonValue;
};

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async write(
    input: WriteAuditLogInput,
    transaction?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = transaction ?? this.prisma;

    await db.auditLog.create({
      data: {
        actorUserId: input.actorUserId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        metadata: input.metadata,
      },
    });
  }
}
