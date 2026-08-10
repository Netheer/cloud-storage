import { PickType } from '@nestjs/swagger';
import { CreateFolderDto } from './create-folder.dto';

export class RenameFolderDto extends PickType(CreateFolderDto, [
  'name',
] as const) {}
