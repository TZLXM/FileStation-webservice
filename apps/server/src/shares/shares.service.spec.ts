import { Test, TestingModule } from '@nestjs/testing';
import { SharesService } from './shares.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Share } from './entities/share.entity';
import { DownloadSession } from './entities/download-session.entity';
import { File } from '../files/entities/file.entity';
import { DataSource } from 'typeorm';

describe('SharesService', () => {
  let service: SharesService;

  const mockSharesRepository = { create: jest.fn(), save: jest.fn(), find: jest.fn(), findOne: jest.fn(), createQueryBuilder: jest.fn() };
  const mockDownloadSessionsRepository = { create: jest.fn(), save: jest.fn(), findOne: jest.fn() };
  const mockFilesRepository = { findOne: jest.fn() };
  const mockDataSource = { createQueryRunner: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SharesService,
        { provide: getRepositoryToken(Share), useValue: mockSharesRepository },
        { provide: getRepositoryToken(DownloadSession), useValue: mockDownloadSessionsRepository },
        { provide: getRepositoryToken(File), useValue: mockFilesRepository },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<SharesService>(SharesService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('lists the newest 200 shares when no file filter is supplied', async () => {
    const shares = [{ id: 'share-1' }] as Share[];
    mockSharesRepository.find.mockResolvedValue(shares);

    const result = await service.findAll();

    expect(result).toBe(shares);
    expect(mockSharesRepository.find).toHaveBeenCalledWith({ order: { createdAt: 'DESC' }, take: 200 });
  });

  // accessShare（统一端点）与 validateAuthorizedDownload（四层复验）、票据语义：
  // 在 Task 13 E2E 用真实 SQLite 验证（含密码失败计数、share 吊销后票据失效、Range 连续计数）。
  describe('accessShare（统一端点）', () => {
    it.todo('免密分享：忽略 password 直接放行');
    it.todo('密码分享：无 password → 400 PASSWORD_REQUIRED');
    it.todo('密码分享：错误密码 → 400 INVALID_PASSWORD + 记录失败计数');
    it.todo('密码分享：连续 5 错 → SHARE_LOCKED（第 6 次直接拒绝）');
    it.todo('密码分享：正确密码 → 清除失败计数');
  });

  describe('validateAuthorizedDownload（四层复验）', () => {
    it.todo('session.shareId !== 路由 shareId → 403 SESSION_SHARE_MISMATCH');
    it.todo('session 过期 → 410 TOKEN_EXPIRED');
    it.todo('share 吊销 → 410 SHARE_REVOKED（票据创建后吊销也失效）');
    it.todo('share 过期 → 410 SHARE_EXPIRED');
    it.todo('file 非 active → 410 FILE_UNAVAILABLE');
  });

  describe('票据语义', () => {
    it.todo('同一 ticket 连续两个不同 Range 请求均 206，used_downloads 只 +1');
    it.todo('countDownload 顺序：先 download_sessions.counted，后 shares.used_downloads');
    it.todo('shares UPDATE affected=0（吊销/用尽）→ 回滚抛 SHARE_EXHAUSTED');
  });
});
