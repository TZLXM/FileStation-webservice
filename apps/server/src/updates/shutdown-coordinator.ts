import path from 'node:path';
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
  barrier: WriteBarrierService;
  snapshot: VerifiedSnapshotPort;
  spawner: HandoffSpawner;
  channel: HandoffChannel;
  closeApplication: () => Promise<void>;
  exit?: (code: number) => never;
  drainDeadline?: () => number;
}

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

  constructor(private readonly options: ShutdownCoordinatorOptions) {
    this.exit = options.exit ?? ((code: number) => process.exit(code));
    this.drainDeadline =
      options.drainDeadline ?? (() => Date.now() + 60_000);
  }

  async handoff(attempt: MaintenanceAttempt): Promise<never> {
    const owned = this.options.barrier.currentAttempt;
    if (
      !owned ||
      owned.attemptId !== attempt.attemptId ||
      owned.fence !== attempt.fence
    ) {
      throw new Error('shutdown attempt or fence does not own the write barrier');
    }
    await this.options.barrier.waitForZero(this.drainDeadline());
    const metadata =
      await this.options.snapshot.createVerifiedSnapshot(attempt);
    this.validateSnapshot(attempt, metadata);

    await this.options.snapshot.freezeSourceDatabase(attempt);
    const journal = await AttemptJournal.open(this.options.journalRoot);
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
    );
    const closeIntent = await journal.appendIntent({
      attemptId: attempt.attemptId,
      fence: attempt.fence,
      action: 'close-application',
      phase: 'SNAPSHOT_READY',
    });
    await this.options.closeApplication();
    await journal.appendCompletion({
      attemptId: attempt.attemptId,
      fence: attempt.fence,
      intentId: closeIntent.id,
      phase: 'HANDOFF_READY',
    });
    return this.exit(0);
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
