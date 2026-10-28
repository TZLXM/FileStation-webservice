import { ChildProcess, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AttemptJournal, PlatformBootIdentityProvider } from '@filestation/updater';

function childFixture() {
  const child = fork(path.join(__dirname, 'fixtures/update-owner-child.cjs'), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const messages: any[] = [];
  let errorOutput = '';
  child.stderr?.on('data', (bytes) => { errorOutput += bytes.toString(); });
  child.on('message', (message) => { messages.push(message); });
  return {
    child,
    async event(name: string): Promise<any> {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const failure = messages.find((message) => message.event === 'fixture-error');
        if (failure) throw new Error(failure.message);
        const index = messages.findIndex((message) => message.event === name);
        if (index >= 0) return messages.splice(index, 1)[0];
        if (child.exitCode !== null) throw new Error(`child exited: ${errorOutput}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`child timed out waiting for ${name}: ${errorOutput}`);
    },
  };
}

async function exitChild(child: ChildProcess) {
  if (!child.connected) return;
  const exited = once(child, 'exit');
  child.send({ command: 'exit' });
  await exited;
}

describe('update coordinator OS ownership (real children)', () => {
  it.each(['PREPARED', 'HANDOFF_READY'])('excludes other processes and refuses dead %s ownership without recovery', async (phase) => {
    const root = await mkdtemp(path.join(tmpdir(), 'filestation-owner-'));
    const staging = path.join(root, '.filestation-update-staging', 'fixture', 'payload');
    await mkdir(staging, { recursive: true });
    const receipt = {
      prepared_id: '07523e2b-37ee-40cb-980f-cce36310e45f',
      manifest_sha256: 'a'.repeat(64), artifact_sha256: 'b'.repeat(64), version: '0.2.5',
      platform: process.platform === 'win32' ? 'windows-x64' : 'linux-x64', arch: 'x64',
      staging_path: await realpath(staging), verified_size: 64, unpacked_size: 64,
      expires_at: Date.now() + 900_000,
    };
    const owner = childFixture();
    const contender = childFixture();
    try {
      owner.child.send({ command: 'init', root, receipt });
      contender.child.send({ command: 'init', root, receipt: { ...receipt, prepared_id: 'other-receipt' } });
      const [first, second] = await Promise.all([owner.event('ready'), contender.event('ready')]);
      expect(first.pid).not.toBe(second.pid);
      const identity = new PlatformBootIdentityProvider();
      expect(first.boot).toEqual(await identity.current());
      expect(second.boot).toEqual(first.boot);
      expect(await identity.isProcessAlive(first.pid, first.created)).toBe(true);
      expect(await identity.isProcessAlive(second.pid, second.created)).toBe(true);
      owner.child.send({ command: 'accept', pauseAppend: true });
      await owner.event('append-paused');
      contender.child.send({ command: 'accept' });
      expect(await contender.event('refused')).toMatchObject({ code: 'UPDATE_IN_PROGRESS' });
      owner.child.send({ command: 'resume-append' });
      const accepted = await owner.event('accepted');
      const prepared = await AttemptJournal.inspect(root);
      expect(prepared.records).toHaveLength(1);
      expect(prepared.attemptId).toBe(accepted.acceptance.attempt_id);
      expect(prepared.owner).toMatchObject({ pid: first.pid, processCreatedAt: first.created, bootIdentity: first.boot.value });
      if (phase === 'HANDOFF_READY') {
        owner.child.send({ command: 'handoff' });
        await owner.event('nest-closed');
        contender.child.send({ command: 'probe-guard' });
        await contender.event('guard-refused');
        contender.child.send({ command: 'accept' });
        expect(await contender.event('refused')).toMatchObject({ code: 'UPDATE_IN_PROGRESS' });
        owner.child.send({ command: 'resume-handoff' });
        await owner.event('handoff-ready');
      }
      const ready = await AttemptJournal.inspect(root);
      expect(ready.phase).toBe(phase);
      await exitChild(owner.child);
      expect(await identity.isProcessAlive(first.pid, first.created)).toBe(false);
      contender.child.send({ command: 'probe-guard' });
      await contender.event('guard-acquired');
      contender.child.send({ command: 'accept' });
      expect(await contender.event('refused')).toMatchObject({ code: 'UPDATE_IN_PROGRESS' });
      expect(await AttemptJournal.inspect(root)).toEqual(ready);
    } finally {
      await Promise.all([exitChild(owner.child), exitChild(contender.child)]);
      await rm(root, { recursive: true, force: true });
    }
  });
});
