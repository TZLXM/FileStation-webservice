import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { json, NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuditLog } from '../src/audit/entities/audit-log.entity';
import { FoldersService } from '../src/folders/folders.service';
import { RangeNotSatisfiableFilter } from '../src/common/http/range-not-satisfiable.filter';
import { initAndLogin, setupEnv, teardownEnv, TestEnv } from './helpers';

describe('MCP service (e2e)', () => {
  let env: TestEnv;
  let app: INestApplication;
  let adminToken: string;
  let readOnlyToken: string;
  let writeToken: string;
  let rpcId = 1;

  function decodeMcpResponse(response: any): any {
    const contentType = response.headers['content-type'] ?? '';
    if (contentType.startsWith('text/event-stream')) {
      const data = response.text.split(/\r?\n/).find((line: string) => line.startsWith('data: '));
      return JSON.parse(data?.slice('data: '.length) ?? '{}');
    }
    return response.body;
  }

  function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
    return request(app.getHttpServer())
      .post('/api/v1/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: rpcId++, method, params });
  }

  function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
    return rpc(token, 'tools/call', { name, arguments: args });
  }

  beforeAll(async () => {
    env = await setupEnv();
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    // Match main.ts ordering: route-specific parser is installed before Nest's default parser.
    const mcpJsonParser = json({ limit: '16mb' });
    app.use('/api/v1/mcp', function routeMcpJsonParser(req: Request, res: Response, next: NextFunction) {
      return mcpJsonParser(req, res, next);
    });
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    app.useGlobalFilters(new RangeNotSatisfiableFilter());
    await app.init();

    adminToken = await initAndLogin(app);
    const readTokenResponse = await request(app.getHttpServer()).post('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'mcp-read-only', scopes: ['files:read'] }).expect(201);
    readOnlyToken = readTokenResponse.body.data.token;

    const writeTokenResponse = await request(app.getHttpServer()).post('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'mcp-file-writer', scopes: ['files:write'] }).expect(201);
    writeToken = writeTokenResponse.body.data.token;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await teardownEnv(env);
  });

  it('exposes agent defaults and keeps MCP disabled until explicitly enabled', async () => {
    const settings = await request(app.getHttpServer()).get('/api/v1/settings')
      .set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(settings.body.data.agent).toEqual({ mcp_enabled: false, mcp_max_upload_mb: 32 });

    await rpc(readOnlyToken, 'tools/list').expect(404);
  });

  it('merges agent updates and suppresses no-op settings audit events', async () => {
    await request(app.getHttpServer()).put('/api/v1/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ agent: { mcp_enabled: true } }).expect(200);
    let settings = await request(app.getHttpServer()).get('/api/v1/settings')
      .set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(settings.body.data.agent).toEqual({ mcp_enabled: true, mcp_max_upload_mb: 32 });

    await request(app.getHttpServer()).put('/api/v1/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ agent: { mcp_max_upload_mb: 1 } }).expect(200);
    settings = await request(app.getHttpServer()).get('/api/v1/settings')
      .set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(settings.body.data.agent).toEqual({ mcp_enabled: true, mcp_max_upload_mb: 1 });

    const repository = app.get(DataSource).getRepository(AuditLog);
    const beforeNoOp = await repository.count({ where: { action: 'settings.updated' } });
    await request(app.getHttpServer()).put('/api/v1/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ agent: { mcp_enabled: true } }).expect(200);
    const afterNoOp = await repository.count({ where: { action: 'settings.updated' } });
    expect(afterNoOp).toBe(beforeNoOp);
  });

  it('returns 404 for GET and DELETE even while MCP is enabled', async () => {
    await request(app.getHttpServer()).get('/api/v1/mcp').expect(404);
    await request(app.getHttpServer()).delete('/api/v1/mcp').expect(404);
  });

  it('requires a case-insensitive Bearer scheme and lists exactly eleven tools', async () => {
    await request(app.getHttpServer()).post('/api/v1/mcp')
      .set('Authorization', readOnlyToken)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }).expect(401);
    await request(app.getHttpServer()).post('/api/v1/mcp')
      .set('Authorization', `Basic ${readOnlyToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }).expect(401);
    await request(app.getHttpServer()).post('/api/v1/mcp')
      .set('Authorization', 'Bearer')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }).expect(401);

    const response = await request(app.getHttpServer()).post('/api/v1/mcp')
      .set('Authorization', `bEaReR ${readOnlyToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }).expect(200);
    const names = decodeMcpResponse(response).result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual([
      'server_info', 'list_files', 'list_folders', 'create_folder', 'upload_init',
      'upload_part', 'complete_upload', 'delete_file', 'create_share', 'list_shares', 'revoke_share',
    ]);
  });

  it('returns a tool error when the token lacks that tool scope', async () => {
    const response = await callTool(readOnlyToken, 'create_folder', { name: 'must-not-exist' }).expect(200);
    const payload = decodeMcpResponse(response);
    expect(payload.result.isError).toBe(true);
    expect(payload.result.content[0].text).toContain('MISSING_SCOPE');
    expect(await app.get(FoldersService).findAll()).toEqual([]);
  });

  it('enforces the total upload cap and clamps upload chunks to eight MiB', async () => {
    const oversized = await callTool(writeToken, 'upload_init', {
      filename: 'too-large.bin', size: 1024 * 1024 + 1,
    }).expect(200);
    const oversizedPayload = decodeMcpResponse(oversized);
    expect(oversizedPayload.result.isError).toBe(true);
    expect(oversizedPayload.result.content[0].text).toContain('FILE_TOO_LARGE');

    await request(app.getHttpServer()).put('/api/v1/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ transfer: { default_chunk_size: 16 * 1024 * 1024 } }).expect(200);
    const initialized = await callTool(writeToken, 'upload_init', {
      filename: 'clamped.bin', size: 1024 * 1024,
    }).expect(200);
    const upload = JSON.parse(decodeMcpResponse(initialized).result.content[0].text);
    expect(upload.chunk_size).toBe(8 * 1024 * 1024);
    expect(upload.total_chunks).toBe(1);

    const invalidChunk = await callTool(writeToken, 'upload_init', {
      filename: 'invalid-chunk.bin', size: 1, chunk_size: 8 * 1024 * 1024 + 1,
    }).expect(200);
    expect(decodeMcpResponse(invalidChunk).result.isError).toBe(true);
  });

  it('parses MCP requests above 100 KB while other JSON routes keep their default limit', async () => {
    const base64 = Buffer.alloc(8 * 1024 * 1024, 7).toString('base64');
    const mcpResponse = await callTool(writeToken, 'upload_part', {
      upload_id: 'missing-upload', upload_token: 'invalid-upload-token', part_number: 0,
      content_base64: base64,
    }).expect(200);
    expect(decodeMcpResponse(mcpResponse).result.isError).toBe(true);

    await request(app.getHttpServer()).post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'x', extra: 'x'.repeat(120 * 1024) })
      .expect(413);
  });
});
