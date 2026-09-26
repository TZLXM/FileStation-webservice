import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createHash } from 'crypto';
import { access, writeFile } from 'fs/promises';
import { createApp, initAndLogin, setupEnv, teardownEnv, type TestEnv } from './helpers';
import { FileLifecycleService } from '../src/files/file-lifecycle.service';
import { StorageService } from '../src/files/storage.service';
import { SettingsService } from '../src/settings/settings.service';
import { SqliteImmediateTransactionService } from '../src/common/database/sqlite-immediate-transaction.service';
import { UploadsService } from '../src/files/uploads.service';
import { File } from '../src/files/entities/file.entity';
import { UploadSession } from '../src/files/entities/upload-session.entity';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

async function waitForCondition(condition: () => boolean | Promise<boolean>, description: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
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

  it('keeps a recovery owner alive across a short lease while file inspection is gated', async () => {
    const content = Buffer.from('recovery-heartbeat-holds-lease');
    const { id } = await createUpload('recover-heartbeat.bin', content);
    const storedName = 'recovery-heartbeat-final';
    await writeFile(storage.getFinalPath(storedName), content);
    await markVerifying(id, storedName);

    const originalGetFileStats = storage.getFileStats.bind(storage);
    const inspectionEntered = deferred();
    const releaseInspection = deferred();
    const statsSpy = jest.spyOn(storage, 'getFileStats').mockImplementation(async (...args) => {
      inspectionEntered.resolve();
      await releaseInspection.promise;
      return originalGetFileStats(...args);
    });
    const originalLeaseMs = (lifecycle as any).verifyLeaseMs;
    const originalHeartbeatIntervalMs = (lifecycle as any).verifyHeartbeatIntervalMs;
    (lifecycle as any).verifyLeaseMs = 120;
    (lifecycle as any).verifyHeartbeatIntervalMs = 15;

    const recovery = lifecycle.recoverVerifyingUploads();
    let gateError: unknown;
    try {
      await inspectionEntered.promise;
      const claimed = await readSession(id);
      const claimedOwner = claimed.verify_owner_token;
      const originalLeaseUntil = claimed.verify_lease_until!;
      await waitForCondition(
        async () => Number((await readSession(id)).verify_lease_until) > originalLeaseUntil,
        'recovery heartbeat to extend its lease',
      );
      await waitForCondition(() => Date.now() > originalLeaseUntil, 'initial recovery lease to pass');
      expect(claimedOwner).not.toBe('expired-owner');

      const secondLifecycle = new FileLifecycleService(
        dataSource.getRepository(File),
        dataSource.getRepository(UploadSession),
        storage,
        app.get(SettingsService),
        dataSource,
        new SqliteImmediateTransactionService(app.get(ConfigService)),
      );
      (secondLifecycle as any).verifyLeaseMs = 120;
      (secondLifecycle as any).verifyHeartbeatIntervalMs = 15;
      await secondLifecycle.recoverVerifyingUploads();

      const afterCompetitor = await readSession(id);
      expect(afterCompetitor.verify_owner_token).toBe(claimedOwner);
      expect(afterCompetitor.status).toBe('verifying');
      expect(Number(afterCompetitor.verify_lease_until)).toBeGreaterThan(originalLeaseUntil);
      expect((lifecycle as any).activeVerifyHeartbeats?.size).toBe(1);
    } catch (error) {
      gateError = error;
    } finally {
      releaseInspection.resolve();
      statsSpy.mockRestore();
      (lifecycle as any).verifyLeaseMs = originalLeaseMs;
      (lifecycle as any).verifyHeartbeatIntervalMs = originalHeartbeatIntervalMs;
    }
    await recovery;
    if (gateError) throw gateError;
    expect((lifecycle as any).activeVerifyHeartbeats?.size).toBe(0);
    expect((await readSession(id)).status).toBe('completed');
  });

  it('aborts recovery I/O and does not publish after its lease owner is replaced', async () => {
    const content = Buffer.from('recovery-owner-loss-aborts-publish');
    const { id } = await createUpload('recover-owner-loss.bin', content);
    const storedName = 'recovery-owner-loss-final';
    await markVerifying(id, storedName);

    const originalCombine = storage.combineParts.bind(storage);
    const combineEntered = deferred();
    const releaseCombine = deferred();
    let combineSignal: AbortSignal | undefined;
    const combineSpy = jest.spyOn(storage, 'combineParts').mockImplementation(async (...args: any[]) => {
      combineSignal = args[3];
      combineEntered.resolve();
      await releaseCombine.promise;
      return originalCombine(args[0], args[1], args[2], combineSignal);
    });
    const originalLeaseMs = (lifecycle as any).verifyLeaseMs;
    const originalHeartbeatIntervalMs = (lifecycle as any).verifyHeartbeatIntervalMs;
    (lifecycle as any).verifyLeaseMs = 120;
    (lifecycle as any).verifyHeartbeatIntervalMs = 15;

    const recovery = lifecycle.recoverVerifyingUploads();
    let gateError: unknown;
    try {
      await combineEntered.promise;
      expect(combineSignal).toBeInstanceOf(AbortSignal);
      await dataSource.query(
        `UPDATE upload_sessions SET verify_owner_token = 'replacement-owner', verify_lease_until = ? WHERE id = ?`,
        [Date.now() + 60_000, id],
      );
      await waitForCondition(() => combineSignal!.aborted, 'lost recovery lease to abort active I/O');
    } catch (error) {
      gateError = error;
    } finally {
      releaseCombine.resolve();
      combineSpy.mockRestore();
      (lifecycle as any).verifyLeaseMs = originalLeaseMs;
      (lifecycle as any).verifyHeartbeatIntervalMs = originalHeartbeatIntervalMs;
    }
    await recovery;
    if (gateError) throw gateError;

    expect((await readSession(id)).verify_owner_token).toBe('replacement-owner');
    expect((await readSession(id)).status).toBe('verifying');
    expect(await storage.fileExists(storedName)).toBe(false);
    await expect(access(storage.getFinalPath(`${storedName}.tmp`))).rejects.toThrow();
    const [files] = await dataSource.query(`SELECT COUNT(*) AS count FROM files WHERE stored_name = ?`, [storedName]);
    expect(Number(files.count)).toBe(0);
    expect((lifecycle as any).activeVerifyHeartbeats?.size).toBe(0);
  });

  it('keeps normal complete ownership heartbeating through settings lookup and stage-three commit', async () => {
    const content = Buffer.from('complete-heartbeat-spans-stage-three');
    const { id, token } = await createUpload('complete-heartbeat.bin', content);
    const uploads = app.get(UploadsService) as any;
    const originalLeaseMs = uploads.verifyLeaseMs;
    const originalHeartbeatIntervalMs = uploads.verifyHeartbeatIntervalMs;
    uploads.verifyLeaseMs = 120;
    uploads.verifyHeartbeatIntervalMs = 15;

    const settings = app.get(SettingsService);
    const originalGetSettings = settings.getStorageSettings.bind(settings);
    const settingsEntered = deferred();
    const releaseSettings = deferred();
    const settingsSpy = jest.spyOn(settings, 'getStorageSettings').mockImplementation(async () => {
      settingsEntered.resolve();
      await releaseSettings.promise;
      return originalGetSettings();
    });

    const completion = request(app.getHttpServer())
      .post(`/api/v1/uploads/${id}/complete`)
      .set('X-Upload-Token', token)
      .send({})
      .then((result) => result);
    let gateError: unknown;
    try {
      await settingsEntered.promise;
      const claimed = await readSession(id);
      const claimedOwner = claimed.verify_owner_token;
      const leaseAtGate = Number(claimed.verify_lease_until);
      await waitForCondition(
        async () => Number((await readSession(id)).verify_lease_until) > leaseAtGate,
        'normal complete heartbeat to extend its lease after stage-two work',
      );
      await waitForCondition(() => Date.now() > leaseAtGate, 'initial complete lease to pass');
      expect(claimedOwner).toBeTruthy();

      const competitor = new FileLifecycleService(
        dataSource.getRepository(File),
        dataSource.getRepository(UploadSession),
        storage,
        settings,
        dataSource,
        new SqliteImmediateTransactionService(app.get(ConfigService)),
      );
      await competitor.recoverVerifyingUploads();
      const afterCompetitor = await readSession(id);
      expect(afterCompetitor.verify_owner_token).toBe(claimedOwner);
      expect(afterCompetitor.status).toBe('verifying');
    } catch (error) {
      gateError = error;
    } finally {
      releaseSettings.resolve();
      settingsSpy.mockRestore();
      uploads.verifyLeaseMs = originalLeaseMs;
      uploads.verifyHeartbeatIntervalMs = originalHeartbeatIntervalMs;
    }
    const response = await completion;
    if (gateError) throw gateError;
    expect(response.status).toBe(201);
    expect((await readSession(id)).status).toBe('completed');
  });

  it('does not publish a normal completion after the verifying owner is replaced', async () => {
    const content = Buffer.from('complete-owner-loss-aborts-publish');
    const { id, token } = await createUpload('complete-owner-loss.bin', content);
    const uploads = app.get(UploadsService) as any;
    const originalLeaseMs = uploads.verifyLeaseMs;
    const originalHeartbeatIntervalMs = uploads.verifyHeartbeatIntervalMs;
    uploads.verifyLeaseMs = 120;
    uploads.verifyHeartbeatIntervalMs = 15;

    const originalCombine = storage.combineParts.bind(storage);
    const combineEntered = deferred();
    const releaseCombine = deferred();
    let combineSignal: AbortSignal | undefined;
    const combineSpy = jest.spyOn(storage, 'combineParts').mockImplementation(async (...args: any[]) => {
      combineSignal = args[3];
      combineEntered.resolve();
      await releaseCombine.promise;
      return originalCombine(args[0], args[1], args[2], combineSignal);
    });
    const completion = request(app.getHttpServer())
      .post(`/api/v1/uploads/${id}/complete`)
      .set('X-Upload-Token', token)
      .send({})
      .then((result) => result);
    let gateError: unknown;
    try {
      await combineEntered.promise;
      expect(combineSignal).toBeInstanceOf(AbortSignal);
      await dataSource.query(
        `UPDATE upload_sessions SET verify_owner_token = 'replacement-complete-owner', verify_lease_until = ? WHERE id = ?`,
        [Date.now() + 60_000, id],
      );
      await waitForCondition(() => combineSignal!.aborted, 'lost complete lease to abort active I/O');
    } catch (error) {
      gateError = error;
    } finally {
      releaseCombine.resolve();
      combineSpy.mockRestore();
      uploads.verifyLeaseMs = originalLeaseMs;
      uploads.verifyHeartbeatIntervalMs = originalHeartbeatIntervalMs;
    }
    const response = await completion;
    if (gateError) throw gateError;

    const session = await readSession(id);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(session.status).toBe('verifying');
    expect(session.verify_owner_token).toBe('replacement-complete-owner');
    const [{ final_stored_name: storedName }] = await dataSource.query(
      `SELECT final_stored_name FROM upload_sessions WHERE id = ?`,
      [id],
    );
    expect(await storage.fileExists(storedName)).toBe(false);
    await expect(access(storage.getFinalPath(`${storedName}.tmp`))).rejects.toThrow();
    const [files] = await dataSource.query(`SELECT COUNT(*) AS count FROM files WHERE stored_name = ?`, [storedName]);
    expect(Number(files.count)).toBe(0);
    expect(uploads.activeVerifyHeartbeats.size).toBe(0);
  });
});
