import { SettingsService } from './settings.service';

describe('SettingsService TOTP security settings', () => {
  const settingsRepository = {
    findOne: jest.fn(),
    save: jest.fn(),
  };
  const configService = { get: jest.fn() };
  const authenticatorsRepository = { count: jest.fn() };
  const connection = {
    get: jest.fn(async (_sql: string, parameters: unknown[] = []) => {
      const count = await authenticatorsRepository.count({
        where: { type: parameters[0], isActive: parameters[1] },
      });
      return { count };
    }),
    run: jest.fn(async (sql: string, parameters: unknown[] = []) => {
      if (sql.startsWith('INSERT INTO settings')) {
        await settingsRepository.save({
          key: parameters[0],
          value: parameters[1],
          updatedAt: parameters[2],
          updatedBy: parameters[3],
        });
      }
      return { changes: 1, lastID: 1 };
    }),
  };
  const sqliteTransactions = {
    run: jest.fn(async (work: (db: typeof connection) => Promise<void>) => work(connection)),
  };
  let service: any;

  beforeEach(() => {
    jest.clearAllMocks();
    settingsRepository.findOne.mockResolvedValue(null);
    settingsRepository.save.mockResolvedValue(undefined);
    authenticatorsRepository.count.mockResolvedValue(0);
    service = new (SettingsService as any)(
      settingsRepository as any,
      configService as any,
      authenticatorsRepository as any,
      sqliteTransactions as any,
    );
  });

  it('derives totp_active from active TOTP authenticators and does not persist it', async () => {
    authenticatorsRepository.count.mockResolvedValue(1);
    settingsRepository.findOne.mockResolvedValue({
      key: 'security',
      value: JSON.stringify({ totp_required: false, max_login_attempts: 5, lockout_minutes: 15 }),
    });

    const settings = await service.getSecuritySettings();

    expect(settings.totp_active).toBe(true);
    expect(authenticatorsRepository.count).toHaveBeenCalledWith({
      where: { type: 'totp', isActive: 1 },
    });
    expect(JSON.stringify(settings)).not.toContain('totp_secret');
  });

  it('prevents requiring TOTP until an active authenticator exists', async () => {
    await expect(service.setSecuritySettings({ totp_required: true } as any, 'admin-1'))
      .rejects.toMatchObject({ response: { code: 'TOTP_NOT_ENABLED' } });

    expect(settingsRepository.save).not.toHaveBeenCalled();
  });

  it('allows requiring TOTP after enrollment and strips the derived field before persistence', async () => {
    authenticatorsRepository.count.mockResolvedValue(1);

    await service.setSecuritySettings({
      totp_required: true,
      max_login_attempts: 8,
      totp_active: false,
    } as any, 'admin-1');

    expect(settingsRepository.save).toHaveBeenCalledWith(expect.objectContaining({
      key: 'security',
      value: JSON.stringify({ totp_required: true, max_login_attempts: 8 }),
      updatedBy: 'admin-1',
    }));
  });

  it('keeps derived activity false when no active authenticator exists', async () => {
    await expect(service.getSecuritySettings()).resolves.toMatchObject({ totp_active: false });
  });

  it('uses an independent transaction for the active-TOTP check and settings write', async () => {
    const connection = {
      get: jest.fn().mockResolvedValue({ count: 1 }),
      run: jest.fn().mockResolvedValue({ changes: 1, lastID: 1 }),
    };
    const sqliteTransactions = {
      run: jest.fn(async (work: (db: typeof connection) => Promise<void>) => work(connection)),
    };
    const isolatedService = new (SettingsService as any)(
      settingsRepository as any,
      configService as any,
      authenticatorsRepository as any,
      sqliteTransactions as any,
    );

    await isolatedService.setSecuritySettings({ totp_required: true } as any, 'admin-1');

    expect(sqliteTransactions.run).toHaveBeenCalledTimes(1);
    expect(connection.get).toHaveBeenCalledWith(
      'SELECT COUNT(1) AS count FROM authenticators WHERE type = ? AND is_active = ?',
      ['totp', 1],
    );
    expect(connection.run).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO settings'),
      expect.arrayContaining(['security']),
    );
  });
});
