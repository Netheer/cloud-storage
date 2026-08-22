import { ApiProperty } from '@nestjs/swagger';
import { MultipartUploadSessionResponseDto } from './multipart-upload-session-response.dto';

export class MultipartUploadedPartResponseDto {
  @ApiProperty({
    example: 1,
  })
  partNumber!: number;

  @ApiProperty({
    example: '"d41d8cd98f00b204e9800998ecf8427e"',
  })
  etag!: string;

  @ApiProperty({
    example: '8388608',
    description: 'Uploaded part size in bytes.',
  })
  size!: string;
}

export class MultipartUploadStatusResponseDto extends MultipartUploadSessionResponseDto {
  @ApiProperty({
    type: MultipartUploadedPartResponseDto,
    isArray: true,
  })
  uploadedParts!: MultipartUploadedPartResponseDto[];
}
