import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import * as http from 'http';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuditLog } from '../src/audit/entities/audit-log.entity';
import { FoldersService } from '../src/folders/folders.service';
import { ApiToken } from '../src/api-tokens/entities/api-token.entity';
import { UploadsService } from '../src/files/uploads.service';
import { installNonMcpBodyParsers } from '../src/common/http/body-parsers';
import { RangeNotSatisfiableFilter } from '../src/common/http/range-not-satisfiable.filter';
import { initAndLogin, setupEnv, teardownEnv, TestEnv } from './helpers';

describe('MCP service (e2e)', () => {
  let env: TestEnv;
  let app: INestApplication;
  let adminToken: string;
  let readOnlyToken: string;
  let readOnlyTokenId: string;
  let writeToken: string;
  let writeTokenId: string;
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

  function rawJson(method: 'post' | 'get' | 'delete', body: string) {
    const agent = request(app.getHttpServer());
    const route = method === 'post'
      ? agent.post('/api/v1/mcp')
      : method === 'get'
        ? agent.get('/api/v1/mcp')
        : agent.delete('/api/v1/mcp');
    return route.set('Content-Type', 'application/json').send(body);
  }

  function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
    return rpc(token, 'tools/call', { name, arguments: args });
  }

  beforeAll(async () => {
    env = await setupEnv();
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    installNonMcpBodyParsers(app);
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    app.useGlobalFilters(new RangeNotSatisfiableFilter());
    await app.init();
    await app.listen(0);

    adminToken = await initAndLogin(app);
    const readTokenResponse = await request(app.getHttpServer()).post('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'mcp-read-only', scopes: ['files:read'] }).expect(201);
    readOnlyToken = readTokenResponse.body.data.token;
    readOnlyTokenId = readTokenResponse.body.data.id;

    const writeTokenResponse = await request(app.getHttpServer()).post('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'mcp-file-writer', scopes: ['files:write'] }).expect(201);
    writeToken = writeTokenResponse.body.data.token;
    writeTokenId = writeTokenResponse.body.data.id;
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

  it('returns 404 for disabled MCP before parsing malformed POST bodies', async () => {
    await rawJson('post', '{"malformed":}').expect(404);
  });

  it('returns 404 for disabled MCP before parsing an oversized POST body', async () => {
    const oversizedJson = `{"body":"${'x'.repeat(16 * 1024 * 1024)}"}`;
    await rawJson('post', oversizedJson).expect(404);
  });

  it('returns disabled 404 promptly while a chunked MCP body remains open', async () => {
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('Expected an active local HTTP server');
    const client = http.request({
      host: address.address.includes(':') ? '::1' : '127.0.0.1',
      port: address.port,
      path: '/api/v1/mcp',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
    });
    const responseStatus = new Promise<number | null>((resolve) => {
      client.once('response', (response) => {
        response.resume();
        resolve(response.statusCode ?? null);
      });
      client.once('error', () => resolve(null));
    });
    let deadline: NodeJS.Timeout | undefined;
    const timedResponse = new Promise<null>((resolve) => {
      deadline = setTimeout(() => resolve(null), 2500);
    });

    try {
      client.flushHeaders();
      client.write('{"partial":');
      expect(await Promise.race([responseStatus, timedResponse])).toBe(404);
    } finally {
      if (deadline) clearTimeout(deadline);
      client.destroy();
    }
  }, 10_000);

  it.each(['get', 'delete'] as const)(
    'returns 404 for %s before parsing a malformed MCP body',
    async (method) => {
      await rawJson(method, '{"malformed":}').expect(404);
    },
  );

  it.each(['get', 'delete'] as const)(
    'returns 404 for %s before parsing an oversized MCP body',
    async (method) => {
      const oversizedJson = `{"body":"${'x'.repeat(16 * 1024 * 1024)}"}`;
      await rawJson(method, oversizedJson).expect(404);
    },
  );

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
    await request(app.getHttpServer()).post('/api/v1/mcp')
      .set('Authorization', `Bearer\t${readOnlyToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }).expect(401);

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

  it.each([
    ['malformed JSON', '{not-json'],
    ['a scalar scope string', '"files:read"'],
    ['an unknown scope', '["root:all"]'],
    ['a non-string scope member', '["files:read",7]'],
  ])('rejects API token scopes stored as %s before recording token use', async (_caseName, scopes) => {
    const repository = app.get(DataSource).getRepository(ApiToken);
    const original = await repository.findOneByOrFail({ id: readOnlyTokenId });
    await repository.update(readOnlyTokenId, { scopes, lastUsedAt: null, lastUsedIp: null });

    try {
      const response = await rpc(readOnlyToken, 'tools/list');
      const after = await repository.findOneByOrFail({ id: readOnlyTokenId });
      expect({ status: response.status, lastUsedAt: after.lastUsedAt }).toEqual({ status: 401, lastUsedAt: null });
    } finally {
      await repository.update(readOnlyTokenId, {
        scopes: original.scopes,
        lastUsedAt: original.lastUsedAt,
        lastUsedIp: original.lastUsedIp,
      });
    }
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

  it('reports zero-byte uploads as zero parts with a direct-complete instruction', async () => {
    const uploadPart = jest.spyOn(app.get(UploadsService), 'uploadPart');
    try {
      const response = await callTool(writeToken, 'upload_init', {
        filename: 'empty.bin', size: 0,
      }).expect(200);
      const upload = JSON.parse(decodeMcpResponse(response).result.content[0].text);
      expect(upload.total_chunks).toBe(0);
      expect(upload.next).toContain('直接调用 complete_upload');
      expect(upload.next).not.toContain('upload_part 0');

      const completeResponse = await callTool(writeToken, 'complete_upload', {
        upload_id: upload.upload_id,
        upload_token: upload.upload_token,
      }).expect(200);
      const completeResult = JSON.parse(decodeMcpResponse(completeResponse).result.content[0].text);
      expect(typeof completeResult.file_id).toBe('string');
      expect(completeResult.file_id.length).toBeGreaterThan(0);
      expect(uploadPart).not.toHaveBeenCalled();
    } finally {
      uploadPart.mockRestore();
    }
  });

  it('rejects decoded upload parts larger than eight MiB before UploadsService and audit', async () => {
    const repository = app.get(DataSource).getRepository(ApiToken);
    const token = await repository.findOneByOrFail({ id: writeTokenId });
    const uploadsService = app.get(UploadsService);
    const session = await uploadsService.initializeUpload({
      filename: 'large-chunk.bin',
      size: 8 * 1024 * 1024 + 1,
      chunk_size: 8 * 1024 * 1024 + 1,
    }, 'admin', token.accountId);
    const uploadPart = jest.spyOn(uploadsService, 'uploadPart');
    const auditRepository = app.get(DataSource).getRepository(AuditLog);
    const beforeAudits = await auditRepository.count({ where: { action: 'mcp.tool_called', resourceId: 'upload_part' } });
    const contentBase64 = Buffer.alloc(8 * 1024 * 1024 + 1, 7).toString('base64');

    try {
      const response = await callTool(writeToken, 'upload_part', {
        upload_id: session.upload_id,
        upload_token: session.upload_token,
        part_number: 0,
        content_base64: contentBase64,
      }).expect(200);
      expect(decodeMcpResponse(response).result.content[0].text).toContain('MCP_CHUNK_TOO_LARGE');
      expect(uploadPart).not.toHaveBeenCalled();
      expect(await auditRepository.count({ where: { action: 'mcp.tool_called', resourceId: 'upload_part' } })).toBe(beforeAudits);
    } finally {
      uploadPart.mockRestore();
    }
  });

  it.each([
    ['invalid characters', 'Y#=='],
    ['invalid length/padding', 'YQ='],
    ['unpadded form', 'YQ'],
    ['non-canonical padding bits', 'YR=='],
  ])('rejects base64 with %s before UploadsService and audit', async (_caseName, contentBase64) => {
    const repository = app.get(DataSource).getRepository(ApiToken);
    const token = await repository.findOneByOrFail({ id: writeTokenId });
    const uploadsService = app.get(UploadsService);
    const session = await uploadsService.initializeUpload({
      filename: 'malformed-base64.bin', size: 1, chunk_size: 1,
    }, 'admin', token.accountId);
    const uploadPart = jest.spyOn(uploadsService, 'uploadPart');
    const auditRepository = app.get(DataSource).getRepository(AuditLog);
    const beforeAudits = await auditRepository.count({ where: { action: 'mcp.tool_called', resourceId: 'upload_part' } });

    try {
      const response = await callTool(writeToken, 'upload_part', {
        upload_id: session.upload_id,
        upload_token: session.upload_token,
        part_number: 0,
        content_base64: contentBase64,
      }).expect(200);
      expect(decodeMcpResponse(response).result.content[0].text).toContain('INVALID_BASE64');
      expect(uploadPart).not.toHaveBeenCalled();
      expect(await auditRepository.count({ where: { action: 'mcp.tool_called', resourceId: 'upload_part' } })).toBe(beforeAudits);
    } finally {
      uploadPart.mockRestore();
    }
  });

  it('keeps enabled authenticated MCP JSON errors at 400 and 413 after route gating', async () => {
    await request(app.getHttpServer()).put('/api/v1/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ agent: { mcp_enabled: true } }).expect(200);

    await request(app.getHttpServer()).post('/api/v1/mcp')
      .set('Content-Type', 'application/json')
      .send('{"malformed":}')
      .expect(401);

    await request(app.getHttpServer()).post('/api/v1/mcp')
      .set('Authorization', `Bearer ${readOnlyToken}`)
      .set('Content-Type', 'application/json')
      .send('{"malformed":}')
      .expect(400);

    const oversizedJson = `{"body":"${'x'.repeat(16 * 1024 * 1024)}"}`;
    await request(app.getHttpServer()).post('/api/v1/mcp')
      .set('Authorization', `Bearer ${readOnlyToken}`)
      .set('Content-Type', 'application/json')
      .send(oversizedJson)
      .expect(413);
  });

  it('parses MCP requests above 100 KB while other JSON routes keep their default limit', async () => {
    const base64 = Buffer.alloc(8 * 1024 * 1024, 7).toString('base64');
    const mcpResponse = await callTool(writeToken, 'upload_part', {
      upload_id: 'missing-upload', upload_token: 'invalid-upload-token', part_number: 0,
      content_base64: base64,
    }).expect(200);
    const mcpPayload = decodeMcpResponse(mcpResponse);
    expect(mcpPayload.result.isError).toBe(true);
    expect(mcpPayload.result.content[0].text).toContain('Upload session not found');

    await request(app.getHttpServer()).post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'x', extra: 'x'.repeat(120 * 1024) })
      .expect(413);
  });
});
