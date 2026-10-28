import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import {
  MaintenanceAttempt,
  WriteFreezeService,
} from './write-freeze.service';

export type WriteSource =
  | 'http'
  | 'ws'
  | 'cron:audit-purge'
  | 'cron:file-lifecycle'
  | 'cron:recovery-cleanup'
  | 'startup-scan'
  | 'startup-storage'
  | 'upload-finalizer'
  | 'lifecycle-recovery'
  | 'audit';

export interface WriteLease {
  readonly source: WriteSource;
  readonly released: boolean;
  release(): void;
}

export interface CommittedActivationAuthority {
  readonly attemptId: string;
  readonly fence: number;
}

export class MaintenanceUnavailableError extends Error {
  readonly code = 'UPDATE_MAINTENANCE';

  constructor() {
    super('FileStation is in update maintenance');
    this.name = 'MaintenanceUnavailableError';
  }
}

export class WriteDrainTimeoutError extends Error {
  readonly code = 'UPDATE_DRAIN_TIMEOUT';

  constructor(active: number) {
    super(`Timed out waiting for ${active} write lease(s) to drain`);
    this.name = 'WriteDrainTimeoutError';
  }
}

interface LeaseContext {
  barrier: WriteBarrierService;
  lease: WriteLease;
}

class DeregisteringWriteLease implements WriteLease {
  private isReleased = false;

  constructor(
    readonly source: WriteSource,
    private readonly onRelease: () => void,
  ) {}

  get released(): boolean {
    return this.isReleased;
  }

  release(): void {
    if (this.isReleased) return;
    this.isReleased = true;
    this.onRelease();
  }
}

class NestedWriteLease implements WriteLease {
  readonly released = false;

  constructor(readonly source: WriteSource) {}

  release(): void {}
}

@Injectable()
export class WriteBarrierService {
  private closedAttempt?: Readonly<MaintenanceAttempt>;
  private leases = 0;
  private readonly drainWaiters = new Set<() => void>();
  private readonly context = new AsyncLocalStorage<LeaseContext>();
  private readonly committedActivations = new WeakSet<object>();

  constructor(private readonly freeze: WriteFreezeService) {}

  get activeLeaseCount(): number {
    return this.leases;
  }

  get currentAttempt(): Readonly<MaintenanceAttempt> | undefined {
    return this.closedAttempt;
  }

  get accepting(): boolean {
    return this.closedAttempt === undefined;
  }

  async acquire(source: WriteSource): Promise<WriteLease> {
    const current = this.context.getStore();
    if (
      current?.barrier === this &&
      !current.lease.released &&
      this.closedAttempt
    ) {
      return new NestedWriteLease(source);
    }

    if (this.closedAttempt) throw new MaintenanceUnavailableError();
    this.freeze.assertWritable();

    this.leases += 1;
    const lease = new DeregisteringWriteLease(source, () => {
      this.leases -= 1;
      if (this.leases === 0) {
        for (const notify of [...this.drainWaiters]) notify();
        this.drainWaiters.clear();
      }
    });
    return lease;
  }

  attachContext(lease: WriteLease): void {
    this.context.enterWith({ barrier: this, lease });
  }

  runInLeaseContext<T>(lease: WriteLease, operation: () => T): T {
    return this.context.run({ barrier: this, lease }, operation);
  }

  async forkLease(source: WriteSource): Promise<WriteLease> {
    const current = this.context.getStore();
    if (current?.barrier === this && !current.lease.released) {
      this.freeze.assertWritable();
      this.leases += 1;
      return new DeregisteringWriteLease(source, () => {
        this.leases -= 1;
        if (this.leases === 0) {
          for (const notify of [...this.drainWaiters]) notify();
          this.drainWaiters.clear();
        }
      });
    }
    return this.acquire(source);
  }

  async withForkedLease<T>(
    source: WriteSource,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lease = await this.forkLease(source);
    try {
      return await this.context.run({ barrier: this, lease }, operation);
    } finally {
      lease.release();
    }
  }

  async withLease<T>(
    source: WriteSource,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquire(source);
    try {
      return await this.context.run({ barrier: this, lease }, operation);
    } finally {
      lease.release();
    }
  }

  beginCommittedActivation(
    attempt: MaintenanceAttempt,
  ): CommittedActivationAuthority {
    this.assertAttempt(attempt);
    const authority = Object.freeze({
      attemptId: attempt.attemptId,
      fence: attempt.fence,
    });
    this.committedActivations.add(authority);
    return authority;
  }

  async withCommittedActivation<T>(
    authority: CommittedActivationAuthority,
    source: WriteSource,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (
      !this.committedActivations.has(authority) ||
      !this.closedAttempt ||
      this.closedAttempt.attemptId !== authority.attemptId ||
      this.closedAttempt.fence !== authority.fence
    ) {
      throw new Error('committed activation authority is invalid');
    }
    this.freeze.assertWritable();
    this.leases += 1;
    const lease = new DeregisteringWriteLease(source, () => {
      this.leases -= 1;
      if (this.leases === 0) {
        for (const notify of [...this.drainWaiters]) notify();
        this.drainWaiters.clear();
      }
    });
    try {
      return await this.context.run({ barrier: this, lease }, operation);
    } finally {
      lease.release();
    }
  }

  finishCommittedActivation(authority: CommittedActivationAuthority): void {
    this.committedActivations.delete(authority);
  }

  enterMaintenance(attempt: MaintenanceAttempt): void {
    this.freeze.assertWritable();
    if (
      this.closedAttempt &&
      (this.closedAttempt.attemptId !== attempt.attemptId ||
        this.closedAttempt.fence !== attempt.fence)
    ) {
      throw new Error('A different update attempt already closed the barrier');
    }
    this.closedAttempt = Object.freeze({ ...attempt });
  }

  abortMaintenance(attempt: MaintenanceAttempt): void {
    this.assertAttempt(attempt);
    if (this.freeze.isFrozen) {
      throw new Error(
        'Update maintenance cannot be aborted after the irreversible source freeze',
      );
    }
    this.closedAttempt = undefined;
  }

  reopenAfterCommitted(attempt: MaintenanceAttempt): void {
    this.assertAttempt(attempt);
    if (this.freeze.isFrozen) {
      throw new Error('A frozen source instance must exit and be replaced');
    }
    this.closedAttempt = undefined;
  }

  waitForZero(deadline: number): Promise<void> {
    if (this.leases === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.drainWaiters.delete(check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (this.leases === 0) finish();
      };
      this.drainWaiters.add(check);
      const timeoutMs = Math.max(0, deadline - Date.now());
      const timer = setTimeout(
        () => finish(new WriteDrainTimeoutError(this.leases)),
        timeoutMs,
      );
    });
  }

  private assertAttempt(attempt: MaintenanceAttempt): void {
    if (
      !this.closedAttempt ||
      this.closedAttempt.attemptId !== attempt.attemptId ||
      this.closedAttempt.fence !== attempt.fence
    ) {
      throw new Error('Update attempt or fence does not own the write barrier');
    }
  }
}
