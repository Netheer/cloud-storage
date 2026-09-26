import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, Worker, UnrecoverableError } from 'bullmq';
import {
  MAINTENANCE_QUEUE_NAME,
  MULTIPART_CLEANUP_INTERVAL_MS,
  MULTIPART_CLEANUP_JOB_NAME,
  MULTIPART_CLEANUP_SCHEDULER_ID,
  STORED_OBJECT_CLEANUP_INTERVAL_MS,
  STORED_OBJECT_CLEANUP_JOB_NAME,
  STORED_OBJECT_CLEANUP_SCHEDULER_ID,
  PREVIEW_CLEANUP_INTERVAL_MS,
  PREVIEW_CLEANUP_JOB_NAME,
  PREVIEW_CLEANUP_SCHEDULER_ID,
} from './maintenance.constants';
import { MultipartCleanupService } from './multipart-cleanup.service';
import { StoredObjectCleanupService } from './stored-object-cleanup.service';
import { PreviewCleanupService } from './preview-cleanup.service';

type MaintenanceJobData = Record<string, never>;

@Injectable()
export class MaintenanceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceWorker.name);

  private readonly redisHost: string;
  private readonly redisPort: number;

  private queue: Queue<MaintenanceJobData> | null = null;
  private worker: Worker<MaintenanceJobData> | null = null;

  constructor(
    configService: ConfigService,
    private readonly multipartCleanupService: MultipartCleanupService,
    private readonly storedObjectCleanupService: StoredObjectCleanupService,
    private readonly previewCleanupService: PreviewCleanupService,
  ) {
    this.redisHost = configService.getOrThrow<string>('REDIS_HOST');
    this.redisPort = Number(configService.getOrThrow<string>('REDIS_PORT'));

    if (!Number.isInteger(this.redisPort)) {
      throw new Error('REDIS_PORT must be an integer');
    }
  }

  async onModuleInit(): Promise<void> {
    const connection = {
      host: this.redisHost,
      port: this.redisPort,
    };

    this.queue = new Queue<MaintenanceJobData>(MAINTENANCE_QUEUE_NAME, {
      connection,
    });

    this.worker = new Worker<MaintenanceJobData>(
      MAINTENANCE_QUEUE_NAME,
      async (job: Job<MaintenanceJobData>): Promise<void> => {
        switch (job.name) {
          case MULTIPART_CLEANUP_JOB_NAME: {
            const result = await this.multipartCleanupService.cleanupBatch();

            this.logger.log(
              `Multipart cleanup job ${job.id} completed: ` +
                `scanned=${result.scanned}, ` +
                `cleaned=${result.cleaned}, ` +
                `skipped=${result.skipped}, ` +
                `failed=${result.failed}`,
            );

            return;
          }

          case STORED_OBJECT_CLEANUP_JOB_NAME: {
            const databaseResult =
              await this.storedObjectCleanupService.cleanupDatabaseOrphans();

            const physicalResult =
              await this.storedObjectCleanupService.cleanupPhysicalOrphans();

            this.logger.log(
              `StoredObject cleanup job ${job.id} completed: ` +
                `db(scanned=${databaseResult.scanned}, ` +
                `cleaned=${databaseResult.cleaned}, ` +
                `skipped=${databaseResult.skipped}, ` +
                `failed=${databaseResult.failed}), ` +
                `physical(scanned=${physicalResult.scanned}, ` +
                `cleaned=${physicalResult.cleaned}, ` +
                `skipped=${physicalResult.skipped}, ` +
                `failed=${physicalResult.failed})`,
            );

            return;
          }

          case PREVIEW_CLEANUP_JOB_NAME: {
            const result = await this.previewCleanupService.cleanupBatch();

            this.logger.log(
              `Preview cleanup job ${job.id} completed: ` +
                `scanned=${result.scanned}, ` +
                `cleaned=${result.cleaned}, ` +
                `skipped=${result.skipped}, ` +
                `failed=${result.failed}`,
            );

            return;
          }

          default:
            throw new UnrecoverableError(
              `Unsupported maintenance job name: ${job.name}`,
            );
        }
      },
      {
        connection,
        concurrency: 1,
      },
    );

    this.worker.on('completed', (job) => {
      this.logger.log(`Maintenance job ${job.id} (${job.name}) completed`);
    });

    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `Maintenance job ${job?.id ?? 'unknown'} ` +
          `(${job?.name ?? 'unknown'}) failed: ${error.message}`,
        error.stack,
      );
    });

    this.worker.on('error', (error) => {
      this.logger.error('Maintenance BullMQ worker error', error.stack);
    });

    await this.queue.upsertJobScheduler(
      MULTIPART_CLEANUP_SCHEDULER_ID,
      {
        every: MULTIPART_CLEANUP_INTERVAL_MS,
      },
      {
        name: MULTIPART_CLEANUP_JOB_NAME,
        data: {},
        opts: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      },
    );

    await this.queue.upsertJobScheduler(
      STORED_OBJECT_CLEANUP_SCHEDULER_ID,
      {
        every: STORED_OBJECT_CLEANUP_INTERVAL_MS,
      },
      {
        name: STORED_OBJECT_CLEANUP_JOB_NAME,
        data: {},
        opts: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      },
    );

    await this.queue.upsertJobScheduler(
      PREVIEW_CLEANUP_SCHEDULER_ID,
      {
        every: PREVIEW_CLEANUP_INTERVAL_MS,
      },
      {
        name: PREVIEW_CLEANUP_JOB_NAME,
        data: {},
        opts: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      },
    );

    this.logger.log(
      `Scheduled "${PREVIEW_CLEANUP_JOB_NAME}" every ` +
        `${PREVIEW_CLEANUP_INTERVAL_MS / 1000} seconds`,
    );

    this.logger.log(
      `Scheduled "${STORED_OBJECT_CLEANUP_JOB_NAME}" every ` +
        `${STORED_OBJECT_CLEANUP_INTERVAL_MS / 1000} seconds`,
    );

    this.logger.log(
      `Scheduled "${MULTIPART_CLEANUP_JOB_NAME}" every ` +
        `${MULTIPART_CLEANUP_INTERVAL_MS / 1000} seconds`,
    );

    this.logger.log(`Listening on queue "${MAINTENANCE_QUEUE_NAME}"`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
