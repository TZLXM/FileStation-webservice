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
          await execFileAsync("icacls.exe", [protectedPath, "/grant", "*S-1-1-0:F", "*S-1-5-32-545:R"], { windowsHide: true });
          await fs.protect(protectedPath, protectedPath === dir);
          const script = `$acl = [System.IO.${protectedPath === dir ? 'Directory' : 'File'}]::GetAccessControl('${protectedPath.replace(/'/g, "''")}'); [pscustomobject]@{ Protected=$acl.AreAccessRulesProtected; User=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; Rules=@($acl.Access | ForEach-Object { [pscustomobject]@{ SID=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; Inherited=$_.IsInherited } }) } | ConvertTo-Json -Depth 5 -Compress`;
          const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
          const acl = JSON.parse(stdout);
          expect(acl.Protected).toBe(true);
          expect(acl.Rules.map((rule: any) => rule.SID).sort()).toEqual([...new Set([acl.User, "S-1-5-18", "S-1-5-32-544"])].sort());
          expect(acl.Rules.every((rule: any) => !rule.Inherited)).toBe(true);
        }
      } finally {
        await temp.cleanup();
      }
    },
  );
});
