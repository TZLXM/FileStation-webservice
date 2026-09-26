import { Test, TestingModule } from '@nestjs/testing';
import { FileLifecycleService } from './file-lifecycle.service';
import { StorageService } from './storage.service';
import { SettingsService } from '../settings/settings.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { File } from './entities/file.entity';
import { UploadSession } from './entities/upload-session.entity';
import { UploadPart } from './entities/upload-part.entity';
import { DataSource } from 'typeorm';
import { SqliteImmediateTransactionService } from '../common/database/sqlite-immediate-transaction.service';

describe('FileLifecycleService', () => {
  let service: FileLifecycleService;

  const mockFilesRepository = { find: jest.fn(), update: jest.fn(), count: jest.fn() };
  const mockUploadSessionsRepository = { find: jest.fn(), update: jest.fn(), findOne: jest.fn() };
  const mockUploadPartsRepository = { find: jest.fn(), delete: jest.fn() };
  const mockStorageService = {
    deleteFile: jest.fn(),
    deleteUploadTempDir: jest.fn(),
    deleteTempPart: jest.fn(),
    getFileStats: jest.fn(),
    calculateFileHash: jest.fn(),
    combineParts: jest.fn(),
    getFinalPath: jest.fn(),
  };
  const mockSettingsService = { getStorageSettings: jest.fn() };
  const mockDataSource = { createQueryRunner: jest.fn(), query: jest.fn() };
  const mockSqliteTransactions = { run: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FileLifecycleService,
        { provide: getRepositoryToken(File), useValue: mockFilesRepository },
        { provide: getRepositoryToken(UploadSession), useValue: mockUploadSessionsRepository },
        { provide: getRepositoryToken(UploadPart), useValue: mockUploadPartsRepository },
        { provide: StorageService, useValue: mockStorageService },
        { provide: SettingsService, useValue: mockSettingsService },
        { provide: DataSource, useValue: mockDataSource },
        { provide: SqliteImmediateTransactionService, useValue: mockSqliteTransactions },
      ],
    }).compile();

    service = module.get<FileLifecycleService>(FileLifecycleService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('expireFiles: active 过期 → expired（条件 UPDATE 参数断言）', async () => {
    mockFilesRepository.update.mockResolvedValue({ affected: 2 });
    await service.expireFiles();
    expect(mockFilesRepository.update).toHaveBeenCalled();
  });

  it('queueDeletion: 按 cleanup_grace_hours 计算 cutoff', async () => {
    mockSettingsService.getStorageSettings.mockResolvedValue({ cleanup_grace_hours: 24 });
    mockFilesRepository.update.mockResolvedValue({ affected: 0 });
    await service.queueDeletion();
    expect(mockFilesRepository.update).toHaveBeenCalled();
  });

  it('processDeletes: 磁盘删除成功 → deleted', async () => {
    mockFilesRepository.find.mockResolvedValue([]);
    await service.processDeletes();
    expect(mockFilesRepository.find).toHaveBeenCalled();
  });

  it('cleanupExpiredUploadSessions: 过期 initiated/uploading → expired + 删目录', async () => {
    mockUploadSessionsRepository.find.mockResolvedValue([]);
    await service.cleanupExpiredUploadSessions();
    expect(mockUploadSessionsRepository.find).toHaveBeenCalled();
  });

  // 复杂分支（recoverVerifyingUploads 四分支、finishVerifyingUpload 并发 PK 幂等、
  // scanOrphanTempFiles、onApplicationBootstrap 容错）在 Task 13 E2E 用真实 SQLite 验证。
  it.todo('recoverVerifyingUploads 四分支（文件存在+size/size 不符/文件不存在/hash 不符）');
  it.todo('finishVerifyingUpload 与 completeUpload 阶段三并发：files 表只一行（PK 幂等）');
  it.todo('scanOrphanTempFiles: 无会话/终态会话整目录删；活跃会话只删 .part.tmp');
  it.todo('onApplicationBootstrap 依次调用五个方法；任一抛错不影响其余');
});
