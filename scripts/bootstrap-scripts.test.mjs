import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
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

    const identity = await bootIdentity();
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
        "2147483647",
        "-OldBootIdentity",
        identity.boot,
        "-OldProcessCreatedAt",
        identity.created,
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

function fixtureEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("FILESTATION_") || key === "JWT_SECRET") delete env[key];
  return env;
}

async function bootIdentity() {
  if (process.platform === "linux") return { boot: `linux:${(await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()}`, created: "linux-starttime:1" };
  const probe = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('O', [Globalization.CultureInfo]::InvariantCulture)"], { encoding: "utf8", windowsHide: true });
  assert.equal(probe.status, 0, probe.stderr);
  return { boot: `win32:${probe.stdout.trim()}`, created: "win32:2000-01-01T00:00:00.0000000Z" };
}

function bootstrapArgs(fixture, identity) {
  return ["--root", fixture.install, "--source-root", fixture.legacy, "--old-pid", "2147483647", "--old-boot-identity", identity.boot, "--old-process-created-at", identity.created, "--relative-path-policy", "preserve"];
}

test("compiled CLI bootstrap uses dotenv-only custom paths and non-dry launch loads a side-effect-free fixture", async () => {
  const fixture = await makeFixture();
  const cli = path.join(repositoryRoot, "apps/updater/dist/cli.js");
  const env = fixtureEnvironment();
  try {
    await writeFile(path.join(fixture.legacy, "custom.db"), "fixture custom database");
    await writeFile(path.join(fixture.legacy, ".env"), "FILESTATION_DB_PATH=./custom.db\nFILESTATION_STORAGE_PATH=./custom-storage\nFILESTATION_TEMP_PATH=./custom-temp\nFILESTATION_SERVE_STATIC=fixture-static\nFIXTURE_PRECEDENCE=dotenv\n");
    // This helper and main never import Nest, connect to a service or open user data.
    await mkdir(path.join(fixture.legacy, "apps/server/dist/bootstrap"), { recursive: true });
    await writeFile(path.join(fixture.legacy, "apps/server/dist/bootstrap/bootstrap-snapshot.js"), `const fs = require('node:fs'); const a = process.argv; fs.copyFileSync(a[a.indexOf('--db')+1], a[a.indexOf('--out')+1]); console.log(JSON.stringify({sourceIntegrity:'ok',sourceForeignKeys:0,snapshotIntegrity:'ok',snapshotForeignKeys:0}));`);
    await writeFile(path.join(fixture.legacy, "apps/server/dist/main.js"), `const assert = require('node:assert/strict'); assert.equal(process.env.FILESTATION_SERVE_STATIC, 'fixture-static'); assert.equal(process.env.FIXTURE_PRECEDENCE, 'process'); assert.ok(process.env.FILESTATION_INSTALL_ID); assert.ok(process.env.FILESTATION_RELEASE_ROOT); console.log('FIXTURE_LOADED');`);
    const identity = await bootIdentity();
    const boot = spawnSync(process.execPath, [cli, "bootstrap", ...bootstrapArgs(fixture, identity)], { env, cwd: fixture.root, encoding: "utf8", windowsHide: true });
    assert.equal(boot.status, 0, boot.stderr);
    const result = JSON.parse(boot.stdout);
    assert.deepEqual(result.paths, { database: path.join(fixture.legacy, "custom.db"), storage: path.join(fixture.legacy, "custom-storage"), temp: path.join(fixture.legacy, "custom-temp") });
    const wrongCwd = spawnSync(process.execPath, [cli, "launch", "--root", fixture.install], { env: { ...env, FIXTURE_PRECEDENCE: "process" }, cwd: fixture.root, encoding: "utf8", windowsHide: true });
    assert.notEqual(wrongCwd.status, 0);
    assert.doesNotMatch(wrongCwd.stdout, /FIXTURE_LOADED/);
    assert.match(wrongCwd.stderr, /cwd/i);
    const launch = spawnSync(process.execPath, [cli, "launch", "--root", fixture.install], { env: { ...env, FIXTURE_PRECEDENCE: "process" }, cwd: fixture.install, encoding: "utf8", windowsHide: true });
    assert.equal(launch.status, 0, launch.stderr);
    assert.match(launch.stdout, /FIXTURE_LOADED/);
    for (const name of ["custom-storage", "custom-temp"]) await assert.rejects(access(path.join(fixture.legacy, name)), { code: "ENOENT" });
  } finally {
    assert.ok(fixture.root.startsWith(tmpdir() + path.sep) && path.basename(fixture.root).startsWith("filestation-task6-script-"));
    await unlink(path.join(fixture.install, "current")).catch(e => { if (e.code !== "ENOENT") throw e; });
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Linux shell scripts perform fixture bootstrap and launch dry runs", async (t) => {
  if (process.platform !== "linux") return t.skip("Linux bash fixture execution pending on Linux");
  const fixture = await makeFixture(); const env = fixtureEnvironment();
  try {
    const identity = await bootIdentity();
    const boot = spawnSync("bash", [path.join(repositoryRoot, "scripts/bootstrap-update.sh"), ...bootstrapArgs(fixture, identity), "--dry-run"], { env, cwd: fixture.root, encoding: "utf8" });
    assert.equal(boot.status, 0, boot.stderr); assert.match(boot.stdout, /dry-run/);
    await assert.rejects(access(fixture.install), { code: "ENOENT" });
    const release = path.join(fixture.install, "releases/v0.2.0");
    await mkdir(path.join(release, "apps/server/dist"), { recursive: true });
    await writeFile(path.join(release, "apps/server/dist/main.js"), "fixture");
    await writeFile(path.join(fixture.install, "managed-install.json"), JSON.stringify({ schemaVersion:1, installId:"fixture", installRoot:fixture.install, currentPath:path.join(fixture.install,"current"), environmentPath:path.join(fixture.install,".env"), paths:{database:path.join(fixture.root,"data/db"),storage:path.join(fixture.root,"data/storage"),temp:path.join(fixture.root,"data/temp")},bootstrapBackupId:"fixture",bootstrapFingerprint:"a".repeat(64),createdAt:"2026-10-28T00:00:00.000Z" }));
    await symlink(release, path.join(fixture.install,"current"), "dir");
    const launch = spawnSync("bash", [path.join(repositoryRoot,"scripts/start-filestation.sh"), "--root", fixture.install, "--dry-run"], { env, cwd: fixture.root, encoding:"utf8" });
    assert.equal(launch.status, 0, launch.stderr); assert.match(launch.stdout, /dry-run/);
    await assert.rejects(access(path.join(fixture.root,"data")), { code:"ENOENT" });
  } finally {
    assert.ok(fixture.root.startsWith(tmpdir()+path.sep) && path.basename(fixture.root).startsWith("filestation-task6-script-"));
    await unlink(path.join(fixture.install,"current")).catch(e=>{if(e.code!=="ENOENT")throw e;});
    await rm(fixture.root,{recursive:true,force:true});
  }
});
