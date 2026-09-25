import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { DownloadFileResponseDto } from '../files/dto/download-file-response.dto';
import { PublicFileResponseDto } from './dto/public-file-response.dto';
import { PublicLinksService } from './public-links.service';
import { PublicFolderResponseDto } from './dto/public-folder-response.dto';

@ApiTags('Public Access')
@Controller('public')
export class PublicAccessController {
  constructor(private readonly publicLinksService: PublicLinksService) {}

  @Get('files/:token')
  @ApiOperation({
    summary: 'Get a file through a public link',
  })
  @ApiOkResponse({
    type: PublicFileResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Public link is invalid, expired or revoked',
  })
  getFile(@Param('token') token: string): Promise<PublicFileResponseDto> {
    return this.publicLinksService.getPublicFile(token);
  }

  @Get('files/:token/download')
  @ApiOperation({
    summary: 'Create a temporary download URL through a public link',
  })
  @ApiOkResponse({
    type: DownloadFileResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Public link is invalid, expired or revoked',
  })
  createDownloadUrl(
    @Param('token') token: string,
  ): Promise<DownloadFileResponseDto> {
    return this.publicLinksService.createPublicFileDownloadUrl(token);
  }

  @Get('folders/:token')
  @ApiOperation({
    summary: 'Browse the root of a public folder',
  })
  @ApiOkResponse({
    type: PublicFolderResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Public link is invalid, expired or revoked',
  })
  getFolderRoot(
    @Param('token') token: string,
  ): Promise<PublicFolderResponseDto> {
    return this.publicLinksService.getPublicFolderRoot(token);
  }

  @Get('folders/:token/folders/:folderId')
  @ApiOperation({
    summary: 'Browse a folder inside a public folder tree',
  })
  @ApiOkResponse({
    type: PublicFolderResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Public link or folder not found',
  })
  getFolder(
    @Param('token') token: string,
    @Param('folderId', ParseUUIDPipe)
    folderId: string,
  ): Promise<PublicFolderResponseDto> {
    return this.publicLinksService.getPublicFolder(token, folderId);
  }

  @Get('folders/:token/files/:fileId/download')
  @ApiOperation({
    summary: 'Download a file inside a public folder tree',
  })
  @ApiOkResponse({
    type: DownloadFileResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Public link or file not found',
  })
  createFolderFileDownloadUrl(
    @Param('token') token: string,
    @Param('fileId', ParseUUIDPipe)
    fileId: string,
  ): Promise<DownloadFileResponseDto> {
    return this.publicLinksService.createPublicFolderFileDownloadUrl(
      token,
      fileId,
    );
  }
}
