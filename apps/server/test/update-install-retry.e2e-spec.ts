import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AttemptJournal, acquireRecoveryGuard } from '@filestation/updater';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Request, Response } from 'express';
import { authenticator } from 'otplib';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AccountsService } from '../src/accounts/accounts.service';
import { AuditAction, AuditService } from '../src/audit/audit.service';
import { Authenticator } from '../src/auth/entities/authenticator.entity';
import { encryptSecret } from '../src/common/crypto/totp-secret-cipher';
import { setupFullApplication } from '../src/common/http/application-setup';
import { registerMaintenanceRequestLease } from '../src/maintenance/maintenance-admission.guard';
import { UpdateStatusController } from '../src/maintenance/update-status.controller';
import { WriteBarrierService } from '../src/maintenance/write-barrier.service';
import { UpdateCapabilityService } from '../src/updates/update-capability.service';
import { UpdateCheckService } from '../src/updates/update-check.service';
import { UpdateInstallCoordinator } from '../src/updates/update-install-coordinator';
import { UpdateOperationReservationService } from '../src/updates/update-operation-reservation.service';
import { UpdatePrepareService } from '../src/updates/update-prepare.service';
import { UpdateSpacePreflightService } from '../src/updates/update-space-preflight.service';
import { UPDATE_FETCH, UPDATE_INSTALL_EXECUTOR, UPDATE_JOURNAL_IDENTITY } from '../src/updates/updates.tokens';
import { initAndLogin, setupEnv, teardownEnv, TestEnv } from './helpers';
import { buildSafePublisherZip, createSignedManifestFixture } from './update-fixtures';

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('retry lifecycle did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('public update confirmation retry (composed services)', () => {
  let env: TestEnv;
  let app: INestApplication;
  let root: string;
  let token: string;
  let adminId: string;
  let selection: { version: string; manifest_sha256: string; artifact_sha256: string };
  let available: jest.Mock;
  let execute: jest.Mock;

  beforeEach(async () => {
    env = await setupEnv();
    root = await realpath(env.dir);
    process.env.FILESTATION_INSTALL_ROOT = root;
    const archive = buildSafePublisherZip();
    const signed = createSignedManifestFixture(archive);
    const candidate = { manifest: signed.manifest, artifact: signed.manifest.artifacts[0], manifest_sha256: signed.digest };
    selection = { version: candidate.manifest.version, manifest_sha256: candidate.manifest_sha256, artifact_sha256: candidate.artifact.sha256 };
    available = jest.fn(async () => undefined);
    execute = jest.fn(async () => undefined);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(UpdateCheckService).useValue({ resolveCandidate: async () => candidate })
      .overrideProvider(UpdateCapabilityService).useValue({ inspect: async () => ({ mode: 'managed', supported: true, install_root: root, platform: candidate.artifact.platform, updater_version: '0.2.5', reason: null }) })
      .overrideProvider(UpdateSpacePreflightService).useValue({ assertSufficient: async () => undefined })
      .overrideProvider(UPDATE_FETCH).useValue(async () => new globalThis.Response(archive, { status: 200, headers: { 'content-length': String(archive.length) } }))
      .overrideProvider(UPDATE_INSTALL_EXECUTOR).useValue({ assertAvailable: available, execute })
      .overrideProvider(UPDATE_JOURNAL_IDENTITY).useValue({ current: async () => ({ provider: 'windows-cim', value: 'retry-fixture-boot' }), processCreatedAt: async () => 'retry-fixture-created', isProcessAlive: async () => true })
      .compile();
    app = module.createNestApplication({ logger: false });
    setupFullApplication(app, app.get(ConfigService));
    await app.init();
    token = await initAndLogin(app);
    adminId = (await app.get(AccountsService).findByUsername('admin'))!.id;
  });

  afterEach(async () => {
    const coordinator = app.get(UpdateInstallCoordinator) as any;
    await app.close();
    // The synthetic executor does not exit this test process after maintenance.
    await coordinator.ownership?.recoveryGuard.release();
    await coordinator.operationReservation?.release();
    jest.restoreAllMocks();
    delete process.env.FILESTATION_INSTALL_ROOT;
    await teardownEnv(env);
  });

  async function pendingInstall(preparedId: string, totpCode?: string) {
    const response = new EventEmitter() as Response;
    const req = { user: { id: adminId }, ip: '127.0.0.1', headers: {} } as Request & { user: { id: string } };
    const state = registerMaintenanceRequestLease(req, response, await app.get(WriteBarrierService).acquire('http'));
    state.handlerStarted = true;
    try {
      const accepted = await app.get(UpdateStatusController).install({ prepared_id: preparedId, password: 'StrongP@ssw0rd', totp_code: totpCode }, req, response);
      return { response, accepted };
    } catch (error) {
      response.emit('close');
      throw error;
    } finally {
      state.handlerDone = true;
    }
  }

  it.each(['close-before-finish', 'executor-unavailable'])('prepares a new single-use receipt after %s and requires fresh password/TOTP', async failure => {
    const server = app.getHttpServer();
    const coordinator = app.get(UpdateInstallCoordinator);
    const barrier = app.get(WriteBarrierService);
    const audit = jest.spyOn(app.get(AuditService), 'record');
    const consume = jest.spyOn(app.get(UpdatePrepareService), 'consume');
    const first = await request(server).post('/api/v1/updates/prepare').set('Authorization', `Bearer ${token}`).send(selection).expect(201);
    const initial = await pendingInstall(first.body.prepared_id);
    expect(barrier.accepting).toBe(true);
    if (failure === 'close-before-finish') {
      initial.response.emit('close');
    } else {
      available.mockRejectedValueOnce(new Error('controlled unavailable executor'));
      initial.response.emit('finish');
      await waitFor(() => audit.mock.calls.some(([entry]) => entry.action === AuditAction.UPDATE_FAILED));
    }
    // Await only asynchronous abandonment cleanup, never call accept() directly
    // with a receipt the public controller has already consumed.
    await (coordinator as any).abandoning;
    expect(barrier.accepting).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    const abandoned = await AttemptJournal.inspect(root);
    expect(abandoned.phase).toBe('PREPARED');
    await expect(acquireRecoveryGuard(path.join(root, 'update.recovery.guard'))).rejects.toThrow();
    const reused = await request(server).post('/api/v1/updates/install').set('Authorization', `Bearer ${token}`).send({ prepared_id: first.body.prepared_id, password: 'StrongP@ssw0rd' }).expect(409);
    expect(reused.body.code).toBe('UPDATE_RECEIPT_INVALID');

    const fresh = await request(server).post('/api/v1/updates/prepare').set('Authorization', `Bearer ${token}`).send(selection).expect(201);
    expect(fresh.body.prepared_id).not.toBe(first.body.prepared_id);
    expect(await AttemptJournal.inspect(root)).toEqual(abandoned);
    await expect(acquireRecoveryGuard(path.join(root, 'update.recovery.guard'))).rejects.toThrow();
    initial.response.emit('finish');
    await new Promise(resolve => setImmediate(resolve));
    expect(execute).not.toHaveBeenCalled();
    expect(barrier.accepting).toBe(true);
    const secret = authenticator.generateSecret();
    await app.get(DataSource).getRepository(Authenticator).save({ id: randomUUID(), accountId: adminId, type: 'totp', name: 'retry fixture', totpSecretEncrypted: encryptSecret(secret, app.get(ConfigService).get<string>('app.jwtSecret')!), createdAt: Date.now(), lastUsedAt: null, isActive: 1 });
    const consumedBeforeReauth = consume.mock.calls.length;
    await request(server).post('/api/v1/updates/install').set('Authorization', `Bearer ${token}`).send({ prepared_id: fresh.body.prepared_id, password: 'wrong-fixture-password' }).expect(401);
    await request(server).post('/api/v1/updates/install').set('Authorization', `Bearer ${token}`).send({ prepared_id: fresh.body.prepared_id, password: 'StrongP@ssw0rd' }).expect(401);
    expect(consume).toHaveBeenCalledTimes(consumedBeforeReauth);
    expect(await AttemptJournal.inspect(root)).toEqual(abandoned);

    const replacement = await pendingInstall(fresh.body.prepared_id, authenticator.generate(secret));
    expect(replacement.accepted.attempt_id).not.toBe(initial.accepted.attempt_id);
    expect(replacement.accepted.fence).toBe(initial.accepted.fence + 1);
    expect(await app.get(UpdatePrepareService).consume(fresh.body.prepared_id)).toBeNull();
    expect(barrier.accepting).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    const history = (await readFile(path.join(root, 'update-attempt.journal'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(history.some(record => record.kind === 'completion' && record.phase === 'ABORTED' && record.context.attemptId === initial.accepted.attempt_id)).toBe(true);
    expect((await AttemptJournal.inspect(root)).phase).toBe('PREPARED');
    replacement.response.emit('finish');
    await waitFor(() => execute.mock.calls.length === 1);
    expect(barrier.accepting).toBe(false);
    expect((await AttemptJournal.inspect(root)).phase).toBe('MAINTENANCE');
  });

  it.each(['pending journal', 'maintenance started'])('retains both native guards when abandonment proof fails: %s', async mode => {
    const prepared = await request(app.getHttpServer()).post('/api/v1/updates/prepare').set('Authorization', `Bearer ${token}`).send(selection).expect(201);
    const initial = await pendingInstall(prepared.body.prepared_id);
    const coordinator = app.get(UpdateInstallCoordinator) as any;
    const snapshot = await AttemptJournal.inspect(root);
    if (mode === 'pending journal') {
      await coordinator.ownership.journal.appendIntent({ attemptId: snapshot.attemptId, fence: snapshot.fence, action: 'enter-maintenance', phase: 'MAINTENANCE' });
    } else {
      app.get(WriteBarrierService).enterMaintenance({ attemptId: snapshot.attemptId!, fence: snapshot.fence, installRoot: root, backupId: snapshot.backupId!, targetVersion: snapshot.targetVersion! });
    }
    const before = await AttemptJournal.inspect(root);
    initial.response.emit('close');
    await coordinator.abandoning?.catch(() => undefined);
    await expect(new UpdateOperationReservationService().acquire(root, 'prepare')).rejects.toThrow();
    await expect(acquireRecoveryGuard(path.join(root, 'update.recovery.guard'))).rejects.toThrow();
    expect(await AttemptJournal.inspect(root)).toEqual(before);
    expect(execute).not.toHaveBeenCalled();
  });
});
