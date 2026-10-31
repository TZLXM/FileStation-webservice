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
import {
  encodeInheritedCapability,
  readInheritedEnvelope,
} from "./update/capability";
import { createManagedUpdateOrchestrator } from "./update/orchestrator";
import { RetentionService } from "./update/retention";
import { acceptTerminalLaunch } from './update/terminal-launch';
import { OperatorRecoveryAuthority } from './update/operator-authority';
import { AttemptJournal } from './state/attempt-journal';

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
  filestation-updater recover --root <managed-root> --attempt <id> --expected-fence <fence>
  filestation-updater continue --attempt <id> --root <managed-root>
  filestation-updater cleanup --bootstrap-backup <exact-id> --root <managed-root>
  filestation-updater cleanup --acknowledge-diagnostic <exact-id> --root <managed-root>
    --attempt <id> --expected-fence <fence>

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
The CLI never prints .env values. Active recovery requires the protected OS
installation boundary, exact attempt/fence and proof that prior writers exited.
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

interface CloseableApplicationHandle {
  close?: () => Promise<void>;
  app?: {
    close?: () => Promise<void>;
  };
}

async function closeApplicationHandleAfterFailure(
  handle: CloseableApplicationHandle,
  originalError: unknown,
): Promise<boolean> {
  const close =
    typeof handle.close === "function"
      ? () => handle.close!()
      : typeof handle.app?.close === "function"
        ? () => handle.app!.close!()
        : undefined;
  if (!close) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(close),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('startup cleanup timed out')), 10_000); }),
    ]);
    return false;
  } catch (cleanupError) {
    if (originalError instanceof Error && originalError.cause === undefined) {
      try {
        Object.defineProperty(originalError, "cause", {
          configurable: true,
          value: cleanupError,
          writable: true,
        });
      } catch {
        // Cleanup diagnostics must not replace the original launch failure.
      }
    }
    return true;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  if (
    ![
      "bootstrap",
      "launch",
      "status",
      "recover",
      "continue",
      "cleanup",
    ].includes(command)
  ) {
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
      attempt: { type: "string" },
      "bootstrap-backup": { type: "string" },
      "expected-fence": {type:'string'},
      "inherited-launch": {type:'boolean'},
      "acknowledge-diagnostic": {type:'string'},
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
  if (command === "continue") {
    const attemptId = required(values, "attempt");
    const inherited = await readInheritedEnvelope(process.stdin);
    const authority = inherited.authority;
    const encoded = encodeInheritedCapability(authority);
    const handoffIdentity = encoded.toString("utf8");
    encoded.fill(0);
    const configuredPort =
      (await loadInstallEnvironment(installRoot, {processEnvironment:{...process.env,...inherited.runtime}})).values.FILESTATION_PORT;
    const servicePort =
      configuredPort && /^\d+$/.test(configuredPort)
        ? Number(configuredPort)
        : 8080;
    if (!Number.isSafeInteger(servicePort) || servicePort < 1 || servicePort > 65535) {
      throw new Error("FILESTATION_PORT must be a valid service port");
    }
    const orchestrator = createManagedUpdateOrchestrator({
      handoffIdentity,
      identity: dependencies.identityProvider,
      runtime: inherited.runtime,
    });
    const result = await orchestrator.run({
      attemptId,
      installRoot,
      handoffIdentity,
      servicePort,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "cleanup") {
    if(typeof values['acknowledge-diagnostic']==='string') {
      const snapshot=await AttemptJournal.inspect(installRoot);
      const authority=await OperatorRecoveryAuthority.authorize(installRoot,required(values,'attempt'),integer(values,'expected-fence',1,Number.MAX_SAFE_INTEGER));
      if(snapshot.pending || snapshot.attemptId!==values.attempt) throw new Error('diagnostic acknowledgment requires a quiescent matching attempt');
      const {acquireRecoveryGuard}=await import('./platform/recovery-guard');
      const guard=await acquireRecoveryGuard(path.join(installRoot,'update.recovery.guard'));
      try {const current=await AttemptJournal.inspect(installRoot);authority.assert(installRoot,current.attemptId!,current.fence);if(current.pending)throw new Error('attempt is active');await new RetentionService(installRoot).acknowledgeDiagnostic(values['acknowledge-diagnostic']);}
      finally {await guard.release();}
      return 0;
    }
    const backupId = required(values, "bootstrap-backup");
    const removed =
      await new RetentionService(installRoot).cleanupBootstrapRecoveryAssets(
        backupId,
      );
    process.stdout.write(
      `${JSON.stringify({ state: "cleaned", backupId, removed }, null, 2)}\n`,
    );
    return 0;
  }
  if (command === "status") {
    const result = await inspectManagedUpdate(installRoot);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "recover") {
    const snapshot=await AttemptJournal.inspectRecoverable(installRoot);
    if(snapshot.initialized) {
      const attemptId=required(values,'attempt');
      const authority=await OperatorRecoveryAuthority.authorize(installRoot,attemptId,integer(values,'expected-fence',1,Number.MAX_SAFE_INTEGER));
      const environment=await loadInstallEnvironment(installRoot);
      const port=Number(environment.values.FILESTATION_PORT ?? 8080);
      if(!Number.isSafeInteger(port)||port<1||port>65535) throw new Error('invalid recovery service port');
      const orchestrator=createManagedUpdateOrchestrator({handoffIdentity:'',operatorAuthority:authority,runtime:process.env,identity:dependencies.identityProvider});
      const result=await orchestrator.run({attemptId,installRoot,handoffIdentity:'',servicePort:port,recovery:true});
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    const result = await recoverManagedUpdate(installRoot);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  let inherited:Awaited<ReturnType<typeof readInheritedEnvelope>> | undefined;
  if(values['inherited-launch']===true) {
    if(!process.send) throw new Error('terminal launch requires inherited OS IPC');
    inherited=await readInheritedEnvelope(process.stdin);
    if(!inherited.launch) throw new Error('terminal launch claims absent');
    Object.assign(process.env,inherited.runtime);
    await acceptTerminalLaunch(installRoot,inherited.launch,inherited.authority);
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
  const launched=await launchManagedInstall({
    root: installRoot,
    cwd: process.cwd(),
    currentRealpath,
    executableRealpath,
    metadata,
    importer: dependencies.importer,
  });
  const imported=launched.imported as {bootstrap?:()=>Promise<{app?:{getHttpServer:()=>{listening:boolean};close?:()=>Promise<void>};restartHealth?:{version:string;release:string;health:string};reconcileUpdateAudit?:()=>Promise<void>;close?:()=>Promise<void>}>};
  if(typeof imported?.bootstrap==='function') {
    const handle=await imported.bootstrap();
    try {
      if(inherited) {
        if(!handle.app?.getHttpServer().listening || !handle.restartHealth || handle.restartHealth.health!=='ok') throw new Error('terminal startup health is not ready');
        const identity=new PlatformBootIdentityProvider();
        const proof={...handle.restartHealth,pid:process.pid,createdAt:await identity.processCreatedAt(process.pid),boot:(await identity.current()).value,attemptId:inherited.launch!.attemptId,fence:inherited.launch!.fence,nonce:inherited.launch!.nonce};
        process.send!({proof,receipt:inherited.authority.receipt(proof as never)});
        process.once('message',message=>{
          if((message as {event?:string}).event==='verification-durable') {
            // The normal app has already activated. A bounded, explicit callback
            // catches the verification event appended after initial reconciliation.
            void handle.reconcileUpdateAudit?.().catch(async error=>{
              const cleanupFailed=await closeApplicationHandleAfterFailure(handle,error);
              const detail=error instanceof Error?error.message:'operation failed';
              process.stderr.write(`filestation-updater: ${detail}\n`);
              process.exitCode=1;
              if(cleanupFailed && require.main === module) process.exit(1);
            });
          }
        });
      }
    } catch (error) {
      await closeApplicationHandleAfterFailure(handle, error);
      throw error;
    }
  } else if(inherited) throw new Error('stable launcher server has no bootstrap entry');
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
      process.exit(1);
    });
}
