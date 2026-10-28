import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PlatformBootIdentityProvider } from '../src/state/boot-identity';
import { stopDetachedChild } from './fixtures/cleanup-process';

jest.setTimeout(30_000);
it('never signals a live unrelated process when a journal PID has been reused', async () => {
  const child = spawn(process.execPath, ['-e', "process.send('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  try {
    await once(child, 'message');
    const identity = new PlatformBootIdentityProvider();
    const boot = (await identity.current()).value;
    const createdAt = await identity.processCreatedAt(child.pid!);
    const signal = jest.fn();
    await stopDetachedChild({ pid: child.pid!, boot, createdAt: createdAt + '-historical' }, identity, signal);
    expect(signal).not.toHaveBeenCalled();
    await stopDetachedChild({ pid: child.pid!, boot: boot + '-other', createdAt }, identity, signal);
    expect(signal).not.toHaveBeenCalled();
    await stopDetachedChild({ pid: child.pid!, boot, createdAt }, identity, signal);
    expect(signal).toHaveBeenCalledWith(child.pid, 'SIGKILL');
  } finally {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
});

it('skips unknown/exited identities without sending a signal', async () => {
  const signal = jest.fn();
  for (const isProcessAlive of [async () => false, async () => { throw Error('identity unavailable'); }]) {
    await stopDetachedChild({ pid: 999999, createdAt: 'old', boot: 'boot' }, { current: async () => ({ provider: 'linux-proc', value: 'boot' }), processCreatedAt: async () => 'old', isProcessAlive }, signal);
  }
  expect(signal).not.toHaveBeenCalled();
});
