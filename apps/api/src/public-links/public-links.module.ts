import { Module } from '@nestjs/common';
import { AccessService } from '../access/access.service';
import { DatabaseModule } from '../database/database.module';
import { PublicLinksController } from './public-links.controller';
import { PublicLinksService } from './public-links.service';
import { PublicAccessController } from './public-access.controller';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [DatabaseModule, StorageModule],
  controllers: [PublicLinksController, PublicAccessController],
  providers: [PublicLinksService, AccessService],
  exports: [PublicLinksService],
})
export class PublicLinksModule {}
