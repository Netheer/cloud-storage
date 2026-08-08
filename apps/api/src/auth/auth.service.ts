import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { UserResponseDto } from '../users/dto/user-response.dto';
import { UsersService } from '../users/users.service';
import { AuthSessionsService } from './auth-sessions.service';
import { AuthResponseDto } from './dto/auth-response.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

export type LoginResult = AuthResponseDto & {
  refreshToken: string;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly authSessionsService: AuthSessionsService,
  ) {}

  async register(dto: RegisterDto): Promise<UserResponseDto> {
    const existingUser = await this.usersService.findByEmailForAuth(dto.email);

    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    const passwordHash = await this.passwordService.hash(dto.password);

    try {
      return await this.usersService.create({
        email: dto.email,
        passwordHash,
        displayName: dto.displayName,
      });
    } catch (error: unknown) {
      if (this.isUniqueConstraintError(error)) {
        throw new ConflictException('User with this email already exists');
      }

      throw error;
    }
  }

  async login(dto: LoginDto): Promise<LoginResult> {
    const user = await this.usersService.findByEmailForAuth(dto.email);

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordIsValid = await this.passwordService.verify(
      user.passwordHash,
      dto.password,
    );

    if (!passwordIsValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const tokens = await this.tokenService.issueTokenPair(user.id, user.email);

    await this.authSessionsService.create({
      id: tokens.sessionId,
      userId: user.id,
      refreshTokenHash: tokens.refreshTokenHash,
      expiresAt: tokens.refreshExpiresAt,
    });

    return {
      accessToken: tokens.accessToken,
      expiresIn: tokens.accessExpiresIn,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    };
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    );
  }
}
