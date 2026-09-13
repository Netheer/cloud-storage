import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../app.module';
import { FileProcessingQueueService } from './file-processing-queue.service';

const logger = new Logger('QueueSmokeTest');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const queue = app.get(FileProcessingQueueService);

    const jobId = await queue.enqueue({
      fileId: randomUUID(),
      versionId: randomUUID(),
      storedObjectId: randomUUID(),
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
