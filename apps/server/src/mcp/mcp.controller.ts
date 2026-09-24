import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Request, Response } from 'express';
import { ApiTokensService } from '../api-tokens/api-tokens.service';
import { SettingsService } from '../settings/settings.service';
import { McpPrincipal, McpService } from './mcp.service';

@Controller('mcp')
export class McpController {
  constructor(
    private mcpService: McpService,
    private apiTokensService: ApiTokensService,
    private settingsService: SettingsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const agent = await this.settingsService.getAgentSettings();
    if (!agent.mcp_enabled) throw new NotFoundException('Not found');

    const authorization = req.headers.authorization;
    const bearerMatch = typeof authorization === 'string'
      ? /^Bearer[ \t]+(\S+)$/i.exec(authorization)
      : null;
    if (!bearerMatch) throw new UnauthorizedException('Missing API token');

    const token = await this.apiTokensService.validatePlaintext(bearerMatch[1]);
    if (!token) throw new UnauthorizedException('Invalid or expired API token');

    const principal: McpPrincipal = {
      accountId: token.accountId,
      tokenId: token.id,
      scopes: JSON.parse(token.scopes),
      ip: req.ip ?? 'unknown',
    };
    await this.apiTokensService.touchLastUsed(token.id, principal.ip);

    // These values only form a display convenience URL; proxy headers are not trusted.
    const baseUrl = `${req.protocol}://${req.get('host') ?? ''}`;
    const server = this.mcpService.buildServer(principal, baseUrl);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      // Close after handleRequest settles so cleanup cannot interrupt a response in flight.
      await Promise.allSettled([
        Promise.resolve().then(() => transport.close()),
        Promise.resolve().then(() => server.close()),
      ]);
    }
  }

  @Get()
  methodNotAllowed(): void {
    throw new NotFoundException('Not found');
  }

  @Delete()
  methodNotAllowedDelete(): void {
    throw new NotFoundException('Not found');
  }
}
