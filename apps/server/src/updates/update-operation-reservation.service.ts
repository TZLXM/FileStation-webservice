import {
  ConflictException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import {
  acquireRecoveryGuard,
  RecoveryGuard,
} from '@filestation/updater';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

export type UpdateOperationKind = 'prepare' | 'install';

export const UPDATE_OPERATION_GUARD = Symbol('UPDATE_OPERATION_GUARD');

type GuardFactory = (filename: string) => Promise<RecoveryGuard>;

export interface UpdateOperationLease {
  readonly root: string;
  readonly kind: UpdateOperationKind;
  assertActive(): Promise<void>;
  release(): Promise<void>;
}

interface OperationHolder {
  guard: RecoveryGuard;
  kind: UpdateOperationKind;
  leases: number;
}

function rootKey(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function busy(): ConflictException {
  return new ConflictException({
    code: 'UPDATE_OPERATION_IN_PROGRESS',
    message: 'Another prepare or install operation owns this installation',
  });
}

@Injectable()
export class UpdateOperationReservationService {
  private readonly holders = new Map<string, OperationHolder>();
  private readonly pending = new Set<string>();

  constructor(
    @Optional()
    @Inject(UPDATE_OPERATION_GUARD)
    private readonly acquireGuard: GuardFactory = acquireRecoveryGuard,
  ) {}

  async acquire(
    rootInput: string,
    kind: UpdateOperationKind,
  ): Promise<UpdateOperationLease> {
    const declaredRoot = path.resolve(rootInput);
    const root = await realpath(declaredRoot);
    if (root !== declaredRoot) throw busy();
    const key = rootKey(root);
    const existing = this.holders.get(key);
    if (existing) {
      if (existing.kind !== 'install' || kind !== 'install') throw busy();
      existing.leases += 1;
      return this.lease(key, root, existing);
    }
    if (this.pending.has(key)) throw busy();

    this.pending.add(key);
    let guard: RecoveryGuard | undefined;
    try {
      guard = await this.acquireGuard(
        path.join(root, 'update.operation.guard'),
      );
      await guard.assertActive();
    } catch {
      this.pending.delete(key);
      await guard?.release();
      throw busy();
    }
    this.pending.delete(key);
    const holder: OperationHolder = { guard, kind, leases: 1 };
    this.holders.set(key, holder);
    return this.lease(key, root, holder);
  }

  private lease(
    key: string,
    root: string,
    holder: OperationHolder,
  ): UpdateOperationLease {
    let released = false;
    return {
      root,
      kind: holder.kind,
      assertActive: async () => {
        if (released) throw busy();
        await holder.guard.assertActive();
      },
      release: async () => {
        if (released) return;
        released = true;
        holder.leases -= 1;
        if (holder.leases > 0) return;
        if (this.holders.get(key) === holder) this.holders.delete(key);
        await holder.guard.release();
      },
    };
  }
}
