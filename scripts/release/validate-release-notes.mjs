import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  compareStableSemver,
  parseStableSemver,
  ReleaseValidationError,
} from "./validate-version.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const CATEGORY_KEYS = [
  "features",
  "fixes",
  "security",
  "upgrades",
  "breaking",
  "known_issues",
];
const CATEGORY_SET = new Set(CATEGORY_KEYS);
const LANGUAGE_KEYS = ["zh-CN", "en"];
const LANGUAGE_SET = new Set(LANGUAGE_KEYS);
const ITEM_ID_PATTERN = /^[a-z][a-z0-9:_-]{2,100}$/;

function fail(message) {
  throw new ReleaseValidationError(message);
}

function assertExactObject(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(`${field} contains unknown field ${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${field} is missing field ${key}`);
  }
}

function validateSummary(summary, language) {
  assertExactObject(
    summary,
    Object.keys(summary).filter((key) => CATEGORY_SET.has(key)),
    `release_summaries.${language}`,
  );
  const categories = Object.keys(summary);
  if (categories.length === 0) {
    fail(`release_summaries.${language} must contain at least one category`);
  }

  const idsByCategory = new Map();
  for (const category of categories) {
    if (!CATEGORY_SET.has(category)) {
      fail(`release_summaries.${language}.${category} is not a supported category`);
    }
    const items = summary[category];
    if (!Array.isArray(items) || items.length === 0) {
      fail(
        `release_summaries.${language}.${category} must be omitted when empty`,
      );
    }
    const seen = new Set();
    for (const [index, item] of items.entries()) {
      assertExactObject(
        item,
        ["id", "text"],
        `release_summaries.${language}.${category}[${index}]`,
      );
      if (typeof item.id !== "string" || !ITEM_ID_PATTERN.test(item.id)) {
        fail(
          `release_summaries.${language}.${category}[${index}].id is invalid`,
        );
      }
      if (seen.has(item.id)) {
        fail(
          `release_summaries.${language}.${category} repeats item ID ${item.id}`,
        );
      }
      if (typeof item.text !== "string" || item.text.trim() === "") {
        fail(
          `release_summaries.${language}.${category}[${index}].text must be non-empty`,
        );
      }
      if (/\[(?:Review|待审阅)\]/iu.test(item.text)) {
        fail("unresolved draft review marker: Review / 待审阅");
      }
      seen.add(item.id);
    }
    idsByCategory.set(category, items.map((item) => item.id));
  }
  return idsByCategory;
}

export function validateReleaseNotes(notes) {
  assertExactObject(
    notes,
    [
      "version",
      "database_migration",
      "breaking_changes",
      "minimum_node",
      "requires_manual_bootstrap",
      "automatic_update_from",
      "update_protocol",
      "min_updater_version",
      "migration_workspace_multiplier",
      "migration_workspace_min_bytes",
      "release_summaries",
    ],
    "release notes",
  );

  const version = parseStableSemver(notes.version, "release notes version");
  for (const field of ["database_migration", "breaking_changes", "requires_manual_bootstrap"]) {
    if (typeof notes[field] !== "boolean") fail(`${field} must be a boolean`);
  }
  const minimumNode = parseStableSemver(notes.minimum_node, "minimum_node");
  if (compareStableSemver(minimumNode.raw, "20.17.0") < 0) {
    fail("minimum_node must be at least 20.17.0");
  }
  const automaticFrom = parseStableSemver(
    notes.automatic_update_from,
    "automatic_update_from",
  );
  const minUpdater = parseStableSemver(
    notes.min_updater_version,
    "min_updater_version",
  );
  if (notes.update_protocol !== 1) {
    fail("update_protocol must be 1 for UpdateManifestV1");
  }
  if (version.patch > 0 && notes.breaking_changes) {
    fail("patch releases cannot declare breaking changes");
  }
  if (!notes.breaking_changes && Object.values(notes.release_summaries ?? {}).some(summary => summary?.breaking?.length > 0)) {
    fail("breaking category contradicts breaking_changes=false");
  }
  if (notes.breaking_changes) {
    const hasBreaking = Object.hasOwn(notes.release_summaries ?? {}, "zh-CN") &&
      notes.release_summaries["zh-CN"].breaking?.length > 0 &&
      notes.release_summaries.en?.breaking?.length > 0;
    if (!hasBreaking) {
      fail("breaking_changes=true requires bilingual Breaking Changes entries");
    }
  }

  if (notes.database_migration) {
    if (
      !Number.isFinite(notes.migration_workspace_multiplier) ||
      notes.migration_workspace_multiplier < 2 ||
      notes.migration_workspace_multiplier > 64
    ) {
      fail("migration_workspace_multiplier must be between 2.0 and 64.0");
    }
    if (
      !Number.isSafeInteger(notes.migration_workspace_min_bytes) ||
      notes.migration_workspace_min_bytes < 0
    ) {
      fail("migration_workspace_min_bytes must be a non-negative safe integer");
    }
    if (notes.migration_workspace_min_bytes < 268435456) {
      fail("database migrations require at least 268435456 workspace bytes");
    }
  } else if (
    notes.migration_workspace_multiplier !== 0 ||
    notes.migration_workspace_min_bytes !== 0
  ) {
    fail("migration workspace fields must be zero when no migration is present");
  }

  if (!notes.release_summaries || typeof notes.release_summaries !== "object") {
    fail("release_summaries must be an object");
  }
  const languageKeys = Object.keys(notes.release_summaries);
  for (const language of languageKeys) {
    if (!LANGUAGE_SET.has(language)) {
      fail(`release_summaries contains unsupported language ${language}`);
    }
  }
  for (const language of LANGUAGE_KEYS) {
    if (!Object.hasOwn(notes.release_summaries, language)) {
      fail(`release_summaries.${language} is required`);
    }
  }

  const zhIds = validateSummary(notes.release_summaries["zh-CN"], "zh-CN");
  const enIds = validateSummary(notes.release_summaries.en, "en");
  const zhCategories = [...zhIds.keys()].sort();
  const enCategories = [...enIds.keys()].sort();
  if (JSON.stringify(zhCategories) !== JSON.stringify(enCategories)) {
    fail("zh-CN and en category mismatch: both languages must classify the same facts");
  }
  for (const category of zhCategories) {
    if (JSON.stringify(zhIds.get(category)) !== JSON.stringify(enIds.get(category))) {
      fail(
        `${category} item IDs must pair the same facts in zh-CN and en`,
      );
    }
  }

  return {
    version: version.raw,
    minimumNode: minimumNode.raw,
    automaticUpdateFrom: automaticFrom.raw,
    minUpdaterVersion: minUpdater.raw,
    categories: zhCategories,
  };
}

export async function loadReleaseNotes(version, repositoryRoot = REPOSITORY_ROOT) {
  const notesPath = path.join(
    repositoryRoot,
    "release-notes",
    `v${parseStableSemver(version).raw}.json`,
  );
  const notes = JSON.parse(await readFile(notesPath, "utf8"));
  validateReleaseNotes(notes);
  return { notes, notesPath };
}

async function main() {
  try {
    const arguments_ = process.argv.slice(2);
    if (arguments_.length !== 2 || arguments_[0] !== "--version") {
      fail("usage: validate-release-notes.mjs --version <semver>");
    }
    const { notesPath, notes } = await loadReleaseNotes(arguments_[1]);
    const result = validateReleaseNotes(notes);
    console.log(
      JSON.stringify({
        ...result,
        path: path.relative(REPOSITORY_ROOT, notesPath),
      }),
    );
  } catch (error) {
    console.error(
      `Release-note validation failed: ${error instanceof Error ? error.message : "unknown error"}`,
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
