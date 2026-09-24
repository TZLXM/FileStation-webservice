import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { setupEnv, teardownEnv, createApp, initAndLogin, TestEnv } from './helpers';

describe('API Token exchange (e2e)', () => {
  let env: TestEnv;
  let app: INestApplication;
  let adminJwt: string;
  let plaintext: string;
  let tokenId: string;
  let apiJwt: string;

  beforeAll(async () => {
    env = await setupEnv();
    app = await createApp();
    adminJwt = await initAndLogin(app);
    const server = app.getHttpServer();
    // 签发只有 files:read 的 token
    const createRes = await request(server).post('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ name: 'e2e-agent', scopes: ['files:read'] }).expect(201);
    plaintext = createRes.body.data.token;
    tokenId = createRes.body.data.id;
    // 换 JWT
    const exchRes = await request(server).post('/api/v1/auth/api-token/exchange')
      .set('Authorization', `Bearer ${plaintext}`).expect(200);
    apiJwt = exchRes.body.data.access_token;
    expect(exchRes.body.data.expires_in).toBe(3600);
  }, 60_000);

  afterAll(async () => { await app.close(); await teardownEnv(env); });

  it('列表接口不明文返回 token', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${adminJwt}`).expect(200);
    expect(res.body.data[0].token).toBeUndefined();
    expect(res.body.data[0].token_prefix).toBe(plaintext.substring(0, 12));
    expect(res.body.data[0].last_used_at).toBeTruthy();
  });

  it('api_token JWT 可访问授权 scope 的端点（GET /files）', async () => {
    await request(app.getHttpServer()).get('/api/v1/files')
      .set('Authorization', `Bearer ${apiJwt}`).expect(200);
  });

  it('审计日志分页接口仅管理员可访问且不返回明文 token', async () => {
    const result = await request(app.getHttpServer()).get('/api/v1/audit-logs?page=1&page_size=100&action=api_token.created')
      .set('Authorization', `Bearer ${adminJwt}`).expect(200);
    expect(result.body.data).toMatchObject({ page: 1, page_size: 100, total_pages: 1 });
    expect(result.body.data.items).toHaveLength(1);
    expect(result.body.data.items[0]).toMatchObject({
      action: 'api_token.created',
      resource_type: 'api_token',
      resource_id: tokenId,
      details: { name: 'e2e-agent', scopes: ['files:read'] },
    });
    expect(JSON.stringify(result.body.data)).not.toContain(plaintext);

    await request(app.getHttpServer()).get('/api/v1/audit-logs')
      .set('Authorization', `Bearer ${apiJwt}`).expect(403);
  });

  it('scope 不足被拒（POST /uploads 需要 files:write）→ 403', async () => {
    await request(app.getHttpServer()).post('/api/v1/uploads')
      .set('Authorization', `Bearer ${apiJwt}`)
      .send({ filename: 'x.txt', size: 1 }).expect(403);
  });

  it('api_token 永不可访问 settings（默认拒绝 + AdminOnlyGuard 双保险）→ 403', async () => {
    await request(app.getHttpServer()).get('/api/v1/settings')
      .set('Authorization', `Bearer ${apiJwt}`).expect(403);
  });

  it('伪造 JWT 放大 scopes 无效：scopes 以 DB 为准', async () => {
    const forged = app.get(JwtService).sign({
      sub: 'forged', username: 'admin', principal_type: 'api_token',
      scopes: ['files:write'], // 伪造放大
      token_id: tokenId,       // 但指向 DB 中只有 files:read 的 token
    });
    await request(app.getHttpServer()).post('/api/v1/uploads')
      .set('Authorization', `Bearer ${forged}`)
      .send({ filename: 'x.txt', size: 1 }).expect(403);
  });

  it('吊销后既有 JWT 立即失效 → 401', async () => {
    await request(app.getHttpServer()).delete(`/api/v1/api-tokens/${tokenId}`)
      .set('Authorization', `Bearer ${adminJwt}`).expect(200);
    await request(app.getHttpServer()).get('/api/v1/files')
      .set('Authorization', `Bearer ${apiJwt}`).expect(401);

    const auditResult = await request(app.getHttpServer()).get('/api/v1/audit-logs?action=api_token.revoked')
      .set('Authorization', `Bearer ${adminJwt}`).expect(200);
    expect(auditResult.body.data.items).toHaveLength(1);
    expect(auditResult.body.data.items[0]).toMatchObject({ action: 'api_token.revoked', resource_id: tokenId });
  });

  it('吊销后的明文、格式错误的明文 exchange → 401', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/api-token/exchange')
      .set('Authorization', `Bearer ${plaintext}`).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/api-token/exchange')
      .set('Authorization', 'Bearer fs_api_deadbeef').expect(401);
  });

  it('有效明文缺少 Bearer scheme 时拒绝 exchange → 401', async () => {
    const createRes = await request(app.getHttpServer()).post('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ name: 'raw-header-agent', scopes: ['files:read'] }).expect(201);
    const validPlaintext = createRes.body.data.token;

    await request(app.getHttpServer()).post('/api/v1/auth/api-token/exchange')
      .set('Authorization', validPlaintext).expect(401);
  });
});
