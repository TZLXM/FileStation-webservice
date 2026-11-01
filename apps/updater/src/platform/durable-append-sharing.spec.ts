import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AttemptJournal } from '../state/attempt-journal';
import { NodeDurableFileSystem, WindowsNativeApi } from './durable-fs';

function stubApi(): jest.Mocked<WindowsNativeApi> {
  return { create: jest.fn<ReturnType<WindowsNativeApi['create']>, Parameters<WindowsNativeApi['create']>>(() => ({})),
    write: jest.fn((_handle: unknown, bytes: Buffer) => bytes.length),
    flush: jest.fn(), close: jest.fn(), move: jest.fn(), volumePath: jest.fn(),
    volumeSerial: jest.fn(), volumeGuid: jest.fn() };
}

// Test-only backend substitution through the existing protected member.
class BackendFileSystem extends NodeDurableFileSystem {
  protected readonly windows = { api: stubApi(), diagnostics: {
    flushFileBuffers: 0, writeThroughFile: 0, writeThroughRename: 0, aclProtections: 0,
  } };
  constructor() { super('linux'); }
  nativeApi() { return this.windows.api; }
  async protect() {} // Native ACL behavior is covered by durable-fs.spec.ts.
}

class ObservedNativeFileSystem extends NodeDurableFileSystem {
  nativeApi() { return this.windows!.api; }
}

describe('Windows append handle acquisition', () => {
  let root: string;
  let filename: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'filestation-append-sharing-'));
    filename = path.join(root, 'record');
    await writeFile(filename, 'before\n');
  });
  afterEach(async () => { jest.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

  it('retries only sharing acquisition and writes/flushes/closes once with exclusive write-through flags', async () => {
    const fs = new BackendFileSystem();
    const api = fs.nativeApi();
    const busy = Object.assign(new Error('sharing'), { win32Code: 32 });
    api.create.mockImplementationOnce(() => { throw busy; });
    await fs.append(filename, Buffer.from('record\n'));
    expect(api.create).toHaveBeenCalledTimes(2);
    expect(api.create).toHaveBeenLastCalledWith(filename, 4, 0, 4, 0x80 | 0x80000000);
    expect(api.write).toHaveBeenCalledTimes(1);
    expect(api.flush).toHaveBeenCalledTimes(1);
    expect(api.close).toHaveBeenCalledTimes(1);
  });

  it.each([5, 33])('propagates non-32 acquisition error %s without retry or mutation', async (win32Code) => {
    const fs = new BackendFileSystem();
    const api = fs.nativeApi();
    const error = Object.assign(new Error('acquire failed'), { win32Code });
    api.create.mockImplementation(() => { throw error; });
    await expect(fs.append(filename, Buffer.from('record\n'))).rejects.toBe(error);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.write).not.toHaveBeenCalled();
    expect(api.close).not.toHaveBeenCalled();
  });

  it.each(['write', 'flush', 'close'] as const)('never replays after %s throws even sharing error32', async (stage) => {
    const fs = new BackendFileSystem();
    const api = fs.nativeApi();
    const error = Object.assign(new Error(`${stage} failed`), { win32Code: 32 });
    api[stage].mockImplementation(() => { throw error; });
    await expect(fs.append(filename, Buffer.from('record\n'))).rejects.toBe(error);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.write).toHaveBeenCalledTimes(1);
    expect(api.flush).toHaveBeenCalledTimes(stage === 'write' ? 0 : 1);
    expect(api.close).toHaveBeenCalledTimes(1);
  });

  const nativeTest = process.platform === 'win32' ? it : it.skip;
  nativeTest('appends exactly one strict journal record after a real reader closes within budget', async () => {
    const fs = new ObservedNativeFileSystem();
    const journal = await AttemptJournal.open(root, { fs });
    await journal.beginAttempt({ attemptId: 'sharing-test', fence: 1,
      currentVersion: '0.2.5', targetVersion: '0.2.6', phase: 'PREPARED',
      owner: { bootIdentity: 'synthetic-boot', pid: process.pid,
        processCreatedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() } });
    const before = await readFile(journal.filename);
    const reader = await open(journal.filename, 'r');
    const api = fs.nativeApi();
    const create = api.create.bind(api);
    let release: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let collisions = 0;
    jest.spyOn(api, 'create').mockImplementation((...args) => {
      try { return create(...args); }
      catch (error) {
        if (error && typeof error === 'object' && 'win32Code' in error && error.win32Code === 32) {
          collisions++;
          if (!timer) timer = setTimeout(() => { release = reader.close(); }, 40);
        }
        throw error;
      }
    });
    try {
      await journal.appendIntent({ attemptId: 'sharing-test', fence: 1, action: 'commit-update', phase: 'COMMITTED' });
      await release;
      const after = await readFile(journal.filename);
      expect(after.subarray(0, before.length)).toEqual(before);
      expect(after.subarray(before.length).toString().trim().split('\n')).toHaveLength(1);
      const snapshot = await AttemptJournal.inspect(root);
      expect(snapshot.records).toHaveLength(2);
      expect(snapshot.records[1]).toMatchObject({ kind: 'intent', action: 'commit-update', seq: 2 });
      expect(collisions).toBeGreaterThan(0);
    } finally {
      if (timer) clearTimeout(timer);
      await (release ?? reader.close());
    }
  }, 15000);

  nativeTest('expires while a real reader remains open with unchanged bytes and original native error', async () => {
    const fs = new ObservedNativeFileSystem();
    const reader = await open(filename, 'r');
    const api = fs.nativeApi();
    const create = api.create.bind(api);
    let lastError: unknown;
    let attempts = 0;
    jest.spyOn(api, 'create').mockImplementation((...args) => {
      attempts++;
      try { return create(...args); } catch (error) { lastError = error; throw error; }
    });
    const start = performance.now();
    try {
      const failure = await fs.append(filename, Buffer.from('never\n')).then(
        () => { throw new Error('Expected acquisition to expire'); },
        (error: unknown) => error,
      );
      const elapsed = performance.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(2500);
      expect(attempts).toBeGreaterThan(1);
      expect(failure).toBe(lastError);
      expect(lastError).toMatchObject({ win32Code: 32 });
      expect(await reader.readFile('utf8')).toBe('before\n');
    } finally { await reader.close(); }
    expect(await readFile(filename, 'utf8')).toBe('before\n');
  }, 10000);
});
