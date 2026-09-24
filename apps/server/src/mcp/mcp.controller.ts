import {
  Controller,
  BadRequestException,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  PayloadTooLargeException,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { json, Request, Response } from 'express';
import { API_TOKEN_SCOPES, ApiTokenScope } from '@filestation/shared';
import { ApiTokensService } from '../api-tokens/api-tokens.service';
import { SettingsService } from '../settings/settings.service';
import { McpPrincipal, McpService } from './mcp.service';

const mcpJsonParser = json({ limit: '16mb' });

function parseTokenScopes(scopesJson: string): ApiTokenScope[] | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(scopesJson);
  } catch {
    return null;
  }
  if (!Array.isArray(decoded)) return null;
  if (decoded.some((scope) => typeof scope !== 'string' || !API_TOKEN_SCOPES.includes(scope as ApiTokenScope))) {
    return null;
  }
  return decoded as ApiTokenScope[];
}

function parseMcpJsonBody(req: Request, res: Response): Promise<unknown> {
  return new Promise((resolve, reject) => {
    mcpJsonParser(req, res, (error?: Error & { type?: string }) => {
      if (error) {
        if (error.type === 'entity.too.large') {
          reject(new PayloadTooLargeException('MCP JSON body exceeds 16MB'));
        } else {
          reject(new BadRequestException('Invalid MCP JSON request body'));
        }
        return;
      }
      resolve(req.body);
    });
  });
}

function discardRequestBody(req: Request): Promise<void> {
  if (req.readableEnded || req.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      req.removeListener('end', finish);
      req.removeListener('close', finish);
      req.removeListener('error', finish);
      resolve();
    };
    req.once('end', finish);
    req.once('close', finish);
    req.once('error', finish);
    req.resume();
    if (req.readableEnded || req.destroyed) finish();
  });
}

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
    if (!agent.mcp_enabled) {
      await discardRequestBody(req);
      throw new NotFoundException('Not found');
    }

    const authorization = req.headers.authorization;
    const bearerMatch = typeof authorization === 'string'
      ? /^Bearer +(\S+)$/i.exec(authorization)
      : null;
    if (!bearerMatch) {
      await discardRequestBody(req);
      throw new UnauthorizedException('Missing API token');
    }

    const token = await this.apiTokensService.validatePlaintext(bearerMatch[1]);
    if (!token) {
      await discardRequestBody(req);
      throw new UnauthorizedException('Invalid or expired API token');
    }
    const scopes = parseTokenScopes(token.scopes);
    if (!scopes) {
      await discardRequestBody(req);
      throw new UnauthorizedException('Invalid API token scopes');
    }

    const principal: McpPrincipal = {
      accountId: token.accountId,
      tokenId: token.id,
      scopes,
      ip: req.ip ?? 'unknown',
    };
    await this.apiTokensService.touchLastUsed(token.id, principal.ip);

    const parsedBody = await parseMcpJsonBody(req, res);

    // These values only form a display convenience URL; proxy headers are not trusted.
    const baseUrl = `${req.protocol}://${req.get('host') ?? ''}`;
    const server = this.mcpService.buildServer(principal, baseUrl);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } finally {
      // Close after handleRequest settles so cleanup cannot interrupt a response in flight.
      await Promise.allSettled([
        Promise.resolve().then(() => transport.close()),
        Promise.resolve().then(() => server.close()),
      ]);
    }
  }

  @Get()
  async methodNotAllowed(@Req() req: Request): Promise<void> {
    await discardRequestBody(req);
    throw new NotFoundException('Not found');
  }

  @Delete()
  async methodNotAllowedDelete(@Req() req: Request): Promise<void> {
    await discardRequestBody(req);
    throw new NotFoundException('Not found');
  }
}
