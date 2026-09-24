import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards, Req, BadRequestException } from '@nestjs/common';
import { FoldersService } from './folders.service';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { CreateFolderDto, UpdateFolderDto } from './dto/folder.dto';
import { ApiResponse } from '@filestation/shared';
import { Request } from 'express';
import { RequireScopes } from '../security/decorators/require-scopes.decorator';

@Controller('folders')
@UseGuards(JwtAuthGuard)
export class FoldersController {
  constructor(private foldersService: FoldersService) {}

  @Post()
  @RequireScopes('folders:write')
  async create(@Body() body: CreateFolderDto, @Req() req: Request): Promise<ApiResponse<any>> {
    const folder = await this.foldersService.create(body.name, body.parent_id || null, (req as any).user.id);
    return { code: 'OK', message: 'Folder created', data: folder, request_id: crypto.randomUUID() };
  }

  @Get()
  @RequireScopes('folders:read')
  async findAll(): Promise<ApiResponse<any[]>> {
    const folders = await this.foldersService.findAll();
    return { code: 'OK', message: 'Folders retrieved', data: folders, request_id: crypto.randomUUID() };
  }

  @Get('tree')
  @RequireScopes('folders:read')
  async findTree(): Promise<ApiResponse<any[]>> {
    const tree = await this.foldersService.findTree();
    return { code: 'OK', message: 'Folder tree retrieved', data: tree, request_id: crypto.randomUUID() };
  }

  @Get(':id')
  @RequireScopes('folders:read')
  async findOne(@Param('id') id: string): Promise<ApiResponse<any>> {
    const folder = await this.foldersService.findOne(id);
    return { code: 'OK', message: 'Folder retrieved', data: folder, request_id: crypto.randomUUID() };
  }

  @Patch(':id')
  @RequireScopes('folders:write')
  async update(@Param('id') id: string, @Body() body: UpdateFolderDto): Promise<ApiResponse<any>> {
    if (body.parent_id !== undefined) {
      const folder = await this.foldersService.move(id, body.parent_id);
      return { code: 'OK', message: 'Folder moved', data: folder, request_id: crypto.randomUUID() };
    }
    if (body.name !== undefined) {
      const folder = await this.foldersService.update(id, body.name);
      return { code: 'OK', message: 'Folder updated', data: folder, request_id: crypto.randomUUID() };
    }
    throw new BadRequestException('No update fields provided');
  }

  @Delete(':id')
  @RequireScopes('folders:write')
  async delete(@Param('id') id: string): Promise<ApiResponse<null>> {
    await this.foldersService.delete(id);
    return { code: 'OK', message: 'Folder deleted', data: null, request_id: crypto.randomUUID() };
  }
}
