import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { UPDATE_FETCH, UPDATE_TRUSTED_KEY } from '../src/updates/updates.tokens';
import {
  createApp,
  initAndLogin,
  setupEnv,
  teardownEnv,
  TestEnv,
} from './helpers';

describe('update management API (e2e)', () => {
  let env: TestEnv;
  let app: INestApplication;
  let adminToken: string;
  let apiToken: string;
  let updateFetch: jest.Mock;

  beforeAll(async () => {
    delete process.env.FILESTATION_INSTALL_ROOT;
    delete process.env.FILESTATION_MANAGED_LAUNCH;
    delete process.env.FILESTATION_DEPLOYMENT_MODE;
    delete process.env.FILESTATION_CONTAINER;
    env = await setupEnv();
    updateFetch = jest.fn(() => Promise.reject(new Error('Unexpected update fetch in unconfigured-key fixture')));
    app = await createApp(undefined, (builder) =>
      builder
        .overrideProvider(UPDATE_TRUSTED_KEY).useValue(() => null)
        .overrideProvider(UPDATE_FETCH).useValue(updateFetch),
    );
    adminToken = await initAndLogin(app);

    const created = await request(app.getHttpServer())
      .post('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'updates-e2e', scopes: ['files:read'] })
      .expect(201);
    const exchanged = await request(app.getHttpServer())
      .post('/api/v1/auth/api-token/exchange')
      .set('Authorization', `Bearer ${created.body.data.token}`)
      .expect(200);
    apiToken = exchanged.body.data.access_token;
  });

  afterAll(async () => {
    await app.close();
    await teardownEnv(env);
  });

  it.each([
    ['get', '/api/v1/updates/status'],
    ['post', '/api/v1/updates/check'],
    ['post', '/api/v1/updates/prepare'],
    ['post', '/api/v1/updates/install'],
  ] as const)('requires a bearer administrator for %s %s', async (method, endpoint) => {
    const noBearer = request(app.getHttpServer())[method](endpoint);
    if (method === 'post') noBearer.send({});
    await noBearer.expect(401);

    const cookieOnly = request(app.getHttpServer())[method](endpoint)
      .set('Cookie', 'refresh_token=refresh-only');
    if (method === 'post') cookieOnly.send({});
    await cookieOnly.expect(401);
  });

  it.each([
    ['get', '/api/v1/updates/status'],
    ['post', '/api/v1/updates/check'],
    ['post', '/api/v1/updates/prepare'],
    ['post', '/api/v1/updates/install'],
  ] as const)('rejects API-token principals for %s %s', async (method, endpoint) => {
    const pending = request(app.getHttpServer())[method](endpoint)
      .set('Authorization', `Bearer ${apiToken}`);
    if (method === 'post') pending.send({});
    const response = await pending.expect(403);
    expect(response.body).toEqual(
      expect.objectContaining({ code: 'ENDPOINT_NOT_SCOPED' }),
    );
  });

  it('returns a fail-closed publisher status without making a startup call', async () => {
    const status = await request(app.getHttpServer())
      .get('/api/v1/updates/status')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(status.body).toEqual(
      expect.objectContaining({
        current_version: '0.2.5',
        publisher_status: 'unconfigured',
      }),
    );

    const checked = await request(app.getHttpServer())
      .post('/api/v1/updates/check')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ force: true })
      .expect(200);
    expect(checked.body).toEqual(
      expect.objectContaining({
        stage: 'failed',
        error_code: 'PUBLISHER_UNCONFIGURED',
      }),
    );
    expect(updateFetch).not.toHaveBeenCalled();
  });

  it('rejects URLs, recovery codes, and unknown fields in management bodies', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/updates/prepare')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        version: '0.2.5',
        manifest_sha256: 'a'.repeat(64),
        artifact_sha256: 'b'.repeat(64),
        url: 'https://example.invalid/archive.zip',
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/v1/updates/install')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        prepared_id: '07523e2b-37ee-40cb-980f-cce36310e45f',
        password: 'fixture-password',
        recovery_code: 'fixture-recovery-code',
      })
      .expect(400);
  });

  it('rechecks the password before consuming a prepared receipt', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/updates/install')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        prepared_id: '07523e2b-37ee-40cb-980f-cce36310e45f',
        password: 'wrong-password',
      })
      .expect(401);
    expect(JSON.stringify(response.body)).not.toContain('wrong-password');
  });
});
