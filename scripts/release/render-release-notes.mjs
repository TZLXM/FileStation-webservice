import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadReleaseNotes } from "./validate-release-notes.mjs";
import { ReleaseValidationError } from "./validate-version.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const SECTION_TITLES = {
  features: ["新增功能", "Features"],
  fixes: ["问题修复", "Bug Fixes"],
  security: ["安全更新", "Security"],
  upgrades: ["升级说明", "Upgrade Notes"],
  breaking: ["不兼容变更", "Breaking Changes"],
  known_issues: ["已知问题", "Known Issues"],
};
const CATEGORY_ORDER = Object.keys(SECTION_TITLES);

function fail(message) {
  throw new ReleaseValidationError(message);
}

function renderLanguage(summary, languageIndex) {
  const lines = [];
  for (const category of CATEGORY_ORDER) {
    const items = summary[category];
    if (!items || items.length === 0) continue;
    lines.push(`### ${SECTION_TITLES[category][languageIndex]}`);
    lines.push("");
    for (const item of items) lines.push(`- ${item.text}`);
    lines.push("");
  }
  return lines;
}

export function renderReleaseNotes(
  notes,
  {
    repositoryUrl,
    previousTag = null,
    generatedAt = null,
  } = {},
) {
  if (!notes?.release_summaries) fail("validated release notes are required");
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repositoryUrl ?? "")) {
    fail("repositoryUrl must be an HTTPS GitHub repository URL");
  }

  const lines = [
    `# FileStation v${notes.version}`,
    "",
    "## 中文",
    "",
    ...renderLanguage(notes.release_summaries["zh-CN"], 0),
    "## English",
    "",
    ...renderLanguage(notes.release_summaries.en, 1),
    "---",
    "",
    `- Minimum Node.js / 最低 Node.js：\`${notes.minimum_node}\``,
    `- Database migration / 数据库迁移：${notes.database_migration ? "yes / 是" : "no / 否"}`,
    `- Manual bootstrap / 手动 bootstrap：${notes.requires_manual_bootstrap ? "required / 需要" : "not required / 不需要"}`,
  ];
  if (generatedAt) {
    lines.push(`- Generated / 生成时间：\`${generatedAt}\``);
  }
  lines.push("");
  if (previousTag) {
    lines.push(
      `[Full Changelog / 完整比较](${repositoryUrl}/compare/${encodeURIComponent(previousTag)}...v${notes.version})`,
    );
  } else {
    lines.push(
      `[Release source / 发布源码](${repositoryUrl}/tree/v${notes.version})`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail(
        "usage: render-release-notes.mjs --version <semver> --repository <https-url> [--from <tag>] [--output <file>]",
      );
    }
    options[key.slice(2)] = value;
  }
  return options;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (!options.version || !options.repository) {
      fail("--version and --repository are required");
    }
    const { notes } = await loadReleaseNotes(options.version);
    const rendered = renderReleaseNotes(notes, {
      repositoryUrl: options.repository.replace(/\.git$/, ""),
      previousTag: options.from ?? null,
    });
    if (options.output) {
      await writeFile(path.resolve(REPOSITORY_ROOT, options.output), rendered, "utf8");
      console.log(path.relative(REPOSITORY_ROOT, path.resolve(REPOSITORY_ROOT, options.output)));
    } else {
      process.stdout.write(rendered);
    }
  } catch (error) {
    console.error(
      `Release-note rendering failed: ${error instanceof Error ? error.message : "unknown error"}`,
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
