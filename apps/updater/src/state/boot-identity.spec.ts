import { spawn, ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { open, readFile } from 'node:fs/promises';
import {
  BootIdentityError,
  PlatformBootIdentityProvider,
  canonicalWindowsCimTimestamp,
} from "./boot-identity";

// Test-only waits retain the owned ChildProcess and detach every listener/timer.
async function waitForFixtureChild(child: ChildProcess, event: 'message' | 'exit', timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (event === 'exit') return;
    throw new Error('fixture child exited before message');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const expected = once(child, event, { signal: controller.signal });
    const candidates = [expected];
    if (event === 'message') candidates.push(once(child, 'exit', { signal: controller.signal }).then(() => {
      throw new Error('fixture child exited before message');
    }));
    await Promise.race(candidates);
  } catch (error) {
    if (controller.signal.aborted) throw new Error('fixture child ' + event + ' exceeded ' + timeoutMs + 'ms');
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

describe('owned process fixture lifecycle', () => {
  it.each(['message', 'exit'] as const)('bounds a missing child %s and proves final cleanup', async event => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    let observer: ReturnType<typeof setTimeout> | undefined;
    try {
      const observed = await Promise.race([
        waitForFixtureChild(child, event, 40).then(() => ({ kind: 'resolved', error: undefined }), error => ({ kind: 'rejected', error })),
        new Promise<{ kind: string; error: undefined }>(resolve => { observer = setTimeout(() => resolve({ kind: 'hung', error: undefined }), 300); }),
      ]);
      expect(observed.kind).toBe('rejected');
      expect(observed.error?.message).toMatch(/fixture child (message|exit) exceeded 40ms/);
    } finally {
      if (observer) clearTimeout(observer);
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.all([waitForFixtureChild(child, 'exit'), Promise.resolve().then(() => child.kill('SIGKILL'))]);
      }
    }
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 10_000);
  it('rejects a child exit before readiness and proves final cleanup', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    let observer: ReturnType<typeof setTimeout> | undefined;
    try {
      const observed = await Promise.race([
        waitForFixtureChild(child, 'message').then(() => ({ kind: 'resolved', error: undefined }), error => ({ kind: 'rejected', error })),
        new Promise<{ kind: string; error: undefined }>(resolve => { observer = setTimeout(() => resolve({ kind: 'hung', error: undefined }), 6_000); }),
      ]);
      expect(observed.kind).toBe('rejected');
      expect(observed.error?.message).toMatch(/fixture child exited before message/);
    } finally {
      if (observer) clearTimeout(observer);
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.all([waitForFixtureChild(child, 'exit'), Promise.resolve().then(() => child.kill('SIGKILL'))]);
      }
    }
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 10_000);
});

describe("PlatformBootIdentityProvider", () => {
  const winTest = process.platform === "win32" ? it : it.skip;
  const linuxTest = process.platform === "linux" ? it : it.skip;

  it("reads and validates Linux boot and process identities", async () => {
    const files = new Map([
      [
        "/proc/sys/kernel/random/boot_id",
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n",
      ],
      [
        "/proc/4242/stat",
        "4242 (worker with spaces) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20 21\n",
      ],
    ]);
    const provider = new PlatformBootIdentityProvider({
      platform: "linux",
      readFile: async (filename) => {
        const value = files.get(filename);
        if (!value) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return value;
      },
    });

    expect(await provider.current()).toEqual({
      provider: "linux-proc",
      value: "linux:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
    expect(await provider.processCreatedAt(4242)).toBe(
      "linux-starttime:987654",
    );
  });

  it("fails closed when Linux boot identity is unavailable", async () => {
    const provider = new PlatformBootIdentityProvider({
      platform: "linux",
      readFile: async () => {
        throw Object.assign(new Error("unavailable"), { code: "EACCES" });
      },
    });
    await expect(provider.current()).rejects.toBeInstanceOf(BootIdentityError);
  });

  it("maps a Linux listening socket inode to its owning PID", async () => {
    const provider = new PlatformBootIdentityProvider({
      platform: "linux",
      readFile: async (filename) => {
        if (filename === "/proc/net/tcp") {
          return [
            "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
            "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 424242 1",
          ].join("\n");
        }
        if (filename === "/proc/net/tcp6") return "";
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      readDirectory: async () => ["1", "4321", "self"],
      readLink: async (filename) =>
        filename.includes("/4321/") ? "socket:[424242]" : "socket:[1]",
    });
    expect(await provider.listeningPid(8080)).toBe(4321);
  });

  it("uses PowerShell CIM for canonical Windows boot and process creation times", async () => {
    const scripts: string[] = [];
    const provider = new PlatformBootIdentityProvider({
      platform: "win32",
      runPowerShell: async (script) => {
        scripts.push(script);
        if (script.includes("Win32_OperatingSystem")) {
          return "10/27/2026 01:02:03Z\n";
        }
        return "2026-10-27T01:05:06.1234567Z\n";
      },
    });

    expect(await provider.current()).toEqual({
      provider: "windows-cim",
      value: "win32:2026-10-27T01:02:03.000Z",
    });
    expect(await provider.processCreatedAt(77)).toBe(
      "win32:2026-10-27T01:05:06.1234567Z",
    );
    expect(scripts.some((script) => script.includes("Get-CimInstance"))).toBe(
      true,
    );
  });

  it("normalizes valid CIM UTC timestamps and rejects missing or malformed values", () => {
    expect(canonicalWindowsCimTimestamp("2026-10-27T01:02:03Z")).toBe(
      "2026-10-27T01:02:03.000Z",
    );
    expect(canonicalWindowsCimTimestamp("10/27/2026 01:02:03Z")).toBe(
      "2026-10-27T01:02:03.000Z",
    );
    expect(() => canonicalWindowsCimTimestamp("")).toThrow(BootIdentityError);
    expect(() => canonicalWindowsCimTimestamp("not-a-time")).toThrow(
      BootIdentityError,
    );
  });

  winTest("reads real Windows CIM boot and process creation identities", async () => {
    const provider = new PlatformBootIdentityProvider({ platform: "win32" });
    const boot = await provider.current();
    const creation = await provider.processCreatedAt(process.pid);
    expect(boot.provider).toBe("windows-cim");
    expect(boot.value).toMatch(/^win32:\d{4}-\d\d-\d\dT.*Z$/);
    expect(creation).toMatch(/^win32:\d{4}-\d\d-\d\dT.*Z$/);
    expect(await provider.isProcessAlive(process.pid, creation)).toBe(true);
  }, 20_000);

  linuxTest("reads the real Linux boot and process start identities", async () => {
    const provider = new PlatformBootIdentityProvider({ platform: "linux" });
    const boot = await provider.current();
    const creation = await provider.processCreatedAt(process.pid);
    expect(boot.provider).toBe("linux-proc");
    expect(boot.value).toMatch(/^linux:[a-f0-9-]+$/);
    expect(creation).toMatch(/^linux-starttime:\d+$/);
    expect(await provider.isProcessAlive(process.pid, creation)).toBe(true);
  });
  linuxTest('recognizes stat ESRCH when a verified child exits between open and read', async () => {
    const child = spawn(process.execPath, ['-e', "process.send('ready');setTimeout(()=>process.exit(0),5000)"], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    try {
      await waitForFixtureChild(child, 'message');
      const identity = new PlatformBootIdentityProvider({ platform: 'linux' });
      const creation = await identity.processCreatedAt(child.pid!);
      expect(await identity.isProcessAlive(child.pid!, creation)).toBe(true);
      const statPath = '/proc/' + child.pid + '/stat';
      let readError: NodeJS.ErrnoException | undefined;
      const exiting = new PlatformBootIdentityProvider({ platform: 'linux', readFile: async filename => {
        if (filename !== statPath) return readFile(filename, 'utf8');
        const handle = await open(filename, 'r');
        try {
          await Promise.all([waitForFixtureChild(child, 'exit'), Promise.resolve().then(() => child.kill('SIGTERM'))]);
          return await handle.readFile('utf8');
        } catch (error) {
          readError = error as NodeJS.ErrnoException;
          throw error;
        } finally { await handle.close(); }
      } });
      const observed = await exiting.isProcessAlive(child.pid!, creation).then(
        alive => ({ alive, error: undefined }), error => ({ alive: undefined, error }),
      );
      expect(readError).toMatchObject({ code: 'ESRCH', syscall: 'read' });
      expect(observed.error).toBeUndefined();
      expect(observed.alive).toBe(false);
      expect(await identity.isProcessAlive(child.pid!, creation)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.all([waitForFixtureChild(child, 'exit'), Promise.resolve().then(() => child.kill('SIGKILL'))]);
      }
    }
  }, 20_000);

});

describe("review identity failures", () => {
  it.each(['ENOENT', 'ESRCH'])('recognizes Linux stat %s as absence without probing a bare PID', async code => {
    const probe = jest.fn(() => true);
    const provider = new PlatformBootIdentityProvider({ platform: 'linux', kill: probe,
      readFile: async filename => {
        expect(filename).toBe('/proc/123/stat');
        throw Object.assign(new Error('stat target disappeared'), { code });
      },
    });
    await expect(provider.processCreatedAt(123)).rejects.toThrow();
    await expect(provider.isProcessAlive(123, 'linux-starttime:987654')).resolves.toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "EPERM", "EIO", "malformed"])("fails closed on Linux %s with a live PID probe", async code => {
    const provider = new PlatformBootIdentityProvider({ platform: "linux", kill: () => true,
      readFile: async () => { if (code === "malformed") return "bad stat"; throw Object.assign(new Error(code), { code }); } });
    await expect(provider.isProcessAlive(123, "old")).rejects.toBeInstanceOf(BootIdentityError);
  });
  it("fails closed on CIM failure and malformed response", async () => {
    for (const response of ["failure", "malformed"]) {
      const provider = new PlatformBootIdentityProvider({ platform: "win32", kill: () => true,
        runPowerShell: async () => { if (response === "failure") throw new Error("CIM unavailable"); return "garbage"; } });
      await expect(provider.isProcessAlive(123, "old")).rejects.toBeInstanceOf(BootIdentityError);
    }
  });
  it("accepts only confirmed absence", async () => {
    const linux = new PlatformBootIdentityProvider({ platform: "linux", readFile: async () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); } });
    expect(await linux.isProcessAlive(123, "old")).toBe(false);
    const win = new PlatformBootIdentityProvider({ platform: "win32", runPowerShell: async () => { throw Object.assign(new Error("absent"), { code: 3 }); } });
    expect(await win.isProcessAlive(123, "old")).toBe(false);
  });
});
