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
const UPDATE_SYSTEM_GROUPS = {
  bootstrap: ["linuxX64", "windowsX64"],
  confirmedUpdate: ["linuxX64", "windowsX64"],
  rollbackBeforeCommit: ["linuxX64", "windowsX64"],
  docker: ["selfUpdateRefused"],
  nginx: ["root", "fsPrefix"],
};
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

function assertExactObject(value, expectedKeys, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }

  const unexpectedKeys = Object.keys(value).filter((key) => !expectedKeys.includes(key));
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

function validateCandidate(candidate) {
  assertExactObject(
    candidate,
    ["sourceCommit", "runId", "platformDigests"],
    "candidate",
  );
  assertExactObject(
    candidate.platformDigests,
    ["linux-x64", "windows-x64"],
    "candidate.platformDigests",
  );

  if (
    candidate.sourceCommit !== null &&
    (typeof candidate.sourceCommit !== "string" ||
      !SHA1_PATTERN.test(candidate.sourceCommit))
  ) {
    fail("candidate.sourceCommit must be a lowercase 40-character Git SHA");
  }

  if (
    candidate.runId !== null &&
    (typeof candidate.runId !== "string" || !RUN_ID_PATTERN.test(candidate.runId))
  ) {
    fail("candidate.runId must be a positive GitHub Actions run ID");
  }

  for (const platform of ["linux-x64", "windows-x64"]) {
    const digest = candidate.platformDigests[platform];
    if (
      digest !== null &&
      (typeof digest !== "string" || !SHA256_DIGEST_PATTERN.test(digest))
    ) {
      fail(
        `candidate.platformDigests.${platform} must be a sha256:<lowercase-hex> digest`,
      );
    }
  }
}

function validateManualRecord(record, field) {
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

  if (record.status !== "passed") {
    fail(`${field} is ${record.status}; release evidence must be passed`);
  }

  if (record.reference === null) {
    fail(`${field}.reference is required when the check is passed`);
  }
}

function validateManualEvidence(manual) {
  assertExactObject(manual, PHASE_2_MANUAL_CHECKS, "manual");
  for (const check of PHASE_2_MANUAL_CHECKS) {
    validateManualRecord(manual[check], `manual.${check}`);
  }
}

function validateUpdateSystem(updateSystem) {
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
      validateManualRecord(
        updateSystem[group][check],
        `updateSystem.${group}.${check}`,
      );
    }
  }
}

function validateCandidateDigests(candidate) {
  if (candidate.sourceCommit === null) {
    fail("candidate.sourceCommit is missing; record the exact candidate commit");
  }
  if (candidate.runId === null) {
    fail("candidate.runId is missing; record the candidate CI run");
  }
  for (const platform of ["linux-x64", "windows-x64"]) {
    if (candidate.platformDigests[platform] === null) {
      fail(
        `candidate.platformDigests.${platform} is missing; record the platform digest`,
      );
    }
  }
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
  validateManualEvidence(evidence.manual);

  if (requestedVersion === "0.2.5") {
    validateUpdateSystem(evidence.updateSystem);
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
  } catch (error) {
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
