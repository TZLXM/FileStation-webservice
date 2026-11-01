import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { WriteBarrierService } from '../src/maintenance/write-barrier.service';
import {
  createApp,
  initAndLogin,
  setupEnv,
  teardownEnv,
  TestEnv,
} from './helpers';

async function databaseFingerprint(dataSource: DataSource): Promise<string> {
  const tables = (await dataSource.query(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  )) as Array<{ name: string }>;
  const snapshot: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    const quoted = `"${name.replace(/"/g, '""')}"`;
    const rows = (await dataSource.query(`SELECT * FROM ${quoted}`)) as unknown[];
    snapshot[name] = rows
      .map((row) => JSON.stringify(row))
      .sort();
  }
  return createHash('sha256')
    .update(JSON.stringify(snapshot))
    .digest('hex');
}

async function treeFingerprint(root: string): Promise<string> {
  const entries: string[] = [];
  async function visit(directory: string, relative: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, child.name);
      const key = path.posix.join(relative, child.name);
      if (child.isDirectory()) {
        entries.push(`d:${key}`);
        await visit(filename, key);
      } else {
        const digest = createHash('sha256')
          .update(await readFile(filename))
          .digest('hex');
        entries.push(`f:${key}:${digest}`);
      }
    }
  }
  await visit(root, '');
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

describe('update maintenance write barrier (e2e)', () => {
  let env: TestEnv;
  let app: INestApplication;
  let accessToken: string;

  beforeAll(async () => {
    env = await setupEnv();
    app = await createApp();
    accessToken = await initAndLogin(app);
  });

  afterAll(async () => {
    await app.close();
    await teardownEnv(env);
  });

  it('rejects every business entry point before auth and leaves DB/storage unchanged', async () => {
    const dataSource = app.get(DataSource);
    const beforeDb = await databaseFingerprint(dataSource);
    const beforeStorage = await treeFingerprint(env.storagePath);
    app.get(WriteBarrierService).enterMaintenance({
      attemptId: 'attempt-01',
      fence: 5,
      installRoot: env.dir,
      backupId: 'backup-01',
      targetVersion: '0.2.5',
    });

    const routes: Array<[string, string]> = [
      ['get', '/api/v1/auth/status'],
      ['post', '/api/v1/auth/init'],
      ['post', '/api/v1/auth/login'],
      ['post', '/api/v1/auth/login/totp'],
      ['post', '/api/v1/auth/refresh'],
      ['post', '/api/v1/auth/logout'],
      ['post', '/api/v1/auth/totp/setup'],
      ['post', '/api/v1/auth/totp/confirm'],
      ['post', '/api/v1/auth/totp/disable'],
      ['post', '/api/v1/auth/api-token/exchange'],
      ['post', '/api/v1/auth/recovery/generate'],
      ['post', '/api/v1/auth/recovery/verify'],
      ['get', '/api/v1/settings/public'],
      ['get', '/api/v1/settings'],
      ['put', '/api/v1/settings'],
      ['get', '/api/v1/audit-logs'],
      ['post', '/api/v1/api-tokens'],
      ['get', '/api/v1/api-tokens'],
      ['delete', '/api/v1/api-tokens/fixture'],
      ['get', '/api/v1/files'],
      ['get', '/api/v1/files/fixture'],
      ['get', '/api/v1/files/fixture/content'],
      ['patch', '/api/v1/files/fixture'],
      ['post', '/api/v1/files/fixture/extend'],
      ['delete', '/api/v1/files/fixture'],
      ['post', '/api/v1/uploads'],
      ['put', '/api/v1/uploads/fixture/parts/0'],
      ['get', '/api/v1/uploads/fixture'],
      ['post', '/api/v1/uploads/fixture/complete'],
      ['post', '/api/v1/uploads/fixture/resume'],
      ['delete', '/api/v1/uploads/fixture'],
      ['post', '/api/v1/folders'],
      ['get', '/api/v1/folders'],
      ['get', '/api/v1/folders/tree'],
      ['get', '/api/v1/folders/fixture'],
      ['patch', '/api/v1/folders/fixture'],
      ['delete', '/api/v1/folders/fixture'],
      ['post', '/api/v1/shares'],
      ['get', '/api/v1/shares'],
      ['get', '/api/v1/shares/fixture'],
      ['post', '/api/v1/shares/fixture/access'],
      ['post', '/api/v1/shares/fixture/download-ticket'],
      ['get', '/api/v1/shares/fixture/content'],
      ['delete', '/api/v1/shares/fixture'],
      ['get', '/api/v1/downloads/fixture'],
      ['post', '/api/v1/mcp'],
      ['get', '/api/v1/mcp'],
      ['delete', '/api/v1/mcp'],
    ];

    for (const [method, endpoint] of routes) {
      const agent = request(app.getHttpServer());
      let pending;
      if (method === 'get') pending = agent.get(endpoint);
      else if (method === 'post') pending = agent.post(endpoint).send({});
      else if (method === 'put') pending = agent.put(endpoint).send({});
      else if (method === 'patch') pending = agent.patch(endpoint).send({});
      else pending = agent.delete(endpoint);
      const response = await pending;
      expect({
        method,
        endpoint,
        status: response.status,
        body: response.body,
      }).toEqual({
        method,
        endpoint,
        status: 503,
        body: {
          code: 'UPDATE_MAINTENANCE',
          message:
            'FileStation is temporarily unavailable while an update is prepared',
        },
      });
      expect(response.headers['retry-after']).toBe('5');
    }

    expect(await databaseFingerprint(dataSource)).toBe(beforeDb);
    expect(await treeFingerprint(env.storagePath)).toBe(beforeStorage);
  });

  it('keeps only the side-effect-free update status route readable', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/updates/status')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({
        phase: 'unavailable',
      }),
    );
  });
});
