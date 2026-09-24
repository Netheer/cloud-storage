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
  ApiForbiddenResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { MultipartUploadStatusResponseDto } from './dto/multipart-upload-status-response.dto';
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
import { PreviewFileResponseDto } from './dto/preview-file-response.dto';
import { FileVersionResponseDto } from './dto/file-version-response.dto';
import { AccessService } from '../access/access.service';
import { CreateShareDto } from '../access/dto/create-share.dto';
import { ShareResponseDto } from '../access/dto/share-response.dto';
import { UpdateShareDto } from '../access/dto/update-share.dto';
import { SharedFileResponseDto } from '../access/dto/shared-file-response.dto';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

@ApiTags('Files')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('files')
export class FilesController {
  constructor(
    private readonly filesService: FilesService,
    private readonly accessService: AccessService,
  ) {}

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

  @Post(':id/versions')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: MAX_FILE_SIZE_BYTES,
      },
    }),
  )
  @ApiOperation({
    summary: 'Upload a new version of an existing file',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'File ID',
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
      },
    },
  })
  @ApiCreatedResponse({
    description: 'New file version uploaded successfully',
    type: FileResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'File is missing or request data is invalid',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiNotFoundResponse({
    description: 'File not found',
  })
  @ApiConflictResponse({
    description: 'File is not ready to accept a new version',
  })
  uploadVersion(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe) fileId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<FileResponseDto> {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    return this.filesService.uploadVersion(user.id, fileId, file);
  }

  @Post(':id/versions/multipart')
  @ApiOperation({
    summary: 'Initiate a resumable multipart upload for a new file version',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'File ID',
  })
  @ApiCreatedResponse({
    description: 'Multipart version upload session created or returned',
    type: MultipartUploadSessionResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Upload parameters are invalid',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiNotFoundResponse({
    description: 'File not found',
  })
  @ApiConflictResponse({
    description:
      'File is not ready to accept a new version or client request ID conflicts',
  })
  @ApiServiceUnavailableResponse({
    description: 'Object storage is temporarily unavailable',
  })
  initiateMultipartVersionUpload(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe) fileId: string,
    @Body() dto: InitiateMultipartUploadDto,
  ): Promise<MultipartUploadSessionResponseDto> {
    return this.filesService.initiateMultipartUpload(user.id, dto, fileId);
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

  @Get('multipart/:sessionId')
  @ApiOperation({
    summary: 'Get multipart upload state and uploaded parts',
  })
  @ApiParam({
    name: 'sessionId',
    format: 'uuid',
    description: 'Multipart upload session ID',
  })
  @ApiOkResponse({
    description: 'Multipart upload state returned successfully',
    type: MultipartUploadStatusResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Session ID is invalid',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiNotFoundResponse({
    description: 'Multipart upload session not found',
  })
  @ApiServiceUnavailableResponse({
    description: 'Object storage is temporarily unavailable',
  })
  getMultipartUploadStatus(
    @CurrentUser() user: UserResponseDto,
    @Param('sessionId', ParseUUIDPipe) uploadSessionId: string,
  ): Promise<MultipartUploadStatusResponseDto> {
    return this.filesService.getMultipartUploadStatus(user.id, uploadSessionId);
  }

  @Get(':id/versions')
  @ApiOperation({
    summary: 'List all versions of a file',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'File ID',
  })
  @ApiOkResponse({
    description: 'File versions returned successfully',
    type: FileVersionResponseDto,
    isArray: true,
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
  listVersions(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe) fileId: string,
  ): Promise<FileVersionResponseDto[]> {
    return this.filesService.listVersions(user.id, fileId);
  }
  @Get(':id/versions/:versionId/download')
  @ApiOperation({
    summary: 'Create a temporary download URL for a specific file version',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'File ID',
  })
  @ApiParam({
    name: 'versionId',
    format: 'uuid',
    description: 'File version ID',
  })
  @ApiOkResponse({
    description: 'Temporary version download URL created successfully',
    type: DownloadFileResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid file ID or version ID',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiNotFoundResponse({
    description: 'File version not found',
  })
  createVersionDownloadUrl(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe) fileId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ): Promise<DownloadFileResponseDto> {
    return this.filesService.createVersionDownloadUrl(
      user.id,
      fileId,
      versionId,
    );
  }

  @Post(':id/versions/:versionId/restore')
  @ApiOperation({
    summary: 'Restore a previous file version as a new version',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'File ID',
  })
  @ApiParam({
    name: 'versionId',
    format: 'uuid',
    description: 'Source file version ID',
  })
  @ApiCreatedResponse({
    description: 'File version restored successfully',
    type: FileResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid file ID or version ID',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiNotFoundResponse({
    description: 'File or file version not found',
  })
  @ApiConflictResponse({
    description: 'File is not ready or the selected version is already current',
  })
  restoreVersion(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe) fileId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ): Promise<FileResponseDto> {
    return this.filesService.restoreVersion(user.id, fileId, versionId);
  }

  @Get(':id/shares')
  @ApiOperation({
    summary: 'List users with direct access to a file',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'File ID',
  })
  @ApiOkResponse({
    description: 'File shares returned successfully',
    type: ShareResponseDto,
    isArray: true,
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiForbiddenResponse({
    description: 'Only the file owner can manage sharing',
  })
  @ApiNotFoundResponse({
    description: 'File not found',
  })
  listShares(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe) fileId: string,
  ): Promise<ShareResponseDto[]> {
    return this.accessService.listFileShares(user.id, fileId);
  }

  @Post(':id/shares')
  @ApiOperation({
    summary: 'Share a file with a registered user',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'File ID',
  })
  @ApiCreatedResponse({
    description: 'File access granted successfully',
    type: ShareResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid share data or sharing with yourself',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiForbiddenResponse({
    description: 'Only the file owner can manage sharing',
  })
  @ApiNotFoundResponse({
    description: 'File or target user not found',
  })
  @ApiConflictResponse({
    description: 'File is already directly shared with this user',
  })
  createShare(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe) fileId: string,
    @Body() dto: CreateShareDto,
  ): Promise<ShareResponseDto> {
    return this.accessService.createFileShare(user.id, fileId, dto);
  }

  @Patch(':id/shares/:grantId')
  @ApiOperation({
    summary: 'Change a user role for a shared file',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'File ID',
  })
  @ApiParam({
    name: 'grantId',
    format: 'uuid',
    description: 'File access grant ID',
  })
  @ApiOkResponse({
    description: 'File access role updated successfully',
    type: ShareResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid file ID, grant ID, or role',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiForbiddenResponse({
    description: 'Only the file owner can manage sharing',
  })
  @ApiNotFoundResponse({
    description: 'File or file share not found',
  })
  updateShare(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe) fileId: string,
    @Param('grantId', ParseUUIDPipe) grantId: string,
    @Body() dto: UpdateShareDto,
  ): Promise<ShareResponseDto> {
    return this.accessService.updateFileShare(user.id, fileId, grantId, dto);
  }

  @Delete(':id/shares/:grantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke direct access to a file',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'File ID',
  })
  @ApiParam({
    name: 'grantId',
    format: 'uuid',
    description: 'File access grant ID',
  })
  @ApiNoContentResponse({
    description: 'File access revoked successfully',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiForbiddenResponse({
    description: 'Only the file owner can manage sharing',
  })
  @ApiNotFoundResponse({
    description: 'File or file share not found',
  })
  removeShare(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe) fileId: string,
    @Param('grantId', ParseUUIDPipe) grantId: string,
  ): Promise<void> {
    return this.accessService.removeFileShare(user.id, fileId, grantId);
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

  @Get(':id/preview')
  @ApiOperation({
    summary: 'Create a temporary file preview URL',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'File ID',
  })
  @ApiOkResponse({
    description: 'Temporary preview URL created successfully',
    type: PreviewFileResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid file ID',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiNotFoundResponse({
    description: 'File or preview not found',
  })
  createPreviewUrl(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe) fileId: string,
  ): Promise<PreviewFileResponseDto> {
    return this.filesService.createPreviewUrl(user.id, fileId);
  }

  @Post('multipart/:sessionId/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete a multipart upload and create file metadata',
  })
  @ApiParam({
    name: 'sessionId',
    format: 'uuid',
    description: 'Multipart upload session ID',
  })
  @ApiOkResponse({
    description: 'Multipart upload completed successfully',
    type: FileResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Session ID is invalid',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiNotFoundResponse({
    description: 'Multipart upload session not found',
  })
  @ApiConflictResponse({
    description: 'Upload is incomplete or cannot be completed',
  })
  @ApiGoneResponse({
    description: 'Multipart upload session has expired',
  })
  @ApiServiceUnavailableResponse({
    description: 'Object storage is temporarily unavailable',
  })
  completeMultipartUpload(
    @CurrentUser() user: UserResponseDto,
    @Param('sessionId', ParseUUIDPipe) uploadSessionId: string,
  ): Promise<FileResponseDto> {
    return this.filesService.completeMultipartUpload(user.id, uploadSessionId);
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

  @Delete('multipart/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Abort a multipart upload',
  })
  @ApiParam({
    name: 'sessionId',
    format: 'uuid',
    description: 'Multipart upload session ID',
  })
  @ApiNoContentResponse({
    description: 'Multipart upload aborted successfully',
  })
  @ApiBadRequestResponse({
    description: 'Session ID is invalid',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiNotFoundResponse({
    description: 'Multipart upload session not found',
  })
  @ApiConflictResponse({
    description: 'Multipart upload cannot currently be aborted',
  })
  @ApiServiceUnavailableResponse({
    description: 'Object storage is temporarily unavailable',
  })
  abortMultipartUpload(
    @CurrentUser() user: UserResponseDto,
    @Param('sessionId', ParseUUIDPipe) uploadSessionId: string,
  ): Promise<void> {
    return this.filesService.abortMultipartUpload(user.id, uploadSessionId);
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

  @Get('shared-with-me')
  @ApiOperation({
    summary: 'List files shared directly with the current user',
  })
  @ApiOkResponse({
    description: 'Shared files returned successfully',
    type: SharedFileResponseDto,
    isArray: true,
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  listSharedWithMe(
    @CurrentUser() user: UserResponseDto,
  ): Promise<SharedFileResponseDto[]> {
    return this.accessService.listSharedFiles(user.id);
  }
}
