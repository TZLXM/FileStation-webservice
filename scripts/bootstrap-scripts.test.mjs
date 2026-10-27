import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "filestation-task6-script-"));
  const legacy = path.join(root, "legacy");
  const install = path.join(root, "managed");
  await mkdir(path.join(legacy, "apps/server/dist"), { recursive: true });
  await mkdir(path.join(legacy, "apps/updater/dist"), { recursive: true });
  await mkdir(path.join(legacy, "data/storage"), { recursive: true });
  await mkdir(path.join(legacy, "data/temp"), { recursive: true });
  await writeFile(
    path.join(legacy, "package.json"),
    `${JSON.stringify({ name: "fixture", version: "0.2.0" })}\n`,
  );
  await writeFile(
    path.join(legacy, "apps/server/dist/main.js"),
    "fixture server\n",
  );
  await writeFile(
    path.join(legacy, "apps/updater/dist/cli.js"),
    "fixture updater\n",
  );
  await writeFile(path.join(legacy, "data/filestation.db"), "fixture db");
  await writeFile(
    path.join(legacy, ".env"),
    [
      "FILESTATION_DB_PATH=./data/filestation.db",
      "FILESTATION_STORAGE_PATH=./data/storage",
      "FILESTATION_TEMP_PATH=./data/temp",
      "JWT_SECRET=fixture-only-secret",
      "",
    ].join("\n"),
  );
  return { root, legacy, install };
}

test("PowerShell scripts parse and bootstrap/launch dry runs stay inside the fixture", async (t) => {
  if (process.platform !== "win32") {
    t.skip("PowerShell parser and dry run are Windows-specific");
    return;
  }
  const fixture = await makeFixture();
  try {
    for (const script of [
      "scripts/bootstrap-update.ps1",
      "scripts/start-filestation.ps1",
    ]) {
      const parsed = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${path
            .join(repositoryRoot, script)
            .replaceAll("'", "''")}', [ref]$null, [ref]$errors) > $null; if ($errors.Count) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }`,
        ],
        { encoding: "utf8", windowsHide: true },
      );
      assert.equal(parsed.status, 0, parsed.stderr);
    }

    const bootstrap = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(repositoryRoot, "scripts/bootstrap-update.ps1"),
        "-Root",
        fixture.install,
        "-SourceRoot",
        fixture.legacy,
        "-OldPid",
        "4242",
        "-OldBootIdentity",
        "fixture-boot",
        "-OldProcessCreatedAt",
        "linux-starttime:123",
        "-RelativePathPolicy",
        "preserve",
        "-DryRun",
      ],
      { encoding: "utf8", windowsHide: true, cwd: fixture.root },
    );
    assert.equal(bootstrap.status, 0, bootstrap.stderr);
    assert.match(bootstrap.stdout, /dry-run/i);
    await assert.rejects(access(fixture.install), { code: "ENOENT" });

    const start = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(repositoryRoot, "scripts/start-filestation.ps1"),
        "-Root",
        fixture.install,
        "-DryRun",
      ],
      { encoding: "utf8", windowsHide: true, cwd: fixture.root },
    );
    assert.notEqual(start.status, 0);
    assert.match(
      `${start.stdout}\n${start.stderr}`,
      /managed-install|metadata/i,
    );
    await assert.rejects(access(fixture.install), { code: "ENOENT" });

    const release = path.join(fixture.install, "releases", "v0.2.0");
    const data = path.join(fixture.install, "data");
    await mkdir(path.join(release, "apps/server/dist"), { recursive: true });
    await mkdir(data, { recursive: true });
    await writeFile(
      path.join(release, "apps/server/dist/main.js"),
      "fixture managed server\n",
    );
    await writeFile(
      path.join(fixture.install, ".env"),
      [
        `FILESTATION_DB_PATH=${path.join(data, "filestation.db")}`,
        `FILESTATION_STORAGE_PATH=${path.join(data, "storage")}`,
        `FILESTATION_TEMP_PATH=${path.join(data, "temp")}`,
        "FILESTATION_SERVE_STATIC=true",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(fixture.install, "managed-install.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        installId: "fixture-install",
        installRoot: fixture.install,
        currentPath: path.join(fixture.install, "current"),
        environmentPath: path.join(fixture.install, ".env"),
        paths: {
          database: path.join(data, "filestation.db"),
          storage: path.join(data, "storage"),
          temp: path.join(data, "temp"),
        },
        bootstrapBackupId: "fixture-backup",
        bootstrapFingerprint: "a".repeat(64),
        createdAt: "2026-10-28T00:00:00.000Z",
      })}\n`,
    );
    await symlink(
      release,
      path.join(fixture.install, "current"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const validStart = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(repositoryRoot, "scripts/start-filestation.ps1"),
        "-Root",
        fixture.install,
        "-DryRun",
      ],
      { encoding: "utf8", windowsHide: true, cwd: fixture.root },
    );
    assert.equal(validStart.status, 0, validStart.stderr);
    assert.match(validStart.stdout, /"state": "dry-run"/);
    await assert.rejects(access(path.join(data, "storage")), {
      code: "ENOENT",
    });
    await assert.rejects(access(path.join(data, "temp")), { code: "ENOENT" });
  } finally {
    if (
      fixture.root.startsWith(tmpdir() + path.sep) &&
      path.basename(fixture.root).startsWith("filestation-task6-script-")
    ) {
      try {
        await unlink(path.join(fixture.install, "current"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("POSIX scripts pass bash syntax validation when bash is available", async (t) => {
  if (process.platform !== "linux") {
    t.skip("bash -n is exercised on Linux");
    return;
  }
  const bashProbe = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (bashProbe.error?.code === "ENOENT") {
    t.skip("bash is unavailable");
    return;
  }
  for (const script of [
    "scripts/bootstrap-update.sh",
    "scripts/start-filestation.sh",
  ]) {
    const parsed = spawnSync("bash", [
      "-n",
      path.join(repositoryRoot, script),
    ]);
    assert.equal(parsed.status, 0);
  }
});

test("help output describes manual bootstrap and restore without loading the server", async () => {
  const cli = path.join(repositoryRoot, "apps/updater/dist/cli.js");
  const result = spawnSync(process.execPath, [cli, "--help"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bootstrap/);
  assert.match(result.stdout, /restore/i);
  assert.doesNotMatch(result.stdout, /JWT_SECRET=/);
});
