import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
  Delete,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiForbiddenResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { UserResponseDto } from '../users/dto/user-response.dto';
import { CreateFolderDto } from './dto/create-folder.dto';
import { FolderResponseDto } from './dto/folder-response.dto';
import { ListFoldersQueryDto } from './dto/list-folders-query.dto';
import { MoveFolderDto } from './dto/move-folder.dto';
import { RenameFolderDto } from './dto/rename-folder.dto';
import { FoldersService } from './folders.service';
import { AccessService } from '../access/access.service';
import { CreateShareDto } from '../access/dto/create-share.dto';
import { ShareResponseDto } from '../access/dto/share-response.dto';
import { UpdateShareDto } from '../access/dto/update-share.dto';
import { SharedFolderResponseDto } from '../access/dto/shared-folder-response.dto';

@ApiTags('Folders')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('folders')
export class FoldersController {
  constructor(
    private readonly foldersService: FoldersService,
    private readonly accessService: AccessService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List root folders or children of a folder',
  })
  @ApiOkResponse({
    description: 'Folders returned successfully',
    type: FolderResponseDto,
    isArray: true,
  })
  @ApiBadRequestResponse({
    description: 'Invalid parent folder ID',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiNotFoundResponse({
    description: 'Parent folder not found',
  })
  list(
    @CurrentUser() user: UserResponseDto,
    @Query() query: ListFoldersQueryDto,
  ): Promise<FolderResponseDto[]> {
    return this.foldersService.list(user.id, query.parentId);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a root or nested folder',
  })
  @ApiCreatedResponse({
    description: 'Folder successfully created',
    type: FolderResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid folder name or parent ID',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiNotFoundResponse({
    description: 'Parent folder not found',
  })
  create(
    @CurrentUser() user: UserResponseDto,
    @Body() dto: CreateFolderDto,
  ): Promise<FolderResponseDto> {
    return this.foldersService.create(user.id, dto);
  }
  @Get(':id/shares')
  @ApiOperation({
    summary: 'List users with direct access to a folder',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Folder ID',
  })
  @ApiOkResponse({
    description: 'Folder shares returned successfully',
    type: ShareResponseDto,
    isArray: true,
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiForbiddenResponse({
    description: 'Only the folder owner can manage sharing',
  })
  @ApiNotFoundResponse({
    description: 'Folder not found',
  })
  listShares(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe) folderId: string,
  ): Promise<ShareResponseDto[]> {
    return this.accessService.listFolderShares(user.id, folderId);
  }

  @Post(':id/shares')
  @ApiOperation({
    summary: 'Share a folder with a registered user',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Folder ID',
  })
  @ApiCreatedResponse({
    description: 'Folder access granted successfully',
    type: ShareResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid share data or sharing with yourself',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiForbiddenResponse({
    description: 'Only the folder owner can manage sharing',
  })
  @ApiNotFoundResponse({
    description: 'Folder or target user not found',
  })
  @ApiConflictResponse({
    description: 'Folder is already shared with this user',
  })
  createShare(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe) folderId: string,
    @Body() dto: CreateShareDto,
  ): Promise<ShareResponseDto> {
    return this.accessService.createFolderShare(user.id, folderId, dto);
  }

  @Patch(':id/shares/:grantId')
  @ApiOperation({
    summary: 'Change a user role for a shared folder',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Folder ID',
  })
  @ApiParam({
    name: 'grantId',
    format: 'uuid',
    description: 'Folder access grant ID',
  })
  @ApiOkResponse({
    description: 'Folder access role updated successfully',
    type: ShareResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid folder ID, grant ID, or role',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiForbiddenResponse({
    description: 'Only the folder owner can manage sharing',
  })
  @ApiNotFoundResponse({
    description: 'Folder or folder share not found',
  })
  updateShare(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe) folderId: string,
    @Param('grantId', ParseUUIDPipe) grantId: string,
    @Body() dto: UpdateShareDto,
  ): Promise<ShareResponseDto> {
    return this.accessService.updateFolderShare(
      user.id,
      folderId,
      grantId,
      dto,
    );
  }

  @Delete(':id/shares/:grantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke direct access to a folder',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Folder ID',
  })
  @ApiParam({
    name: 'grantId',
    format: 'uuid',
    description: 'Folder access grant ID',
  })
  @ApiNoContentResponse({
    description: 'Folder access revoked successfully',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiForbiddenResponse({
    description: 'Only the folder owner can manage sharing',
  })
  @ApiNotFoundResponse({
    description: 'Folder or folder share not found',
  })
  removeShare(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe) folderId: string,
    @Param('grantId', ParseUUIDPipe) grantId: string,
  ): Promise<void> {
    return this.accessService.removeFolderShare(user.id, folderId, grantId);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Rename a folder',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Folder ID',
  })
  @ApiOkResponse({
    description: 'Folder successfully renamed',
    type: FolderResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid folder ID or name',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiNotFoundResponse({
    description: 'Folder not found',
  })
  rename(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe) folderId: string,
    @Body() dto: RenameFolderDto,
  ): Promise<FolderResponseDto> {
    return this.foldersService.rename(user.id, folderId, dto);
  }

  @Patch(':id/move')
  @ApiOperation({
    summary: 'Move a folder to another folder or to root',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Folder ID',
  })
  @ApiOkResponse({
    description: 'Folder successfully moved',
    type: FolderResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid folder ID, destination ID, or cyclic move',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  @ApiNotFoundResponse({
    description: 'Folder or destination folder not found',
  })
  move(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe) folderId: string,
    @Body() dto: MoveFolderDto,
  ): Promise<FolderResponseDto> {
    return this.foldersService.move(user.id, folderId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an empty folder',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Folder ID',
  })
  @ApiNoContentResponse({
    description: 'Folder successfully deleted',
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
  @ApiConflictResponse({
    description: 'Folder is not empty',
  })
  remove(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe) folderId: string,
  ): Promise<void> {
    return this.foldersService.remove(user.id, folderId);
  }

  @Get('shared-with-me')
  @ApiOperation({
    summary: 'List folders shared directly with the current user',
  })
  @ApiOkResponse({
    description: 'Shared folders returned successfully',
    type: SharedFolderResponseDto,
    isArray: true,
  })
  @ApiUnauthorizedResponse({
    description: 'Access token is missing or invalid',
  })
  listSharedWithMe(
    @CurrentUser() user: UserResponseDto,
  ): Promise<SharedFolderResponseDto[]> {
    return this.accessService.listSharedFolders(user.id);
  }
}
