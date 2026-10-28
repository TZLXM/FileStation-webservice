import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AttemptJournal } from '@filestation/updater';
import { startGatedApplication } from './server-startup';
import {
  TrustedStartupAccess,
  UpdateStartupIntent,
} from './startup-authority';
import { DataSource } from 'typeorm';

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

describe('gated startup', () => {
  let root: string;
  let journal: AttemptJournal;
  let handle: Awaited<ReturnType<typeof startGatedApplication>>;

  const intent: UpdateStartupIntent = {
    mode: 'gated',
    attempt: {
      attemptId: 'attempt-gated-01',
      fence: 11,
      installRoot: '',
      backupId: 'backup-gated-01',
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
    root = await mkdtemp(path.join(tmpdir(), 'filestation-task7-gated-'));
    intent.attempt.installRoot = root;
    process.env.FILESTATION_DB_PATH = path.join(root, 'database.sqlite');
    process.env.FILESTATION_STORAGE_PATH = path.join(root, 'storage');
    process.env.FILESTATION_TEMP_PATH = path.join(root, 'temp');
    process.env.FILESTATION_INSTALL_ROOT = root;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'task7-gated-secret';
    journal = await AttemptJournal.open(root);
    await journal.beginAttempt({
      attemptId: intent.attempt.attemptId,
      fence: intent.attempt.fence,
      currentVersion: '0.2.0',
      targetVersion: intent.attempt.targetVersion,
      phase: 'PREPARED',
      owner: {
        bootIdentity: 'fixture-boot',
        pid: process.pid,
        processCreatedAt: '2026-10-28T00:00:00.000Z',
        heartbeatAt: new Date().toISOString(),
      },
    });

    handle = await startGatedApplication({
      access,
      intent,
      host: '127.0.0.1',
      port: 0,
      commitPollIntervalMs: 10,
    });
  });

  afterEach(async () => {
    await handle.close();
    delete process.env.FILESTATION_DB_PATH;
    delete process.env.FILESTATION_STORAGE_PATH;
    delete process.env.FILESTATION_TEMP_PATH;
    delete process.env.FILESTATION_INSTALL_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('serves maintenance until a matching durable COMMITTED, then activates normal services', async () => {
    const dataSource = handle.app.get(DataSource);
    const before = await databaseFingerprint(dataSource);
    await request(handle.app.getHttpServer())
      .get('/api/v1/auth/status')
      .expect(503);
    await request(handle.app.getHttpServer())
      .get('/api/v1/internal/update/health')
      .set('X-FileStation-Attempt', intent.attempt.attemptId)
      .set('X-FileStation-Fence', String(intent.attempt.fence))
      .set('X-FileStation-Capability', 'fixture-capability')
      .expect(200)
      .expect((response) => {
        expect(response.body.status).toBe('gated');
        expect(response.body.phase).toBe('PREPARED');
      });
    await expect(stat(path.join(root, 'storage'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(path.join(root, 'temp'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await databaseFingerprint(dataSource)).toBe(before);

    const pending = await journal.appendIntent({
      attemptId: intent.attempt.attemptId,
      fence: intent.attempt.fence,
      action: 'commit-update',
      phase: 'COMMITTED',
    });
    await journal.appendCompletion({
      attemptId: intent.attempt.attemptId,
      fence: intent.attempt.fence,
      intentId: pending.id,
      phase: 'COMMITTED',
    });

    await handle.committed;
    await request(handle.app.getHttpServer())
      .get('/api/v1/auth/status')
      .expect(200);
    expect((await stat(path.join(root, 'storage'))).isDirectory()).toBe(true);
    expect((await stat(path.join(root, 'temp'))).isDirectory()).toBe(true);
  });
});
