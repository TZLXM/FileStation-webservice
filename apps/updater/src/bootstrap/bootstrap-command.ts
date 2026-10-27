import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import {
  DurableFileSystem,
  NodeDurableFileSystem,
} from "../platform/durable-fs";
import {
  VolumePlan,
  planRequiredSpace,
} from "../platform/volume-space";
import {
  ProcessIdentityProvider,
} from "../state/boot-identity";
import { AttemptJournal } from "../state/attempt-journal";
import {
  ManagedInstallMetadata,
  loadManagedInstallMetadata,
} from "../launcher";
import {
  BootstrapPathPlan,
  ManagedInstallPaths,
  RelativePathPolicy,
  pathWithin,
  planBootstrapPaths,
  sameCanonicalPath,
} from "./path-plan";

export interface DatabaseSnapshotReceipt {
  sourceIntegrity: "ok";
  sourceForeignKeys: 0;
  snapshotIntegrity: "ok";
  snapshotForeignKeys: 0;
}

export interface SpaceVerification {
  sufficient: boolean;
  plans: VolumePlan[];
}

export interface BootstrapManagedInstallOptions {
  legacyRoot: string;
  installRoot: string;
  configuredPaths?: Partial<ManagedInstallPaths>;
  overrides?: Partial<ManagedInstallPaths>;
  relativePathPolicy?: RelativePathPolicy;
  acceptPathChange?: boolean;
  environment?: NodeJS.ProcessEnv;
  releaseVersion?: string;
  oldPid: number;
  oldBootIdentity: string;
  oldProcessCreatedAt: string;
  servicePort?: number;
  identityProvider: ProcessIdentityProvider;
  fs?: DurableFileSystem;
  snapshotDatabase: (input: {
    database: string;
    output: string;
  }) => Promise<DatabaseSnapshotReceipt>;
  verifySpace?: (input: {
    paths: BootstrapPathPlan;
    sourceBytes: number;
    databaseBytes: number;
    backupId: string;
  }) => Promise<SpaceVerification>;
  dryRun?: boolean;
  now?: () => Date;
  id?: () => string;
}

export interface BootstrapManagedInstallResult {
  state: "bootstrapped" | "already-bootstrapped" | "dry-run";
  installId: string;
  installRoot: string;
  backupId: string;
  releaseVersion: string;
  releaseRealpath: string;
  paths: ManagedInstallPaths;
  changes: BootstrapPathPlan["changes"];
  permissionPlan: {
    posix: { directories: "0700"; files: "0600" };
    windows: string;
  };
  manualInstructions: string[];
}

export interface ManagedUpdateInspection {
  state: "no-active-update" | "active" | "terminal";
  installId: string;
  attemptId?: string;
  fence?: number;
  phase?: string;
  pendingAction?: string;
}

export interface ManagedRecoveryResult {
  state: "no-active-recovery" | "recovery-required";
  installId: string;
  guidance: string;
}

interface CopyEntry {
  path: string;
  type: "file" | "symlink";
  size: number;
  sha256?: string;
  target?: string;
}

interface CopyOptions {
  sourceRoot: string;
  destinationRoot: string;
  fs: DurableFileSystem;
  excludedPaths: string[];
  releaseOnly?: boolean;
  symlinkBoundary?: string;
  absoluteInternalSymlinkTarget?: boolean;
}

class BootstrapDurableFileSystem extends NodeDurableFileSystem {
  private readonly ensuredDirectories = new Set<string>();

  override async ensurePrivateDirectory(
    directory: string,
    mode?: number,
  ): Promise<void> {
    const key = path.resolve(directory);
    if (this.ensuredDirectories.has(key)) return;
    await super.ensurePrivateDirectory(directory, mode);
    this.ensuredDirectories.add(key);
  }

  override async protect(
    filename: string,
    directory: boolean,
  ): Promise<void> {
    // Descendants inherit the protected DACL from their created directory.
    if (process.platform === "win32" && !directory) return;
    await super.protect(filename, directory);
  }
}

const PATH_KEYS = ["database", "storage", "temp"] as const;
const TERMINAL_PHASES = new Set([
  "COMMITTED",
  "ROLLED_BACK",
  "FAILED",
  "ABORTED",
]);
const MANUAL_INSTRUCTIONS = [
  "Nginx was not modified or reloaded. If a reverse proxy is used, review its proxy_pass and maintenance rules, then run nginx -t and reload it manually.",
  "Keep using the original legacy root and legacy .env until the managed launcher and database snapshot have been verified.",
  "Restore: stop the managed process, inspect backups/<id>/MANIFEST.json, restore legacy-source and env/legacy.env to a separate path, and start the old server with the original legacy command and root cwd.",
  "Recovery of an in-progress update remains fail closed until the authenticated Task 9 orchestrator is available. Do not edit or truncate update-attempt.journal.",
];

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeRelative(candidate: string): string {
  return candidate.split(path.sep).join("/");
}

function isExcludedRelative(relative: string): boolean {
  const normalized = normalizeRelative(relative);
  const segments = normalized.split("/").filter(Boolean);
  const basename = segments.at(-1)?.toLowerCase() ?? "";
  if (
    segments.some((segment) => {
      const value = segment.toLowerCase();
      return (
        value === ".git" ||
        value === "logs" ||
        value === "cache" ||
        value === ".cache" ||
        value === "coverage" ||
        value === "node_modules/.cache"
      );
    })
  ) {
    return true;
  }
  if (
    normalized === "data/storage" ||
    normalized.startsWith("data/storage/") ||
    normalized === "data/temp" ||
    normalized.startsWith("data/temp/")
  ) {
    return true;
  }
  return (
    basename === ".env" ||
    basename.startsWith(".env.") ||
    basename.endsWith(".log") ||
    basename === "managed-install.json" ||
    basename === ".bootstrap-in-progress.json"
  );
}

function isReleaseExcluded(relative: string): boolean {
  const normalized = normalizeRelative(relative);
  return (
    isExcludedRelative(relative) ||
    normalized === "data" ||
    normalized.startsWith("data/") ||
    normalized === "current" ||
    normalized === "backups" ||
    normalized.startsWith("backups/") ||
    normalized === "releases" ||
    normalized.startsWith("releases/")
  );
}

async function copySafeTree(options: CopyOptions): Promise<CopyEntry[]> {
  if (
    pathWithin(options.sourceRoot, options.destinationRoot) ||
    sameCanonicalPath(options.sourceRoot, options.destinationRoot)
  ) {
    throw new Error("backup destination must not be inside the legacy source tree");
  }
  const entries: CopyEntry[] = [];

  const walk = async (sourceDirectory: string): Promise<void> => {
    const names = await readdir(sourceDirectory);
    names.sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      const source = path.join(sourceDirectory, name);
      const relative = path.relative(options.sourceRoot, source);
      if (
        (options.releaseOnly
          ? isReleaseExcluded(relative)
          : isExcludedRelative(relative)) ||
        options.excludedPaths.some((candidate) =>
          sameCanonicalPath(candidate, source),
        )
      ) {
        continue;
      }
      const destination = path.join(options.destinationRoot, relative);
      const metadata = await lstat(source);
      if (metadata.isSymbolicLink()) {
        const target = await readlink(source);
        const targetAbsolute = path.isAbsolute(target)
          ? path.resolve(target)
          : path.resolve(path.dirname(source), target);
        const symlinkBoundary = options.symlinkBoundary ?? options.sourceRoot;
        if (!pathWithin(symlinkBoundary, targetAbsolute)) {
          throw new Error(`legacy source symlink escapes its root: ${relative}`);
        }
        const targetMetadata = await stat(targetAbsolute);
        await options.fs.ensurePrivateDirectory(path.dirname(destination));
        if (process.platform === "win32" && targetMetadata.isDirectory()) {
          await options.fs.createJunction(targetAbsolute, destination);
        } else {
          await options.fs.symlink(
            options.absoluteInternalSymlinkTarget ? targetAbsolute : target,
            destination,
          );
        }
        entries.push({
          path: normalizeRelative(relative),
          type: "symlink",
          size: 0,
          target: normalizeRelative(target),
        });
        continue;
      }
      if (metadata.isDirectory()) {
        await options.fs.ensurePrivateDirectory(destination);
        await walk(source);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`legacy source contains unsupported entry: ${relative}`);
      }
      await options.fs.ensurePrivateDirectory(path.dirname(destination));
      await copyFile(source, destination);
      await options.fs.protect(destination, false);
      entries.push({
        path: normalizeRelative(relative),
        type: "file",
        size: metadata.size,
        sha256: sha256(await readFile(destination)),
      });
    }
  };

  await options.fs.ensurePrivateDirectory(options.destinationRoot);
  await walk(options.sourceRoot);
  return entries;
}

async function measureTree(root: string): Promise<number> {
  let total = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const filename = path.join(directory, name);
      const metadata = await lstat(filename);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) await walk(filename);
      else if (metadata.isFile()) total += metadata.size;
    }
  };
  await walk(root);
  return total;
}

async function pathSize(filename: string): Promise<number> {
  try {
    return (await stat(filename)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function defaultVerifySpace(input: {
  paths: BootstrapPathPlan;
  sourceBytes: number;
  databaseBytes: number;
  backupId: string;
}): Promise<SpaceVerification> {
  const installRoot = input.paths.installRoot;
  const plans = await planRequiredSpace(
    {
      installRoot,
      artifactStaging: installRoot,
      releases: path.join(installRoot, "releases"),
      retainedRelease: path.join(
        installRoot,
        "releases",
        `.retained-${input.backupId}`,
      ),
      database: input.paths.proposed.database,
      wal: `${input.paths.proposed.database}-wal`,
      shm: `${input.paths.proposed.database}-shm`,
      temp: input.paths.proposed.temp,
      backups: path.join(installRoot, "backups"),
      snapshot: path.join(
        installRoot,
        "backups",
        input.backupId,
        "database.sqlite",
      ),
      restoreTemp: path.join(
        installRoot,
        "backups",
        input.backupId,
        "restore-temp",
      ),
    },
    {
      database_migration: false,
      migration_workspace_multiplier: 0,
      migration_workspace_min_bytes: 0,
      artifacts: [
        {
          archive_size: input.sourceBytes,
          unpacked_size: input.sourceBytes,
        },
      ],
    },
    {
      pageCount: Math.max(1, Math.ceil(input.databaseBytes / 4096)),
      pageSize: 4096,
      dbFileBytes: input.databaseBytes,
      walBytes: await pathSize(`${input.paths.proposed.database}-wal`),
      shmBytes: await pathSize(`${input.paths.proposed.database}-shm`),
      snapshotBytes: input.databaseBytes,
    },
    {
      retainedReleaseBytes: 0,
      minimumSafetyMarginBytes: 64 * 1024 * 1024,
    },
  );
  return {
    sufficient: plans.every((plan) => plan.sufficient),
    plans,
  };
}

async function readReleaseVersion(
  legacyRoot: string,
  requested?: string,
): Promise<string> {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(
      await readFile(path.join(legacyRoot, "package.json"), "utf8"),
    );
  } catch {
    throw new Error("legacy root must contain a readable package.json");
  }
  const version =
    typeof packageJson === "object" && packageJson !== null
      ? (packageJson as { version?: unknown }).version
      : undefined;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("legacy package.json must contain a stable product version");
  }
  if (requested !== undefined && requested !== version) {
    throw new Error(
      `requested release version ${requested} does not match legacy package version ${version}`,
    );
  }
  for (const required of [
    "apps/server/dist/main.js",
    "apps/updater/dist/cli.js",
  ]) {
    try {
      await stat(path.join(legacyRoot, required));
    } catch {
      throw new Error(`legacy bootstrap requires built artifact ${required}`);
    }
  }
  return version;
}

async function assertOldProcessStopped(
  options: BootstrapManagedInstallOptions,
): Promise<void> {
  if (
    !Number.isSafeInteger(options.oldPid) ||
    options.oldPid < 1 ||
    !options.oldBootIdentity ||
    !options.oldProcessCreatedAt
  ) {
    throw new Error(
      "bootstrap requires the old PID, boot identity and process creation identity to prove it stopped",
    );
  }
  const currentBoot = await options.identityProvider.current();
  if (currentBoot.value !== options.oldBootIdentity) {
    return;
  }
  const alive = await options.identityProvider.isProcessAlive(
    options.oldPid,
    options.oldProcessCreatedAt,
  );
  if (alive) {
    throw new Error("old process is still alive; stop and drain it first");
  }
  if (
    options.servicePort !== undefined &&
    options.identityProvider.listeningPid
  ) {
    const owner = await options.identityProvider.listeningPid(options.servicePort);
    if (owner === options.oldPid) {
      throw new Error(
        "old FileStation process still owns the service port; it is not proven stopped",
      );
    }
  }
}

function renderManagedEnv(
  original: string | undefined,
  paths: ManagedInstallPaths,
): string {
  const values: Record<string, string> = {
    FILESTATION_DB_PATH: paths.database,
    FILESTATION_STORAGE_PATH: paths.storage,
    FILESTATION_TEMP_PATH: paths.temp,
  };
  const seen = new Set<string>();
  const lines = (original ?? "").split(/\r?\n/);
  const output = lines.map((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match || !(match[1] in values)) return line;
    const key = match[1];
    if (seen.has(key)) return `${key}=${values[key]}`;
    seen.add(key);
    return `${key}=${values[key]}`;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) output.push(`${key}=${value}`);
  }
  return `${output.filter((line, index) => line !== "" || index < output.length - 1).join("\n")}\n`;
}

async function exists(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function cleanupFailedInstall(
  root: string,
  fs: DurableFileSystem,
): Promise<void> {
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) return;
  const current = path.join(resolved, "current");
  try {
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) await fs.unlink(current);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rm(resolved, { recursive: true, force: true });
}

function metadataFor(
  installId: string,
  paths: BootstrapPathPlan,
  backupId: string,
  fingerprint: string,
  createdAt: string,
): ManagedInstallMetadata {
  return {
    schemaVersion: 1,
    installId,
    installRoot: paths.installRoot,
    currentPath: path.join(paths.installRoot, "current"),
    environmentPath: path.join(paths.installRoot, ".env"),
    paths: paths.proposed,
    bootstrapBackupId: backupId,
    bootstrapFingerprint: fingerprint,
    createdAt,
  };
}

function resultFor(
  state: BootstrapManagedInstallResult["state"],
  metadata: ManagedInstallMetadata,
  releaseRealpath: string,
  releaseVersion: string,
  changes: BootstrapPathPlan["changes"],
): BootstrapManagedInstallResult {
  return {
    state,
    installId: metadata.installId,
    installRoot: metadata.installRoot,
    backupId: metadata.bootstrapBackupId,
    releaseVersion,
    releaseRealpath,
    paths: metadata.paths,
    changes,
    permissionPlan: {
      posix: { directories: "0700", files: "0600" },
      windows:
        "protected DACL: current running account, SYSTEM and Administrators only",
    },
    manualInstructions: MANUAL_INSTRUCTIONS,
  };
}

export async function bootstrapManagedInstall(
  options: BootstrapManagedInstallOptions,
): Promise<BootstrapManagedInstallResult> {
  const fs = options.fs ?? new BootstrapDurableFileSystem();
  const environment = options.environment ?? process.env;
  const pathPlan = await planBootstrapPaths({
    legacyRoot: options.legacyRoot,
    installRoot: options.installRoot,
    configuredPaths: {
      database: environment.FILESTATION_DB_PATH,
      storage: environment.FILESTATION_STORAGE_PATH,
      temp: environment.FILESTATION_TEMP_PATH,
    },
    overrides: options.overrides,
    relativePathPolicy: options.relativePathPolicy,
    acceptPathChange: options.acceptPathChange,
  });
  if (
    sameCanonicalPath(pathPlan.legacyRoot, pathPlan.installRoot) ||
    pathWithin(pathPlan.legacyRoot, pathPlan.installRoot)
  ) {
    throw new Error(
      "managed install root must be outside and distinct from the legacy source root",
    );
  }

  await assertOldProcessStopped(options);
  const releaseVersion = await readReleaseVersion(
    pathPlan.legacyRoot,
    options.releaseVersion,
  );
  const fingerprint = sha256(
    Buffer.from(
      JSON.stringify({
        legacyRoot: pathPlan.legacyRoot,
        installRoot: pathPlan.installRoot,
        paths: pathPlan.proposed,
        releaseVersion,
      }),
      "utf8",
    ),
  );
  const installId = options.id?.() ?? `install-${fingerprint.slice(0, 24)}`;
  const backupId = options.id?.() ?? `bootstrap-${fingerprint.slice(0, 24)}`;
  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const releaseName = `v${releaseVersion}-${fingerprint.slice(0, 12)}`;
  const releaseRealpath = path.join(
    pathPlan.installRoot,
    "releases",
    releaseName,
  );
  const metadata = metadataFor(
    installId,
    pathPlan,
    backupId,
    fingerprint,
    createdAt,
  );

  if (await exists(pathPlan.installRoot)) {
    const existing = await loadManagedInstallMetadata(pathPlan.installRoot, {
      fs,
    }).catch(() => undefined);
    if (
      existing &&
      existing.bootstrapFingerprint === fingerprint &&
      sameCanonicalPath(existing.installRoot, pathPlan.installRoot)
    ) {
      const current = path.join(pathPlan.installRoot, "current");
      const currentRealpath = await fs.realpath(current);
      return resultFor(
        "already-bootstrapped",
        existing,
        currentRealpath,
        releaseVersion,
        pathPlan.changes,
      );
    }
    throw new Error(
      "managed install root already exists with different or incomplete metadata",
    );
  }

  const databaseBytes = await pathSize(pathPlan.proposed.database);
  await stat(pathPlan.proposed.database).catch(() => {
    throw new Error(
      `legacy database is missing at canonical path ${pathPlan.proposed.database}`,
    );
  });
  const sourceBytes = await measureTree(pathPlan.legacyRoot);
  const verifySpace = options.verifySpace ?? defaultVerifySpace;
  const space = await verifySpace({
    paths: pathPlan,
    sourceBytes,
    databaseBytes,
    backupId,
  });
  if (!space.sufficient || space.plans.some((plan) => !plan.sufficient)) {
    throw new Error("insufficient space for bootstrap release, backup and snapshot");
  }

  if (options.dryRun) {
    return resultFor(
      "dry-run",
      metadata,
      releaseRealpath,
      releaseVersion,
      pathPlan.changes,
    );
  }

  const installParent = path.dirname(pathPlan.installRoot);
  const bootstrapLock = path.join(
    installParent,
    `.${path.basename(pathPlan.installRoot)}.bootstrap.lock`,
  );
  let created = false;
  let lockHeld = false;
  try {
    await fs.createExclusive(
      bootstrapLock,
      Buffer.from(
        `${JSON.stringify({
          schemaVersion: 1,
          pid: process.pid,
          installId,
          fingerprint,
          createdAt,
        })}\n`,
        "utf8",
      ),
      { mode: 0o600 },
    );
    lockHeld = true;
    if (await exists(pathPlan.installRoot)) {
      throw new Error(
        "managed install root appeared after preflight; refusing concurrent bootstrap",
      );
    }
    await fs.ensurePrivateDirectory(pathPlan.installRoot);
    created = true;
    await fs.writeAtomic(
      path.join(pathPlan.installRoot, ".bootstrap-in-progress.json"),
      Buffer.from(
        `${JSON.stringify({
          schemaVersion: 1,
          installId,
          backupId,
          fingerprint,
          legacyRoot: pathPlan.legacyRoot,
          installRoot: pathPlan.installRoot,
        })}\n`,
      ),
      { mode: 0o600 },
    );

    const excludedPaths = [
      pathPlan.proposed.database,
      `${pathPlan.proposed.database}-wal`,
      `${pathPlan.proposed.database}-shm`,
      pathPlan.proposed.storage,
      pathPlan.proposed.temp,
    ];
    const releaseEntries = await copySafeTree({
      sourceRoot: pathPlan.legacyRoot,
      destinationRoot: releaseRealpath,
      fs,
      excludedPaths,
      releaseOnly: true,
    });
    const backupRoot = path.join(
      pathPlan.installRoot,
      "backups",
      backupId,
    );
    const legacyBackupRoot = path.join(backupRoot, "legacy-source");
    const sourceEntries = await copySafeTree({
      sourceRoot: pathPlan.legacyRoot,
      destinationRoot: legacyBackupRoot,
      fs,
      excludedPaths,
    });
    await copySafeTree({
      sourceRoot: path.join(pathPlan.legacyRoot, "apps/updater"),
      destinationRoot: path.join(pathPlan.installRoot, "updater"),
      fs,
      excludedPaths,
    });
    const nodeModules = path.join(pathPlan.legacyRoot, "node_modules");
    if (await exists(nodeModules)) {
      await copySafeTree({
        sourceRoot: nodeModules,
        destinationRoot: path.join(pathPlan.installRoot, "node_modules"),
        fs,
        excludedPaths,
        symlinkBoundary: pathPlan.legacyRoot,
        absoluteInternalSymlinkTarget: true,
      });
    }

    const envSourcePath = path.join(pathPlan.legacyRoot, ".env");
    const envBytes = await readFile(envSourcePath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (envBytes) {
      const envBackup = path.join(backupRoot, "env", "legacy.env");
      await fs.ensurePrivateDirectory(path.dirname(envBackup));
      await fs.writeAtomic(envBackup, envBytes, { mode: 0o600 });
    }
    const managedEnv = renderManagedEnv(
      envBytes?.toString("utf8"),
      pathPlan.proposed,
    );
    await fs.writeAtomic(
      path.join(pathPlan.installRoot, ".env"),
      Buffer.from(managedEnv, "utf8"),
      { mode: 0o600 },
    );

    const snapshotPath = path.join(backupRoot, "database.sqlite");
    await fs.ensurePrivateDirectory(backupRoot);
    const snapshotReceipt = await options.snapshotDatabase({
      database: pathPlan.proposed.database,
      output: snapshotPath,
    });
    if (
      snapshotReceipt.sourceIntegrity !== "ok" ||
      snapshotReceipt.sourceForeignKeys !== 0 ||
      snapshotReceipt.snapshotIntegrity !== "ok" ||
      snapshotReceipt.snapshotForeignKeys !== 0
    ) {
      throw new Error("database snapshot verification did not return an OK receipt");
    }
    await fs.protect(snapshotPath, false);

    const managedMetadataPath = path.join(
      pathPlan.installRoot,
      "managed-install.json",
    );
    const manifest = {
      schemaVersion: 1,
      kind: "bootstrap-backup",
      backupId,
      installId,
      createdAt,
      legacyRoot: pathPlan.legacyRoot,
      installRoot: pathPlan.installRoot,
      releaseVersion,
      canonicalPaths: pathPlan.proposed,
      canonicalPathChanges: pathPlan.changes,
      sourceEntries,
      releaseEntries,
      exclusions: [
        ".git",
        "caches",
        "logs",
        "data/storage",
        "data/temp",
        normalizeRelative(path.relative(pathPlan.legacyRoot, pathPlan.proposed.database)),
        normalizeRelative(path.relative(pathPlan.legacyRoot, `${pathPlan.proposed.database}-wal`)),
        normalizeRelative(path.relative(pathPlan.legacyRoot, `${pathPlan.proposed.database}-shm`)),
      ],
      env: envBytes
        ? {
            storedPath: "env/legacy.env",
            sha256: sha256(envBytes),
            size: envBytes.length,
          }
        : { present: false },
      snapshot: {
        storedPath: "database.sqlite",
        sha256: sha256(await readFile(snapshotPath)),
        bytes: (await stat(snapshotPath)).size,
      },
      legacyRestartInstructions: [
        "Use the original legacy root and the unchanged original launch command.",
        "If restoring the backup to another path, copy legacy-source and env/legacy.env together, then run the old command from that restored root.",
        "Do not point an old and new process at the same database or storage simultaneously.",
      ],
      excludedFromRuntimeCopy:
        "database/storage/temp remain at their canonical non-copied locations",
    };
    const manifestBytes = Buffer.from(
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    await fs.writeAtomic(
      path.join(backupRoot, "MANIFEST.json"),
      manifestBytes,
      { mode: 0o600 },
    );
    await fs.writeAtomic(
      managedMetadataPath,
      Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
      { mode: 0o600 },
    );

    const current = metadata.currentPath;
    if (process.platform === "win32") {
      await fs.createJunction(releaseRealpath, current);
    } else {
      await fs.symlink(releaseRealpath, current);
    }
    const actualCurrent = await fs.realpath(current);
    if (!sameCanonicalPath(actualCurrent, releaseRealpath)) {
      throw new Error("managed current link does not resolve to the bootstrap release");
    }
    await fs.unlink(path.join(pathPlan.installRoot, ".bootstrap-in-progress.json"));
    await fs.unlink(bootstrapLock);
    lockHeld = false;
    return resultFor(
      "bootstrapped",
      metadata,
      releaseRealpath,
      releaseVersion,
      pathPlan.changes,
    );
  } catch (error) {
    if (created) await cleanupFailedInstall(pathPlan.installRoot, fs);
    if (lockHeld) {
      await fs.unlink(bootstrapLock).catch(() => {});
    }
    throw error;
  }
}

export async function inspectManagedUpdate(
  root: string,
  options: { fs?: DurableFileSystem } = {},
): Promise<ManagedUpdateInspection> {
  const fs = options.fs ?? new NodeDurableFileSystem();
  const metadata = await loadManagedInstallMetadata(root, { fs });
  const journalPath = path.join(path.resolve(root), "update-attempt.journal");
  if (!(await fs.exists(journalPath))) {
    return {
      state: "no-active-update",
      installId: metadata.installId,
    };
  }
  const journal = await AttemptJournal.open(path.resolve(root), { fs });
  const snapshot = await journal.readSnapshot();
  if (!snapshot.phase) {
    return {
      state: "no-active-update",
      installId: metadata.installId,
    };
  }
  const terminal = TERMINAL_PHASES.has(snapshot.phase);
  return {
    state: terminal ? "terminal" : "active",
    installId: metadata.installId,
    attemptId: snapshot.attemptId,
    fence: snapshot.fence,
    phase: snapshot.phase,
    pendingAction: snapshot.pending?.action,
  };
}

export async function recoverManagedUpdate(
  root: string,
  options: { fs?: DurableFileSystem } = {},
): Promise<ManagedRecoveryResult> {
  const inspected = await inspectManagedUpdate(root, options);
  if (inspected.state === "no-active-update") {
    return {
      state: "no-active-recovery",
      installId: inspected.installId,
      guidance: "No active update journal attempt was found.",
    };
  }
  if (inspected.state === "terminal") {
    return {
      state: "no-active-recovery",
      installId: inspected.installId,
      guidance: `Attempt ${inspected.attemptId} is terminal (${inspected.phase}).`,
    };
  }
  throw new Error(
    `Active update ${inspected.attemptId} at ${inspected.phase} requires the authenticated Task 9 recovery orchestrator. Keep the journal and owner lock unchanged; do not truncate or edit them.`,
  );
}
