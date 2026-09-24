import type { ShareRole } from './create-share.dto';

export class SharedFolderResponseDto {
  id!: string;
  name!: string;
  ownerId!: string;
  parentId!: string | null;

  role!: ShareRole;
  sharedAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}
