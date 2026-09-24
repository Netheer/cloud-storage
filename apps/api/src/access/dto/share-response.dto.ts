import type { ShareRole } from './create-share.dto';

export class ShareResponseDto {
  id!: string;
  userId!: string;
  email!: string;
  displayName!: string | null;
  role!: ShareRole;
  createdAt!: Date;
  updatedAt!: Date;
}
