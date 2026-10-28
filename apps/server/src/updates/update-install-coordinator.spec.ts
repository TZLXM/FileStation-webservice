import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'node:events';
import {
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AttemptJournal, JournalRecord, NodeDurableFileSystem } from '@filestation/updater';
import { Response } from 'express';
import { AuditAction, AuditService } from '../audit/audit.service';
import {
  MaintenanceLeaseRequest,
  registerMaintenanceRequestLease,
} from '../maintenance/maintenance-admission.guard';
import { WriteBarrierService } from '../maintenance/write-barrier.service';
import { WriteFreezeService } from '../maintenance/write-freeze.service';
import {
  UpdateCapabilityService,
} from './update-capability.service';
import {
  RefusingUpdateInstallExecutor,
  UpdateInstallExecutor,
} from './update-install-coordinator';
import { UpdateInstallCoordinator } from './update-install-coordinator';
import {
  UPDATE_JOURNAL_IDENTITY,
  UPDATE_INSTALL_EXECUTOR,
  UPDATE_NOW,
  UPDATE_PRODUCT_VERSION,
  UPDATE_RANDOM_ID,
} from './updates.tokens';
import {
  PreparedUpdateReceipt,
  UpdateCapability,
} from './update-types';

function readyCapability(root: string): UpdateCapability {
  return {
    mode: 'managed',
    supported: true,
    install_root: root,
    updater_version: '0.2.0',
    platform: 'windows-x64',
    reason: null,
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for coordinator');
}

describe('UpdateInstallCoordinator', () => {
  let root: string;
  let staging: string;
  let now: number;
  let capability: UpdateCapability;
  let barrier: WriteBarrierService;
  let journal: AttemptJournal;
  let executor: UpdateInstallExecutor;
  let audit: { record: jest.Mock };
  let service: UpdateInstallCoordinator;
  let receipt: PreparedUpdateReceipt;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'filestation-install-'));
    staging = path.join(
      root,
      '.filestation-update-staging',
      'fixture',
      'payload',
    );
    await mkdir(staging, { recursive: true });
    now = Date.parse('2026-10-28T00:00:00.000Z');
    capability = readyCapability(root);
    barrier = new WriteBarrierService(new WriteFreezeService());
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    executor = {
      assertAvailable: jest.fn().mockResolvedValue(undefined),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    receipt = Object.freeze({
      prepared_id: '07523e2b-37ee-40cb-980f-cce36310e45f',
      manifest_sha256: 'a'.repeat(64),
      artifact_sha256: 'b'.repeat(64),
      version: '0.2.5',
      platform: 'windows-x64',
      arch: 'x64',
      staging_path: await realpath(staging),
      verified_size: 120,
      unpacked_size: 64,
      expires_at: now + 15 * 60 * 1000,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UpdateInstallCoordinator,
        { provide: WriteBarrierService, useValue: barrier },
        {
          provide: UpdateCapabilityService,
          useValue: { inspect: jest.fn(async () => capability) },
        },
        { provide: AuditService, useValue: audit },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'app.updateJournalRoot' ? root : undefined,
            ),
          },
        },
        { provide: UPDATE_INSTALL_EXECUTOR, useValue: executor },
        { provide: UPDATE_NOW, useValue: () => now },
        { provide: UPDATE_PRODUCT_VERSION, useValue: '0.2.0' },
        {
          provide: UPDATE_RANDOM_ID,
          useValue: jest
            .fn()
            .mockReturnValueOnce('attempt-task-8')
            .mockReturnValueOnce('backup-task-8')
            .mockReturnValue('record-task-8'),
        },
        {
          provide: UPDATE_JOURNAL_IDENTITY,
          useValue: {
            current: async () => ({
              provider: 'windows-cim',
              value: 'win32:fixture',
            }),
            processCreatedAt: async () => 'win32:process',
            isProcessAlive: async () => true,
          },
        },
      ],
    }).compile();
    service = module.get(UpdateInstallCoordinator);
    journal = await AttemptJournal.open(root);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    const context = (executor.execute as jest.Mock).mock.calls[0]?.[0];
    await context?.ownership.recoveryGuard.release();
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('records PREPARED but waits for both response finish and request lease release', async () => {
    const accepted = await service.accept(receipt);
    expect((await AttemptJournal.inspect(root)).phase).toBe('PREPARED');

    const response = new EventEmitter() as Response;
    const request = {} as MaintenanceLeaseRequest;
    const lease = await barrier.acquire('http');
    const originalRelease = lease.release.bind(lease);
    const events: string[] = [];
    jest.spyOn(lease, 'release').mockImplementation(() => {
      events.push('lease-release');
      originalRelease();
    });
    executor.execute = jest.fn(async () => {
      events.push('executor');
      expect(barrier.currentAttempt).toMatchObject({
        attemptId: accepted.attempt_id,
        fence: accepted.fence,
      });
    });
    const state = registerMaintenanceRequestLease(request, response, lease);
    state.handlerStarted = true;
    state.handlerDone = true;

    service.scheduleAfterResponse(accepted.attempt, response);
    expect(barrier.accepting).toBe(true);
    expect(executor.execute).not.toHaveBeenCalled();

    response.emit('finish');
    await waitFor(() => events.includes('executor'));

    expect(events).toEqual(['lease-release', 'executor']);
    expect(barrier.accepting).toBe(false);
    expect((await AttemptJournal.inspect(root)).phase).toBe('MAINTENANCE');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.UPDATE_MAINTENANCE,
        resourceId: accepted.attempt_id,
      }),
    );
  });

  it('does not enter maintenance or execute after a response close', async () => {
    const accepted = await service.accept(receipt);
    const response = new EventEmitter() as Response;
    const request = {} as MaintenanceLeaseRequest;
    const lease = await barrier.acquire('http');
    const state = registerMaintenanceRequestLease(request, response, lease);
    state.handlerStarted = true;
    state.handlerDone = true;
    service.scheduleAfterResponse(accepted.attempt, response);

    response.emit('close');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(barrier.accepting).toBe(true);
    expect(executor.execute).not.toHaveBeenCalled();
    expect((await AttemptJournal.inspect(root)).phase).toBe('PREPARED');

    let resume!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { resume = resolve; });
    const appending = new Promise<void>((resolve) => { entered = resolve; });
    const append = NodeDurableFileSystem.prototype.append;
    jest.spyOn(NodeDurableFileSystem.prototype, 'append').mockImplementationOnce(async function (this: NodeDurableFileSystem, ...args) {
      entered();
      await waiting;
      return append.apply(this, args);
    });
    const replacing = service.accept(receipt);
    await appending;
    try {
      await expect(service.accept(receipt)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'UPDATE_IN_PROGRESS' }),
      });
    } finally { resume(); }
    const replacement = await replacing;
    expect(replacement.attempt_id).not.toBe(accepted.attempt_id);
    expect(replacement.fence).toBe(accepted.fence + 1);
    // inspect validates every record/checksum but exposes only this attempt's records.
    const snapshot = await AttemptJournal.inspect(root);
    const history: JournalRecord[] = (await readFile(journal.filename, 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(history.map((record) => record.seq)).toEqual([1, 2, 3, 4]);
    expect(history.filter((record) => record.kind === 'attempt').map((record) => record.context.fence))
      .toEqual([accepted.fence, replacement.fence]);
    expect(history[2]).toMatchObject({ kind: 'completion', phase: 'ABORTED', context: { attemptId: accepted.attempt_id } });
    expect(snapshot).toMatchObject({ sequence: 4, attemptId: replacement.attempt_id, fence: replacement.fence, phase: 'PREPARED', pending: null });
    expect(snapshot.records).toHaveLength(1);
    expect((await AttemptJournal.inspect(root)).phase).toBe('PREPARED');
  });

  it('leaves PREPARED untouched when the Task 9 executor refuses availability', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UpdateInstallCoordinator,
        { provide: WriteBarrierService, useValue: barrier },
        {
          provide: UpdateCapabilityService,
          useValue: { inspect: jest.fn(async () => capability) },
        },
        { provide: AuditService, useValue: audit },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'app.updateJournalRoot' ? root : undefined,
            ),
          },
        },
        {
          provide: UPDATE_INSTALL_EXECUTOR,
          useClass: RefusingUpdateInstallExecutor,
        },
        { provide: UPDATE_NOW, useValue: () => now },
        { provide: UPDATE_PRODUCT_VERSION, useValue: '0.2.0' },
        {
          provide: UPDATE_RANDOM_ID,
          useValue: jest
            .fn()
            .mockReturnValueOnce('attempt-refusal')
            .mockReturnValueOnce('backup-refusal')
            .mockReturnValue('record-refusal'),
        },
        {
          provide: UPDATE_JOURNAL_IDENTITY,
          useValue: {
            current: async () => ({
              provider: 'windows-cim',
              value: 'win32:fixture',
            }),
            processCreatedAt: async () => 'win32:process',
            isProcessAlive: async () => true,
          },
        },
      ],
    }).compile();
    const refusing = module.get(UpdateInstallCoordinator);
    const accepted = await refusing.accept(receipt);
    const response = new EventEmitter() as Response;
    const request = {} as MaintenanceLeaseRequest;
    const lease = await barrier.acquire('http');
    const state = registerMaintenanceRequestLease(request, response, lease);
    state.handlerStarted = true;
    state.handlerDone = true;

    refusing.scheduleAfterResponse(accepted.attempt, response);
    response.emit('finish');
    await waitFor(() =>
      audit.record.mock.calls.some(
        ([entry]) => entry.action === AuditAction.UPDATE_FAILED,
      ),
    );

    expect(barrier.accepting).toBe(true);
    expect((await AttemptJournal.inspect(root)).phase).toBe('PREPARED');
    await module.close();
  });

  it('rejects an expired receipt or one that no longer targets this platform', async () => {
    now = receipt.expires_at;
    await expect(service.accept(receipt)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'UPDATE_RECEIPT_EXPIRED' }),
    });

    now = receipt.expires_at - 1;
    capability = readyCapability(root);
    capability = {
      ...capability,
      platform: 'linux-x64',
    };
    await expect(service.accept(receipt)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'UPDATE_PLATFORM_CHANGED' }),
    });
  });
  it('admits only one distinct receipt across independent coordinators', async () => {
    const other = new UpdateInstallCoordinator(
      { get: () => root } as unknown as ConfigService, barrier,
      { inspect: async () => capability } as UpdateCapabilityService,
      audit as unknown as AuditService, executor,
      { current: async () => ({ provider: 'windows-cim', value: 'win32:fixture' }),
        processCreatedAt: async () => 'win32:process', isProcessAlive: async () => true },
      () => now, '0.2.0', () => 'competing-attempt',
    );
    let resume!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { resume = resolve; });
    const appending = new Promise<void>((resolve) => { entered = resolve; });
    const append = NodeDurableFileSystem.prototype.append;
    jest.spyOn(NodeDurableFileSystem.prototype, 'append').mockImplementationOnce(async function (this: NodeDurableFileSystem, ...args) {
      entered();
      await waiting;
      return append.apply(this, args);
    });
    const first = service.accept(receipt);
    await appending;
    const second = await Promise.allSettled([
      other.accept(Object.freeze({ ...receipt, prepared_id: 'other-receipt' })),
    ]);
    resume();
    const results = [...await Promise.allSettled([first]), ...second];
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(second[0]).toMatchObject({ status: 'rejected', reason: { response: { code: 'UPDATE_IN_PROGRESS' } } });
    const snapshot = await AttemptJournal.inspect(root);
    expect(snapshot.phase).toBe('PREPARED');
    expect(snapshot.records).toHaveLength(1);
  });

  it.each([
    ['live foreign PID', process.pid + 10000, 'foreign-created'],
    ['dead foreign PID', process.pid + 20000, 'dead-created'],
    ['reused PID', process.pid, 'old-created'],
    ['restarted coordinator with same process identity', process.pid, 'win32:process'],
    ['unknown creation identity', process.pid + 30000, 'unknown'],
  ])('refuses %s without mutating PREPARED, including expired heartbeat', async (_name, pid, created) => {
    await journal.beginAttempt({
      attemptId: 'prior-attempt', fence: 1, currentVersion: '0.2.0',
      targetVersion: '0.2.5', phase: 'PREPARED', backupId: 'prior-backup',
      owner: { bootIdentity: 'win32:fixture', pid,
        processCreatedAt: created, heartbeatAt: '2020-01-01T00:00:00.000Z' },
    });
    const before = await AttemptJournal.inspect(root);
    await expect(service.accept(receipt)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'UPDATE_IN_PROGRESS' }),
    });
    expect(await AttemptJournal.inspect(root)).toEqual(before);
  });

});
