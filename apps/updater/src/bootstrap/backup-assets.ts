import { createHash } from "node:crypto";
import path from "node:path";
import type { DurableFileSystem } from "../platform/durable-fs";
import type { ManagedInstallMetadata } from "../launcher";
import { ManagedInstallPaths, pathWithin, sameCanonicalPath } from "./path-plan";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function syncRecoveryTree(root: string, fs: DurableFileSystem): Promise<void> {
  for (const name of await fs.readdir(root)) {
    const filename = path.join(root, name);
    const entry = await fs.lstat(filename);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await syncRecoveryTree(filename, fs);
    else if (entry.isFile()) await fs.syncFile(filename);
    else throw new Error("unsupported recovery asset");
  }
  await fs.fsyncDirectory(root);
  await fs.fsyncDirectory(path.dirname(root));
}

export async function verifyExistingBootstrap(
  metadata: ManagedInstallMetadata, planned: ManagedInstallPaths,
  release: string, current: string, fs: DurableFileSystem, previous: ManagedInstallPaths,
): Promise<void> {
  for (const key of ["database", "storage", "temp"] as const) {
    if (!sameCanonicalPath(metadata.paths[key], planned[key]))
      throw new Error("bootstrap metadata paths differ from the approved plan");
  }
  if (!sameCanonicalPath(current, release)) throw new Error("bootstrap current is not the expected release");
  const backup = path.join(metadata.installRoot, "backups", metadata.bootstrapBackupId);
  const manifest = JSON.parse((await fs.readFile(path.join(backup, "MANIFEST.json"))).toString("utf8"));
  if (manifest.copyPolicyVersion !== 2)
    throw new Error("bootstrap backup copy policy is obsolete or missing");
  if (manifest.schemaVersion !== 1 || manifest.kind !== "bootstrap-backup" ||
      manifest.backupId !== metadata.bootstrapBackupId || manifest.installId !== metadata.installId ||
      JSON.stringify(manifest.canonicalPaths) !== JSON.stringify(planned) ||
      JSON.stringify(manifest.originalCanonicalPaths) !== JSON.stringify(previous) ||
      !sameCanonicalPath(manifest.snapshot?.database ?? "", previous.database) ||
      manifest.snapshotReceipt?.sourceIntegrity !== "ok" || manifest.snapshotReceipt?.snapshotIntegrity !== "ok" ||
      manifest.snapshotReceipt?.sourceForeignKeys !== 0 || manifest.snapshotReceipt?.snapshotForeignKeys !== 0)
    throw new Error("bootstrap backup manifest or integrity receipt is inconsistent");
  const verifyFile = async (filename: string, hash: string, size: number) => {
    const entry = await fs.lstat(filename);
    if (!entry.isFile() || entry.size !== size || sha256(await fs.readFile(filename)) !== hash)
      throw new Error("bootstrap recovery asset hash or size differs from verified manifest");
  };
  if (manifest.snapshot?.storedPath !== "database.sqlite") throw new Error("invalid bootstrap snapshot manifest");
  await verifyFile(path.join(backup, "database.sqlite"), manifest.snapshot.sha256, manifest.snapshot.bytes);
  if (!sameCanonicalPath(previous.database, planned.database)) {
    const target = manifest.targetSnapshot;
    if (target?.storedPath !== "target-database.sqlite" || !sameCanonicalPath(target.database, planned.database) ||
        target.receipt?.sourceIntegrity !== "ok" || target.receipt?.snapshotIntegrity !== "ok" || target.receipt?.sourceForeignKeys !== 0 || target.receipt?.snapshotForeignKeys !== 0)
      throw new Error("relocated target verification manifest is inconsistent");
    await verifyFile(path.join(backup, target.storedPath), target.sha256, target.bytes);
  }
  if (manifest.env?.storedPath) {
    if (manifest.env.storedPath !== "env/legacy.env") throw new Error("invalid env backup path");
    await verifyFile(path.join(backup, "env/legacy.env"), manifest.env.sha256, manifest.env.size);
  } else if (manifest.env?.present !== false) throw new Error("invalid env backup manifest");
  if (!Array.isArray(manifest.updaterEntries) || !(manifest.nodeModulesEntries === null || Array.isArray(manifest.nodeModulesEntries)))
    throw new Error("bootstrap standalone copy manifest missing");
  for (const [tree, entries, linkBoundary, required] of [
    [path.join(backup, "legacy-source"), manifest.sourceEntries, path.join(backup, "legacy-source"), true],
    [release, manifest.releaseEntries, release, true],
    [path.join(metadata.installRoot, "updater"), manifest.updaterEntries, path.join(metadata.installRoot, "updater"), true],
    ...(manifest.nodeModulesEntries === null ? [] : [[path.join(metadata.installRoot, "node_modules"), manifest.nodeModulesEntries, release, false]]),
  ] as const) {
    if (!Array.isArray(entries) || (required && !entries.length)) throw new Error("bootstrap recovery tree manifest missing");
    for (const entry of entries) {
      if (typeof entry.path !== "string" || path.isAbsolute(entry.path) || !pathWithin(tree, path.resolve(tree, entry.path)))
        throw new Error("invalid bootstrap manifest entry path");
      const filename = path.join(tree, entry.path);
      if (entry.type === "file") await verifyFile(filename, entry.sha256, entry.size);
      else if (entry.type === "symlink") {
        if (typeof entry.target !== "string" || !(await fs.lstat(filename)).isSymbolicLink() ||
            !pathWithin(linkBoundary, await fs.realpath(filename)) ||
            !sameCanonicalPath(path.resolve(path.dirname(filename), await fs.readlink(filename)), path.resolve(path.dirname(filename), entry.target)))
          throw new Error("bootstrap dependency link escaped its recovery tree");
      } else throw new Error("invalid bootstrap manifest entry type");
    }
  }
}
