import { createHash } from "node:crypto";
import { appendFile, chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AttemptContext,
  AttemptJournal,
  JournalRecord,
} from "./state/attempt-journal";
import { DurableFileSystem, NodeDurableFileSystem } from "./platform/durable-fs";

export const FIXED_NOW = new Date("2026-10-27T01:02:03.004Z");

export interface TestTempRoot {
  path: string;
  cleanup(): Promise<void>;
}

export async function createTempRoot(): Promise<TestTempRoot> {
  const root = await mkdtemp(path.join(tmpdir(), "filestation-updater-"));
  return {
    path: root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export function handoffHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function context(
  overrides: Partial<AttemptContext> = {},
): AttemptContext {
  return {
    attemptId: "attempt-01",
    fence: 1,
    currentVersion: "0.2.0",
    targetVersion: "0.2.5",
    previousVersion: "0.2.0",
    backupId: "backup-01",
    phase: "PREPARED",
    owner: {
      bootIdentity: "linux:11111111-2222-3333-4444-555555555555",
      pid: 1234,
      processCreatedAt: "1728",
      heartbeatAt: FIXED_NOW.toISOString(),
      handoffIdentityHash: handoffHash("handoff-capability"),
    },
    ...overrides,
  };
}

export class InjectableDurableFs extends NodeDurableFileSystem {
  readonly calls: Array<{ operation: string; path?: string }> = [];
  failOperation?: string;
  failAfterWriteOperation?: string;
  failAppend?: {
    match: (bytes: Buffer) => boolean;
    timing: "before" | "after";
  };
  failRename?: {
    match: (source: string, target: string) => boolean;
  };

  constructor(private readonly failOnce = new Set<string>()) {
    super();
  }

  private shouldFail(operation: string): boolean {
    this.calls.push({ operation });
    if (!this.failOnce.has(operation)) return false;
    this.failOnce.delete(operation);
    return true;
  }

  override async append(
    filename: string,
    bytes: Buffer,
    options?: Parameters<DurableFileSystem["append"]>[2],
  ): Promise<void> {
    const failBefore = this.shouldFail(`append:${path.basename(filename)}`);
    this.calls.push({ operation: "append", path: filename });
    if (failBefore) throw new Error("injected append flush failure");
    if (this.failAppend?.match(bytes) && this.failAppend.timing === "before") {
      this.failAppend = undefined;
      throw new Error("injected append failure before write");
    }
    await super.append(filename, bytes, options);
    if (this.failAppend?.match(bytes)) {
      const timing = this.failAppend.timing;
      this.failAppend = undefined;
      if (timing === "after")
        throw new Error("injected append failure after write");
    }
    if (
      this.failAfterWriteOperation ===
      `append:${path.basename(filename)}`
    ) {
      this.failAfterWriteOperation = undefined;
      throw new Error("injected append flush failure after write");
    }
  }

  override async rename(
    source: string,
    target: string,
    options?: Parameters<DurableFileSystem["rename"]>[2],
  ): Promise<void> {
    if (this.failRename?.match(source, target)) {
      this.failRename = undefined;
      throw new Error("injected rename failure");
    }
    if (this.shouldFail(`rename:${path.basename(source)}`))
      throw new Error("injected rename failure");
    this.calls.push({
      operation: "rename",
      path: `${path.basename(source)}->${path.basename(target)}`,
    });
    await super.rename(source, target, options);
  }
}

export async function makeJournal(
  root: string,
  fs: DurableFileSystem = new NodeDurableFileSystem(),
  now: () => Date = () => FIXED_NOW,
): Promise<AttemptJournal> {
  return AttemptJournal.open(root, { fs, now });
}

export async function journalPath(root: string): Promise<string> {
  return path.join(root, "update-attempt.journal");
}

export async function rewriteRecord(
  root: string,
  index: number,
  mutate: (record: Record<string, any>) => void,
  recomputeChecksum = true,
): Promise<void> {
  const filename = await journalPath(root);
  const raw = await readFile(filename, "utf8");
  const lines = raw.trimEnd().split("\n");
  const record = JSON.parse(lines[index]);
  mutate(record);
  if (recomputeChecksum) {
    const { checksum: _checksum, ...withoutChecksum } = record;
    const digest = createHash("sha256")
      .update(JSON.stringify(withoutChecksum), "utf8")
      .digest("hex");
    record.checksum = digest;
  }
  lines[index] = JSON.stringify(record);
  await chmod(filename, 0o600);
  await appendFile(`${filename}.rewrite`, `${lines.join("\n")}\n`, {
    mode: 0o600,
  });
  await rm(filename);
  await new NodeDurableFileSystem().rename(`${filename}.rewrite`, filename, {
    replace: true,
  });
}

export function recordFromLine(line: string): JournalRecord {
  return JSON.parse(line) as JournalRecord;
}
