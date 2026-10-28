import { rm } from "node:fs/promises";
import path from "node:path";
import {
  AttemptJournalSnapshot,
} from "../state/attempt-journal";
import {
  DurableFileSystem,
  NodeDurableFileSystem,
} from "../platform/durable-fs";

export interface CleanupResult {
  eligible: boolean;
  deleted: string[];
  retained: string[];
}

const BACKUP_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function within(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function verifiedRestart(snapshot: AttemptJournalSnapshot): boolean {
  if (
    snapshot.phase !== "COMMITTED" ||
    snapshot.pending !== null
  ) {
    return false;
  }
  const intents = new Map(
    snapshot.records
      .filter(
        (record) =>
          record.kind === "intent" &&
          record.action === "verify-committed-restart",
      )
      .map((record) => [record.id, record]),
  );
  return snapshot.records.some((record) => {
    if (
      record.kind !== "completion" ||
      record.intentId === undefined ||
      !intents.has(record.intentId) ||
      !record.result ||
      typeof record.result !== "object" ||
      Array.isArray(record.result)
    ) {
      return false;
    }
    const result = record.result as Record<string, unknown>;
    return (
      result.health === "ok" &&
      result.version === snapshot.targetVersion
    );
  });
}

export class RetentionService {
  private readonly fs: DurableFileSystem;

  constructor(
    private readonly root: string,
    options: { fs?: DurableFileSystem } = {},
  ) {
    this.fs = options.fs ?? new NodeDurableFileSystem();
  }

  async cleanup(
    snapshot: AttemptJournalSnapshot,
  ): Promise<CleanupResult> {
    if (!verifiedRestart(snapshot)) {
      return { eligible: false, deleted: [], retained: [] };
    }
    const root = path.resolve(this.root);
    const releasesRoot = path.join(root, "releases");
    const current = await this.fs.realpath(path.join(root, "current"));
    const switchIntent = [...snapshot.records]
      .reverse()
      .find(
        (record) =>
          record.kind === "intent" &&
          ["attach-current", "replace-current"].includes(
            record.action ?? "",
          ) &&
          record.payload &&
          typeof record.payload === "object" &&
          !Array.isArray(record.payload),
      );
    const payload = switchIntent?.payload as
      | Record<string, unknown>
      | undefined;
    const previous =
      typeof payload?.originalTarget === "string"
        ? path.resolve(payload.originalTarget)
        : undefined;
    const retained = [current, ...(previous ? [previous] : [])];
    const retainedKeys = new Set(
      retained.map((value) =>
        process.platform === "win32"
          ? path.resolve(value).toLowerCase()
          : path.resolve(value),
      ),
    );
    const deleted: string[] = [];
    if (await this.fs.exists(releasesRoot)) {
      for (const name of await this.fs.readdir(releasesRoot)) {
        if (
          name.startsWith(".stage-") ||
          name.startsWith("previous-attempt-")
        ) {
          continue;
        }
        const candidate = path.join(releasesRoot, name);
        if (!within(releasesRoot, candidate)) continue;
        const key =
          process.platform === "win32"
            ? candidate.toLowerCase()
            : candidate;
        if (retainedKeys.has(key)) continue;
        const info = await this.fs.lstat(candidate);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        const actual = await this.fs.realpath(candidate);
        if (
          !within(releasesRoot, actual) ||
          retainedKeys.has(
            process.platform === "win32" ? actual.toLowerCase() : actual,
          )
        ) {
          continue;
        }
        await rm(candidate, { recursive: true, force: false });
        deleted.push(candidate);
      }
    }
    return { eligible: true, deleted, retained };
  }

  async cleanupBootstrapRecoveryAssets(
    backupId: string,
  ): Promise<string[]> {
    if (!BACKUP_ID.test(backupId) || backupId.includes("..")) {
      throw new Error("bootstrap backup id must be one exact safe identifier");
    }
    const backupRoot = path.join(
      path.resolve(this.root),
      "backups",
      backupId,
    );
    const backupsRoot = path.join(path.resolve(this.root), "backups");
    if (!within(backupsRoot, backupRoot)) {
      throw new Error("bootstrap backup id escaped protected backups");
    }
    const removed: string[] = [];
    for (const relative of ["env", "legacy-source"]) {
      const target = path.join(backupRoot, relative);
      if (!within(backupRoot, target)) {
        throw new Error("bootstrap recovery asset path is unsafe");
      }
      if (await this.fs.exists(target)) {
        const info = await this.fs.lstat(target);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new Error("bootstrap recovery asset is not a real directory");
        }
        await rm(target, { recursive: true, force: false });
        removed.push(target);
      }
    }
    return removed;
  }
}
