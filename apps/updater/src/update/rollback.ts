import { createHash } from "node:crypto";
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import {
  AttemptJournal,
  JsonValue,
} from "../state/attempt-journal";
import {
  DurableFileSystem,
  NodeDurableFileSystem,
} from "../platform/durable-fs";

export type RollbackCrashPoint = "after-diagnostic-intent";

export interface UpdateRollbackOptions {
  crashAt?: RollbackCrashPoint;
  fs?: DurableFileSystem;
  now?: () => Date;
}

export interface RestoreDatabaseInput {
  root: string;
  journal: AttemptJournal;
  attemptId: string;
  fence: number;
  databasePath: string;
  snapshotPath: string;
}

export interface RestoreDatabaseResult {
  state: "restored";
  diagnosticDirectory: string;
  snapshotPath: string;
}

export class InjectedRollbackCrash extends Error {
  constructor(point: RollbackCrashPoint) {
    super(`injected rollback crash: ${point}`);
    this.name = "InjectedRollbackCrash";
  }
}

function within(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function object(value: JsonValue | undefined): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("rollback journal payload is malformed");
  }
  return value;
}

export class UpdateRollbackService {
  private readonly fs: DurableFileSystem;
  private readonly now: () => Date;

  constructor(private readonly options: UpdateRollbackOptions = {}) {
    this.fs = options.fs ?? new NodeDurableFileSystem();
    this.now = options.now ?? (() => new Date());
  }

  async restoreDatabase(
    input: RestoreDatabaseInput,
  ): Promise<RestoreDatabaseResult> {
    const root = path.resolve(input.root);
    const databasePath = path.resolve(input.databasePath);
    const snapshotPath = path.resolve(input.snapshotPath);
    const backupsRoot = path.join(root, "backups");
    if (
      !within(backupsRoot, snapshotPath) ||
      !path.isAbsolute(databasePath)
    ) {
      throw new Error("rollback database or snapshot path is unsafe");
    }

    const current = await input.journal.readSnapshot();
    if (
      current.attemptId !== input.attemptId ||
      current.fence !== input.fence
    ) {
      throw new Error("rollback attempt or fence is mismatched");
    }
    if (current.phase === "COMMITTED") {
      throw new Error("COMMITTED update cannot be rolled back");
    }
    if (current.pending && current.pending.action !== "rollback-database") {
      throw new Error(`pending action ${current.pending.action} must recover first`);
    }

    const token = createHash("sha256")
      .update(`${input.attemptId}:${input.fence}`)
      .digest("hex")
      .slice(0, 24);
    const diagnosticDirectory = path.join(
      path.dirname(snapshotPath),
      "diagnostics",
      `${input.attemptId}-${input.fence}`,
    );
    const payload = {
      databasePath,
      snapshotPath,
      diagnosticDirectory,
      restoreTag: token,
    } as unknown as JsonValue;
    let intentId = current.pending?.intentId;
    if (!intentId) {
      const intent = await input.journal.appendIntent({
        attemptId: input.attemptId,
        fence: input.fence,
        action: "rollback-database",
        phase: "ROLLBACK_INTENT",
        payload,
      });
      intentId = intent.id;
    } else {
      const previous = object(current.pending?.payload);
      if (
        previous.databasePath !== databasePath ||
        previous.snapshotPath !== snapshotPath
      ) {
        throw new Error("pending rollback paths do not match");
      }
    }

    if (this.options.crashAt === "after-diagnostic-intent") {
      throw new InjectedRollbackCrash("after-diagnostic-intent");
    }

    const snapshotBytes = await readFile(snapshotPath);
    const snapshotIntent = [...current.records]
      .reverse()
      .find(
        (record) =>
          record.kind === "intent" &&
          record.action === "snapshot-database",
      );
    const expectedHash =
      snapshotIntent && object(snapshotIntent.payload).sha256;
    if (
      typeof expectedHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(expectedHash) ||
      sha256(snapshotBytes) !== expectedHash
    ) {
      throw new Error("verified rollback snapshot hash changed");
    }

    await this.fs.ensurePrivateDirectory(diagnosticDirectory);
    const sidecars = ["", "-wal", "-shm", "-journal"] as const;
    for (const suffix of sidecars) {
      const source = `${databasePath}${suffix}`;
      const target = path.join(
        diagnosticDirectory,
        `${path.basename(databasePath)}${suffix}`,
      );
      if (await this.fs.exists(source)) {
        if (await this.fs.exists(target)) {
          throw new Error("rollback diagnostics already contain both source and target");
        }
        await this.fs.rename(source, target, { replace: false });
      }
    }
    await this.fs.writeAtomic(
      path.join(diagnosticDirectory, "manifest.json"),
      Buffer.from(
        `${JSON.stringify({
          schemaVersion: 1,
          attemptId: input.attemptId,
          fence: input.fence,
          createdAt: this.now().toISOString(),
          files: sidecars.map(
            (suffix) => `${path.basename(databasePath)}${suffix}`,
          ),
        })}\n`,
      ),
      { mode: 0o600 },
    );

    const restorePath = `${databasePath}.restore-${token}`;
    if (await this.fs.exists(restorePath)) await this.fs.unlink(restorePath);
    await copyFile(snapshotPath, restorePath);
    await this.fs.protect(restorePath, false);
    await this.fs.syncFile(restorePath);
    await this.fs.fsyncDirectory(path.dirname(databasePath));
    if (await this.fs.exists(databasePath)) {
      throw new Error("rollback database sidecar set was not fully detached");
    }
    await this.fs.rename(restorePath, databasePath, { replace: false });
    await this.fs.fsyncDirectory(path.dirname(databasePath));

    await input.journal.appendCompletion({
      attemptId: input.attemptId,
      fence: input.fence,
      intentId,
      phase: "ROLLBACK_INTENT",
      result: {
        diagnosticDirectory,
        snapshotPath,
        restored: true,
      },
    });
    return { state: "restored", diagnosticDirectory, snapshotPath };
  }
}
