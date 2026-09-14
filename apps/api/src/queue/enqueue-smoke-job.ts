import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { FileProcessingQueueService } from './file-processing-queue.service';
import { PrismaService } from '../database/prisma.service';

const logger = new Logger('QueueSmokeTest');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const queue = app.get(FileProcessingQueueService);
    const prisma = app.get(PrismaService);

    const file = await prisma.file.findFirst({
      where: {
        status: 'READY',
        deletedAt: null,
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        currentVersion: {
          select: {
            id: true,
            storedObjectId: true,
          },
        },
      },
    });

    if (!file?.currentVersion) {
      throw new Error(
        'No READY file with a current version was found for the smoke test',
      );
    }

    const jobId = await queue.enqueue({
      fileId: file.id,
      versionId: file.currentVersion.id,
      storedObjectId: file.currentVersion.storedObjectId,
    });

    logger.log(`Smoke job enqueued: ${jobId ?? 'unknown'}`);
  } finally {
    await app.close();
  }
}

void bootstrap().catch((error: unknown) => {
  const stack = error instanceof Error ? error.stack : String(error);

  logger.error('Failed to enqueue smoke job', stack);
  process.exitCode = 1;
});
