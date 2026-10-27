import { spawn } from "node:child_process";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { acquireRecoveryGuard } from "./recovery-guard";
import { createTempRoot } from "../test-support";

it.each(["exit", "kill"])("retains real OS exclusion and releases on child %s", async mode => {
  const temp = await createTempRoot();
  const filename = path.join(temp.path, "permanent.guard");
  const source = path.resolve(__dirname, "recovery-guard.ts");
  const script = `require(${JSON.stringify(source)}).acquireRecoveryGuard(${JSON.stringify(filename)}).then(() => { process.stdout.write('ready'); process.stdin.resume(); process.stdin.on('data', () => process.exit(0)); });`;
  const child = spawn(process.execPath, ["-r", require.resolve("ts-node/register"), "-e", script], { env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "true" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); child.once("exit", () => reject(new Error("child exited before ready"))); });
    await expect(acquireRecoveryGuard(filename)).rejects.toThrow();
    if (mode === "kill") child.kill("SIGKILL"); else child.stdin.write("exit");
    await exited;
    const guard = await acquireRecoveryGuard(filename);
    await guard.assertActive(); await guard.release();
    expect(await readFile(filename)).toHaveLength(0);
    const again = await acquireRecoveryGuard(filename); await again.release();
  } finally { child.kill(); await exited; await temp.cleanup(); }
}, 20000);

it("uses retained Windows share-denial handles and nonblocking Linux flock adapter sequences", async () => {
  const calls: any[] = [];
  const win = await acquireRecoveryGuard("guard", { platform: "win32", windowsApi: {
    create: (...args) => { calls.push(args); return "handle"; }, close: handle => { calls.push(["close", handle]); },
  } });
  expect(calls).toEqual([["guard", 0xc0000000, 0, 4, 0x80000000]]);
  await win.release(); await win.release(); expect(calls.at(-1)).toEqual(["close", "handle"]); expect(calls).toHaveLength(2);
  calls.length = 0;
  const posix = { open: async (name: string) => { calls.push(["open", name]); return { fd: 42, close: async () => { calls.push(["close", 42]); } }; }, flock: (fd: number, flags: number) => { calls.push(["flock", fd, flags]); return 0; } };
  const linux = await acquireRecoveryGuard("guard", { platform: "linux", posix });
  expect(calls).toEqual([["open", "guard"], ["flock", 42, 6]]); await linux.release();
  expect(calls.at(-1)).toEqual(["close", 42]);
  await expect(acquireRecoveryGuard("guard", { platform: "linux", posix: { ...posix, flock: () => -1 } })).rejects.toThrow(/held or unavailable/);
  expect(calls.at(-1)).toEqual(["close", 42]);
});
