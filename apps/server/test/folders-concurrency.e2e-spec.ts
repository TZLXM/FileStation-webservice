import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir, rm } from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { AppModule } from '../src/app.module';
import { FoldersService } from '../src/folders/folders.service';
import { DataSource } from 'typeorm';

describe('Folders concurrency (e2e, real SQLite)', () => {
  let dir: string;
  let app: INestApplication;
  let foldersService: FoldersService;
  let adminId: string; // v1.7 高优 10：先建账户（folders.created_by 有 FK）

  beforeAll(async () => {
    dir = join(tmpdir(), `filestation-folders-e2e-${uuidv4()}`);
    await mkdir(dir, { recursive: true });
    process.env.FILESTATION_DB_PATH = join(dir, 'test.db');
    process.env.FILESTATION_STORAGE_PATH = join(dir, 'storage');
    process.env.FILESTATION_TEMP_PATH = join(dir, 'temp');
    process.env.JWT_SECRET = 'e2e-test-secret';
    process.env.NODE_ENV = 'test';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    foldersService = app.get(FoldersService);

    // v1.7 高优 10：folders.created_by REFERENCES admin_accounts(id)，必须先建账户
    const dataSource = app.get(DataSource);
    adminId = uuidv4();
    const now = Date.now();
    await dataSource.query(
      `INSERT INTO admin_accounts (id, username, password_hash, password_changed_at, created_at, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [adminId, `testadmin_${adminId.slice(0, 8)}`, 'x', now, now],
    );
  }, 30_000);

  afterAll(async () => {
    await app.close();
    delete process.env.FILESTATION_DB_PATH;
    delete process.env.FILESTATION_STORAGE_PATH;
    delete process.env.FILESTATION_TEMP_PATH;
    await rm(dir, { recursive: true, force: true });
  });

  it('concurrent delete of same folder: exactly one succeeds', async () => {
    const folder = await foldersService.create('test-folder', null, adminId);

    const results = await Promise.allSettled([
      foldersService.delete(folder.id),
      foldersService.delete(folder.id),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it('concurrent delete + move-child-in: not both succeed（事务内重查必要性）', async () => {
    const parent = await foldersService.create('parent', null, adminId);
    const child = await foldersService.create('child', null, adminId);

    const results = await Promise.allSettled([
      foldersService.delete(parent.id),
      foldersService.move(child.id, parent.id),
    ]);

    // BEGIN IMMEDIATE 串行化后：要么 delete 先（move 看到 is_deleted=1 → 404），
    // 要么 move 先（delete 事务内重查看到新子项 → 400）。不会同时成功。
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeLessThanOrEqual(1);
  });
});
