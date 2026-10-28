import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AttemptJournal } from '@filestation/updater';
import { DataSource } from 'typeorm';
import { UpdateAuditReconciler } from './update-audit-reconciler';

async function journalFixture(
  root: string,
  terminal: boolean,
): Promise<AttemptJournal> {
  const journal = await AttemptJournal.open(root);
  await journal.beginAttempt({
    attemptId: 'attempt-audit-01',
    fence: 3,
    currentVersion: '0.2.0',
    targetVersion: '0.2.5',
    previousVersion: '0.2.0',
    backupId: 'backup-audit-01',
    phase: 'PREPARED',
    owner: {
      bootIdentity: 'fixture-boot',
      pid: 1234,
      processCreatedAt: 'fixture-created',
      heartbeatAt: new Date().toISOString(),
    },
  });
  const stop = await journal.appendIntent({
    attemptId: 'attempt-audit-01',
    fence: 3,
    action: 'record-old-stopped',
    phase: 'OLD_STOPPED',
  });
  await journal.appendCompletion({
    attemptId: 'attempt-audit-01',
    fence: 3,
    intentId: stop.id,
    phase: 'OLD_STOPPED',
  });
  if (terminal) {
    const commit = await journal.appendIntent({
      attemptId: 'attempt-audit-01',
      fence: 3,
      action: 'commit-update',
      phase: 'READY_TO_COMMIT',
    });
    await journal.appendCompletion({
      attemptId: 'attempt-audit-01',
      fence: 3,
      intentId: commit.id,
      phase: 'COMMITTED',
    });
  }
  return journal;
}

describe('UpdateAuditReconciler', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'filestation-update-audit-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('does not write audit rows during maintenance', async () => {
    await journalFixture(root, false);
    const query = jest.fn();
    const reconciler = new UpdateAuditReconciler(
      { query } as unknown as DataSource,
    );

    await expect(reconciler.reconcile(root)).resolves.toEqual({
      inserted: 0,
      skipped: 0,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('uses deterministic insert-or-ignore events after a terminal journal', async () => {
    await journalFixture(root, true);
    const query = jest
      .fn()
      .mockResolvedValueOnce({ changes: 1 })
      .mockResolvedValueOnce({ changes: 1 })
      .mockResolvedValueOnce({ changes: 0 })
      .mockResolvedValueOnce({ changes: 0 });
    const reconciler = new UpdateAuditReconciler(
      { query } as unknown as DataSource,
    );

    const first = await reconciler.reconcile(root);
    const retry = await reconciler.reconcile(root);

    expect(first).toEqual({ inserted: 2, skipped: 0 });
    expect(retry).toEqual({ inserted: 0, skipped: 2 });
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[0][0]).toMatch(/INSERT OR IGNORE/i);
    expect(query.mock.calls[0][1][0]).toBe(query.mock.calls[2][1][0]);
    expect(JSON.stringify(query.mock.calls)).not.toContain('capability');
  });
});
