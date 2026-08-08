import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { UserResponseDto } from '../../users/dto/user-response.dto';

type AuthenticatedRequest = {
  user?: UserResponseDto;
};

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): UserResponseDto => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.user) {
      throw new UnauthorizedException('Authenticated user is missing');
    }

    return request.user;
  },
);
