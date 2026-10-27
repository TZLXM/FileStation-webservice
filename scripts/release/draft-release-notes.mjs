import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  resolvePriorStableTag,
  ReleaseValidationError,
} from "./validate-version.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function fail(message) {
  throw new ReleaseValidationError(message);
}

function categoryForCommit(commit) {
  const match = /^([a-z]+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/i.exec(commit.subject);
  if (!match) return null;
  const type = match[1].toLowerCase();
  const scope = (match[2] ?? "").toLowerCase();
  const subject = match[4].trim();
  const body = commit.body ?? "";
  const security =
    scope === "security" ||
    /(?:security|cve-\d+|vulnerab|advisory)/i.test(`${subject}\n${body}`);
  const breaking =
    Boolean(match[3]) || /(?:^|\n)BREAKING[ -]CHANGE:/i.test(body);

  if (breaking) return { category: "breaking", prefix: "breaking" };
  if (security) return { category: "security", prefix: "security" };
  if (type === "feat") return { category: "features", prefix: "feat" };
  if (type === "fix") return { category: "fixes", prefix: "fix" };
  return null;
}

export function draftReleaseNotes({
  targetVersion,
  previousTag,
  commits,
  pullRequests = [],
  databaseMigration = true,
}) {
  if (!Array.isArray(commits)) fail("commits must be an array");
  if (!Array.isArray(pullRequests)) fail("pullRequests must be an array");
  const summaries = {
    "zh-CN": {},
    en: {},
  };

  const sources = [];
  for (const commit of commits) {
    if (!/^[0-9a-f]{40}$/u.test(commit.sha ?? "")) {
      fail("every draft source commit needs a lowercase 40-character SHA");
    }
    if (typeof commit.subject !== "string" || commit.subject.trim() === "") {
      fail("every draft source commit needs a subject");
    }
    sources.push({ ...commit, idBase: commit.sha });
  }
  for (const pullRequest of pullRequests) {
    if (
      !Number.isSafeInteger(pullRequest.number) ||
      pullRequest.number <= 0 ||
      typeof pullRequest.title !== "string" ||
      pullRequest.title.trim() === ""
    ) {
      fail("every draft PR needs a positive number and non-empty title");
    }
    const coveredByMergeCommit = sources.some((source) =>
      source.subject.includes(`(#${pullRequest.number})`),
    );
    if (coveredByMergeCommit) continue;
    sources.push({
      sha: `pr-${pullRequest.number}`,
      subject: pullRequest.title,
      body: pullRequest.body ?? "",
      idBase: `pr-${pullRequest.number}`,
    });
  }

  for (const commit of sources) {
    const classification = categoryForCommit(commit);
    if (!classification) continue;

    const id = `${classification.prefix}:${commit.idBase}`;
    for (const [language, marker] of [
      ["zh-CN", "待审阅"],
      ["en", "Review"],
    ]) {
      summaries[language][classification.category] ??= [];
      summaries[language][classification.category].push({
        id,
        text: `[${marker}] ${commit.subject.trim()}`,
      });
    }
  }

  if (Object.keys(summaries["zh-CN"]).length === 0) {
    summaries["zh-CN"].upgrades = [
      {
        id: `release:${targetVersion}`,
        text: `[待审阅] 准备 FileStation v${targetVersion} 发布。`,
      },
    ];
    summaries.en.upgrades = [
      {
        id: `release:${targetVersion}`,
        text: `[Review] Prepare the FileStation v${targetVersion} release.`,
      },
    ];
  }

  return {
    version: targetVersion,
    database_migration: databaseMigration,
    breaking_changes: Boolean(summaries.en.breaking?.length),
    minimum_node: "20.17.0",
    requires_manual_bootstrap:
      previousTag === null || targetVersion === "0.2.5",
    automatic_update_from: "0.2.5",
    update_protocol: 1,
    min_updater_version: "0.2.5",
    migration_workspace_multiplier: databaseMigration ? 3 : 0,
    migration_workspace_min_bytes: databaseMigration ? 268435456 : 0,
    release_summaries: summaries,
  };
}

function git(arguments_) {
  const result = spawnSync("git", arguments_, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail(
      `git ${arguments_.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout;
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail(
        "usage: draft-release-notes.mjs --version <semver> [--from <tag>] [--pr-metadata <json>]",
      );
    }
    options[key.slice(2)] = value;
  }
  return options;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (!options.version) fail("--version is required");
    const head = git(["rev-parse", "HEAD"]).trim();
    let previousTag = options.from ?? null;
    if (!previousTag) {
      const tagRows = git([
        "for-each-ref",
        "--format=%(refname:short)%09%(*objectname)%09%(objectname)",
        "refs/tags",
      ])
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((row) => {
          const [name, peeled, raw] = row.split("\t");
          return { name, commit: peeled || raw };
        });
      const prior = await resolvePriorStableTag({
        targetVersion: options.version,
        tags: tagRows,
        head,
        isAncestor: async (candidate, descendant) =>
          spawnSync(
            "git",
            ["merge-base", "--is-ancestor", candidate, descendant],
            { cwd: REPOSITORY_ROOT, windowsHide: true },
          ).status === 0,
      });
      previousTag = prior?.name ?? null;
    }

    const range = previousTag ? `${previousTag}..${head}` : head;
    const rawLog = git([
      "log",
      "--format=%x1e%H%x1f%s%x1f%b",
      range,
    ]);
    const commits = rawLog
      .split("\x1e")
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [sha, subject, body = ""] = record.split("\x1f");
        return { sha, subject, body };
      });
    let pullRequests = [];
    if (options["pr-metadata"]) {
      const metadata = JSON.parse(
        await readFile(path.resolve(REPOSITORY_ROOT, options["pr-metadata"]), "utf8"),
      );
      pullRequests = Array.isArray(metadata)
        ? metadata
        : Array.isArray(metadata.pullRequests)
          ? metadata.pullRequests
          : null;
      if (!pullRequests) {
        fail("--pr-metadata must contain an array or a pullRequests array");
      }
    }

    let migrationPaths = [];
    if (previousTag) {
      migrationPaths = git([
        "diff",
        "--name-only",
        previousTag,
        head,
        "--",
        "apps/server/src/database/migrations",
      ])
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
    }
    const draft = draftReleaseNotes({
      targetVersion: options.version,
      previousTag,
      commits,
      pullRequests,
      databaseMigration: previousTag === null || migrationPaths.length > 0,
    });
    console.log(`${JSON.stringify(draft, null, 2)}\n`);
  } catch (error) {
    console.error(
      `Draft generation failed: ${error instanceof Error ? error.message : "unknown error"}`,
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
