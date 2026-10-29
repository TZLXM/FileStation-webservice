"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const startedAt = performance.now();
const timingFile = path.join(process.cwd(), "fixture-terminal-timing.jsonl");
function timing(event, extra = {}) {
  // Observation must never alter startup, a native query's result/rejection,
  // proof IPC, or the existing terminal error handler.
  try {
    fs.appendFileSync(timingFile, `${JSON.stringify({ event, elapsedMs: Math.round(performance.now() - startedAt), ...extra })}\n`);
  } catch {
    // Best effort only, including record construction and diagnostic I/O.
  }
}
timing("process-start");
const diagnostic = path.join(process.cwd(), "fixture-terminal-error.txt");
const environmentDiagnostic = path.join(
  process.cwd(),
  "fixture-terminal-environment.json",
);
fs.writeFileSync(
  environmentDiagnostic,
  `${JSON.stringify({
    cwd: process.cwd(),
    nodeEnv: process.env.NODE_ENV ?? null,
    jwtSecretPresent: Boolean(process.env.JWT_SECRET),
    dotenvPresent: fs.existsSync(path.join(process.cwd(), ".env")),
    metadataPresent: fs.existsSync(
      path.join(process.cwd(), "managed-install.json"),
    ),
  })}\n`,
);

const cliPath = __CLI_PATH__;
const capability = require(path.join(path.dirname(cliPath), "update/capability.js"));
const readInheritedEnvelope = capability.readInheritedEnvelope;
capability.readInheritedEnvelope = async function (...args) {
  const result = await readInheritedEnvelope.apply(this, args);
  timing("inherited-envelope", { remainingBudgetMs: result.launch?.expiresAt - Date.now() });
  return result;
};
// Observe the real native provider, without replacing queries, values, clocks,
// proof checks or IPC. Only operation names/durations are persisted, never claims.
const { PlatformBootIdentityProvider } = require(path.join(path.dirname(cliPath), "state/boot-identity.js"));
for (const operation of ["current", "processCreatedAt", "listeningPid"]) {
  const original = PlatformBootIdentityProvider.prototype[operation];
  PlatformBootIdentityProvider.prototype[operation] = async function (...args) {
    const start = performance.now();
    try { return await original.apply(this, args); }
    finally { timing(`identity:${operation}`, { durationMs: Math.round(performance.now() - start) }); }
  };
}
const send = process.send;
if (send) process.send = function (message, ...args) {
  if (message?.proof) timing("proof-send");
  return send.call(this, message, ...args);
};
const launcher = require(
  path.join(path.dirname(cliPath), "launcher.js"),
);
const { loadInstallEnvironment } = launcher;
const validateManagedDataOnDisk = launcher.validateManagedDataOnDisk;
const launchManagedInstall = launcher.launchManagedInstall;
launcher.validateManagedDataOnDisk = async (input) => {
  fs.writeFileSync(
    path.join(process.cwd(), "fixture-terminal-validation-input.json"),
    `${JSON.stringify({
      effectiveNodeEnv: input.environment?.NODE_ENV ?? null,
      effectiveJwtSecretPresent: Boolean(input.environment?.JWT_SECRET),
      invocationNodeEnv: input.processEnvironment?.NODE_ENV ?? null,
      invocationJwtSecretPresent: Boolean(input.processEnvironment?.JWT_SECRET),
      metadataSource: input.installMetadata?.productionEnvironment?.source ?? null,
    })}\n`,
  );
  return validateManagedDataOnDisk(input);
};
launcher.launchManagedInstall = async (options) => {
  timing("launch-managed-enter");
  const loaded = await loadInstallEnvironment(options.root, {
    processEnvironment: options.processEnvironment ?? process.env,
  });
  fs.writeFileSync(
    path.join(process.cwd(), "fixture-terminal-launch-input.json"),
    `${JSON.stringify({
      processNodeEnv: process.env.NODE_ENV ?? null,
      processJwtSecretPresent: Boolean(process.env.JWT_SECRET),
      loadedNodeEnv: loaded.values.NODE_ENV ?? null,
      loadedJwtSecretPresent: Boolean(loaded.values.JWT_SECRET),
      optionsCwd: options.cwd ?? null,
      processCwd: process.cwd(),
    })}\n`,
  );
  const result = await launchManagedInstall(options);
  timing("launch-managed-imported");
  return result;
};
const { main } = require(cliPath);

loadInstallEnvironment(process.cwd())
  .then((loaded) => {
    fs.writeFileSync(
      path.join(process.cwd(), "fixture-terminal-loaded-environment.json"),
      `${JSON.stringify({
        nodeEnv: loaded.values.NODE_ENV ?? null,
        jwtSecretPresent: Boolean(loaded.values.JWT_SECRET),
        databaseAbsolute:
          typeof loaded.values.FILESTATION_DB_PATH === "string" &&
          path.isAbsolute(loaded.values.FILESTATION_DB_PATH),
        storageAbsolute:
          typeof loaded.values.FILESTATION_STORAGE_PATH === "string" &&
          path.isAbsolute(loaded.values.FILESTATION_STORAGE_PATH),
        tempAbsolute:
          typeof loaded.values.FILESTATION_TEMP_PATH === "string" &&
          path.isAbsolute(loaded.values.FILESTATION_TEMP_PATH),
      })}\n`,
    );
    timing("main-enter");
    return main();
  })
  .then((code) => {
    timing("main-complete", { code });
    if (code !== 0) process.exitCode = code;
  })
  .catch((error) => {
    timing("main-error");
    const detail =
      error instanceof Error ? error.stack ?? error.message : String(error);
    fs.writeFileSync(diagnostic, `${detail}\n`);
    process.stderr.write(`terminal-cli fixture: ${detail}\n`);
    process.exitCode = 1;
  });
