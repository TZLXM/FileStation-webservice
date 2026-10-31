import { Injectable } from '@nestjs/common';

export interface MaintenanceAttempt {
  attemptId: string;
  fence: number;
  installRoot: string;
  backupId: string;
  targetVersion: string;
}

export class WriteFrozenError extends Error {
  readonly code = 'UPDATE_SOURCE_FROZEN';

  constructor() {
    super('The source database and storage are frozen for update handoff');
    this.name = 'WriteFrozenError';
  }
}

/**
 * Irreversible process-wide latch shared by database and storage writers.
 * It is deliberately independent from the barrier's open/closed admission
 * state: gated startup may reopen a new instance after COMMITTED, while an old
 * snapshot source can never thaw.
 */
@Injectable()
export class WriteFreezeService {
  private frozenAttempt?: Readonly<MaintenanceAttempt>;

  get isFrozen(): boolean {
    return this.frozenAttempt !== undefined;
  }

  get attempt(): Readonly<MaintenanceAttempt> | undefined {
    return this.frozenAttempt;
  }

  freeze(attempt: MaintenanceAttempt): void {
    if (this.frozenAttempt) {
      if (
        this.frozenAttempt.attemptId !== attempt.attemptId ||
        this.frozenAttempt.fence !== attempt.fence
      ) {
        throw new Error('A different update attempt already froze this process');
      }
      return;
    }
    this.frozenAttempt = Object.freeze({ ...attempt });
  }

  assertWritable(): void {
    if (this.frozenAttempt) throw new WriteFrozenError();
  }
}
