import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from '../storage/object-storage.interface';

const STORED_OBJECT_CLEANUP_BATCH_SIZE = 100;

const STORED_OBJECT_ORPHAN_GRACE_PERIOD_MS = 60 * 60 * 1000;

type StoredObjectCleanupResult = {
  scanned: number;
  cleaned: number;
  skipped: number;
  failed: number;
};

@Injectable()
export class StoredObjectCleanupService {
  private readonly logger = new Logger(StoredObjectCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE)
    private readonly objectStorage: ObjectStorage,
  ) {}

  async cleanupDatabaseOrphans(
    batchSize = STORED_OBJECT_CLEANUP_BATCH_SIZE,
  ): Promise<StoredObjectCleanupResult> {
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error(
        'Stored object cleanup batch size must be a positive integer',
      );
    }

    const orphanBefore = new Date(
      Date.now() - STORED_OBJECT_ORPHAN_GRACE_PERIOD_MS,
    );

    const candidates = await this.prisma.storedObject.findMany({
      where: {
        createdAt: {
          lte: orphanBefore,
        },
        versions: {
          none: {},
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
      take: batchSize,
      select: {
        id: true,
        objectKey: true,
        createdAt: true,
      },
    });

    const result: StoredObjectCleanupResult = {
      scanned: candidates.length,
      cleaned: 0,
      skipped: 0,
      failed: 0,
    };

    for (const candidate of candidates) {
      try {
        const deleted = await this.prisma.storedObject.deleteMany({
          where: {
            id: candidate.id,
            versions: {
              none: {},
            },
          },
        });

        if (deleted.count === 0) {
          result.skipped += 1;
          continue;
        }

        try {
          await this.objectStorage.deleteObject(candidate.objectKey);
        } catch (error: unknown) {
          result.failed += 1;

          const message =
            error instanceof Error ? error.message : String(error);

          this.logger.warn(
            `StoredObject ${candidate.id} was removed from DB, ` +
              `but physical object ${candidate.objectKey} ` +
              `could not be deleted: ${message}`,
          );

          continue;
        }

        result.cleaned += 1;

        this.logger.log(
          `Cleaned orphan StoredObject ${candidate.id} ` +
            `(${candidate.objectKey})`,
        );
      } catch (error: unknown) {
        result.failed += 1;

        const stack = error instanceof Error ? error.stack : String(error);

        this.logger.error(
          `Failed to clean StoredObject ${candidate.id}`,
          stack,
        );
      }
    }

    this.logger.log(
      `StoredObject DB cleanup finished: ` +
        `scanned=${result.scanned}, ` +
        `cleaned=${result.cleaned}, ` +
        `skipped=${result.skipped}, ` +
        `failed=${result.failed}`,
    );

    return result;
  }

  async cleanupPhysicalOrphans(
    maxObjects = STORED_OBJECT_CLEANUP_BATCH_SIZE,
  ): Promise<StoredObjectCleanupResult> {
    if (!Number.isInteger(maxObjects) || maxObjects < 1) {
      throw new Error(
        'Physical object cleanup batch size must be a positive integer',
      );
    }

    const orphanBefore = new Date(
      Date.now() - STORED_OBJECT_ORPHAN_GRACE_PERIOD_MS,
    );

    const result: StoredObjectCleanupResult = {
      scanned: 0,
      cleaned: 0,
      skipped: 0,
      failed: 0,
    };

    let continuationToken: string | undefined;

    while (result.scanned < maxObjects) {
      const remaining = maxObjects - result.scanned;

      const page = await this.objectStorage.listObjects({
        continuationToken,
        maxKeys: remaining,
      });

      if (page.objects.length === 0) {
        break;
      }

      for (const object of page.objects) {
        if (result.scanned >= maxObjects) {
          break;
        }

        result.scanned += 1;

        if (
          !object.lastModified ||
          object.lastModified.getTime() > orphanBefore.getTime()
        ) {
          result.skipped += 1;
          continue;
        }

        try {
          const [storedObject, uploadSession, previewVersion] =
            await Promise.all([
              this.prisma.storedObject.findUnique({
                where: {
                  objectKey: object.objectKey,
                },
                select: {
                  id: true,
                },
              }),

              this.prisma.uploadSession.findFirst({
                where: {
                  objectKey: object.objectKey,
                  status: {
                    in: ['CREATED', 'UPLOADING', 'COMPLETING', 'ABORTING'],
                  },
                },
                select: {
                  id: true,
                },
              }),

              this.prisma.fileVersion.findFirst({
                where: {
                  previewObjectKey: object.objectKey,
                },
                select: {
                  id: true,
                },
              }),
            ]);

          if (storedObject || uploadSession || previewVersion) {
            result.skipped += 1;
            continue;
          }

          await this.objectStorage.deleteObject(object.objectKey);

          result.cleaned += 1;

          this.logger.log(`Cleaned physical orphan ${object.objectKey}`);
        } catch (error: unknown) {
          result.failed += 1;

          const message =
            error instanceof Error ? error.message : String(error);

          this.logger.warn(
            `Could not clean physical orphan ` +
              `${object.objectKey}: ${message}`,
          );
        }
      }

      if (!page.nextContinuationToken) {
        break;
      }

      continuationToken = page.nextContinuationToken;
    }

    this.logger.log(
      `StoredObject physical cleanup finished: ` +
        `scanned=${result.scanned}, ` +
        `cleaned=${result.cleaned}, ` +
        `skipped=${result.skipped}, ` +
        `failed=${result.failed}`,
    );

    return result;
  }
}
