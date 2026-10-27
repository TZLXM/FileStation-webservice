import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  buildManifest,
  canonicalizeJson,
  loadFixedPublicKey,
  readArtifactMetadata,
  requireConfiguredPublicKey,
  signManifest,
  validateArtifactMetadata,
  verifyManifestSignature,
} from "./build-manifest.mjs";
import { draftReleaseNotes } from "./draft-release-notes.mjs";
import {
  packageArtifact,
  parsePackageArguments,
  prepareArtifactDirectory,
  isForbiddenArtifactPath,
  resolveNpmInvocation,
} from "./package-artifact.mjs";
import { renderReleaseNotes } from "./render-release-notes.mjs";
import { redactSmokeOutput } from "./smoke-artifact.mjs";
import {
  determineDatabaseMigration,
  resolvePriorStableTag,
  validateCandidateTagDiff,
  validateVersion,
} from "./validate-version.mjs";
import { validateReleaseNotes } from "./validate-release-notes.mjs";

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "filestation-release-tools-"));
const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const tagCommit = "abcdef0123456789abcdef0123456789abcdef01";

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

function localizedSummary(language) {
  const english = language === "en";
  return {
    features: [
      {
        id: "feat-release-tools",
        text: english
          ? "Add deterministic release tooling."
          : "新增确定性的发布工具。",
      },
    ],
    fixes: [
      {
        id: "fix-release-gate",
        text: english
          ? "Reject incomplete release evidence."
          : "拒绝不完整的发布证据。",
      },
    ],
  };
}

function validNotes(version = "0.2.0") {
  return {
    version,
    database_migration: true,
    breaking_changes: false,
    minimum_node: "20.17.0",
    requires_manual_bootstrap: true,
    automatic_update_from: "0.2.5",
    update_protocol: 1,
    min_updater_version: "0.2.5",
    migration_workspace_multiplier: 3,
    migration_workspace_min_bytes: 268435456,
    release_summaries: {
      "zh-CN": localizedSummary("zh-CN"),
      en: localizedSummary("en"),
    },
  };
}

function artifact(platform) {
  const windows = platform === "windows-x64";
  return {
    platform,
    os: windows ? "windows" : "linux",
    arch: "x64",
    filename: `filestation-v0.2.0-${windows ? "win" : "linux"}-x64.${windows ? "zip" : "tar.gz"}`,
    url: `https://github.com/example/FileStation/releases/download/v0.2.0/filestation-v0.2.0-${windows ? "win" : "linux"}-x64.${windows ? "zip" : "tar.gz"}`,
    archive_size: windows ? 200 : 100,
    unpacked_size: windows ? 500 : 400,
    sha256: windows ? "2".repeat(64) : "1".repeat(64),
    format: windows ? "zip" : "tar.gz",
  };
}

function manifestInput() {
  return {
    notes: validNotes(),
    version: "0.2.0",
    commit: tagCommit,
    publishedAt: "2026-10-27T00:00:00.000Z",
    releaseUrl: "https://github.com/example/FileStation/releases/tag/v0.2.0",
    upgradeGuideUrl:
      "https://github.com/example/FileStation/blob/v0.2.0/docs/UPDATING.md",
    artifacts: [artifact("linux-x64"), artifact("windows-x64")],
  };
}

function workspaceManifests(version = "0.2.0") {
  return Object.fromEntries(
    [
      "package.json",
      "apps/server/package.json",
      "apps/web/package.json",
      "packages/shared/package.json",
    ].map((file) => [file, { name: file, version }]),
  );
}

test("version validation requires the tag and all four product manifests to agree", () => {
  assert.equal(
    validateVersion({
      tag: "v0.2.0",
      manifests: workspaceManifests(),
      breakingChanges: false,
    }).version,
    "0.2.0",
  );

  assert.throws(
    () =>
      validateVersion({
        tag: "v0.2.1",
        manifests: workspaceManifests(),
        breakingChanges: false,
      }),
    /tag/i,
  );

  const manifests = workspaceManifests();
  manifests["apps/web/package.json"].version = "0.2.5";
  assert.throws(
    () =>
      validateVersion({
        tag: "v0.2.0",
        manifests,
        breakingChanges: false,
      }),
    /apps\/web\/package\.json|workspace/i,
  );
});

test("version validation rejects prereleases and breaking patch releases", () => {
  assert.throws(
    () =>
      validateVersion({
        tag: "v0.2.0-rc.1",
        manifests: workspaceManifests(),
        breakingChanges: false,
      }),
    /stable SemVer/i,
  );
  assert.throws(
    () =>
      validateVersion({
        tag: "v0.2.1",
        manifests: workspaceManifests("0.2.1"),
        breakingChanges: true,
      }),
    /patch.*breaking/i,
  );
});

test("release-note validation omits empty categories and pairs stable item IDs", () => {
  const notes = validNotes();
  assert.doesNotThrow(() => validateReleaseNotes(notes));
  assert.deepEqual(Object.keys(notes.release_summaries["zh-CN"]), [
    "features",
    "fixes",
  ]);
  assert.deepEqual(Object.keys(notes.release_summaries.en), [
    "features",
    "fixes",
  ]);

  notes.release_summaries.en.fixes[0].id = "different-id";
  assert.throws(() => validateReleaseNotes(notes), /item ID|same fact/i);
});

test("release-note validation rejects an empty category in only one language", () => {
  const notes = validNotes();
  notes.release_summaries["zh-CN"].security = [
    { id: "security-one", text: "修复一个安全问题。" },
  ];

  assert.throws(() => validateReleaseNotes(notes), /security|category/i);
});

test("patch notes fail closed when breaking changes are declared", () => {
  const notes = validNotes("0.2.1");
  notes.breaking_changes = true;
  notes.release_summaries["zh-CN"].breaking = [
    { id: "breaking-one", text: "需要人工迁移。" },
  ];
  notes.release_summaries.en.breaking = [
    { id: "breaking-one", text: "Manual migration is required." },
  ];

  assert.throws(() => validateReleaseNotes(notes), /patch.*breaking/i);
});

test("no-migration notes require both migration workspace fields to be zero", () => {
  const notes = validNotes("0.2.1");
  notes.database_migration = false;
  notes.migration_workspace_multiplier = 0;
  notes.migration_workspace_min_bytes = 0;

  assert.doesNotThrow(() => validateReleaseNotes(notes));

  notes.migration_workspace_min_bytes = 268435456;
  assert.throws(
    () => validateReleaseNotes(notes),
    /migration workspace fields.*zero/i,
  );
});

test("release notes reject a minimum Node version below 20.17.0", () => {
  const notes = validNotes();
  notes.minimum_node = "20.16.0";

  assert.throws(() => validateReleaseNotes(notes), /minimum_node|20\.17\.0/i);
});

test("draft notes assign matching stable IDs to both languages and omit empty categories", () => {
  const draft = draftReleaseNotes({
    targetVersion: "0.2.1",
    previousTag: "v0.2.0",
    commits: [
      {
        sha: "a".repeat(40),
        subject: "feat(server): add resumable upload",
        body: "",
      },
      {
        sha: "b".repeat(40),
        subject: "fix(web): avoid cache failure",
        body: "",
      },
      {
        sha: "c".repeat(40),
        subject: "docs: explain deployment",
        body: "",
      },
    ],
  });

  const zh = draft.release_summaries["zh-CN"];
  const en = draft.release_summaries.en;
  assert.deepEqual(Object.keys(zh), ["features", "fixes"]);
  assert.deepEqual(Object.keys(en), ["features", "fixes"]);
  assert.equal(zh.features[0].id, en.features[0].id);
  assert.equal(zh.fixes[0].id, en.fixes[0].id);
  assert.equal(zh.features[0].id, `feat:${"a".repeat(40)}`);
  assert.match(zh.features[0].text, /待审阅/);
  assert.match(en.features[0].text, /Review/);
  assert.doesNotThrow(() => validateReleaseNotes(draft));
});

test("draft notes consume conventional PR metadata with stable paired IDs", () => {
  const draft = draftReleaseNotes({
    targetVersion: "0.2.1",
    previousTag: "v0.2.0",
    commits: [],
    pullRequests: [
      {
        number: 42,
        title: "fix(server): reject stale update manifests",
        body: "No automatic translation.",
      },
    ],
  });

  assert.equal(
    draft.release_summaries["zh-CN"].fixes[0].id,
    "fix:pr-42",
  );
  assert.equal(draft.release_summaries.en.fixes[0].id, "fix:pr-42");
  assert.match(draft.release_summaries["zh-CN"].fixes[0].text, /待审阅/);
  assert.match(draft.release_summaries.en.fixes[0].text, /Review/);
});

test("v0.2.5 draft conservatively requires one-time manual bootstrap", () => {
  const draft = draftReleaseNotes({
    targetVersion: "0.2.5",
    previousTag: "v0.2.0",
    commits: [],
    databaseMigration: false,
  });

  assert.equal(draft.requires_manual_bootstrap, true);
});

test("prior stable tag selection chooses the unique highest reachable release", async () => {
  const selected = await resolvePriorStableTag({
    targetVersion: "0.2.5",
    head: sourceCommit,
    tags: [
      { name: "v0.1.0", commit: "1".repeat(40) },
      { name: "v0.2.0", commit: "2".repeat(40) },
      { name: "v0.2.5-rc.1", commit: "3".repeat(40) },
      { name: "v0.3.0", commit: "4".repeat(40) },
    ],
    isAncestor: async (_candidate, head) => head === sourceCommit,
  });

  assert.equal(selected.name, "v0.2.0");
});

test("prior tag selection fails closed for an unreachable or ambiguous candidate", async () => {
  await assert.rejects(
    resolvePriorStableTag({
      targetVersion: "0.2.5",
      tags: [
        { name: "v0.1.0", commit: "1".repeat(40) },
        { name: "v0.2.0", commit: "2".repeat(40) },
      ],
      head: sourceCommit,
      isAncestor: async (candidate) => candidate === "1".repeat(40),
    }),
    /unreachable|ancestor/i,
  );

  await assert.rejects(
    resolvePriorStableTag({
      targetVersion: "0.2.5",
      tags: [
        { name: "v0.2.0", commit: "1".repeat(40) },
        { name: "v0.2.0-alt", commit: "2".repeat(40) },
      ],
      head: sourceCommit,
      isAncestor: async () => true,
    }),
    /ambiguous|v0\.2\.0/i,
  );
});

test("initial releases always include migrations and later releases derive them from the prior tag", async () => {
  assert.equal(
    await determineDatabaseMigration({
      targetVersion: "0.2.0",
      tags: [],
      head: sourceCommit,
      isAncestor: async () => false,
      getChangedPaths: async () => [],
    }),
    true,
  );

  assert.equal(
    await determineDatabaseMigration({
      targetVersion: "0.2.5",
      tags: [{ name: "v0.2.0", commit: sourceCommit }],
      head: tagCommit,
      isAncestor: async () => true,
      getChangedPaths: async (_from, _to, prefix) =>
        prefix === "apps/server/src/database/migrations"
          ? ["apps/server/src/database/migrations/2-change.ts"]
          : [],
    }),
    true,
  );

  assert.equal(
    await determineDatabaseMigration({
      targetVersion: "0.2.5",
      tags: [{ name: "v0.2.0", commit: sourceCommit }],
      head: tagCommit,
      isAncestor: async () => true,
      getChangedPaths: async () => [],
    }),
    false,
  );
});

test("candidate-to-tag diff permits only release evidence and CURRENT-STATE", () => {
  assert.doesNotThrow(() =>
    validateCandidateTagDiff({
      candidateCommit: sourceCommit,
      tagCommit,
      changedPaths: [
        "release-evidence/v0.2.0.json",
        "docs/CURRENT-STATE.md",
      ],
    }),
  );

  assert.throws(
    () =>
      validateCandidateTagDiff({
        candidateCommit: sourceCommit,
        tagCommit,
        changedPaths: ["apps/server/src/main.ts"],
      }),
    /candidate.*tag|artifact input/i,
  );
});

test("rendering release notes is deterministic and only emits non-empty bilingual sections", () => {
  const notes = validNotes();
  const first = renderReleaseNotes(notes, {
    repositoryUrl: "https://github.com/example/FileStation",
    previousTag: "v0.1.0",
  });
  const second = renderReleaseNotes(notes, {
    repositoryUrl: "https://github.com/example/FileStation",
    previousTag: "v0.1.0",
  });

  assert.equal(first, second);
  assert.match(first, /## 新增功能/);
  assert.match(first, /## Features/);
  assert.match(first, /## 问题修复/);
  assert.match(first, /## Bug Fixes/);
  assert.doesNotMatch(first, /## 不兼容变更/);
  assert.match(
    first,
    /https:\/\/github\.com\/example\/FileStation\/compare\/v0\.1\.0\.\.\.v0\.2\.0/,
  );
});

test("RFC 8785 canonicalization sorts keys and preserves canonical Unicode", () => {
  assert.equal(
    canonicalizeJson({
      z: [true, null],
      b: "é",
      a: 1,
      nested: { y: 2, x: 1 },
    }),
    '{"a":1,"b":"é","nested":{"x":1,"y":2},"z":[true,null]}',
  );
  assert.throws(() => canonicalizeJson({ unsafe: 9007199254740992 }), /safe integer/i);
  assert.throws(() => canonicalizeJson({ missing: undefined }), /undefined/i);
});

test("manifest building and Ed25519 signatures reject tampering and non-64-byte values", () => {
  const manifest = buildManifest(manifestInput());
  const payload = canonicalizeJson(manifest);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyBase64 = privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64");
  const publicKeyBase64 = publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");

  const signature = signManifest({
    payload,
    privateKeyBase64,
    expectedPublicKeyBase64: publicKeyBase64,
  });
  assert.equal(signature.length, 64);
  assert.equal(
    verifyManifestSignature({
      payload,
      signature,
      publicKeyBase64,
    }),
    true,
  );
  assert.equal(canonicalizeJson(buildManifest(manifestInput())), payload);
  assert.deepEqual(
    signManifest({
      payload,
      privateKeyBase64,
      expectedPublicKeyBase64: publicKeyBase64,
    }),
    signature,
  );

  const tampered = Buffer.from(payload);
  tampered[tampered.length - 5] ^= 1;
  assert.equal(
    verifyManifestSignature({
      payload: tampered.toString("utf8"),
      signature,
      publicKeyBase64,
    }),
    false,
  );
  assert.throws(
    () =>
      verifyManifestSignature({
        payload,
        signature: Buffer.concat([signature, Buffer.from([0])]),
        publicKeyBase64,
      }),
    /64 bytes/i,
  );
  assert.throws(
    () =>
      verifyManifestSignature({
        payload,
        signature: signature.subarray(0, 63),
        publicKeyBase64,
      }),
    /64 bytes/i,
  );

  const wrongKey = generateKeyPairSync("ed25519").publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  assert.throws(
    () =>
      signManifest({
        payload,
        privateKeyBase64,
        expectedPublicKeyBase64: wrongKey,
      }),
    /binding|does not match/i,
  );
});

test("the checked-in public-key module is an explicit fail-closed sentinel", async () => {
  const fixed = await loadFixedPublicKey();
  assert.equal(fixed.status, "unconfigured");
  assert.equal(fixed.publicKeyBase64, null);
  assert.throws(
    () => requireConfiguredPublicKey(fixed),
    /UNCONFIGURED|public key/i,
  );
});

test("manifest artifacts require exact GitHub release paths, sizes, and SHA-256", () => {
  const valid = artifact("linux-x64");
  assert.doesNotThrow(() =>
    validateArtifactMetadata(valid, {
      version: "0.2.0",
      releaseUrl: "https://github.com/example/FileStation/releases/tag/v0.2.0",
    }),
  );

  for (const mutation of [
    { url: "https://downloads.example.com/file.tar.gz" },
    { url: `${valid.url}?redirect=https://evil.example` },
    { archive_size: -1 },
    { unpacked_size: 1.5 },
    { sha256: "sha256:not-a-digest" },
    { filename: "../escape.tar.gz" },
  ]) {
    assert.throws(
      () =>
        validateArtifactMetadata(
          { ...valid, ...mutation },
          {
            version: "0.2.0",
            releaseUrl:
              "https://github.com/example/FileStation/releases/tag/v0.2.0",
          },
        ),
      /artifact|URL|size|sha256|filename/i,
    );
  }
});

test("candidate digests must exactly match rebuilt media and candidate evidence", async () => {
  const design = ["linux-x64", "windows-x64"];
  const metadata = design.map(artifact);
  const evidence = {
    candidate: {
      sourceCommit,
      runId: "12345",
      platformDigests: {
        "linux-x64": `sha256:${metadata[0].sha256}`,
        "windows-x64": `sha256:${metadata[1].sha256}`,
      },
    },
  };

  assert.deepEqual(
    await readArtifactMetadata({
      artifacts: metadata,
      expectedEvidence: evidence,
    }),
    metadata,
  );

  evidence.candidate.platformDigests["windows-x64"] = `sha256:${"3".repeat(64)}`;
  await assert.rejects(
    readArtifactMetadata({ artifacts: metadata, expectedEvidence: evidence }),
    /digest|windows-x64/i,
  );
});

test("artifact file lookup validates filenames before reading the filesystem", async () => {
  const metadata = ["linux-x64", "windows-x64"].map(artifact);
  metadata[0].filename = "../outside.tar.gz";
  const evidence = {
    candidate: {
      sourceCommit,
      runId: "12345",
      platformDigests: {
        "linux-x64": `sha256:${metadata[0].sha256}`,
        "windows-x64": `sha256:${metadata[1].sha256}`,
      },
    },
  };

  await assert.rejects(
    readArtifactMetadata({
      artifacts: metadata,
      expectedEvidence: evidence,
      artifactDirectory: fixtureRoot,
      version: "0.2.0",
      releaseUrl:
        "https://github.com/example/FileStation/releases/tag/v0.2.0",
    }),
    /artifact\.filename|filename/i,
  );
});

async function writeFixtureFile(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function createRepositoryFixture() {
  const root = path.join(fixtureRoot, `repo-${crypto.randomUUID()}`);
  await writeFixtureFile(
    root,
    "package.json",
    JSON.stringify({ name: "fixture", version: "0.2.0", private: true }, null, 2),
  );
  await writeFixtureFile(
    root,
    "package-lock.json",
    JSON.stringify({ lockfileVersion: 3, packages: {} }, null, 2),
  );
  for (const workspace of [
    "apps/server/package.json",
    "apps/web/package.json",
    "packages/shared/package.json",
  ]) {
    await writeFixtureFile(
      root,
      workspace,
      JSON.stringify({ version: "0.2.0", private: true }, null, 2),
    );
  }
  for (const required of [
    "apps/server/dist/main.js",
    "apps/web/dist/index.html",
    "packages/shared/dist/index.js",
    "scripts/release/smoke-artifact.mjs",
    "scripts/release/create-smoke-db.mjs",
    "release-notes/v0.2.0.json",
  ]) {
    await writeFixtureFile(root, required, `fixture:${required}\n`);
  }
  await writeFixtureFile(
    root,
    "node_modules/sqlite3/build/Release/node_sqlite3.node",
    "native-fixture",
  );
  await writeFixtureFile(root, ".env", "JWT_SECRET=fixture-secret\n");
  await writeFixtureFile(root, "data/filestation.db", "fixture-database");
  await writeFixtureFile(root, "apps/server/test/secret.test.js", "test");
  await writeFixtureFile(root, "server.log", "log");

  return root;
}

test("staging path filters use repository-relative segments", async () => {
  const repositoryRoot = await createRepositoryFixture();
  const nestedSource = path.join(
    fixtureRoot,
    "tests",
    `repo-${crypto.randomUUID()}`,
  );
  await mkdir(nestedSource, { recursive: true });
  await copyFile(
    path.join(repositoryRoot, "package.json"),
    path.join(nestedSource, "package.json"),
  );
  await cp(repositoryRoot, nestedSource, {
    recursive: true,
    force: true,
  });
  const destination = path.join(fixtureRoot, `stage-${crypto.randomUUID()}`);
  await prepareArtifactDirectory({
    repositoryRoot: nestedSource,
    destination,
    version: "0.2.0",
    platform: "linux-x64",
    productionNodeModulesDirectory: path.join(nestedSource, "node_modules"),
  });
  assert.equal(
    await readFile(
      path.join(
        destination,
        "node_modules/sqlite3/build/Release/node_sqlite3.node",
      ),
      "utf8",
    ),
    "native-fixture",
  );
});

test("artifact staging includes production tree and excludes data, env, logs, and tests", async () => {
  const repositoryRoot = await createRepositoryFixture();
  const destination = path.join(fixtureRoot, `stage-${crypto.randomUUID()}`);
  await prepareArtifactDirectory({
    repositoryRoot,
    destination,
    version: "0.2.0",
    platform: "linux-x64",
    productionNodeModulesDirectory: path.join(repositoryRoot, "node_modules"),
  });

  assert.equal(
    await readFile(
      path.join(
        destination,
        "node_modules/sqlite3/build/Release/node_sqlite3.node",
      ),
      "utf8",
    ),
    "native-fixture",
  );
  for (const excluded of [
    ".env",
    "data/filestation.db",
    "apps/server/test/secret.test.js",
    "server.log",
  ]) {
    await assert.rejects(stat(path.join(destination, excluded)), { code: "ENOENT" });
  }
});

test("artifact staging refuses to remove a destination inside the source tree", async () => {
  const repositoryRoot = await createRepositoryFixture();
  await assert.rejects(
    prepareArtifactDirectory({
      repositoryRoot,
      destination: path.join(repositoryRoot, ".release-stage-unexpected"),
      version: "0.2.0",
      platform: "linux-x64",
      productionNodeModulesDirectory: path.join(repositoryRoot, "node_modules"),
    }),
    /outside the source tree/i,
  );
});

test("ZIP and tar.gz packaging is deterministic for a fixed source epoch", async () => {
  const repositoryRoot = await createRepositoryFixture();
  for (const platform of ["linux-x64", "windows-x64"]) {
    const outputs = [];
    for (let index = 0; index < 2; index += 1) {
      const destination = path.join(
        fixtureRoot,
        `stage-${platform}-${index}-${crypto.randomUUID()}`,
      );
      await prepareArtifactDirectory({
        repositoryRoot,
        destination,
        version: "0.2.0",
        platform,
        productionNodeModulesDirectory: path.join(repositoryRoot, "node_modules"),
      });
      const result = await packageArtifact({
        sourceRoot: destination,
        outputDirectory: path.join(destination, "out"),
        version: "0.2.0",
        platform,
        sourceDateEpoch: 1_704_067_200,
      });
      outputs.push(await readFile(result.archivePath));
    }
    assert.deepEqual(outputs[0], outputs[1], `${platform} archive differed`);
  }
});

test("packaging CLI accepts --install-production as a value-free flag", () => {
  assert.deepEqual(
    parsePackageArguments([
      "--version",
      "0.2.0",
      "--platform",
      "linux-x64",
      "--output",
      "release-artifacts",
      "--source-date-epoch",
      "1704067200",
      "--release-url",
      "https://github.com/example/FileStation/releases/tag/v0.2.0",
      "--install-production",
    ]),
    {
      version: "0.2.0",
      platform: "linux-x64",
      output: "release-artifacts",
      "source-date-epoch": "1704067200",
      "release-url": "https://github.com/example/FileStation/releases/tag/v0.2.0",
      "install-production": true,
    },
  );
});

test("artifact path filtering drops dependency tests but keeps runtime data", () => {
  assert.equal(
    isForbiddenArtifactPath(
      "node_modules/example/__tests__/widget.test.js.map",
    ),
    true,
  );
  assert.equal(
    isForbiddenArtifactPath("node_modules/example/test/fixture.json"),
    true,
  );
  assert.equal(
    isForbiddenArtifactPath("node_modules/example/data/schema.json"),
    false,
  );
  assert.equal(isForbiddenArtifactPath("data/filestation.db"), true);
  assert.equal(isForbiddenArtifactPath(".env.local"), true);
});

test("Windows packaging invokes npm-cli.js through Node instead of npm.cmd", async () => {
  const binDirectory = path.join(fixtureRoot, `npm-bin-${crypto.randomUUID()}`);
  const npmCmd = path.join(binDirectory, "npm.cmd");
  const npmCli = path.join(
    binDirectory,
    "node_modules/npm/bin/npm-cli.js",
  );
  await writeFixtureFile(fixtureRoot, path.relative(fixtureRoot, npmCmd), "@echo off\n");
  await writeFixtureFile(fixtureRoot, path.relative(fixtureRoot, npmCli), "// fixture npm cli\n");

  const invocation = await resolveNpmInvocation({
    platform: "win32",
    execPath: "C:\\node\\node.exe",
    env: { Path: binDirectory },
  });
  assert.deepEqual(invocation, {
    command: "C:\\node\\node.exe",
    argsPrefix: [npmCli],
    shell: false,
  });
  await assert.doesNotReject(() => resolveNpmInvocation());
});

test("smoke output redaction removes initialization tokens, secrets, and credentials", () => {
  const raw = [
    "initialized",
    "初始化 Token: 0123456789abcdef",
    "JWT_SECRET=super-secret",
    "Authorization: Bearer abc.def.ghi",
    "password=hunter2",
    "x".repeat(3000),
  ].join("\n");
  const redacted = redactSmokeOutput(raw);

  assert.doesNotMatch(redacted, /0123456789abcdef|super-secret|abc\.def\.ghi|hunter2/);
  assert.match(redacted, /REDACTED/);
  assert.ok(redacted.length <= 1024);
});

test("shared protocol exports and CI release-tool test wiring are present", async () => {
  const sharedIndex = await readFile(
    new URL("../../packages/shared/src/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(sharedIndex, /update-types/);
  assert.match(sharedIndex, /update-public-key/);

  for (const symbol of [
    "UpdateManifestV1",
    "UpdateArtifact",
    "LocalizedReleaseSummary",
    "UpdateStage",
    "UpdateStatusResponse",
    "UPDATE_PROTOCOL_VERSION",
  ]) {
    const types = await readFile(
      new URL("../../packages/shared/src/update-types.ts", import.meta.url),
      "utf8",
    );
    assert.match(types, new RegExp(`\\b${symbol}\\b`));
  }

  const workflow = await readFile(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /^        run: node --test scripts\/release\/release-tools\.test\.mjs\r?$/m,
  );
});

test("release workflows isolate candidate builds from protected signing and publication", async () => {
  const platform = await readFile(
    new URL("../../.github/workflows/release-platform.yml", import.meta.url),
    "utf8",
  );
  const candidate = await readFile(
    new URL("../../.github/workflows/release-candidate.yml", import.meta.url),
    "utf8",
  );
  const release = await readFile(
    new URL("../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );

  assert.match(platform, /workflow_call:/);
  assert.match(platform, /windows-latest/);
  assert.match(platform, /ubuntu-latest/);
  assert.match(platform, /actions: read/);
  assert.doesNotMatch(platform, /RELEASE_SIGNING_PRIVATE_KEY_BASE64/);

  assert.match(candidate, /pull_request:/);
  assert.match(candidate, /workflow_dispatch:/);
  assert.match(candidate, /release-platform\.yml/);
  assert.match(candidate, /actions: read/);
  assert.doesNotMatch(candidate, /RELEASE_SIGNING_PRIVATE_KEY_BASE64/);
  assert.doesNotMatch(candidate, /gh release|softprops\/action-gh-release/);

  assert.match(release, /tags:\s*\n\s*- ["']v\*["']/);
  assert.match(release, /environment: release-signing/);
  assert.match(release, /release-platform\.yml/);
  assert.match(release, /RELEASE_SIGNING_PRIVATE_KEY_BASE64/);
  assert.match(release, /gh release create/);
  assert.match(release, /actions: read/);
  assert.match(platform, /ref:\s*\$\{\{\s*inputs\.source_commit\s*\}\}/);
});
