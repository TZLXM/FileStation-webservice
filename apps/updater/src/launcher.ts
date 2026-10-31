import { parseProductionEnvironment, ProductionEnvironmentRequirements, requireProductionEnvironment } from "./bootstrap/environment";
import { readFile as readFileFromDisk, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertLaunchRecoverySafe } from "./state/launch-recovery";
import { parse as parseDotenv } from "dotenv";
import {
  DurableFileSystem,
  NodeDurableFileSystem,
} from "./platform/durable-fs";
import {
  ManagedInstallPaths,
  canonicalPathKey,
  canonicalizePotentialPath,
  pathWithin,
  sameCanonicalPath,
} from "./bootstrap/path-plan";

export interface ManagedInstallMetadata {
  schemaVersion: 1;
  installId: string;
  installRoot: string;
  currentPath: string;
  environmentPath: string;
  paths: ManagedInstallPaths;
  bootstrapBackupId: string;
  bootstrapFingerprint: string;
  createdAt: string;
  productionEnvironment?: ProductionEnvironmentRequirements;
}

export interface LaunchEnvironment {
  root: string;
  dotenvPath: string;
  values: Readonly<Record<string, string>>;
}

export interface LoadInstallEnvironmentOptions {
  processEnvironment?: NodeJS.ProcessEnv;
  readFile?: (filename: string, encoding: "utf8") => Promise<string>;
}

export interface ManagedLaunchValidationInput {
  cwd: string;
  executableRealpath: string;
  installMetadata: ManagedInstallMetadata;
  currentRealpath: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
  processEnvironment?: Readonly<NodeJS.ProcessEnv>;
  configuredPaths?: Partial<
    Record<keyof ManagedInstallPaths, string | undefined>
  >;
}

export interface ManagedLaunchPlan {
  installId: string;
  installRoot: string;
  releaseRealpath: string;
  paths: ManagedInstallPaths;
  environment: Readonly<Record<string, string>>;
}

export interface LaunchManagedInstallOptions {
  root: string;
  cwd?: string;
  executableRealpath?: string;
  currentRealpath?: string;
  metadata?: ManagedInstallMetadata;
  processEnvironment?: NodeJS.ProcessEnv;
  targetEnvironment?: NodeJS.ProcessEnv;
  fs?: DurableFileSystem;
  importer?: (specifier: string) => Promise<unknown>;
}

export interface LaunchManagedInstallResult {
  plan: ManagedLaunchPlan;
  imported: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireAbsolute(field: string, value: unknown): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${field} must be an absolute canonical path`);
  }
  const normalized = path.resolve(value);
  if (normalized !== value.replace(/[\\/]+$/, "")) {
    throw new Error(`${field} must be normalized`);
  }
  return normalized;
}

export function parseManagedInstallMetadata(
  value: unknown,
): ManagedInstallMetadata {
  if (!isObject(value) || value.schemaVersion !== 1) {
    throw new Error("managed-install.json has an unsupported schema");
  }
  const installRoot = requireAbsolute("installRoot", value.installRoot);
  const currentPath = requireAbsolute("currentPath", value.currentPath);
  const environmentPath = requireAbsolute(
    "environmentPath",
    value.environmentPath,
  );
  if (!sameCanonicalPath(currentPath, path.join(installRoot, "current"))) {
    throw new Error("managed-install.json currentPath must be <installRoot>/current");
  }
  if (!sameCanonicalPath(environmentPath, path.join(installRoot, ".env"))) {
    throw new Error("managed-install.json environmentPath must be <installRoot>/.env");
  }
  if (
    typeof value.installId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.installId)
  ) {
    throw new Error("managed-install.json installId is invalid");
  }
  if (
    typeof value.bootstrapBackupId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
      value.bootstrapBackupId,
    )
  ) {
    throw new Error("managed-install.json bootstrapBackupId is invalid");
  }
  if (
    typeof value.bootstrapFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.bootstrapFingerprint)
  ) {
    throw new Error("managed-install.json bootstrapFingerprint is invalid");
  }
  if (
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new Error("managed-install.json createdAt is invalid");
  }
  if (!isObject(value.paths)) {
    throw new Error("managed-install.json paths are missing");
  }
  const paths = {
    database: requireAbsolute("paths.database", value.paths.database),
    storage: requireAbsolute("paths.storage", value.paths.storage),
    temp: requireAbsolute("paths.temp", value.paths.temp),
  };
  if (
    sameCanonicalPath(paths.storage, paths.temp) ||
    sameCanonicalPath(paths.database, paths.storage) ||
    sameCanonicalPath(paths.database, paths.temp)
  ) {
    throw new Error("managed-install.json database/storage/temp paths must be distinct");
  }
  return {
    schemaVersion: 1,
    installId: value.installId,
    installRoot,
    currentPath,
    environmentPath,
    paths,
    bootstrapBackupId: value.bootstrapBackupId,
    bootstrapFingerprint: value.bootstrapFingerprint,
    createdAt: value.createdAt,
    ...(value.productionEnvironment !== undefined ? { productionEnvironment: parseProductionEnvironment(value.productionEnvironment) } : {}),
  };
}

export async function loadManagedInstallMetadata(
  root: string,
  options: { fs?: DurableFileSystem } = {},
): Promise<ManagedInstallMetadata> {
  const fs = options.fs ?? new NodeDurableFileSystem();
  const filename = path.join(path.resolve(root), "managed-install.json");
  let raw: Buffer;
  try {
    raw = await fs.readFile(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`managed-install.json is missing at ${filename}`);
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("managed-install.json is not valid JSON");
  }
  return parseManagedInstallMetadata(parsed);
}

export async function loadInstallEnvironment(
  root: string,
  options: LoadInstallEnvironmentOptions = {},
): Promise<LaunchEnvironment> {
  const canonicalRoot = path.resolve(root);
  const dotenvPath = path.join(canonicalRoot, ".env");
  const processEnvironment = options.processEnvironment ?? process.env;
  const readText =
    options.readFile ??
    ((filename: string, encoding: "utf8") =>
      readFileFromDisk(filename, encoding));
  let dotenvValues: Record<string, string> = {};
  try {
    dotenvValues = parseDotenv(await readText(dotenvPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const values: Record<string, string> = { ...dotenvValues };
  for (const [key, value] of Object.entries(processEnvironment)) {
    if (value !== undefined) values[key] = value;
  }
  return { root: canonicalRoot, dotenvPath, values };
}

export function validateManagedLaunch(
  input: ManagedLaunchValidationInput,
): ManagedLaunchPlan {
  const metadata = parseManagedInstallMetadata(input.installMetadata);
  const cwd = path.resolve(input.cwd);
  const executable = path.resolve(input.executableRealpath);
  const current = path.resolve(input.currentRealpath);

  if (!sameCanonicalPath(cwd, metadata.installRoot)) {
    throw new Error(
      "managed launch must use the installation root as cwd; current/ and release directories are rejected",
    );
  }
  const releasesRoot = path.join(metadata.installRoot, "releases");
  if (
    !pathWithin(releasesRoot, current) ||
    sameCanonicalPath(current, releasesRoot)
  ) {
    throw new Error("managed current link does not resolve inside <installRoot>/releases");
  }
  if (
    !pathWithin(current, executable) ||
    sameCanonicalPath(executable, current)
  ) {
    throw new Error(
      "managed server executable is not in the current release; direct stale-release launch is rejected",
    );
  }

  if (input.configuredPaths) {
    for (const key of ["database", "storage", "temp"] as const) {
      const configured = input.configuredPaths[key];
      if (configured === undefined) continue;
      if (!path.isAbsolute(configured)) {
        throw new Error(
          `configured ${key} path must be an absolute canonical path before any filesystem or database write`,
        );
      }
      if (!sameCanonicalPath(configured, metadata.paths[key])) {
        throw new Error(
          `configured ${key} canonical path differs from managed-install.json`,
        );
      }
    }
  }

  const environment: Record<string, string> = {
    FILESTATION_MANAGED_LAUNCH: "true",
    FILESTATION_INSTALL_ID: metadata.installId,
    FILESTATION_INSTALL_ROOT: metadata.installRoot,
    FILESTATION_RELEASE_ROOT: current,
    FILESTATION_DB_PATH: metadata.paths.database,
    FILESTATION_STORAGE_PATH: metadata.paths.storage,
    FILESTATION_TEMP_PATH: metadata.paths.temp,
  };
  return {
    installId: metadata.installId,
    installRoot: metadata.installRoot,
    releaseRealpath: current,
    paths: metadata.paths,
    environment,
  };
}

/** Read-only data safety preflight, including authorized update children. */
export async function validateManagedDataOnDisk(
  input: ManagedLaunchValidationInput,
): Promise<ManagedLaunchPlan> {
  const plan = validateManagedLaunch(input);
  requireProductionEnvironment(input.environment ?? {}, input.installMetadata.productionEnvironment, input.processEnvironment);
  for (const key of ["database", "storage", "temp"] as const) {
    const actual = await canonicalizePotentialPath(plan.paths[key], plan.installRoot);
    if (!sameCanonicalPath(actual, plan.paths[key]))
      throw new Error(`${key} canonical target drift detected before writes`);
  }
  return plan;
}

/** Normal launch additionally refuses active/uncertain update ownership. */
export async function validateManagedLaunchOnDisk(
  input: ManagedLaunchValidationInput,
  fs: DurableFileSystem = new NodeDurableFileSystem(),
): Promise<ManagedLaunchPlan> {
  const plan = await validateManagedDataOnDisk(input);
  await assertLaunchRecoverySafe(plan.installRoot, plan.releaseRealpath, fs);
  return plan;
}

export async function launchManagedInstall(
  options: LaunchManagedInstallOptions,
): Promise<LaunchManagedInstallResult> {
  const fs = options.fs ?? new NodeDurableFileSystem();
  const targetEnvironment = options.targetEnvironment ?? process.env;
  const environment = await loadInstallEnvironment(options.root, {
    processEnvironment: options.processEnvironment ?? targetEnvironment,
  });
  const metadata =
    options.metadata ??
    (await loadManagedInstallMetadata(options.root, { fs }));
  const currentRealpath =
    options.currentRealpath ?? (await fs.realpath(metadata.currentPath));
  const executableRealpath =
    options.executableRealpath ??
    (await realpath(
      path.join(currentRealpath, "apps/server/dist/main.js"),
    ));
  const configuredPaths = {
    database: environment.values.FILESTATION_DB_PATH,
    storage: environment.values.FILESTATION_STORAGE_PATH,
    temp: environment.values.FILESTATION_TEMP_PATH,
  };
  const plan = await validateManagedLaunchOnDisk({
    cwd: options.cwd ?? process.cwd(),
    executableRealpath,
    installMetadata: metadata,
    currentRealpath,
    configuredPaths,
    environment: environment.values,
    processEnvironment: options.processEnvironment ?? targetEnvironment,
  }, fs);

  for (const [key, value] of Object.entries(environment.values)) {
    targetEnvironment[key] = value;
  }
  for (const [key, value] of Object.entries(plan.environment)) {
    targetEnvironment[key] = value;
  }

  const serverMain = path.join(
    plan.releaseRealpath,
    "apps/server/dist/main.js",
  );
  const importer =
    options.importer ??
    (async (specifier: string) => require(fileURLToPath(specifier)));
  const imported = await importer(pathToFileURL(serverMain).href);
  return { plan, imported };
}

export function managedEnvironmentAssignments(
  plan: ManagedLaunchPlan,
): Readonly<Record<string, string>> {
  return Object.freeze({ ...plan.environment });
}

export function managedPathKey(value: string): string {
  return canonicalPathKey(value);
}
