import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from '../storage/object-storage.interface';

const MULTIPART_CLEANUP_BATCH_SIZE = 100;
const MULTIPART_ABORT_RECOVERY_DELAY_MS = 30 * 1000;

type MultipartCleanupResult = {
  scanned: number;
  cleaned: number;
  skipped: number;
  failed: number;
};

type MultipartCleanupCandidate = {
  id: string;
  status: string;
  objectKey: string;
  multipartUploadId: string | null;
  expiresAt: Date;
  updatedAt: Date;
};

@Injectable()
export class MultipartCleanupService {
  private readonly logger = new Logger(MultipartCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE)
    private readonly objectStorage: ObjectStorage,
  ) {}

  async cleanupBatch(
    batchSize = MULTIPART_CLEANUP_BATCH_SIZE,
  ): Promise<MultipartCleanupResult> {
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error(
        'Multipart cleanup batch size must be a positive integer',
      );
    }

    const now = new Date();
    const staleAbortingBefore = new Date(
      now.getTime() - MULTIPART_ABORT_RECOVERY_DELAY_MS,
    );

    const candidates = await this.prisma.uploadSession.findMany({
      where: {
        OR: [
          {
            status: 'CREATED',
            expiresAt: {
              lte: now,
            },
          },
          {
            status: 'UPLOADING',
            expiresAt: {
              lte: now,
            },
          },
          {
            status: 'EXPIRED',
          },
          {
            status: 'FAILED',
          },
          {
            status: 'ABORTING',
            updatedAt: {
              lte: staleAbortingBefore,
            },
          },
        ],
      },
      orderBy: [
        {
          expiresAt: 'asc',
        },
        {
          updatedAt: 'asc',
        },
      ],
      take: batchSize,
      select: {
        id: true,
        status: true,
        objectKey: true,
        multipartUploadId: true,
        expiresAt: true,
        updatedAt: true,
      },
    });

    const result: MultipartCleanupResult = {
      scanned: candidates.length,
      cleaned: 0,
      skipped: 0,
      failed: 0,
    };

    for (const candidate of candidates) {
      try {
        const claimed = await this.claimSession(candidate, now);

        if (!claimed) {
          result.skipped += 1;
          continue;
        }

        if (candidate.multipartUploadId) {
          try {
            await this.objectStorage.abortMultipartUpload({
              objectKey: candidate.objectKey,
              uploadId: candidate.multipartUploadId,
            });
          } catch (error: unknown) {
            result.failed += 1;

            const message =
              error instanceof Error ? error.message : String(error);

            this.logger.warn(
              `Could not abort multipart upload for session ` +
                `${candidate.id}: ${message}`,
            );

            /*
             * Оставляем ABORTING.
             *
             * Следующий cleanup-run сможет повторно захватить
             * эту сессию после recovery delay.
             */
            continue;
          }
        }

        const finalized = await this.prisma.uploadSession.updateMany({
          where: {
            id: candidate.id,
            status: 'ABORTING',
          },
          data: {
            status: 'ABORTED',
          },
        });

        if (finalized.count > 0) {
          result.cleaned += 1;

          this.logger.log(`Cleaned multipart upload session ${candidate.id}`);

          continue;
        }

        const currentSession = await this.prisma.uploadSession.findUnique({
          where: {
            id: candidate.id,
          },
          select: {
            status: true,
          },
        });

        if (currentSession?.status === 'ABORTED') {
          /*
           * Другой cleanup/API abort уже завершил операцию.
           * Это успешный идемпотентный результат.
           */
          result.cleaned += 1;
          continue;
        }

        result.failed += 1;

        this.logger.warn(
          `Multipart upload session ${candidate.id} ` +
            `could not transition ABORTING -> ABORTED`,
        );
      } catch (error: unknown) {
        result.failed += 1;

        const stack = error instanceof Error ? error.stack : String(error);

        this.logger.error(
          `Multipart cleanup failed for session ${candidate.id}`,
          stack,
        );
      }
    }

    this.logger.log(
      `Multipart cleanup batch finished: ` +
        `scanned=${result.scanned}, ` +
        `cleaned=${result.cleaned}, ` +
        `skipped=${result.skipped}, ` +
        `failed=${result.failed}`,
    );

    return result;
  }

  private async claimSession(
    candidate: MultipartCleanupCandidate,
    now: Date,
  ): Promise<boolean> {
    if (candidate.status === 'ABORTING') {
      const recoveredClaim = await this.prisma.uploadSession.updateMany({
        where: {
          id: candidate.id,
          status: 'ABORTING',
          updatedAt: candidate.updatedAt,
        },
        data: {
          /*
           * Обновление updatedAt служит lease-like claim:
           * другой worker уже не сможет захватить старое значение.
           */
          updatedAt: now,
        },
      });

      return recoveredClaim.count > 0;
    }

    const claimedSession = await this.prisma.uploadSession.updateMany({
      where: {
        id: candidate.id,
        status: candidate.status as
          'CREATED' | 'UPLOADING' | 'EXPIRED' | 'FAILED',
      },
      data: {
        status: 'ABORTING',
      },
    });

    return claimedSession.count > 0;
  }
}
