import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { DatabaseModule } from '../database/database.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthSessionsService } from './auth-sessions.service';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    UsersModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: {
          expiresIn: Number(
            configService.getOrThrow<string>('JWT_ACCESS_TTL_SECONDS'),
          ),
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthSessionsService, PasswordService, TokenService],
  exports: [AuthService],
})
export class AuthModule {}
