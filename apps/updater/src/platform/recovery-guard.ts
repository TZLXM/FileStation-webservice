import { constants } from "node:fs";
import { open } from "node:fs/promises";
import koffi from "koffi";
import { createWindowsNativeApi, WindowsNativeApi } from "./durable-fs";

export interface RecoveryGuardOptions {
  platform?: NodeJS.Platform;
  windowsApi?: Pick<WindowsNativeApi, "create" | "close">;
  posix?: {
    open(filename: string): Promise<{ fd: number; close(): Promise<void> }>;
    flock(fd: number, operation: number): number;
  };
}
export interface RecoveryGuard { assertActive(): Promise<void>; release(): Promise<void>; }
/** Permanent guard inode/path. Never rename or unlink it during installation life.
 * The kernel owns exclusion and releases it on process death, including SIGKILL.
 * Acquisition is nonblocking; contention and unsupported platforms fail closed.
 */
export async function acquireRecoveryGuard(filename: string, options: RecoveryGuardOptions = {}): Promise<RecoveryGuard> {
  const platform = options.platform ?? process.platform;
  let close: () => Promise<void>;
  if (platform === "win32") {
    const api = options.windowsApi ?? createWindowsNativeApi();
    // share=0 denies other opens/renames/deletes while this handle is retained.
    const handle = api.create(filename, 0xc0000000, 0, 4, 0x80000000);
    close = async () => { api.close(handle); };
  } else if (platform === "linux") {
    const backend = options.posix ?? {
      open: (name: string) => open(name, constants.O_RDWR | constants.O_CREAT, 0o600),
      flock: koffi.load("libc.so.6").func("int flock(int fd, int operation)"),
    };
    const file = await backend.open(filename);
    if (backend.flock(file.fd, 2 | 4) !== 0) { await file.close(); throw new Error("Recovery OS guard is held or unavailable"); }
    close = async () => { await file.close(); };
  } else { throw new Error("Recovery OS guard unsupported on this platform"); }
  let released = false;
  return {
    async assertActive() { if (released) throw new Error("Recovery OS guard released"); },
    async release() { if (!released) { released = true; await close(); } },
  };
}
