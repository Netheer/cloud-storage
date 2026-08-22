import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  Param,
  ParseUUIDPipe,
  Patch,
  Delete,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiParam,
  ApiNoContentResponse,
  ApiConflictResponse,
  ApiServiceUnavailableResponse,
  ApiGoneResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { UserResponseDto } from '../users/dto/user-response.dto';
import { FileResponseDto } from './dto/file-response.dto';
import { ListFilesQueryDto } from './dto/list-files-query.dto';
import { UploadFileDto } from './dto/upload-file.dto';
import { FilesService } from './files.service';
import { DownloadFileResponseDto } from './dto/download-file-response.dto';
import { RenameFileDto } from './dto/rename-file.dto';
import { MoveFileDto } from './dto/move-file.dto';
import { InitiateMultipartUploadDto } from './dto/initiate-multipart-upload.dto';
import { MultipartUploadSessionResponseDto } from './dto/multipart-upload-session-response.dto';
import { MultipartUploadPartUrlResponseDto } from './dto/multipart-upload-part-url-response.dto';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

@ApiTags('Files')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('files')
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: MAX_FILE_SIZE_BYTES,
      },
    }),
  )
  @ApiOperation({
    summary: 'Upload a small file to root or a folder',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
        folderId: {
          type: 'string',
          format: 'uuid',
          description: 'Destination folder ID. Omit to upload to root.',
        },
      },
    },
  })
  @ApiCreatedResponse({
    description: 'File uploaded successfully',
    type: FileResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'File is missing or request data is invalid',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiNotFoundResponse({
    description: 'Destination folder not found',
  })
  upload(
    @CurrentUser() user: UserResponseDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadFileDto,
  ): Promise<FileResponseDto> {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    return this.filesService.upload(user.id, file, dto);
  }

  @Post('multipart')
  @ApiOperation({
    summary: 'Initiate a resumable multipart upload',
  })
  @ApiCreatedResponse({
    description: 'Multipart upload session created or returned',
    type: MultipartUploadSessionResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Upload parameters are invalid',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiNotFoundResponse({
    description: 'Destination folder not found',
  })
  @ApiConflictResponse({
    description: 'Client request ID is already used with different parameters',
  })
  @ApiServiceUnavailableResponse({
    description: 'Object storage is temporarily unavailable',
  })
  initiateMultipartUpload(
    @CurrentUser() user: UserResponseDto,
    @Body() dto: InitiateMultipartUploadDto,
  ): Promise<MultipartUploadSessionResponseDto> {
    return this.filesService.initiateMultipartUpload(user.id, dto);
  }

  @Post('multipart/:sessionId/parts/:partNumber')
  @ApiOperation({
    summary: 'Create a temporary URL for uploading one file part',
  })
  @ApiParam({
    name: 'sessionId',
    format: 'uuid',
    description: 'Multipart upload session ID',
  })
  @ApiParam({
    name: 'partNumber',
    type: Number,
    description: 'Part number starting from 1',
  })
  @ApiCreatedResponse({
    description: 'Temporary upload URL created successfully',
    type: MultipartUploadPartUrlResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Session ID or part number is invalid',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiNotFoundResponse({
    description: 'Multipart upload session not found',
  })
  @ApiConflictResponse({
    description: 'Multipart upload session is not accepting parts',
  })
  @ApiGoneResponse({
    description: 'Multipart upload session has expired',
  })
  @ApiServiceUnavailableResponse({
    description: 'Object storage is temporarily unavailable',
  })
  createMultipartUploadPartUrl(
    @CurrentUser() user: UserResponseDto,
    @Param('sessionId', ParseUUIDPipe) uploadSessionId: string,
    @Param('partNumber', ParseIntPipe) partNumber: number,
  ): Promise<MultipartUploadPartUrlResponseDto> {
    return this.filesService.createMultipartUploadPartUrl(
      user.id,
      uploadSessionId,
      partNumber,
    );
  }

  @Get()
  @ApiOperation({
    summary: 'List root files or files in a folder',
  })
  @ApiOkResponse({
    description: 'Files returned successfully',
    type: FileResponseDto,
    isArray: true,
  })
  @ApiBadRequestResponse({
    description: 'Invalid folder ID',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiNotFoundResponse({
    description: 'Folder not found',
  })
  list(
    @CurrentUser() user: UserResponseDto,
    @Query() query: ListFilesQueryDto,
  ): Promise<FileResponseDto[]> {
    return this.filesService.list(user.id, query.folderId);
  }

  @Get(':id/download')
  @ApiOperation({
    summary: 'Create a temporary file download URL',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'File ID',
  })
  @ApiOkResponse({
    description: 'Temporary download URL created successfully',
    type: DownloadFileResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid file ID',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiNotFoundResponse({
    description: 'File not found',
  })
  createDownloadUrl(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe) fileId: string,
  ): Promise<DownloadFileResponseDto> {
    return this.filesService.createDownloadUrl(user.id, fileId);
  }

  @Patch(':id/move')
  @ApiOperation({
    summary: 'Move a file to another folder or to root',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'File ID',
  })
  @ApiOkResponse({
    description: 'File moved successfully',
    type: FileResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid file ID or destination folder ID',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiNotFoundResponse({
    description: 'File or destination folder not found',
  })
  move(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe) fileId: string,
    @Body() dto: MoveFileDto,
  ): Promise<FileResponseDto> {
    return this.filesService.move(user.id, fileId, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Rename a file',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'File ID',
  })
  @ApiOkResponse({
    description: 'File renamed successfully',
    type: FileResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid file ID or name',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiNotFoundResponse({
    description: 'File not found',
  })
  rename(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe) fileId: string,
    @Body() dto: RenameFileDto,
  ): Promise<FileResponseDto> {
    return this.filesService.rename(user.id, fileId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a file and its stored object',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'File ID',
  })
  @ApiNoContentResponse({
    description: 'File deleted successfully',
  })
  @ApiBadRequestResponse({
    description: 'Invalid file ID',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiNotFoundResponse({
    description: 'File not found',
  })
  remove(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe) fileId: string,
  ): Promise<void> {
    return this.filesService.remove(user.id, fileId);
  }
}
