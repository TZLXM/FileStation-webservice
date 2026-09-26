import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createHash } from 'crypto';
import { writeFile } from 'fs/promises';
import { createApp, initAndLogin, setupEnv, teardownEnv, type TestEnv } from './helpers';
import { FileLifecycleService } from '../src/files/file-lifecycle.service';
import { StorageService } from '../src/files/storage.service';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('File lifecycle verifying recovery (SQLite integration)', () => {
  let env: TestEnv;
  let app: INestApplication;
  let accessToken: string;
  let dataSource: DataSource;
  let storage: StorageService;
  let lifecycle: FileLifecycleService;

  beforeAll(async () => {
    env = await setupEnv();
    app = await createApp();
    accessToken = await initAndLogin(app);
    dataSource = app.get(DataSource);
    storage = app.get(StorageService);
    lifecycle = app.get(FileLifecycleService);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await teardownEnv(env);
  });

  async function createUpload(filename: string, content: Buffer): Promise<{ id: string; token: string }> {
    const init = await request(app.getHttpServer())
      .post('/api/v1/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename, size: content.length })
      .expect(201);
    const id = init.body.data.upload_id as string;
    const token = init.body.data.upload_token as string;
    const checksum = createHash('sha256').update(content).digest('hex');
    await request(app.getHttpServer())
      .put(`/api/v1/uploads/${id}/parts/0`)
      .set('X-Upload-Token', token)
      .set('X-Part-Checksum', checksum)
      .set('Content-Type', 'application/octet-stream')
      .send(content)
      .expect(200);
    return { id, token };
  }

  async function markVerifying(
    uploadId: string,
    storedName: string | null,
    options: { leaseUntil?: number | null; startedAt?: number } = {},
  ): Promise<void> {
    const now = Date.now();
    await dataSource.query(
      `UPDATE upload_sessions
         SET status = 'verifying', final_stored_name = ?, verify_started_at = ?,
             verify_owner_token = 'expired-owner', verify_lease_until = ?, verify_heartbeat_at = ?
       WHERE id = ?`,
      [storedName, options.startedAt ?? now - 11 * 60 * 1000,
       options.leaseUntil === undefined ? now - 60_000 : options.leaseUntil,
       now - 11 * 60 * 1000, uploadId],
    );
  }

  async function readSession(uploadId: string): Promise<{ status: string; final_file_id: string | null; verify_owner_token: string | null; verify_lease_until: number | null }> {
    const [row] = await dataSource.query(
      `SELECT status, final_file_id, verify_owner_token, verify_lease_until FROM upload_sessions WHERE id = ?`,
      [uploadId],
    );
    return row;
  }

  it('completes a stale verifying row when its persisted final file exists', async () => {
    const content = Buffer.from('recovery-final-file-exists');
    const { id } = await createUpload('recover-existing.bin', content);
    const storedName = 'recovered-existing-final';
    await writeFile(storage.getFinalPath(storedName), content);
    await markVerifying(id, storedName);

    await lifecycle.recoverVerifyingUploads();

    const session = await readSession(id);
    expect(session.status).toBe('completed');
    expect(session.final_file_id).toBeTruthy();
    const [files] = await dataSource.query(`SELECT COUNT(*) AS count FROM files WHERE stored_name = ?`, [storedName]);
    expect(Number(files.count)).toBe(1);
  });

  it('rebuilds the final file from ready parts when the persisted final file is missing', async () => {
    const content = Buffer.from('recovery-final-file-missing');
    const { id } = await createUpload('recover-missing.bin', content);
    const storedName = 'recovered-missing-final';
    await markVerifying(id, storedName);

    await lifecycle.recoverVerifyingUploads();

    const session = await readSession(id);
    expect(session.status).toBe('completed');
    expect(session.final_file_id).toBeTruthy();
    const recovered = await storage.calculateFileHash(storage.getFinalPath(storedName));
    expect(recovered).toBe(createHash('sha256').update(content).digest('hex'));
  });

  it('recovers a legacy verifying row that has no lease columns populated', async () => {
    const content = Buffer.from('legacy-verifying-row');
    const { id } = await createUpload('recover-legacy.bin', content);
    const storedName = 'recovered-legacy-final';
    await writeFile(storage.getFinalPath(storedName), content);
    await markVerifying(id, storedName, { leaseUntil: null, startedAt: Date.now() - 6 * 60 * 1000 });

    await lifecycle.recoverVerifyingUploads();

    const session = await readSession(id);
    expect(session.status).toBe('completed');
    expect(session.final_file_id).toBeTruthy();
  });

  it('does not take over a candidate whose lease was refreshed after the stale scan', async () => {
    const content = Buffer.from('recovery-lease-refresh');
    const { id } = await createUpload('recover-refreshed-lease.bin', content);
    const storedName = 'not-taken-over-final';
    await writeFile(storage.getFinalPath(storedName), content);
    await markVerifying(id, storedName);

    const refreshedLease = Date.now() + 10 * 60 * 1000;
    const candidateScanned = deferred();
    const releaseCandidateScan = deferred();
    const originalQuery = dataSource.query.bind(dataSource);
    const querySpy = jest.spyOn(dataSource, 'query').mockImplementation(async (sql: string, parameters?: any[]) => {
      const result = await originalQuery(sql, parameters);
      if (sql.includes('FROM upload_sessions') && sql.includes("status = 'verifying'")) {
        candidateScanned.resolve();
        await releaseCandidateScan.promise;
      }
      return result;
    });
    const recovery = lifecycle.recoverVerifyingUploads();

    try {
      await candidateScanned.promise;
      await originalQuery(
        `UPDATE upload_sessions SET verify_owner_token = 'live-owner', verify_lease_until = ?, verify_heartbeat_at = ? WHERE id = ?`,
        [refreshedLease, Date.now(), id],
      );
    } finally {
      releaseCandidateScan.resolve();
      querySpy.mockRestore();
    }
    await recovery;

    const session = await readSession(id);
    expect(session.status).toBe('verifying');
    expect(session.verify_owner_token).toBe('live-owner');
    expect(session.verify_lease_until).toBe(refreshedLease);
    const [files] = await dataSource.query(`SELECT COUNT(*) AS count FROM files WHERE stored_name = ?`, [storedName]);
    expect(Number(files.count)).toBe(0);
  });

  it('marks a stale verifying row failed when neither final file nor complete ready parts exist', async () => {
    const init = await request(app.getHttpServer())
      .post('/api/v1/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'recover-impossible.bin', size: 20 })
      .expect(201);
    const id = init.body.data.upload_id as string;
    const storedName = 'missing-and-no-ready-parts';
    await markVerifying(id, storedName);

    await lifecycle.recoverVerifyingUploads();

    const session = await readSession(id);
    expect(session.status).toBe('failed');
    expect(session.verify_owner_token).toBeNull();
  });
});
