import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { authenticator } from 'otplib';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { createHash, randomBytes } from 'crypto';
import { AccountsService } from '../src/accounts/accounts.service';
import { AuthService } from '../src/auth/auth.service';
import { SqliteImmediateTransactionService } from '../src/common/database/sqlite-immediate-transaction.service';
import { setupEnv, teardownEnv, createApp, TestEnv } from './helpers';

const PASSWORD = 'StrongP@ssw0rd';

interface AuthenticatedContext {
  env: TestEnv;
  app: INestApplication;
  accountId: string;
  accessToken: string;
  refreshToken: string;
}

function responseCode(response: request.Response): string | undefined {
  return response.body.code ?? response.body.error?.code;
}

function refreshCookieToken(header: unknown): string | undefined {
  const values = Array.isArray(header) ? header : typeof header === 'string' ? [header] : [];
  const cookie = values.find((value) => typeof value === 'string' && value.startsWith('refresh_token='));
  return typeof cookie === 'string'
    ? cookie.slice('refresh_token='.length).split(';', 1)[0]
    : undefined;
}

function jwtPayload(token: string): Record<string, unknown> {
  const encoded = token.split('.')[1];
  if (!encoded) throw new Error('JWT payload is missing');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function nextTotpCode(secret: string): string {
  const stepMillis = 30_000;
  const nextCounter = Math.floor(Date.now() / stepMillis) + 1;
  return authenticator.create({
    ...authenticator.options,
    window: 1,
    epoch: nextCounter * stepMillis + 100,
  }).generate(secret);
}

async function createAuthenticatedContext(): Promise<AuthenticatedContext> {
  const env = await setupEnv();
  const app = await createApp();
  const initToken = await app.get(AuthService).generateInitToken();
  await request(app.getHttpServer())
    .post('/api/v1/auth/init')
    .set('X-Init-Token', initToken)
    .send({ username: 'admin', password: PASSWORD })
    .expect(201);

  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ username: 'admin', password: PASSWORD })
    .expect(200);
  const refreshToken = refreshCookieToken(login.headers['set-cookie']);
  if (!refreshToken) throw new Error('Login did not set a refresh cookie');
  const [account] = await app.get(DataSource).query(
    "SELECT id FROM admin_accounts WHERE username = 'admin'",
  );

  return {
    env,
    app,
    accountId: account.id as string,
    accessToken: login.body.data.access_token as string,
    refreshToken,
  };
}

describe('administrator session-bound access tokens (e2e)', () => {
  jest.setTimeout(120_000);

  let context: AuthenticatedContext | undefined;

  beforeEach(async () => {
    context = await createAuthenticatedContext();
  });

  afterEach(async () => {
    if (context) {
      await context.app.close();
      await teardownEnv(context.env);
      context = undefined;
    }
  });

  it('rejects a pre-recovery access token immediately, including API-token creation', async () => {
    const { app, accessToken, refreshToken } = context!;
    const generated = await request(app.getHttpServer())
      .post('/api/v1/auth/recovery/generate')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ password: PASSWORD })
      .expect(201);
    const recoveryCode = generated.body.data.codes[0] as string;

    const recovered = await request(app.getHttpServer())
      .post('/api/v1/auth/recovery/verify')
      .send({ username: 'admin', code: recoveryCode })
      .expect(200);
    const recoveredAccess = recovered.body.data.access_token as string;

    const oldList = await request(app.getHttpServer())
      .get('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(oldList.status).toBe(401);
    expect(responseCode(oldList)).toBe('SESSION_REVOKED');

    const dataSource = app.get(DataSource);
    const [{ count: beforeCount }] = await dataSource.query(
      'SELECT COUNT(*) AS count FROM api_tokens',
    );
    const oldCreate = await request(app.getHttpServer())
      .post('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'must-not-exist', scopes: ['files:read'] });
    expect(oldCreate.status).toBe(401);
    expect(responseCode(oldCreate)).toBe('SESSION_REVOKED');
    const [{ count: afterCount }] = await dataSource.query(
      'SELECT COUNT(*) AS count FROM api_tokens',
    );
    expect(afterCount).toBe(beforeCount);

    await request(app.getHttpServer())
      .get('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${recoveredAccess}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${refreshToken}`)
      .expect(401);
  });

  it('keeps the session id stable across refresh rotation and keeps prior access usable', async () => {
    const { app, accessToken, refreshToken } = context!;
    const originalPayload = jwtPayload(accessToken);
    expect(originalPayload.sid).toEqual(expect.any(String));

    const refreshed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${refreshToken}`)
      .expect(200);
    const refreshedAccess = refreshed.body.data.access_token as string;
    const rotatedRefresh = refreshCookieToken(refreshed.headers['set-cookie']);
    expect(rotatedRefresh).toEqual(expect.any(String));
    expect(rotatedRefresh).not.toBe(refreshToken);
    expect(jwtPayload(refreshedAccess).sid).toBe(originalPayload.sid);

    await request(app.getHttpServer())
      .get('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${refreshedAccess}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${refreshToken}`)
      .expect(401);

    const sessions = await app.get(DataSource).query(
      'SELECT id, revoked_at FROM sessions WHERE id = ?',
      [originalPayload.sid],
    );
    expect(sessions).toEqual([{ id: originalPayload.sid, revoked_at: null }]);
  });

  it('rejects family, rotation, and cross-session tampering without consuming the valid token', async () => {
    const { app, accessToken, refreshToken } = context!;
    const parts = refreshToken.split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('fs_rt_1');

    const tamperedFamily = [
      parts[0],
      parts[1],
      randomBytes(32).toString('base64url'),
      parts[3],
    ].join('.');
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${tamperedFamily}`)
      .expect(401);

    const forgedRotation = [
      parts[0],
      parts[1],
      parts[2],
      randomBytes(32).toString('base64url'),
    ].join('.');
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${forgedRotation}`)
      .expect(401);

    const secondLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: PASSWORD })
      .expect(200);
    const secondSid = jwtPayload(secondLogin.body.data.access_token as string).sid;
    expect(secondSid).toEqual(expect.any(String));
    expect(secondSid).not.toBe(jwtPayload(accessToken).sid);
    const crossSession = [
      parts[0],
      secondSid,
      parts[2],
      parts[3],
    ].join('.');
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${crossSession}`)
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${refreshToken}`)
      .expect(200);
  });

  it('revokes the bound access token immediately on logout', async () => {
    const { app, accessToken, refreshToken } = context!;

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', `refresh_token=${refreshToken}`)
      .expect(200);

    const denied = await request(app.getHttpServer())
      .get('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(denied.status).toBe(401);
    expect(responseCode(denied)).toBe('SESSION_REVOKED');
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${refreshToken}`)
      .expect(401);
  });

  it('binds a TOTP-completed login to its new session and revokes it on logout', async () => {
    const { app, accessToken } = context!;
    const setup = await request(app.getHttpServer())
      .post('/api/v1/auth/totp/setup')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(201);
    const secret = setup.body.data.secret as string;
    await request(app.getHttpServer())
      .post('/api/v1/auth/totp/confirm')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        code: authenticator.create({ ...authenticator.options, window: 1 }).generate(secret),
      })
      .expect(201);

    const challenged = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: PASSWORD })
      .expect(200);
    expect(challenged.body.data.requires_second_factor).toBe(true);

    const completed = await request(app.getHttpServer())
      .post('/api/v1/auth/login/totp')
      .send({
        login_challenge: challenged.body.data.login_challenge,
        totp_code: nextTotpCode(secret),
      })
      .expect(200);
    const totpAccess = completed.body.data.access_token as string;
    const totpRefresh = refreshCookieToken(completed.headers['set-cookie']);
    const payload = jwtPayload(totpAccess);
    expect(payload.sid).toEqual(expect.any(String));
    const sessions = await app.get(DataSource).query(
      'SELECT account_id, revoked_at FROM sessions WHERE id = ?',
      [payload.sid],
    );
    expect(sessions).toEqual([{ account_id: context!.accountId, revoked_at: null }]);

    await request(app.getHttpServer())
      .get('/api/v1/settings')
      .set('Authorization', `Bearer ${totpAccess}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', `refresh_token=${totpRefresh}`)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/settings')
      .set('Authorization', `Bearer ${totpAccess}`)
      .expect(401);
  });

  it('rejects a legacy admin token without sid and recovers it through refresh', async () => {
    const { app, accountId, refreshToken } = context!;
    const legacyAccess = app.get(JwtService).sign({
      sub: accountId,
      username: 'admin',
      principal_type: 'admin',
    });

    const legacyDenied = await request(app.getHttpServer())
      .get('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${legacyAccess}`);
    expect(legacyDenied.status).toBe(401);
    expect(responseCode(legacyDenied)).toBe('REAUTH_REQUIRED');

    const refreshed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${refreshToken}`)
      .expect(200);
    const refreshedAccess = refreshed.body.data.access_token as string;
    expect(jwtPayload(refreshedAccess).sid).toEqual(expect.any(String));
    await request(app.getHttpServer())
      .get('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${refreshedAccess}`)
      .expect(200);
  });

  it('rejects a session id that belongs to a different account', async () => {
    const { app, accountId } = context!;
    const otherAccount = await app.get(AccountsService).createAccount(
      'other-admin',
      'OtherStrongP@ssw0rd',
    );
    const otherSessionId = uuidv4();
    const now = Date.now();
    await app.get(DataSource).query(
      `INSERT INTO sessions
        (id, account_id, refresh_token_hash, device_info, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, NULL, ?, ?, NULL)`,
      [otherSessionId, otherAccount.id, 'f'.repeat(64), now, now + 60_000],
    );
    const mismatchedAccess = app.get(JwtService).sign({
      sub: accountId,
      username: 'admin',
      principal_type: 'admin',
      sid: otherSessionId,
    });

    const denied = await request(app.getHttpServer())
      .get('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${mismatchedAccess}`);
    expect(denied.status).toBe(401);
    expect(responseCode(denied)).toBe('SESSION_INVALID');
  });

  it('allows only one concurrent refresh and preserves one stable session', async () => {
    const { app, accessToken, refreshToken } = context!;
    const originalSid = jwtPayload(accessToken).sid;
    expect(originalSid).toEqual(expect.any(String));

    const results = await Promise.all(Array.from({ length: 2 }, () =>
      request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', `refresh_token=${refreshToken}`),
    ));
    expect(results.map(({ status }) => status).sort()).toEqual([200, 401]);
    const winner = results.find(({ status }) => status === 200)!;
    const winningAccess = winner.body.data.access_token as string;
    expect(jwtPayload(winningAccess).sid).toBe(originalSid);
    await request(app.getHttpServer())
      .get('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(await app.get(DataSource).query(
      'SELECT id FROM sessions WHERE id = ?',
      [originalSid],
    )).toHaveLength(1);
  });

  it('revokes the stable session when refresh and logout race', async () => {
    const { app, accessToken, refreshToken } = context!;
    const sid = jwtPayload(accessToken).sid;
    expect(sid).toEqual(expect.any(String));

    const [refreshResult, logoutResult] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', `refresh_token=${refreshToken}`),
      request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Cookie', `refresh_token=${refreshToken}`),
    ]);
    expect([200, 401]).toContain(refreshResult.status);
    expect(logoutResult.status).toBe(200);

    await request(app.getHttpServer())
      .get('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401);
    if (refreshResult.status === 200) {
      await request(app.getHttpServer())
        .get('/api/v1/api-tokens')
        .set('Authorization', `Bearer ${refreshResult.body.data.access_token}`)
        .expect(401);
    }
    const targetSession = await app.get(DataSource).query(
      'SELECT revoked_at FROM sessions WHERE id = ?',
      [sid],
    );
    expect(targetSession).toEqual([{ revoked_at: expect.any(Number) }]);
  });

  it('revokes the current session after multiple rotations using the original cookie', async () => {
    const { app, accessToken, refreshToken } = context!;
    const sid = jwtPayload(accessToken).sid;
    expect(sid).toEqual(expect.any(String));

    const first = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${refreshToken}`)
      .expect(200);
    const firstRefresh = refreshCookieToken(first.headers['set-cookie']);
    expect(firstRefresh).toEqual(expect.any(String));
    const second = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${firstRefresh}`)
      .expect(200);
    const secondRefresh = refreshCookieToken(second.headers['set-cookie']);
    const secondAccess = second.body.data.access_token as string;
    expect(secondRefresh).toEqual(expect.any(String));

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${refreshToken}`)
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${firstRefresh}`)
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', `refresh_token=${refreshToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${secondAccess}`)
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${secondRefresh}`)
      .expect(401);
    expect(await app.get(DataSource).query(
      'SELECT revoked_at FROM sessions WHERE id = ?',
      [sid],
    )).toEqual([{ revoked_at: expect.any(Number) }]);
  });

  it('revokes a rotation committed after multiple turns when the original cookie logs out', async () => {
    const { app, accessToken, refreshToken } = context!;
    const sid = jwtPayload(accessToken).sid;
    expect(sid).toEqual(expect.any(String));
    const first = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${refreshToken}`)
      .expect(200);
    const firstRefresh = refreshCookieToken(first.headers['set-cookie']);
    const second = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${firstRefresh}`)
      .expect(200);
    const secondRefresh = refreshCookieToken(second.headers['set-cookie']);
    expect(secondRefresh).toEqual(expect.any(String));

    const authService = app.get(AuthService);
    const originalRefresh = authService.refreshToken.bind(authService);
    let markRotated!: () => void;
    let releaseRefresh!: () => void;
    const rotated = new Promise<void>((resolve) => { markRotated = resolve; });
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const refreshSpy = jest.spyOn(authService, 'refreshToken').mockImplementation(async (token) => {
      const result = await originalRefresh(token);
      markRotated();
      await refreshGate;
      return result;
    });
    const pendingRefresh = request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${secondRefresh}`)
      .then((response) => response);
    try {
      await rotated;
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Cookie', `refresh_token=${refreshToken}`)
        .expect(200);
      releaseRefresh();

      const third = await pendingRefresh;
      expect(third.status).toBe(200);
      await request(app.getHttpServer())
        .get('/api/v1/api-tokens')
        .set('Authorization', `Bearer ${third.body.data.access_token}`)
        .expect(401);
      const thirdRefresh = refreshCookieToken(third.headers['set-cookie']);
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', `refresh_token=${thirdRefresh}`)
        .expect(401);
      expect(await app.get(DataSource).query(
        'SELECT revoked_at FROM sessions WHERE id = ?',
        [sid],
      )).toEqual([{ revoked_at: expect.any(Number) }]);
    } finally {
      releaseRefresh();
      refreshSpy.mockRestore();
      await pendingRefresh;
    }
  });

  it('preserves a pre-family legacy cookie across arbitrary rotations without allowing reuse', async () => {
    const { app, accountId, accessToken } = context!;
    const sid = jwtPayload(accessToken).sid;
    expect(sid).toEqual(expect.any(String));
    const legacyRefresh = uuidv4();
    const now = Date.now();
    const dataSource = app.get(DataSource);
    await dataSource.query('DELETE FROM sessions WHERE id = ?', [sid]);
    await dataSource.query(
      `INSERT INTO sessions
        (id, account_id, refresh_token_hash, device_info, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, NULL, ?, ?, NULL)`,
      [
        sid,
        accountId,
        createHash('sha256').update(legacyRefresh).digest('hex'),
        now,
        now + 7 * 24 * 60 * 60 * 1000,
      ],
    );

    const first = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${legacyRefresh}`)
      .expect(200);
    const firstRefresh = refreshCookieToken(first.headers['set-cookie']);
    const second = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${firstRefresh}`)
      .expect(200);
    const secondRefresh = refreshCookieToken(second.headers['set-cookie']);
    expect(secondRefresh).toEqual(expect.any(String));

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${legacyRefresh}`)
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', `refresh_token=${legacyRefresh}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${secondRefresh}`)
      .expect(401);
  });

  it.each([
    ['cookie-only', false],
    ['legacy no-sid access', true],
  ])(
    'revokes a refresh committed before the response reaches a %s client',
    async (_label, useLegacyAccess) => {
      const { app, accessToken, refreshToken, accountId } = context!;
      const sid = jwtPayload(accessToken).sid;
      expect(sid).toEqual(expect.any(String));

      const authService = app.get(AuthService);
      const originalRefresh = authService.refreshToken.bind(authService);
      let markRotated!: () => void;
      let releaseRefresh!: () => void;
      const rotated = new Promise<void>((resolve) => { markRotated = resolve; });
      const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
      const refreshSpy = jest.spyOn(authService, 'refreshToken').mockImplementation(async (token) => {
        const result = await originalRefresh(token);
        markRotated();
        await refreshGate;
        return result;
      });

      const pendingRefresh = request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', `refresh_token=${refreshToken}`)
        .then((response) => response);
      try {
        await rotated;
        const logout = request(app.getHttpServer())
          .post('/api/v1/auth/logout')
          .set('Cookie', `refresh_token=${refreshToken}`);
        if (useLegacyAccess) {
          const legacyAccess = app.get(JwtService).sign({
            sub: accountId,
            username: 'admin',
            principal_type: 'admin',
          });
          logout.set('Authorization', `Bearer ${legacyAccess}`);
        }
        await logout.expect(200);

        releaseRefresh();
        const refreshed = await pendingRefresh;
        expect(refreshed.status).toBe(200);
        await request(app.getHttpServer())
          .get('/api/v1/api-tokens')
          .set('Authorization', `Bearer ${refreshed.body.data.access_token}`)
          .expect(401);
        const rotatedRefresh = refreshCookieToken(refreshed.headers['set-cookie']);
        expect(rotatedRefresh).toEqual(expect.any(String));
        await request(app.getHttpServer())
          .post('/api/v1/auth/refresh')
          .set('Cookie', `refresh_token=${rotatedRefresh}`)
          .expect(401);
        expect(await app.get(DataSource).query(
          'SELECT revoked_at FROM sessions WHERE id = ?',
          [sid],
        )).toEqual([{ revoked_at: expect.any(Number) }]);
      } finally {
        releaseRefresh();
        refreshSpy.mockRestore();
        await pendingRefresh;
      }
    },
  );

  it('rejects refresh when the session expires while waiting for the write lock', async () => {
    const { app, accessToken, refreshToken } = context!;
    const sid = jwtPayload(accessToken).sid;
    expect(sid).toEqual(expect.any(String));
    const startedAt = Date.now();
    const expiresAt = startedAt + 1_000;
    await app.get(DataSource).query(
      'UPDATE sessions SET expires_at = ? WHERE id = ?',
      [expiresAt, sid],
    );

    const transactions = app.get(SqliteImmediateTransactionService);
    const originalRun = transactions.run.bind(transactions);
    let lockAcquired!: () => void;
    let releaseLock!: () => void;
    const acquired = new Promise<void>((resolve) => { lockAcquired = resolve; });
    const lockGate = new Promise<void>((resolve) => { releaseLock = resolve; });
    const held = originalRun(async () => {
      lockAcquired();
      await lockGate;
    });
    await acquired;

    let fakeNow = startedAt;
    const clockSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    let refreshQueued!: () => void;
    const queued = new Promise<void>((resolve) => { refreshQueued = resolve; });
    const runSpy = jest.spyOn(transactions, 'run').mockImplementation(async (work) => {
      refreshQueued();
      return originalRun(work);
    });
    const pendingRefresh = request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${refreshToken}`)
      .then((response) => response);
    try {
      await queued;
      fakeNow = expiresAt + 1;
      releaseLock();
      await held;

      const refreshed = await pendingRefresh;
      expect(refreshed.status).toBe(401);
      expect(await app.get(DataSource).query(
        'SELECT expires_at FROM sessions WHERE id = ?',
        [sid],
      )).toEqual([{ expires_at: expiresAt }]);
    } finally {
      releaseLock();
      await held;
      runSpy.mockRestore();
      clockSpy.mockRestore();
      await pendingRefresh;
    }
  });

  it('does not clear the cookie or report success when sid revocation fails', async () => {
    const { app, accessToken } = context!;
    const sid = jwtPayload(accessToken).sid;
    expect(sid).toEqual(expect.any(String));
    expect(sid).toMatch(/^[0-9a-f-]+$/i);
    const dataSource = app.get(DataSource);
    await dataSource.query(`
      CREATE TRIGGER fail_logout_sid
      BEFORE UPDATE OF revoked_at ON sessions
      WHEN NEW.id = '${sid}'
      BEGIN
        SELECT RAISE(ABORT, 'injected logout revocation failure');
      END
    `);
    try {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(response.status).toBe(500);
      expect(response.headers['set-cookie']).toBeUndefined();
    } finally {
      await dataSource.query('DROP TRIGGER IF EXISTS fail_logout_sid');
    }
  });

  it('never lets a pre-recovery refresh session survive a concurrent recovery', async () => {
    const { app, accessToken, refreshToken, accountId } = context!;
    const generated = await request(app.getHttpServer())
      .post('/api/v1/auth/recovery/generate')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ password: PASSWORD })
      .expect(201);
    const code = generated.body.data.codes[1] as string;

    const [refreshResult, recoveryResult] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', `refresh_token=${refreshToken}`),
      request(app.getHttpServer())
        .post('/api/v1/auth/recovery/verify')
        .send({ username: 'admin', code }),
    ]);
    expect([200, 401]).toContain(refreshResult.status);
    expect(recoveryResult.status).toBe(200);

    const recoveredAccess = recoveryResult.body.data.access_token as string;
    const recoveredSid = jwtPayload(recoveredAccess).sid;
    expect(recoveredSid).toEqual(expect.any(String));
    await request(app.getHttpServer())
      .get('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${recoveredAccess}`)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401);
    if (refreshResult.status === 200) {
      await request(app.getHttpServer())
        .get('/api/v1/api-tokens')
        .set('Authorization', `Bearer ${refreshResult.body.data.access_token}`)
        .expect(401);
    }

    const activeSessions = await app.get(DataSource).query(
      'SELECT id FROM sessions WHERE account_id = ? AND revoked_at IS NULL',
      [accountId],
    );
    expect(activeSessions).toEqual([{ id: recoveredSid }]);
  });

  it('rejects a session-bound token once its session expires', async () => {
    const { app, accessToken } = context!;
    const sid = jwtPayload(accessToken).sid;
    expect(sid).toEqual(expect.any(String));
    await app.get(DataSource).query(
      'UPDATE sessions SET expires_at = ? WHERE id = ?',
      [Date.now() - 1, sid],
    );

    const denied = await request(app.getHttpServer())
      .get('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(denied.status).toBe(401);
    expect(responseCode(denied)).toBe('SESSION_EXPIRED');
  });
});
