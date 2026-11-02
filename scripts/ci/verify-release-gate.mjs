import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/;
const PHASE_2_MANUAL_CHECKS = [
  "viewport375px",
  "totpRecovery",
  "resumeAfterRefresh",
];
const V025_MANUAL_CHECKS = [
  ...PHASE_2_MANUAL_CHECKS,
  "viewport375pxUploadSuccessPrompt",
];
const UPDATE_SYSTEM_GROUPS = {
  bootstrap: ["linuxX64", "windowsX64"],
  confirmedUpdate: ["linuxX64", "windowsX64"],
  rollbackBeforeCommit: ["linuxX64", "windowsX64"],
  docker: ["selfUpdateRefused"],
  nginx: ["root", "fsPrefix"],
};
const FIRST_RELEASE_EXCEPTION_VERSION = "0.2.5";
const FIRST_RELEASE_EXCEPTION_CHECKS = [
  "updateSystem.bootstrap.linuxX64",
  "updateSystem.confirmedUpdate.linuxX64",
  "updateSystem.confirmedUpdate.windowsX64",
  "updateSystem.rollbackBeforeCommit.linuxX64",
  "updateSystem.rollbackBeforeCommit.windowsX64",
  "manual.viewport375pxUploadSuccessPrompt",
];
const SUPPORTED_VERSIONS = new Set(["0.2.0", "0.2.5"]);
const EVIDENCE_STATUSES = new Set(["passed", "failed", "pending"]);

class ReleaseGateError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseGateError";
  }
}

function fail(message) {
  throw new ReleaseGateError(message);
}

function assertExactObject(value, expectedKeys, field, optionalKeys = []) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }

  const allowedKeys = new Set([...expectedKeys, ...optionalKeys]);
  const unexpectedKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpectedKeys.length > 0) {
    fail(
      `${field} contains unknown field(s): ${unexpectedKeys
        .map((key) => `${field}.${key}`)
        .join(", ")}`,
    );
  }

  const missingKeys = expectedKeys.filter((key) => !Object.hasOwn(value, key));
  if (missingKeys.length > 0) {
    fail(
      `${field} is missing required field(s): ${missingKeys
        .map((key) => `${field}.${key}`)
        .join(", ")}`,
    );
  }
}

function findDuplicateJsonFields(rawValue) {
  let index = 0;
  const duplicateFields = [];

  function skipWhitespace() {
    while (index < rawValue.length && /\s/.test(rawValue[index])) {
      index += 1;
    }
  }

  function parseString() {
    const start = index;
    index += 1;
    while (index < rawValue.length) {
      if (rawValue[index] === "\\") {
        index += 2;
      } else if (rawValue[index] === '"') {
        index += 1;
        return JSON.parse(rawValue.slice(start, index));
      } else {
        index += 1;
      }
    }
    throw new Error("unterminated JSON string");
  }

  function parseValue(field) {
    skipWhitespace();
    if (rawValue[index] === "{") {
      parseObject(field);
      return;
    }
    if (rawValue[index] === "[") {
      parseArray(field);
      return;
    }
    if (rawValue[index] === '"') {
      parseString();
      return;
    }
    while (
      index < rawValue.length &&
      !/[\s,\]}]/.test(rawValue[index])
    ) {
      index += 1;
    }
  }

  function parseObject(field) {
    index += 1;
    skipWhitespace();
    if (rawValue[index] === "}") {
      index += 1;
      return;
    }

    const keys = new Set();
    while (index < rawValue.length) {
      skipWhitespace();
      const key = parseString();
      const keyField = `${field}.${key}`;
      if (keys.has(key)) {
        duplicateFields.push(keyField);
      }
      keys.add(key);

      skipWhitespace();
      index += 1;
      parseValue(keyField);
      skipWhitespace();
      if (rawValue[index] === ",") {
        index += 1;
        continue;
      }
      if (rawValue[index] === "}") {
        index += 1;
        return;
      }
    }
  }

  function parseArray(field) {
    index += 1;
    skipWhitespace();
    if (rawValue[index] === "]") {
      index += 1;
      return;
    }

    let itemIndex = 0;
    while (index < rawValue.length) {
      parseValue(`${field}[${itemIndex}]`);
      itemIndex += 1;
      skipWhitespace();
      if (rawValue[index] === ",") {
        index += 1;
        continue;
      }
      if (rawValue[index] === "]") {
        index += 1;
        return;
      }
    }
  }

  parseValue("evidence");
  skipWhitespace();
  if (index !== rawValue.length) {
    throw new Error("unexpected trailing JSON content");
  }

  return duplicateFields;
}

function validateCandidate(candidate, field = "candidate") {
  assertExactObject(
    candidate,
    ["sourceCommit", "runId", "platformDigests"],
    field,
  );
  assertExactObject(
    candidate.platformDigests,
    ["linux-x64", "windows-x64"],
    `${field}.platformDigests`,
  );

  if (
    candidate.sourceCommit !== null &&
    (typeof candidate.sourceCommit !== "string" ||
      !SHA1_PATTERN.test(candidate.sourceCommit))
  ) {
    fail(`${field}.sourceCommit must be a lowercase 40-character Git SHA`);
  }

  if (
    candidate.runId !== null &&
    (typeof candidate.runId !== "string" || !RUN_ID_PATTERN.test(candidate.runId))
  ) {
    fail(`${field}.runId must be a positive GitHub Actions run ID`);
  }

  for (const platform of ["linux-x64", "windows-x64"]) {
    const digest = candidate.platformDigests[platform];
    if (
      digest !== null &&
      (typeof digest !== "string" || !SHA256_DIGEST_PATTERN.test(digest))
    ) {
      fail(
        `${field}.platformDigests.${platform} must be a sha256:<lowercase-hex> digest`,
      );
    }
  }
}

function validateManualRecord(record, field, deferred = false) {
  assertExactObject(record, ["status", "reference"], field);

  if (!EVIDENCE_STATUSES.has(record.status)) {
    fail(`${field}.status must be passed, failed, or pending`);
  }

  if (
    record.reference !== null &&
    (typeof record.reference !== "string" || record.reference.trim() === "")
  ) {
    fail(`${field}.reference must be a non-empty string or null`);
  }

  if (record.status === "failed") {
    fail(`${field} is ${record.status}; release evidence must be passed`);
  }

  if (record.status === "pending" && !deferred) {
    fail(`${field} is ${record.status}; release evidence must be passed`);
  }
  if (record.status === "passed" && deferred) {
    fail(`${field} must be pending while listed in firstReleaseException`);
  }

  if (record.status === "passed" && record.reference === null) {
    fail(`${field}.reference is required when the check is passed`);
  }
}

function validateManualEvidence(manual, requestedVersion, deferredChecks) {
  const checks = requestedVersion === "0.2.5"
    ? V025_MANUAL_CHECKS
    : PHASE_2_MANUAL_CHECKS;
  assertExactObject(manual, checks, "manual");
  for (const check of checks) {
    const field = `manual.${check}`;
    validateManualRecord(manual[check], field, deferredChecks.has(field));
  }
}

function validateUpdateSystem(updateSystem, deferredChecks) {
  assertExactObject(
    updateSystem,
    Object.keys(UPDATE_SYSTEM_GROUPS),
    "updateSystem",
  );
  for (const [group, checks] of Object.entries(UPDATE_SYSTEM_GROUPS)) {
    assertExactObject(
      updateSystem[group],
      checks,
      `updateSystem.${group}`,
    );
    for (const check of checks) {
      const field = `updateSystem.${group}.${check}`;
      validateManualRecord(
        updateSystem[group][check],
        field,
        deferredChecks.has(field),
      );
    }
  }
}

function validateCandidateDigests(candidate, field = "candidate") {
  if (candidate.sourceCommit === null) {
    fail(`${field}.sourceCommit is missing; record the exact candidate commit`);
  }
  if (candidate.runId === null) {
    fail(`${field}.runId is missing; record the candidate CI run`);
  }
  for (const platform of ["linux-x64", "windows-x64"]) {
    if (candidate.platformDigests[platform] === null) {
      fail(
        `${field}.platformDigests.${platform} is missing; record the platform digest`,
      );
    }
  }
}

function validateNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${field} must be a non-empty string`);
  }
}

function validateFirstReleaseException(exception, evidence) {
  const field = "firstReleaseException";
  assertExactObject(
    exception,
    ["version", "approvalReference", "candidate", "deferrals"],
    field,
  );

  if (exception.version !== FIRST_RELEASE_EXCEPTION_VERSION) {
    fail(
      `${field}.version must be exactly ${FIRST_RELEASE_EXCEPTION_VERSION}`,
    );
  }
  validateNonEmptyString(
    exception.approvalReference,
    `${field}.approvalReference`,
  );

  validateCandidate(exception.candidate, `${field}.candidate`);
  validateCandidateDigests(exception.candidate, `${field}.candidate`);
  for (const candidateField of ["sourceCommit", "runId"]) {
    if (exception.candidate[candidateField] !== evidence.candidate[candidateField]) {
      fail(
        `${field}.candidate.${candidateField} does not match evidence.candidate.${candidateField}`,
      );
    }
  }
  for (const platform of ["linux-x64", "windows-x64"]) {
    if (
      exception.candidate.platformDigests[platform] !==
      evidence.candidate.platformDigests[platform]
    ) {
      fail(
        `${field}.candidate.platformDigests.${platform} does not match evidence.candidate.platformDigests.${platform}`,
      );
    }
  }

  if (!Array.isArray(exception.deferrals)) {
    fail(`${field}.deferrals must be an array`);
  }
  if (exception.deferrals.length === 0) {
    fail(`${field}.deferrals must contain at least one approved check`);
  }

  const approvedChecks = new Set(FIRST_RELEASE_EXCEPTION_CHECKS);
  const deferredChecks = new Set();
  exception.deferrals.forEach((deferral, deferralIndex) => {
    const deferralField = `${field}.deferrals.${deferralIndex}`;
    assertExactObject(
      deferral,
      ["check", "reason", "risk", "closureCondition"],
      deferralField,
    );

    if (!approvedChecks.has(deferral.check)) {
      fail(`${deferralField}.check is not an approved first-release exception`);
    }
    if (deferredChecks.has(deferral.check)) {
      fail(`${deferralField}.check duplicates ${deferral.check}`);
    }
    deferredChecks.add(deferral.check);

    for (const property of ["reason", "risk", "closureCondition"]) {
      validateNonEmptyString(
        deferral[property],
        `${deferralField}.${property}`,
      );
    }
  });

  return deferredChecks;
}

function validateEvidence(evidence, requestedVersion) {
  assertExactObject(
    evidence,
    [
      "schemaVersion",
      "version",
      "candidate",
      "manual",
      "knownRisks",
      "notes",
      ...(requestedVersion === "0.2.5" ? ["updateSystem"] : []),
    ],
    "evidence",
    requestedVersion === "0.2.5" ? ["firstReleaseException"] : [],
  );

  if (evidence.schemaVersion !== 1) {
    fail(`schemaVersion ${JSON.stringify(evidence.schemaVersion)} is unsupported`);
  }
  if (evidence.version !== requestedVersion) {
    fail(
      `evidence.version ${JSON.stringify(evidence.version)} does not match requested version ${requestedVersion}`,
    );
  }

  validateCandidate(evidence.candidate);
  validateCandidateDigests(evidence.candidate);
  const deferredChecks = requestedVersion === "0.2.5"
    && Object.hasOwn(evidence, "firstReleaseException")
      ? validateFirstReleaseException(evidence.firstReleaseException, evidence)
      : new Set();
  validateManualEvidence(evidence.manual, requestedVersion, deferredChecks);

  if (requestedVersion === "0.2.5") {
    validateUpdateSystem(evidence.updateSystem, deferredChecks);
  }

  if (
    !Array.isArray(evidence.knownRisks) ||
    evidence.knownRisks.some(
      (risk) => typeof risk !== "string" || risk.trim() === "",
    )
  ) {
    fail("knownRisks must be an array of non-empty strings");
  }
  if (typeof evidence.notes !== "string") {
    fail("notes must be a string");
  }

  return evidence;
}

export async function verifyReleaseGate({
  version,
  evidenceDirectory = path.join(REPOSITORY_ROOT, "release-evidence"),
}) {
  if (!SUPPORTED_VERSIONS.has(version)) {
    fail(`unknown release version ${JSON.stringify(version)}`);
  }

  const evidencePath = path.join(evidenceDirectory, `v${version}.json`);
  let rawEvidence;
  try {
    rawEvidence = await readFile(evidencePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      fail(`release evidence is missing: ${evidencePath}`);
    }
    throw error;
  }

  let evidence;
  try {
    evidence = JSON.parse(rawEvidence);
    const duplicateFields = findDuplicateJsonFields(rawEvidence);
    if (duplicateFields.length > 0) {
      fail(`JSON contains duplicate field: ${duplicateFields[0]}`);
    }
  } catch (error) {
    if (error instanceof ReleaseGateError) {
      throw error;
    }
    fail(`release evidence is not valid JSON: ${error.message}`);
  }

  validateEvidence(evidence, version);
  return { version, evidencePath };
}

function parseArguments(arguments_) {
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--version" ||
    !arguments_[1] ||
    arguments_[1].startsWith("-")
  ) {
    fail("usage: npm run verify:release-gate -- --version <semver>");
  }

  return arguments_[1];
}

async function main() {
  try {
    const version = parseArguments(process.argv.slice(2));
    const result = await verifyReleaseGate({ version });
    console.log(
      `Release gate passed for ${result.version}: ${path.relative(REPOSITORY_ROOT, result.evidencePath)}`,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown release-gate error";
    console.error(`Release gate failed: ${message}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
