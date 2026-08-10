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

@ApiTags('Folders')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('folders')
export class FoldersController {
  constructor(private readonly foldersService: FoldersService) {}

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
}
