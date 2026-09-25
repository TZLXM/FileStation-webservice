import { SettingsController } from './settings.controller';

describe('SettingsController audit events', () => {
  const settingsService = {
    getSecuritySettings: jest.fn(),
    getTransferSettings: jest.fn(),
    setSecuritySettings: jest.fn(),
    set: jest.fn(),
  };
  const auditService = { record: jest.fn().mockResolvedValue(undefined) };
  let controller: SettingsController;
  const req = {
    user: { id: 'admin-1' },
    ip: '198.51.100.62',
    headers: { 'user-agent': 'Audit test agent' },
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new SettingsController(settingsService as any, auditService as any);
  });

  it('returns the existing update response and records changed section names only', async () => {
    settingsService.getSecuritySettings.mockResolvedValue({
      totp_required: false,
      max_login_attempts: 5,
      lockout_minutes: 15,
    });
    settingsService.getTransferSettings.mockResolvedValue({ default_chunk_size: 1024 });
    settingsService.set.mockResolvedValue(undefined);
    const body = {
      security: { totp_required: true, max_login_attempts: 8 },
      transfer: { default_chunk_size: 2048 },
    };

    const result = await controller.update(body as any, req);

    expect(result).toMatchObject({ code: 'OK', message: 'Settings updated', data: null });
    expect(auditService.record).toHaveBeenCalledWith({
      accountId: 'admin-1',
      action: 'settings.updated',
      details: { sections: ['security', 'transfer'] },
      ip: '198.51.100.62',
      userAgent: 'Audit test agent',
    });
    expect(JSON.stringify(auditService.record.mock.calls[0][0])).not.toContain('2048');
    expect(JSON.stringify(auditService.record.mock.calls[0][0])).not.toContain('true');
  });

  it('does not emit a settings event when persistence fails', async () => {
    settingsService.getSecuritySettings.mockResolvedValue({ max_login_attempts: 5 });
    settingsService.setSecuritySettings.mockRejectedValue(new Error('settings write failed'));

    await expect(controller.update({ security: { max_login_attempts: 8 } } as any, req)).rejects.toThrow('settings write failed');
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('keeps the success response but does not audit updates that persist no valid setting keys', async () => {
    settingsService.set.mockResolvedValue(undefined);
    const emptyRequests = [
      {},
      { security: {} },
      { unsupported: { value: 'ignored' } },
    ];

    for (const body of emptyRequests) {
      const result = await controller.update(body as any, req);
      expect(result).toMatchObject({ code: 'OK', message: 'Settings updated', data: null });
    }

    expect(auditService.record).not.toHaveBeenCalled();
    expect(settingsService.set).not.toHaveBeenCalled();
  });

  it('treats totp_active as derived read-only data when updating security settings', async () => {
    settingsService.getSecuritySettings.mockResolvedValue({
      totp_required: false,
      totp_active: true,
      max_login_attempts: 5,
      lockout_minutes: 15,
    });
    settingsService.setSecuritySettings.mockResolvedValue(undefined);

    await controller.update({
      security: { totp_active: false, max_login_attempts: 8 },
    } as any, req);

    expect(settingsService.setSecuritySettings).toHaveBeenCalledWith({
      totp_required: false,
      max_login_attempts: 8,
      lockout_minutes: 15,
    }, 'admin-1');
    expect(settingsService.set).not.toHaveBeenCalledWith('security', expect.objectContaining({ totp_active: expect.anything() }), 'admin-1');
  });
});
