import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateReleaseNotes } from "./validate-release-notes.mjs";
import {
  parseStableSemver,
  ReleaseValidationError,
} from "./validate-version.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const PUBLIC_KEY_SOURCE = path.join(
  REPOSITORY_ROOT,
  "packages/shared/src/update-public-key.ts",
);
const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ARTIFACT_KEYS = [
  "platform",
  "os",
  "arch",
  "filename",
  "url",
  "archive_size",
  "unpacked_size",
  "sha256",
  "format",
];
const PLATFORMS = {
  "linux-x64": { os: "linux", suffix: "linux-x64", format: "tar.gz" },
  "windows-x64": { os: "windows", suffix: "win-x64", format: "zip" },
};

function fail(message) {
  throw new ReleaseValidationError(message);
}

function assertExactObject(value, expectedKeys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!expectedKeys.includes(key)) {
      fail(`${field} contains unknown field ${key}`);
    }
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) {
      fail(`${field} is missing field ${key}`);
    }
  }
}

function canonicalString(value) {
  return JSON.stringify(value);
}

function canonicalValue(value, location = "$") {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return canonicalString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${location} must be a finite number`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      fail(`${location} must be a JSON safe integer`);
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((entry, index) => {
        if (entry === undefined) fail(`${location}[${index}] cannot be undefined`);
        return canonicalValue(entry, `${location}[${index}]`);
      })
      .join(",")}]`;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(`${location} must contain plain JSON objects only`);
    }
    const members = [];
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) {
        fail(`${location}.${key} cannot be undefined`);
      }
      members.push(
        `${canonicalString(key)}:${canonicalValue(value[key], `${location}.${key}`)}`,
      );
    }
    return `{${members.join(",")}}`;
  }
  fail(`${location} contains a non-JSON value`);
}

export function canonicalizeJson(value) {
  return canonicalValue(value);
}

function decodeBase64(value, field) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !BASE64_PATTERN.test(value)
  ) {
    fail(`${field} must be standard base64`);
  }
  return Buffer.from(value, "base64");
}

export function validateArtifactMetadata(
  artifactValue,
  { version, releaseUrl },
) {
  assertExactObject(artifactValue, ARTIFACT_KEYS, "artifact");
  const platform = PLATFORMS[artifactValue.platform];
  if (!platform) fail("artifact.platform must be linux-x64 or windows-x64");
  if (artifactValue.os !== platform.os) {
    fail(`artifact.os must be ${platform.os} for ${artifactValue.platform}`);
  }
  if (artifactValue.arch !== "x64") fail("artifact.arch must be x64");
  if (
    artifactValue.format !== platform.format
  ) {
    fail(`artifact.format must be ${platform.format} for ${artifactValue.platform}`);
  }

  const expectedFilename = `filestation-v${version}-${platform.suffix}.${platform.format}`;
  if (artifactValue.filename !== expectedFilename) {
    fail(`artifact.filename must be ${expectedFilename}`);
  }
  if (!Number.isSafeInteger(artifactValue.archive_size) || artifactValue.archive_size <= 0) {
    fail("artifact.archive_size must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(artifactValue.unpacked_size) ||
    artifactValue.unpacked_size <= 0
  ) {
    fail("artifact.unpacked_size must be a positive safe integer");
  }
  if (artifactValue.unpacked_size < artifactValue.archive_size) {
    fail("artifact.unpacked_size cannot be smaller than archive_size");
  }
  if (typeof artifactValue.sha256 !== "string" || !SHA256_PATTERN.test(artifactValue.sha256)) {
    fail("artifact.sha256 must be 64 lowercase hexadecimal characters");
  }

  let release;
  try {
    release = new URL(releaseUrl);
  } catch {
    fail("releaseUrl must be an absolute URL");
  }
  if (
    release.protocol !== "https:" ||
    release.hostname !== "github.com" ||
    release.search ||
    release.hash
  ) {
    fail("releaseUrl must be a canonical GitHub HTTPS URL without query or fragment");
  }
  const suffix = `/releases/tag/v${version}`;
  if (!release.pathname.endsWith(suffix)) {
    fail(`releaseUrl must end with ${suffix}`);
  }
  const expectedUrl = new URL(
    `${release.pathname.replace(/\/releases\/tag\//, "/releases/download/")}/${artifactValue.filename}`,
    release.origin,
  ).href;
  if (artifactValue.url !== expectedUrl) {
    fail("artifact.url must be the exact GitHub Release asset URL");
  }
  return artifactValue;
}

export function buildManifest(input) {
  const versionInfo = validateReleaseNotes(input.notes);
  const version = parseStableSemver(input.version);
  if (versionInfo.version !== version.raw || input.notes.version !== version.raw) {
    fail("manifest version must match validated release notes");
  }
  if (typeof input.commit !== "string" || !SHA1_PATTERN.test(input.commit)) {
    fail("manifest commit must be a lowercase 40-character Git SHA");
  }
  const publishedAt = new Date(input.publishedAt);
  if (
    Number.isNaN(publishedAt.valueOf()) ||
    publishedAt.toISOString() !== input.publishedAt
  ) {
    fail("publishedAt must be a canonical UTC ISO-8601 timestamp");
  }
  if (!Array.isArray(input.artifacts)) fail("artifacts must be an array");
  const platforms = new Set();
  const artifacts = input.artifacts.map((artifact) => {
    validateArtifactMetadata(artifact, {
      version: version.raw,
      releaseUrl: input.releaseUrl,
    });
    if (platforms.has(artifact.platform)) {
      fail(`artifacts contains duplicate platform ${artifact.platform}`);
    }
    platforms.add(artifact.platform);
    return { ...artifact };
  });
  for (const platform of Object.keys(PLATFORMS)) {
    if (!platforms.has(platform)) fail(`artifacts is missing ${platform}`);
  }
  artifacts.sort((left, right) =>
    left.platform.localeCompare(right.platform),
  );

  const releaseUrl = new URL(input.releaseUrl);
  const repositoryUrl = releaseUrl.origin + releaseUrl.pathname.replace(/\/releases\/tag\/v[^/]+$/, "");
  const expectedUpgradeGuide = `${repositoryUrl}/blob/v${version.raw}/docs/UPDATING.md`;
  if (input.upgradeGuideUrl !== expectedUpgradeGuide) {
    fail(`upgradeGuideUrl must be ${expectedUpgradeGuide}`);
  }

  return {
    version: version.raw,
    commit: input.commit,
    published_at: input.publishedAt,
    channel: "stable",
    minimum_node: input.notes.minimum_node,
    database_migration: input.notes.database_migration,
    migration_workspace_multiplier:
      input.notes.migration_workspace_multiplier,
    migration_workspace_min_bytes: input.notes.migration_workspace_min_bytes,
    breaking_changes: input.notes.breaking_changes,
    requires_manual_bootstrap: input.notes.requires_manual_bootstrap,
    automatic_update_from: input.notes.automatic_update_from,
    update_protocol: 1,
    min_updater_version: input.notes.min_updater_version,
    release_notes_url: input.releaseUrl,
    release_summaries: structuredClone(input.notes.release_summaries),
    upgrade_guide_url: input.upgradeGuideUrl,
    artifacts,
  };
}

function parseEd25519PrivateKey(privateKeyBase64) {
  const privateKey = createPrivateKey({
    key: decodeBase64(
      privateKeyBase64,
      "RELEASE_SIGNING_PRIVATE_KEY_BASE64",
    ),
    format: "der",
    type: "pkcs8",
  });
  if (privateKey.asymmetricKeyType !== "ed25519") {
    fail("release signing key must be an Ed25519 PKCS#8 private key");
  }
  return privateKey;
}

function parseEd25519PublicKey(publicKeyBase64) {
  const publicKey = createPublicKey({
    key: decodeBase64(publicKeyBase64, "public key"),
    format: "der",
    type: "spki",
  });
  if (publicKey.asymmetricKeyType !== "ed25519") {
    fail("publisher trust root must be an Ed25519 SPKI public key");
  }
  return publicKey;
}

export function signManifest({
  payload,
  privateKeyBase64,
  expectedPublicKeyBase64,
}) {
  if (typeof payload !== "string" || payload.length === 0) {
    fail("manifest payload must be non-empty");
  }
  const privateKey = parseEd25519PrivateKey(privateKeyBase64);
  const expectedPublicKey = parseEd25519PublicKey(expectedPublicKeyBase64);
  const derivedPublic = createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  });
  const expectedPublic = expectedPublicKey.export({
    format: "der",
    type: "spki",
  });
  if (
    derivedPublic.length !== expectedPublic.length ||
    !timingSafeEqual(derivedPublic, expectedPublic)
  ) {
    fail("release signing private key does not match the fixed publisher key binding");
  }

  const signature = sign(null, Buffer.from(payload, "utf8"), privateKey);
  if (signature.length !== 64) {
    fail("Ed25519 signature must be exactly 64 bytes");
  }
  return signature;
}

export function verifyManifestSignature({
  payload,
  signature,
  publicKeyBase64,
}) {
  if (!Buffer.isBuffer(signature) || signature.length !== 64) {
    fail("Ed25519 signature must be exactly 64 bytes");
  }
  const publicKey = parseEd25519PublicKey(publicKeyBase64);
  try {
    return verify(
      null,
      Buffer.from(String(payload), "utf8"),
      publicKey,
      signature,
    );
  } catch {
    return false;
  }
}

export async function loadFixedPublicKey(sourcePath = PUBLIC_KEY_SOURCE) {
  const source = await readFile(sourcePath, "utf8");
  const statusMatch =
    /export const UPDATE_PUBLIC_KEY_STATUS[^=]*=\s*["']([^"']+)["']/u.exec(
      source,
    );
  const keyMatch =
    /export const UPDATE_PUBLIC_KEY_SPKI_BASE64[^=]*=\s*["']([^"']*)["']/u.exec(
      source,
    );
  if (statusMatch?.[1] === "unconfigured" || keyMatch?.[1] === "UNCONFIGURED") {
    return {
      status: "unconfigured",
      publicKeyBase64: null,
      fingerprintSha256: null,
    };
  }
  if (statusMatch?.[1] !== "configured" || !keyMatch?.[1]) {
    fail("fixed publisher public-key module is malformed");
  }
  const publicKey = parseEd25519PublicKey(keyMatch[1]);
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    status: "configured",
    publicKeyBase64: keyMatch[1],
    fingerprintSha256: createHash("sha256").update(spki).digest("hex"),
  };
}

export function requireConfiguredPublicKey(fixedKey) {
  if (fixedKey?.status !== "configured" || !fixedKey.publicKeyBase64) {
    fail(
      "publisher public key is UNCONFIGURED; provision the reviewed Ed25519 SPKI key before signing",
    );
  }
  parseEd25519PublicKey(fixedKey.publicKeyBase64);
  return fixedKey.publicKeyBase64;
}

export async function readArtifactMetadata({
  artifacts,
  expectedEvidence,
  artifactDirectory = null,
  version = null,
  releaseUrl = null,
}) {
  if (!Array.isArray(artifacts)) fail("artifacts metadata must be an array");
  if (!expectedEvidence?.candidate) fail("candidate evidence is required");
  if (
    typeof expectedEvidence.candidate.sourceCommit !== "string" ||
    !SHA1_PATTERN.test(expectedEvidence.candidate.sourceCommit)
  ) {
    fail("candidate.sourceCommit must be a lowercase 40-character Git SHA");
  }
  if (
    typeof expectedEvidence.candidate.runId !== "string" ||
    !/^[1-9][0-9]*$/u.test(expectedEvidence.candidate.runId)
  ) {
    fail("candidate.runId must be a positive integer string");
  }

  const byPlatform = new Map();
  for (const item of artifacts) {
    if (byPlatform.has(item?.platform)) {
      fail(`artifacts metadata duplicates ${item.platform}`);
    }
    byPlatform.set(item?.platform, item);
  }
  for (const platform of Object.keys(PLATFORMS)) {
    const item = byPlatform.get(platform);
    if (!item) fail(`artifacts metadata is missing ${platform}`);
    if (artifactDirectory) {
      if (!version || !releaseUrl) {
        fail("artifact file verification requires version and releaseUrl");
      }
      validateArtifactMetadata(item, { version, releaseUrl });
    }
    const expectedDigest =
      expectedEvidence.candidate.platformDigests?.[platform];
    if (expectedDigest !== `sha256:${item.sha256}`) {
      fail(`rebuilt ${platform} digest does not match candidate evidence`);
    }
    if (artifactDirectory) {
      const filePath = path.resolve(artifactDirectory, item.filename);
      const content = await readFile(filePath);
      const digest = createHash("sha256").update(content).digest("hex");
      if (digest !== item.sha256) {
        fail(`rebuilt ${platform} artifact digest does not match metadata`);
      }
      if (content.length !== item.archive_size) {
        fail(`rebuilt ${platform} artifact size does not match metadata`);
      }
    }
  }
  return artifacts;
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail(
        "usage: build-manifest.mjs --notes <file> --version <semver> --commit <sha> --release-url <url> --upgrade-guide-url <url> --artifacts <metadata.json> --artifact-dir <dir> --output-dir <dir> --evidence <file>",
      );
    }
    options[key.slice(2)] = value;
  }
  return options;
}

export async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const required = [
      "notes",
      "version",
      "commit",
      "release-url",
      "upgrade-guide-url",
      "artifacts",
      "artifact-dir",
      "output-dir",
      "evidence",
    ];
    for (const key of required) {
      if (!options[key]) fail(`--${key} is required`);
    }

    const fixedKey = await loadFixedPublicKey();
    const configuredPublicKey = requireConfiguredPublicKey(fixedKey);

    const notes = JSON.parse(
      await readFile(path.resolve(options.notes), "utf8"),
    );
    const evidence = JSON.parse(
      await readFile(path.resolve(options.evidence), "utf8"),
    );
    const artifacts = await readArtifactMetadata({
      artifacts: JSON.parse(
        await readFile(path.resolve(options.artifacts), "utf8"),
      ),
      expectedEvidence: evidence,
      artifactDirectory: path.resolve(options["artifact-dir"]),
      version: options.version,
      releaseUrl: options["release-url"],
    });
    const publishedAt =
      process.env.RELEASE_PUBLISHED_AT ?? new Date().toISOString();
    const manifest = buildManifest({
      notes,
      version: options.version,
      commit: options.commit,
      publishedAt,
      releaseUrl: options["release-url"],
      upgradeGuideUrl: options["upgrade-guide-url"],
      artifacts,
    });
    const payload = canonicalizeJson(manifest);
    const privateKeyBase64 =
      process.env.RELEASE_SIGNING_PRIVATE_KEY_BASE64;
    if (!privateKeyBase64) {
      fail("RELEASE_SIGNING_PRIVATE_KEY_BASE64 is required in the signing step");
    }
    const signature = signManifest({
      payload,
      privateKeyBase64,
      expectedPublicKeyBase64: configuredPublicKey,
    });
    if (
      !verifyManifestSignature({
        payload,
        signature,
        publicKeyBase64: configuredPublicKey,
      })
    ) {
      fail("generated manifest signature did not verify with the fixed public key");
    }

    const outputDirectory = path.resolve(options["output-dir"]);
    await writeFile(
      path.join(outputDirectory, "update-manifest.json"),
      payload,
      "utf8",
    );
    await writeFile(
      path.join(outputDirectory, "update-manifest.json.sig"),
      signature,
    );
    console.log(
      JSON.stringify({
        version: manifest.version,
        commit: manifest.commit,
        publicKeyFingerprintSha256: fixedKey.fingerprintSha256,
        manifestSha256: createHash("sha256")
          .update(payload)
          .digest("hex"),
        signatureBytes: signature.length,
      }),
    );
  } catch (error) {
    console.error(
      `Manifest build failed: ${error instanceof Error ? error.message : "unknown error"}`,
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
