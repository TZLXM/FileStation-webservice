import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'node:events';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AttemptJournal } from '@filestation/updater';
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
          },
        },
      ],
    }).compile();
    service = module.get(UpdateInstallCoordinator);
    journal = await AttemptJournal.open(root);
  });

  afterEach(async () => {
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

    const replacement = await service.accept(receipt);
    expect(replacement.attempt_id).not.toBe(accepted.attempt_id);
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
});
