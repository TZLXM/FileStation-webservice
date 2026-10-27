import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

function passed(reference) {
  return { status: "passed", reference };
}

function pending() {
  return { status: "pending", reference: null };
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
    },
    knownRisks: ["moderate/low dependency advisories accepted in CURRENT-STATE"],
    notes: "Structured evidence only; Pending prose is intentionally ignored.",
  };

  if (version === "0.2.5") {
    evidence.updateSystem = {
      linuxX64: passed("manual/update-linux-x64"),
      windowsX64: passed("manual/update-windows-x64"),
    };
  }

  return evidence;
}

async function verifyFixture(version, evidence) {
  const evidenceDirectory = path.join(fixtureRoot, `${version}-${crypto.randomUUID()}`);
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    path.join(evidenceDirectory, `v${version}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
  return verifyReleaseGate({ version, evidenceDirectory });
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
  evidence.updateSystem.windowsX64 = pending();

  await assert.rejects(verifyFixture("0.2.5", evidence), /windowsX64/);
});

test("accepts complete v0.2.5 evidence", async () => {
  const result = await verifyFixture("0.2.5", validEvidence("0.2.5"));

  assert.equal(result.version, "0.2.5");
});

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
