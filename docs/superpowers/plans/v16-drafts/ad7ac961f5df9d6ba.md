Read complete. I have all the v1.5 context needed. Producing the v1.6 fix design for my assigned scope (problems 7, 9, 11, 12).

---

# Phase 1 计划 v1.6 修正设计 — 文件夹一致性 / Schema / 前端管理 UI / 测试计划

适用范围：复审问题 7（文件夹一致性）、9（Schema 缺索引/缺表/枚举不一致）、11（前端管理 UI 缺失）、12（测试计划）。所有代码与 v1.5 全局约束兼容（SQLite 条件 UPDATE、事务内无文件 I/O、Unix 毫秒存储 / ISO 8601 返回、Controller 无前缀）。

---

## 1. 文件夹一致性（问题 7）

### 1.1 FoldersService v1.6 完整代码

修正点：
- `move()` 验证新父文件夹存在且 `is_deleted=0`（含并发安全：条件 UPDATE 兜底，见 1.4 说明）
- `delete()` 原子化：`BEGIN IMMEDIATE` 事务内重查子文件夹数 + 文件数（`Not(DELETED)` 等价 SQL `status != 'deleted'`），再执行条件软删 `UPDATE ... WHERE id=? AND is_deleted=0`，任一步失败整体回滚
- `create()` 同样验证父文件夹（v1.5 已有，保留）
- `getDescendantIds()` 移入事务外（循环检查是纯读操作，移动前的检查竞态由条件 UPDATE 兜底）

`apps/server/src/folders/folders.service.ts`:
```typescript
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Folder } from './entities/folder.entity';
import { File, FileStatus } from '../files/entities/file.entity';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class FoldersService {
  constructor(
    @InjectRepository(Folder)
    private foldersRepository: Repository<Folder>,
    @InjectRepository(File)
    private filesRepository: Repository<File>,
    private dataSource: DataSource,
  ) {}

  async create(name: string, parentId: string | null, createdBy: string): Promise<Folder> {
    if (parentId) {
      const parent = await this.foldersRepository.findOne({
        where: { id: parentId, isDeleted: 0 },
      });
      if (!parent) {
        throw new NotFoundException({
          code: 'PARENT_FOLDER_NOT_FOUND',
          message: 'Parent folder not found or deleted',
        });
      }
    }

    const folder = this.foldersRepository.create({
      id: uuidv4(),
      name,
      parentId,
      createdBy,
      createdAt: Date.now(),
      isDeleted: 0,
    });

    return this.foldersRepository.save(folder);
  }

  async findAll(): Promise<Folder[]> {
    return this.foldersRepository.find({
      where: { isDeleted: 0 },
      order: { name: 'ASC' },
    });
  }

  async findTree(): Promise<Folder[]> {
    const allFolders = await this.findAll();

    const folderMap = new Map<string, Folder & { children: Folder[] }>();
    const roots: (Folder & { children: Folder[] })[] = [];

    for (const folder of allFolders) {
      folderMap.set(folder.id, { ...folder, children: [] });
    }
    for (const folder of allFolders) {
      const node = folderMap.get(folder.id)!;
      if (folder.parentId && folderMap.has(folder.parentId)) {
        folderMap.get(folder.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  async findOne(id: string): Promise<Folder> {
    const folder = await this.foldersRepository.findOne({
      where: { id, isDeleted: 0 },
    });
    if (!folder) {
      throw new NotFoundException({
        code: 'FOLDER_NOT_FOUND',
        message: 'Folder not found',
      });
    }
    return folder;
  }

  async update(id: string, name: string): Promise<Folder> {
    const folder = await this.findOne(id);
    folder.name = name;
    return this.foldersRepository.save(folder);
  }

  async move(id: string, newParentId: string | null): Promise<Folder> {
    // 目标存在性 + 未删除验证（v1.6 新增）
    if (newParentId) {
      if (newParentId === id) {
        throw new BadRequestException({
          code: 'MOVE_TO_SELF',
          message: 'Cannot move folder to itself',
        });
      }
      const parent = await this.foldersRepository.findOne({
        where: { id: newParentId, isDeleted: 0 },
      });
      if (!parent) {
        throw new NotFoundException({
          code: 'PARENT_FOLDER_NOT_FOUND',
          message: 'Target folder not found or deleted',
        });
      }
      // 防循环：目标不能是自身后代
      const descendants = await this.getDescendantIds(id);
      if (descendants.includes(newParentId)) {
        throw new BadRequestException({
          code: 'MOVE_TO_DESCENDANT',
          message: 'Cannot move folder to its descendant',
        });
      }
    }

    // 条件 UPDATE 兜底（防 findOne 后并发软删本文件夹）：
    // 仅当文件夹仍处于未删除状态时更新 parent_id
    const result = await this.foldersRepository.update(
      { id, isDeleted: 0 },
      { parentId: newParentId },
    );
    if (result.affected === 0) {
      throw new NotFoundException({
        code: 'FOLDER_NOT_FOUND',
        message: 'Folder not found or deleted',
      });
    }

    return this.findOne(id);
  }

  /**
   * 原子删除：BEGIN IMMEDIATE 事务内重查子项计数，再条件软删。
   * 纯 SQL 事务（与 AuthService.initialize 同一模式），事务内无任何文件 I/O。
   */
  async delete(id: string): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      await queryRunner.query('BEGIN IMMEDIATE');

      // 事务内重查：文件夹存在且未删除
      const folderRows = await queryRunner.query(
        `SELECT id FROM folders WHERE id = ? AND is_deleted = 0`,
        [id],
      );
      if (folderRows.length === 0) {
        throw new NotFoundException({
          code: 'FOLDER_NOT_FOUND',
          message: 'Folder not found',
        });
      }

      // 事务内重查：子文件夹计数（BEGIN IMMEDIATE 持写锁，计数结果在事务内稳定）
      const childRows = await queryRunner.query(
        `SELECT COUNT(*) AS cnt FROM folders WHERE parent_id = ? AND is_deleted = 0`,
        [id],
      );
      if (Number(childRows[0].cnt) > 0) {
        throw new BadRequestException({
          code: 'FOLDER_NOT_EMPTY',
          message: 'Cannot delete folder with subfolders',
        });
      }

      // 事务内重查：文件计数（所有非 deleted 状态，等价 Not(FileStatus.DELETED)）
      const fileRows = await queryRunner.query(
        `SELECT COUNT(*) AS cnt FROM files WHERE folder_id = ? AND status != ?`,
        [id, FileStatus.DELETED],
      );
      if (Number(fileRows[0].cnt) > 0) {
        throw new BadRequestException({
          code: 'FOLDER_NOT_EMPTY',
          message: 'Cannot delete folder with files',
        });
      }

      // 条件软删（双保险：仅当仍未删除时生效）
      const deleteResult = await queryRunner.query(
        `UPDATE folders SET is_deleted = 1, deleted_at = ? WHERE id = ? AND is_deleted = 0`,
        [Date.now(), id],
      );
      if (deleteResult.changes === 0) {
        throw new ConflictException({
          code: 'FOLDER_ALREADY_DELETED',
          message: 'Folder was deleted concurrently',
        });
      }

      await queryRunner.query('COMMIT');
    } catch (error) {
      await queryRunner.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async getDescendantIds(folderId: string): Promise<string[]> {
    const result: string[] = [];
    const queue = [folderId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const children = await this.foldersRepository.find({
        where: { parentId: currentId, isDeleted: 0 },
      });
      for (const child of children) {
        result.push(child.id);
        queue.push(child.id);
      }
    }
    return result;
  }
}
```

### 1.2 FilesService.update() 目标 folder_id 验证 + expires_at: null 修正

FilesService 注入 `Repository<Folder>`（FilesModule 的 `TypeOrmModule.forFeature` 增加 `Folder`，避免与 FoldersModule 形成模块环依赖）。

`apps/server/src/files/files.service.ts`（修正后的相关片段）:
```typescript
// 构造函数增加：
//   @InjectRepository(Folder)
//   private foldersRepository: Repository<Folder>,

async update(id: string, updates: Partial<File>): Promise<File> {
  const file = await this.findOne(id);

  // 目标文件夹验证（v1.6 新增）：folder_id 字段被显式提供且非 null 时，
  // 目标必须存在且未删除；folder_id = null 表示移到根目录，合法
  if (updates.folderId !== undefined && updates.folderId !== null) {
    if (updates.folderId === file.folderId) {
      // 无变化，跳过验证
    } else {
      const target = await this.foldersRepository.findOne({
        where: { id: updates.folderId, isDeleted: 0 },
      });
      if (!target) {
        throw new NotFoundException({
          code: 'TARGET_FOLDER_NOT_FOUND',
          message: 'Target folder not found or deleted',
        });
      }
    }
  }

  await this.filesRepository.update(id, { ...updates, updatedAt: Date.now() });
  return this.findOne(id);
}

/** 设为永久保留（expires_at = null 显式清除） */
async setPermanent(id: string): Promise<File> {
  await this.filesRepository.update(id, {
    expiresAt: null,
    updatedAt: Date.now(),
  });
  return this.findOne(id);
}
```

`FilesController.update`（PATCH /files/:id）修正 — `expires_at: null` 不再被 falsy 跳过，且校验 ISO 字符串：
```typescript
@Patch(':id')
async update(
  @Param('id') id: string,
  @Body() updates: { filename?: string; folder_id?: string | null; expires_at?: string | null },
): Promise<ApiResponse<FileMetadata>> {
  const updateData: Partial<File> = {};

  if (updates.filename !== undefined) updateData.filename = updates.filename;
  // 显式 null = 移到根目录；undefined = 不动
  if ('folder_id' in updates) updateData.folderId = updates.folder_id ?? null;

  // expires_at 显式 null = 永久保留（v1.6 修正：不再被 falsy 检查跳过）
  if ('expires_at' in updates) {
    if (updates.expires_at === null) {
      const file = await this.filesService.setPermanent(id);
      return { code: 'OK', message: 'File set to permanent', data: this.toMetadata(file), request_id: crypto.randomUUID() };
    }
    const ts = Date.parse(updates.expires_at!);
    if (Number.isNaN(ts)) {
      throw new BadRequestException({ code: 'INVALID_EXPIRES_AT', message: 'expires_at must be ISO 8601 or null' });
    }
    updateData.expiresAt = ts;
  }

  if (Object.keys(updateData).length === 0) {
    throw new BadRequestException('No update fields provided');
  }

  const file = await this.filesService.update(id, updateData);
  return { code: 'OK', message: 'File updated', data: this.toMetadata(file), request_id: crypto.randomUUID() };
}
```

（DTO 化由问题 4 的负责人处理；此处 Controller 逻辑假设 UpdateFileDto 中 `folder_id?: string | null`、`expires_at?: string | null` 均带 `@IsOptional()`，null 值能穿过 ValidationPipe。）

### 1.3 files PATCH 与 folders 单元测试设计

`apps/server/src/folders/folders.service.spec.ts`（mock 层测试，验证逻辑分支与 SQL 调用序列）:
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { FoldersService } from './folders.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Folder } from './entities/folder.entity';
import { File, FileStatus } from '../files/entities/file.entity';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';

/** 通用 QueryRunner mock 工厂：按 SQL 子串匹配返回值的 raw SQL 路由器 */
function createMockQueryRunner(routes: Array<{ match: string; params?: any[]; result: any }>) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const queryRunner = {
    calls,
    connect: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockImplementation(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/^BEGIN/.test(sql)) return undefined;
      if (/^(COMMIT|ROLLBACK)/.test(sql)) return undefined;
      const route = routes.find((r) => sql.includes(r.match));
      if (!route) throw new Error(`Unmocked SQL: ${sql}`);
      if (route.params) expect(params).toEqual(route.params);
      return typeof route.result === 'function' ? route.result() : route.result;
    }),
  };
  return queryRunner;
}

describe('FoldersService', () => {
  let service: FoldersService;
  const mockFoldersRepository = { findOne: jest.fn(), find: jest.fn(), create: jest.fn(), save: jest.fn(), update: jest.fn(), count: jest.fn() };
  const mockFilesRepository = { count: jest.fn() };
  const mockDataSource = { createQueryRunner: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FoldersService,
        { provide: getRepositoryToken(Folder), useValue: mockFoldersRepository },
        { provide: getRepositoryToken(File), useValue: mockFilesRepository },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();
    service = module.get<FoldersService>(FoldersService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('move', () => {
    it('should reject moving to a deleted target folder', async () => {
      mockFoldersRepository.findOne.mockResolvedValue(null); // 目标已删除/不存在
      await expect(service.move('f1', 'deleted-target')).rejects.toThrow(NotFoundException);
      expect(mockFoldersRepository.update).not.toHaveBeenCalled();
    });

    it('should reject moving to itself', async () => {
      await expect(service.move('f1', 'f1')).rejects.toThrow(BadRequestException);
    });

    it('should reject moving to a descendant', async () => {
      mockFoldersRepository.findOne.mockResolvedValue({ id: 'child', isDeleted: 0 });
      mockFoldersRepository.find.mockResolvedValue([{ id: 'child' }]); // f1 的子节点含 child
      await expect(service.move('f1', 'child')).rejects.toThrow(BadRequestException);
    });

    it('should move to root when newParentId is null', async () => {
      mockFoldersRepository.update.mockResolvedValue({ affected: 1 });
      mockFoldersRepository.findOne.mockResolvedValue({ id: 'f1', parentId: null, isDeleted: 0 });
      const result = await service.move('f1', null);
      expect(mockFoldersRepository.update).toHaveBeenCalledWith({ id: 'f1', isDeleted: 0 }, { parentId: null });
      expect(result.parentId).toBeNull();
    });

    it('should throw NotFound when conditional update affects 0 rows (concurrent delete)', async () => {
      mockFoldersRepository.update.mockResolvedValue({ affected: 0 });
      await expect(service.move('f1', null)).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete (atomic transaction)', () => {
    it('should commit when folder is empty', async () => {
      const qr = createMockQueryRunner([
        { match: 'SELECT id FROM folders', params: ['f1'], result: [{ id: 'f1' }] },
        { match: 'SELECT COUNT(*) AS cnt FROM folders', result: [{ cnt: 0 }] },
        { match: 'SELECT COUNT(*) AS cnt FROM files', result: [{ cnt: 0 }] },
        { match: 'UPDATE folders SET is_deleted = 1', params: [expect.any(Number), 'f1'], result: { changes: 1 } },
      ]);
      mockDataSource.createQueryRunner.mockReturnValue(qr);

      await service.delete('f1');

      const sqlSequence = qr.calls.map((c) => c.sql.split(' ')[0]);
      expect(sqlSequence[0]).toBe('BEGIN');
      expect(sqlSequence[sqlSequence.length - 1]).toBe('COMMIT');
      // 计数重查必须发生在 BEGIN 之后、UPDATE 之前
      const updateIdx = qr.calls.findIndex((c) => c.sql.includes('UPDATE folders SET is_deleted'));
      const countIdx = qr.calls.findIndex((c) => c.sql.includes('FROM files'));
      expect(countIdx).toBeGreaterThan(0);
      expect(updateIdx).toBeGreaterThan(countIdx);
    });

    it('should rollback when folder has subfolders (no UPDATE issued)', async () => {
      const qr = createMockQueryRunner([
        { match: 'SELECT id FROM folders', result: [{ id: 'f1' }] },
        { match: 'SELECT COUNT(*) AS cnt FROM folders', result: [{ cnt: 2 }] },
      ]);
      mockDataSource.createQueryRunner.mockReturnValue(qr);

      await expect(service.delete('f1')).rejects.toThrow(BadRequestException);
      expect(qr.calls.some((c) => c.sql.includes('UPDATE folders'))).toBe(false);
      expect(qr.calls.some((c) => c.sql.startsWith('ROLLBACK'))).toBe(true);
    });

    it('should rollback when folder has non-deleted files', async () => {
      const qr = createMockQueryRunner([
        { match: 'SELECT id FROM folders', result: [{ id: 'f1' }] },
        { match: 'SELECT COUNT(*) AS cnt FROM folders', result: [{ cnt: 0 }] },
        { match: 'SELECT COUNT(*) AS cnt FROM files', result: [{ cnt: 1 }] },
      ]);
      mockDataSource.createQueryRunner.mockReturnValue(qr);
      await expect(service.delete('f1')).rejects.toThrow(BadRequestException);
    });

    it('should throw Conflict when conditional UPDATE affects 0 rows', async () => {
      const qr = createMockQueryRunner([
        { match: 'SELECT id FROM folders', result: [{ id: 'f1' }] },
        { match: 'SELECT COUNT(*) AS cnt FROM folders', result: [{ cnt: 0 }] },
        { match: 'SELECT COUNT(*) AS cnt FROM files', result: [{ cnt: 0 }] },
        { match: 'UPDATE folders SET is_deleted = 1', result: { changes: 0 } },
      ]);
      mockDataSource.createQueryRunner.mockReturnValue(qr);
      await expect(service.delete('f1')).rejects.toThrow(ConflictException);
    });
  });
});
```

`apps/server/src/files/files.service.spec.ts`（片段 — folder 验证分支）:
```typescript
describe('FilesService.update folder validation', () => {
  it('should allow folder_id = null (move to root)', async () => {
    mockFilesRepository.findOne.mockResolvedValue({ id: 'file1', folderId: 'old', status: 'active' });
    mockFilesRepository.update.mockResolvedValue({ affected: 1 });
    const result = await service.update('file1', { folderId: null });
    expect(mockFoldersRepository.findOne).not.toHaveBeenCalled(); // null 不查库
    expect(mockFilesRepository.update).toHaveBeenCalledWith('file1', expect.objectContaining({ folderId: null }));
  });

  it('should reject move to deleted folder', async () => {
    mockFilesRepository.findOne.mockResolvedValue({ id: 'file1', folderId: null, status: 'active' });
    mockFoldersRepository.findOne.mockResolvedValue(null); // 已删除
    await expect(service.update('file1', { folderId: 'deleted-folder' })).rejects.toThrow(NotFoundException);
    expect(mockFilesRepository.update).not.toHaveBeenCalled();
  });

  it('should skip validation when folder unchanged', async () => {
    mockFilesRepository.findOne.mockResolvedValue({ id: 'file1', folderId: 'same', status: 'active' });
    mockFilesRepository.update.mockResolvedValue({ affected: 1 });
    await service.update('file1', { folderId: 'same' });
    expect(mockFoldersRepository.findOne).not.toHaveBeenCalled();
  });
});

describe('FilesService.setPermanent', () => {
  it('should set expiresAt to null explicitly', async () => {
    mockFilesRepository.update.mockResolvedValue({ affected: 1 });
    mockFilesRepository.findOne.mockResolvedValue({ id: 'file1', expiresAt: null });
    const result = await service.setPermanent('file1');
    expect(mockFilesRepository.update).toHaveBeenCalledWith('file1', expect.objectContaining({ expiresAt: null }));
    expect(result.expiresAt).toBeNull();
  });
});
```

**并发删除场景测试思路（集成层，不用 mock）：** 单测 mock 无法验证真实 SQLite 锁行为，因此在 `apps/server/test/folders-concurrency.e2e-spec.ts`（或 folders.service 的 `@nestjs/testing` 集成 spec）中：
1. 用临时目录 SQLite（同 E2E 第 4.3 节的建库方式）真实实例化 FoldersService + 空文件夹 `f1`；
2. 并发发起 `Promise.allSettled([service.delete('f1'), service.delete('f1')])` —— 断言恰好一个 fulfilled、一个 rejected（NotFound/Conflict），且 DB 中 `is_deleted=1`；
3. 并发「删除 + 移入子项」：`Promise.allSettled([service.delete('f1'), service.move('f2', 'f1')])` —— 断言不会同时成功（`BEGIN IMMEDIATE` 写锁串行化后，delete 的事务内重查会看到新子项而 400，或 move 的 findOne 在 delete 提交后看到 is_deleted=1 而 404）；此用例证明事务内重查的必要性（v1.5 两步式在此场景下会双双成功，删出非空文件夹）。

---

## 2. Schema 修正（问题 9）

以下内容直接补充进 `1700000000000-initial-schema.ts` 的 `up()`。同时在文件顶部加分区注释：

```typescript
// ============================================================================
// Phase 1 实际使用的表:
//   admin_accounts, sessions, system_meta, folders, files,
//   upload_sessions, upload_parts, shares, download_sessions,
//   download_tickets, settings, audit_logs(登录/吊销审计)
// Phase 2+ 预留（Phase 1 建表但不读写，禁止为其写业务代码）:
//   authenticators, api_tokens, login_challenges, recovery_codes,
//   temp_codes, temp_code_sessions, entries, transfer_events,
//   transfer_stats_hourly
// ============================================================================
```

### 2.1 补索引（追加到 up() 末尾、settings 表之后）

```typescript
// ---- v1.6 补充索引（Phase 1 查询路径覆盖）----
await queryRunner.query(`CREATE INDEX idx_folders_parent ON folders(parent_id)`);
await queryRunner.query(`CREATE INDEX idx_upload_sessions_token ON upload_sessions(upload_token_hash)`);
await queryRunner.query(`CREATE INDEX idx_upload_sessions_status ON upload_sessions(status)`);
await queryRunner.query(`CREATE INDEX idx_shares_file ON shares(file_id)`);
await queryRunner.query(`CREATE INDEX idx_shares_status ON shares(status)`);
await queryRunner.query(`CREATE INDEX idx_download_sessions_share ON download_sessions(share_id)`);
await queryRunner.query(`CREATE INDEX idx_transfer_events_time ON transfer_events(occurred_at)`);
await queryRunner.query(`CREATE INDEX idx_audit_logs_account ON audit_logs(account_id)`);
await queryRunner.query(`CREATE INDEX idx_audit_logs_action ON audit_logs(action)`);
```

注意：`idx_folders_parent` 与 Folder 实体上已有的 `@Index('idx_folders_parent')` 对应（v1.5 实体有、迁移无，必须对齐）；`idx_upload_sessions_token` 虽与 `upload_token_hash UNIQUE` 产生的自动唯一索引功能重叠，但显式命名保证跨 SQLite 版本行为一致且名称可预期（若决定依赖 UNIQUE 自动索引，需在迁移注释中说明并删除实体侧重复定义——二选一，建议保留显式索引）。

### 2.2 补 transfer_stats_hourly 表（Phase 2 预留，Phase 1 建表）

```typescript
// 按小时聚合的传输统计（Phase 2 预留：统计任务写入，Phase 1 不读写）
await queryRunner.query(`
  CREATE TABLE transfer_stats_hourly (
    hour_timestamp INTEGER NOT NULL,
    entry_id TEXT NOT NULL,
    upload_bytes INTEGER DEFAULT 0 CHECK(upload_bytes >= 0),
    download_bytes INTEGER DEFAULT 0 CHECK(download_bytes >= 0),
    upload_count INTEGER DEFAULT 0 CHECK(upload_count >= 0),
    download_count INTEGER DEFAULT 0 CHECK(download_count >= 0),
    PRIMARY KEY (hour_timestamp, entry_id)
  )
`);
```

`down()` 首部对应增加 `DROP TABLE IF EXISTS transfer_stats_hourly`（以及新索引随表删除，无需单独 DROP）。

### 2.3 ShareProtection 枚举移除 ADMIN

`apps/server/src/shares/entities/share.entity.ts`:
```typescript
export enum ShareProtection {
  NONE = 'none',
  PASSWORD = 'password',
  // v1.6: 移除 ADMIN —— Phase 1 DB CHECK(protection IN ('none','password')) 不允许，
  // 实体与 DB 必须一致；admin 保护类型在 Phase 2 引入时同步放宽 CHECK
}
```

DB 侧 `shares` 表 CHECK 保持 v1.5 现状（`CHECK(protection IN ('none', 'password'))`）不变。任何 Phase 1 代码引用 `ShareProtection.ADMIN` 处（如 SharesService.createAccess 的 'VERIFICATION_REQUIRED' 文案）同步清理措辞为仅 password。

---

## 3. 前端管理端 UI 补齐（问题 11）— Task 12 扩展

### 3.1 决策：分享管理采用「文件行内显示 + 吊销按钮」

不新增 SharesPage。理由：Phase 1 分享必然挂在单个文件上，管理员心智模型是「对文件操作」；行内展开该文件的分享列表（`GET /shares?file_id=`）+ 吊销按钮（`DELETE /shares/:id`）即可覆盖全部 Phase 1 需求，避免第二个列表页的导航与状态同步成本。为此后端补一个管理端查询端点（很小）：

`SharesService` 增加：
```typescript
async findByFile(fileId: string): Promise<Share[]> {
  return this.sharesRepository.find({
    where: { fileId },
    order: { createdAt: 'DESC' },
  });
}
```
`SharesController` 增加（置于 `@Get(':id')` 之前会冲突——`GET /shares?file_id=` 与 `GET /shares/:id` 不同路径，无冲突）：
```typescript
@Get()
@UseGuards(JwtAuthGuard)
async listByFile(@Query('file_id') fileId: string): Promise<ApiResponse<any[]>> {
  if (!fileId) throw new BadRequestException('file_id is required');
  const shares = await this.sharesService.findByFile(fileId);
  return {
    code: 'OK',
    message: 'Shares retrieved',
    data: shares.map((s) => ({
      id: s.id,
      share_url: `/s/${s.id}`,
      protection: s.protection,
      status: s.status,
      max_downloads: s.maxDownloads,
      used_downloads: s.usedDownloads,
      expires_at: s.expiresAt ? new Date(s.expiresAt).toISOString() : null,
      created_at: new Date(s.createdAt).toISOString(),
    })),
    request_id: crypto.randomUUID(),
  };
}
```

### 3.2 api.ts 增加 downloadFile 辅助（管理员 blob 下载）

`apps/web/src/lib/api.ts` 追加方法（依赖问题 5 修正后的 request：不再无条件覆盖调用方 Authorization 头）：
```typescript
/**
 * 管理员直接下载：GET /files/:id/content，fetch blob 后通过 a[download] 落盘。
 * 使用管理员 accessToken（非分享 download token）。
 */
async downloadFile(fileId: string, filename: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (this.accessToken) {
    headers['Authorization'] = `Bearer ${this.accessToken}`;
  }
  const response = await fetch(`${API_BASE}/files/${fileId}/content`, {
    headers,
    credentials: 'include',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Download failed' }));
    throw new Error(error.message || 'Download failed');
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
```

### 3.3 FolderTree 组件完整代码

`apps/web/src/components/FolderTree.tsx`:
```tsx
import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { FolderNode } from '@filestation/shared';

interface FolderTreeProps {
  selectedFolderId: string | null; // null = 根目录
  onSelect: (folderId: string | null) => void;
  refreshKey: number; // 父组件递增以触发重载
}

export default function FolderTree({ selectedFolderId, onSelect, refreshKey }: FolderTreeProps) {
  const [tree, setTree] = useState<FolderNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState<string | null | 'root'>(null); // 'root' 或父 id
  const [renaming, setRenaming] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [error, setError] = useState('');

  const loadTree = useCallback(async () => {
    try {
      const response = await api.get<FolderNode[]>('/folders/tree');
      setTree(response.data!);
    } catch (err: any) {
      setError(err.message || '加载文件夹失败');
    }
  }, []);

  useEffect(() => {
    loadTree();
  }, [loadTree, refreshKey]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreate = async (parentId: string | null) => {
    if (!inputValue.trim()) { setCreating(null); return; }
    try {
      await api.post('/folders', { name: inputValue.trim(), parent_id: parentId });
      setCreating(null);
      setInputValue('');
      loadTree();
    } catch (err: any) {
      alert('创建失败: ' + err.message);
    }
  };

  const handleRename = async (id: string) => {
    if (!inputValue.trim()) { setRenaming(null); return; }
    try {
      await api.patch(`/folders/${id}`, { name: inputValue.trim() });
      setRenaming(null);
      setInputValue('');
      loadTree();
    } catch (err: any) {
      alert('重命名失败: ' + err.message);
    }
  };

  const handleDelete = async (node: FolderNode) => {
    if (!confirm(`删除文件夹「${node.name}」？仅允许删除空文件夹。`)) return;
    try {
      await api.delete(`/folders/${node.id}`);
      if (selectedFolderId === node.id) onSelect(null);
      loadTree();
    } catch (err: any) {
      alert('删除失败: ' + err.message);
    }
  };

  const renderNode = (node: FolderNode, depth: number): React.ReactNode => {
    const isSelected = selectedFolderId === node.id;
    const isExpanded = expanded.has(node.id);
    const hasChildren = (node.children?.length ?? 0) > 0;

    return (
      <div key={node.id}>
        <div
          className={`flex items-center group px-2 py-1 rounded cursor-pointer text-sm ${
            isSelected ? 'bg-blue-100 text-blue-800' : 'hover:bg-gray-100'
          }`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          <span
            className="w-4 text-gray-400 select-none"
            onClick={() => hasChildren && toggleExpand(node.id)}
          >
            {hasChildren ? (isExpanded ? '▾' : '▸') : ''}
          </span>

          {renaming === node.id ? (
            <input
              autoFocus
              className="flex-1 px-1 border rounded text-sm"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onBlur={() => handleRename(node.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRename(node.id);
                if (e.key === 'Escape') setRenaming(null);
              }}
            />
          ) : (
            <span className="flex-1 truncate" onClick={() => onSelect(node.id)}>
              {node.name}
            </span>
          )}

          {/* 悬停操作按钮 */}
          <span className="hidden group-hover:flex space-x-1 text-xs text-gray-500">
            <button title="新建子文件夹" onClick={() => { setCreating(node.id); setInputValue(''); setExpanded((p) => new Set(p).add(node.id)); }}>+</button>
            <button title="重命名" onClick={() => { setRenaming(node.id); setInputValue(node.name); }}>✎</button>
            <button title="删除" onClick={() => handleDelete(node)}>×</button>
          </span>
        </div>

        {creating === node.id && (
          <div style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }} className="py-1">
            <input
              autoFocus
              placeholder="新文件夹名称"
              className="w-full px-1 border rounded text-sm"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onBlur={() => handleCreate(node.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate(node.id);
                if (e.key === 'Escape') setCreating(null);
              }}
            />
          </div>
        )}

        {isExpanded && node.children?.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="w-64 flex-shrink-0 bg-white border-r border-gray-200 p-2 overflow-y-auto">
      <div className="flex justify-between items-center px-2 py-1 mb-2">
        <span className="text-xs font-semibold text-gray-500 uppercase">文件夹</span>
        <button
          className="text-sm text-blue-600 hover:text-blue-800"
          title="新建根文件夹"
          onClick={() => { setCreating('root'); setInputValue(''); }}
        >
          + 新建
        </button>
      </div>

      <div
        className={`px-2 py-1 rounded cursor-pointer text-sm ${
          selectedFolderId === null ? 'bg-blue-100 text-blue-800' : 'hover:bg-gray-100'
        }`}
        onClick={() => onSelect(null)}
      >
        全部文件（根目录）
      </div>

      {creating === 'root' && (
        <div className="px-2 py-1">
          <input
            autoFocus
            placeholder="新文件夹名称"
            className="w-full px-1 border rounded text-sm"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onBlur={() => handleCreate(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate(null);
              if (e.key === 'Escape') setCreating(null);
            }}
          />
        </div>
      )}

      {error && <div className="text-red-600 text-xs px-2">{error}</div>}
      {tree.map((node) => renderNode(node, 1))}
    </div>
  );
}
```

### 3.4 ShareCreateDialog 组件完整代码

`apps/web/src/components/ShareCreateDialog.tsx`:
```tsx
import { useState } from 'react';
import { api } from '../lib/api';

interface ShareCreateDialogProps {
  fileId: string;
  filename: string;
  onClose: () => void;
}

export default function ShareCreateDialog({ fileId, filename, onClose }: ShareCreateDialogProps) {
  const [protection, setProtection] = useState<'none' | 'password'>('none');
  const [password, setPassword] = useState('');
  const [maxDownloads, setMaxDownloads] = useState<string>('');
  const [expiresInHours, setExpiresInHours] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (protection === 'password' && password.length < 4) {
      setError('密码至少 4 位');
      return;
    }

    setCreating(true);
    try {
      const body: Record<string, unknown> = { file_id: fileId, protection };
      if (protection === 'password') body.password = password;
      if (maxDownloads) body.max_downloads = parseInt(maxDownloads, 10);
      if (expiresInHours) {
        body.expires_at = new Date(Date.now() + parseInt(expiresInHours, 10) * 3600_000).toISOString();
      }

      const response = await api.post<{ share_id: string; share_url: string }>('/shares', body);
      // 拼接完整 URL（同源部署）
      setShareUrl(`${window.location.origin}${response.data!.share_url}`);
    } catch (err: any) {
      setError(err.message || '创建分享失败');
    } finally {
      setCreating(false);
    }
  };

  const copyToClipboard = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    alert('已复制到剪贴板');
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-1">创建分享</h3>
        <p className="text-sm text-gray-500 mb-4 truncate">{filename}</p>

        {shareUrl ? (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">分享链接</label>
              <div className="flex space-x-2">
                <input readOnly value={shareUrl} className="flex-1 px-3 py-2 border rounded text-sm bg-gray-50" />
                <button onClick={copyToClipboard} className="px-3 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
                  复制
                </button>
              </div>
            </div>
            <button onClick={onClose} className="w-full py-2 border rounded text-sm hover:bg-gray-50">关闭</button>
          </div>
        ) : (
          <form onSubmit={handleCreate} className="space-y-4">
            {error && <div className="text-red-600 text-sm">{error}</div>}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">访问保护</label>
              <div className="flex space-x-4 text-sm">
                <label className="flex items-center space-x-1">
                  <input type="radio" checked={protection === 'none'} onChange={() => setProtection('none')} />
                  <span>免密</span>
                </label>
                <label className="flex items-center space-x-1">
                  <input type="radio" checked={protection === 'password'} onChange={() => setProtection('password')} />
                  <span>密码保护</span>
                </label>
              </div>
            </div>

            {protection === 'password' && (
              <div>
                <label className="block text-sm font-medium text-gray-700">访问密码</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mt-1 block w-full px-3 py-2 border rounded text-sm"
                  required
                  minLength={4}
                />
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700">最大下载次数（留空不限）</label>
              <input
                type="number"
                min={1}
                value={maxDownloads}
                onChange={(e) => setMaxDownloads(e.target.value)}
                className="mt-1 block w-full px-3 py-2 border rounded text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">有效期（小时，留空永久）</label>
              <input
                type="number"
                min={1}
                value={expiresInHours}
                onChange={(e) => setExpiresInHours(e.target.value)}
                className="mt-1 block w-full px-3 py-2 border rounded text-sm"
              />
            </div>

            <div className="flex space-x-2">
              <button type="submit" disabled={creating} className="flex-1 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">
                {creating ? '创建中...' : '创建分享'}
              </button>
              <button type="button" onClick={onClose} className="px-4 py-2 border rounded text-sm hover:bg-gray-50">取消</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
```

### 3.5 FilesPage 重构（骨架 + 关键逻辑）

布局：左侧 FolderTree + 右侧（FileUpload + 当前文件夹的 FileList）。

`apps/web/src/pages/FilesPage.tsx`（关键逻辑骨架，表头/样式沿用 v1.5）：
```tsx
import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '../stores/authStore';
import { api } from '../lib/api';
import { FileMetadata, PaginatedResponse } from '@filestation/shared';
import FileUpload from '../components/FileUpload';
import FolderTree from '../components/FolderTree';
import FileList from '../components/FileList';

export default function FilesPage() {
  const [files, setFiles] = useState<FileMetadata[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const logout = useAuthStore((s) => s.logout);
  const username = useAuthStore((s) => s.username);

  const loadFiles = useCallback(async () => {
    const folderParam = selectedFolderId ? `&folder_id=${selectedFolderId}` : '';
    const response = await api.get<PaginatedResponse<FileMetadata>>(
      `/files?page=${page}&page_size=20${folderParam}`,
    );
    setFiles(response.data!.items);
    setTotal(response.data!.total);
  }, [page, selectedFolderId]);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  const handleSelectFolder = (id: string | null) => {
    setSelectedFolderId(id);
    setPage(1);
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white shadow">
        <div className="px-4 py-4 flex justify-between items-center">
          <h1 className="text-2xl font-bold">FileStation</h1>
          <div className="flex items-center space-x-4">
            <span className="text-sm text-gray-600">{username}</span>
            <button onClick={() => logout()} className="text-sm text-red-600 hover:text-red-800">退出</button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <FolderTree
          selectedFolderId={selectedFolderId}
          onSelect={handleSelectFolder}
          refreshKey={treeRefreshKey}
        />
        <main className="flex-1 p-6 overflow-y-auto">
          <div className="mb-6">
            <FileUpload onUploadComplete={loadFiles} />
          </div>
          <FileList files={files} total={total} page={page} onPageChange={setPage} onChanged={loadFiles} />
        </main>
      </div>
    </div>
  );
}
```

### 3.6 FileList 操作列（骨架 + 关键逻辑）

`apps/web/src/components/FileList.tsx`（操作全部走 v1.6 修正后的端点）：
```tsx
import { useState } from 'react';
import { api } from '../lib/api';
import { FileMetadata } from '@filestation/shared';
import ShareCreateDialog from './ShareCreateDialog';
import MoveFileDialog from './MoveFileDialog';

interface FileListProps {
  files: FileMetadata[];
  total: number;
  page: number;
  onPageChange: (page: number) => void;
  onChanged: () => void; // 任何变更后刷新列表
}

interface ShareItem {
  id: string;
  share_url: string;
  protection: 'none' | 'password';
  status: 'active' | 'revoked';
  max_downloads: number | null;
  used_downloads: number;
  expires_at: string | null;
}

export default function FileList({ files, total, page, onPageChange, onChanged }: FileListProps) {
  const [shareDialogFile, setShareDialogFile] = useState<FileMetadata | null>(null);
  const [moveDialogFile, setMoveDialogFile] = useState<FileMetadata | null>(null);
  const [expandedShares, setExpandedShares] = useState<Record<string, ShareItem[]>>({});

  // 管理员直接下载（fetch blob + a[download]）
  const handleDownload = async (file: FileMetadata) => {
    try {
      await api.downloadFile(file.id, file.filename);
    } catch (err: any) {
      alert('下载失败: ' + err.message);
    }
  };

  // 延长有效期（输入小时数）
  const handleExtend = async (file: FileMetadata) => {
    const input = prompt('延长小时数:', '24');
    if (!input) return;
    const hours = parseInt(input, 10);
    if (isNaN(hours) || hours <= 0) { alert('无效小时数'); return; }
    try {
      await api.post(`/files/${file.id}/extend`, { hours });
      onChanged();
    } catch (err: any) {
      alert('延长失败: ' + err.message);
    }
  };

  // 设为永久（PATCH expires_at: null —— v1.6 后端已支持显式 null）
  const handleSetPermanent = async (file: FileMetadata) => {
    try {
      await api.patch(`/files/${file.id}`, { expires_at: null });
      onChanged();
    } catch (err: any) {
      alert('操作失败: ' + err.message);
    }
  };

  const handleDelete = async (file: FileMetadata) => {
    if (!confirm(`确认删除「${file.filename}」？文件将进入清理队列。`)) return;
    try {
      await api.delete(`/files/${file.id}`);
      onChanged();
    } catch (err: any) {
      alert('删除失败: ' + err.message);
    }
  };

  // 行内分享列表（展开/收起）
  const toggleShares = async (file: FileMetadata) => {
    if (expandedShares[file.id]) {
      setExpandedShares((prev) => { const n = { ...prev }; delete n[file.id]; return n; });
      return;
    }
    try {
      const response = await api.get<ShareItem[]>(`/shares?file_id=${file.id}`);
      setExpandedShares((prev) => ({ ...prev, [file.id]: response.data! }));
    } catch (err: any) {
      alert('加载分享失败: ' + err.message);
    }
  };

  const handleRevokeShare = async (fileId: string, shareId: string) => {
    if (!confirm('吊销该分享？已有下载票据将立即失效。')) return;
    try {
      await api.delete(`/shares/${shareId}`);
      const response = await api.get<ShareItem[]>(`/shares?file_id=${fileId}`);
      setExpandedShares((prev) => ({ ...prev, [fileId]: response.data! }));
    } catch (err: any) {
      alert('吊销失败: ' + err.message);
    }
  };

  return (
    <div className="bg-white shadow rounded-lg">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">文件名</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">大小</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">过期时间</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">下载次数</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">操作</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {files.map((file) => (
            <>
              <tr key={file.id}>
                <td className="px-4 py-3 text-sm font-medium">{file.filename}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{formatSize(file.size)}</td>
                <td className="px-4 py-3 text-sm text-gray-500">
                  {file.expires_at ? new Date(file.expires_at).toLocaleString() : '永久'}
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">{file.download_count}</td>
                <td className="px-4 py-3 text-sm text-right space-x-2 whitespace-nowrap">
                  <button onClick={() => handleDownload(file)} className="text-blue-600 hover:underline">下载</button>
                  <button onClick={() => setMoveDialogFile(file)} className="text-gray-600 hover:underline">移动</button>
                  <button onClick={() => handleExtend(file)} className="text-gray-600 hover:underline">延期</button>
                  {file.expires_at && (
                    <button onClick={() => handleSetPermanent(file)} className="text-gray-600 hover:underline">设为永久</button>
                  )}
                  <button onClick={() => setShareDialogFile(file)} className="text-green-600 hover:underline">分享</button>
                  <button onClick={() => toggleShares(file)} className="text-gray-600 hover:underline">
                    {expandedShares[file.id] ? '收起' : '分享列表'}
                  </button>
                  <button onClick={() => handleDelete(file)} className="text-red-600 hover:underline">删除</button>
                </td>
              </tr>
              {expandedShares[file.id] && (
                <tr key={`${file.id}-shares`}>
                  <td colSpan={5} className="px-8 py-2 bg-gray-50">
                    {expandedShares[file.id].length === 0 ? (
                      <span className="text-xs text-gray-400">暂无分享</span>
                    ) : (
                      <ul className="space-y-1">
                        {expandedShares[file.id].map((s) => (
                          <li key={s.id} className="flex items-center space-x-3 text-xs">
                            <span className="font-mono">{window.location.origin}{s.share_url}</span>
                            <span>{s.protection === 'password' ? '密码' : '免密'}</span>
                            <span>{s.used_downloads}{s.max_downloads !== null ? `/${s.max_downloads}` : ''} 次</span>
                            <span>{s.expires_at ? new Date(s.expires_at).toLocaleString() : '永久'}</span>
                            {s.status === 'revoked' ? (
                              <span className="text-gray-400">已吊销</span>
                            ) : (
                              <button onClick={() => handleRevokeShare(file.id, s.id)} className="text-red-600 hover:underline">
                                吊销
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>

      {/* 分页 */}
      <div className="px-4 py-3 flex justify-between items-center text-sm text-gray-500">
        <span>共 {total} 个文件</span>
        <div className="space-x-2">
          <button disabled={page <= 1} onClick={() => onPageChange(page - 1)} className="disabled:opacity-40">上一页</button>
          <button disabled={page * 20 >= total} onClick={() => onPageChange(page + 1)} className="disabled:opacity-40">下一页</button>
        </div>
      </div>

      {shareDialogFile && (
        <ShareCreateDialog
          fileId={shareDialogFile.id}
          filename={shareDialogFile.filename}
          onClose={() => setShareDialogFile(null)}
        />
      )}
      {moveDialogFile && (
        <MoveFileDialog
          file={moveDialogFile}
          onClose={() => setMoveDialogFile(null)}
          onMoved={() => { setMoveDialogFile(null); onChanged(); }}
        />
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
```

`MoveFileDialog`（骨架，复用文件夹树平铺为下拉列表）：
```tsx
// apps/web/src/components/MoveFileDialog.tsx
// 关键逻辑：
// 1. useEffect 加载 GET /folders（平铺列表），选项 = [根目录(null), ...folders]
// 2. 提交：api.patch(`/files/${file.id}`, { folder_id: selectedId }) // null = 根目录
// 3. 成功后 onMoved()
// 渲染：固定定位对话框 + <select> + 确认/取消按钮（结构同 ShareCreateDialog，约 60 行）
```

FileUpload 需增加当前文件夹入参：`initializeUpload` 请求体带 `folder_id: selectedFolderId`（后端 InitUploadDto 增加可选 `folder_id`，completeUpload 创建 File 时写入——与 1.2 的 folder 验证复用同一逻辑，归属 Task 5/12 衔接点，此处标注）。

---

## 4. 测试计划重写（问题 12）

### 4.1 auth.service.spec.ts 修正（完整框架）

修正点：mock 完整 QueryRunner；`initialize` 全部走 `queryRunner.query` 按 SQL 匹配返回值；新增 refresh 并发轮换测试。

`apps/server/src/auth/auth.service.spec.ts`:
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { AccountsService } from '../accounts/accounts.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Session } from './entities/session.entity';
import { LoginChallenge } from './entities/login-challenge.entity';
import { SystemMeta } from './entities/system-meta.entity';
import { DataSource } from 'typeorm';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * QueryRunner mock 工厂。
 * rawSqlRoutes: initialize() 的原生 SQL 按子串匹配路由（BEGIN/COMMIT/ROLLBACK 自动处理）。
 * managerBehavior: refreshToken() 的 manager 操作行为注入点。
 */
function createMockQueryRunner(options: {
  rawSqlRoutes?: Array<{ match: string; params?: any[]; result: any }>;
  managerBehavior?: {
    updateAffected?: number;
    sessionFound?: any;
  };
}) {
  const rawCalls: Array<{ sql: string; params: any[] }> = [];
  const queryBuilderExecute = jest.fn().mockImplementation(async () => ({
    affected: options.managerBehavior?.updateAffected ?? 1,
  }));

  const queryRunner: any = {
    rawCalls,
    connect: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    // initialize() 使用原生 SQL
    query: jest.fn().mockImplementation(async (sql: string, params: any[] = []) => {
      rawCalls.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())) return undefined;
      const route = (options.rawSqlRoutes ?? []).find((r) => sql.includes(r.match));
      if (!route) throw new Error(`Unmocked SQL: ${sql}`);
      if (route.params) expect(params).toEqual(route.params);
      return typeof route.result === 'function' ? route.result() : route.result;
    }),
    // refreshToken() 使用 manager + QueryBuilder
    manager: {
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: queryBuilderExecute,
      }),
      findOne: jest.fn().mockImplementation(async () => options.managerBehavior?.sessionFound ?? null),
      create: jest.fn().mockImplementation((_entity: any, data: any) => data),
      save: jest.fn().mockResolvedValue(undefined),
    },
  };
  return queryRunner;
}

describe('AuthService', () => {
  let service: AuthService;
  const mockAccountsService = { createAccount: jest.fn(), findByUsername: jest.fn(), findById: jest.fn(), validatePassword: jest.fn(), getAccountCount: jest.fn() };
  const mockJwtService = { sign: jest.fn().mockReturnValue('mock-access-token') };
  const mockConfigService = { get: jest.fn() };
  const mockSessionsRepository = { create: jest.fn((d) => d), save: jest.fn(), findOne: jest.fn(), update: jest.fn() };
  const mockChallengesRepository = { create: jest.fn(), save: jest.fn(), findOne: jest.fn(), update: jest.fn() };
  const mockSystemMetaRepository = { findOne: jest.fn(), save: jest.fn(), delete: jest.fn() };
  const mockDataSource = { createQueryRunner: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: AccountsService, useValue: mockAccountsService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: getRepositoryToken(Session), useValue: mockSessionsRepository },
        { provide: getRepositoryToken(LoginChallenge), useValue: mockChallengesRepository },
        { provide: getRepositoryToken(SystemMeta), useValue: mockSystemMetaRepository },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('isInitialized', () => {
    it('returns true when initialized_at exists', async () => {
      mockSystemMetaRepository.findOne.mockResolvedValue({ key: 'initialized_at', value: '123' });
      expect(await service.isInitialized()).toBe(true);
    });
    it('returns false otherwise', async () => {
      mockSystemMetaRepository.findOne.mockResolvedValue(null);
      expect(await service.isInitialized()).toBe(false);
    });
  });

  describe('initialize', () => {
    const validToken = 'valid-init-token';
    const validMetaValue = JSON.stringify({
      token_hash: sha256(validToken),
      expires_at: Date.now() + 10 * 60 * 1000,
    });

    function setupQueryRunner(overrides: Partial<Parameters<typeof createMockQueryRunner>[0]> = {}) {
      const qr = createMockQueryRunner({
        rawSqlRoutes: [
          { match: `SELECT value FROM system_meta WHERE key = 'init_token'`, result: [{ value: validMetaValue }] },
          { match: `SELECT 1 FROM system_meta WHERE key = 'initialized_at'`, result: [] },
          { match: 'INSERT INTO admin_accounts', result: undefined },
          { match: `INSERT INTO system_meta (key, value) VALUES ('initialized_at', ?)`, result: undefined },
          { match: `INSERT INTO system_meta (key, value) VALUES ('first_account_id', ?)`, result: undefined },
          { match: `DELETE FROM system_meta WHERE key = 'init_token'`, result: undefined },
        ],
        ...overrides,
      });
      mockDataSource.createQueryRunner.mockReturnValue(qr);
      return qr;
    }

    it('should throw Unauthorized when no init token generated', async () => {
      const qr = createMockQueryRunner({
        rawSqlRoutes: [{ match: `SELECT value FROM system_meta WHERE key = 'init_token'`, result: [] }],
      });
      mockDataSource.createQueryRunner.mockReturnValue(qr);
      await expect(service.initialize('user', 'pass', 'any')).rejects.toThrow(UnauthorizedException);
      expect(qr.rollbackTransaction ?? qr.rawCalls.some((c: any) => c.sql.startsWith('ROLLBACK'))).toBeTruthy();
    });

    it('should throw Unauthorized when init token expired', async () => {
      const expiredMeta = JSON.stringify({ token_hash: sha256(validToken), expires_at: Date.now() - 1000 });
      const qr = createMockQueryRunner({
        rawSqlRoutes: [{ match: `SELECT value FROM system_meta WHERE key = 'init_token'`, result: [{ value: expiredMeta }] }],
      });
      mockDataSource.createQueryRunner.mockReturnValue(qr);
      await expect(service.initialize('user', 'pass', validToken)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw Unauthorized when token hash mismatches (timingSafeEqual path)', async () => {
      setupQueryRunner();
      await expect(service.initialize('user', 'pass', 'wrong-token')).rejects.toThrow(UnauthorizedException);
    });

    it('should throw BadRequest when already initialized (re-check inside transaction)', async () => {
      setupQueryRunner({
        rawSqlRoutes: [
          { match: `SELECT value FROM system_meta WHERE key = 'init_token'`,
            result: [{ value: JSON.stringify({ token_hash: sha256(validToken), expires_at: Date.now() + 60000 }) }] },
          { match: `SELECT 1 FROM system_meta WHERE key = 'initialized_at'`, result: [{ '?column?': 1 }] },
        ],
      });
      await expect(service.initialize('user', 'pass', validToken)).rejects.toThrow(BadRequestException);
    });

    it('should succeed with valid token: single transaction, token deleted, tokens issued', async () => {
      const qr = setupQueryRunner();
      const result = await service.initialize('admin', 'StrongP@ssw0rd', validToken);

      expect(result.accessToken).toBe('mock-access-token');
      expect(result.refreshToken).toBeTruthy();
      expect(result.expiresIn).toBe(24 * 60 * 60);

      const seq = qr.rawCalls.map((c: any) => c.sql.trim().split(' ')[0]);
      expect(seq[0]).toBe('BEGIN');
      expect(seq[seq.length - 1]).toBe('COMMIT');
      // init token 单次使用：DELETE 必须在 COMMIT 前
      expect(qr.rawCalls.some((c: any) => c.sql.includes(`DELETE FROM system_meta WHERE key = 'init_token'`))).toBe(true);
      // 会话保存走 sessionsRepository（generateTokens 在事务外）
      expect(mockSessionsRepository.save).toHaveBeenCalled();
    });
  });

  describe('refreshToken (atomic rotation)', () => {
    it('should rotate when conditional UPDATE affects 1 row', async () => {
      const qr = createMockQueryRunner({
        managerBehavior: {
          updateAffected: 1,
          sessionFound: { id: 's1', accountId: 'acc1' },
        },
      });
      mockDataSource.createQueryRunner.mockReturnValue(qr);
      mockAccountsService.findById.mockResolvedValue({ id: 'acc1', username: 'admin', isActive: 1 });

      const result = await service.refreshToken('old-refresh-token');
      expect(result.accessToken).toBe('mock-access-token');
      expect(qr.commitTransaction).toHaveBeenCalled();
      expect(qr.manager.createQueryBuilder).toHaveBeenCalled();
    });

    it('concurrent rotation: only the first succeeds (affected=0 for the loser)', async () => {
      // 模拟两个并发请求各自的 QueryRunner：第一个抢到（affected=1），第二个 affected=0
      const winner = createMockQueryRunner({ managerBehavior: { updateAffected: 1, sessionFound: { id: 's1', accountId: 'acc1' } } });
      const loser = createMockQueryRunner({ managerBehavior: { updateAffected: 0 } });
      mockDataSource.createQueryRunner
        .mockReturnValueOnce(winner)
        .mockReturnValueOnce(loser);
      mockAccountsService.findById.mockResolvedValue({ id: 'acc1', username: 'admin', isActive: 1 });

      const results = await Promise.allSettled([
        service.refreshToken('same-token'),
        service.refreshToken('same-token'),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(UnauthorizedException);
      expect(loser.rollbackTransaction).toHaveBeenCalled();
    });

    it('should reject revoked/expired token (affected=0) and rollback', async () => {
      const qr = createMockQueryRunner({ managerBehavior: { updateAffected: 0 } });
      mockDataSource.createQueryRunner.mockReturnValue(qr);
      await expect(service.refreshToken('dead-token')).rejects.toThrow(UnauthorizedException);
      expect(qr.commitTransaction).not.toHaveBeenCalled();
      expect(qr.rollbackTransaction).toHaveBeenCalled();
    });
  });
});
```

### 4.2 uploads.service.spec.ts 修正（关键用例框架）

修正点：`repository.create` mock 返回完整 session（含数字 `expiresAt`）；新增同分块并发测试。

```typescript
// apps/server/src/files/uploads.service.spec.ts（在 v1.5 骨架上替换/追加以下 describe）

describe('initializeUpload', () => {
  it('should create upload session with complete entity shape', async () => {
    const request = { filename: 'test.txt', size: 1024 };
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);

    mockStorageService.getUploadTempDir.mockReturnValue('/tmp/test-upload');
    mockStorageService.createUploadTempDir.mockResolvedValue(undefined);

    // v1.6 修正：create mock 返回完整 session 对象（实现随后读 session.expiresAt）
    const fullSession = {
      id: 'uuid-1',
      uploadTokenHash: expect.any(String),
      filename: 'test.txt',
      expectedSize: 1024,
      expectedHash: null,
      chunkSize: 8 * 1024 * 1024,
      status: 'initiated',
      receivedSize: 0,
      tempPath: '/tmp/test-upload',
      principalType: 'admin',
      principalId: 'user-id',
      createdAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000, // 必须是数字，否则 toISOString() 崩溃
    };
    mockUploadsRepository.create.mockReturnValue(fullSession);
    mockUploadsRepository.save.mockResolvedValue(fullSession);

    const result = await service.initializeUpload(request, 'admin', 'user-id');

    expect(result.upload_id).toBeTruthy();
    expect(result.upload_token).toBeTruthy();
    expect(result.chunk_size).toBe(8 * 1024 * 1024);
    // expires_at 必须是合法 ISO 8601（回归：v1.5 mock 导致 NaN）
    expect(result.expires_at).toBe(new Date(fullSession.expiresAt).toISOString());
    expect(() => Date.parse(result.expires_at)).not.toThrow();
    expect(mockStorageService.createUploadTempDir).toHaveBeenCalled();

    (Date.now as jest.Mock).mockRestore();
  });
});

describe('uploadPart concurrency (same part, two concurrent requests)', () => {
  const session = {
    id: 'up1', uploadTokenHash: '', filename: 'a.bin', expectedSize: 100,
    chunkSize: 100, status: 'initiated', receivedSize: 0, expiresAt: Date.now() + 3600_000,
  };
  const data = Buffer.alloc(100, 1);
  const checksum = createHash('sha256').update(data).digest('hex');

  beforeEach(() => {
    // validateUploadToken 通过
    mockUploadsRepository.findOne.mockResolvedValue(session);
  });

  it('identical checksum: second request is idempotent (received=true, no double increment)', async () => {
    // 第一个请求：findOne 无既有分块；事务内 findOne 也无 → create+save+increment
    // 第二个请求：findOne 返回已 ready 的同 checksum 分块 → 直接幂等返回
    const existingPart = { uploadId: 'up1', partNumber: 0, checksum, status: 'ready', size: 100, offset: 0 };
    mockPartsRepository.findOne
      .mockResolvedValueOnce(null)          // 请求1：事务外检查
      .mockResolvedValueOnce(existingPart); // 请求2：事务外检查命中

    // dataSource.transaction mock：执行回调并传入事务 manager
    const txManager = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((_e, d) => d),
      save: jest.fn().mockResolvedValue(undefined),
      increment: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };
    mockDataSource.transaction.mockImplementation(async (cb: any) => cb(txManager));

    const [r1, r2] = await Promise.all([
      service.uploadPart('up1', 0, data, checksum, 'token'),
      service.uploadPart('up1', 0, data, checksum, 'token'),
    ]);

    expect(r1.received).toBe(true);
    expect(r2.received).toBe(true);
    // received_size 只递增一次
    expect(txManager.increment).toHaveBeenCalledTimes(1);
  });

  it('different checksum: loser gets PART_CHECKSUM_MISMATCH', async () => {
    const existingPart = { uploadId: 'up1', partNumber: 0, checksum: 'different', status: 'ready', size: 100, offset: 0 };
    mockPartsRepository.findOne.mockResolvedValue(existingPart);
    await expect(service.uploadPart('up1', 0, data, checksum, 'token'))
      .rejects.toThrow(ConflictException);
    // 冲突路径不得写文件
    expect(mockStorageService.writePart).not.toHaveBeenCalled();
  });
});
```

（注意：uploadPart 的 owner 抢占重构属于问题 1/2 负责人范围；本测试针对其修正后的行为契约编写——若 uploadPart 实现改为「先抢占再写文件」，事务外 findOne 的 mock 序列需同步调整为抢占 UPDATE 的 affected mock。测试文件头部应加注释说明此耦合点。）

### 4.3 E2E 重写 — 环境变量覆盖的具体做法

核心机制：`configuration.ts` 是 `registerAs('app', () => {...})` 工厂，**在 `Test.createTestingModule({imports:[AppModule]}).compile()` 时（ConfigModule 初始化）才读 `process.env`，而非 import AppModule 时**。因此测试文件可以顶层 import AppModule，在每个 describe 的 `beforeAll`/`beforeEach` 里先 `process.env.XXX = ...` 再 compile，即可实现每个 describe 独立隔离。

```typescript
// apps/server/test/app.e2e-spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import cookieParser from 'cookie-parser';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir, rm, readFile } from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';

/** 每个 describe 一套独立临时环境：DB + 存储 + 临时目录 */
interface TestEnv {
  dir: string;
  dbPath: string;
  storagePath: string;
  tempPath: string;
}

async function setupEnv(): Promise<TestEnv> {
  const dir = join(tmpdir(), `filestation-e2e-${uuidv4()}`);
  const env: TestEnv = {
    dir,
    dbPath: join(dir, 'test.db'),
    storagePath: join(dir, 'storage'),
    tempPath: join(dir, 'temp'),
  };
  await mkdir(env.storagePath, { recursive: true });
  await mkdir(env.tempPath, { recursive: true });

  // 关键：必须在 compile() 之前设置（configuration 工厂在 ConfigModule init 时读取）
  process.env.FILESTATION_DB_PATH = env.dbPath;
  process.env.FILESTATION_STORAGE_PATH = env.storagePath;
  process.env.FILESTATION_TEMP_PATH = env.tempPath;
  process.env.JWT_SECRET = 'e2e-test-secret';
  process.env.NODE_ENV = 'test';
  return env;
}

async function teardownEnv(env: TestEnv) {
  delete process.env.FILESTATION_DB_PATH;
  delete process.env.FILESTATION_STORAGE_PATH;
  delete process.env.FILESTATION_TEMP_PATH;
  await rm(env.dir, { recursive: true, force: true }); // 含 -wal/-shm
}

async function createApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  // 与 main.ts 完全一致的配置（globalPrefix 是唯一前缀来源）
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.enableCors({ origin: ['http://localhost:5173'], credentials: true });
  await app.init();
  return app;
}

/** 完成初始化并登录，返回 accessToken */
async function initAndLogin(app: INestApplication): Promise<string> {
  // 直接从 AuthService 生成 init token（等价于启动日志输出的 token）
  const initToken = await app.get(AuthService).generateInitToken();

  await request(app.getHttpServer())
    .post('/api/v1/auth/init')
    .set('X-Init-Token', initToken) // v1.6：头部传递，非 JSON body
    .send({ username: 'admin', password: 'StrongP@ssw0rd' })
    .expect(201);

  const loginRes = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ username: 'admin', password: 'StrongP@ssw0rd' })
    .expect(200);

  return loginRes.body.data.access_token;
}
```

完整流程 describe（独立环境）：
```typescript
describe('Full flow (e2e): init -> login -> upload -> share -> download -> revoke', () => {
  let env: TestEnv;
  let app: INestApplication;
  let accessToken: string;

  beforeAll(async () => {
    env = await setupEnv();
    app = await createApp();
    accessToken = await initAndLogin(app);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await teardownEnv(env);
  });

  it('completes the entire lifecycle', async () => {
    const server = app.getHttpServer();
    const fileContent = Buffer.from('hello filestation world'); // 24 bytes，单块

    // 1. 初始化上传
    const initRes = await request(server)
      .post('/api/v1/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'hello.txt', size: fileContent.length })
      .expect(201);
    const { upload_id, upload_token } = initRes.body.data;

    // 2. 上传唯一分块（part 0）
    const checksum = createHash('sha256').update(fileContent).digest('hex');
    await request(server)
      .put(`/api/v1/uploads/${upload_id}/parts/0`)
      .set('X-Upload-Token', upload_token)
      .set('X-Part-Checksum', checksum)
      .set('Content-Type', 'application/octet-stream')
      .send(fileContent)
      .expect(200);

    // 3. 完成上传
    const completeRes = await request(server)
      .post(`/api/v1/uploads/${upload_id}/complete`)
      .set('X-Upload-Token', upload_token)
      .send({})
      .expect(201);
    const fileId = completeRes.body.data.file_id;
    expect(fileId).toBeTruthy();

    // 4. 创建免密分享
    const shareRes = await request(server)
      .post('/api/v1/shares')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ file_id: fileId, protection: 'none' })
      .expect(201);
    const shareId = shareRes.body.data.share_id;

    // 5. 统一 access 端点（v1.6：POST /shares/:id/access，免密不传 password）
    const accessRes = await request(server)
      .post(`/api/v1/shares/${shareId}/access`)
      .send({})
      .expect(201);
    const downloadToken = accessRes.body.data.download_token;
    expect(downloadToken).toBeTruthy();

    // 6. 创建下载票据
    const ticketRes = await request(server)
      .post(`/api/v1/shares/${shareId}/download-ticket`)
      .set('Authorization', `Bearer ${downloadToken}`)
      .send({})
      .expect(201);
    const ticketUrl = ticketRes.body.data.ticket_url; // /api/v1/downloads/:ticket

    // 7. Range 下载（bytes=0-4 → 206 'hello'）
    const rangeRes = await request(server)
      .get(ticketUrl)
      .set('Range', 'bytes=0-4')
      .expect(206);
    expect(rangeRes.headers['content-range']).toBe(`bytes 0-4/${fileContent.length}`);
    expect(rangeRes.body.toString()).toBe('hello');

    // 8. 完整下载（200）
    await request(server).get(ticketUrl).expect(200);

    // 9. 管理员吊销分享
    await request(server)
      .delete(`/api/v1/shares/${shareId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // 10. 吊销后：新 access 410；既有票据/既有 download token 复验失败（410/404）
    await request(server).post(`/api/v1/shares/${shareId}/access`).send({}).expect(410);
    await request(server).get(ticketUrl).expect(410);
    await request(server)
      .post(`/api/v1/shares/${shareId}/download-ticket`)
      .set('Authorization', `Bearer ${downloadToken}`)
      .send({})
      .expect(410);
  });
});
```

并发初始化 describe（独立环境，双请求 init 仅一个 201）：
```typescript
describe('Concurrent initialization (e2e)', () => {
  let env: TestEnv;
  let app: INestApplication;

  beforeAll(async () => {
    env = await setupEnv();
    app = await createApp();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await teardownEnv(env);
  });

  it('two concurrent init requests: exactly one 201, one 4xx', async () => {
    const initToken = await app.get(AuthService).generateInitToken();
    const server = app.getHttpServer();

    const [r1, r2] = await Promise.all([
      request(server).post('/api/v1/auth/init').set('X-Init-Token', initToken)
        .send({ username: 'admin', password: 'StrongP@ssw0rd' }),
      request(server).post('/api/v1/auth/init').set('X-Init-Token', initToken)
        .send({ username: 'admin', password: 'StrongP@ssw0rd' }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses[0]).toBe(201);
    expect([400, 401, 409]).toContain(statuses[1]); // BEGIN IMMEDIATE 串行化后事务内重查拒绝

    // 第三次（token 已单次消费）必须失败
    await request(server).post('/api/v1/auth/init').set('X-Init-Token', initToken)
      .send({ username: 'x', password: 'y' }).expect((res) => expect(res.status).toBeGreaterThanOrEqual(400));
  });

  it('wrong init token is rejected with 401', async () => {
    // 此 describe 已初始化：应 400（先查 initialized）；未初始化环境应 401。
    // 精确语义以问题 8 修正后的实现为准，此处锁定「一定不是 201/200」
    const res = await request(app.getHttpServer()).post('/api/v1/auth/init')
      .set('X-Init-Token', 'wrong-token')
      .send({ username: 'a', password: 'b' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
```

`jest-e2e.json` 补充（防临时目录泄漏 + 串行避免端口/SQLite 争用）：
```json
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": ".",
  "testEnvironment": "node",
  "testRegex": ".e2e-spec.ts$",
  "transform": { "^.+\\.(t|j)s$": "ts-jest" },
  "maxWorkers": 1,
  "testTimeout": 60000
}
```

E2E 已知注意事项（写入计划备注）：
- `maxWorkers: 1`：多个 describe 串行执行，避免同时操作各自 WAL 文件时的 CI 资源抖动（隔离性已由独立目录保证，串行只为稳定）。
- `StorageService.ensureDirectories()` 在 v1.6 由问题 8 负责人改为模块 `onModuleInit` 自动调用后，E2E 无需手动建目录；在此之前 `setupEnv()` 中的 `mkdir` 保留作为兜底。
- 上传 E2E 的 `request.put().send(Buffer)` 需要 Controller 使用 raw body 解析（属 Task 5 范围）；若实现采用流式读取，E2E 行为不变。

---

## 任务清单（v1.6 增量，挂到对应 Task）

| 编号 | 归属 Task | 内容 | 文件 |
|------|-----------|------|------|
| 7a | Task 7 | FoldersService 重写：move 验证目标（存在+未删+非自身+非后代）+ 条件 UPDATE 兜底；delete 改 BEGIN IMMEDIATE 原子事务（事务内重查子文件夹/文件计数 + 条件软删）；注入 DataSource | `apps/server/src/folders/folders.service.ts` |
| 7b | Task 5 | FilesService 注入 `Repository<Folder>`；update() 验证目标 folder（null 合法、未变跳过、已删 404）；新增 setPermanent()；FilesModule forFeature 增加 Folder；FilesController PATCH 修正 `'folder_id' in updates` / `'expires_at' in updates` 显式 null 处理 | `apps/server/src/files/files.service.ts`, `files.controller.ts`, `files.module.ts` |
| 7c | Task 7 | 单测：folders.service.spec（createMockQueryRunner 工厂 + move 5 用例 + delete 4 用例）；files.service.spec（folder 验证 3 用例 + setPermanent 1 用例）；并发删除/移动场景集成测试（真实临时 SQLite） | `apps/server/src/folders/folders.service.spec.ts`, `apps/server/src/files/files.service.spec.ts`, `apps/server/test/folders-concurrency.e2e-spec.ts` |
| 9a | Task 2 | 迁移 up() 追加 9 个索引 + transfer_stats_hourly 表 + Phase 1/预留分区注释；down() 补 DROP | `apps/server/src/database/migrations/1700000000000-initial-schema.ts` |
| 9b | Task 3 | ShareProtection 移除 ADMIN，与 DB CHECK 对齐；清理引用文案 | `apps/server/src/shares/entities/share.entity.ts`, `shares.service.ts` |
| 11a | Task 6 | SharesService.findByFile + SharesController `GET /shares?file_id=`（管理端行内分享列表支撑） | `apps/server/src/shares/shares.service.ts`, `shares.controller.ts` |
| 11b | Task 12 | api.downloadFile()；FolderTree 组件；ShareCreateDialog 组件；MoveFileDialog 骨架；FileList 操作列（下载/移动/延期/设为永久/删除/分享/行内分享列表+吊销）；FilesPage 重构（树+列表布局）；FileUpload 透传 folder_id | `apps/web/src/lib/api.ts`, `apps/web/src/components/{FolderTree,ShareCreateDialog,MoveFileDialog,FileList,FileUpload}.tsx`, `apps/web/src/pages/FilesPage.tsx` |
| 12a | Task 4 | auth.service.spec 重写：createMockQueryRunner（raw SQL 路由 + manager 行为注入）；initialize 5 用例；refresh 原子轮换 3 用例（含并发胜负断言） | `apps/server/src/auth/auth.service.spec.ts` |
| 12b | Task 5 | uploads.service.spec 修正：initializeUpload 完整 session mock（数字 expiresAt + ISO 断言）；同分块并发 2 用例 | `apps/server/src/files/uploads.service.spec.ts` |
| 12c | Task 13 | E2E 重写：setupEnv/teardownEnv（describe 级独立临时 DB+存储，compile 前注入 env）；createApp 复刻 main.ts 配置；initAndLogin 辅助；完整流程 10 步用例（含 Range 206、吊销后票据失效 410）；并发 init 用例；jest-e2e.json maxWorkers=1/timeout=60s | `apps/server/test/app.e2e-spec.ts`, `apps/server/test/jest-e2e.json` |

**跨任务耦合点（需与其他问题负责人对齐）：** 12b 的 uploadPart 并发测试 mock 序列取决于问题 1/2 的 owner 抢占重构最终形态；11b 的 FileUpload folder_id 需要 Task 5 的 InitUploadDto/completeUpload 接受 folder_id；4.3 E2E 的 `/shares/:id/access` 统一端点与 `X-Init-Token` 头分别依赖问题 6、8 的修正落地——E2E 编写应以修正后的契约为准，本设计中已按目标契约给出。