import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response as ExpressResponse } from 'express';
import { UserResponseDto } from '../users/dto/user-response.dto';
import { AuthService } from './auth.service';
import { AuthResponseDto } from './dto/auth-response.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Post('register')
  @ApiOperation({
    summary: 'Register a new user',
  })
  @ApiCreatedResponse({
    description: 'User successfully registered',
    type: UserResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid registration data',
  })
  @ApiConflictResponse({
    description: 'User with this email already exists',
  })
  register(@Body() dto: RegisterDto): Promise<UserResponseDto> {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Log in with email and password',
  })
  @ApiOkResponse({
    description: 'Login successful',
    type: AuthResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid request data',
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid email or password',
  })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: ExpressResponse,
  ): Promise<AuthResponseDto> {
    const result = await this.authService.login(dto);

    const cookieName = this.configService.getOrThrow<string>(
      'AUTH_REFRESH_COOKIE_NAME',
    );

    const secureCookie =
      this.configService.getOrThrow<string>('AUTH_COOKIE_SECURE') === 'true';

    const refreshTtlSeconds = Number(
      this.configService.getOrThrow<string>('JWT_REFRESH_TTL_SECONDS'),
    );

    response.cookie(cookieName, result.refreshToken, {
      httpOnly: true,
      secure: secureCookie,
      sameSite: 'lax',
      path: '/auth',
      maxAge: refreshTtlSeconds * 1000,
    });

    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
    };
  }
}
