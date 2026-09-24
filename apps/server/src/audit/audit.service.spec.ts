import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditService } from './audit.service';
import { AuditLog } from './entities/audit-log.entity';

describe('AuditService', () => {
  let service: AuditService;
  let repo: { save: jest.Mock; findAndCount: jest.Mock; delete: jest.Mock };

  beforeEach(async () => {
    repo = {
      save: jest.fn(async (entry) => entry),
      findAndCount: jest.fn(async () => [[], 0]),
      delete: jest.fn(async () => ({ affected: 0 })),
    };
    const module = await Test.createTestingModule({
      providers: [AuditService, { provide: getRepositoryToken(AuditLog), useValue: repo }],
    }).compile();
    service = module.get(AuditService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('anonymizes IPv4 addresses to /24', async () => {
    await service.record({ accountId: 'a1', action: 'auth.login', ip: '203.0.113.87' });
    expect(repo.save.mock.calls[0][0].ipAddress).toBe('203.0.113.0');
  });

  it('anonymizes IPv4-mapped IPv6 addresses to the IPv4 /24', async () => {
    await service.record({ accountId: 'a1', action: 'auth.login', ip: '::ffff:203.0.113.87' });
    expect(repo.save.mock.calls[0][0].ipAddress).toBe('::ffff:203.0.113.0');
  });

  it('preserves only the first three IPv6 segments', async () => {
    await service.record({ accountId: 'a1', action: 'auth.login', ip: '2001:db8:85a3::8a2e:370:7334' });
    expect(repo.save.mock.calls[0][0].ipAddress).toBe('2001:db8:85a3::');
  });

  it('anonymizes compressed IPv6 addresses without shifting segments', async () => {
    await service.record({ accountId: 'a1', action: 'auth.login', ip: '2001:db8::1' });
    expect(repo.save.mock.calls[0][0].ipAddress).toBe('2001:db8::');
  });

  it('truncates user agents to 256 characters', async () => {
    await service.record({ accountId: 'a1', action: 'auth.login', userAgent: 'a'.repeat(300) });
    expect(repo.save.mock.calls[0][0].userAgent).toBe('a'.repeat(256));
  });

  it('does not throw when persistence fails', async () => {
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    repo.save.mockRejectedValue(new Error('db locked'));
    await expect(service.record({ accountId: null, action: 'auth.login' })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('does not throw when details cannot be serialized', async () => {
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    const details: Record<string, unknown> = {};
    details['self'] = details;
    await expect(service.record({ accountId: null, action: 'auth.login', details })).resolves.toBeUndefined();
    expect(repo.save).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('purges records older than exactly 90 days', async () => {
    const startedAt = Date.now();
    await service.purgeExpired();
    expect(repo.delete).toHaveBeenCalled();
    const criteria = repo.delete.mock.calls[0][0];
    expect(criteria.createdAt._value).toBeLessThanOrEqual(startedAt - 90 * 24 * 60 * 60 * 1000);
    expect(criteria.createdAt._value).toBeGreaterThanOrEqual(startedAt - 90 * 24 * 60 * 60 * 1000 - 10);
  });

  it('returns the shared five-field pagination shape', async () => {
    repo.findAndCount.mockResolvedValue([[], 0]);
    const result = await service.findAll(2, 20);
    expect(result).toEqual({ items: [], total: 0, page: 2, page_size: 20, total_pages: 1 });
    expect(repo.findAndCount.mock.calls[0][0].skip).toBe(20);
  });

  it('filters by action and returns ISO timestamps with parsed details', async () => {
    repo.findAndCount.mockResolvedValue([[
      {
        id: 'audit-1',
        accountId: 'a1',
        action: 'auth.login',
        resourceType: null,
        resourceId: null,
        details: '{"username":"alice"}',
        ipAddress: '203.0.113.0',
        userAgent: 'browser',
        createdAt: Date.UTC(2026, 8, 1),
      },
    ], 1]);

    const result = await service.findAll(1, 10, 'auth.login');

    expect(repo.findAndCount.mock.calls[0][0].where).toEqual({ action: 'auth.login' });
    expect(result.items[0]).toEqual({
      id: 'audit-1',
      account_id: 'a1',
      action: 'auth.login',
      resource_type: null,
      resource_id: null,
      details: { username: 'alice' },
      ip_address: '203.0.113.0',
      user_agent: 'browser',
      created_at: '2026-09-01T00:00:00.000Z',
    });
    expect(result).toEqual({
      items: result.items,
      total: 1,
      page: 1,
      page_size: 10,
      total_pages: 1,
    });
  });

  it('returns a page with null details for malformed stored JSON without echoing it', async () => {
    const malformedDetails = '{malformed-secret-payload';
    const warn = jest.spyOn((service as any).logger, 'warn');
    repo.findAndCount.mockResolvedValue([[
      {
        id: 'audit-corrupt',
        accountId: 'a1',
        action: 'auth.login',
        resourceType: null,
        resourceId: null,
        details: malformedDetails,
        ipAddress: null,
        userAgent: null,
        createdAt: Date.UTC(2026, 8, 1),
      },
      {
        id: 'audit-valid',
        accountId: 'a2',
        action: 'auth.login',
        resourceType: null,
        resourceId: null,
        details: '{"username":"alice"}',
        ipAddress: null,
        userAgent: null,
        createdAt: Date.UTC(2026, 8, 2),
      },
    ], 2]);

    const result = await service.findAll(1, 10);

    expect(result.items[0].details).toBeNull();
    expect(result.items[1].details).toEqual({ username: 'alice' });
    expect(JSON.stringify(result)).not.toContain(malformedDetails);
    expect(warn).not.toHaveBeenCalled();
    expect(result.total).toBe(2);
  });
});
