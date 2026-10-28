import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  extractVerifiedArchive,
  inspectArchive,
  openVerifiedArchive,
} from "@filestation/update-core";
import {
  loadInstallEnvironment,
  ManagedInstallMetadata,
  validateManagedLaunch,
} from "../src/launcher";
import { NodeDurableFileSystem } from "../src/platform/durable-fs";

jest.setTimeout(480_000);

const repositoryRoot = path.resolve(__dirname, "../../..");
const currentPlatform =
  process.platform === "win32" ? "windows-x64" : "linux-x64";

interface PreparedArchive {
  platform: "windows-x64" | "linux-x64";
  format: "zip" | "tar.gz";
  archivePath: string;
  archiveRoot: string;
  archiveMemberRoot: string;
  archiveSize: number;
  unpackedSize: number;
  sha256: string;
}

async function runNode(
  arguments_: string[],
  cwd: string,
  label: string,
  timeoutMs = 360_000,
): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, arguments_, {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const startedAt = Date.now();
  const progress = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(`${label} still running (${elapsed}s)`);
  }, 15_000);
  progress.unref();
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`node command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  } finally {
    if (timer) clearTimeout(timer);
    clearInterval(progress);
  }
  return { code: child.exitCode, output };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function prepareArchives(
  root: string,
  version: string,
  platform: "windows-x64" | "linux-x64",
): Promise<PreparedArchive[]> {
  const prepared: PreparedArchive[] = [];
  {
    const output = path.join(root, "archives");
    const extracted = path.join(root, `extract-${platform}`);
    const result = await runNode(
      [
        "scripts/release/package-artifact.mjs",
        "--version",
        version,
        "--platform",
        platform,
        "--output",
        output,
        "--source-date-epoch",
        "1704067200",
        "--install-production",
        "--release-url",
        `https://github.com/example/FileStation/releases/tag/v${version}`,
      ],
      repositoryRoot,
      `package ${platform}`,
    );
    if (result.code !== 0) {
      throw new Error(`artifact packaging failed:\n${result.output}`);
    }
    const metadata = JSON.parse(
      await readFile(
        path.join(output, `artifact-metadata-${platform}.json`),
        "utf8",
      ),
    ) as {
      filename: string;
      archive_size: number;
      unpacked_size: number;
      sha256: string;
      format: "zip" | "tar.gz";
    };
    const archivePath = path.join(output, metadata.filename);
    const handle = await openVerifiedArchive(archivePath, metadata.sha256);
    try {
      const plan = await inspectArchive(handle, {
        format: metadata.format,
        version,
        platform,
        unpackedSize: metadata.unpacked_size,
        maxArchiveBytes: metadata.archive_size,
        maxTotalBytes: metadata.unpacked_size,
      });
      await extractVerifiedArchive(handle, plan, extracted);
    } finally {
      await handle.close();
    }
    prepared.push({
      platform,
      format: metadata.format,
      archivePath,
      // extractVerifiedArchive strips the publisher archive root and writes
      // the relocatable install root directly into the random destination.
      archiveRoot: extracted,
      archiveMemberRoot: `filestation-v${version}-${
        platform === "windows-x64" ? "win" : "linux"
      }-x64`,
      archiveSize: metadata.archive_size,
      unpackedSize: metadata.unpacked_size,
      sha256: metadata.sha256,
    });
  }
  return prepared;
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else files.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
  await walk(root);
  return files.sort();
}

function assertRelocatableLayout(root: string, files: string[]): void {
  for (const required of [
    "apps/server/dist/main.js",
    "apps/updater/dist/cli.js",
    "apps/updater/dist/launcher.js",
    "apps/web/dist-root/index.html",
    "apps/web/dist-fs/index.html",
    "packages/shared/dist/index.js",
    "packages/update-core/dist/index.js",
    "apps/server/package.json",
    "apps/web/package.json",
    "apps/updater/package.json",
    "packages/shared/package.json",
    "packages/update-core/package.json",
    "scripts/bootstrap-update.ps1",
    "scripts/bootstrap-update.sh",
    "scripts/start-filestation.ps1",
    "scripts/start-filestation.sh",
    "scripts/release/smoke-artifact.mjs",
  ]) {
    expect(
      files.includes(required) ||
        (required.endsWith("dist/main.js") &&
          files.some(
            (file) =>
              file.startsWith(path.dirname(required).replaceAll("\\", "/")) &&
              file.endsWith("/main.js"),
          )),
    ).toBe(true);
    expect(path.resolve(root, required).startsWith(root)).toBe(true);
  }
}

function findZipTarget(
  bytes: Buffer,
  target: string,
): number[] {
  const needle = Buffer.from(target, "utf8");
  const offsets: number[] = [];
  for (
    let offset = bytes.indexOf(needle);
    offset >= 0;
    offset = bytes.indexOf(needle, offset + 1)
  ) {
    offsets.push(offset);
  }
  return offsets;
}

function findTarHeader(bytes: Buffer, member: string): number {
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    if (bytes.subarray(offset, offset + 512).every((value) => value === 0)) {
      break;
    }
    const name = bytes
      .subarray(offset, offset + 100)
      .toString("utf8")
      .replace(/\0.*$/u, "");
    if (name === member) return offset;
    const size = Number.parseInt(
      bytes
        .subarray(offset + 124, offset + 136)
        .toString("ascii")
        .replace(/(?:\u0000| )+$/u, ""),
      8,
    );
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return -1;
}

function updateTarChecksum(bytes: Buffer, offset: number): void {
  bytes.fill(0x20, offset + 148, offset + 156);
  let checksum = 0;
  for (let index = offset; index < offset + 512; index += 1) {
    checksum += bytes[index];
  }
  const encoded = checksum.toString(8).padStart(7, "0");
  bytes.write(encoded, offset + 148, "ascii");
  bytes[offset + 155] = 0;
}

async function mutateArchive(
  source: string,
  destination: string,
  format: "zip" | "tar.gz",
  mutate: (bytes: Buffer) => void,
): Promise<{ filename: string; digest: string }> {
  const sourceBytes = await readFile(source);
  const bytes =
    format === "tar.gz" ? gunzipSync(sourceBytes) : Buffer.from(sourceBytes);
  mutate(bytes);
  const archive =
    format === "tar.gz"
      ? gzipSync(bytes, { level: 9 })
      : bytes;
  await writeFile(destination, archive, { mode: 0o600 });
  return { filename: destination, digest: sha256(archive) };
}

describe("relocatable release artifacts", () => {
  let root: string;
  let version: string;
  let archives: PreparedArchive[];

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "filestation-artifact-test-"));
    version = JSON.parse(
      await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
    ).version;
    archives = await prepareArchives(root, version, currentPlatform);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it(
    "relocates the host platform archive without runtime or forbidden members",
    async () => {
      const archive = archives.find(
        (entry) => entry.platform === currentPlatform,
      )!;
      const files = await listRelativeFiles(archive.archiveRoot);
      assertRelocatableLayout(archive.archiveRoot, files);
      for (const file of files) {
        const parts = file.split("/").map((part) => part.toLowerCase());
        expect(parts[0]).not.toBe("data");
        expect(
          parts.some((part) =>
            ["logs", "test", "tests", "__tests__"].includes(part),
          ),
        ).toBe(false);
        expect(parts.at(-1)).not.toMatch(/^\.env(?:\.|$)/);
        expect(parts.at(-1)).not.toMatch(/\.log$/);
      }
      expect(archive.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(archive.archiveSize).toBeGreaterThan(0);
      expect(archive.unpackedSize).toBeGreaterThan(archive.archiveSize);
    },
  );

  it("loads native sqlite/bcrypt and the shipped application from an absolute install root", async () => {
    const archive = archives.find(
      (entry) => entry.platform === currentPlatform,
    )!;
    const result = await runNode(
      [
        path.join(archive.archiveRoot, "scripts/release/smoke-artifact.mjs"),
        "--artifact-root",
        archive.archiveRoot,
      ],
      archive.archiveRoot,
      "artifact smoke",
    );
    if (result.code !== 0) {
      throw new Error(`artifact smoke failed:\n${result.output}`);
    }
    const smoke = JSON.parse(result.output.trim().split(/\r?\n/u).at(-1)!);
    expect(smoke).toMatchObject({
      version,
      nativeVersions: {
        sqlite3: expect.any(String),
        bcrypt: expect.any(String),
      },
      publicSettings: "ok",
      staticIndex: "ok",
      referencedAsset: "ok",
      webBundles: {
        root: {
          index: "ok",
          asset: "ok",
          bootstrap: "ok",
          cache: "ok",
        },
        fs: {
          index: "ok",
          asset: "ok",
          api: "ok",
          router: "ok",
          bootstrap: "ok",
          cache: "ok",
        },
      },
    });
  });

  it("uses .env after relocation while process values win and rejects wrong cwd", async () => {
    const archive = archives.find(
      (entry) => entry.platform === currentPlatform,
    )!;
    const managedRoot = path.join(root, "managed-install");
    const releasesRoot = path.join(managedRoot, "releases");
    const release = path.join(releasesRoot, `v${version}-test`);
    const paths = {
      database: path.join(managedRoot, "data/filestation.db"),
      storage: path.join(managedRoot, "data/storage"),
      temp: path.join(managedRoot, "data/temp"),
    };
    await mkdir(releasesRoot, { recursive: true });
    await rename(archive.archiveRoot, release);
    const currentPath = path.join(managedRoot, "current");
    await new NodeDurableFileSystem()
      .createJunction(release, currentPath)
      .catch(() => new NodeDurableFileSystem().symlink(release, currentPath));
    await writeFile(
      path.join(managedRoot, ".env"),
      [
        "NODE_ENV=development",
        "JWT_SECRET=dotenv-only-value",
        "FILESTATION_PORT=9123",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const metadata: ManagedInstallMetadata = {
      schemaVersion: 1,
      installId: "artifact-smoke",
      installRoot: managedRoot,
      currentPath,
      environmentPath: path.join(managedRoot, ".env"),
      paths,
      bootstrapBackupId: "bootstrap",
      bootstrapFingerprint: "a".repeat(64),
      createdAt: new Date().toISOString(),
      productionEnvironment: {
        nodeEnv: "production",
        required: ["NODE_ENV", "JWT_SECRET"],
        source: "dotenv",
      },
    };
    await writeFile(
      path.join(managedRoot, "managed-install.json"),
      `${JSON.stringify(metadata)}\n`,
      { mode: 0o600 },
    );
    const processEnvironment = {
      NODE_ENV: "production",
      JWT_SECRET: "process-wins",
    };
    const loaded = await loadInstallEnvironment(managedRoot, {
      processEnvironment,
    });
    expect(loaded.values).toMatchObject({
      NODE_ENV: "production",
      JWT_SECRET: "process-wins",
      FILESTATION_PORT: "9123",
    });
    const executableRealpath = await realpath(
      path.join(release, "apps/server/dist/main.js"),
    );
    const currentRealpath = await realpath(currentPath);
    expect(() =>
      validateManagedLaunch({
        cwd: currentPath,
        executableRealpath,
        currentRealpath,
        installMetadata: metadata,
        configuredPaths: paths,
        environment: loaded.values,
        processEnvironment,
      }),
    ).toThrow(/installation root as cwd|current\/|release/i);
    const plan = validateManagedLaunch({
      cwd: managedRoot,
      executableRealpath,
      currentRealpath,
      installMetadata: metadata,
      configuredPaths: paths,
      environment: loaded.values,
      processEnvironment,
    });
    expect(plan).toMatchObject({
      installRoot: managedRoot,
      releaseRealpath: currentRealpath,
      environment: {
        FILESTATION_INSTALL_ROOT: managedRoot,
        FILESTATION_RELEASE_ROOT: currentRealpath,
      },
    });
  });

  it("rejects archive traversal, special member types, and over-budget input", async () => {
    const archive = archives.find(
      (entry) => entry.platform === currentPlatform,
    )!;
    const original = await readFile(archive.archivePath);
    const packageMember = `${archive.archiveMemberRoot}/package.json`;
    const traversalMember = `${archive.archiveMemberRoot}/../packag.js`;
    expect(Buffer.byteLength(traversalMember)).toBe(
      Buffer.byteLength(packageMember),
    );

    const traversal = await mutateArchive(
      archive.archivePath,
      path.join(root, `traversal.${archive.format}`),
      archive.format,
      (bytes) => {
        if (archive.format === "zip") {
          const offsets = findZipTarget(bytes, packageMember);
          expect(offsets).toHaveLength(2);
          for (const offset of offsets) {
            bytes.write(
              traversalMember,
              offset,
              Buffer.byteLength(traversalMember),
            );
          }
        } else {
          const header = findTarHeader(bytes, packageMember);
          expect(header).toBeGreaterThanOrEqual(0);
          bytes.write(
            traversalMember,
            header,
            Buffer.byteLength(traversalMember),
          );
          updateTarChecksum(bytes, header);
        }
      },
    );
    const traversalHandle = await openVerifiedArchive(
      traversal.filename,
      traversal.digest,
    );
    try {
      await expect(
        inspectArchive(traversalHandle, {
          format: archive.format,
          version,
          platform: archive.platform,
          unpackedSize: archive.unpackedSize,
        }),
      ).rejects.toThrow(/path component|unsafe archive/i);
    } finally {
      await traversalHandle.close();
    }

    const special = await mutateArchive(
      archive.archivePath,
      path.join(root, `special.${archive.format}`),
      archive.format,
      (bytes) => {
        if (archive.format === "zip") {
          let changed = 0;
          const endOffset = bytes.lastIndexOf(
            Buffer.from([0x50, 0x4b, 0x05, 0x06]),
          );
          expect(endOffset).toBeGreaterThanOrEqual(0);
          const entryCount = bytes.readUInt16LE(endOffset + 10);
          let offset = bytes.readUInt32LE(endOffset + 16);
          for (let index = 0; index < entryCount; index += 1) {
            expect(bytes.readUInt32LE(offset)).toBe(0x02014b50);
            const nameLength = bytes.readUInt16LE(offset + 28);
            const extraLength = bytes.readUInt16LE(offset + 30);
            const commentLength = bytes.readUInt16LE(offset + 32);
            const name = bytes
              .subarray(offset + 46, offset + 46 + nameLength)
              .toString("utf8");
            if (name === packageMember) {
              bytes.writeUInt32LE((0o120777 << 16) >>> 0, offset + 38);
              changed += 1;
            }
            offset += 46 + nameLength + extraLength + commentLength;
          }
          expect(changed).toBe(1);
        } else {
          const header = findTarHeader(bytes, packageMember);
          expect(header).toBeGreaterThanOrEqual(0);
          bytes[header + 156] = "1".charCodeAt(0);
          updateTarChecksum(bytes, header);
        }
      },
    );
    const specialHandle = await openVerifiedArchive(
      special.filename,
      special.digest,
    );
    try {
      await expect(
        inspectArchive(specialHandle, {
          format: archive.format,
          version,
          platform: archive.platform,
          unpackedSize: archive.unpackedSize,
        }),
      ).rejects.toThrow(/special member|unsafe archive/i);
    } finally {
      await specialHandle.close();
    }

    const sizeHandle = await openVerifiedArchive(
      archive.archivePath,
      sha256(original),
    );
    try {
      await expect(
        inspectArchive(sizeHandle, {
          format: archive.format,
          version,
          platform: archive.platform,
          unpackedSize: archive.unpackedSize,
          maxArchiveBytes: original.length - 1,
        }),
      ).rejects.toThrow(/compressed size limit|unsafe archive/i);
    } finally {
      await sizeHandle.close();
    }
  });
});
