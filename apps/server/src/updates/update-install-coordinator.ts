import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Response } from 'express';
import {
  AttemptJournal,
  AttemptJournalSnapshot,
  PlatformBootIdentityProvider,
} from '@filestation/updater';
import { AuditAction, AuditService } from '../audit/audit.service';
import { waitForResponseAndLeaseRelease } from '../maintenance/maintenance-admission.guard';
import { WriteBarrierService } from '../maintenance/write-barrier.service';
import { MaintenanceAttempt } from '../maintenance/write-freeze.service';
import { UpdateCapabilityService } from './update-capability.service';
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

export const UPDATE_INSTALL_EXECUTOR_CONTRACT_VERSION = 1 as const;

export interface UpdateInstallContext {
  readonly contract_version: typeof UPDATE_INSTALL_EXECUTOR_CONTRACT_VERSION;
  readonly attempt: Readonly<MaintenanceAttempt>;
  readonly receipt: PreparedUpdateReceipt;
}

export interface UpdateInstallExecutor {
  assertAvailable(): Promise<void>;
  execute(context: UpdateInstallContext): Promise<void>;
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
export class UpdateInstallCoordinator {
  private readonly logger = new Logger(UpdateInstallCoordinator.name);
  private readonly receipts = new Map<string, PreparedUpdateReceipt>();
  private readonly abandonedAttempts = new Set<string>();

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
    const journal = await AttemptJournal.open(journalRoot);
    let snapshot = await AttemptJournal.inspect(journalRoot);
    if (
      snapshot.phase === 'PREPARED' &&
      snapshot.owner &&
      (snapshot.owner.pid !== process.pid ||
        this.abandonedAttempts.has(snapshot.attemptId!)) &&
      !snapshot.pending
    ) {
      const abortIntent = await journal.appendIntent({
        attemptId: snapshot.attemptId!,
        fence: snapshot.fence,
        action: 'abort-stale-prepared',
        phase: 'ABORTED',
        payload: { reason: 'owner-restarted-before-install-handoff' },
      });
      await journal.appendCompletion({
        attemptId: snapshot.attemptId!,
        fence: snapshot.fence,
        intentId: abortIntent.id,
        phase: 'ABORTED',
      });
      snapshot = await AttemptJournal.inspect(journalRoot);
      this.abandonedAttempts.delete(snapshot.attemptId ?? '');
    }
    if (snapshot.initialized && !this.terminal(snapshot.phase)) {
      throw ioFailure(
        'UPDATE_IN_PROGRESS',
        'An update attempt is already active',
      );
    }

    const boot = await this.identity.current();
    const createdAt = await this.identity.processCreatedAt(process.pid);
    const acceptedAt = new Date(this.now()).toISOString();
    const attemptId = this.randomId();
    const backupId = `update-${this.randomId()}`.slice(0, 128);
    const attempt: MaintenanceAttempt = {
      attemptId,
      fence: snapshot.fence + 1,
      installRoot: root,
      backupId,
      targetVersion: receipt.version,
    };
    await journal.beginAttempt({
      attemptId,
      fence: attempt.fence,
      currentVersion: this.productVersion,
      targetVersion: receipt.version,
      backupId,
      phase: 'PREPARED',
      owner: {
        bootIdentity: boot.value,
        pid: process.pid,
        processCreatedAt: createdAt,
        heartbeatAt: acceptedAt,
      },
    });
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
    if (!this.barrier.accepting) return;
    const receipt = this.receipts.get(attempt.attemptId);
    if (!receipt) {
      await this.recordFailure(attempt, 'RECEIPT_NOT_AVAILABLE');
      return;
    }
    try {
      await this.executor.assertAvailable();
    } catch {
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

    await this.audit.record({
      accountId: null,
      action: AuditAction.UPDATE_MAINTENANCE,
      resourceType: 'update',
      resourceId: attempt.attemptId,
      details: { target_version: attempt.targetVersion },
    });
    this.barrier.enterMaintenance(attempt);
    const journal = await AttemptJournal.open(this.journalRoot(attempt.installRoot));
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

    try {
      await this.executor.execute({
        contract_version: UPDATE_INSTALL_EXECUTOR_CONTRACT_VERSION,
        attempt: Object.freeze({ ...attempt }),
        receipt,
      });
    } catch {
      await this.recordFailure(attempt, 'INSTALL_EXECUTOR_FAILED');
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
      const journal = await AttemptJournal.open(
        this.journalRoot(attempt.installRoot),
      );
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
    await this.audit.record({
      accountId: null,
      action: AuditAction.UPDATE_FAILED,
      resourceType: 'update',
      resourceId: attempt.attemptId,
      details: { reason },
    });
  }
}
