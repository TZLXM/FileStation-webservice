"use strict";

const fs = require("node:fs");
const path = require("node:path");
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
  return launchManagedInstall(options);
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
    return main();
  })
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((error) => {
    const detail =
      error instanceof Error ? error.stack ?? error.message : String(error);
    fs.writeFileSync(diagnostic, `${detail}\n`);
    process.stderr.write(`terminal-cli fixture: ${detail}\n`);
    process.exitCode = 1;
  });
