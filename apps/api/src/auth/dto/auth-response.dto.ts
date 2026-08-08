import { ApiProperty } from '@nestjs/swagger';
import { UserResponseDto } from '../../users/dto/user-response.dto';

export class AuthResponseDto {
  @ApiProperty({
    description: 'Short-lived JWT access token',
  })
  accessToken!: string;

  @ApiProperty({
    example: 900,
    description: 'Access token lifetime in seconds',
  })
  expiresIn!: number;

  @ApiProperty({
    type: () => UserResponseDto,
  })
  user!: UserResponseDto;
}
