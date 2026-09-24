import { Transform } from 'class-transformer';
import { IsEmail, IsIn, MaxLength } from 'class-validator';

export const SHARE_ROLES = ['EDITOR', 'VIEWER'] as const;

export type ShareRole = (typeof SHARE_ROLES)[number];

export class CreateShareDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsIn(SHARE_ROLES)
  role!: ShareRole;
}
