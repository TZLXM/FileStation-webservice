import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { verifyReleaseGate } from "./verify-release-gate.mjs";

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "filestation-release-gate-"));

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const linuxDigest = `sha256:${"1".repeat(64)}`;
const windowsDigest = `sha256:${"2".repeat(64)}`;
const FIRST_RELEASE_DEFERRALS = [
  {
    check: "updateSystem.bootstrap.linuxX64",
    reason: "No persistent Linux x64 host is available before the first release.",
    risk: "First-release bootstrap on Linux x64 remains unproven.",
    closureCondition: "Complete bootstrap acceptance on a persistent Linux x64 host.",
  },
  {
    check: "updateSystem.confirmedUpdate.linuxX64",
    reason: "No persistent Linux x64 installation is available before the first release.",
    risk: "Confirmed update behavior on Linux x64 remains unproven.",
    closureCondition: "Complete a confirmed update acceptance run on Linux x64.",
  },
  {
    check: "updateSystem.confirmedUpdate.windowsX64",
    reason: "The first hosted release candidate cannot complete real update acceptance.",
    risk: "Confirmed update behavior on Windows x64 remains unproven.",
    closureCondition: "Complete a confirmed update acceptance run on Windows x64.",
  },
  {
    check: "updateSystem.rollbackBeforeCommit.linuxX64",
    reason: "No persistent Linux x64 installation is available before the first release.",
    risk: "Pre-commit rollback behavior on Linux x64 remains unproven.",
    closureCondition: "Complete a pre-commit rollback acceptance run on Linux x64.",
  },
  {
    check: "updateSystem.rollbackBeforeCommit.windowsX64",
    reason: "The first hosted release candidate cannot complete real rollback acceptance.",
    risk: "Pre-commit rollback behavior on Windows x64 remains unproven.",
    closureCondition: "Complete a pre-commit rollback acceptance run on Windows x64.",
  },
  {
    check: "manual.viewport375pxUploadSuccessPrompt",
    reason: "The approved first release prioritizes publishing before this prompt is tested.",
    risk: "The 375px upload success prompt may remain visually unverified after release.",
    closureCondition: "Verify the successful-upload prompt in a real 375px browser session.",
  },
];
const FIRST_RELEASE_EXCEPTION_ORIGINAL_CHECKS = [
  "updateSystem.bootstrap.linuxX64",
  "updateSystem.confirmedUpdate.linuxX64",
  "updateSystem.confirmedUpdate.windowsX64",
  "updateSystem.rollbackBeforeCommit.linuxX64",
  "updateSystem.rollbackBeforeCommit.windowsX64",
];

function passed(reference) {
  return { status: "passed", reference };
}

function pending() {
  return { status: "pending", reference: null };
}

function updateRecord(evidence, check) {
  return check
    .split(".")
    .reduce((value, part) => value[part], evidence);
}

function setUpdateCheck(evidence, check, record) {
  const parts = check.split(".");
  updateRecord(evidence, parts.slice(0, -1).join("."))[parts.at(-1)] = record;
}

function validEvidence(version = "0.2.0") {
  const evidence = {
    schemaVersion: 1,
    version,
    candidate: {
      sourceCommit,
      runId: "123456789",
      platformDigests: {
        "linux-x64": linuxDigest,
        "windows-x64": windowsDigest,
      },
    },
    manual: {
      viewport375px: passed("manual/375px"),
      totpRecovery: passed("manual/totp-recovery"),
      resumeAfterRefresh: passed("manual/resume-after-refresh"),
      ...(version === "0.2.5"
        ? {
            viewport375pxUploadSuccessPrompt: passed(
              "manual/375px-upload-success-prompt",
            ),
          }
        : {}),
    },
    knownRisks: ["moderate/low dependency advisories accepted in CURRENT-STATE"],
    notes: "Structured evidence only; Pending prose is intentionally ignored.",
  };

  if (version === "0.2.5") {
    evidence.updateSystem = {
      bootstrap: {
        linuxX64: passed("manual/bootstrap-linux-x64"),
        windowsX64: passed("manual/bootstrap-windows-x64"),
      },
      confirmedUpdate: {
        linuxX64: passed("manual/update-linux-x64"),
        windowsX64: passed("manual/update-windows-x64"),
      },
      rollbackBeforeCommit: {
        linuxX64: passed("manual/rollback-linux-x64"),
        windowsX64: passed("manual/rollback-windows-x64"),
      },
      docker: {
        selfUpdateRefused: passed("manual/docker-self-update-refused"),
      },
      nginx: {
        root: passed("manual/nginx-root"),
        fsPrefix: passed("manual/nginx-fs-prefix"),
      },
    };
  }

  return evidence;
}

function validFirstReleaseException(evidence) {
  return {
    version: "0.2.5",
    approvalReference: "release-approval/first-v0.2.5",
    candidate: structuredClone(evidence.candidate),
    deferrals: structuredClone(FIRST_RELEASE_DEFERRALS),
  };
}

function firstReleaseExceptionEvidenceFor(deferrals) {
  const evidence = validEvidence("0.2.5");
  for (const { check } of deferrals) {
    setUpdateCheck(evidence, check, pending());
  }
  evidence.firstReleaseException = {
    ...validFirstReleaseException(evidence),
    deferrals: structuredClone(deferrals),
  };
  return evidence;
}

function firstReleaseExceptionEvidence() {
  return firstReleaseExceptionEvidenceFor(FIRST_RELEASE_DEFERRALS);
}

async function verifyRawFixture(version, rawEvidence) {
  const evidenceDirectory = path.join(fixtureRoot, `${version}-${crypto.randomUUID()}`);
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    path.join(evidenceDirectory, `v${version}.json`),
    rawEvidence,
    "utf8",
  );
  return verifyReleaseGate({ version, evidenceDirectory });
}

async function verifyFixture(version, evidence) {
  return verifyRawFixture(
    version,
    evidenceJson(evidence),
  );
}

function evidenceJson(evidence) {
  return `${JSON.stringify(evidence, null, 2)}\n`;
}

function replaceOnce(value, search, replacement) {
  const replaced = value.replace(search, replacement);
  assert.notEqual(replaced, value, `fixture marker not found: ${search}`);
  return replaced;
}

test("accepts complete v0.2.0 evidence and preserves accepted risks", async () => {
  const result = await verifyFixture("0.2.0", validEvidence());

  assert.equal(result.version, "0.2.0");
});

test("rejects v0.2.0 without candidate source provenance", async () => {
  const evidence = validEvidence();
  delete evidence.candidate.sourceCommit;

  await assert.rejects(verifyFixture("0.2.0", evidence), /sourceCommit/);
});

test("rejects v0.2.0 without a candidate platform digest", async () => {
  const evidence = validEvidence();
  delete evidence.candidate.platformDigests["windows-x64"];

  await assert.rejects(verifyFixture("0.2.0", evidence), /platformDigests\.windows-x64/);
});

for (const manualCheck of ["viewport375px", "totpRecovery", "resumeAfterRefresh"]) {
  test(`rejects v0.2.0 when ${manualCheck} is not passed`, async () => {
    const evidence = validEvidence();
    evidence.manual[manualCheck] = pending();

    await assert.rejects(verifyFixture("0.2.0", evidence), new RegExp(manualCheck));
  });
}

test("requires v0.2.5 update evidence instead of accepting Phase 2 fields alone", async () => {
  const evidence = validEvidence("0.2.5");
  delete evidence.updateSystem;

  await assert.rejects(verifyFixture("0.2.5", evidence), /updateSystem/);
});

test("rejects v0.2.5 when a platform update check is pending", async () => {
  const evidence = validEvidence("0.2.5");
  evidence.updateSystem.confirmedUpdate.windowsX64 = pending();

  await assert.rejects(
    verifyFixture("0.2.5", evidence),
    /confirmedUpdate\.windowsX64/,
  );
});

test("accepts complete v0.2.5 evidence", async () => {
  const result = await verifyFixture("0.2.5", validEvidence("0.2.5"));

  assert.equal(result.version, "0.2.5");
});

test("accepts exact v0.2.5 first-release exceptions for only the approved pending checks", async () => {
  const result = await verifyFixture("0.2.5", firstReleaseExceptionEvidence());

  assert.equal(result.version, "0.2.5");
});

test("accepts a prompt-only first-release deferral when the original five checks passed", async () => {
  const promptDeferral = FIRST_RELEASE_DEFERRALS.filter(
    ({ check }) => check === "manual.viewport375pxUploadSuccessPrompt",
  );
  const evidence = firstReleaseExceptionEvidenceFor(promptDeferral);
  const result = await verifyFixture("0.2.5", evidence);

  assert.equal(result.version, "0.2.5");
  assert.equal(evidence.firstReleaseException.deferrals.length, 1);
  for (const check of FIRST_RELEASE_EXCEPTION_ORIGINAL_CHECKS) {
    assert.equal(updateRecord(evidence, check).status, "passed");
  }
});

test("accepts the original five deferrals when the prompt check passed", async () => {
  const originalFive = FIRST_RELEASE_DEFERRALS.filter(
    ({ check }) => check !== "manual.viewport375pxUploadSuccessPrompt",
  );
  const evidence = firstReleaseExceptionEvidenceFor(originalFive);
  const result = await verifyFixture("0.2.5", evidence);

  assert.equal(result.version, "0.2.5");
  assert.equal(evidence.firstReleaseException.deferrals.length, 5);
  assert.equal(
    evidence.manual.viewport375pxUploadSuccessPrompt.status,
    "passed",
  );
});

test("rejects an empty first-release exception deferral set", async () => {
  const evidence = firstReleaseExceptionEvidenceFor([]);

  await assert.rejects(
    verifyFixture("0.2.5", evidence),
    /deferrals must contain at least one approved check/,
  );
});

test("rejects a failed check even when it appears in the first-release exception", async () => {
  const evidence = firstReleaseExceptionEvidence();
  setUpdateCheck(
    evidence,
    "updateSystem.rollbackBeforeCommit.windowsX64",
    { status: "failed", reference: "manual/failed" },
  );

  await assert.rejects(
    verifyFixture("0.2.5", evidence),
    /updateSystem\.rollbackBeforeCommit\.windowsX64 is failed/,
  );
});

test("rejects a passed check listed as a first-release exception", async () => {
  const evidence = firstReleaseExceptionEvidence();
  setUpdateCheck(
    evidence,
    "updateSystem.bootstrap.linuxX64",
    passed("manual/bootstrap-linux-x64"),
  );

  await assert.rejects(
    verifyFixture("0.2.5", evidence),
    /updateSystem\.bootstrap\.linuxX64 must be pending/,
  );
});

test("rejects a pending update check outside the first-release exception whitelist", async () => {
  const evidence = firstReleaseExceptionEvidence();
  setUpdateCheck(evidence, "updateSystem.docker.selfUpdateRefused", pending());

  await assert.rejects(
    verifyFixture("0.2.5", evidence),
    /updateSystem\.docker\.selfUpdateRefused is pending/,
  );
});

test("rejects v0.2.5 without the upload-success-prompt manual field", async () => {
  const evidence = validEvidence("0.2.5");
  delete evidence.manual.viewport375pxUploadSuccessPrompt;

  await assert.rejects(
    verifyFixture("0.2.5", evidence),
    /manual\.viewport375pxUploadSuccessPrompt/,
  );
});

test("rejects a pending upload-success-prompt check without the first-release exception", async () => {
  const evidence = validEvidence("0.2.5");
  evidence.manual.viewport375pxUploadSuccessPrompt = pending();

  await assert.rejects(
    verifyFixture("0.2.5", evidence),
    /manual\.viewport375pxUploadSuccessPrompt is pending/,
  );
});

test("rejects the upload-success-prompt field for v0.2.0", async () => {
  const evidence = validEvidence();
  evidence.manual.viewport375pxUploadSuccessPrompt = passed(
    "manual/375px-upload-success-prompt",
  );

  await assert.rejects(
    verifyFixture("0.2.0", evidence),
    /manual\.viewport375pxUploadSuccessPrompt/,
  );
});

test("rejects other pending manual checks with the first-release exception", async () => {
  const evidence = firstReleaseExceptionEvidence();
  evidence.manual.viewport375px = pending();

  await assert.rejects(
    verifyFixture("0.2.5", evidence),
    /manual\.viewport375px is pending/,
  );
});

test("rejects a passed upload-success-prompt check listed as deferred", async () => {
  const evidence = firstReleaseExceptionEvidence();
  evidence.manual.viewport375pxUploadSuccessPrompt = passed(
    "manual/375px-upload-success-prompt",
  );

  await assert.rejects(
    verifyFixture("0.2.5", evidence),
    /manual\.viewport375pxUploadSuccessPrompt must be pending/,
  );
});

test("rejects a failed upload-success-prompt check even when deferred", async () => {
  const evidence = firstReleaseExceptionEvidence();
  evidence.manual.viewport375pxUploadSuccessPrompt = {
    status: "failed",
    reference: "manual/375px-upload-success-prompt-failed",
  };

  await assert.rejects(
    verifyFixture("0.2.5", evidence),
    /manual\.viewport375pxUploadSuccessPrompt is failed/,
  );
});

test("rejects the v0.2.5 first-release exception for another release version", async () => {
  const evidence = validEvidence("0.2.0");
  evidence.firstReleaseException = validFirstReleaseException(
    validEvidence("0.2.5"),
  );

  await assert.rejects(
    verifyFixture("0.2.0", evidence),
    /firstReleaseException/,
  );
});

test("rejects duplicate or unknown checks in the first-release exception", async () => {
  const duplicate = firstReleaseExceptionEvidence();
  duplicate.firstReleaseException.deferrals[1] = structuredClone(
    duplicate.firstReleaseException.deferrals[0],
  );
  await assert.rejects(
    verifyFixture("0.2.5", duplicate),
    /duplicate|deferrals/i,
  );

  const unknown = firstReleaseExceptionEvidence();
  unknown.firstReleaseException.deferrals[0].check = "updateSystem.docker.selfUpdateRefused";
  await assert.rejects(
    verifyFixture("0.2.5", unknown),
    /deferrals/,
  );
});

for (const property of ["reason", "risk", "closureCondition"]) {
  test(`rejects a first-release exception deferral without a valid ${property}`, async () => {
    const evidence = firstReleaseExceptionEvidence();
    evidence.firstReleaseException.deferrals[0][property] = "   ";

    await assert.rejects(
      verifyFixture("0.2.5", evidence),
      new RegExp(`deferrals\\.0\\.${property}`),
    );
  });
}

test("rejects unknown fields in the first-release exception and its deferrals", async () => {
  const exceptionUnknown = firstReleaseExceptionEvidence();
  exceptionUnknown.firstReleaseException.ticket = "unapproved";
  await assert.rejects(
    verifyFixture("0.2.5", exceptionUnknown),
    /firstReleaseException\.ticket/,
  );

  const deferralUnknown = firstReleaseExceptionEvidence();
  deferralUnknown.firstReleaseException.deferrals[0].owner = "unapproved";
  await assert.rejects(
    verifyFixture("0.2.5", deferralUnknown),
    /deferrals\.0\.owner/,
  );
});

test("rejects a first-release exception for a different exact version or without approval", async () => {
  const wrongVersion = firstReleaseExceptionEvidence();
  wrongVersion.firstReleaseException.version = "0.2.6";
  await assert.rejects(
    verifyFixture("0.2.5", wrongVersion),
    /firstReleaseException\.version/,
  );

  const missingApproval = firstReleaseExceptionEvidence();
  missingApproval.firstReleaseException.approvalReference = " ";
  await assert.rejects(
    verifyFixture("0.2.5", missingApproval),
    /firstReleaseException\.approvalReference/,
  );
});

for (const field of ["sourceCommit", "runId", "linux-x64", "windows-x64"]) {
  test(`rejects a first-release exception candidate change in ${field}`, async () => {
    const evidence = firstReleaseExceptionEvidence();
    const target = field.endsWith("-x64")
      ? evidence.firstReleaseException.candidate.platformDigests
      : evidence.firstReleaseException.candidate;
    const replacement = {
      sourceCommit: "fedcba9876543210fedcba9876543210fedcba98",
      runId: "987654321",
      "linux-x64": `sha256:${"3".repeat(64)}`,
      "windows-x64": `sha256:${"4".repeat(64)}`,
    }[field];
    target[field] = replacement;

    await assert.rejects(
      verifyFixture("0.2.5", evidence),
      new RegExp(`firstReleaseException\\.candidate.*${field}`),
    );
  });
}

for (const field of ["sourceCommit", "runId", "linux-x64", "windows-x64"]) {
  test(`rejects an incomplete first-release exception candidate ${field}`, async () => {
    const evidence = firstReleaseExceptionEvidence();
    const target = field.endsWith("-x64")
      ? evidence.firstReleaseException.candidate.platformDigests
      : evidence.firstReleaseException.candidate;
    target[field] = null;

    await assert.rejects(
      verifyFixture("0.2.5", evidence),
      new RegExp(field),
    );
  });
}

test("rejects duplicate JSON fields within the first-release exception", async () => {
  const evidence = firstReleaseExceptionEvidence();
  const rawEvidence = replaceOnce(
    evidenceJson(evidence),
    '"approvalReference": "release-approval/first-v0.2.5",',
    '"approvalReference": "release-approval/first-v0.2.5",\n    "approvalReference": "release-approval/replaced",',
  );

  await assert.rejects(
    verifyRawFixture("0.2.5", rawEvidence),
    /duplicate.*firstReleaseException\.approvalReference/i,
  );
});

const outerDuplicateCases = [
  {
    field: "candidate object",
    expectedPath: "evidence.candidate",
    search: '  "candidate": {',
    replacement: '  "candidate": {},\n  "candidate": {',
  },
  {
    field: "runId",
    expectedPath: "evidence.candidate.runId",
    search: '    "runId": "123456789",',
    replacement:
      '    "runId": "123456789",\n    "runId": "123456789",',
  },
  {
    field: "linux digest",
    expectedPath: "evidence.candidate.platformDigests.linux-x64",
    search: `      "linux-x64": "${linuxDigest}",`,
    replacement: `      "linux-x64": "${linuxDigest}",\n      "linux-x64": "${linuxDigest}",`,
  },
  {
    field: "windows digest",
    expectedPath: "evidence.candidate.platformDigests.windows-x64",
    search: `      "windows-x64": "${windowsDigest}"`,
    replacement: `      "windows-x64": "${windowsDigest}",\n      "windows-x64": "${windowsDigest}"`,
  },
];

for (const { field, expectedPath, search, replacement } of outerDuplicateCases) {
  test(`rejects duplicate outer ${field} when the v0.2.5 exception is enabled`, async () => {
    const rawEvidence = replaceOnce(
      evidenceJson(firstReleaseExceptionEvidence()),
      search,
      replacement,
    );

    await assert.rejects(
      verifyRawFixture("0.2.5", rawEvidence),
      new RegExp(`duplicate.*${expectedPath.replaceAll(".", "\\.")}`, "i"),
    );
  });
}

test("rejects failed then pending status duplication when the exception is enabled", async () => {
  const rawEvidence = replaceOnce(
    evidenceJson(firstReleaseExceptionEvidence()),
    '      "linuxX64": {\n        "status": "pending",',
    '      "linuxX64": {\n        "status": "failed",\n        "status": "pending",',
  );

  await assert.rejects(
    verifyRawFixture("0.2.5", rawEvidence),
    /duplicate.*updateSystem\.bootstrap\.linuxX64\.status/i,
  );
});

test("rejects a duplicate update check that hides a failed result", async () => {
  const rawEvidence = replaceOnce(
    evidenceJson(firstReleaseExceptionEvidence()),
    '      "linuxX64": {\n        "status": "pending",\n        "reference": null\n      },',
    '      "linuxX64": {\n        "status": "failed",\n        "reference": "manual/failed"\n      },\n      "linuxX64": {\n        "status": "pending",\n        "reference": null\n      },',
  );

  await assert.rejects(
    verifyRawFixture("0.2.5", rawEvidence),
    /duplicate.*updateSystem\.bootstrap\.linuxX64/i,
  );
});

test("rejects a duplicate top-level updateSystem that hides a failed result", async () => {
  const rawEvidence = replaceOnce(
    evidenceJson(firstReleaseExceptionEvidence()),
    '  "updateSystem": {',
    '  "updateSystem": {"bootstrap":{"linuxX64":{"status":"failed","reference":"manual/failed"}}},\n  "updateSystem": {',
  );

  await assert.rejects(
    verifyRawFixture("0.2.5", rawEvidence),
    /duplicate.*evidence\.updateSystem/i,
  );
});

test("rejects an escaped duplicate top-level exception that hides another record", async () => {
  const evidence = firstReleaseExceptionEvidence();
  const hiddenException = structuredClone(evidence.firstReleaseException);
  hiddenException.approvalReference = "release-approval/hidden";
  const rawEvidence = replaceOnce(
    evidenceJson(evidence),
    '  "firstReleaseException": {',
    `  "firstReleaseException": ${JSON.stringify(hiddenException)},\n  "\\u0066irstReleaseException": {`,
  );

  await assert.rejects(
    verifyRawFixture("0.2.5", rawEvidence),
    /duplicate.*evidence\.firstReleaseException/i,
  );
});

const ordinaryDuplicateCases = [
  {
    version: "0.2.0",
    field: "candidate object",
    expectedPath: "evidence.candidate",
    search: '  "candidate": {',
    replacement: '  "candidate": {},\n  "candidate": {',
  },
  {
    version: "0.2.0",
    field: "sourceCommit",
    expectedPath: "evidence.candidate.sourceCommit",
    search: `    "sourceCommit": "${sourceCommit}",`,
    replacement:
      `    "sourceCommit": "not-a-commit",\n    "sourceCommit": "${sourceCommit}",`,
  },
  {
    version: "0.2.0",
    field: "runId",
    expectedPath: "evidence.candidate.runId",
    search: '    "runId": "123456789",',
    replacement:
      '    "runId": "not-a-run",\n    "runId": "123456789",',
  },
  {
    version: "0.2.0",
    field: "linux digest",
    expectedPath: "evidence.candidate.platformDigests.linux-x64",
    search: `      "linux-x64": "${linuxDigest}",`,
    replacement:
      `      "linux-x64": "sha256:not-a-digest",\n      "linux-x64": "${linuxDigest}",`,
  },
  {
    version: "0.2.0",
    field: "windows digest",
    expectedPath: "evidence.candidate.platformDigests.windows-x64",
    search: `      "windows-x64": "${windowsDigest}"`,
    replacement:
      `      "windows-x64": "sha256:not-a-digest",\n      "windows-x64": "${windowsDigest}"`,
  },
  {
    version: "0.2.0",
    field: "manual status",
    expectedPath: "evidence.manual.viewport375px.status",
    search: '    "viewport375px": {\n      "status": "passed",',
    replacement:
      '    "viewport375px": {\n      "status": "failed",\n      "status": "passed",',
  },
  {
    version: "0.2.0",
    field: "escaped runId",
    expectedPath: "evidence.candidate.runId",
    search: '    "runId": "123456789",',
    replacement:
      '    "runId": "123456789",\n    "\\u0072unId": "987654321",',
  },
  {
    version: "0.2.5",
    field: "candidate object",
    expectedPath: "evidence.candidate",
    search: '  "candidate": {',
    replacement: '  "candidate": {},\n  "candidate": {',
  },
  {
    version: "0.2.5",
    field: "sourceCommit",
    expectedPath: "evidence.candidate.sourceCommit",
    search: `    "sourceCommit": "${sourceCommit}",`,
    replacement:
      `    "sourceCommit": "not-a-commit",\n    "sourceCommit": "${sourceCommit}",`,
  },
  {
    version: "0.2.5",
    field: "runId",
    expectedPath: "evidence.candidate.runId",
    search: '    "runId": "123456789",',
    replacement:
      '    "runId": "not-a-run",\n    "runId": "123456789",',
  },
  {
    version: "0.2.5",
    field: "linux digest",
    expectedPath: "evidence.candidate.platformDigests.linux-x64",
    search: `      "linux-x64": "${linuxDigest}",`,
    replacement:
      `      "linux-x64": "sha256:not-a-digest",\n      "linux-x64": "${linuxDigest}",`,
  },
  {
    version: "0.2.5",
    field: "windows digest",
    expectedPath: "evidence.candidate.platformDigests.windows-x64",
    search: `      "windows-x64": "${windowsDigest}"`,
    replacement:
      `      "windows-x64": "sha256:not-a-digest",\n      "windows-x64": "${windowsDigest}"`,
  },
  {
    version: "0.2.5",
    field: "update status",
    expectedPath: "evidence.updateSystem.bootstrap.linuxX64.status",
    search: '      "linuxX64": {\n        "status": "passed",',
    replacement:
      '      "linuxX64": {\n        "status": "failed",\n        "status": "passed",',
  },
  {
    version: "0.2.5",
    field: "escaped update status",
    expectedPath: "evidence.updateSystem.bootstrap.linuxX64.status",
    search:
      '      "linuxX64": {\n        "status": "passed",\n        "reference": "manual/bootstrap-linux-x64"',
    replacement:
      '      "linuxX64": {\n        "status": "failed",\n        "\\u0073tatus": "passed",\n        "reference": "manual/bootstrap-linux-x64"',
  },
];

for (const { version, field, expectedPath, search, replacement } of ordinaryDuplicateCases) {
  test(`rejects duplicate ${field} in ordinary v${version} evidence`, async () => {
    const rawEvidence = replaceOnce(
      evidenceJson(validEvidence(version)),
      search,
      replacement,
    );

    await assert.rejects(
      verifyRawFixture(version, rawEvidence),
      new RegExp(`duplicate.*${expectedPath.replaceAll(".", "\\.")}`, "i"),
    );
  });
}

test("rejects an unknown release version", async () => {
  await assert.rejects(verifyFixture("0.3.0", validEvidence("0.3.0")), /unknown release version/);
});

test("rejects an unknown schema version", async () => {
  const evidence = validEvidence();
  evidence.schemaVersion = 2;

  await assert.rejects(verifyFixture("0.2.0", evidence), /schemaVersion/);
});

test("rejects unknown top-level fields", async () => {
  const evidence = validEvidence();
  evidence.automatedFallback = { status: "passed" };

  await assert.rejects(verifyFixture("0.2.0", evidence), /automatedFallback/);
});

test("rejects unknown nested fields", async () => {
  const evidence = validEvidence();
  evidence.candidate.branch = "master";

  await assert.rejects(verifyFixture("0.2.0", evidence), /candidate\.branch/);
});

test("rejects an invalid source commit or platform digest", async () => {
  const evidence = validEvidence();
  evidence.candidate.platformDigests["linux-x64"] = "sha256:not-a-digest";

  await assert.rejects(verifyFixture("0.2.0", evidence), /linux-x64/);
});

// Exercise each version independently so version-specific validation cannot bypass provenance.
for (const version of ["0.2.0", "0.2.5"]) {
  for (const field of ["sourceCommit", "runId", "linux-x64", "windows-x64"]) {
    for (const missingKind of ["omitted", "null"]) {
      test(`rejects v${version} with ${missingKind} candidate ${field}`, async () => {
        const evidence = validEvidence(version);
        const target = field.endsWith("-x64")
          ? evidence.candidate.platformDigests
          : evidence.candidate;
        if (missingKind === "omitted") delete target[field];
        else target[field] = null;

        await assert.rejects(verifyFixture(version, evidence), (error) => {
          assert.ok(error.message.includes(field), error.message);
          return true;
        });
      });
    }
  }

  for (const [field, value] of [
    ["sourceCommit", "not-a-commit"],
    ["runId", "not-a-run"],
    ["linux-x64", "sha256:not-a-digest"],
    ["windows-x64", "sha256:not-a-digest"],
  ]) {
    test(`rejects v${version} with malformed candidate ${field}`, async () => {
      const evidence = validEvidence(version);
      const target = field.endsWith("-x64")
        ? evidence.candidate.platformDigests
        : evidence.candidate;
      target[field] = value;

      await assert.rejects(verifyFixture(version, evidence), (error) => {
        assert.ok(error.message.includes(field), error.message);
        return true;
      });
    });
  }

  const checks = [
    ["manual", "viewport375px"],
    ...(version === "0.2.5"
      ? [["manual", "viewport375pxUploadSuccessPrompt"]]
      : []),
    ["manual", "totpRecovery"],
    ["manual", "resumeAfterRefresh"],
    ...(version === "0.2.5"
      ? [
          ["updateSystem", "bootstrap.linuxX64"],
          ["updateSystem", "bootstrap.windowsX64"],
          ["updateSystem", "confirmedUpdate.linuxX64"],
          ["updateSystem", "confirmedUpdate.windowsX64"],
          ["updateSystem", "rollbackBeforeCommit.linuxX64"],
          ["updateSystem", "rollbackBeforeCommit.windowsX64"],
          ["updateSystem", "docker.selfUpdateRefused"],
          ["updateSystem", "nginx.root"],
          ["updateSystem", "nginx.fsPrefix"],
        ]
      : []),
  ];
  for (const [group, field] of checks) {
    test(`rejects v${version} when ${group}.${field} failed`, async () => {
      const evidence = validEvidence(version);
      const pathParts = field.split(".");
      const target = pathParts.reduce(
        (value, part) => value[part],
        evidence[group],
      );
      target.status = "failed";

      await assert.rejects(verifyFixture(version, evidence), (error) => {
        assert.ok(error.message.includes(`${group}.${field} is failed`), error.message);
        return true;
      });
    });
  }
}

test("v0.2.5 rejects every missing or malformed update-system check", async () => {
  const checks = [
    ["bootstrap", "linuxX64"],
    ["bootstrap", "windowsX64"],
    ["confirmedUpdate", "linuxX64"],
    ["confirmedUpdate", "windowsX64"],
    ["rollbackBeforeCommit", "linuxX64"],
    ["rollbackBeforeCommit", "windowsX64"],
    ["docker", "selfUpdateRefused"],
    ["nginx", "root"],
    ["nginx", "fsPrefix"],
  ];

  for (const [group, field] of checks) {
    const missing = validEvidence("0.2.5");
    delete missing.updateSystem[group][field];
    await assert.rejects(
      verifyFixture("0.2.5", missing),
      new RegExp(`updateSystem\\.${group}\\.${field}`),
    );

    const malformed = validEvidence("0.2.5");
    malformed.updateSystem[group][field] = {
      status: "passed",
      reference: "   ",
    };
    await assert.rejects(
      verifyFixture("0.2.5", malformed),
      new RegExp(`updateSystem\\.${group}\\.${field}`),
    );
  }
});

test("v0.2.0 retains its historical Phase 2 evidence schema", async () => {
  await assert.doesNotReject(verifyFixture("0.2.0", validEvidence("0.2.0")));

  const evidence = validEvidence("0.2.0");
  evidence.updateSystem = validEvidence("0.2.5").updateSystem;
  await assert.rejects(
    verifyFixture("0.2.0", evidence),
    /updateSystem/,
  );
});

test("CI runs release-gate tests without treating pending production evidence as passing", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /^        run: node --test scripts\/ci\/verify-release-gate\.test\.mjs\r?$/m);
  assert.doesNotMatch(workflow, /run:.*(?:npm run verify:release-gate|node scripts\/ci\/verify-release-gate\.mjs)/);
});
