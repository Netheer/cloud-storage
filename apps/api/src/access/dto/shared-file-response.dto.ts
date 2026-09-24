import type { ShareRole } from './create-share.dto';

export class SharedFileResponseDto {
  id!: string;
  name!: string;
  ownerId!: string;
  folderId!: string | null;

  status!: string;
  mimeType!: string | null;
  size!: string | null;

  role!: ShareRole;
  sharedAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}
