import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { StorageModule } from '../storage/storage.module';
import { MaintenanceWorker } from './maintenance.worker';
import { MultipartCleanupService } from './multipart-cleanup.service';
import { StoredObjectCleanupService } from './stored-object-cleanup.service';
import { PreviewCleanupService } from './preview-cleanup.service';

@Module({
  imports: [DatabaseModule, StorageModule],
  providers: [
    MultipartCleanupService,
    MaintenanceWorker,
    PreviewCleanupService,
    StoredObjectCleanupService,
  ],
})
export class MaintenanceModule {}
