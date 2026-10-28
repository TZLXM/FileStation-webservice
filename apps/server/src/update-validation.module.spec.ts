import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { AttemptJournal } from '@filestation/updater';
import { startValidationApplication } from './maintenance/server-startup';
import {
  TrustedStartupAccess,
  UpdateStartupIntent,
} from './maintenance/startup-authority';

async function databaseFingerprint(dataSource: DataSource): Promise<string> {
  const tables = (await dataSource.query(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  )) as Array<{ name: string }>;
  const snapshot: Record<string, string[]> = {};
  for (const { name } of tables) {
    const rows = (await dataSource.query(
      `SELECT * FROM "${name.replace(/"/g, '""')}"`,
    )) as unknown[];
    snapshot[name] = rows.map((row) => JSON.stringify(row)).sort();
  }
  return createHash('sha256')
    .update(JSON.stringify(snapshot))
    .digest('hex');
}

describe('UpdateValidationModule', () => {
  let root: string;
  let app: INestApplication;
  const intent: UpdateStartupIntent = {
    mode: 'validate',
    attempt: {
      attemptId: 'attempt-01',
      fence: 3,
      installRoot: '',
      backupId: 'backup-01',
      targetVersion: '0.2.5',
    },
  };
  const access: TrustedStartupAccess = {
    async authorizeStartup() {},
    async authorizeRequest(_intent, credentials) {
      if (credentials.capability !== 'fixture-capability') {
        throw new Error('capability rejected');
      }
    },
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'filestation-task7-validate-'));
    intent.attempt.installRoot = root;
    process.env.FILESTATION_DB_PATH = path.join(root, 'database.sqlite');
    process.env.FILESTATION_STORAGE_PATH = path.join(root, 'storage-must-not-exist');
    process.env.FILESTATION_TEMP_PATH = path.join(root, 'temp-must-not-exist');
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'task7-validation-secret';
    const journal = await AttemptJournal.open(root);
    await journal.beginAttempt({
      attemptId: intent.attempt.attemptId,
      fence: intent.attempt.fence,
      currentVersion: '0.2.0',
      targetVersion: intent.attempt.targetVersion,
      phase: 'MAINTENANCE',
      owner: {
        bootIdentity: 'fixture-boot',
        pid: process.pid,
        processCreatedAt: '2026-10-28T00:00:00.000Z',
        heartbeatAt: new Date().toISOString(),
      },
    });

    const handle = await startValidationApplication({ access, intent });
    app = handle.app;
  });

  afterEach(async () => {
    await app.close();
    delete process.env.FILESTATION_DB_PATH;
    delete process.env.FILESTATION_STORAGE_PATH;
    delete process.env.FILESTATION_TEMP_PATH;
    await rm(root, { recursive: true, force: true });
  });

  it('migrates and exposes only an attempt-bound capability health endpoint on random loopback', async () => {
    const dataSource = app.get(DataSource);
    const before = await databaseFingerprint(dataSource);
    const address = app.getHttpServer().address();
    expect(address).toEqual(
      expect.objectContaining({
        address: '127.0.0.1',
      }),
    );
    expect((address as { port: number }).port).toBeGreaterThan(0);

    await request(app.getHttpServer()).get('/api/v1/auth/status').expect(404);
    await request(app.getHttpServer())
      .get('/api/v1/internal/update/health')
      .expect(401);
    const health = await request(app.getHttpServer())
      .get('/api/v1/internal/update/health')
      .set('X-FileStation-Attempt', intent.attempt.attemptId)
      .set('X-FileStation-Fence', String(intent.attempt.fence))
      .set('X-FileStation-Capability', 'fixture-capability')
      .expect(200);

    expect(health.body).toMatchObject({
      status: 'validating',
      attempt_id: intent.attempt.attemptId,
      fence: intent.attempt.fence,
      version: '0.2.0',
      database: {
        integrity: 'ok',
        foreign_keys: 0,
        journal_mode: 'wal',
      },
    });
    expect(await databaseFingerprint(dataSource)).toBe(before);
  });

  it('excludes business initialization, storage, audit, Cron and MCP providers', async () => {
    for (const route of [
      '/api/v1/auth/status',
      '/api/v1/files',
      '/api/v1/audit-logs',
      '/api/v1/mcp',
    ]) {
      await request(app.getHttpServer()).get(route).expect(404);
    }
    await expect(stat(path.join(root, 'storage-must-not-exist'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(path.join(root, 'temp-must-not-exist'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const dataSource = app.get(DataSource);
    const initRows = await dataSource.query(
      `SELECT key FROM system_meta WHERE key = 'init_token'`,
    );
    expect(initRows).toEqual([]);
    const migrations = await dataSource.query(
      'SELECT name FROM sqlite_master WHERE type = ? AND name = ?',
      ['table', 'migrations'],
    );
    expect(migrations).toEqual([{ name: 'migrations' }]);
  });
});
