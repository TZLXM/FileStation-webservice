import { parse as parseDotenv } from "dotenv";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BootstrapManagedInstallOptions,
  bootstrapManagedInstall,
  inspectManagedUpdate,
  recoverManagedUpdate,
} from "./bootstrap-command";
import type { ProcessIdentityProvider } from "../state/boot-identity";
import { NodeDurableFileSystem } from "../platform/durable-fs";
import { AttemptJournal } from "../state/attempt-journal";
import { context } from "../test-support";

jest.setTimeout(30_000);

interface SourceFixture {
  root: string;
  legacyRoot: string;
  installRoot: string;
  envPath: string;
  nginxPath: string;
}

async function sourceFixture(): Promise<SourceFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "filestation-task6-bootstrap-"));
  const legacyRoot = path.join(root, "legacy");
  const installRoot = path.join(root, "managed");
  await mkdir(path.join(legacyRoot, "apps/server/dist"), { recursive: true });
  await mkdir(path.join(legacyRoot, "apps/updater/dist"), { recursive: true });
  await mkdir(path.join(legacyRoot, "apps/web/dist-root"), { recursive: true });
  await mkdir(path.join(legacyRoot, "apps/web/dist-fs"), { recursive: true });
  await mkdir(path.join(legacyRoot, "packages/shared/dist"), {
    recursive: true,
  });
  await mkdir(path.join(legacyRoot, "packages/update-core/dist"), {
    recursive: true,
  });
  await mkdir(path.join(legacyRoot, "node_modules/fixture-package"), {
    recursive: true,
  });
  await mkdir(path.join(legacyRoot, "packages/fixture-workspace"), {
    recursive: true,
  });
  await mkdir(path.join(legacyRoot, "data/storage"), { recursive: true });
  await mkdir(path.join(legacyRoot, "data/temp"), { recursive: true });
  await mkdir(path.join(legacyRoot, "logs"), { recursive: true });
  await mkdir(path.join(legacyRoot, ".git"), { recursive: true });
  await writeFile(
    path.join(legacyRoot, "package.json"),
    `${JSON.stringify({ name: "fixture", version: "0.2.0" }, null, 2)}\n`,
  );
  await writeFile(
    path.join(legacyRoot, "apps/server/dist/main.js"),
    "fixture server\n",
  );
  await writeFile(
    path.join(legacyRoot, "apps/updater/dist/cli.js"),
    "fixture updater\n",
  );
  await writeFile(
    path.join(legacyRoot, "apps/web/dist-root/index.html"),
    "<html>fixture</html>\n",
  );
  await writeFile(
    path.join(legacyRoot, "apps/web/dist-fs/index.html"),
    "<html>fixture /fs/</html>\n",
  );
  await writeFile(
    path.join(legacyRoot, "packages/shared/dist/index.js"),
    "fixture shared\n",
  );
  await writeFile(
    path.join(legacyRoot, "packages/update-core/dist/index.js"),
    "fixture core\n",
  );
  await writeFile(
    path.join(legacyRoot, "node_modules/fixture-package/index.js"),
    "fixture dependency\n",
  );
  await writeFile(
    path.join(legacyRoot, "packages/fixture-workspace/index.js"),
    "fixture workspace\n",
  );
  await symlink(
    path.join(legacyRoot, "packages/fixture-workspace"),
    path.join(legacyRoot, "node_modules/fixture-workspace"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await writeFile(path.join(legacyRoot, "src.txt"), "fixture source\n");
  await writeFile(
    path.join(legacyRoot, "data/filestation.db"),
    "fixture database",
  );
  await writeFile(path.join(legacyRoot, "data/files.db-wal"), "fixture wal");
  await writeFile(
    path.join(legacyRoot, "data/storage/keep.bin"),
    "storage remains canonical",
  );
  await writeFile(path.join(legacyRoot, "data/temp/part.tmp"), "temp");
  await writeFile(path.join(legacyRoot, "logs/server.log"), "fixture log");
  await writeFile(path.join(legacyRoot, ".git/config"), "fixture git");
  const envPath = path.join(legacyRoot, ".env");
  await writeFile(
    envPath,
    [
      "NODE_ENV=test",
      "FILESTATION_DB_PATH=./data/filestation.db",
      "FILESTATION_STORAGE_PATH=./data/storage",
      "FILESTATION_TEMP_PATH=./data/temp",
      "JWT_SECRET=fixture-only-secret",
      "",
    ].join("\n"),
  );
  const nginxPath = path.join(root, "nginx.conf");
  await writeFile(nginxPath, "server { listen 8443; }\n");
  return { root, legacyRoot, installRoot, envPath, nginxPath };
}

function stoppedProcess(): ProcessIdentityProvider {
  return {
    current: async () => ({ provider: "linux-proc", value: "linux:11111111-2222-3333-4444-555555555555" }),
    processCreatedAt: jest.fn(),
    isProcessAlive: async () => false,
    listeningPid: async () => undefined,
  };
}

function commonOptions(
  fixture: SourceFixture,
): BootstrapManagedInstallOptions {
  return {
    legacyRoot: fixture.legacyRoot,
    installRoot: fixture.installRoot,
    environment: {
      FILESTATION_DB_PATH: "./data/filestation.db",
      FILESTATION_STORAGE_PATH: "./data/storage",
      FILESTATION_TEMP_PATH: "./data/temp",
    },
    relativePathPolicy: "preserve" as const,
    oldPid: 4242,
    oldBootIdentity: "linux:11111111-2222-3333-4444-555555555555",
    oldProcessCreatedAt: "linux-starttime:123",
    identityProvider: stoppedProcess(),
    snapshotDatabase: async ({
      database,
      output,
    }: {
      database: string;
      output: string;
    }) => {
      const bytes = await readFile(database);
      await writeFile(output, bytes);
      return {
        sourceIntegrity: "ok" as const,
        sourceForeignKeys: 0,
        snapshotIntegrity: "ok" as const,
        snapshotForeignKeys: 0,
      };
    },
    verifySpace: async () => ({
      sufficient: true,
      plans: [
        {
          volumeId: "fixture-volume",
          availableBytes: 10_000_000,
          requiredBytes: 1_000_000,
          safetyMarginBytes: 100_000,
          sufficient: true,
          components: [],
        },
      ],
    }),
    now: () => new Date("2026-10-28T01:02:03.004Z"),
    id: () => "fixture-bootstrap-id",
  };
}

describe("managed bootstrap", () => {
  let fixture: SourceFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      const current = path.join(fixture.installRoot, "current");
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          await unlink(current);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rm(fixture.root, { recursive: true, force: true });
    }
    fixture = undefined;
  });

  it("builds a recoverable source and env backup without copying runtime storage", async () => {
    fixture = await sourceFixture();
    const nginxBefore = await readFile(fixture.nginxPath);

    const result = await bootstrapManagedInstall(commonOptions(fixture));

    expect(result.state).toBe("bootstrapped");
    const backupRoot = path.join(
      result.installRoot,
      "backups",
      result.backupId,
    );
    await expect(
      readFile(path.join(backupRoot, "legacy-source/src.txt"), "utf8"),
    ).resolves.toBe("fixture source\n");
    await expect(
      readFile(
        path.join(backupRoot, "legacy-source/node_modules/fixture-package/index.js"),
        "utf8",
      ),
    ).resolves.toBe("fixture dependency\n");
    await expect(
      lstat(path.join(backupRoot, "legacy-source/.env")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      lstat(path.join(backupRoot, "legacy-source/.git")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      lstat(path.join(backupRoot, "legacy-source/logs")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      lstat(path.join(backupRoot, "legacy-source/data/storage/keep.bin")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const manifest = JSON.parse(
      await readFile(path.join(backupRoot, "MANIFEST.json"), "utf8"),
    );
    expect(manifest.env).toEqual(
      expect.objectContaining({
        sha256: createHash("sha256")
          .update(await readFile(fixture.envPath))
          .digest("hex"),
      }),
    );
    await expect(
      readFile(path.join(backupRoot, "env/legacy.env"), "utf8"),
    ).resolves.toContain("fixture-only-secret");
    expect(manifest.exclusions).toEqual(
      expect.arrayContaining([".git", "logs", "data/storage", "data/temp"]),
    );
    expect(manifest.legacyRestartInstructions.join("\n")).toMatch(
      /original legacy root/i,
    );
    expect(result.manualInstructions.join("\n")).toMatch(/nginx -t/);
    expect(result.manualInstructions.join("\n")).toMatch(/not modified|no nginx/i);
    await expect(readFile(fixture.nginxPath)).resolves.toEqual(nginxBefore);
  });

  it("keeps the default database, storage and temp through canonical source paths", async () => {
    fixture = await sourceFixture();
    const result = await bootstrapManagedInstall(commonOptions(fixture));

    expect(result.paths.database).toBe(
      path.join(fixture.legacyRoot, "data/filestation.db"),
    );
    expect(result.paths.storage).toBe(
      path.join(fixture.legacyRoot, "data/storage"),
    );
    expect(result.paths.temp).toBe(
      path.join(fixture.legacyRoot, "data/temp"),
    );
    await expect(
      readFile(path.join(fixture.legacyRoot, "data/storage/keep.bin"), "utf8"),
    ).resolves.toBe("storage remains canonical");
    await expect(
      lstat(path.join(result.releaseRealpath, "data/storage/keep.bin")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const managedEnv = await readFile(
      path.join(result.installRoot, ".env"),
      "utf8",
    );
    expect(parseDotenv(managedEnv).FILESTATION_DB_PATH).toBe(
      path.join(fixture.legacyRoot, "data/filestation.db"),
    );
    expect(managedEnv).toContain("JWT_SECRET=fixture-only-secret");
  });

  it("records reviewed absolute custom paths without copying storage", async () => {
    fixture = await sourceFixture();
    const custom = path.join(fixture.root, "custom");
    await mkdir(custom, { recursive: true });
    const database = path.join(custom, "database.sqlite");
    const storage = path.join(custom, "storage");
    const temp = path.join(custom, "temp");
    await writeFile(database, "custom database");

    const result = await bootstrapManagedInstall({
      ...commonOptions(fixture),
      overrides: { database, storage, temp },
      acceptPathChange: true,
    });

    expect(result.paths).toEqual({ database, storage, temp });
    const metadata = JSON.parse(
      await readFile(
        path.join(result.installRoot, "managed-install.json"),
        "utf8",
      ),
    );
    expect(metadata.paths).toEqual({ database, storage, temp });
    await expect(lstat(storage)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(temp)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is idempotent and does not create another backup", async () => {
    fixture = await sourceFixture();
    const first = await bootstrapManagedInstall(commonOptions(fixture));
    const firstManifest = await readFile(
      path.join(first.installRoot, "backups", first.backupId, "MANIFEST.json"),
      "utf8",
    );

    const second = await bootstrapManagedInstall(commonOptions(fixture));

    expect(second.state).toBe("already-bootstrapped");
    expect(second.backupId).toBe(first.backupId);
    await expect(
      readFile(
        path.join(second.installRoot, "backups", second.backupId, "MANIFEST.json"),
        "utf8",
      ),
    ).resolves.toBe(firstManifest);
  });

  it("rejects an old process that is still alive before creating the install root", async () => {
    fixture = await sourceFixture();
    const alive = stoppedProcess();
    alive.isProcessAlive = async () => true;

    await expect(
      bootstrapManagedInstall({
        ...commonOptions(fixture),
        identityProvider: alive,
      }),
    ).rejects.toThrow(/old process.*alive/i);
    await expect(lstat(fixture.installRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a racing bootstrap that appears after lock preflight", async () => {
    fixture = await sourceFixture();
    const racingFs = new (class extends NodeDurableFileSystem {
      override async protect(): Promise<void> {}
      override async createExclusive(
        filename: string,
        bytes: Buffer,
        options?: { mode?: number },
      ): Promise<void> {
        await super.createExclusive(filename, bytes, options);
        if (filename.endsWith(".bootstrap.lock")) {
          await mkdir(fixture!.installRoot, { recursive: true });
          await writeFile(path.join(fixture!.installRoot, "racer-owned"), "keep");
        }
      }
    })();

    await expect(
      bootstrapManagedInstall({
        ...commonOptions(fixture),
        fs: racingFs,
      }),
    ).rejects.toThrow(/appeared after preflight/i);
    await expect(
      readFile(path.join(fixture.installRoot, "racer-owned"), "utf8"),
    ).resolves.toBe("keep");
  });

  it("rolls back staging when current-link creation fails", async () => {
    fixture = await sourceFixture();
    const failingLinkFs = new (class extends NodeDurableFileSystem {
      override async protect(): Promise<void> {}
      override async symlink(): Promise<void> {
        throw new Error("fixture current-link failure");
      }
      override async createJunction(): Promise<void> {
        throw new Error("fixture current-link failure");
      }
    })();

    await expect(
      bootstrapManagedInstall({
        ...commonOptions(fixture),
        fs: failingLinkFs,
      }),
    ).rejects.toThrow(/current-link failure/);
    await expect(lstat(fixture.installRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(path.join(fixture.legacyRoot, "src.txt"), "utf8"),
    ).resolves.toBe("fixture source\n");
    const siblings = await readdir(path.dirname(fixture.installRoot));
    expect(
      siblings.filter((entry) => entry.includes(".bootstrap-")),
    ).toEqual([]);
  });

  it("fails before writes when the volume preflight is insufficient", async () => {
    fixture = await sourceFixture();

    await expect(
      bootstrapManagedInstall({
        ...commonOptions(fixture),
        verifySpace: async () => ({
          sufficient: false,
          plans: [
            {
              volumeId: "fixture-volume",
              availableBytes: 1,
              requiredBytes: 2,
              safetyMarginBytes: 1,
              sufficient: false,
              components: [],
            },
          ],
        }),
      }),
    ).rejects.toThrow(/insufficient.*space/i);
    await expect(lstat(fixture.installRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("places the built updater and launcher inputs in the managed release", async () => {
    fixture = await sourceFixture();
    const result = await bootstrapManagedInstall(commonOptions(fixture));

    await expect(
      readFile(
        path.join(result.installRoot, "updater/dist/cli.js"),
        "utf8",
      ),
    ).resolves.toBe("fixture updater\n");
    expect(
      await realpath(
        path.join(result.installRoot, "node_modules/fixture-workspace"),
      ),
    ).toBe(
      path.join(result.releaseRealpath, "packages/fixture-workspace"),
    );
    await expect(
      readFile(
        path.join(result.releaseRealpath, "apps/updater/dist/cli.js"),
        "utf8",
      ),
    ).resolves.toBe("fixture updater\n");
    const currentTarget = await readlink(
      path.join(result.installRoot, "current"),
    );
    expect(await realpath(currentTarget)).toBe(result.releaseRealpath);
  });

  it("reports update state from the journal and fails closed before Task 9 recovery", async () => {
    fixture = await sourceFixture();
    const result = await bootstrapManagedInstall(commonOptions(fixture));

    await expect(inspectManagedUpdate(result.installRoot)).resolves.toEqual(
      expect.objectContaining({
        state: "no-active-update",
        installId: "fixture-bootstrap-id",
      }),
    );
    await expect(recoverManagedUpdate(result.installRoot)).resolves.toEqual(
      expect.objectContaining({
        state: "no-active-recovery",
      }),
    );

    const journal = await AttemptJournal.open(result.installRoot);
    await journal.beginAttempt(context());
    await expect(inspectManagedUpdate(result.installRoot)).resolves.toEqual(
      expect.objectContaining({
        state: "active",
        attemptId: "attempt-01",
        phase: "PREPARED",
      }),
    );
    await expect(recoverManagedUpdate(result.installRoot)).rejects.toThrow(
      /authenticated Task 9 recovery orchestrator/,
    );
  });
  it("honors configured paths supplied by CLI dotenv merging", async () => {
    fixture = await sourceFixture();
    await writeFile(path.join(fixture.legacyRoot, "custom.db"), "custom database");
    const result = await bootstrapManagedInstall({ ...commonOptions(fixture),
      configuredPaths: { database: "./custom.db", storage: "./custom-storage", temp: "./custom-temp" } });
    expect(result.paths.database).toBe(path.join(fixture.legacyRoot, "custom.db"));
    expect(result.paths.storage).toBe(path.join(fixture.legacyRoot, "custom-storage"));
    expect(result.paths.temp).toBe(path.join(fixture.legacyRoot, "custom-temp"));
  });

  it.each(["typo", "win32:2026-01-01T00:00:00.000Z", "linux:bad", "linux:00000000-0000-0000-0000-000000000000"])("fails closed on unrecognized or incomparable old boot %s", async (oldBootIdentity) => {
    fixture = await sourceFixture();
    await expect(bootstrapManagedInstall({ ...commonOptions(fixture), oldBootIdentity })).rejects.toThrow(/boot.*identity|identity.*boot/i);
    await expect(lstat(fixture.installRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps backup, release and standalone dependency resolution after old source moves", async () => {
    fixture = await sourceFixture();
    await writeFile(path.join(fixture.legacyRoot, "packages/fixture-workspace/package.json"), JSON.stringify({ name: "fixture-workspace", main: "index.js" }));
    await writeFile(path.join(fixture.legacyRoot, "packages/fixture-workspace/index.js"), "module.exports = 'fixture workspace';\n");
    const result = await bootstrapManagedInstall(commonOptions(fixture));
    const moved = path.join(fixture.root, "moved-source");
    await rename(fixture.legacyRoot, moved);
    for (const tree of [result.releaseRealpath, path.join(result.installRoot, "backups", result.backupId, "legacy-source"), result.installRoot]) {
      await expect(readFile(path.join(tree, "node_modules/fixture-workspace/index.js"), "utf8")).resolves.toBe("module.exports = 'fixture workspace';\n");
      expect(await realpath(path.join(tree, "node_modules/fixture-workspace"))).not.toContain(moved);
      const run = spawnSync(process.execPath, ["-e", "require('node:assert/strict').equal(require('fixture-workspace'), 'fixture workspace')"], { cwd: tree, encoding: "utf8", windowsHide: true });
      expect(run.stderr).toBe(""); expect(run.status).toBe(0);
    }
    const restored = path.join(fixture.root, "restored-source");
    const backup = path.join(result.installRoot, "backups", result.backupId);
    await cp(path.join(backup, "legacy-source"), restored, { recursive: true, dereference: true });
    await cp(path.join(backup, "env/legacy.env"), path.join(restored, ".env"));
    await mkdir(path.join(restored, "data"), { recursive: true });
    await cp(path.join(backup, "database.sqlite"), path.join(restored, "data/filestation.db"));
    const restart = spawnSync(process.execPath, ["-e", "require('node:assert/strict').equal(require('fixture-workspace'), 'fixture workspace')"], { cwd: restored, encoding: "utf8", windowsHide: true });
    expect(restart.stderr).toBe(""); expect(restart.status).toBe(0);
    await expect(readFile(path.join(restored, "src.txt"), "utf8")).resolves.toBe("fixture source\n");
  });

  it.each(["paths", "current", "manifest", "snapshot", "source", "env"])("rejects damaged idempotent installation: %s", async (damage) => {
    fixture = await sourceFixture();
    const result = await bootstrapManagedInstall(commonOptions(fixture));
    const backup = path.join(result.installRoot, "backups", result.backupId);
    if (damage === "paths") {
      const filename = path.join(result.installRoot, "managed-install.json");
      const metadata = JSON.parse(await readFile(filename, "utf8"));
      metadata.paths.temp = path.join(fixture.root, "wrong-temp");
      await writeFile(filename, JSON.stringify(metadata));
    } else if (damage === "current") {
      await unlink(path.join(result.installRoot, "current"));
      await symlink(fixture.legacyRoot, path.join(result.installRoot, "current"), process.platform === "win32" ? "junction" : "dir");
    } else {
      const filename = { manifest: "MANIFEST.json", snapshot: "database.sqlite", source: "legacy-source/src.txt", env: "env/legacy.env" }[damage as "manifest" | "snapshot" | "source" | "env"];
      await writeFile(path.join(backup, filename), "corruption");
    }
    await expect(bootstrapManagedInstall(commonOptions(fixture))).rejects.toThrow();
  });

  it("status and recover reject torn tails with zero mutating adapter calls", async () => {
    fixture = await sourceFixture();
    await bootstrapManagedInstall(commonOptions(fixture));
    await writeFile(path.join(fixture.installRoot, "update-attempt.journal"), '{"torn":');
    const fs = new NodeDurableFileSystem();
    const ensure = jest.spyOn(fs, "ensurePrivateDirectory");
    const protect = jest.spyOn(fs, "protect");
    await expect(inspectManagedUpdate(fixture.installRoot, { fs })).resolves.toMatchObject({ state: "active" });
    await expect(recoverManagedUpdate(fixture.installRoot, { fs })).rejects.toThrow(/Task 9|recovery/i);
    expect(ensure).not.toHaveBeenCalled();
    expect(protect).not.toHaveBeenCalled();
  });

  it.each(["src.txt", "database.sqlite"])("never publishes success after asset flush failure: %s", async (basename) => {
    fixture = await sourceFixture();
    const fs = new (class extends NodeDurableFileSystem {
      override async protect(): Promise<void> {}
      protected override async flushFile(filename: string, flush: () => Promise<void>): Promise<void> {
        if (path.basename(filename) === basename) throw new Error("fixture asset flush failure");
        await super.flushFile(filename, flush);
      }
    })();
    await expect(bootstrapManagedInstall({ ...commonOptions(fixture), fs })).rejects.toThrow(/asset flush failure/);
    await expect(lstat(fixture.installRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(fixture.legacyRoot, "src.txt"), "utf8")).resolves.toBe("fixture source\n");
  });

  it("accepts only a valid different boot as proof of the old process absence", async () => {
    fixture = await sourceFixture();
    const provider = stoppedProcess(); const probe = jest.fn(async () => true); provider.isProcessAlive = probe;
    const result = await bootstrapManagedInstall({ ...commonOptions(fixture), identityProvider: provider, oldBootIdentity: "linux:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", dryRun: true });
    expect(result.state).toBe("dry-run"); expect(probe).not.toHaveBeenCalled();
    await expect(lstat(fixture.installRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not treat equivalent Windows timestamp precision as a different boot", async () => {
    fixture = await sourceFixture();
    const provider: ProcessIdentityProvider = {
      current: async () => ({ provider: "windows-cim", value: "win32:2026-10-28T00:00:00.0000000Z" }),
      processCreatedAt: async () => "win32:2026-10-28T00:01:00.0000000Z",
      isProcessAlive: async () => true,
    };
    await expect(bootstrapManagedInstall({ ...commonOptions(fixture), identityProvider: provider,
      oldBootIdentity: "win32:2026-10-28T00:00:00.000Z", oldProcessCreatedAt: "win32:2026-10-28T00:01:00.0000000Z" })).rejects.toThrow(/alive|identity/i);
    await expect(lstat(fixture.installRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("C46-1 excludes both runtime generations and snapshots the original DB separately", async () => {
    fixture = await sourceFixture();
    const old = path.join(fixture.legacyRoot, "custom-runtime"); const relocated = path.join(fixture.root, "relocated");
    for (const base of [old, relocated]) {
      await mkdir(path.join(base, "storage"), { recursive: true }); await mkdir(path.join(base, "temp"));
      await writeFile(path.join(base, "db.sqlite"), base === old ? "original verified database" : "migrated target database");
      await writeFile(path.join(base, "db.sqlite-wal"), "private wal"); await writeFile(path.join(base, "db.sqlite-shm"), "private shm");
      await writeFile(path.join(base, "storage/private.bin"), "never copy storage"); await writeFile(path.join(base, "temp/upload.part"), "never copy temp");
    }
    await symlink(path.join(old,"storage"),path.join(fixture.legacyRoot,"storage-alias"),process.platform === "win32" ? "junction" : "dir");
    const previous = { database:path.join(old,"db.sqlite"),storage:path.join(old,"storage"),temp:path.join(old,"temp") };
    const proposed = { database:path.join(relocated,"db.sqlite"),storage:path.join(relocated,"storage"),temp:path.join(relocated,"temp") };
    const result = await bootstrapManagedInstall({ ...commonOptions(fixture), configuredPaths:previous, overrides:proposed, acceptPathChange:true });
    const backup = path.join(result.installRoot,"backups",result.backupId);
    for(const tree of [result.releaseRealpath,path.join(backup,"legacy-source")]) {
      for(const relative of ["custom-runtime/db.sqlite","custom-runtime/db.sqlite-wal","custom-runtime/db.sqlite-shm","custom-runtime/storage/private.bin","custom-runtime/temp/upload.part","storage-alias"]) {
        await expect(lstat(path.join(tree,relative))).rejects.toMatchObject({code:"ENOENT"});
      }
    }
    await expect(readFile(path.join(backup,"database.sqlite"),"utf8")).resolves.toBe("original verified database");
    await expect(readFile(path.join(backup,"target-database.sqlite"),"utf8")).resolves.toBe("migrated target database");
    const manifest=JSON.parse(await readFile(path.join(backup,"MANIFEST.json"),"utf8"));
    expect(manifest.originalCanonicalPaths).toEqual(previous); expect(manifest.canonicalPaths).toEqual(proposed);
    expect(manifest.snapshot.database).toBe(previous.database); expect(manifest.targetSnapshot.database).toBe(proposed.database);
  });

  it("C46-2 rejects missing required production variables before lock or directory creation", async () => {
    fixture=await sourceFixture(); await writeFile(fixture.envPath,"NODE_ENV=production\n");
    const fs=new NodeDurableFileSystem(); const create=jest.spyOn(fs,"createExclusive");
    await expect(bootstrapManagedInstall({...commonOptions(fixture), fs})).rejects.toThrow(/JWT_SECRET.*required/i);
    expect(create).not.toHaveBeenCalled(); await expect(lstat(fixture.installRoot)).rejects.toMatchObject({code:"ENOENT"});
  });

  it("C46-2 requires secure resolution of process-only vars without persisting or printing values", async () => {
    fixture=await sourceFixture(); await writeFile(fixture.envPath,"");
    const options={...commonOptions(fixture),environment:{NODE_ENV:"production",JWT_SECRET:"fixture-process-only-secret"}};
    await expect(bootstrapManagedInstall(options)).rejects.toThrow(/NODE_ENV.*JWT_SECRET.*secure|secure.*NODE_ENV.*JWT_SECRET/i);
    await expect(lstat(fixture.installRoot)).rejects.toMatchObject({code:"ENOENT"});
    const result=await bootstrapManagedInstall({...options,productionEnvironmentResolution:"service"} as BootstrapManagedInstallOptions);
    const env=await readFile(path.join(result.installRoot,".env"),"utf8");
    expect(env).not.toContain("fixture-process-only-secret"); expect(env).not.toContain("NODE_ENV=production");
    expect(JSON.stringify(result)).not.toContain("fixture-process-only-secret");
    const metadata=JSON.parse(await readFile(path.join(result.installRoot,"managed-install.json"),"utf8"));
    expect(metadata.productionEnvironment).toEqual({nodeEnv:"production",required:["NODE_ENV","JWT_SECRET"],source:"service"});
  });

  it("C46-3 publishes hash/whitespace paths that exactly round-trip through dotenv", async () => {
    fixture=await sourceFixture(); const custom=path.join(fixture.root,"archive # fixture ' quoted"); await mkdir(custom);
    const paths={database:path.join(custom,"db.sqlite"),storage:path.join(custom,"storage # kept"),temp:path.join(custom,"temp ' kept")};
    await writeFile(paths.database,"target db");
    const result=await bootstrapManagedInstall({...commonOptions(fixture),overrides:paths,acceptPathChange:true});
    const parsed=parseDotenv(await readFile(path.join(result.installRoot,".env")));
    expect(parsed.FILESTATION_DB_PATH).toBe(paths.database); expect(parsed.FILESTATION_STORAGE_PATH).toBe(paths.storage); expect(parsed.FILESTATION_TEMP_PATH).toBe(paths.temp);
  });

  it.each(["metadata-only","metadata-current-marker-lock","marker-only","lock-only"])("C46-4 rejects interrupted publication without removing owner markers: %s", async (stage) => {
    fixture=await sourceFixture(); const options=commonOptions(fixture); const result=await bootstrapManagedInstall(options);
    const marker=path.join(result.installRoot,".bootstrap-in-progress.json"); const lock=path.join(fixture.root,".managed.bootstrap.lock");
    if(stage!=="lock-only") await writeFile(marker,"fixture owner marker");
    if(stage!=="marker-only") await writeFile(lock,"fixture owner lock");
    if(stage==="metadata-only") await unlink(path.join(result.installRoot,"current"));
    await expect(bootstrapManagedInstall(options)).rejects.toThrow(/bootstrap.*recovery.*required/i);
    if(stage!=="lock-only") await expect(readFile(marker,"utf8")).resolves.toBe("fixture owner marker");
    if(stage!=="marker-only") await expect(readFile(lock,"utf8")).resolves.toBe("fixture owner lock");
  });

  it("C46-2 refuses to infer development when the old launch mode is unavailable",async()=>{
    fixture=await sourceFixture();await writeFile(fixture.envPath,"");
    await expect(bootstrapManagedInstall({...commonOptions(fixture),environment:{}})).rejects.toThrow(/NODE_ENV.*required|original.*mode/i);
    await expect(lstat(fixture.installRoot)).rejects.toMatchObject({code:"ENOENT"});
  });

});
