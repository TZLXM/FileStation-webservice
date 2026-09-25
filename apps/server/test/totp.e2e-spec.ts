import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { authenticator } from 'otplib';
import request from 'supertest';
import { Authenticator } from '../src/auth/entities/authenticator.entity';
import { TotpService } from '../src/auth/totp.service';
import { Setting } from '../src/settings/entities/setting.entity';
import { setupEnv, teardownEnv, createApp, initAndLogin, TestEnv } from './helpers';

function hasRefreshCookie(header: unknown): boolean {
  const values = Array.isArray(header) ? header : typeof header === 'string' ? [header] : [];
  return values.some((cookie) => typeof cookie === 'string' && cookie.startsWith('refresh_token='));
}

function refreshCookieToken(header: unknown): string {
  const values = Array.isArray(header) ? header : typeof header === 'string' ? [header] : [];
  const cookie = values.find((value) => typeof value === 'string' && value.startsWith('refresh_token='));
  return typeof cookie === 'string' ? cookie.slice('refresh_token='.length).split(';')[0] : '';
}

function codeForNextTotpStep(secret: string): string {
  const stepMillis = 30_000;
  const nextCounter = Math.floor(Date.now() / stepMillis) + 1;
  return authenticator.create({
    ...authenticator.options,
    window: 1,
    epoch: nextCounter * stepMillis + 100,
  }).generate(secret);
}

describe('TOTP authentication (e2e)', () => {
  let env: TestEnv;
  let app: INestApplication;
  let adminJwt: string;
  let totpSecret = '';
  let failedChallenge = '';
  let successfulChallenge = '';
  let successfulCode = '';
  let qrCodeDataUrl = '';
  let concurrentWrongCode = '';
  let concurrentChallenges: string[] = [];
  let successfulAccessToken = '';
  let successfulRefreshToken = '';

  beforeAll(async () => {
    env = await setupEnv();
    app = await createApp();
    adminJwt = await initAndLogin(app);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await teardownEnv(env);
  });

  it('rejects malformed TOTP input through DTO validation', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login/totp')
      .send({ login_challenge: 'ch_00000000-0000-4000-8000-000000000000', totp_code: '123' })
      .expect(400);
  });

  it('rejects API-token principals from administrator TOTP endpoints', async () => {
    const token = await request(app.getHttpServer())
      .post('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ name: 'totp-guard', scopes: ['files:read'] })
      .expect(201);
    const apiJwt = await request(app.getHttpServer())
      .post('/api/v1/auth/api-token/exchange')
      .set('Authorization', `Bearer ${token.body.data.token}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/totp/setup')
      .set('Authorization', `Bearer ${apiJwt.body.data.access_token}`)
      .expect(403);
  });

  it('prevents requiring TOTP when there is no active authenticator', async () => {
    const result = await request(app.getHttpServer())
      .put('/api/v1/settings')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ security: { totp_required: true } })
      .expect(400);

    expect(result.body.code ?? result.body.error?.code).toBe('TOTP_NOT_ENABLED');
  });

  it('serializes concurrent setup so one response owns the only pending authenticator', async () => {
    const responses = await Promise.all(Array.from({ length: 2 }, () =>
      request(app.getHttpServer())
        .post('/api/v1/auth/totp/setup')
        .set('Authorization', `Bearer ${adminJwt}`),
    ));
    const created = responses.filter((response) => response.status === 201);
    const conflicts = responses.filter((response) => response.status === 409);
    expect(created.length).toBe(1);
    expect(conflicts.length).toBe(1);

    const response = created[0];
    totpSecret = response.body.data.secret;
    qrCodeDataUrl = response.body.data.qr_code_data_url;
    const repository = app.get(DataSource).getRepository(Authenticator);
    const savedRows = await repository.find({ where: { type: 'totp' } });
    const [saved] = savedRows;

    expect(savedRows).toHaveLength(1);
    expect(typeof totpSecret).toBe('string');
    expect(totpSecret.length > 0).toBe(true);
    expect(response.body.data.otpauth_url.startsWith('otpauth://totp/')).toBe(true);
    expect(qrCodeDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(saved?.isActive).toBe(0);
    expect(saved?.totpSecretEncrypted?.startsWith('v1.')).toBe(true);
    expect(saved?.totpSecretEncrypted?.includes(totpSecret)).toBe(false);
  });

  it('activates TOTP with a valid code and keeps the derived state out of settings storage', async () => {
    const code = authenticator.create({ ...authenticator.options, window: 1 }).generate(totpSecret);
    await request(app.getHttpServer())
      .post('/api/v1/auth/totp/confirm')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ code })
      .expect(201);

    const settingRepository = app.get(DataSource).getRepository(Setting);
    const settings = await request(app.getHttpServer())
      .get('/api/v1/settings')
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);

    expect(settings.body.data.security.totp_active).toBe(true);
    const storedSecurity = await settingRepository.findOneBy({ key: 'security' } as any);
    expect((storedSecurity?.value ?? '').includes('totp_active')).toBe(false);
  });

  it('returns only a challenge after password login and consumes it after an incorrect code', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'StrongP@ssw0rd' })
      .expect(200);
    failedChallenge = login.body.data.login_challenge;

    expect(login.body.data.requires_second_factor).toBe(true);
    expect(login.body.data.available_methods).toEqual(['totp']);
    expect('access_token' in login.body.data).toBe(false);
    expect(hasRefreshCookie(login.headers['set-cookie'])).toBe(false);

    const validCode = authenticator.create({ ...authenticator.options, window: 1 }).generate(totpSecret);
    const wrongCode = validCode === '000000' ? '000001' : '000000';
    const failed = await request(app.getHttpServer())
      .post('/api/v1/auth/login/totp')
      .send({ login_challenge: failedChallenge, totp_code: wrongCode });
    expect(failed.status).toBe(401);
    expect(JSON.stringify(failed.body).includes(wrongCode)).toBe(false);

    const replay = await request(app.getHttpServer())
      .post('/api/v1/auth/login/totp')
      .send({ login_challenge: failedChallenge, totp_code: validCode });
    expect(replay.status).toBe(401);
    expect('access_token' in (replay.body.data ?? {})).toBe(false);
  });

  it('issues access and refresh credentials only after valid TOTP and rejects challenge replay', async () => {
    const logins = await Promise.all(Array.from({ length: 4 }, () =>
      request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username: 'admin', password: 'StrongP@ssw0rd' })
        .expect(200),
    ));
    const challenges = logins.map((login) => login.body.data.login_challenge);
    successfulCode = codeForNextTotpStep(totpSecret);

    const verificationResults = await Promise.all(challenges.map((loginChallenge) =>
      request(app.getHttpServer())
        .post('/api/v1/auth/login/totp')
        .send({ login_challenge: loginChallenge, totp_code: successfulCode }),
    ));
    const successfulIndex = verificationResults.findIndex((result) => result.status === 200);
    expect(successfulIndex).toBeGreaterThanOrEqual(0);
    expect(verificationResults.filter((result) => result.status === 200)).toHaveLength(1);
    expect(verificationResults.filter((result) => result.status === 401)).toHaveLength(3);
    successfulChallenge = challenges[successfulIndex];
    const verified = verificationResults[successfulIndex];
    successfulAccessToken = verified.body.data.access_token;
    successfulRefreshToken = refreshCookieToken(verified.headers['set-cookie']);

    expect(typeof verified.body.data.access_token).toBe('string');
    expect(verified.body.data.expires_in).toBe(86400);
    expect(verified.body.data.username).toBe('admin');
    expect(hasRefreshCookie(verified.headers['set-cookie'])).toBe(true);
    await request(app.getHttpServer())
      .get('/api/v1/settings')
      .set('Authorization', `Bearer ${verified.body.data.access_token}`)
      .expect(200);

    const replay = await request(app.getHttpServer())
      .post('/api/v1/auth/login/totp')
      .send({ login_challenge: successfulChallenge, totp_code: successfulCode });
    expect(replay.status).toBe(401);
    expect('access_token' in (replay.body.data ?? {})).toBe(false);

    const secondLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'StrongP@ssw0rd' })
      .expect(200);
    const crossChallengeReplay = await request(app.getHttpServer())
      .post('/api/v1/auth/login/totp')
      .send({ login_challenge: secondLogin.body.data.login_challenge, totp_code: successfulCode });
    expect(crossChallengeReplay.status).toBe(401);
    expect(crossChallengeReplay.body.code ?? crossChallengeReplay.body.error?.code).toBe('INVALID_TOTP');
    expect('access_token' in (crossChallengeReplay.body.data ?? {})).toBe(false);

    const authenticatorRepository = app.get(DataSource).getRepository(Authenticator);
    const active = await authenticatorRepository.findOne({ where: { type: 'totp', isActive: 1 } });
    if (active) await authenticatorRepository.update({ id: active.id }, { lastUsedAt: null });
    await app.get(DataSource).query("DELETE FROM system_meta WHERE key = 'login_lockout_admin'");
    await app.get(DataSource).query("DELETE FROM system_meta WHERE key LIKE 'login_ip_%'");
  });

  it('counts concurrent failures from distinct challenges without losing account-lockout increments', async () => {
    const passwordLogins = await Promise.all(Array.from({ length: 6 }, () =>
      request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username: 'admin', password: 'StrongP@ssw0rd' })
        .expect(200),
    ));
    concurrentChallenges = passwordLogins.map((login) => login.body.data.login_challenge);
    expect(concurrentChallenges.every((challenge) => typeof challenge === 'string')).toBe(true);

    const verifier = authenticator.create({ ...authenticator.options, window: 1 });
    concurrentWrongCode = Array.from({ length: 20 }, (_, index) => String(index).padStart(6, '0'))
      .find((candidate) => !verifier.check(candidate, totpSecret)) ?? '';
    expect(concurrentWrongCode.length).toBe(6);

    const matchingSpy = jest.spyOn(app.get(TotpService), 'matchLoginCodeInTransaction');
    const results = await Promise.all(concurrentChallenges.map((loginChallenge) =>
      request(app.getHttpServer())
        .post('/api/v1/auth/login/totp')
        .send({ login_challenge: loginChallenge, totp_code: concurrentWrongCode }),
    ));
    const matchingCalls = matchingSpy.mock.calls.length;
    matchingSpy.mockRestore();
    expect(results.map((result) => result.status)).toEqual(Array(6).fill(401));
    expect(results.every((result) => result.status === 401)).toBe(true);
    const responseCodes = results.map((result) => result.body.code ?? result.body.error?.code);
    expect(responseCodes.filter((code) => code === 'INVALID_TOTP')).toHaveLength(5);
    expect(responseCodes.filter((code) => code === 'ACCOUNT_LOCKED')).toHaveLength(1);
    expect(matchingCalls).toBe(5);

    const blocked = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'StrongP@ssw0rd' });
    expect(blocked.status).toBe(401);
    expect(blocked.body.code ?? blocked.body.error?.code).toBe('ACCOUNT_LOCKED');
  });

  it('atomically consumes a TOTP time step only once across concurrent verifications', async () => {
    const authenticatorRepository = app.get(DataSource).getRepository(Authenticator);
    const active = await authenticatorRepository.findOne({ where: { type: 'totp', isActive: 1 } });
    expect(active).toBeTruthy();
    if (!active) return;
    await authenticatorRepository.update({ id: active.id }, { lastUsedAt: null });
    const code = authenticator.create({ ...authenticator.options, window: 1 }).generate(totpSecret);

    const results = await Promise.all(Array.from({ length: 8 }, () =>
      app.get(TotpService).verifyCode(active.accountId, code),
    ));

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((accepted) => !accepted)).toHaveLength(7);
  });

  it('does not include TOTP material, challenges, or credentials in audit entries', async () => {
    const result = await request(app.getHttpServer())
      .get('/api/v1/audit-logs')
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);
    const audit = JSON.stringify(result.body.data.items);

    for (const value of [
      totpSecret,
      qrCodeDataUrl,
      failedChallenge,
      successfulChallenge,
      successfulCode,
      concurrentWrongCode,
      ...concurrentChallenges,
      successfulAccessToken,
      successfulRefreshToken,
      'StrongP@ssw0rd',
    ]) {
      if (typeof value === 'string' && value.length > 0) expect(audit.includes(value)).toBe(false);
    }
  });

  it('does not allow disabling the last authenticator while TOTP is required', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/settings')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ security: { totp_required: true } })
      .expect(200);

    const authenticatorRepository = app.get(DataSource).getRepository(Authenticator);
    const active = await authenticatorRepository.findOne({ where: { type: 'totp', isActive: 1 } });
    if (active) await authenticatorRepository.update({ id: active.id }, { lastUsedAt: null });
    const code = authenticator.create({ ...authenticator.options, window: 1 }).generate(totpSecret);
    const result = await request(app.getHttpServer())
      .post('/api/v1/auth/totp/disable')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ password: 'StrongP@ssw0rd', code });

    expect(result.status).toBe(409);
    expect(result.body.code ?? result.body.error?.code).toBe('TOTP_REQUIRED');
    const saved = await app.get(DataSource).getRepository(Authenticator).findOne({ where: { type: 'totp' } });
    expect(saved?.isActive).toBe(1);
  });

  it('serializes concurrent TOTP-requirement enablement and authenticator removal', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/settings')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ security: { totp_required: false } })
      .expect(200);

    const authenticatorRepository = app.get(DataSource).getRepository(Authenticator);
    const active = await authenticatorRepository.findOne({ where: { type: 'totp', isActive: 1 } });
    if (active) await authenticatorRepository.update({ id: active.id }, { lastUsedAt: null });
    const code = authenticator.create({ ...authenticator.options, window: 1 }).generate(totpSecret);
    const [requirementResult, disableResult] = await Promise.all([
      request(app.getHttpServer())
        .put('/api/v1/settings')
        .set('Authorization', `Bearer ${adminJwt}`)
        .send({ security: { totp_required: true } }),
      request(app.getHttpServer())
        .post('/api/v1/auth/totp/disable')
        .set('Authorization', `Bearer ${adminJwt}`)
        .send({ password: 'StrongP@ssw0rd', code }),
    ]);

    const allowedOrderings = [
      [200, 409], // requirement wins; deletion sees the policy and refuses
      [400, 201], // deletion wins; the requirement setter sees no active TOTP
    ];
    expect(allowedOrderings).toContainEqual([requirementResult.status, disableResult.status]);

    const currentSettings = await request(app.getHttpServer())
      .get('/api/v1/settings')
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);
    const remaining = await authenticatorRepository.findOne({ where: { type: 'totp', isActive: 1 } });
    expect(currentSettings.body.data.security.totp_required && !remaining).toBe(false);
  });
});
