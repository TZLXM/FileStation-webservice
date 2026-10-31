import { planProductionEnvironment, ProductionEnvironmentResolution, ProductionEnvironmentRequirements, renderManagedEnv } from "./environment";
import { syncRecoveryTree, verifyExistingBootstrap } from "./backup-assets";
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
import { assertLaunchRecoverySafe, unresolvedRecoveryMarker } from "../state/launch-recovery";
import { AttemptJournal, JournalCorruptError } from "../state/attempt-journal";
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
  canonicalizePotentialPath,
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
  productionEnvironmentResolution?: ProductionEnvironmentResolution;
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
    environmentBytes: number;
    manifestBytes: number;
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
  productionEnvironment?: ProductionEnvironmentRequirements;
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
  policyRoot: string;
  destinationRoot: string;
  fs: DurableFileSystem;
  excludedPaths: string[];
  releaseOnly?: boolean;
  symlinkBoundary?: string;
  destinationBoundary?: string;
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
  const lower = normalized.toLowerCase();
  if (segments.some(segment => segment.toLowerCase() === ".git")) return true;
  if (segments.some((segment, index) => segment.toLowerCase() === "node_modules" && segments[index + 1]?.toLowerCase() === ".cache")) return true;
  if (["logs", "cache", ".cache", "coverage", "node_modules/.cache", "apps/server/logs", "apps/updater/logs"].some(
    prefix => lower === prefix || lower.startsWith(`${prefix}/`),
  )) return true;
  if (
    normalized === "data/storage" ||
    normalized.startsWith("data/storage/") ||
    normalized === "data/temp" ||
    normalized.startsWith("data/temp/")
  ) {
    return true;
  }
  return (
    ((basename === ".env" || basename.startsWith(".env.")) &&
      !(segments.some(segment => segment.toLowerCase() === "node_modules") && [".env.defaults", ".env.example"].includes(basename))) ||
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

function runtimeExclusions(paths: ManagedInstallPaths): string[] {
  return [paths.database, `${paths.database}-wal`, `${paths.database}-shm`, paths.storage, paths.temp];
}

async function excludedRuntimePath(source: string, excluded: string[]): Promise<boolean> {
  if (excluded.some(candidate => pathWithin(candidate, source))) return true;
  const actual = await canonicalizePotentialPath(source, path.dirname(source));
  return excluded.some(candidate => pathWithin(candidate, actual));
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
      const policyRelative = path.relative(options.policyRoot, source);
      if (
        (options.releaseOnly
          ? isReleaseExcluded(policyRelative)
          : isExcludedRelative(policyRelative)) ||
        (await excludedRuntimePath(source, options.excludedPaths))
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
        const relocatedTarget = path.join(options.destinationBoundary ?? options.destinationRoot, path.relative(symlinkBoundary, targetAbsolute));
        await options.fs.ensurePrivateDirectory(path.dirname(destination));
        if (process.platform === "win32" && targetMetadata.isDirectory()) {
          await options.fs.createJunction(relocatedTarget, destination);
        } else {
          await options.fs.symlink(
            path.relative(path.dirname(destination), relocatedTarget),
            destination,
          );
        }
        entries.push({
          path: normalizeRelative(relative),
          type: "symlink",
          size: 0,
          target: normalizeRelative(path.relative(path.dirname(destination), relocatedTarget)),
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

async function measureTree(root: string, excluded: string[], installRoot: string): Promise<{ sourceBytes: number; manifestBytes: number }> {
  let total = 0;
  let manifestBytes = 65536;
  const walk = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const filename = path.join(directory, name);
      if (isExcludedRelative(path.relative(root, filename)) || await excludedRuntimePath(filename, excluded)) continue;
      const metadata = await lstat(filename);
      if (metadata.isSymbolicLink() || metadata.isFile()) {
        const targetLength = metadata.isSymbolicLink() ? (await readlink(filename)).length : 0;
        // Four copies at most; bound JSON escaping and both path and link target.
        manifestBytes += 4 * (1024 + 12 * (filename.length + installRoot.length + targetLength));
        if (!Number.isSafeInteger(manifestBytes)) throw new Error("bootstrap manifest budget exceeds safe integer");
      }
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) await walk(filename);
      else if (metadata.isFile()) {
        total += metadata.size;
        if (!Number.isSafeInteger(total)) throw new Error("bootstrap source size exceeds safe integer");
      }
    }
  };
  await walk(root);
  return { sourceBytes: total, manifestBytes };
}

async function pathSize(filename: string): Promise<number> {
  try {
    return (await stat(filename)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

export async function defaultVerifySpace(input: {
  paths: BootstrapPathPlan;
  sourceBytes: number;
  environmentBytes?: number;
  manifestBytes?: number;
  databaseBytes: number;
  backupId: string;
}): Promise<SpaceVerification> {
  const installRoot = input.paths.installRoot;
  // Each actual copy is bounded by sourceBytes: release, legacy backup,
  // standalone updater, and node_modules.
  const sourceCopyBudgetBytes = input.sourceBytes * 4 + (input.environmentBytes ?? 0) + (input.manifestBytes ?? 0);
  if (
    !Number.isSafeInteger(input.sourceBytes) ||
    input.sourceBytes < 1 ||
    !Number.isSafeInteger(input.environmentBytes ?? 0) || (input.environmentBytes ?? 0) < 0 ||
    !Number.isSafeInteger(input.manifestBytes ?? 0) || (input.manifestBytes ?? 0) < 0 ||
    !Number.isSafeInteger(sourceCopyBudgetBytes)
  ) {
    throw new Error(
      "bootstrap source-copy budget must be a positive safe integer",
    );
  }
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
          unpacked_size: sourceCopyBudgetBytes - input.sourceBytes,
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
  const providerPattern = currentBoot.provider === "linux-proc"
    ? /^linux:(?!00000000-0000-0000-0000-000000000000$)[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
    : currentBoot.provider === "windows-cim"
      ? /^win32:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,7}Z$/ : undefined;
  const valid = (value: string) => providerPattern?.test(value) &&
    (currentBoot.provider !== "windows-cim" ||
      (Number.isFinite(Date.parse(value.slice(6))) &&
       new Date(value.slice(6)).toISOString() === value.slice(6).replace(/\.(\d+)Z$/, (_, fraction: string) => `.${fraction.slice(0, 3)}Z`)));
  if (!valid(currentBoot.value) || !valid(options.oldBootIdentity))
    throw new Error("old boot identity is invalid or not comparable to the current provider boot identity");
  const processPattern = currentBoot.provider === "linux-proc" ? /^linux-starttime:\d+$/ : /^win32:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,7}Z$/;
  if (!processPattern.test(options.oldProcessCreatedAt) ||
      (currentBoot.provider === "windows-cim" &&
       (!valid(options.oldProcessCreatedAt) || options.oldProcessCreatedAt.length !== currentBoot.value.length)))
    throw new Error("old process creation identity is invalid for the boot identity provider");
  const comparableBoot = (value: string) => value.replace(/\.(\d+)Z$/, (_, fraction: string) => `.${fraction.padEnd(7, "0")}Z`);
  if (comparableBoot(currentBoot.value) !== comparableBoot(options.oldBootIdentity)) {
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
    manualInstructions: [...MANUAL_INSTRUCTIONS, "Production service migration: securely provide the same NODE_ENV and JWT_SECRET at every launch; shell secret values are never persisted automatically."],
    ...(metadata.productionEnvironment ? { productionEnvironment: metadata.productionEnvironment } : {}),
  };
}

export async function bootstrapManagedInstall(
  options: BootstrapManagedInstallOptions,
): Promise<BootstrapManagedInstallResult> {
  const fs = options.fs ?? new BootstrapDurableFileSystem();
  const legacyRoot = await canonicalizePotentialPath(options.legacyRoot, process.cwd());
  const envBytes = await readFile(path.join(legacyRoot, ".env")).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  const dotenv = envBytes ? parseDotenv(envBytes) : {};
  const invocation = options.environment ?? process.env;
  const environment: NodeJS.ProcessEnv = { ...dotenv };
  for (const [key,value] of Object.entries(invocation)) if (value !== undefined) environment[key] = value;
  const productionEnvironment = planProductionEnvironment(dotenv, environment, options.productionEnvironmentResolution);
  const pathPlan = await planBootstrapPaths({
    legacyRoot: options.legacyRoot,
    installRoot: options.installRoot,
    configuredPaths: {
      database: options.configuredPaths?.database ?? environment.FILESTATION_DB_PATH,
      storage: options.configuredPaths?.storage ?? environment.FILESTATION_STORAGE_PATH,
      temp: options.configuredPaths?.temp ?? environment.FILESTATION_TEMP_PATH,
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

  const managedEnv = renderManagedEnv(envBytes?.toString("utf8"), pathPlan.proposed);
  const excludedPaths = [...runtimeExclusions(pathPlan.previous), ...runtimeExclusions(pathPlan.proposed)];
  for (const relative of ["apps", "apps/updater", "node_modules"]) {
    const candidate = path.join(pathPlan.legacyRoot, relative);
    try {
      if ((await lstat(candidate)).isSymbolicLink())
        throw new Error(`bootstrap copy root or ancestor is a link: ${relative}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await assertOldProcessStopped(options);
  const releaseVersion = await readReleaseVersion(
    pathPlan.legacyRoot,
    options.releaseVersion,
  );
  const fingerprint = sha256(
    Buffer.from(
      JSON.stringify({
        copyPolicyVersion: 2,
        legacyRoot: pathPlan.legacyRoot,
        installRoot: pathPlan.installRoot,
        paths: pathPlan.proposed,
        productionEnvironment,
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

  if (productionEnvironment) metadata.productionEnvironment = productionEnvironment;
  const bootstrapLock = path.join(path.dirname(pathPlan.installRoot), `.${path.basename(pathPlan.installRoot)}.bootstrap.lock`);
  const lockBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, pid: process.pid, installId, fingerprint, createdAt })}\n`, "utf8");
  const publicationMarker = path.join(pathPlan.installRoot, ".bootstrap-in-progress.json");
  if (await fs.exists(bootstrapLock) || await fs.exists(publicationMarker))
    throw new Error("Bootstrap recovery required: publication marker or owner lock remains; do not remove a live owner's state. Inspect the original source and bootstrap state manually.");

  if (await exists(pathPlan.installRoot)) {
    let owned = false;
    try {
      if (!options.dryRun) {
        try { await fs.createExclusive(bootstrapLock, lockBytes, { mode: 0o600 }); owned = true; }
        catch { throw new Error("Bootstrap recovery required: exclusive bootstrap ownership unavailable"); }
      }
      if (await fs.exists(publicationMarker)) throw new Error("Bootstrap recovery required: interrupted publication marker remains");
      const existing = await loadManagedInstallMetadata(pathPlan.installRoot, { fs });
      if (existing.bootstrapFingerprint !== fingerprint || !sameCanonicalPath(existing.installRoot, pathPlan.installRoot))
        throw new Error("Bootstrap recovery required: different or incomplete metadata");
      const currentRealpath = await fs.realpath(existing.currentPath);
      await verifyExistingBootstrap(existing, pathPlan.proposed, releaseRealpath, currentRealpath, fs, pathPlan.previous);
      return resultFor(options.dryRun ? "dry-run" : "already-bootstrapped", existing, currentRealpath, releaseVersion, pathPlan.changes);
    } catch (error) {
      throw new Error(`Bootstrap recovery required: ${error instanceof Error ? error.message : "incomplete installation"}`);
    } finally { if (owned) await fs.unlink(bootstrapLock); }
  }

  const targetChanged = !sameCanonicalPath(pathPlan.previous.database, pathPlan.proposed.database);
  const databaseBytes = await pathSize(pathPlan.previous.database) + await pathSize(`${pathPlan.previous.database}-wal`) + (targetChanged ? await pathSize(pathPlan.proposed.database) + await pathSize(`${pathPlan.proposed.database}-wal`) : 0);
  await stat(pathPlan.previous.database).catch(() => { throw new Error("original legacy database is missing at its approved canonical path"); });
  await stat(pathPlan.proposed.database).catch(() => {
    throw new Error(
      `legacy database is missing at canonical path ${pathPlan.proposed.database}`,
    );
  });
  const { sourceBytes, manifestBytes } = await measureTree(pathPlan.legacyRoot, excludedPaths, pathPlan.installRoot);
  const verifySpace = options.verifySpace ?? defaultVerifySpace;
  const space = await verifySpace({
    paths: pathPlan,
    sourceBytes,
    environmentBytes: (envBytes?.length ?? 0) + Buffer.byteLength(managedEnv, "utf8"),
    manifestBytes,
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

    const releaseEntries = await copySafeTree({
      sourceRoot: pathPlan.legacyRoot,
      policyRoot: pathPlan.legacyRoot,
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
      policyRoot: pathPlan.legacyRoot,
      destinationRoot: legacyBackupRoot,
      fs,
      excludedPaths,
    });
    const updaterEntries = await copySafeTree({
      sourceRoot: path.join(pathPlan.legacyRoot, "apps/updater"),
      policyRoot: pathPlan.legacyRoot,
      destinationRoot: path.join(pathPlan.installRoot, "updater"),
      fs,
      excludedPaths,
    });
    const nodeModules = path.join(pathPlan.legacyRoot, "node_modules");
    const nodeModulesEntries = await exists(nodeModules)
      ? await copySafeTree({
        sourceRoot: nodeModules,
        policyRoot: pathPlan.legacyRoot,
        destinationRoot: path.join(pathPlan.installRoot, "node_modules"),
        fs,
        excludedPaths,
        symlinkBoundary: pathPlan.legacyRoot,
        destinationBoundary: releaseRealpath,
      }) : null;

    if (envBytes) {
      const envBackup = path.join(backupRoot, "env", "legacy.env");
      await fs.ensurePrivateDirectory(path.dirname(envBackup));
      await fs.writeAtomic(envBackup, envBytes, { mode: 0o600 });
    }
    await fs.writeAtomic(
      path.join(pathPlan.installRoot, ".env"),
      Buffer.from(managedEnv, "utf8"),
      { mode: 0o600 },
    );

    const snapshotPath = path.join(backupRoot, "database.sqlite");
    await fs.ensurePrivateDirectory(backupRoot);
    const snapshotReceipt = await options.snapshotDatabase({
      database: pathPlan.previous.database,
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
    let targetSnapshot;
    if (targetChanged) {
      const targetPath = path.join(backupRoot, "target-database.sqlite");
      const receipt = await options.snapshotDatabase({ database: pathPlan.proposed.database, output: targetPath });
      if (receipt.sourceIntegrity !== "ok" || receipt.sourceForeignKeys !== 0 || receipt.snapshotIntegrity !== "ok" || receipt.snapshotForeignKeys !== 0)
        throw new Error("relocated target database snapshot verification failed");
      await fs.protect(targetPath, false);
      targetSnapshot = { storedPath: "target-database.sqlite", database: pathPlan.proposed.database, sha256: sha256(await readFile(targetPath)), bytes: (await stat(targetPath)).size, receipt };
    }


    const managedMetadataPath = path.join(
      pathPlan.installRoot,
      "managed-install.json",
    );
    const manifest = {
      schemaVersion: 1,
      copyPolicyVersion: 2,
      kind: "bootstrap-backup",
      backupId,
      installId,
      createdAt,
      legacyRoot: pathPlan.legacyRoot,
      installRoot: pathPlan.installRoot,
      releaseVersion,
      canonicalPaths: pathPlan.proposed,
      originalCanonicalPaths: pathPlan.previous,
      productionEnvironment,
      canonicalPathChanges: pathPlan.changes,
      sourceEntries,
      releaseEntries,
      updaterEntries,
      nodeModulesEntries,
      exclusions: [
        ...excludedPaths,
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
      snapshotReceipt,
      targetSnapshot,
      snapshot: {
        database: pathPlan.previous.database,
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
    await syncRecoveryTree(pathPlan.installRoot, fs);
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
    await verifyExistingBootstrap(metadata, pathPlan.proposed, releaseRealpath, actualCurrent, fs, pathPlan.previous);
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
  const marker = await unresolvedRecoveryMarker(root, fs);
  if (marker) return { state: "active", installId: metadata.installId, pendingAction: `unresolved-${marker}` };
  const journalPath = path.join(path.resolve(root), "update-attempt.journal");
  if (!(await fs.exists(journalPath))) {
    return {
      state: "no-active-update",
      installId: metadata.installId,
    };
  }
  let snapshot;
  try { snapshot = await AttemptJournal.inspect(path.resolve(root), { fs }); }
  catch (error) {
    if (!(error instanceof JournalCorruptError)) throw error;
    return { state: "active", installId: metadata.installId, pendingAction: "uncertain-journal-recovery-required" };
  }
  if (!snapshot.phase) {
    return {
      state: "no-active-update",
      installId: metadata.installId,
    };
  }
  let terminal = TERMINAL_PHASES.has(snapshot.phase) && !snapshot.pending;
  if (terminal) {
    try { await assertLaunchRecoverySafe(root, await fs.realpath(metadata.currentPath), fs); }
    catch { terminal = false; }
  }
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
