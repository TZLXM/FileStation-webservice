import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
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
  await mkdir(path.join(legacyRoot, "apps/web/dist"), { recursive: true });
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
    path.join(legacyRoot, "apps/web/dist/index.html"),
    "<html>fixture</html>\n",
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
    current: async () => ({ provider: "linux-proc", value: "fixture-boot" }),
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
    oldBootIdentity: "fixture-boot",
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
    expect(managedEnv).toContain(
      `FILESTATION_DB_PATH=${path.join(fixture.legacyRoot, "data/filestation.db")}`,
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
      path.join(fixture.legacyRoot, "packages/fixture-workspace"),
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
});
