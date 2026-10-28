import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Response } from 'express';
import {
  AttemptJournal,
  AttemptJournalSnapshot,
  UpdateCapabilityAuthority,
  acquireRecoveryGuard,
  encodeInheritedCapability,
  RecoveryGuard,
  LockHandle,
  UpdateLock,
} from '@filestation/updater';
import { AuditAction, AuditService } from '../audit/audit.service';
import { waitForResponseAndLeaseRelease } from '../maintenance/maintenance-admission.guard';
import { WriteBarrierService } from '../maintenance/write-barrier.service';
import { MaintenanceAttempt } from '../maintenance/write-freeze.service';
import { UpdateCapabilityService } from './update-capability.service';
import { ApplicationShutdownService } from './application-shutdown.service';
import { DatabaseSnapshotService } from './database-snapshot.service';
import { HANDOFF_SPAWNER, HandoffSpawner } from './handoff-spawner';
import { HandoffProgress, ShutdownCoordinator } from './shutdown-coordinator';
import {
  UPDATE_INSTALL_EXECUTOR,
  UPDATE_JOURNAL_IDENTITY,
  UPDATE_NOW,
  UPDATE_PRODUCT_VERSION,
  UPDATE_RANDOM_ID,
} from './updates.tokens';
import {
  InstallAcceptance,
  PreparedUpdateReceipt,
  UpdateCapability,
  UpdateJournalIdentity,
} from './update-types';

export const UPDATE_INSTALL_EXECUTOR_CONTRACT_VERSION = 2 as const;

export interface UpdateInstallContext {
  readonly contract_version: typeof UPDATE_INSTALL_EXECUTOR_CONTRACT_VERSION;
  readonly attempt: Readonly<MaintenanceAttempt>;
  readonly receipt: PreparedUpdateReceipt;
  readonly onProgress?: (phase: HandoffProgress) => void;
  /** Exclusive writer authority retained across app.close(). Task 9 must keep
   * the guard until this process exits; the child then uses fenced recovery.
   * Never release either handle merely because execute() returned. */
  readonly ownership: Readonly<{
    lock: LockHandle;
    journal: AttemptJournal;
    recoveryGuard: RecoveryGuard;
  }>;
}

export interface UpdateInstallExecutor {
  assertAvailable(): Promise<void>;
  execute(context: UpdateInstallContext): Promise<void>;
}

interface HandoffExecution {
  readonly ownership: Readonly<{
    lock: LockHandle;
    journal: AttemptJournal;
    recoveryGuard: RecoveryGuard;
  }>;
  readonly receipt: PreparedUpdateReceipt;
  readonly onProgress?: (phase: HandoffProgress) => void;
}

export class UpdateInstallExecutorUnavailableError extends Error {
  readonly code = 'UPDATE_INSTALL_EXECUTOR_UNAVAILABLE';

  constructor() {
    super(
      'The Task 9 update executor is not wired; the attempt remains PREPARED',
    );
    this.name = 'UpdateInstallExecutorUnavailableError';
  }
}

@Injectable()
export class RefusingUpdateInstallExecutor implements UpdateInstallExecutor {
  async assertAvailable(): Promise<void> {
    throw new UpdateInstallExecutorUnavailableError();
  }

  async execute(_context: UpdateInstallContext): Promise<void> {
    throw new UpdateInstallExecutorUnavailableError();
  }
}

@Injectable()
export class HandoffUpdateInstallExecutor
  implements UpdateInstallExecutor
{
  constructor(
    private readonly config: ConfigService,
    private readonly capability: UpdateCapabilityService,
    private readonly snapshot: DatabaseSnapshotService,
    private readonly barrier: WriteBarrierService,
    private readonly shutdown: ApplicationShutdownService,
    @Inject(HANDOFF_SPAWNER)
    private readonly spawner: HandoffSpawner,
  ) {}

  async assertAvailable(): Promise<void> {
    const capability = await this.capability.inspect();
    if (
      capability.mode !== 'managed' ||
      !capability.supported ||
      !capability.install_root
    ) {
      throw new UpdateInstallExecutorUnavailableError();
    }
  }

  async execute(context: UpdateInstallContext): Promise<void> {
    if (
      context.contract_version !== UPDATE_INSTALL_EXECUTOR_CONTRACT_VERSION ||
      !context.attempt ||
      !context.receipt ||
      !context.ownership
    ) {
      throw new Error('Task 8 update executor contract v2 is required');
    }
    await context.ownership.recoveryGuard.assertActive();
    await context.ownership.lock.assertActive();
    await this.runHandoff(context.attempt, {
      ownership: context.ownership,
      receipt: context.receipt,
      onProgress: context.onProgress,
    });
  }

  protected async runHandoff(
    attempt: UpdateInstallContext['attempt'],
    execution: HandoffExecution,
  ): Promise<void> {
    const databasePath = this.config.get<string>('app.dbPath');
    if (!databasePath || !path.isAbsolute(databasePath)) {
      throw new Error('update requires an absolute database path');
    }
    const intent = await execution.ownership.journal.appendIntent({
      attemptId: attempt.attemptId,
      fence: attempt.fence,
      action: 'prepare-update',
      phase: 'MAINTENANCE',
      payload: {
        stagingPath: execution.receipt.staging_path,
        targetVersion: execution.receipt.version,
        artifactSha256: execution.receipt.artifact_sha256,
        manifestSha256: execution.receipt.manifest_sha256,
        databasePath,
      },
    });
    await execution.ownership.journal.appendCompletion({
      attemptId: attempt.attemptId,
      fence: attempt.fence,
      intentId: intent.id,
      phase: 'MAINTENANCE',
    });
    const authority = new UpdateCapabilityAuthority();
    const inheritedCapability = encodeInheritedCapability(authority);
    try {
      const coordinator = new ShutdownCoordinator({
        journalRoot: attempt.installRoot,
        journal: execution.ownership.journal,
        barrier: this.barrier,
        snapshot: this.snapshot,
        spawner: this.spawner,
        channel: { close: async () => undefined },
        handoffCapability: inheritedCapability,
        closeApplication: () => this.shutdown.close(),
        onProgress: execution.onProgress,
      });
      await coordinator.handoff(attempt);
    } finally {
      // Keep the capability only in memory until the OS pipe copy is complete.
      inheritedCapability.fill(0);
    }
  }
}

function within(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function ioFailure(code: string, message: string): ConflictException {
  return new ConflictException({ code, message });
}

@Injectable()
export class UpdateInstallCoordinator implements OnModuleDestroy {
  private readonly logger = new Logger(UpdateInstallCoordinator.name);
  private readonly receipts = new Map<string, PreparedUpdateReceipt>();
  private readonly abandonedAttempts = new Set<string>();
  private ownership?: {
    root: string;
    attemptId: string;
    lock: LockHandle;
    journal: AttemptJournal;
    recoveryGuard: RecoveryGuard;
  };
  private changing = false;
  private stopped = false;
  private handedOff = false;
  private readonly scheduled = new Set<string>();
  private accepting?: Promise<InstallAcceptance>;

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await this.accepting?.catch(() => undefined);
    // The durable owner record stays for manual/fenced recovery after restart.
    // An executor may call app.close(); its writer guard must survive that call.
    if (!this.handedOff) await this.ownership?.recoveryGuard.release();
  }

  constructor(
    private readonly config: ConfigService,
    private readonly barrier: WriteBarrierService,
    private readonly capability: UpdateCapabilityService,
    private readonly audit: AuditService,
    @Inject(UPDATE_INSTALL_EXECUTOR)
    private readonly executor: UpdateInstallExecutor,
    @Inject(UPDATE_JOURNAL_IDENTITY)
    private readonly identity: UpdateJournalIdentity,
    @Inject(UPDATE_NOW) private readonly now: () => number,
    @Inject(UPDATE_PRODUCT_VERSION) private readonly productVersion: string,
    @Inject(UPDATE_RANDOM_ID) private readonly randomId: () => string,
  ) {}

  async accept(receipt: PreparedUpdateReceipt): Promise<InstallAcceptance> {
    if (
      this.changing || this.stopped ||
      (this.ownership && !this.abandonedAttempts.has(this.ownership.attemptId))
    ) {
      throw ioFailure('UPDATE_IN_PROGRESS', 'Update ownership is unavailable');
    }
    this.changing = true;
    const pending = this.acceptOwned(receipt);
    this.accepting = pending;
    try {
      return await pending;
    } finally {
      this.changing = false;
      this.accepting = undefined;
    }
  }

  private async acceptOwned(
    receipt: PreparedUpdateReceipt,
  ): Promise<InstallAcceptance> {
    if (!Object.isFrozen(receipt)) {
      throw ioFailure(
        'UPDATE_RECEIPT_INVALID',
        'Prepared update receipt is invalid',
      );
    }
    if (receipt.expires_at <= this.now()) {
      throw ioFailure(
        'UPDATE_RECEIPT_EXPIRED',
        'Prepared update receipt has expired',
      );
    }
    const capability = await this.capability.inspect();
    const root = await this.validateCapability(capability, receipt);
    await this.validateStaging(root, receipt);
    if (!this.barrier.accepting) {
      throw ioFailure(
        'UPDATE_IN_PROGRESS',
        'Another update attempt already owns maintenance',
      );
    }

    const journalRoot = this.journalRoot(root);
    // The same kernel guard used by Task 5 recovery excludes other coordinators,
    // processes and recovery writers before journal open/read/abort/begin.
    let recoveryGuard: RecoveryGuard;
    try {
      if (this.ownership) {
        if (
          this.ownership.root !== journalRoot ||
          !this.abandonedAttempts.has(this.ownership.attemptId)
        ) {
          throw new Error('owner is not abandoned');
        }
        recoveryGuard = this.ownership.recoveryGuard;
        await recoveryGuard.assertActive();
        await this.ownership.lock.assertActive();
      } else {
        recoveryGuard = await acquireRecoveryGuard(
          path.join(journalRoot, 'update.recovery.guard'),
        );
      }
    } catch {
      throw ioFailure(
        'UPDATE_IN_PROGRESS',
        'Exclusive update ownership is unavailable',
      );
    }
    let attempt: MaintenanceAttempt;
    let acceptedAt: string;
    let attemptId: string;
    try {
      const journal =
        this.ownership?.journal ?? await AttemptJournal.open(journalRoot);
      let snapshot = await journal.readSnapshot();
      if (this.ownership) {
        const previous = this.ownership;
        if (
          snapshot.attemptId !== previous.attemptId ||
          snapshot.fence !== previous.lock.fence ||
          snapshot.phase !== 'PREPARED' || snapshot.pending
        ) {
          throw new Error('abandoned owner no longer matches PREPARED');
        }
        const intent = await journal.appendIntent({
          attemptId: previous.attemptId,
          fence: previous.lock.fence,
          action: 'abort-abandoned-prepared',
          phase: 'ABORTED',
          payload: { reason: 'fresh-admin-confirmation' },
        });
        await journal.appendCompletion({
          attemptId: previous.attemptId,
          fence: previous.lock.fence,
          intentId: intent.id,
          phase: 'ABORTED',
        });
        await previous.lock.release();
        this.receipts.delete(previous.attemptId);
        this.abandonedAttempts.delete(previous.attemptId);
        this.ownership = undefined;
        snapshot = await journal.readSnapshot();
      }
      // Foreign, restarted, dead and unverifiable owners all require explicit
      // recovery. Neither PID difference nor heartbeat expiry proves death.
      if (
        snapshot.initialized &&
        (!this.terminal(snapshot.phase) || snapshot.pending)
      ) {
        throw new Error('existing attempt requires manual recovery');
      }
      const boot = await this.identity.current();
      const createdAt = await this.identity.processCreatedAt(process.pid);
      acceptedAt = new Date(this.now()).toISOString();
      attemptId = this.randomId();
      const backupId = `update-${this.randomId()}`.slice(0, 128);
      const lock = await UpdateLock.acquire(
        journalRoot,
        {
          attemptId,
          bootIdentity: boot.value,
          pid: process.pid,
          processCreatedAt: createdAt,
          heartbeatAt: acceptedAt,
          currentVersion: this.productVersion,
          targetVersion: receipt.version,
          backupId,
        },
        { journal, identityProvider: this.identity },
      );
      this.ownership = { root: journalRoot, attemptId, journal, lock, recoveryGuard };
      attempt = {
        attemptId,
        fence: lock.fence,
        installRoot: root,
        backupId,
        targetVersion: receipt.version,
      };
    } catch {
      if (!this.ownership) await recoveryGuard.release();
      throw ioFailure(
        'UPDATE_IN_PROGRESS',
        'Update ownership requires manual recovery or is already held',
      );
    }
    this.receipts.set(attemptId, receipt);
    await this.audit.record({
      accountId: null,
      action: AuditAction.UPDATE_CONFIRMED,
      resourceType: 'update',
      resourceId: attemptId,
      details: {
        target_version: receipt.version,
        manifest_sha256: receipt.manifest_sha256,
        artifact_sha256: receipt.artifact_sha256,
      },
    });
    return {
      attempt,
      attempt_id: attemptId,
      fence: attempt.fence,
      prepared_id: receipt.prepared_id,
      phase: 'PREPARED',
      accepted_at: acceptedAt,
    };
  }

  scheduleAfterResponse(attempt: MaintenanceAttempt, response: Response): void {
    if (
      this.stopped || this.ownership?.attemptId !== attempt.attemptId ||
      this.ownership.lock.fence !== attempt.fence ||
      this.scheduled.has(attempt.attemptId)
    ) return;
    this.scheduled.add(attempt.attemptId);
    let finished = false;
    response.once('finish', () => {
      finished = true;
    });
    response.once('close', () => {
      if (!finished) this.abandonedAttempts.add(attempt.attemptId);
    });
    void this.runAfterResponse(attempt, response).catch(() => {
      this.logger.warn('update install handoff failed closed');
    });
  }

  private async runAfterResponse(
    attempt: MaintenanceAttempt,
    response: Response,
  ): Promise<void> {
    await waitForResponseAndLeaseRelease(response);
    if (
      !this.barrier.accepting || this.stopped || this.changing ||
      this.ownership?.attemptId !== attempt.attemptId ||
      this.abandonedAttempts.has(attempt.attemptId)
    ) return;
    this.changing = true;
    this.handedOff = true;
    try {
      const ownership = this.ownership;
      await ownership.recoveryGuard.assertActive();
      await ownership.lock.assertActive();
      const receipt = this.receipts.get(attempt.attemptId);
      if (!receipt) {
        await this.recordFailure(attempt, 'RECEIPT_NOT_AVAILABLE');
        return;
      }
      try {
        await this.executor.assertAvailable();
      } catch {
        this.handedOff = false;
        this.abandonedAttempts.add(attempt.attemptId);
        await this.audit.record({
          accountId: null,
          action: AuditAction.UPDATE_FAILED,
          resourceType: 'update',
          resourceId: attempt.attemptId,
          details: { reason: 'INSTALL_EXECUTOR_UNAVAILABLE' },
        });
        return;
      }

      if (this.stopped) return;
      await this.audit.record({
        accountId: null,
        action: AuditAction.UPDATE_MAINTENANCE,
        resourceType: 'update',
        resourceId: attempt.attemptId,
        details: { target_version: attempt.targetVersion },
      });
      if (this.stopped) return;
      this.barrier.enterMaintenance(attempt);
      const journal = ownership.journal;
      const intent = await journal.appendIntent({
        attemptId: attempt.attemptId,
        fence: attempt.fence,
        action: 'enter-maintenance',
        phase: 'MAINTENANCE',
      });
      await journal.appendCompletion({
        attemptId: attempt.attemptId,
        fence: attempt.fence,
        intentId: intent.id,
        phase: 'MAINTENANCE',
      });

      let progress: HandoffProgress | undefined;
      try {
        await this.executor.execute({
          contract_version: UPDATE_INSTALL_EXECUTOR_CONTRACT_VERSION,
          attempt: Object.freeze({ ...attempt }),
          receipt,
          onProgress: (phase) => { progress = phase; },
          ownership: Object.freeze({
            lock: ownership.lock,
            journal,
            recoveryGuard: ownership.recoveryGuard,
          }),
        });
      } catch {
        if (progress === 'pre-freeze') {
          await this.abortBeforeFreeze(attempt);
        } else {
          await this.recordFailure(attempt, 'INSTALL_EXECUTOR_FAILED');
        }
      }
    } finally {
      this.changing = false;
    }
  }

  private async validateCapability(
    capability: UpdateCapability,
    receipt: PreparedUpdateReceipt,
  ): Promise<string> {
    if (
      capability.mode !== 'managed' ||
      !capability.supported ||
      !capability.install_root
    ) {
      throw ioFailure(
        capability.reason ?? 'UPDATE_UNSUPPORTED',
        'This installation cannot start an update',
      );
    }
    if (
      capability.platform !== receipt.platform ||
      process.arch !== receipt.arch
    ) {
      throw ioFailure(
        'UPDATE_PLATFORM_CHANGED',
        'The prepared update no longer targets this platform',
      );
    }
    return path.resolve(capability.install_root);
  }

  private async validateStaging(
    root: string,
    receipt: PreparedUpdateReceipt,
  ): Promise<void> {
    const stagingRoot = path.join(root, '.filestation-update-staging');
    const actual = await realpath(receipt.staging_path);
    if (
      actual !== receipt.staging_path ||
      !within(stagingRoot, actual) ||
      path.basename(actual) !== 'payload'
    ) {
      throw ioFailure(
        'UPDATE_RECEIPT_INVALID',
        'Prepared update staging path is invalid',
      );
    }
    const info = await lstat(actual);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw ioFailure(
        'UPDATE_RECEIPT_INVALID',
        'Prepared update staging path is unsafe',
      );
    }
  }

  private journalRoot(root: string): string {
    return (
      this.config.get<string>('app.updateJournalRoot') ?? path.resolve(root)
    );
  }

  private terminal(phase?: AttemptJournalSnapshot['phase']): boolean {
    return [
      'COMMITTED',
      'ROLLED_BACK',
      'FAILED',
      'ABORTED',
    ].includes(phase ?? '');
  }

  private async recordFailure(
    attempt: MaintenanceAttempt,
    reason: string,
  ): Promise<void> {
    try {
      const ownership = this.ownership;
      if (
        !ownership || ownership.attemptId !== attempt.attemptId ||
        ownership.lock.fence !== attempt.fence
      ) return;
      await ownership.recoveryGuard.assertActive();
      await ownership.lock.assertActive();
      const journal = ownership.journal;
      const intent = await journal.appendIntent({
        attemptId: attempt.attemptId,
        fence: attempt.fence,
        action: 'record-install-failure',
        phase: 'FAILED',
        payload: { reason },
      });
      await journal.appendCompletion({
        attemptId: attempt.attemptId,
        fence: attempt.fence,
        intentId: intent.id,
        phase: 'FAILED',
      });
    } catch {
      // PREPARED remains the durable fail-closed state when a failure event
      // itself cannot be recorded.
    }
    // Handoff failures are replayed from the journal after recovery. Never
    // perform uncounted business audit writes while admission is closed.
    if (!this.barrier.accepting) return;
    await this.audit.record({
      accountId: null,
      action: AuditAction.UPDATE_FAILED,
      resourceType: 'update',
      resourceId: attempt.attemptId,
      details: { reason },
    });
  }

  private async abortBeforeFreeze(attempt: MaintenanceAttempt): Promise<void> {
    const ownership = this.ownership;
    if (!ownership || ownership.attemptId !== attempt.attemptId || ownership.lock.fence !== attempt.fence) throw new Error('abort ownership changed');
    await ownership.recoveryGuard.assertActive();
    await ownership.lock.assertActive();
    const snapshot = await ownership.journal.readSnapshot();
    if (snapshot.attemptId !== attempt.attemptId || snapshot.fence !== attempt.fence || snapshot.phase !== 'MAINTENANCE' || snapshot.pending) throw new Error('pre-freeze abort is not proven');
    const intent = await ownership.journal.appendIntent({attemptId:attempt.attemptId,fence:attempt.fence,action:'record-install-failure',phase:'FAILED',payload:{reason:'PRE_FREEZE_ABORT'}});
    await ownership.journal.appendCompletion({attemptId:attempt.attemptId,fence:attempt.fence,intentId:intent.id,phase:'FAILED'});
    // Durable cancellation precedes retiring the exact owner and reopening.
    await ownership.lock.release();
    await ownership.recoveryGuard.release();
    this.ownership = undefined;
    this.receipts.delete(attempt.attemptId);
    this.scheduled.delete(attempt.attemptId);
    this.handedOff = false;
    this.barrier.abortMaintenance(attempt);
  }
}
