import { Test, TestingModule } from '@nestjs/testing';
import { UploadsService } from './uploads.service';
import { StorageService } from './storage.service';
import { SettingsService } from '../settings/settings.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UploadSession } from './entities/upload-session.entity';
import { UploadPart } from './entities/upload-part.entity';
import { File } from './entities/file.entity';
import { Folder } from '../folders/entities/folder.entity';
import { DataSource } from 'typeorm';
import { SqliteImmediateTransactionService } from '../common/database/sqlite-immediate-transaction.service';

describe('UploadsService', () => {
  let service: UploadsService;

  const mockUploadsRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    findOneByOrFail: jest.fn(),
    findOneBy: jest.fn(),
    update: jest.fn(),
    increment: jest.fn(),
  };
  const mockPartsRepository = { create: jest.fn(), save: jest.fn(), find: jest.fn(), findOne: jest.fn() };
  const mockFilesRepository = { create: jest.fn(), save: jest.fn() };
  const mockFoldersRepository = { findOne: jest.fn() };
  const mockStorageService = {
    createUploadTempDir: jest.fn(),
    writePartToTemp: jest.fn(),
    renamePart: jest.fn(),
    deleteTempPart: jest.fn(),
    getUploadTempDir: jest.fn(),
    getPartTempPath: jest.fn(),
    getPartPath: jest.fn(),
    generateStoredName: jest.fn(),
    getFinalPath: jest.fn(),
    combineParts: jest.fn(),
    calculateFileHash: jest.fn(),
    deleteFile: jest.fn(),
    deleteUploadTempDir: jest.fn(),
  };
  const mockSettingsService = {
    getTransferSettings: jest.fn(),
    getStorageSettings: jest.fn(),
  };
  const mockDataSource = {
    createQueryRunner: jest.fn(),
    query: jest.fn(),
    transaction: jest.fn(),
  };
  const mockSqliteTransactions = { run: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UploadsService,
        { provide: getRepositoryToken(UploadSession), useValue: mockUploadsRepository },
        { provide: getRepositoryToken(UploadPart), useValue: mockPartsRepository },
        { provide: getRepositoryToken(File), useValue: mockFilesRepository },
        { provide: getRepositoryToken(Folder), useValue: mockFoldersRepository },
        { provide: StorageService, useValue: mockStorageService },
        { provide: SettingsService, useValue: mockSettingsService },
        { provide: DataSource, useValue: mockDataSource },
        { provide: SqliteImmediateTransactionService, useValue: mockSqliteTransactions },
      ],
    }).compile();

    service = module.get<UploadsService>(UploadsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('initializeUpload', () => {
    it('should create upload session with complete entity shape (数字 expiresAt)', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      mockStorageService.getUploadTempDir.mockReturnValue('/tmp/test-upload');
      mockSettingsService.getTransferSettings.mockResolvedValue({ default_chunk_size: 8 * 1024 * 1024 });

      // v1.6 修正：create mock 返回完整 session（实现随后读 session.expiresAt）
      const fullSession = {
        id: 'uuid-1', filename: 'test.txt', expectedSize: 1024, chunkSize: 8 * 1024 * 1024,
        status: 'initiated', receivedSize: 0, expiresAt: now + 24 * 60 * 60 * 1000,
      };
      mockUploadsRepository.create.mockReturnValue(fullSession);
      mockUploadsRepository.save.mockResolvedValue(fullSession);

      const result = await service.initializeUpload({ filename: 'test.txt', size: 1024 }, 'admin', 'user-id');

      expect(result.chunk_size).toBe(8 * 1024 * 1024);
      expect(result.expires_at).toBe(new Date(fullSession.expiresAt).toISOString());
      expect(() => Date.parse(result.expires_at)).not.toThrow();
      (Date.now as jest.Mock).mockRestore();
    });

    it('should use dto.chunk_size when provided (override default)', async () => {
      mockStorageService.getUploadTempDir.mockReturnValue('/tmp/test-upload');
      mockSettingsService.getTransferSettings.mockResolvedValue({ default_chunk_size: 8 * 1024 * 1024 });
      const fullSession = { id: 'uuid-2', chunkSize: 128 * 1024, expiresAt: Date.now() + 1000 };
      mockUploadsRepository.create.mockReturnValue(fullSession);
      mockUploadsRepository.save.mockResolvedValue(fullSession);

      const result = await service.initializeUpload({ filename: 'a.bin', size: 1024, chunk_size: 128 * 1024 }, 'admin', 'user-id');
      expect(result.chunk_size).toBe(128 * 1024);
    });
  });

  describe('completeUpload audit metadata', () => {
    it('returns filename and size internally for completion auditing', async () => {
      jest.spyOn(service as any, 'validateUploadToken').mockResolvedValue({
        status: 'completed',
        finalFileId: 'file-1',
        filename: 'report.pdf',
        expectedSize: 4096,
      });

      const result = await service.completeUpload('upload-1', 'upload-token');

      expect(result).toEqual({ file_id: 'file-1', filename: 'report.pdf', size: 4096 });
    });
  });

  describe('completeUpload finalization observer', () => {
    const verifyingSession = {
      id: 'upload-observed',
      status: 'verifying',
      verifyStartedAt: Date.now(),
      verifyLeaseUntil: Date.now() + 10_000,
    };

    it('shares one poller and cancels an individual waiter and on module destroy', async () => {
      mockUploadsRepository.findOneBy.mockResolvedValue(verifyingSession);
      const requestAbort = new AbortController();
      const first = (service as any).waitForFinalizedUpload('upload-observed', verifyingSession, requestAbort.signal);
      const second = (service as any).waitForFinalizedUpload('upload-observed', verifyingSession);

      expect(service['finalizationObservers'].get('upload-observed')!.waiters).toBe(2);
      expect(mockUploadsRepository.findOneBy).toHaveBeenCalledTimes(1);

      requestAbort.abort();
      await expect(first).rejects.toMatchObject({ name: 'AbortError' });
      expect(service['finalizationObservers'].get('upload-observed')!.waiters).toBe(1);

      service.onModuleDestroy();
      await expect(second).rejects.toMatchObject({ name: 'AbortError' });
      expect(service['finalizationObservers'].size).toBe(0);
    });

    it('keeps a fixed 15-minute timeout even when the observed lease keeps moving', async () => {
      jest.useFakeTimers({ now: 1_000 });
      mockUploadsRepository.findOneBy.mockImplementation(async () => ({
        ...verifyingSession,
        verifyLeaseUntil: Date.now() + 60 * 60 * 1000,
      }));
      const pending = (service as any).waitForFinalizedUpload('upload-observed', verifyingSession);
      const timeoutExpectation = expect(pending).rejects.toMatchObject({ response: { code: 'UPLOAD_FINALIZING' } });

      try {
        await jest.advanceTimersByTimeAsync(15 * 60 * 1000);
        await timeoutExpectation;
        expect(service['finalizationObservers'].size).toBe(0);
      } finally {
        service.onModuleDestroy();
        jest.useRealTimers();
      }
    });
  });

  describe('part owner transactions', () => {
    it('claims a part through an independent immediate transaction', async () => {
      const connection = {
        get: jest.fn()
          .mockResolvedValueOnce({ status: 'uploading' })
          .mockResolvedValueOnce(undefined),
        run: jest.fn().mockResolvedValue({ changes: 1, lastID: 0 }),
      };
      mockSqliteTransactions.run.mockImplementation(async (work: (db: typeof connection) => Promise<unknown>) => work(connection));

      const outcome = await (service as any).claimPart('upload-1', 0, {
        offset: 0,
        size: 16,
        checksum: 'checksum',
        ownerToken: 'owner-token',
        tempName: 'part.tmp',
        now: Date.now(),
      });

      expect(outcome).toEqual({ outcome: 'claimed' });
      expect(mockSqliteTransactions.run).toHaveBeenCalledTimes(1);
      expect(connection.run).toHaveBeenCalledTimes(2);
      expect(mockDataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('increments received_size only when the owner-guarded ready transition changed one row', async () => {
      const connection = {
        get: jest.fn(),
        run: jest.fn()
          .mockResolvedValueOnce({ changes: 1, lastID: 0 })
          .mockResolvedValueOnce({ changes: 1, lastID: 0 }),
      };
      mockSqliteTransactions.run.mockImplementation(async (work: (db: typeof connection) => Promise<unknown>) => work(connection));

      await (service as any).confirmPartReady('upload-1', 0, 'owner-token', 16);

      expect(mockSqliteTransactions.run).toHaveBeenCalledTimes(1);
      expect(connection.run).toHaveBeenCalledTimes(2);
      expect(connection.run.mock.calls[0][0]).toContain("status = 'ready'");
      expect(connection.run.mock.calls[1][0]).toContain('received_size = received_size + ?');
      expect(mockDataSource.createQueryRunner).not.toHaveBeenCalled();

      connection.run.mockReset().mockResolvedValue({ changes: 0, lastID: 0 });
      await expect((service as any).confirmPartReady('upload-1', 0, 'stale-owner', 16))
        .rejects.toMatchObject({ response: { code: 'PART_CLAIM_LOST' } });
      expect(connection.run).toHaveBeenCalledTimes(1);
    });
  });

  // owner 抢占并发与 completeUpload 恢复契约：以 fake queryRunner（内存 Map 模拟 SQL 语义 + writeLock 互斥）
  // 在 Task 13 E2E 中用真实 SQLite 验证（此处占位结构，防误标 Expected: PASS）。
  describe('uploadPart owner 抢占并发（结构占位，E2E 覆盖）', () => {
    it.todo('同 checksum 并发：先到者 ready，后到者幂等 already_ready');
    it.todo('不同 checksum 并发：先到者 ready，后到者 409 且不删任何文件');
    it.todo('receiving 中他 owner：409 PART_BEING_RECEIVED');
  });
});
