import { ApiTokensController } from './api-tokens.controller';

describe('ApiTokensController audit events', () => {
  const plaintext = 'fs_plaintext_token_must_not_be_audited';
  const apiTokensService = {
    createToken: jest.fn(),
    revokeToken: jest.fn(),
  };
  const auditService = { record: jest.fn().mockResolvedValue(undefined) };
  let controller: ApiTokensController;
  const req = {
    user: { id: 'admin-1' },
    ip: '203.0.113.91',
    headers: { 'user-agent': 'Audit test agent' },
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new ApiTokensController(apiTokensService as any, auditService as any);
  });

  it('returns the created plaintext token once and audits only its safe metadata', async () => {
    apiTokensService.createToken.mockResolvedValue({
      record: { id: 'token-1', name: 'backup', scopes: ['files:read'], token_prefix: 'fs_abc123' },
      plaintext,
    });

    const result = await controller.create({ name: 'backup', scopes: ['files:read'] } as any, req);

    expect(result).toMatchObject({ code: 'OK', data: { id: 'token-1', token: plaintext } });
    expect(auditService.record).toHaveBeenCalledWith({
      accountId: 'admin-1',
      action: 'api_token.created',
      resourceType: 'api_token',
      resourceId: 'token-1',
      details: { name: 'backup', scopes: ['files:read'] },
      ip: '203.0.113.91',
      userAgent: 'Audit test agent',
    });
    expect(JSON.stringify(auditService.record.mock.calls[0][0])).not.toContain(plaintext);
  });

  it('keeps the revoke response and records the token id', async () => {
    apiTokensService.revokeToken.mockResolvedValue(undefined);

    const result = await controller.revoke('token-1', req);

    expect(result).toMatchObject({ code: 'OK', message: 'API token revoked', data: null });
    expect(auditService.record).toHaveBeenCalledWith({
      accountId: 'admin-1',
      action: 'api_token.revoked',
      resourceType: 'api_token',
      resourceId: 'token-1',
      ip: '203.0.113.91',
      userAgent: 'Audit test agent',
    });
  });
});
