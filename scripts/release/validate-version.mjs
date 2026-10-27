import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const STABLE_SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const TAG_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const PRODUCT_MANIFESTS = [
  "package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/shared/package.json",
];
const CANDIDATE_TO_TAG_ALLOWLIST = new Set([
  "docs/CURRENT-STATE.md",
  "release-evidence/v0.2.0.json",
  "release-evidence/v0.2.5.json",
]);

export class ReleaseValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseValidationError";
  }
}

function fail(message) {
  throw new ReleaseValidationError(message);
}

export function parseStableSemver(value, field = "version") {
  if (typeof value !== "string") {
    fail(`${field} must be a stable SemVer string`);
  }
  const normalized = value.startsWith("v") ? value.slice(1) : value;
  const match = STABLE_SEMVER_PATTERN.exec(normalized);
  if (!match) {
    fail(`${field} must be a stable SemVer without prerelease or build metadata`);
  }
  return {
    raw: normalized,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareStableSemver(left, right) {
  const a = parseStableSemver(left, "left version");
  const b = parseStableSemver(right, "right version");
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function validateVersion({ tag, manifests, breakingChanges }) {
  const parsedTag = parseStableSemver(tag, "tag");
  if (typeof tag !== "string" || !tag.startsWith("v")) {
    fail("tag must use the v<major>.<minor>.<patch> form");
  }

  for (const file of PRODUCT_MANIFESTS) {
    const manifest = manifests[file];
    if (!manifest || typeof manifest !== "object") {
      fail(`workspace manifest is missing: ${file}`);
    }
    if (manifest.version !== parsedTag.raw) {
      fail(
        `${file} version ${JSON.stringify(manifest.version)} does not match tag ${tag}`,
      );
    }
  }

  if (typeof breakingChanges !== "boolean") {
    fail("breakingChanges must be a boolean");
  }
  if (parsedTag.patch > 0 && breakingChanges) {
    fail("patch releases cannot declare breaking changes");
  }

  return {
    version: parsedTag.raw,
    tag,
    productManifestCount: PRODUCT_MANIFESTS.length,
  };
}

function stableVersionEntries(tags) {
  const entries = [];
  for (const tag of tags) {
    if (!tag || typeof tag.name !== "string") continue;
    const match = TAG_PATTERN.exec(tag.name);
    if (!match) continue;
    entries.push({
      name: tag.name,
      commit: tag.commit,
      version: tag.name.slice(1),
      core: `${match[1]}.${match[2]}.${match[3]}`,
    });
  }
  return entries;
}

export async function resolvePriorStableTag({
  targetVersion,
  tags,
  head = "HEAD",
  isAncestor,
}) {
  const target = parseStableSemver(targetVersion, "targetVersion").raw;
  const belowTarget = stableVersionEntries(tags)
    .filter((entry) => compareStableSemver(entry.version, target) < 0)
    .sort((left, right) => compareStableSemver(right.version, left.version));
  if (belowTarget.length === 0) return null;

  const highestVersion = belowTarget[0].version;
  const highest = belowTarget.filter((entry) => entry.version === highestVersion);
  const sameCoreSuffixes = tags.filter(
    (tag) =>
      typeof tag?.name === "string" &&
      !TAG_PATTERN.test(tag.name) &&
      tag.name.startsWith(`v${highestVersion}-`),
  );
  if (sameCoreSuffixes.length > 0) {
    fail(
      `prior release v${highestVersion} is ambiguous with tag ${sameCoreSuffixes
        .map((tag) => tag.name)
        .join(", ")}`,
    );
  }
  if (highest.length !== 1) {
    fail(
      `prior release v${highestVersion} is ambiguous across ${highest.length} tags`,
    );
  }

  const selected = highest[0];
  if (!SHA_PATTERN.test(selected.commit ?? "")) {
    fail(`prior tag ${selected.name} does not resolve to a 40-character commit`);
  }
  if (!(await isAncestor(selected.commit, head))) {
    fail(
      `prior tag ${selected.name} (${selected.commit}) is unreachable from ${head || "HEAD"}`,
    );
  }
  return {
    name: selected.name,
    version: selected.version,
    commit: selected.commit,
  };
}

export async function determineDatabaseMigration({
  targetVersion,
  tags,
  head = "HEAD",
  isAncestor,
  getChangedPaths,
}) {
  const priorTag = await resolvePriorStableTag({
    targetVersion,
    tags,
    head,
    isAncestor,
  });
  if (!priorTag) return true;

  const migrationPaths = await getChangedPaths(
    priorTag.commit,
    head,
    "apps/server/src/database/migrations",
  );
  return migrationPaths.some((changedPath) =>
    changedPath.startsWith("apps/server/src/database/migrations/"),
  );
}

export function validateCandidateTagDiff({
  candidateCommit,
  tagCommit,
  changedPaths,
}) {
  for (const [field, value] of [
    ["candidateCommit", candidateCommit],
    ["tagCommit", tagCommit],
  ]) {
    if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
      fail(`${field} must be a lowercase 40-character Git SHA`);
    }
  }
  if (!Array.isArray(changedPaths)) {
    fail("changedPaths must be an array");
  }

  const invalidPaths = changedPaths.filter(
    (changedPath) =>
      typeof changedPath !== "string" ||
      !CANDIDATE_TO_TAG_ALLOWLIST.has(changedPath),
  );
  if (invalidPaths.length > 0) {
    fail(
      `candidate-to-tag changes modify artifact input(s): ${invalidPaths.join(", ")}`,
    );
  }
  return {
    candidateCommit,
    tagCommit,
    nonArtifactPaths: [...changedPaths].sort(),
  };
}

async function readWorkspaceManifests(repositoryRoot) {
  const manifests = {};
  for (const file of PRODUCT_MANIFESTS) {
    manifests[file] = JSON.parse(
      await readFile(path.join(repositoryRoot, file), "utf8"),
    );
  }
  return manifests;
}

function git(arguments_, cwd = REPOSITORY_ROOT) {
  const result = spawnSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail(
      `git ${arguments_.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}

function listGitTags(repositoryRoot = REPOSITORY_ROOT) {
  return git(
    [
      "for-each-ref",
      "--format=%(refname:short)%09%(*objectname)%09%(objectname)",
      "refs/tags",
    ],
    repositoryRoot,
  )
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((row) => {
      const [name, peeled, raw] = row.split("\t");
      return { name, commit: peeled || raw };
    });
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail(
        "usage: validate-version.mjs --version <semver> --tag <v-semver> [--evidence <file>] [--candidate-source <sha>]",
      );
    }
    options[key.slice(2)] = value;
  }
  return options;
}

export async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (!options.version || !options.tag) {
      fail("both --version and --tag are required");
    }

    const manifests = await readWorkspaceManifests(REPOSITORY_ROOT);
    const notes = JSON.parse(
      await readFile(
        path.join(REPOSITORY_ROOT, "release-notes", `v${options.version}.json`),
        "utf8",
      ),
    );
    const version = validateVersion({
      tag: options.tag,
      manifests,
      breakingChanges: notes.breaking_changes,
    });
    const head = git(["rev-parse", "HEAD"]);
    const tags = listGitTags();
    const migration = await determineDatabaseMigration({
      targetVersion: options.version,
      tags,
      head,
      isAncestor: async (candidate, descendant) =>
        spawnSync(
          "git",
          ["merge-base", "--is-ancestor", candidate, descendant],
          { cwd: REPOSITORY_ROOT, windowsHide: true },
        ).status === 0,
      getChangedPaths: async (from, to, prefix) =>
        git(["diff", "--name-only", from, to, "--", prefix])
          .split(/\r?\n/u)
          .filter(Boolean),
    });
    if (notes.database_migration !== migration) {
      fail(
        `release notes database_migration=${notes.database_migration} does not match repository-derived value ${migration}`,
      );
    }

    let candidate = null;
    if (options.evidence || options["candidate-source"]) {
      if (!options.evidence || !options["candidate-source"]) {
        fail("candidate verification requires --evidence and --candidate-source");
      }
      const evidence = JSON.parse(
        await readFile(path.resolve(REPOSITORY_ROOT, options.evidence), "utf8"),
      );
      if (evidence.version !== options.version) {
        fail("release evidence version does not match the requested version");
      }
      if (evidence.candidate?.sourceCommit !== options["candidate-source"]) {
        fail("candidate source commit does not match the release evidence");
      }

      const tagCommit = git(["rev-parse", "HEAD"]);
      const ancestor = spawnSync(
        "git",
        ["merge-base", "--is-ancestor", options["candidate-source"], tagCommit],
        { cwd: REPOSITORY_ROOT, windowsHide: true },
      );
      if (ancestor.status !== 0) {
        fail("candidate source commit is not an ancestor of the tag commit");
      }
      const changedPaths = git([
        "diff",
        "--name-only",
        options["candidate-source"],
        tagCommit,
      ]).split(/\r?\n/).filter(Boolean);
      candidate = validateCandidateTagDiff({
        candidateCommit: options["candidate-source"],
        tagCommit,
        changedPaths,
      });
    }

    console.log(
      JSON.stringify({
        ...version,
        database_migration: migration,
        breaking_changes: notes.breaking_changes,
        candidate,
      }),
    );
  } catch (error) {
    console.error(
      `Version validation failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
