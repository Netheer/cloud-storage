import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PrismaService } from '../database/prisma.service';
import {
  FILE_PROCESSING_QUEUE_NAME,
  PROCESS_FILE_JOB_NAME,
  type ProcessFileJob,
} from '../queue/file-processing.constants';

const PROCESS_FILE_OUTBOX_EVENT_TYPE = 'PROCESS_FILE';
const OUTBOX_POLL_INTERVAL_MS = 1000;
const OUTBOX_BATCH_SIZE = 20;

@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);

  private readonly queue: Queue<ProcessFileJob>;

  private timer: NodeJS.Timeout | null = null;
  private isPublishing = false;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    const redisHost = configService.getOrThrow<string>('REDIS_HOST');

    const redisPort = Number(configService.getOrThrow<string>('REDIS_PORT'));

    if (!Number.isInteger(redisPort)) {
      throw new Error('REDIS_PORT must be an integer');
    }

    this.queue = new Queue<ProcessFileJob>(FILE_PROCESSING_QUEUE_NAME, {
      connection: {
        host: redisHost,
        port: redisPort,
      },
    });
  }

  onModuleInit(): void {
    void this.publishPendingEvents();

    this.timer = setInterval(() => {
      void this.publishPendingEvents();
    }, OUTBOX_POLL_INTERVAL_MS);

    this.logger.log('Outbox publisher started');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    await this.queue.close();
  }

  private async publishPendingEvents(): Promise<void> {
    if (this.isPublishing) {
      return;
    }

    this.isPublishing = true;

    try {
      const events = await this.prisma.outboxEvent.findMany({
        where: {
          publishedAt: null,
        },
        orderBy: {
          createdAt: 'asc',
        },
        take: OUTBOX_BATCH_SIZE,
        select: {
          id: true,
          type: true,
          payload: true,
        },
      });

      for (const event of events) {
        await this.publishEvent(event.id, event.type, event.payload);
      }
    } catch (error: unknown) {
      const stack = error instanceof Error ? error.stack : String(error);

      this.logger.error('Failed to read pending outbox events', stack);
    } finally {
      this.isPublishing = false;
    }
  }

  private async publishEvent(
    eventId: string,
    eventType: string,
    payload: unknown,
  ): Promise<void> {
    try {
      if (eventType !== PROCESS_FILE_OUTBOX_EVENT_TYPE) {
        throw new Error(`Unsupported outbox event type: ${eventType}`);
      }

      const job = this.parseProcessFilePayload(payload);

      await this.queue.add(PROCESS_FILE_JOB_NAME, job, {
        jobId: job.versionId,
        attempts: 4,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      });

      await this.prisma.outboxEvent.update({
        where: {
          id: eventId,
        },
        data: {
          publishedAt: new Date(),
          lastError: null,
        },
      });

      this.logger.log(
        `Published outbox event ${eventId}: ` + `versionId=${job.versionId}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.warn(`Failed to publish outbox event ${eventId}: ${message}`);

      try {
        await this.prisma.outboxEvent.update({
          where: {
            id: eventId,
          },
          data: {
            attempts: {
              increment: 1,
            },
            lastError: message,
          },
        });
      } catch (updateError: unknown) {
        const stack =
          updateError instanceof Error
            ? updateError.stack
            : String(updateError);

        this.logger.error(`Failed to update outbox event ${eventId}`, stack);
      }
    }
  }

  private parseProcessFilePayload(payload: unknown): ProcessFileJob {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload)
    ) {
      throw new Error('PROCESS_FILE outbox payload must be an object');
    }

    const value = payload as Record<string, unknown>;

    if (
      typeof value.fileId !== 'string' ||
      typeof value.versionId !== 'string' ||
      typeof value.storedObjectId !== 'string'
    ) {
      throw new Error('PROCESS_FILE outbox payload is invalid');
    }

    return {
      fileId: value.fileId,
      versionId: value.versionId,
      storedObjectId: value.storedObjectId,
    };
  }
}
