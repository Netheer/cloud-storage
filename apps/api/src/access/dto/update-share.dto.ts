import { IsIn } from 'class-validator';
import { SHARE_ROLES, type ShareRole } from './create-share.dto';

export class UpdateShareDto {
  @IsIn(SHARE_ROLES)
  role!: ShareRole;
}
