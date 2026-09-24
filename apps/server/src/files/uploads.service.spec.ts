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

describe('UploadsService', () => {
  let service: UploadsService;

  const mockUploadsRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    findOneByOrFail: jest.fn(),
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

  // owner 抢占并发与 completeUpload 恢复契约：以 fake queryRunner（内存 Map 模拟 SQL 语义 + writeLock 互斥）
  // 在 Task 13 E2E 中用真实 SQLite 验证（此处占位结构，防误标 Expected: PASS）。
  describe('uploadPart owner 抢占并发（结构占位，E2E 覆盖）', () => {
    it.todo('同 checksum 并发：先到者 ready，后到者幂等 already_ready');
    it.todo('不同 checksum 并发：先到者 ready，后到者 409 且不删任何文件');
    it.todo('receiving 中他 owner：409 PART_BEING_RECEIVED');
  });
});
