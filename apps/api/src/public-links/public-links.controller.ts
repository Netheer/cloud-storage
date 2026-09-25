import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { UserResponseDto } from '../users/dto/user-response.dto';
import { CreatePublicLinkDto } from './dto/create-public-link.dto';
import {
  CreatedPublicLinkResponseDto,
  PublicLinkResponseDto,
} from './dto/public-link-response.dto';
import { PublicLinksService } from './public-links.service';

@ApiTags('Public Links')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller()
export class PublicLinksController {
  constructor(private readonly publicLinksService: PublicLinksService) {}

  @Post('folders/:id/public-links')
  @ApiCreatedResponse({
    type: CreatedPublicLinkResponseDto,
  })
  createFolderLink(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe)
    folderId: string,
    @Body() dto: CreatePublicLinkDto,
  ): Promise<CreatedPublicLinkResponseDto> {
    return this.publicLinksService.createFolderLink(user.id, folderId, dto);
  }

  @Get('folders/:id/public-links')
  @ApiOkResponse({
    type: PublicLinkResponseDto,
    isArray: true,
  })
  listFolderLinks(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe)
    folderId: string,
  ): Promise<PublicLinkResponseDto[]> {
    return this.publicLinksService.listFolderLinks(user.id, folderId);
  }

  @Delete('folders/:id/public-links/:linkId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async revokeFolderLink(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe)
    folderId: string,
    @Param('linkId', ParseUUIDPipe)
    linkId: string,
  ): Promise<void> {
    await this.publicLinksService.revokeFolderLink(user.id, folderId, linkId);
  }

  @Post('files/:id/public-links')
  @ApiCreatedResponse({
    type: CreatedPublicLinkResponseDto,
  })
  createFileLink(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe)
    fileId: string,
    @Body() dto: CreatePublicLinkDto,
  ): Promise<CreatedPublicLinkResponseDto> {
    return this.publicLinksService.createFileLink(user.id, fileId, dto);
  }

  @Get('files/:id/public-links')
  @ApiOkResponse({
    type: PublicLinkResponseDto,
    isArray: true,
  })
  listFileLinks(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe)
    fileId: string,
  ): Promise<PublicLinkResponseDto[]> {
    return this.publicLinksService.listFileLinks(user.id, fileId);
  }

  @Delete('files/:id/public-links/:linkId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async revokeFileLink(
    @CurrentUser() user: UserResponseDto,
    @Param('id', ParseUUIDPipe)
    fileId: string,
    @Param('linkId', ParseUUIDPipe)
    linkId: string,
  ): Promise<void> {
    await this.publicLinksService.revokeFileLink(user.id, fileId, linkId);
  }
}
