import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateRawSync, gzipSync } from "node:zlib";
import { parseStableSemver, ReleaseValidationError } from "./validate-version.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const PLATFORM_DEFINITIONS = {
  "linux-x64": {
    os: "linux",
    suffix: "linux-x64",
    extension: "tar.gz",
    format: "tar.gz",
  },
  "windows-x64": {
    os: "windows",
    suffix: "win-x64",
    extension: "zip",
    format: "zip",
  },
};
const REQUIRED_ARTIFACT_FILES = [
  "package.json",
  "package-lock.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/shared/package.json",
  "apps/server/dist/main.js",
  "apps/web/dist/index.html",
  "packages/shared/dist/index.js",
  "scripts/release/smoke-artifact.mjs",
  "scripts/release/create-smoke-db.mjs",
];
const OPTIONAL_ROOT_FILES = ["CHANGELOG.md", "LICENSE", "README.md"];
const BANNED_SEGMENTS = new Set([
  "logs",
  "test",
  "tests",
  "__tests__",
]);

function fail(message) {
  throw new ReleaseValidationError(message);
}

function platformDefinition(platform) {
  const definition = PLATFORM_DEFINITIONS[platform];
  if (!definition) fail(`unsupported platform ${platform}`);
  return definition;
}

export function isForbiddenArtifactPath(relativePath) {
  const segments = relativePath
    .split(path.sep)
    .join("/")
    .split("/")
    .filter(Boolean);
  const basename = segments.at(-1)?.toLowerCase() ?? "";
  if (segments[0]?.toLowerCase() === "data") return true;
  if (
    segments.some((segment) => {
      const normalized = segment.toLowerCase();
      return (
        BANNED_SEGMENTS.has(normalized) ||
        normalized === ".env" ||
        normalized.startsWith(".env.")
      );
    })
  ) {
    return true;
  }
  return (
    basename.endsWith(".log") ||
    basename === ".env" ||
    basename.startsWith(".env.") ||
    /\.(?:test|spec)\.[^/]+$/u.test(basename)
  );
}

export function artifactFilename(version, platform) {
  const definition = platformDefinition(platform);
  return `filestation-v${parseStableSemver(version).raw}-${definition.suffix}.${definition.extension}`;
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function findOnPath(names, pathValue) {
  for (const directory of String(pathValue ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (await pathExists(candidate)) return candidate;
    }
  }
  return null;
}

export async function resolveNpmInvocation(resolutionOptions = {}) {
  const {
    platform = process.platform,
    execPath = process.execPath,
    env = process.env,
  } = resolutionOptions;
  if (env.npm_execpath && (await pathExists(env.npm_execpath))) {
    return {
      command: execPath,
      argsPrefix: [path.resolve(env.npm_execpath)],
      shell: false,
    };
  }

  if (platform === "win32") {
    const pathValue = env.PATH ?? env.Path ?? env.path;
    const npmCommand = await findOnPath(["npm.cmd", "npm.exe", "npm"], pathValue);
    if (npmCommand) {
      const npmCli = path.join(
        path.dirname(npmCommand),
        "node_modules/npm/bin/npm-cli.js",
      );
      if (await pathExists(npmCli)) {
        return {
          command: execPath,
          argsPrefix: [npmCli],
          shell: false,
        };
      }
      return {
        command: npmCommand,
        argsPrefix: [],
        shell: true,
      };
    }
  }

  return { command: "npm", argsPrefix: [], shell: false };
}

async function copyRequiredFile(sourceRoot, destination, relativePath) {
  const source = path.join(sourceRoot, relativePath);
  if (!(await pathExists(source))) {
    fail(`required artifact input is missing: ${relativePath}`);
  }
  const target = path.join(destination, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
}

async function copyDirectory(sourceRoot, destination, relativePath) {
  const source = path.join(sourceRoot, relativePath);
  if (!(await pathExists(source))) {
    fail(`required artifact input is missing: ${relativePath}`);
  }
  const target = path.join(destination, relativePath);
  await cp(source, target, {
    recursive: true,
    dereference: true,
    filter: (sourcePath) => {
      const relativePath = path
        .relative(source, sourcePath)
        .split(path.sep)
        .join("/");
      return relativePath === "" || !isForbiddenArtifactPath(relativePath);
    },
  });
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

export async function prepareArtifactDirectory({
  repositoryRoot,
  destination,
  version,
  platform,
  productionNodeModulesDirectory = null,
}) {
  const resolvedRepository = path.resolve(repositoryRoot);
  const resolvedDestination = path.resolve(destination);
  if (
    resolvedDestination === path.parse(resolvedDestination).root ||
    resolvedDestination === resolvedRepository ||
    isWithin(resolvedDestination, resolvedRepository) ||
    isWithin(resolvedRepository, resolvedDestination)
  ) {
    fail("artifact destination must be a dedicated directory outside the source tree");
  }
  platformDefinition(platform);
  const normalizedVersion = parseStableSemver(version).raw;

  await rm(resolvedDestination, { recursive: true, force: true });
  await mkdir(resolvedDestination, { recursive: true });

  for (const file of [
    "package.json",
    "package-lock.json",
    "apps/server/package.json",
    "apps/web/package.json",
    "packages/shared/package.json",
    `release-notes/v${normalizedVersion}.json`,
    "scripts/release/smoke-artifact.mjs",
    "scripts/release/create-smoke-db.mjs",
  ]) {
    await copyRequiredFile(resolvedRepository, resolvedDestination, file);
  }
  for (const directory of [
    "apps/server/dist",
    "apps/web/dist",
    "packages/shared/dist",
  ]) {
    await copyDirectory(resolvedRepository, resolvedDestination, directory);
  }
  for (const file of OPTIONAL_ROOT_FILES) {
    if (await pathExists(path.join(resolvedRepository, file))) {
      await copyRequiredFile(resolvedRepository, resolvedDestination, file);
    }
  }

  const rootManifestPath = path.join(resolvedDestination, "package.json");
  const rootManifest = JSON.parse(await readFile(rootManifestPath, "utf8"));
  if (rootManifest.version !== normalizedVersion) {
    fail("source root package version does not match the artifact version");
  }
  rootManifest.scripts = {
    ...(rootManifest.scripts ?? {}),
    start: "node apps/server/dist/main.js",
    "start:bynginx": "node apps/server/dist/main.js",
    "smoke:artifact": "node scripts/release/smoke-artifact.mjs",
  };
  await writeFile(
    rootManifestPath,
    `${JSON.stringify(rootManifest, null, 2)}\n`,
    "utf8",
  );

  if (productionNodeModulesDirectory) {
    const sourceNodeModules = path.resolve(productionNodeModulesDirectory);
    if (!(await pathExists(sourceNodeModules))) {
      fail(`production node_modules directory is missing: ${sourceNodeModules}`);
    }
    await cp(sourceNodeModules, path.join(resolvedDestination, "node_modules"), {
      recursive: true,
      dereference: true,
      filter: (sourcePath) => {
        const relativePath = path
          .relative(sourceNodeModules, sourcePath)
          .split(path.sep)
          .filter(Boolean)
          .join("/");
        return (
          relativePath === "" ||
          !isForbiddenArtifactPath(`node_modules/${relativePath}`)
        );
      },
    });
  }

  return resolvedDestination;
}

async function collectFiles(root) {
  const files = [];
  const recursionStack = new Set();
  async function walk(directory) {
    const resolvedDirectory = await realpath(directory);
    if (recursionStack.has(resolvedDirectory)) {
      fail(`artifact staging contains a symlink cycle at ${directory}`);
    }
    recursionStack.add(resolvedDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const metadata = await stat(absolute);
      if (metadata.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (metadata.isFile()) {
        files.push(absolute);
        continue;
      }
      fail(`artifact staging contains unsupported file type: ${absolute}`);
    }
    recursionStack.delete(resolvedDirectory);
  }
  await walk(root);
  return files.sort((left, right) =>
    path
      .relative(root, left)
      .split(path.sep)
      .join("/")
      .localeCompare(path.relative(root, right).split(path.sep).join("/")),
  );
}

function validateRelativePath(relativePath) {
  const segments = relativePath.split("/");
  if (
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    segments.includes("..")
  ) {
    fail(`artifact contains forbidden path: ${relativePath}`);
  }
}

async function loadArtifactFiles(sourceRoot) {
  for (const required of REQUIRED_ARTIFACT_FILES) {
    if (!(await pathExists(path.join(sourceRoot, required)))) {
      fail(`artifact is missing required file: ${required}`);
    }
  }
  const files = await collectFiles(sourceRoot);
  const entries = [];
  for (const absolutePath of files) {
    const relativePath = path
      .relative(sourceRoot, absolutePath)
      .split(path.sep)
      .join("/");
    if (isForbiddenArtifactPath(relativePath)) continue;
    validateRelativePath(relativePath);
    entries.push({
      absolutePath,
      relativePath,
      content: await readFile(absolutePath),
    });
  }
  return entries;
}

let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    crcTable[index] = value >>> 0;
  }
  return crcTable;
}

function crc32(buffer) {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(epochSeconds) {
  const date = new Date(Math.max(epochSeconds, 315532800) * 1000);
  const year = Math.max(date.getUTCFullYear(), 1980);
  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2),
    date:
      ((year - 1980) << 9) |
      ((date.getUTCMonth() + 1) << 5) |
      date.getUTCDate(),
  };
}

function createZip(entries, sourceDateEpoch) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const timestamp = dosDateTime(sourceDateEpoch);

  for (const entry of entries) {
    const name = Buffer.from(entry.archivePath, "utf8");
    const compressed = deflateRawSync(entry.content, { level: 9 });
    const checksum = crc32(entry.content);
    if (
      entry.content.length > 0xffffffff ||
      compressed.length > 0xffffffff ||
      offset > 0xffffffff
    ) {
      fail("ZIP artifact exceeds the 32-bit ZIP size limit");
    }

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(timestamp.time, 10);
    localHeader.writeUInt16LE(timestamp.date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(timestamp.time, 12);
    centralHeader.writeUInt16LE(timestamp.date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const localDirectory = Buffer.concat(localParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localDirectory.length, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([localDirectory, centralDirectory, end]);
}

function writeAscii(buffer, value, offset, length) {
  const source = Buffer.from(value, "ascii");
  if (source.length > length) fail(`tar field is too long: ${value}`);
  source.copy(buffer, offset);
}

function writeOctal(buffer, value, offset, length) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length !== length - 1) {
    fail(`tar numeric field overflows at offset ${offset}`);
  }
  writeAscii(buffer, encoded, offset, length - 1);
  buffer[offset + length - 1] = 0;
}

function splitTarPath(value) {
  if (Buffer.byteLength(value, "utf8") <= 100) return { name: value, prefix: "" };
  for (let index = value.lastIndexOf("/"); index > 0; index = value.lastIndexOf("/", index - 1)) {
    const prefix = value.slice(0, index);
    const name = value.slice(index + 1);
    if (
      Buffer.byteLength(prefix, "utf8") <= 155 &&
      Buffer.byteLength(name, "utf8") <= 100
    ) {
      return { name, prefix };
    }
  }
  fail(`tar path is too long for USTAR: ${value}`);
}

function createTarHeader(archivePath, size, sourceDateEpoch) {
  const header = Buffer.alloc(512, 0);
  const { name, prefix } = splitTarPath(archivePath);
  writeAscii(header, name, 0, 100);
  writeOctal(header, 0o644, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, size, 124, 12);
  writeOctal(header, Math.max(0, sourceDateEpoch), 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeAscii(header, "ustar", 257, 6);
  header[263] = "0".charCodeAt(0);
  header[264] = "0".charCodeAt(0);
  writeAscii(header, prefix, 345, 155);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeOctal(header, checksum, 148, 8);
  return header;
}

function createTarGz(entries, sourceDateEpoch) {
  const members = [];
  for (const entry of entries) {
    members.push(
      createTarHeader(entry.archivePath, entry.content.length, sourceDateEpoch),
      entry.content,
    );
    const padding = (512 - (entry.content.length % 512)) % 512;
    if (padding > 0) members.push(Buffer.alloc(padding, 0));
  }
  members.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(members), {
    level: 9,
    mtime: 0,
  });
}

export async function packageArtifact({
  sourceRoot,
  outputDirectory,
  version,
  platform,
  sourceDateEpoch,
}) {
  const definition = platformDefinition(platform);
  const normalizedVersion = parseStableSemver(version).raw;
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) {
    fail("sourceDateEpoch must be a non-negative safe integer");
  }
  const resolvedSource = path.resolve(sourceRoot);
  const resolvedOutput = path.resolve(outputDirectory);
  const artifactRootName = `filestation-v${normalizedVersion}-${definition.suffix}`;
  const files = await loadArtifactFiles(resolvedSource);
  const entries = files.map((file) => ({
    content: file.content,
    archivePath: `${artifactRootName}/${file.relativePath}`,
  }));
  const archive = definition.format === "zip"
    ? createZip(entries, sourceDateEpoch)
    : createTarGz(entries, sourceDateEpoch);
  const filename = artifactFilename(normalizedVersion, platform);
  const archivePath = path.join(resolvedOutput, filename);
  await mkdir(resolvedOutput, { recursive: true });
  await writeFile(archivePath, archive);
  if (definition.os === "linux") await chmod(archivePath, 0o644);
  const unpackedSize = files.reduce((total, file) => total + file.content.length, 0);
  return {
    archivePath,
    filename,
    platform,
    os: definition.os,
    arch: "x64",
    format: definition.format,
    archiveSize: archive.length,
    unpackedSize,
    fileCount: files.length,
    sha256: createHash("sha256").update(archive).digest("hex"),
  };
}

export function parsePackageArguments(arguments_) {
  const options = {};
  const flagOptions = new Set(["install-production"]);
  for (let index = 0; index < arguments_.length;) {
    const key = arguments_[index];
    if (!key?.startsWith("--")) {
      fail(
        "usage: package-artifact.mjs --version <semver> --platform <linux-x64|windows-x64> --output <dir> --source-date-epoch <seconds> [--production-node-modules <dir> | --install-production] --release-url <url>",
      );
    }
    const name = key.slice(2);
    if (flagOptions.has(name)) {
      options[name] = true;
      index += 1;
      continue;
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`--${name} requires a value`);
    }
    options[name] = value;
    index += 2;
  }
  return options;
}

async function installProductionDependencies(stagingRoot) {
  const invocation = await resolveNpmInvocation();
  const result = spawnSync(
    invocation.command,
    [
      ...invocation.argsPrefix,
      "ci",
      "--omit=dev",
      "--ignore-scripts=false",
      "--no-audit",
      "--no-fund",
      "--workspaces",
    ],
    {
      cwd: stagingRoot,
      stdio: "inherit",
      windowsHide: true,
      shell: invocation.shell,
    },
  );
  if (result.status !== 0) {
    fail(
      `production dependency installation failed with status ${result.status}` +
        (result.error ? `: ${result.error.code ?? result.error.message}` : ""),
    );
  }
}

export async function main() {
  try {
    const options = parsePackageArguments(process.argv.slice(2));
    for (const required of [
      "version",
      "platform",
      "output",
      "source-date-epoch",
      "release-url",
    ]) {
      if (!options[required]) fail(`--${required} is required`);
    }
    const sourceDateEpoch = Number(options["source-date-epoch"]);
    const stagingRoot = await mkdtemp(
      path.join(tmpdir(), `filestation-release-stage-${options.platform}-`),
    );
    await prepareArtifactDirectory({
      repositoryRoot: REPOSITORY_ROOT,
      destination: stagingRoot,
      version: options.version,
      platform: options.platform,
      productionNodeModulesDirectory: options["production-node-modules"] ?? null,
    });
    if (options["install-production"]) {
      await installProductionDependencies(stagingRoot);
    } else if (!options["production-node-modules"]) {
      fail("supply --install-production or --production-node-modules");
    }

    const result = await packageArtifact({
      sourceRoot: stagingRoot,
      outputDirectory: path.resolve(REPOSITORY_ROOT, options.output),
      version: options.version,
      platform: options.platform,
      sourceDateEpoch,
    });
    const releaseBase = options["release-url"].replace(/\/releases\/tag\//, "/releases/download/");
    const metadata = {
      platform: result.platform,
      os: result.os,
      arch: result.arch,
      filename: result.filename,
      url: `${releaseBase}/${result.filename}`,
      archive_size: result.archiveSize,
      unpacked_size: result.unpackedSize,
      sha256: result.sha256,
      format: result.format,
    };
    await writeFile(
      path.join(path.resolve(REPOSITORY_ROOT, options.output), `artifact-metadata-${result.platform}.json`),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );
    console.log(JSON.stringify({ ...metadata, fileCount: result.fileCount }));
    await rm(stagingRoot, { recursive: true, force: true });
  } catch (error) {
    console.error(
      `Artifact packaging failed: ${error instanceof Error ? error.message : "unknown error"}`,
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
