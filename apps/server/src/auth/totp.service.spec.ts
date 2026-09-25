import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { authenticator } from 'otplib';

type TotpServiceModule = { TotpService: new (...args: any[]) => any };

function loadTotpService(): TotpServiceModule | null {
  try {
    return require('./totp.service') as TotpServiceModule;
  } catch {
    return null;
  }
}

function createFixture() {
  const rows: any[] = [];
  const matches = (row: any, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const repository = {
    findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find((row) => matches(row, where)) ?? null),
    save: jest.fn(async (row: any) => {
      rows.push(row);
      return row;
    }),
    update: jest.fn(async (criteria: Record<string, unknown>, patch: Record<string, unknown>) => {
      const matchesRows = rows.filter((row) => matches(row, criteria));
      for (const row of matchesRows) Object.assign(row, patch);
      return { affected: matchesRows.length };
    }),
    delete: jest.fn(async (where: Record<string, unknown>) => {
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (matches(rows[index], where)) rows.splice(index, 1);
      }
      return { affected: before - rows.length };
    }),
    count: jest.fn(async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => matches(row, where)).length),
  };
  const accountsService = {
    findById: jest.fn().mockResolvedValue({ id: 'account-1', username: 'admin' }),
    validatePassword: jest.fn().mockResolvedValue(true),
  };
  const configService = { get: jest.fn().mockReturnValue('unit-test-key') };
  const auditService = { record: jest.fn().mockResolvedValue(undefined) };
  let securitySetting: { key: string; value: string } | null = null;
  const sqliteConnection = {
    get: jest.fn(async (sql: string, parameters: unknown[] = []) => {
      if (sql.startsWith('SELECT value FROM settings')) return securitySetting ?? undefined;
      if (sql.startsWith('SELECT id FROM authenticators')) {
        const row = rows.find((candidate) => candidate.accountId === parameters[0]
          && candidate.type === parameters[1]
          && candidate.isActive === Number(parameters[2]));
        return row ? { id: row.id } : undefined;
      }
      if (sql.startsWith('SELECT id, totp_secret_encrypted FROM authenticators')) {
        const row = rows.find((candidate) => candidate.accountId === parameters[0]
          && candidate.type === parameters[1]
          && candidate.isActive === Number(parameters[2]));
        return row ? { id: row.id, totp_secret_encrypted: row.totpSecretEncrypted } : undefined;
      }
      return undefined;
    }),
    run: jest.fn(async (sql: string, parameters: unknown[] = []) => {
      if (sql.startsWith('DELETE FROM authenticators')) {
        const where: Record<string, unknown> = { accountId: parameters[0], type: parameters[1] };
        if (parameters.length > 2) where.isActive = Number(parameters[2]);
        const before = rows.length;
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (matches(rows[index], where)) rows.splice(index, 1);
        }
        return { changes: before - rows.length, lastID: 0 };
      }
      if (sql.startsWith('UPDATE authenticators SET last_used_at')) {
        const timestamp = Number(parameters[0]);
        const id = String(parameters[1]);
        const type = String(parameters[2]);
        const expectedActive = Number(parameters[3]);
        const stepTimestamp = Number(parameters[4]);
        const row = rows.find((candidate) => candidate.id === id
          && candidate.type === type
          && candidate.isActive === expectedActive
          && (candidate.lastUsedAt === null || candidate.lastUsedAt < stepTimestamp));
        if (!row) return { changes: 0, lastID: 0 };
        Object.assign(row, { lastUsedAt: timestamp, isActive: 1 });
        return { changes: 1, lastID: 0 };
      }
      if (sql.startsWith('INSERT INTO authenticators')) {
        const [id, accountId, type, name, totpSecretEncrypted, _credentialId, _publicKey, signCount, transports, createdAt, lastUsedAt, isActive] = parameters;
        const row = { id, accountId, type, name, totpSecretEncrypted, signCount, transports, createdAt, lastUsedAt, isActive };
        rows.push(row);
        return { changes: 1, lastID: 0 };
      }
      return { changes: 0, lastID: 0 };
    }),
  };
  const sqliteTransactions = { run: jest.fn(async (work: (connection: any) => Promise<unknown>) => work(sqliteConnection)) };
  const module = loadTotpService();

  expect(module).not.toBeNull();
  if (!module) return null;

  const service = new module.TotpService(repository, accountsService, configService, auditService, sqliteTransactions);
  return {
    service,
    rows,
    repository,
    accountsService,
    auditService,
    sqliteConnection,
    sqliteTransactions,
    setSecurityRequired: (required: boolean) => {
      securitySetting = { key: 'security', value: JSON.stringify({ totp_required: required }) };
    },
  };
}

function generateCode(secret: string): string {
  return authenticator.create({ ...authenticator.options, window: 1 }).generate(secret);
}

function generateCodeAt(secret: string, epoch: number): string {
  return authenticator.create({ ...authenticator.options, window: 1, epoch }).generate(secret);
}

describe('TotpService', () => {
  it('stores an inactive versioned ciphertext and returns provisioning data without auditing it', async () => {
    const fixture = createFixture();
    if (!fixture) return;

    const result = await fixture.service.setup('account-1');
    const [saved] = fixture.rows;

    expect(result.secret).toBeTruthy();
    expect(result.otpauth_url).toMatch(/^otpauth:\/\/totp\//);
    expect(result.qr_code_data_url).toMatch(/^data:image\/png;base64,/);
    expect(saved).toMatchObject({ accountId: 'account-1', type: 'totp', isActive: 0 });
    expect(saved.totpSecretEncrypted).toMatch(/^v1\./);
    expect(saved.totpSecretEncrypted).not.toContain(result.secret);
    expect(fixture.auditService.record).not.toHaveBeenCalled();
  });

  it('rejects a second setup while an active TOTP exists', async () => {
    const fixture = createFixture();
    if (!fixture) return;
    fixture.rows.push({ accountId: 'account-1', type: 'totp', isActive: 1 });

    await expect(fixture.service.setup('account-1')).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.repository.save).not.toHaveBeenCalled();
  });

  it('rejects an invalid confirmation code without activating the pending authenticator', async () => {
    const fixture = createFixture();
    if (!fixture) return;
    await fixture.service.setup('account-1');

    await expect(fixture.service.confirm('account-1', 'invalid')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(fixture.rows[0].isActive).toBe(0);
    expect(fixture.auditService.record).not.toHaveBeenCalled();
  });

  it('activates a pending authenticator after a valid locally generated code', async () => {
    const fixture = createFixture();
    if (!fixture) return;
    const { secret } = await fixture.service.setup('account-1');
    const code = generateCode(secret);

    await fixture.service.confirm('account-1', code);

    expect(fixture.rows[0].isActive).toBe(1);
    expect(fixture.rows[0].lastUsedAt).toEqual(expect.any(Number));
    expect(await fixture.service.verifyCode('account-1', code)).toBe(false);
    expect(fixture.auditService.record).toHaveBeenCalledWith({ accountId: 'account-1', action: 'auth.totp_enabled' });
  });

  it('requires the account password before disabling TOTP', async () => {
    const fixture = createFixture();
    if (!fixture) return;
    const { secret } = await fixture.service.setup('account-1');
    fixture.rows[0].isActive = 1;
    fixture.accountsService.validatePassword.mockResolvedValue(false);
    const code = generateCode(secret);
    const deleteCallsBefore = fixture.repository.delete.mock.calls.length;

    await expect(fixture.service.disable('account-1', 'wrong-password', code)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(fixture.repository.delete).toHaveBeenCalledTimes(deleteCallsBefore);
    expect(fixture.rows[0].isActive).toBe(1);
  });

  it('requires a valid TOTP code before disabling TOTP', async () => {
    const fixture = createFixture();
    if (!fixture) return;
    await fixture.service.setup('account-1');
    fixture.rows[0].isActive = 1;
    const deleteCallsBefore = fixture.repository.delete.mock.calls.length;

    await expect(fixture.service.disable('account-1', 'valid-password', 'invalid')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(fixture.repository.delete).toHaveBeenCalledTimes(deleteCallsBefore);
    expect(fixture.rows[0].isActive).toBe(1);
  });

  it('deletes the authenticator and records only a redacted success event after both checks pass', async () => {
    const fixture = createFixture();
    if (!fixture) return;
    const { secret } = await fixture.service.setup('account-1');
    fixture.rows[0].isActive = 1;
    const code = generateCode(secret);

    await fixture.service.disable('account-1', 'valid-password', code);

    expect(fixture.rows).toHaveLength(0);
    expect(fixture.auditService.record).toHaveBeenCalledWith({ accountId: 'account-1', action: 'auth.totp_disabled' });
    expect(JSON.stringify(fixture.auditService.record.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(fixture.auditService.record.mock.calls)).not.toContain(code);
  });

  it('prevents disabling the last TOTP authenticator while TOTP is required', async () => {
    const fixture = createFixture();
    if (!fixture) return;
    const { secret } = await fixture.service.setup('account-1');
    fixture.rows[0].isActive = 1;
    fixture.setSecurityRequired(true);
    const code = generateCode(secret);

    await expect(fixture.service.disable('account-1', 'valid-password', code))
      .rejects.toMatchObject({ response: { code: 'TOTP_REQUIRED' } });

    expect(fixture.rows).toHaveLength(1);
    expect(fixture.rows[0].isActive).toBe(1);
    expect(fixture.auditService.record).not.toHaveBeenCalled();
  });

  it('verifies only an active authenticator and updates its last-used timestamp on success', async () => {
    const fixture = createFixture();
    if (!fixture) return;
    const { secret } = await fixture.service.setup('account-1');
    const code = generateCode(secret);

    expect(await fixture.service.verifyCode('account-1', code)).toBe(false);
    fixture.rows[0].isActive = 1;
    expect(await fixture.service.verifyCode('account-1', code)).toBe(true);
    expect(fixture.rows[0].lastUsedAt).toEqual(expect.any(Number));
    expect(await fixture.service.verifyCode('account-1', code)).toBe(false);
  });

  it.each([-1, 0, 1])('consumes the matching TOTP counter once for window delta %i', async (delta) => {
    const fixture = createFixture();
    if (!fixture) return;
    const { secret } = await fixture.service.setup('account-1');
    fixture.rows[0].isActive = 1;
    const now = Date.now();
    const stepMillis = 30_000;
    const counter = Math.floor(now / stepMillis) + delta;
    const fixedClock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const code = generateCodeAt(secret, counter * stepMillis + 100);

      expect(await fixture.service.verifyCode('account-1', code)).toBe(true);
      expect(fixture.rows[0].lastUsedAt).toBe(counter * stepMillis);
      expect(await fixture.service.verifyCode('account-1', code)).toBe(false);
    } finally {
      fixedClock.mockRestore();
    }
  });

  it('atomically rejects concurrent reuse of the same TOTP counter', async () => {
    const fixture = createFixture();
    if (!fixture) return;
    const { secret } = await fixture.service.setup('account-1');
    fixture.rows[0].isActive = 1;
    const code = generateCode(secret);

    const results = await Promise.all(Array.from({ length: 8 }, () => fixture.service.verifyCode('account-1', code)));

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((accepted) => !accepted)).toHaveLength(7);
  });
});
