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
