import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  AttemptJournal,
  AttemptJournalSnapshot,
} from '@filestation/updater';
import { AuditAction } from '../audit/audit.service';
import { WriteBarrierService } from '../maintenance/write-barrier.service';

export interface AuditReconcileResult {
  inserted: number;
  skipped: number;
}

const TERMINAL = new Set([
  'COMMITTED',
  'ROLLED_BACK',
  'FAILED',
  'ABORTED',
]);

const EVENTS: Record<string, string> = {
  'record-old-stopped': 'OLD_STOPPED',
  'commit-update': 'COMMITTED',
  'complete-rollback': 'ROLLED_BACK',
  'record-install-failure': 'FAILED',
  'verify-committed-restart': 'RESTART_VERIFIED',
};

const ACTIONS: Record<string, string> = {
  OLD_STOPPED: AuditAction.UPDATE_MAINTENANCE,
  COMMITTED: AuditAction.UPDATE_SUCCEEDED,
  ROLLED_BACK: AuditAction.UPDATE_ROLLBACK,
  FAILED: AuditAction.UPDATE_FAILED,
  RESTART_VERIFIED: AuditAction.UPDATE_SUCCEEDED,
};

function updateId(attemptId: string, event: string): string {
  return createHash('sha256')
    .update(`${attemptId}\0${event}`, 'utf8')
    .digest('hex');
}

function details(snapshot: AttemptJournalSnapshot, event: string): string {
  return JSON.stringify({
    attempt_id: snapshot.attemptId,
    fence: snapshot.fence,
    phase: event,
    current_version: snapshot.currentVersion,
    target_version: snapshot.targetVersion,
    backup_id: snapshot.backupId,
  });
}

@Injectable()
export class UpdateAuditReconciler implements OnModuleDestroy {
  private stopped = false;
  private readonly retries = new Map<string, NodeJS.Timeout>();
  constructor(private readonly dataSource: DataSource, private readonly barrier: WriteBarrierService) {}

  onModuleDestroy(): void {
    this.stopped = true;
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
  }

  private defer(root: string): void {
    if (this.stopped || this.retries.has(root)) return;
    const timer = setTimeout(() => {
      this.retries.delete(root);
      void this.reconcile(root);
    }, 250);
    timer.unref();
    this.retries.set(root, timer);
  }

  async reconcile(root: string): Promise<AuditReconcileResult> {
    if (this.stopped) return {inserted:0,skipped:0};
    let lease;
    try {
      lease = await this.barrier.forkLease('audit');
    } catch {
      this.defer(root);
      return {inserted:0,skipped:0};
    }
    try {
      const history = await AttemptJournal.inspectHistory(root);
      let inserted=0, skipped=0;
      for (const snapshot of history) {
        const result = await this.persist(snapshot);
        inserted+=result.inserted; skipped+=result.skipped;
      }
      return {inserted,skipped};
    } catch {
      this.defer(root);
      return {inserted:0,skipped:0};
    } finally { lease.release(); }
  }

  private async persist(snapshot: AttemptJournalSnapshot): Promise<AuditReconcileResult> {
    if (
      !snapshot.initialized ||
      !snapshot.attemptId ||
      !snapshot.phase ||
      !TERMINAL.has(snapshot.phase) ||
      snapshot.pending
    ) {
      return { inserted: 0, skipped: 0 };
    }
    const intents = new Map(
      snapshot.records
        .filter((record) => record.kind === 'intent')
        .map((record) => [record.id, record]),
    );
    const events = new Set<string>();
    for (const completion of snapshot.records) {
      if (
        completion.kind !== 'completion' ||
        completion.intentId === undefined
      ) {
        continue;
      }
      const intent = intents.get(completion.intentId);
      if (!intent?.action || !EVENTS[intent.action]) continue;
      events.add(EVENTS[intent.action]);
    }
    let inserted = 0;
    let skipped = 0;
    for (const event of [...events].sort()) {
      const id = updateId(snapshot.attemptId, event);
      const result = (await this.dataSource.query(
        `INSERT OR IGNORE INTO audit_logs
          (id, account_id, action, resource_type, resource_id, details,
           ip_address, user_agent, created_at, update_attempt_id, update_event)
         VALUES (?, NULL, ?, 'update', ?, ?, NULL, NULL, ?, ?, ?)`,
        [
          id,
          ACTIONS[event],
          snapshot.attemptId,
          details(snapshot, event),
          Date.now(),
          snapshot.attemptId,
          event,
        ],
      )) as { changes?: number };
      if (Number(result?.changes ?? 0) === 1) inserted += 1;
      else skipped += 1;
    }
    return { inserted, skipped };
  }
}
