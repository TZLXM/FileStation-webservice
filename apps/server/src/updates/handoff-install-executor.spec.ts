import { UpdateCapabilityService } from './update-capability.service';
import { DatabaseSnapshotService } from './database-snapshot.service';
import { WriteBarrierService } from '../maintenance/write-barrier.service';
import { HandoffSpawner } from './handoff-spawner';
import { ApplicationShutdownService } from './application-shutdown.service';
import {
  HandoffUpdateInstallExecutor,
  UpdateInstallContext,
} from './update-install-coordinator';
import { AttemptJournal, RecoveryGuard, LockHandle } from '@filestation/updater';
import { ConfigService } from '@nestjs/config';

describe('HandoffUpdateInstallExecutor', () => {
  it('consumes and retains the exact Task 8 ownership handles', async () => {
    const lock = {
      fence: 4,
      assertActive: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined),
    } as unknown as LockHandle;
    const journal = {
      readSnapshot: jest.fn(),
      filename: 'exact-retained-journal',
    } as unknown as AttemptJournal;
    const recoveryGuard = {
      assertActive: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined),
    } as unknown as RecoveryGuard;
    const runHandoff = jest.fn(async () => undefined);
    const executor = new HandoffUpdateInstallExecutor(
      {
        get: () => 'C:\\fixture\\data\\filestation.db',
      } as unknown as ConfigService,
      {
        inspect: async () => ({
          mode: 'managed',
          supported: true,
          install_root: 'C:\\fixture\\install',
          updater_version: '0.2.0',
          platform: 'windows-x64',
          reason: null,
        }),
      } as unknown as UpdateCapabilityService,
      {} as DatabaseSnapshotService,
      {} as WriteBarrierService,
      {} as ApplicationShutdownService,
      {} as HandoffSpawner,
    );
    jest.spyOn(executor as never, 'runHandoff' as never).mockImplementation(
      runHandoff as never,
    );
    const context: UpdateInstallContext = {
      contract_version: 2,
      attempt: Object.freeze({
        attemptId: 'attempt-executor-01',
        fence: 4,
        installRoot: 'C:\\fixture\\install',
        backupId: 'backup-executor-01',
        targetVersion: '0.2.5',
      }),
      receipt: Object.freeze({
        prepared_id: 'prepared-executor-01',
        manifest_sha256: 'a'.repeat(64),
        artifact_sha256: 'b'.repeat(64),
        version: '0.2.5',
        platform: 'windows-x64',
        arch: 'x64',
        staging_path: 'C:\\fixture\\install\\stage\\payload',
        verified_size: 10,
        unpacked_size: 20,
        expires_at: Date.now() + 60_000,
      }),
      ownership: Object.freeze({ lock, journal, recoveryGuard }),
    };

    await executor.execute(context);

    expect(lock.assertActive).toHaveBeenCalledTimes(1);
    expect(recoveryGuard.assertActive).toHaveBeenCalledTimes(1);
    expect(runHandoff).toHaveBeenCalledWith(
      context.attempt,
      expect.objectContaining({ ownership: context.ownership }),
    );
    expect(lock.release).not.toHaveBeenCalled();
    expect(recoveryGuard.release).not.toHaveBeenCalled();
  });
});
