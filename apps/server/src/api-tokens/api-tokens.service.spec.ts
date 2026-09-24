import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { ApiTokensService } from './api-tokens.service';
import { ApiToken } from './entities/api-token.entity';

const mockRepo = () => ({ save: jest.fn(), find: jest.fn(), findOne: jest.fn(), update: jest.fn() });

const makeToken = (overrides: Partial<ApiToken> = {}): ApiToken => ({
  id: 't1',
  accountId: 'acc1',
  name: 'agent',
  tokenPrefix: 'fs_api_12345',
  tokenHash: 'a'.repeat(64),
  scopes: '["files:read"]',
  expiresAt: null,
  createdAt: 1_700_000_000_000,
  lastUsedAt: null,
  lastUsedIp: null,
  revokedAt: null,
  ...overrides,
});

describe('ApiTokensService', () => {
  let service: ApiTokensService;
  let repo: ReturnType<typeof mockRepo>;

  beforeEach(async () => {
    repo = mockRepo();
    const module = await Test.createTestingModule({
      providers: [ApiTokensService, { provide: getRepositoryToken(ApiToken), useValue: repo }],
    }).compile();
    service = module.get(ApiTokensService);
  });

  it('签发：明文仅返回一次，库中只存 SHA-256 哈希与前缀', async () => {
    repo.save.mockImplementation(async (e) => e);
    const { record, plaintext } = await service.createToken('acc1', 'agent', ['files:read', 'shares:write'], 30);
    expect(plaintext).toMatch(/^fs_api_[0-9a-f]{48}$/);
    expect(record).not.toHaveProperty('token');
    expect(record.token_prefix).toBe(plaintext.substring(0, 12));
    const saved = repo.save.mock.calls[0][0] as ApiToken;
    expect(saved.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(saved.tokenHash).not.toBe(plaintext);
    expect(saved.expiresAt).toBeGreaterThan(Date.now());
  });

  it('签发：scopes 必须是合法子集', async () => {
    await expect(
      service.createToken('acc1', 'bad', ['admin:all' as any], null),
    ).rejects.toThrow();
  });

  it('validatePlaintext：有效/吊销/过期/不存在/前缀错 五分支（mock 按真实 SHA-256 匹配）', async () => {
    const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
    const ok = 'fs_api_' + 'a'.repeat(48);
    const rev = 'fs_api_' + 'b'.repeat(48);
    const exp = 'fs_api_' + 'c'.repeat(48);
    repo.findOne.mockImplementation(async ({ where }: any) => {
      if (where.tokenHash === sha256(ok)) return { id: 't1', revokedAt: null, expiresAt: Date.now() + 60_000 };
      if (where.tokenHash === sha256(rev)) return { id: 't2', revokedAt: Date.now(), expiresAt: null };
      if (where.tokenHash === sha256(exp)) return { id: 't3', revokedAt: null, expiresAt: Date.now() - 1 };
      return null;
    });
    expect((await service.validatePlaintext(ok))?.id).toBe('t1');
    expect(await service.validatePlaintext(rev)).toBeNull();  // 已吊销
    expect(await service.validatePlaintext(exp)).toBeNull();  // 已过期
    expect(await service.validatePlaintext('fs_api_' + 'd'.repeat(48))).toBeNull(); // 不存在
    expect(await service.validatePlaintext('not-a-token')).toBeNull(); // 前缀不符短路
  });

  it('listTokens：只查询指定账号，并返回不含哈希的公开信息', async () => {
    repo.find.mockResolvedValue([
      makeToken({
        expiresAt: 1_700_000_100_000,
        lastUsedAt: 1_700_000_050_000,
        lastUsedIp: '1.2.3.0',
        revokedAt: 1_700_000_060_000,
      }),
    ]);

    const records = await service.listTokens('acc1');

    expect(repo.find).toHaveBeenCalledWith({ where: { accountId: 'acc1' }, order: { createdAt: 'DESC' } });
    expect(records).toEqual([{
      id: 't1',
      name: 'agent',
      token_prefix: 'fs_api_12345',
      scopes: ['files:read'],
      expires_at: '2023-11-14T22:15:00.000Z',
      created_at: '2023-11-14T22:13:20.000Z',
      last_used_at: '2023-11-14T22:14:10.000Z',
      last_used_ip: '1.2.3.0',
      revoked_at: '2023-11-14T22:14:20.000Z',
    }]);
    expect(records[0]).not.toHaveProperty('tokenHash');
  });

  it('revokeToken：只吊销属于当前账号的指定 token', async () => {
    repo.update.mockResolvedValue({ affected: 1 });
    const before = Date.now();

    await service.revokeToken('acc1', 't1');

    const [criteria, changes] = repo.update.mock.calls[0];
    expect(criteria).toEqual({ id: 't1', accountId: 'acc1' });
    expect(changes.revokedAt).toBeGreaterThanOrEqual(before);
  });

  it('revokeToken：token 不存在或不属于账号时返回 not found', async () => {
    repo.update.mockResolvedValue({ affected: 0 });

    await expect(service.revokeToken('acc1', 'other-account-token')).rejects.toThrow('API token not found');
  });

  it('touchLastUsed：距上次不足 60 秒不写库', async () => {
    repo.findOne.mockResolvedValue({ id: 't1', lastUsedAt: Date.now() - 1000 });
    await service.touchLastUsed('t1', '1.2.3.0');
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('touchLastUsed：达到 60 秒时更新最近使用时间和 IP', async () => {
    const now = 1_700_000_100_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    repo.findOne.mockResolvedValue(makeToken({ lastUsedAt: now - 60_000 }));
    try {
      await service.touchLastUsed('t1', '1.2.3.0');
    } finally {
      nowSpy.mockRestore();
    }

    expect(repo.update).toHaveBeenCalledWith(
      { id: 't1' },
      { lastUsedAt: now, lastUsedIp: '1.2.3.0' },
    );
  });
});
