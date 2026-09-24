import { SharesController } from './shares.controller';

describe('SharesController audit events', () => {
  const sharesService = { createShare: jest.fn(), revokeShare: jest.fn() };
  const auditService = { record: jest.fn().mockResolvedValue(undefined) };
  let controller: SharesController;
  const req = {
    user: { id: 'admin-1' },
    ip: '192.0.2.44',
    headers: { 'user-agent': 'Audit test agent' },
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new SharesController(sharesService as any, {} as any, {} as any, auditService as any);
  });

  it('returns the share URL and audits protection metadata without the password', async () => {
    sharesService.createShare.mockResolvedValue({ id: 'share-1' });

    const result = await controller.create({
      file_id: 'file-1',
      protection: 'password',
      password: 'share-secret',
      max_downloads: 4,
    } as any, req);

    expect(result).toMatchObject({
      code: 'OK',
      data: { share_id: 'share-1', share_url: '/s/share-1' },
    });
    expect(auditService.record).toHaveBeenCalledWith({
      accountId: 'admin-1',
      action: 'share.created',
      resourceType: 'share',
      resourceId: 'share-1',
      details: { protection: 'password', max_downloads: 4 },
      ip: '192.0.2.44',
      userAgent: 'Audit test agent',
    });
    expect(JSON.stringify(auditService.record.mock.calls[0][0])).not.toContain('share-secret');
  });

  it('keeps the revoke response and records the share id', async () => {
    sharesService.revokeShare.mockResolvedValue(undefined);

    const result = await controller.revoke('share-1', req);

    expect(result).toMatchObject({ code: 'OK', message: 'Share revoked', data: null });
    expect(auditService.record).toHaveBeenCalledWith({
      accountId: 'admin-1',
      action: 'share.revoked',
      resourceType: 'share',
      resourceId: 'share-1',
      ip: '192.0.2.44',
      userAgent: 'Audit test agent',
    });
  });
});
