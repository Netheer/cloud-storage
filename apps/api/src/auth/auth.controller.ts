import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
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

type RequestWithCookies = {
  cookies?: Record<string, unknown>;
};

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

    this.setRefreshCookie(response, result.refreshToken);

    return this.toAuthResponse(result);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate refresh token and issue a new access token',
  })
  @ApiOkResponse({
    description: 'Tokens successfully refreshed',
    type: AuthResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or expired refresh token',
  })
  async refresh(
    @Req() request: RequestWithCookies,
    @Res({ passthrough: true }) response: ExpressResponse,
  ): Promise<AuthResponseDto> {
    const refreshToken = this.getRefreshToken(request);
    const result = await this.authService.refresh(refreshToken);

    this.setRefreshCookie(response, result.refreshToken);

    return this.toAuthResponse(result);
  }

  private getRefreshToken(request: RequestWithCookies): string {
    const cookieName = this.getRefreshCookieName();
    const refreshToken = request.cookies?.[cookieName];

    if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
      throw new UnauthorizedException('Refresh token cookie is missing');
    }

    return refreshToken;
  }

  private setRefreshCookie(
    response: ExpressResponse,
    refreshToken: string,
  ): void {
    const secureCookie =
      this.configService.getOrThrow<string>('AUTH_COOKIE_SECURE') === 'true';

    const refreshTtlSeconds = Number(
      this.configService.getOrThrow<string>('JWT_REFRESH_TTL_SECONDS'),
    );

    response.cookie(this.getRefreshCookieName(), refreshToken, {
      httpOnly: true,
      secure: secureCookie,
      sameSite: 'lax',
      path: '/auth',
      maxAge: refreshTtlSeconds * 1000,
    });
  }

  private getRefreshCookieName(): string {
    return this.configService.getOrThrow<string>('AUTH_REFRESH_COOKIE_NAME');
  }

  private toAuthResponse(result: {
    accessToken: string;
    expiresIn: number;
    user: UserResponseDto;
  }): AuthResponseDto {
    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
    };
  }
}
