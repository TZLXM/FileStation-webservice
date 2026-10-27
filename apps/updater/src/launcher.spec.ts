import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  launchManagedInstall,
  loadInstallEnvironment,
  ManagedInstallMetadata,
  validateManagedLaunch,
} from "./launcher";
import { NodeDurableFileSystem } from "./platform/durable-fs";

class CountingReadOnlyFs extends NodeDurableFileSystem {
  writeCount = 0;

  private blocked(): never {
    this.writeCount++;
    throw new Error("unexpected filesystem write");
  }

  override async ensurePrivateDirectory(): Promise<void> {
    this.blocked();
  }
  override async ensurePrivateFile(): Promise<void> {
    this.blocked();
  }
  override async writeAtomic(): Promise<void> {
    this.blocked();
  }
  override async append(): Promise<void> {
    this.blocked();
  }
  override async createExclusive(): Promise<void> {
    this.blocked();
  }
  override async truncate(): Promise<void> {
    this.blocked();
  }
  override async rename(): Promise<void> {
    this.blocked();
  }
  override async unlink(): Promise<void> {
    this.blocked();
  }
  override async symlink(): Promise<void> {
    this.blocked();
  }
  override async createJunction(): Promise<void> {
    this.blocked();
  }
  override async protect(): Promise<void> {
    this.blocked();
  }
}

interface Fixture {
  root: string;
  installRoot: string;
  release: string;
  oldRelease: string;
  current: string;
  executable: string;
  metadata: ManagedInstallMetadata;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "filestation-task6-launch-"));
  const installRoot = path.join(root, "install");
  const releases = path.join(installRoot, "releases");
  const release = path.join(releases, "v0.2.0-current");
  const oldRelease = path.join(releases, "v0.1.9-old");
  const current = path.join(installRoot, "current");
  const executable = path.join(release, "apps/server/dist/main.js");
  const oldExecutable = path.join(oldRelease, "apps/server/dist/main.js");
  const data = path.join(installRoot, "data");

  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(path.dirname(oldExecutable), { recursive: true });
  await mkdir(data, { recursive: true });
  await writeFile(executable, "fixture current entrypoint");
  await writeFile(oldExecutable, "fixture old entrypoint");
  await symlink(
    release,
    current,
    process.platform === "win32" ? "junction" : "dir",
  );

  const metadata: ManagedInstallMetadata = {
    schemaVersion: 1,
    installId: "fixture-install-id",
    installRoot,
    currentPath: current,
    environmentPath: path.join(installRoot, ".env"),
    paths: {
      database: path.join(data, "filestation.db"),
      storage: path.join(data, "storage"),
      temp: path.join(data, "temp"),
    },
    bootstrapBackupId: "fixture-backup-id",
    bootstrapFingerprint: "a".repeat(64),
    createdAt: "2026-10-28T00:00:00.000Z",
  };
  await writeFile(
    path.join(installRoot, "managed-install.json"),
    `${JSON.stringify(metadata)}\n`,
  );
  return {
    root,
    installRoot,
    release,
    oldRelease,
    current,
    executable,
    metadata,
  };
}

describe("managed launcher", () => {
  let root: string;

  afterEach(async () => {
    if (root) {
      try {
        await unlink(path.join(root, "install", "current"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads root dotenv values before import while process environment wins", async () => {
    const value = await fixture();
    root = value.root;
    await writeFile(
      path.join(value.installRoot, ".env"),
      [
        "FILESTATION_SERVE_STATIC=fixture-static-from-dotenv",
        "FIXTURE_PRECEDENCE=dotenv-value",
        "",
      ].join("\n"),
    );
    const targetEnvironment: NodeJS.ProcessEnv = {};
    let imported = false;

    const environment = await loadInstallEnvironment(value.installRoot, {
      processEnvironment: {
        FIXTURE_PRECEDENCE: "process-value",
      },
      readFile: (filename) => readFile(filename, "utf8"),
    });
    expect(environment.values.FILESTATION_SERVE_STATIC).toBe(
      "fixture-static-from-dotenv",
    );
    expect(environment.values.FIXTURE_PRECEDENCE).toBe("process-value");

    await launchManagedInstall({
      root: value.installRoot,
      cwd: value.installRoot,
      executableRealpath: await realpath(value.executable),
      currentRealpath: await realpath(value.current),
      metadata: value.metadata,
      processEnvironment: {
        FIXTURE_PRECEDENCE: "process-value",
      },
      targetEnvironment,
      importer: async () => {
        imported = true;
        expect(targetEnvironment.FILESTATION_SERVE_STATIC).toBe(
          "fixture-static-from-dotenv",
        );
        expect(targetEnvironment.FIXTURE_PRECEDENCE).toBe("process-value");
        expect(targetEnvironment.FILESTATION_INSTALL_ROOT).toBe(
          value.installRoot,
        );
        expect(targetEnvironment.FILESTATION_RELEASE_ROOT).toBe(
          await realpath(value.release),
        );
      },
    });

    expect(imported).toBe(true);
  });

  it("rejects a launch from the wrong installation cwd before importing", async () => {
    const value = await fixture();
    root = value.root;
    const importer = jest.fn();

    await expect(
      launchManagedInstall({
        root: value.installRoot,
        cwd: value.current,
        executableRealpath: await realpath(value.executable),
        currentRealpath: await realpath(value.current),
        metadata: value.metadata,
        importer,
      }),
    ).rejects.toThrow(/installation root.*cwd/i);
    expect(importer).not.toHaveBeenCalled();
  });

  it("performs zero filesystem writes and no module import on preflight failure", async () => {
    const value = await fixture();
    root = value.root;
    const fs = new CountingReadOnlyFs();
    const importer = jest.fn();

    await expect(
      launchManagedInstall({
        root: value.installRoot,
        cwd: value.current,
        executableRealpath: await realpath(value.executable),
        currentRealpath: await realpath(value.current),
        metadata: value.metadata,
        fs,
        importer,
      }),
    ).rejects.toThrow(/installation root.*cwd/i);
    expect(fs.writeCount).toBe(0);
    expect(importer).not.toHaveBeenCalled();
  });

  it("rejects a direct launch from a stale release before importing", async () => {
    const value = await fixture();
    root = value.root;
    const importer = jest.fn();

    await expect(
      launchManagedInstall({
        root: value.installRoot,
        cwd: value.installRoot,
        executableRealpath: await realpath(
          path.join(value.oldRelease, "apps/server/dist/main.js"),
        ),
        currentRealpath: await realpath(value.current),
        metadata: value.metadata,
        importer,
      }),
    ).rejects.toThrow(/not.*current release/i);
    expect(importer).not.toHaveBeenCalled();
  });

  it("rejects relative configured paths rather than resolving them from a changed cwd", () => {
    const metadata: ManagedInstallMetadata = {
      schemaVersion: 1,
      installId: "fixture-install-id",
      installRoot: path.resolve("/fixture/install"),
      currentPath: path.resolve("/fixture/install/current"),
      environmentPath: path.resolve("/fixture/install/.env"),
      paths: {
        database: path.resolve("/fixture/data/files.db"),
        storage: path.resolve("/fixture/data/storage"),
        temp: path.resolve("/fixture/data/temp"),
      },
      bootstrapBackupId: "fixture-backup-id",
      bootstrapFingerprint: "a".repeat(64),
      createdAt: "2026-10-28T00:00:00.000Z",
    };

    expect(() =>
      validateManagedLaunch({
        cwd: metadata.installRoot,
        executableRealpath: path.resolve(
          "/fixture/install/releases/v0.2.0/apps/server/dist/main.js",
        ),
        currentRealpath: path.resolve("/fixture/install/releases/v0.2.0"),
        installMetadata: metadata,
        configuredPaths: {
          database: "./data/files.db",
        },
      }),
    ).toThrow(/absolute canonical path/i);
  });

  it("rejects missing metadata at the managed root without importing", async () => {
    root = await mkdtemp(path.join(tmpdir(), "filestation-task6-missing-"));
    const importer = jest.fn();

    await expect(
      launchManagedInstall({
        root,
        cwd: root,
        executableRealpath: path.join(root, "missing.js"),
        importer,
      }),
    ).rejects.toThrow(/managed-install\.json.*missing|metadata.*missing/i);
    expect(importer).not.toHaveBeenCalled();
  });
});
