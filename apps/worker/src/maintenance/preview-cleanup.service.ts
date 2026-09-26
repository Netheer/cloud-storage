import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from '../storage/object-storage.interface';

const PREVIEW_CLEANUP_BATCH_SIZE = 100;

type PreviewCleanupResult = {
  scanned: number;
  cleaned: number;
  skipped: number;
  failed: number;
};

@Injectable()
export class PreviewCleanupService {
  private readonly logger = new Logger(PreviewCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE)
    private readonly objectStorage: ObjectStorage,
  ) {}

  async cleanupBatch(
    batchSize = PREVIEW_CLEANUP_BATCH_SIZE,
  ): Promise<PreviewCleanupResult> {
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error('Preview cleanup batch size must be a positive integer');
    }

    const candidates = await this.prisma.fileVersion.findMany({
      where: {
        previewObjectKey: {
          not: null,
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
      take: batchSize,
      select: {
        id: true,
        previewObjectKey: true,
      },
    });

    const result: PreviewCleanupResult = {
      scanned: candidates.length,
      cleaned: 0,
      skipped: 0,
      failed: 0,
    };

    for (const candidate of candidates) {
      const previewObjectKey = candidate.previewObjectKey;

      if (!previewObjectKey) {
        result.skipped += 1;
        continue;
      }

      try {
        const exists = await this.objectStorage.objectExists(previewObjectKey);

        if (exists) {
          result.skipped += 1;
          continue;
        }

        const updated = await this.prisma.fileVersion.updateMany({
          where: {
            id: candidate.id,
            previewObjectKey,
          },
          data: {
            previewObjectKey: null,
            previewMimeType: null,
            previewWidth: null,
            previewHeight: null,
          },
        });

        if (updated.count === 0) {
          result.skipped += 1;
          continue;
        }

        result.cleaned += 1;

        this.logger.warn(
          `Cleared missing preview metadata for ` +
            `FileVersion ${candidate.id}: ` +
            `${previewObjectKey}`,
        );
      } catch (error: unknown) {
        result.failed += 1;

        const message = error instanceof Error ? error.message : String(error);

        this.logger.warn(
          `Could not verify preview for ` +
            `FileVersion ${candidate.id}: ${message}`,
        );
      }
    }

    this.logger.log(
      `Preview cleanup finished: ` +
        `scanned=${result.scanned}, ` +
        `cleaned=${result.cleaned}, ` +
        `skipped=${result.skipped}, ` +
        `failed=${result.failed}`,
    );

    return result;
  }
}
