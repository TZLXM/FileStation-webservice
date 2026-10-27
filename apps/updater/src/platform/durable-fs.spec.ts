import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  NodeDurableFileSystem,
  WindowsDurableFileSystem,
} from "./durable-fs";
import { createTempRoot } from "../test-support";

const execFileAsync = promisify(execFile);

describe("DurableFileSystem", () => {
  it("uses real exclusive creation, flush, rename, and private permissions", async () => {
    const temp = await createTempRoot();
    try {
      const fs = new NodeDurableFileSystem();
      const privateDir = path.join(temp.path, "private");
      const first = path.join(privateDir, "first.json");
      const second = path.join(privateDir, "second.json");
      await fs.ensurePrivateDirectory(privateDir);
      await fs.createExclusive(first, Buffer.from('{"one":1}\n'), {
        mode: 0o600,
      });

      await expect(
        fs.createExclusive(first, Buffer.from("duplicate"), { mode: 0o600 }),
      ).rejects.toMatchObject({ code: "EEXIST" });
      await fs.writeAtomic(second, Buffer.from('{"two":2}\n'), {
        mode: 0o600,
      });
      await fs.rename(second, first, { replace: true });
      expect(await readFile(first, "utf8")).toBe('{"two":2}\n');
      if (process.platform !== "win32") {
        expect((await stat(privateDir)).mode & 0o777).toBe(0o700);
        expect((await stat(first)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await temp.cleanup();
    }
  });

  const winTest = process.platform === "win32" ? it : it.skip;

  winTest(
    "runs the real Win32 write-through path and records FlushFileBuffers",
    async () => {
      const temp = await createTempRoot();
      try {
        const fs = new WindowsDurableFileSystem();
        const dir = path.join(temp.path, "durable");
        const source = path.join(dir, "source");
        const target = path.join(dir, "target");
        await fs.ensurePrivateDirectory(dir);
        await fs.writeAtomic(source, Buffer.from("durable\n"), {
          mode: 0o600,
        });
        await fs.rename(source, target, { replace: true });
        expect(await readFile(target, "utf8")).toBe("durable\n");
        expect(fs.diagnostics.flushFileBuffers).toBeGreaterThan(0);
        expect(fs.diagnostics.writeThroughFile).toBeGreaterThan(0);
        expect(fs.diagnostics.writeThroughRename).toBeGreaterThan(0);
      } finally {
        await temp.cleanup();
      }
    },
  );

  winTest(
    "applies protected ACLs to files and directories using the native ACL command",
    async () => {
      const temp = await createTempRoot();
      try {
        const fs = new WindowsDurableFileSystem();
        const dir = path.join(temp.path, "acl-dir");
        const file = path.join(dir, "acl-file");
        await fs.ensurePrivateDirectory(dir);
        await fs.writeAtomic(file, Buffer.from("private"), { mode: 0o600 });
        expect(fs.diagnostics.aclProtections).toBeGreaterThanOrEqual(2);
        expect(await readFile(file, "utf8")).toBe("private");
        for (const protectedPath of [dir, file]) {
          const { stdout } = await execFileAsync(
            "icacls.exe",
            [protectedPath],
            { windowsHide: true },
          );
          expect(stdout).not.toContain("(I)");
          const explicitRules = stdout
            .split(/\r?\n/)
            .filter(
              (line) =>
                line.includes(":") &&
                !line.toLocaleLowerCase().includes("processed"),
            );
          expect(explicitRules.length).toBeGreaterThanOrEqual(3);
        }
      } finally {
        await temp.cleanup();
      }
    },
  );
});
