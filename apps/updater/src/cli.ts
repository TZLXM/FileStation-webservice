#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import path from "node:path";
import {
  DatabaseSnapshotReceipt,
  bootstrapManagedInstall,
  inspectManagedUpdate,
  recoverManagedUpdate,
} from "./bootstrap/bootstrap-command";
import {
  launchManagedInstall,
  loadInstallEnvironment,
  loadManagedInstallMetadata,
  validateManagedLaunchOnDisk,
} from "./launcher";
import {
  PlatformBootIdentityProvider,
  ProcessIdentityProvider,
} from "./state/boot-identity";

const execFileAsync = promisify(execFile);
const MINIMUM_NODE = [20, 17, 0] as const;
const HELP = `FileStation updater 0.2.0

Usage:
  filestation-updater bootstrap --root <managed-root> --source-root <legacy-root>
    --old-pid <pid> --old-boot-identity <id> --old-process-created-at <identity>
    --relative-path-policy preserve|managed [--database <absolute-path>]
    [--storage <absolute-path>] [--temp <absolute-path>] [--accept-path-change]
    [--service-port <port>] [--release-version <version>] [--dry-run]
    [--production-env-resolution dotenv|service]

  filestation-updater launch --root <managed-root> [--dry-run]
  filestation-updater status --root <managed-root>
  filestation-updater recover --root <managed-root>

Manual operation:
  1. Stop and drain the old FileStation process. Bootstrap never stops a process.
  2. Record the old PID, boot identity and process creation identity while the
     process is still visible.
  3. Review canonical database/storage/temp paths and relative-path policy.
  4. Run bootstrap. Nginx files are never modified or reloaded by this CLI.
  5. Restore by stopping the managed process and using
     backups/<id>/legacy-source plus backups/<id>/env/legacy.env with the old
     launch command from the original legacy root.

Bootstrap requires the original NODE_ENV explicitly (production/development/test).
Run it with the original deployment environment; do not infer a missing mode.
Production requires NODE_ENV and JWT_SECRET. If they are process-only, securely
configure the same values in restricted .env or the new service environment, then
acknowledge --production-env-resolution service. Shell secrets are never persisted.
The CLI never prints .env values. Active update recovery is fail closed until the
authenticated update orchestrator is available.
`;

function assertNodeVersion(): void {
  const current = process.versions.node.split(".").map(Number);
  for (let index = 0; index < MINIMUM_NODE.length; index++) {
    if (current[index] > MINIMUM_NODE[index]) return;
    if (current[index] < MINIMUM_NODE[index]) {
      throw new Error(
        `FileStation requires Node.js ${MINIMUM_NODE.join(".")} or newer`,
      );
    }
  }
}

function required(
  values: Record<string, string | boolean | undefined>,
  name: string,
): string {
  const value = values[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function integer(
  values: Record<string, string | boolean | undefined>,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const raw = required(values, name);
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function snapshotEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

async function runServerSnapshot(
  sourceRoot: string,
  database: string,
  output: string,
): Promise<DatabaseSnapshotReceipt> {
  const script = path.join(
    sourceRoot,
    "apps/server/dist/bootstrap/bootstrap-snapshot.js",
  );
  const { stdout } = await execFileAsync(
    process.execPath,
    [script, "--db", database, "--out", output],
    {
      env: snapshotEnvironment(),
      windowsHide: true,
      timeout: 5 * 60_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const parsed = JSON.parse(stdout) as DatabaseSnapshotReceipt;
  if (
    parsed.sourceIntegrity !== "ok" ||
    parsed.sourceForeignKeys !== 0 ||
    parsed.snapshotIntegrity !== "ok" ||
    parsed.snapshotForeignKeys !== 0
  ) {
    throw new Error("server snapshot helper returned an invalid receipt");
  }
  return parsed;
}

export interface CliDependencies {
  identityProvider?: ProcessIdentityProvider;
  importer?: (specifier: string) => Promise<unknown>;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number> {
  assertNodeVersion();
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const command = argv[0];
  if (!["bootstrap", "launch", "status", "recover"].includes(command)) {
    throw new Error(`unsupported command ${command}`);
  }
  const parsed = parseArgs({
    args: argv.slice(1),
    allowPositionals: false,
    strict: true,
    options: {
      root: { type: "string" },
      "source-root": { type: "string" },
      database: { type: "string" },
      storage: { type: "string" },
      temp: { type: "string" },
      "relative-path-policy": { type: "string" },
      "accept-path-change": { type: "boolean" },
      "production-env-resolution": { type: "string" },
      "old-pid": { type: "string" },
      "old-boot-identity": { type: "string" },
      "old-process-created-at": { type: "string" },
      "service-port": { type: "string" },
      "release-version": { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  const values = parsed.values as Record<
    string,
    string | boolean | undefined
  >;

  if (command === "bootstrap") {
    const installRoot = path.resolve(
      typeof values.root === "string" ? values.root : process.cwd(),
    );
    const sourceRoot = path.resolve(required(values, "source-root"));
    const policy = required(values, "relative-path-policy");
    if (policy !== "preserve" && policy !== "managed") {
      throw new Error("--relative-path-policy must be preserve or managed");
    }
    const environment = await loadInstallEnvironment(sourceRoot);
    const resolution = values["production-env-resolution"];
    if (resolution !== undefined && resolution !== "dotenv" && resolution !== "service")
      throw new Error("--production-env-resolution must be dotenv or service");
    const result = await bootstrapManagedInstall({
      environment: process.env,
      productionEnvironmentResolution: resolution,
      legacyRoot: sourceRoot,
      installRoot,
      configuredPaths: {
        database: environment.values.FILESTATION_DB_PATH,
        storage: environment.values.FILESTATION_STORAGE_PATH,
        temp: environment.values.FILESTATION_TEMP_PATH,
      },
      overrides: {
        database:
          typeof values.database === "string" ? values.database : undefined,
        storage:
          typeof values.storage === "string" ? values.storage : undefined,
        temp: typeof values.temp === "string" ? values.temp : undefined,
      },
      relativePathPolicy: policy,
      acceptPathChange: values["accept-path-change"] === true,
      releaseVersion:
        typeof values["release-version"] === "string"
          ? values["release-version"]
          : undefined,
      oldPid: integer(values, "old-pid", 1, Number.MAX_SAFE_INTEGER),
      oldBootIdentity: required(values, "old-boot-identity"),
      oldProcessCreatedAt: required(values, "old-process-created-at"),
      servicePort:
        values["service-port"] === undefined
          ? undefined
          : integer(values, "service-port", 1, 65535),
      identityProvider:
        dependencies.identityProvider ?? new PlatformBootIdentityProvider(),
      snapshotDatabase: ({ database, output }) =>
        runServerSnapshot(sourceRoot, database, output),
      dryRun: values["dry-run"] === true,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  const installRoot = path.resolve(
    typeof values.root === "string" ? values.root : process.cwd(),
  );
  if (command === "status") {
    const result = await inspectManagedUpdate(installRoot);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "recover") {
    const result = await recoverManagedUpdate(installRoot);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  const environment = await loadInstallEnvironment(installRoot);
  const metadata = await loadManagedInstallMetadata(installRoot);
  const currentRealpath = await import("node:fs/promises").then(({ realpath }) =>
    realpath(metadata.currentPath),
  );
  const executableRealpath = await import("node:fs/promises").then(
    ({ realpath }) =>
      realpath(path.join(currentRealpath, "apps/server/dist/main.js")),
  );
  if (values["dry-run"] === true) {
    const plan = await validateManagedLaunchOnDisk({
      cwd: process.cwd(),
      executableRealpath,
      currentRealpath,
      installMetadata: metadata,
      environment: environment.values,
      processEnvironment: process.env,
      configuredPaths: {
        database: environment.values.FILESTATION_DB_PATH,
        storage: environment.values.FILESTATION_STORAGE_PATH,
        temp: environment.values.FILESTATION_TEMP_PATH,
      },
    });
    process.stdout.write(
      `${JSON.stringify({ state: "dry-run", plan }, null, 2)}\n`,
    );
    return 0;
  }
  await launchManagedInstall({
    root: installRoot,
    cwd: process.cwd(),
    currentRealpath,
    executableRealpath,
    metadata,
    importer: dependencies.importer,
  });
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const detail =
        process.env.FILESTATION_DEBUG === "1" && error instanceof Error
          ? error.stack ?? error.message
          : error instanceof Error
            ? error.message
            : "operation failed";
      process.stderr.write(`filestation-updater: ${detail}\n`);
      process.exitCode = 1;
    });
}
