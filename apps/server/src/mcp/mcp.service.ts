import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHash } from 'crypto';
import { z } from 'zod';
import { FilesService } from '../files/files.service';
import { UploadsService } from '../files/uploads.service';
import { FoldersService } from '../folders/folders.service';
import { SharesService } from '../shares/shares.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { ShareProtection, ShareType } from '../shares/entities/share.entity';

export interface McpPrincipal {
  accountId: string;
  tokenId: string;
  scopes: string[];
  ip: string;
}

type McpToolSchema = Record<string, z.ZodTypeAny>;
type McpToolArguments<Schema extends McpToolSchema> = {
  [Key in keyof Schema]: z.infer<Schema[Key]>;
};
type McpTextResult = { content: Array<{ type: 'text'; text: string }> };

@Injectable()
export class McpService {
  constructor(
    private filesService: FilesService,
    private uploadsService: UploadsService,
    private foldersService: FoldersService,
    private sharesService: SharesService,
    private settingsService: SettingsService,
    private auditService: AuditService,
  ) {}

  assertScope(principal: McpPrincipal, scope: string): void {
    if (!principal.scopes.includes(scope)) {
      throw new Error(`MISSING_SCOPE: tool requires scope "${scope}"`);
    }
  }

  /** Build a request-local MCP server. No protocol session state is retained. */
  buildServer(principal: McpPrincipal, baseUrl: string): McpServer {
    const server = new McpServer(
      { name: 'filestation', version: '0.2.0' },
      { capabilities: { tools: {} } },
    );
    const audit = (tool: string, details?: Record<string, unknown>) =>
      this.auditService.record({
        accountId: principal.accountId,
        action: 'mcp.tool_called',
        resourceType: 'mcp_tool',
        resourceId: tool,
        details,
        ip: principal.ip,
      });
    const text = (value: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    });
    // SDK 1.30's compatibility overload unions Zod 3 and Zod 4 schemas and can
    // exceed TypeScript's instantiation depth for ordinary Zod 3 raw shapes.
    // Keep handler inference on the pinned Zod 3 types and invoke the same tool API.
    const registerTool = <Schema extends McpToolSchema>(
      name: string,
      description: string,
      schema: Schema,
      handler: (args: McpToolArguments<Schema>) => Promise<McpTextResult>,
    ) => Reflect.apply(server.tool, server, [name, description, schema, handler]);

    registerTool('server_info', 'FileStation 站点与能力信息', {}, async () => {
      await audit('server_info');
      const site = await this.settingsService.getSiteSettings();
      const agent = await this.settingsService.getAgentSettings();
      return text({
        site_name: site.name,
        mcp_max_upload_mb: agent.mcp_max_upload_mb,
        server_time: new Date().toISOString(),
      });
    });

    registerTool('list_files', '列出文件（分页）', {
      page: z.number().int().min(1).default(1),
      page_size: z.number().int().min(1).max(100).default(20),
      folder_id: z.string().optional(),
    }, async ({ page, page_size, folder_id }) => {
      this.assertScope(principal, 'files:read');
      await audit('list_files');
      const { items, total } = await this.filesService.findAll(page, page_size, folder_id);
      return text({
        total,
        items: items.map((file) => ({
          id: file.id,
          filename: file.filename,
          size: file.size,
          expires_at: file.expiresAt ? new Date(file.expiresAt).toISOString() : null,
          download_count: file.downloadCount,
        })),
      });
    });

    registerTool('list_folders', '列出全部文件夹', {}, async () => {
      this.assertScope(principal, 'folders:read');
      await audit('list_folders');
      const folders = await this.foldersService.findAll();
      return text(folders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        parent_id: folder.parentId,
      })));
    });

    registerTool('create_folder', '新建文件夹', {
      name: z.string().min(1).max(128),
      parent_id: z.string().nullable().default(null),
    }, async ({ name, parent_id }) => {
      this.assertScope(principal, 'folders:write');
      const folder = await this.foldersService.create(name, parent_id, principal.accountId);
      await audit('create_folder', { folder_id: folder.id });
      return text({ id: folder.id, name: folder.name });
    });

    registerTool(
      'upload_init',
      '开始上传：校验单文件总大小上限并创建会话；未提供 chunk_size 时取 min(8MiB, 系统默认分块大小)，支持的分块大小为 64KiB 至 8MiB。',
      {
        filename: z.string().min(1).max(255),
        size: z.number().int().min(0),
        folder_id: z.string().optional(),
        chunk_size: z.number().int().min(64 * 1024).max(8 * 1024 * 1024).optional(),
      },
      async ({ filename, size, folder_id, chunk_size }) => {
        this.assertScope(principal, 'files:write');
        const agent = await this.settingsService.getAgentSettings();
        const maxBytes = agent.mcp_max_upload_mb * 1024 * 1024;
        if (size > maxBytes) {
          throw new Error(`FILE_TOO_LARGE: ${size} bytes > limit ${maxBytes} (agent.mcp_max_upload_mb)`);
        }

        const transfer = await this.settingsService.getTransferSettings();
        const effectiveChunkSize = chunk_size ?? Math.min(8 * 1024 * 1024, transfer.default_chunk_size);
        const upload = await this.uploadsService.initializeUpload(
          { filename, size, chunk_size: effectiveChunkSize, folder_id },
          'admin',
          principal.accountId,
        );
        await audit('upload_init', { upload_id: upload.upload_id, filename, size });
        return text({
          upload_id: upload.upload_id,
          upload_token: upload.upload_token,
          chunk_size: upload.chunk_size,
          total_chunks: Math.max(1, Math.ceil(size / upload.chunk_size)),
          next: '对 part_number ∈ [0, total_chunks) 逐块调 upload_part（content_base64 的原始字节 ≤ chunk_size），全部成功后调 complete_upload',
        });
      },
    );

    registerTool('upload_part', '上传一个分块（content_base64 解码后的字节数须符合 upload_init 返回的 chunk_size，最大 8MiB）', {
      upload_id: z.string(),
      upload_token: z.string(),
      part_number: z.number().int().min(0),
      content_base64: z.string(),
    }, async ({ upload_id, upload_token, part_number, content_base64 }) => {
      this.assertScope(principal, 'files:write');
      const data = Buffer.from(content_base64, 'base64');
      const checksum = createHash('sha256').update(data).digest('hex');
      await this.uploadsService.uploadPart(upload_id, part_number, data, checksum, upload_token);
      await audit('upload_part', { upload_id, part_number, size: data.length });
      return text({ upload_id, part_number, received_bytes: data.length });
    });

    registerTool('complete_upload', '全部分块就绪后合并为文件，返回 file_id（幂等）', {
      upload_id: z.string(),
      upload_token: z.string(),
    }, async ({ upload_id, upload_token }) => {
      this.assertScope(principal, 'files:write');
      const { file_id } = await this.uploadsService.completeUpload(upload_id, upload_token);
      await audit('complete_upload', { upload_id, file_id });
      return text({ file_id });
    });

    registerTool('delete_file', '删除文件（进入清理队列）', {
      file_id: z.string(),
    }, async ({ file_id }) => {
      this.assertScope(principal, 'files:write');
      await this.filesService.delete(file_id);
      await audit('delete_file', { file_id });
      return text({ deleted: file_id });
    });

    registerTool('create_share', '为文件创建分享链接', {
      file_id: z.string(),
      protection: z.enum(['none', 'password']).default('none'),
      password: z.string().min(4).optional(),
      max_downloads: z.number().int().min(1).optional(),
      expires_in_hours: z.number().int().min(1).optional(),
    }, async ({ file_id, protection, password, max_downloads, expires_in_hours }) => {
      this.assertScope(principal, 'shares:write');
      if (protection === 'password' && !password) {
        throw new Error('PASSWORD_REQUIRED: protection=password 时必须提供 password');
      }
      const share = await this.sharesService.createShare(
        file_id,
        ShareType.PAGE,
        protection === 'password' ? ShareProtection.PASSWORD : ShareProtection.NONE,
        password ?? null,
        max_downloads ?? null,
        expires_in_hours ? new Date(Date.now() + expires_in_hours * 3_600_000) : null,
        principal.accountId,
      );
      await audit('create_share', { share_id: share.id, protection });
      return text({
        share_id: share.id,
        share_url: `/s/${share.id}`,
        share_url_absolute: `${baseUrl}/s/${share.id}`,
      });
    });

    registerTool('list_shares', '列出分享（可按文件过滤）', {
      file_id: z.string().optional(),
    }, async ({ file_id }) => {
      this.assertScope(principal, 'shares:read');
      await audit('list_shares');
      const shares = file_id
        ? await this.sharesService.findByFile(file_id)
        : await this.sharesService.findAll();
      return text(shares.map((share) => ({
        share_id: share.id,
        share_url: `/s/${share.id}`,
        share_url_absolute: `${baseUrl}/s/${share.id}`,
        file_id: share.fileId,
        protection: share.protection,
        status: share.status,
        used_downloads: share.usedDownloads,
        max_downloads: share.maxDownloads,
        expires_at: share.expiresAt ? new Date(share.expiresAt).toISOString() : null,
      })));
    });

    registerTool('revoke_share', '吊销分享链接', {
      share_id: z.string(),
    }, async ({ share_id }) => {
      this.assertScope(principal, 'shares:write');
      await this.sharesService.revokeShare(share_id);
      await audit('revoke_share', { share_id });
      return text({ revoked: share_id });
    });

    return server;
  }
}
