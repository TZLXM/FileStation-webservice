import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AttemptJournal } from '@filestation/updater';
import { WriteBarrierService } from '../maintenance/write-barrier.service';
import { WriteFreezeService } from '../maintenance/write-freeze.service';
import {
  HandoffChannel,
  HandoffSpawner,
  RefusingHandoffSpawner,
} from './handoff-spawner';
import { ShutdownCoordinator } from './shutdown-coordinator';

class ProcessExitSignal extends Error {}

describe('ShutdownCoordinator', () => {
  let root: string;
  let journal: AttemptJournal;
  let freeze: WriteFreezeService;
  let barrier: WriteBarrierService;

  const attempt = () => ({
    attemptId: 'attempt-handoff-01',
    fence: 4,
    installRoot: root,
    backupId: 'backup-handoff-01',
    targetVersion: '0.2.5',
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'filestation-task7-handoff-'));
    journal = await AttemptJournal.open(root);
    await journal.beginAttempt({
      attemptId: attempt().attemptId,
      fence: attempt().fence,
      currentVersion: '0.2.0',
      targetVersion: attempt().targetVersion,
      backupId: attempt().backupId,
      phase: 'MAINTENANCE',
      owner: {
        bootIdentity: 'fixture-boot',
        pid: process.pid,
        processCreatedAt: '2026-10-28T00:00:00.000Z',
        heartbeatAt: new Date().toISOString(),
      },
    });
    freeze = new WriteFreezeService();
    barrier = new WriteBarrierService(freeze);
    barrier.enterMaintenance(attempt());
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('fails closed when the Task 9 handoff spawner is not wired', async () => {
    const spawner = new RefusingHandoffSpawner();
    await expect(
      spawner.startWaiting(attempt(), {
        close: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: 'HANDOFF_SPAWNER_UNAVAILABLE',
    });
  });

  it('freezes, starts the waiting updater, closes Nest, then writes HANDOFF_READY', async () => {
    const events: string[] = [];
    const channel: HandoffChannel = {
      async close() {
        events.push('channel-close');
      },
    };
    const spawner: HandoffSpawner = {
      async startWaiting(_attempt, receivedChannel) {
        expect(receivedChannel).toBe(channel);
        events.push('spawner-waiting');
      },
    };
    const snapshot = {
      createVerifiedSnapshot: jest.fn(async () => {
        events.push('snapshot');
        return {
          attemptId: attempt().attemptId,
          fence: attempt().fence,
          path: path.join(
            root,
            'backups',
            attempt().backupId,
            'update-snapshot.sqlite',
          ),
          sha256: 'a'.repeat(64),
          bytes: 4096,
          sourceDatabase: path.join(root, 'database.sqlite'),
          integrity: 'ok' as const,
          foreignKeys: 0 as const,
          createdAt: '2026-10-28T00:00:00.000Z',
        };
      }),
      freezeSourceDatabase: jest.fn(async () => {
        events.push('freeze-database');
        freeze.freeze(attempt());
      }),
    };
    const coordinator = new ShutdownCoordinator({
      journalRoot: root,
      barrier,
      snapshot,
      spawner,
      channel,
      closeApplication: async () => {
        events.push('app-close');
      },
      exit: ((code: number) => {
        events.push(`exit:${code}`);
        throw new ProcessExitSignal('exit');
      }) as (code: number) => never,
    });

    await expect(coordinator.handoff(attempt())).rejects.toBeInstanceOf(
      ProcessExitSignal,
    );

    expect(events.indexOf('snapshot')).toBeLessThan(
      events.indexOf('freeze-database'),
    );
    expect(events.indexOf('freeze-database')).toBeLessThan(
      events.indexOf('spawner-waiting'),
    );
    expect(events.indexOf('spawner-waiting')).toBeLessThan(
      events.indexOf('app-close'),
    );
    expect(events.indexOf('app-close')).toBeLessThan(
      events.indexOf('exit:0'),
    );

    const completed = await journal.readSnapshot();
    expect(completed.phase).toBe('HANDOFF_READY');
    expect(completed.pending).toBeNull();
    expect(completed.records.some((record) => record.phase === 'OLD_STOPPED')).toBe(
      false,
    );
    expect(completed.records.at(-1)?.kind).toBe('completion');
  });

  it('never writes HANDOFF_READY or exits when app.close fails', async () => {
    const spawner: HandoffSpawner = {
      startWaiting: jest.fn(async () => undefined),
    };
    const exit = jest.fn() as unknown as (code: number) => never;
    const coordinator = new ShutdownCoordinator({
      journalRoot: root,
      barrier,
      snapshot: {
        createVerifiedSnapshot: async () => ({
          attemptId: attempt().attemptId,
          fence: attempt().fence,
          path: path.join(
            root,
            'backups',
            attempt().backupId,
            'update-snapshot.sqlite',
          ),
          sha256: 'b'.repeat(64),
          bytes: 4096,
          sourceDatabase: path.join(root, 'database.sqlite'),
          integrity: 'ok',
          foreignKeys: 0,
          createdAt: '2026-10-28T00:00:00.000Z',
        }),
        freezeSourceDatabase: async () => freeze.freeze(attempt()),
      },
      spawner,
      channel: { close: async () => undefined },
      closeApplication: async () => {
        throw new Error('partial close failed');
      },
      exit,
    });

    await expect(coordinator.handoff(attempt())).rejects.toThrow(
      /close failed/i,
    );
    expect(spawner.startWaiting).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    const pending = await journal.readSnapshot();
    expect(pending.phase).toBe('SNAPSHOT_READY');
    expect(pending.pending?.action).toBe('close-application');
    expect(
      pending.records.some(
        (record) =>
          record.kind === 'completion' && record.phase === 'HANDOFF_READY',
      ),
    ).toBe(false);
  });
});
