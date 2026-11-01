import { KeyObject, verify } from "node:crypto";
import canonicalize from "canonicalize";
import * as semver from "semver";
import type { UpdateManifestV1, UpdateArtifact } from "@filestation/shared";
import {
  validateReleaseAssetUrl,
  OFFICIAL_REPOSITORY,
} from "./download-policy";
declare const verified: unique symbol;
export type VerifiedManifestV1 = Readonly<UpdateManifestV1> & {
  readonly [verified]: true;
};
const trustedManifests = new WeakSet<object>();
function fail(field: string): never {
  throw new Error(`Invalid manifest: ${field}`);
}
function object(
  value: unknown,
  keys: string[],
  field: string,
  partial = false,
): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field);
  if (
    Object.keys(value).some((k) => !keys.includes(k)) ||
    (!partial && keys.some((k) => !Object.hasOwn(value, k)))
  )
    fail(field);
}
function stable(value: unknown): value is string {
  return (
    typeof value === "string" &&
    semver.valid(value) === value &&
    semver.prerelease(value) === null &&
    !value.includes("+")
  );
}
function integer(value: unknown, min = 0): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= min
  );
}
function text(value: unknown, max = 16384): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
function docUrl(value: unknown): void {
  if (!text(value, 2048)) fail("documentation URL");
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.hostname !== "github.com" ||
    u.username ||
    u.password ||
    u.port ||
    u.search ||
    !u.pathname.startsWith(`/${OFFICIAL_REPOSITORY}/`)
  )
    fail("documentation URL");
}
function freeze(value: any): any {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
/** The caller must supply an explicitly trusted Ed25519 public key. No runtime key discovery. */
export function verifyManifest(
  bytes: Buffer,
  signature: Buffer,
  trustedKeyObject: KeyObject,
): VerifiedManifestV1 {
  if (
    bytes.length > 1024 * 1024 ||
    !trustedKeyObject ||
    trustedKeyObject.type !== "public" ||
    trustedKeyObject.asymmetricKeyType !== "ed25519" ||
    signature.length !== 64
  )
    fail("key/signature/size");
  if (!verify(null, bytes, trustedKeyObject, signature)) fail("signature");
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const m: any = JSON.parse(raw);
  // Equality rejects duplicate keys, alternate number encodings, BOMs and whitespace too.
  if (!Buffer.from(canonicalize(m) ?? "", "utf8").equals(bytes))
    fail("RFC8785 encoding");
  object(
    m,
    [
      "version",
      "commit",
      "published_at",
      "channel",
      "minimum_node",
      "database_migration",
      "migration_workspace_multiplier",
      "migration_workspace_min_bytes",
      "breaking_changes",
      "requires_manual_bootstrap",
      "automatic_update_from",
      "update_protocol",
      "min_updater_version",
      "release_notes_url",
      "release_summaries",
      "upgrade_guide_url",
      "artifacts",
    ],
    "fields",
  );
  for (const f of [
    "version",
    "minimum_node",
    "automatic_update_from",
    "min_updater_version",
  ])
    if (!stable(m[f])) fail(f);
  if (
    semver.lt(m.minimum_node, "20.17.0") ||
    semver.gt(m.automatic_update_from, m.version) ||
    semver.gt(m.min_updater_version, m.version)
  )
    fail("version floor");
  if (
    m.update_protocol !== 1 ||
    m.channel !== "stable" ||
    !text(m.commit, 40) ||
    !/^[a-f0-9]{40}$/.test(m.commit) ||
    !text(m.published_at, 32) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(m.published_at) ||
    !Number.isFinite(Date.parse(m.published_at))
  )
    fail("protocol/metadata");
  if (
    new Date(m.published_at).toISOString() !==
    (m.published_at.includes(".")
      ? m.published_at
      : m.published_at.replace("Z", ".000Z"))
  )
    fail("published_at calendar");
  for (const f of [
    "database_migration",
    "breaking_changes",
    "requires_manual_bootstrap",
  ])
    if (typeof m[f] !== "boolean") fail(f);
  if (!integer(m.migration_workspace_min_bytes))
    fail("migration_workspace_min_bytes");
  if (m.database_migration) {
    if (
      typeof m.migration_workspace_multiplier !== "number" ||
      !Number.isFinite(m.migration_workspace_multiplier) ||
      m.migration_workspace_multiplier < 2 ||
      m.migration_workspace_multiplier > 64 ||
      m.migration_workspace_min_bytes < 268435456
    )
      fail("migration workspace");
  } else if (
    m.migration_workspace_multiplier !== 0 ||
    m.migration_workspace_min_bytes !== 0
  )
    fail("migration workspace without migration");
  docUrl(m.release_notes_url);
  docUrl(m.upgrade_guide_url);
  object(m.release_summaries, ["zh-CN", "en"], "summaries");
  const categories = [
    "features",
    "fixes",
    "security",
    "upgrades",
    "breaking",
    "known_issues",
  ];
  const localeIds: string[][] = [];
  for (const lang of ["zh-CN", "en"]) {
    const summary = m.release_summaries[lang];
    object(summary, categories, "summary category", true);
    if (!Object.keys(summary).length) fail("empty summary");
    const ids: string[] = [];
    for (const [category, items] of Object.entries(summary)) {
      if (!Array.isArray(items) || items.length < 1 || items.length > 100)
        fail("summary items");
      for (const item of items as any[]) {
        object(item, ["id", "text"], "summary item");
        if (
          !text(item.id, 101) ||
          !/^[a-z][a-z0-9:_-]{2,100}$/.test(item.id) ||
          !text(item.text) ||
          !item.text.trim() ||
          /\[(?:Review|待审阅)\]/iu.test(item.text) ||
          ids.includes(`${category}:${item.id}`)
        )
          fail("summary item");
        ids.push(`${category}:${item.id}`);
      }
    }
    localeIds.push(ids);
  }
  if (
    (semver.patch(m.version) > 0 && m.breaking_changes) ||
    (m.breaking_changes && !m.release_summaries.en.breaking?.length) ||
    (!m.breaking_changes && m.release_summaries.en.breaking?.length)
  )
    fail("breaking changes");
  if (JSON.stringify(localeIds[0]) !== JSON.stringify(localeIds[1]))
    fail("localized IDs");
  if (
    !Array.isArray(m.artifacts) ||
    m.artifacts.length < 1 ||
    m.artifacts.length > 2
  )
    fail("artifacts");
  const platforms = new Set<string>();
  for (const a of m.artifacts) {
    object(
      a,
      [
        "platform",
        "os",
        "arch",
        "filename",
        "url",
        "archive_size",
        "unpacked_size",
        "sha256",
        "format",
      ],
      "artifact",
    );
    const win = a.platform === "windows-x64";
    if (
      (!win && a.platform !== "linux-x64") ||
      platforms.has(a.platform) ||
      a.arch !== "x64" ||
      a.os !== (win ? "windows" : "linux") ||
      a.format !== (win ? "zip" : "tar.gz")
    )
      fail("artifact platform");
    platforms.add(a.platform);
    const name = `filestation-v${m.version}-${win ? "win" : "linux"}-x64.${a.format}`;
    if (a.filename !== name || !text(a.url, 2048)) fail("artifact filename");
    const url = validateReleaseAssetUrl(a.url, OFFICIAL_REPOSITORY);
    if (
      url.pathname !==
      `/${OFFICIAL_REPOSITORY}/releases/download/v${m.version}/${name}`
    )
      fail("artifact URL version");
    if (
      !integer(a.archive_size, 1) ||
      !integer(a.unpacked_size, 1) ||
      !text(a.sha256, 64) ||
      !/^[a-f0-9]{64}$/.test(a.sha256)
    )
      fail("artifact size/digest");
  }
  const result = freeze(m) as VerifiedManifestV1;
  trustedManifests.add(result);
  return result;
}
export type UpdateDecision =
  | {
      status: "available";
      artifact: UpdateArtifact;
    }
  | {
      status:
        | "same_version"
        | "downgrade"
        | "unsupported_platform"
        | "node_required"
        | "updater_required"
        | "manual_bootstrap"
        | "invalid_version";
    };
export function selectUpdate(
  m: VerifiedManifestV1,
  currentVersion: string,
  platform: string,
  arch: string,
  updaterVersion: string,
  nodeVersion = process.versions.node,
): UpdateDecision {
  if (!trustedManifests.has(m)) fail("unverified manifest");
  if (
    !stable(currentVersion) ||
    !stable(updaterVersion) ||
    !stable(nodeVersion)
  )
    return { status: "invalid_version" };
  if (semver.eq(m.version, currentVersion)) return { status: "same_version" };
  if (semver.lt(m.version, currentVersion)) return { status: "downgrade" };
  const os = platform === "win32" ? "windows" : platform;
  const artifact = m.artifacts.find((a) => a.os === os && a.arch === arch);
  if (!artifact) return { status: "unsupported_platform" };
  if (semver.lt(nodeVersion, m.minimum_node))
    return { status: "node_required" };
  if (semver.lt(updaterVersion, m.min_updater_version))
    return { status: "updater_required" };
  if (
    m.requires_manual_bootstrap ||
    semver.lt(currentVersion, m.automatic_update_from)
  )
    return { status: "manual_bootstrap" };
  return { status: "available", artifact };
}
