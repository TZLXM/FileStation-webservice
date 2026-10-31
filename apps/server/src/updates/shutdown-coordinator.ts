import path from 'node:path';
import { createHash } from 'node:crypto';
import { AttemptJournal } from '@filestation/updater';
import {
  MaintenanceAttempt,
} from '../maintenance/write-freeze.service';
import { WriteBarrierService } from '../maintenance/write-barrier.service';
import { SnapshotMetadata } from './database-snapshot.service';
import {
  HandoffChannel,
  HandoffSpawner,
} from './handoff-spawner';

export interface VerifiedSnapshotPort {
  createVerifiedSnapshot(
    attempt: MaintenanceAttempt,
  ): Promise<SnapshotMetadata>;
  freezeSourceDatabase(attempt: MaintenanceAttempt): Promise<void>;
}

export interface ShutdownCoordinatorOptions {
  journalRoot: string;
  journal: AttemptJournal;
  barrier: WriteBarrierService;
  snapshot: VerifiedSnapshotPort;
  spawner: HandoffSpawner;
  channel: HandoffChannel;
  handoffCapability: Buffer;
  closeApplication: () => Promise<void>;
  exit?: (code: number) => never;
  drainDeadline?: () => number;
  now?: () => Date;
  onProgress?: (phase: HandoffProgress) => void;
}

export type HandoffProgress = 'pre-freeze' | 'freeze-started' | 'close-started';

function safeRelative(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * The journal is the only authority. This object may run from ordinary Nest
 * services for snapshot preparation, then continues in the same non-Nest
 * call stack after app.close() to append HANDOFF_READY.
 */
export class ShutdownCoordinator {
  private readonly exit: (code: number) => never;
  private readonly drainDeadline: () => number;
  private readonly now: () => Date;

  constructor(private readonly options: ShutdownCoordinatorOptions) {
    this.exit = options.exit ?? ((code: number) => process.exit(code));
    this.drainDeadline =
      options.drainDeadline ?? (() => Date.now() + 60_000);
    this.now = options.now ?? (() => new Date());
  }

  async handoff(attempt: MaintenanceAttempt): Promise<never> {
    this.options.onProgress?.('pre-freeze');
    const owned = this.options.barrier.currentAttempt;
    if (
      !owned ||
      owned.attemptId !== attempt.attemptId ||
      owned.fence !== attempt.fence
    ) {
      throw new Error('shutdown attempt or fence does not own the write barrier');
    }
    if (
      !Buffer.isBuffer(this.options.handoffCapability) ||
      this.options.handoffCapability.length === 0 ||
      this.options.handoffCapability.length > 4096
    ) {
      throw new Error('shutdown requires one bounded inherited capability');
    }
    const identityHash = createHash('sha256')
      .update(this.options.handoffCapability)
      .digest('hex');
    await this.bindHandoffIdentity(
      attempt,
      identityHash,
    );
    await this.options.barrier.waitForZero(this.drainDeadline());
    const metadata =
      await this.options.snapshot.createVerifiedSnapshot(attempt);
    this.validateSnapshot(attempt, metadata);

    // Even a rejected freeze may already have latched query-only/storage freeze.
    this.options.onProgress?.('freeze-started');
    await this.options.snapshot.freezeSourceDatabase(attempt);
    const journal = this.options.journal;
    const snapshotIntent = await journal.appendIntent({
      attemptId: attempt.attemptId,
      fence: attempt.fence,
      action: 'snapshot-database',
      phase: 'SNAPSHOT_READY',
      payload: {
        path: metadata.path,
        sha256: metadata.sha256,
        bytes: metadata.bytes,
        createdAt: metadata.createdAt,
        integrity: metadata.integrity,
        foreignKeys: metadata.foreignKeys,
      },
    });
    await journal.appendCompletion({
      attemptId: attempt.attemptId,
      fence: attempt.fence,
      intentId: snapshotIntent.id,
      phase: 'SNAPSHOT_READY',
    });

    await this.options.spawner.startWaiting(
      attempt,
      this.options.channel,
      this.options.handoffCapability,
    );
    const closeIntent = await journal.appendIntent({
      attemptId: attempt.attemptId,
      fence: attempt.fence,
      action: 'close-application',
      phase: 'SNAPSHOT_READY',
    });
    this.options.onProgress?.('close-started');
    await this.options.closeApplication();
    await journal.appendCompletion({
      attemptId: attempt.attemptId,
      fence: attempt.fence,
      intentId: closeIntent.id,
      phase: 'HANDOFF_READY',
    });
    return this.exit(0);
  }

  private async bindHandoffIdentity(
    attempt: MaintenanceAttempt,
    identityHash: string,
  ) {
    const current = await this.options.journal.readSnapshot();
    if (
      current.attemptId !== attempt.attemptId ||
      current.fence !== attempt.fence ||
      current.pending ||
      current.phase !== 'MAINTENANCE' ||
      !current.records.length
    ) {
      throw new Error('handoff identity cannot bind to the current journal');
    }
    const previous = current.records.at(-1)!.context;
    const nextContext = {
      ...structuredClone(previous),
      phase: 'MAINTENANCE' as const,
      owner: {
        ...structuredClone(previous.owner),
        heartbeatAt: this.now().toISOString(),
        handoffIdentityHash: identityHash,
      },
    };
    const intent = await this.options.journal.appendIntent({
      attemptId: attempt.attemptId,
      fence: attempt.fence,
      action: 'bind-handoff-identity',
      phase: 'MAINTENANCE',
      payload: { identityHash },
    });
    await this.options.journal.appendCompletion({
      attemptId: attempt.attemptId,
      fence: attempt.fence,
      intentId: intent.id,
      phase: 'MAINTENANCE',
      nextContext,
    });
    return nextContext;
  }

  private validateSnapshot(
    attempt: MaintenanceAttempt,
    metadata: SnapshotMetadata,
  ): void {
    const backupRoot = path.join(
      path.resolve(attempt.installRoot),
      'backups',
      attempt.backupId,
    );
    if (
      metadata.attemptId !== attempt.attemptId ||
      metadata.fence !== attempt.fence ||
      !safeRelative(backupRoot, path.resolve(metadata.path)) ||
      !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
      !Number.isSafeInteger(metadata.bytes) ||
      metadata.bytes <= 0 ||
      metadata.integrity !== 'ok' ||
      metadata.foreignKeys !== 0
    ) {
      throw new Error('verified snapshot metadata does not match the attempt');
    }
  }
}
