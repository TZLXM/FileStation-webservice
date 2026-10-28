import { createHash } from "node:crypto";
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalizePotentialPath } from '../bootstrap/path-plan';
import {
  AttemptJournal,
  JsonValue,
} from "../state/attempt-journal";
import {
  DurableFileSystem,
  NodeDurableFileSystem,
} from "../platform/durable-fs";

export type RollbackCrashPoint = "after-diagnostic-intent" | "after-move-db" | "after-move-wal" | "after-move-shm" | "after-move-journal" | "before-publication" | "after-publication";

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

    // A recovery owner advances the fence, but must resume the original
    // diagnostic identity instead of creating another set for the new fence.
    const diagnosticFence = current.pending
      ? current.records.find(record => record.id === current.pending!.intentId)!.context.fence
      : input.fence;
    let token = createHash("sha256")
      .update(`${input.attemptId}:${diagnosticFence}`)
      .digest("hex")
      .slice(0, 24);
    const localDiagnostic = path.join(path.dirname(databasePath), '.filestation-update-diagnostics', token);
    let diagnosticDirectory = localDiagnostic;
    if(current.pending?.action==='rollback-database') {
      const previous=object(current.pending.payload);
      if(typeof previous.diagnosticDirectory!=='string' || previous.restoreTag !== token || (previous.diagnosticDirectory !== localDiagnostic && !within(path.dirname(snapshotPath),previous.diagnosticDirectory))) throw new Error('pending rollback diagnostic identity malformed');
      diagnosticDirectory=previous.diagnosticDirectory; token=previous.restoreTag;
    }
    if (await canonicalizePotentialPath(diagnosticDirectory, root) !== diagnosticDirectory) {
      throw new Error('rollback diagnostic canonical target drift before writes');
    }
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

    const referencePath = path.join(path.dirname(snapshotPath), 'diagnostics', `${input.attemptId}-${diagnosticFence}`, 'manifest.json');
    const publishReference = async (): Promise<void> => {
      if (diagnosticDirectory === path.dirname(referencePath)) return; // Existing pending protocol remains recoverable.
      const manifest = JSON.parse((await this.fs.readFile(path.join(diagnosticDirectory, 'manifest.json'))).toString('utf8'));
      if (await canonicalizePotentialPath(path.dirname(referencePath), root) !== path.dirname(referencePath)) throw new Error('rollback metadata canonical target drift');
      await this.fs.ensurePrivateDirectory(path.dirname(referencePath));
      await this.fs.writeAtomic(referencePath, Buffer.from(JSON.stringify({...manifest, databasePath, diagnosticDirectory, restoreTag:token})+'\n'), {mode:0o600});
    };
    const complete = async (): Promise<RestoreDatabaseResult> => {
      await publishReference();
      await input.journal.appendCompletion({ attemptId: input.attemptId, fence: input.fence, intentId: intentId!, phase: "ROLLBACK_INTENT", result: { diagnosticDirectory, snapshotPath, restored: true } });
      return { state: "restored", diagnosticDirectory, snapshotPath };
    };
    const manifestPath = path.join(diagnosticDirectory, "manifest.json");
    // Detached evidence is durable before publication. Never detach a published
    // restore a second time into the original failed database's diagnostic set.
    if (await this.fs.exists(manifestPath) && await this.fs.exists(databasePath)) {
      const manifest = JSON.parse((await this.fs.readFile(manifestPath)).toString("utf8"));
      if (manifest.attemptId !== input.attemptId || manifest.snapshotSha256 !== expectedHash || !manifest.detached)
        throw new Error("restore publication manifest mismatched");
      if (sha256(await readFile(databasePath)) !== expectedHash)
        throw new Error("restored database publication hash mismatched");
      for (const suffix of ["-wal", "-shm", "-journal"])
        if (await this.fs.exists(databasePath + suffix)) throw new Error("restored publication has live sidecars");
      return complete();
    }
    await this.fs.ensurePrivateDirectory(path.dirname(diagnosticDirectory));
    await this.fs.ensurePrivateDirectory(diagnosticDirectory);
    if (await this.fs.realpath(diagnosticDirectory) !== diagnosticDirectory) throw new Error('rollback diagnostic canonical target drift');
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
        const point = `after-move-${suffix ? suffix.slice(1) : "db"}` as RollbackCrashPoint;
        if (this.options.crashAt === point) throw new InjectedRollbackCrash(point);
      }
    }
    await this.fs.writeAtomic(
      path.join(diagnosticDirectory, "manifest.json"),
      Buffer.from(
        `${JSON.stringify({
          schemaVersion: 1,
          detached: true,
          snapshotSha256: expectedHash,
          releaseReferences: current.records.filter(r => r.kind === "intent" && ["attach-current", "replace-current"].includes(r.action ?? "")).map(r => r.payload),
          attemptId: input.attemptId,
          fence: diagnosticFence,
          createdAt: this.now().toISOString(),
          files: sidecars.map(
            (suffix) => `${path.basename(databasePath)}${suffix}`,
          ),
        })}\n`,
      ),
      { mode: 0o600 },
    );
    await publishReference();

    const restorePath = `${databasePath}.restore-${token}`;
    if (await this.fs.exists(restorePath)) await this.fs.unlink(restorePath);
    await copyFile(snapshotPath, restorePath);
    await this.fs.protect(restorePath, false);
    await this.fs.syncFile(restorePath);
    await this.fs.fsyncDirectory(path.dirname(databasePath));
    if (await this.fs.exists(databasePath)) {
      throw new Error("rollback database sidecar set was not fully detached");
    }
    if (this.options.crashAt === "before-publication") throw new InjectedRollbackCrash("before-publication");
    await this.fs.rename(restorePath, databasePath, { replace: false });
    await this.fs.fsyncDirectory(path.dirname(databasePath));

    if (this.options.crashAt === "after-publication") throw new InjectedRollbackCrash("after-publication");
    return complete();
  }
}
