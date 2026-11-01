import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AttemptJournal,
  UpdateCapabilityAuthority,
  encodeInheritedCapability,
} from '@filestation/updater';
import { InheritedTrustedStartupAccess } from './inherited-startup-access';
import { UpdateStartupIntent } from './startup-authority';

const NOW = Date.parse('2026-10-28T12:00:00.000Z');

describe('InheritedTrustedStartupAccess', () => {
  let root: string;
  let journal: AttemptJournal;
  let authority: UpdateCapabilityAuthority;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'filestation-inherited-access-'));
    authority = new UpdateCapabilityAuthority(Buffer.alloc(32, 0x33));
    journal = await AttemptJournal.open(root);
    await journal.beginAttempt({
      attemptId: 'attempt-inherited-01',
      fence: 13,
      currentVersion: '0.2.0',
      targetVersion: '0.2.5',
      previousVersion: '0.2.0',
      backupId: 'backup-inherited-01',
      phase: 'HANDOFF_READY',
      owner: {
        bootIdentity: 'win32:2026-10-28T00:00:00.000Z',
        pid: 4321,
        processCreatedAt: 'win32:2026-10-28T00:00:01.000Z',
        heartbeatAt: new Date(NOW - 1000).toISOString(),
        handoffIdentityHash: 'a'.repeat(64),
      },
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function intent(mode: 'validate' | 'gated'): UpdateStartupIntent {
    return {
      mode,
      attempt: {
        attemptId: 'attempt-inherited-01',
        fence: 13,
        installRoot: root,
        backupId: 'backup-inherited-01',
        targetVersion: '0.2.5',
      },
    };
  }

  async function* inherited(payload: Buffer): AsyncGenerator<Buffer> {
    yield payload;
  }

  it('authorizes pre-import validation startup only from a matching inherited channel', async () => {
    const intentValue = intent('validate');
    const pending = await journal.appendIntent({
      attemptId: 'attempt-inherited-01',
      fence: 13,
      action: 'validate-release',
      phase: 'MIGRATING',
      payload: { target: '0.2.5' },
    });
    const access = await InheritedTrustedStartupAccess.fromInherited(
      inherited(encodeInheritedCapability(authority)),
    );

    await expect(access.authorizeStartup(intentValue)).resolves.toBeUndefined();

    await journal.appendCompletion({
      attemptId: 'attempt-inherited-01',
      fence: 13,
      intentId: pending.id,
      phase: 'MIGRATED_VERIFIED',
    });
    await expect(access.authorizeStartup(intentValue)).rejects.toThrow(
      /pre-import|phase|validation/i,
    );
  });

  it('authorizes gated startup after migration and rejects changed attempt state', async () => {
    await journal.appendIntent({
      attemptId: 'attempt-inherited-01',
      fence: 13,
      action: 'validate-release',
      phase: 'MIGRATING',
    });
    const latest = await journal.readSnapshot();
    await journal.appendCompletion({
      attemptId: 'attempt-inherited-01',
      fence: 13,
      intentId: latest.pending!.intentId,
      phase: 'MIGRATED_VERIFIED',
    });
    const access = await InheritedTrustedStartupAccess.fromInherited(
      inherited(encodeInheritedCapability(authority)),
    );

    await expect(access.authorizeStartup(intent('gated'))).resolves.toBeUndefined();
    await expect(
      access.authorizeStartup({
        ...intent('gated'),
        attempt: {
          ...intent('gated').attempt,
          fence: 12,
        },
      }),
    ).rejects.toThrow(/attempt|fence/i);
  });

  it('validates request purpose/method/stage and signs deterministic receipts', async () => {
    const access = new InheritedTrustedStartupAccess(authority, () => NOW);
    const capability = authority.issue({
      attemptId: 'attempt-inherited-01',
      fence: 13,
      purpose: 'promote',
      method: 'POST',
      stage: 'gated',
      expiresAt: NOW + 1000,
    });

    await expect(
      access.authorizeRequest(intent('gated'), {
        attemptId: 'attempt-inherited-01',
        fence: 13,
        capability,
        purpose: 'promote',
        method: 'POST',
        stage: 'gated',
      }),
    ).resolves.toBeUndefined();
    await expect(
      access.authorizeRequest(intent('gated'), {
        attemptId: 'attempt-inherited-01',
        fence: 13,
        capability,
        purpose: 'health',
        method: 'GET',
        stage: 'gated',
      }),
    ).rejects.toThrow(/capability/i);

    const payload = {
      attempt_id: 'attempt-inherited-01',
      fence: 13,
      target_version: '0.2.5',
      migration_id: '1800000000000',
      schema_sha256: 'b'.repeat(64),
      health: 'ok',
    };
    const receipt = access.signReceipt(payload);
    expect(receipt).toBe(access.signReceipt(payload));
    expect(authority.verifyReceipt(receipt, payload)).toBe(true);
  });
});
