import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { authenticator } from 'otplib';
import request from 'supertest';
import { createHash } from 'crypto';
import { RecoveryCode } from '../src/auth/entities/recovery-code.entity';
import { Session } from '../src/auth/entities/session.entity';
import { RecoveryService } from '../src/auth/recovery.service';
import { setupEnv, teardownEnv, createApp, initAndLogin, TestEnv } from './helpers';

function responseCode(response: any): string | undefined {
  return response.body.code ?? response.body.error?.code;
}

function hasRefreshCookie(header: unknown): boolean {
  const values = Array.isArray(header) ? header : typeof header === 'string' ? [header] : [];
  return values.some((cookie) => typeof cookie === 'string' && cookie.startsWith('refresh_token='));
}

function refreshCookie(header: unknown): string | undefined {
  const values = Array.isArray(header) ? header : typeof header === 'string' ? [header] : [];
  const cookie = values.find((value) => typeof value === 'string' && value.startsWith('refresh_token='));
  return typeof cookie === 'string' ? cookie.split(';', 1)[0].slice('refresh_token='.length) : undefined;
}

function nextTotpCode(secret: string): string {
  const counter = Math.floor(Date.now() / 30_000) + 1;
  return authenticator.create({ ...authenticator.options, window: 1, epoch: counter * 30_000 + 100 }).generate(secret);
}

describe('recovery-code authentication (e2e)', () => {
  jest.setTimeout(120_000);
  let env: TestEnv;
  let app: INestApplication;
  let adminJwt: string;
  let latestCodes: string[] = [];

  beforeAll(async () => {
    env = await setupEnv();
    app = await createApp();
    adminJwt = await initAndLogin(app);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await teardownEnv(env);
  });

  it('atomically limits recovery factor work to ten attempts per client IP', async () => {
    const recoveryService = app.get(RecoveryService);
    let entered = 0;
    let firstIp: string | undefined;
    let release!: () => void;
    let tenthStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tenEntered = new Promise<void>((resolve) => { tenthStarted = resolve; });
    const verifySpy = jest.spyOn(recoveryService, 'verify').mockImplementation(async (...args) => {
      entered += 1;
      firstIp ??= args[2];
      if (entered === 10) tenthStarted();
      await gate;
      throw new UnauthorizedException({ code: 'INVALID_RECOVERY_CODE' });
    });

    const attempts = Array.from({ length: 11 }, (_, index) =>
      request(app.getHttpServer())
        .post('/api/v1/auth/recovery/verify')
        .send({ username: `missing-${index}`, code: 'ABCD-EFGH-JK' })
        .then((response) => response),
    );
    try {
      await tenEntered;
      const firstCompleted = await Promise.race([
        Promise.race(attempts),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      expect(firstCompleted).not.toBeNull();
      expect(firstCompleted && responseCode(firstCompleted)).toBe('IP_THROTTLED');
      expect(entered).toBe(10);
    } finally {
      release();
      await Promise.all(attempts);
      verifySpy.mockRestore();
      if (firstIp) {
        await app.get(DataSource).query('DELETE FROM system_meta WHERE key = ?', [`login_ip_${firstIp}`]);
      }
    }
  });

  it('publishes OpenAPI contracts for both recovery endpoints', async () => {
    const document = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    const generate = document.body.paths['/api/v1/auth/recovery/generate'].post;
    const verify = document.body.paths['/api/v1/auth/recovery/verify'].post;

    expect(generate.tags).toContain('auth');
    expect(generate.security).toEqual([{ bearerAuth: [] }]);
    expect(generate.requestBody.content['application/json'].schema.$ref).toContain('RecoveryGenerateDto');
    expect(generate.responses['201'].content['application/json'].schema.$ref).toContain('RecoveryGenerateResponseDto');
    expect(generate.responses['401']).toBeDefined();
    expect(generate.responses['403']).toBeDefined();
    expect(verify.tags).toContain('auth');
    expect(verify.security ?? []).toEqual([]);
    expect(verify.requestBody.content['application/json'].schema.$ref).toContain('RecoveryVerifyDto');
    expect(verify.responses['200'].content['application/json'].schema.$ref).toContain('RecoveryVerifyResponseDto');
    expect(verify.responses['401']).toBeDefined();
    expect(document.body.components.schemas.RecoveryGenerateDto.properties.password.minLength).toBe(1);
    expect(document.body.components.schemas.RecoveryGenerateDto.required).toContain('password');
    expect(document.body.components.schemas.RecoveryGenerateDto.required).not.toContain('totp_code');
    expect(document.body.components.schemas.RecoveryVerifyDto.properties.code.maxLength).toBe(32);
    expect(document.body.components.schemas.RecoveryGenerateDataDto.properties.codes.type).toBe('array');
    expect(document.body.components.schemas.RecoveryVerifyDataDto.properties.expires_in.example).toBe(86400);
  });

  it('validates request DTOs and requires an administrator for code generation', async () => {
    const malformed = await request(app.getHttpServer())
      .post('/api/v1/auth/recovery/verify')
      .send({ username: '', code: 7 })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/auth/recovery/generate')
      .send({ password: 'current-password' })
      .expect(401);
  });

  it('rejects API-token principals from administrator recovery-code generation', async () => {
    const token = await request(app.getHttpServer())
      .post('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ name: 'recovery-guard', scopes: ['files:read'] })
      .expect(201);
    const apiLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/api-token/exchange')
      .set('Authorization', `Bearer ${token.body.data.token}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/recovery/generate')
      .set('Authorization', `Bearer ${apiLogin.body.data.access_token}`)
      .send({ password: 'StrongP@ssw0rd' })
      .expect(403);
  });

  it('generates a complete Argon2id group once and invalidates every old unused code on regeneration', async () => {
    const first = await request(app.getHttpServer())
      .post('/api/v1/auth/recovery/generate')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ password: 'StrongP@ssw0rd' })
      .expect(201);
    const firstCodes = first.body.data.codes as string[];
    expect(firstCodes).toHaveLength(10);
    expect(firstCodes.every((code) => /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/.test(code))).toBe(true);

    const repository = app.get(DataSource).getRepository(RecoveryCode);
    const account = await app.get(DataSource).query("SELECT id FROM admin_accounts WHERE username = 'admin'");
    const rows = await repository.findBy({ accountId: account[0].id });
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.codeHash.startsWith('$argon2id$'))).toBe(true);
    expect(rows.every((row) => row.expiresAt - row.createdAt === 24 * 60 * 60 * 1000)).toBe(true);
    expect(rows.every((row) => firstCodes.every((code) => !row.codeHash.includes(code)))).toBe(true);

    const second = await request(app.getHttpServer())
      .post('/api/v1/auth/recovery/generate')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ password: 'StrongP@ssw0rd' })
      .expect(201);
    latestCodes = second.body.data.codes;
    expect(latestCodes).toHaveLength(10);
    const obsolete = await request(app.getHttpServer())
      .post('/api/v1/auth/recovery/verify')
      .send({ username: 'admin', code: firstCodes[0] });
    expect(obsolete.status).toBe(401);
    expect(responseCode(obsolete)).toBe('INVALID_RECOVERY_CODE');
    expect(JSON.stringify(obsolete.body)).not.toContain(firstCodes[0]);
  });

  it('serializes different valid codes with their session replacement before returning tokens', async () => {
    const firstCode = latestCodes[2];
    const secondCode = latestCodes[3];
    const recoveryService = app.get(RecoveryService);
    const originalVerify = recoveryService.verify.bind(recoveryService);
    let firstCommitted!: () => void;
    let releaseFirst!: () => void;
    const firstCommit = new Promise<void>((resolve) => { firstCommitted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const verifySpy = jest.spyOn(recoveryService, 'verify').mockImplementation(async (...args) => {
      const result = await originalVerify(...args);
      if (args[1] === firstCode) {
        firstCommitted();
        await firstGate;
      }
      return result;
    });

    const firstRequest = request(app.getHttpServer())
      .post('/api/v1/auth/recovery/verify')
      .send({ username: 'admin', code: firstCode })
      .then((response) => response);
    try {
      await firstCommit;
      const secondResponse = await request(app.getHttpServer())
        .post('/api/v1/auth/recovery/verify')
        .send({ username: 'admin', code: secondCode })
        .expect(200);
      releaseFirst();
      const firstResponse = await firstRequest;
      expect(firstResponse.status).toBe(200);
      const dataSource = app.get(DataSource);
      const account = (await dataSource.query("SELECT id FROM admin_accounts WHERE username = 'admin'"))[0];
      const active = await dataSource.getRepository(Session).findBy({ accountId: account.id, revokedAt: IsNull() });
      expect(active).toHaveLength(1);
      const winningRefreshToken = refreshCookie(secondResponse.headers['set-cookie']);
      const firstRefreshToken = refreshCookie(firstResponse.headers['set-cookie']);
      expect(winningRefreshToken).toBeDefined();
      expect(active[0].refreshTokenHash).toBe(createHash('sha256').update(winningRefreshToken!).digest('hex'));
      expect(active[0].refreshTokenHash).not.toBe(createHash('sha256').update(firstRefreshToken!).digest('hex'));
      const jwtPayload = JSON.parse(Buffer.from(secondResponse.body.data.access_token.split('.')[1], 'base64url').toString());
      expect(jwtPayload).toMatchObject({ sub: account.id, username: 'admin', principal_type: 'admin' });

      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', `refresh_token=${firstRefreshToken}`)
        .expect(401);
      const refreshedWinner = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', `refresh_token=${winningRefreshToken}`)
        .expect(200);
      const rotatedRefreshToken = refreshCookie(refreshedWinner.headers['set-cookie']);
      expect(rotatedRefreshToken).toBeDefined();
      const sessionsAfterRefresh = await dataSource.getRepository(Session).findBy({ accountId: account.id });
      const activeAfterRefresh = sessionsAfterRefresh.filter(({ revokedAt }) => revokedAt === null);
      expect(activeAfterRefresh).toHaveLength(1);
      expect(sessionsAfterRefresh.find(({ id }) => id === active[0].id)?.revokedAt).not.toBeNull();
      expect(activeAfterRefresh[0].refreshTokenHash)
        .toBe(createHash('sha256').update(rotatedRefreshToken!).digest('hex'));
    } finally {
      releaseFirst();
      verifySpy.mockRestore();
    }
  });

  it('locks after five wrong codes, blocks a correct sixth attempt, then recovery revokes all prior sessions', async () => {
    const dataSource = app.get(DataSource);
    await dataSource.query("DELETE FROM system_meta WHERE key = 'recovery_fail_admin'");
    const wrongResults = await Promise.all(Array.from({ length: 5 }, () =>
      request(app.getHttpServer())
        .post('/api/v1/auth/recovery/verify')
        .send({ username: 'admin', code: 'ZZZZ-ZZZZ-ZZ' }),
    ));
    expect(wrongResults.every((result) => result.status === 401)).toBe(true);
    expect(wrongResults.every((result) => responseCode(result) === 'INVALID_RECOVERY_CODE')).toBe(true);

    const locked = await request(app.getHttpServer())
      .post('/api/v1/auth/recovery/verify')
      .send({ username: 'admin', code: latestCodes[0] });
    expect(locked.status).toBe(401);
    expect(responseCode(locked)).toBe('RECOVERY_LOCKED');

    await dataSource.query("DELETE FROM system_meta WHERE key = 'recovery_fail_admin'");
    const sessionsRepository = dataSource.getRepository(Session);
    const before = await sessionsRepository.findBy({ accountId: (await dataSource.query("SELECT id FROM admin_accounts WHERE username = 'admin'"))[0].id });
    expect(before.some((session) => session.revokedAt === null)).toBe(true);

    const recovered = await request(app.getHttpServer())
      .post('/api/v1/auth/recovery/verify')
      .send({ username: 'admin', code: latestCodes[0].toLowerCase().replace('-', ' ') })
      .expect(200);
    expect(typeof recovered.body.data.access_token).toBe('string');
    expect(recovered.body.data.username).toBe('admin');
    expect(hasRefreshCookie(recovered.headers['set-cookie'])).toBe(true);

    const after = await sessionsRepository.findBy({ accountId: before[0].accountId });
    expect(before.filter((session) => session.revokedAt === null).every((prior) =>
      after.find((session) => session.id === prior.id)?.revokedAt !== null,
    )).toBe(true);
    expect(after.filter((session) => session.revokedAt === null)).toHaveLength(1);
  });

  it('allows only one concurrent request to consume the same recovery code', async () => {
    const code = latestCodes[1];
    const dataSource = app.get(DataSource);
    const account = (await dataSource.query("SELECT id FROM admin_accounts WHERE username = 'admin'"))[0];
    const usedBefore = (await dataSource.getRepository(RecoveryCode).findBy({ accountId: account.id }))
      .filter(({ usedAt }) => usedAt !== null).length;
    const results = await Promise.all(Array.from({ length: 2 }, () =>
      request(app.getHttpServer())
        .post('/api/v1/auth/recovery/verify')
        .send({ username: 'admin', code }),
    ));

    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(results.filter((result) => result.status === 401)).toHaveLength(1);
    const codes = await dataSource.getRepository(RecoveryCode).findBy({ accountId: account.id });
    expect(codes.filter(({ usedAt }) => usedAt !== null)).toHaveLength(usedBefore + 1);
    expect(results.every((result) => !JSON.stringify(result.body).includes(code))).toBe(true);
  });

  it('requires and consumes a TOTP code when generating recovery codes for a TOTP-enabled account', async () => {
    const setup = await request(app.getHttpServer())
      .post('/api/v1/auth/totp/setup')
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(201);
    const secret = setup.body.data.secret as string;
    const confirmation = authenticator.create({ ...authenticator.options, window: 1 }).generate(secret);
    await request(app.getHttpServer())
      .post('/api/v1/auth/totp/confirm')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ code: confirmation })
      .expect(201);

    const missing = await request(app.getHttpServer())
      .post('/api/v1/auth/recovery/generate')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ password: 'StrongP@ssw0rd' });
    expect(missing.status).toBe(401);
    expect(responseCode(missing)).toBe('TOTP_REQUIRED');

    const generated = await request(app.getHttpServer())
      .post('/api/v1/auth/recovery/generate')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ password: 'StrongP@ssw0rd', totp_code: nextTotpCode(secret) })
      .expect(201);
    expect(generated.body.data.codes).toHaveLength(10);
  });
});
