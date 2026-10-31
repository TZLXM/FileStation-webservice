import { rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from 'node:crypto';
import {
  AttemptJournalSnapshot,
  AttemptJournal,
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
      result.version === snapshot.targetVersion &&
      record.context.fence === snapshot.fence &&
      Number.isSafeInteger(result.pid) && Number(result.pid) > 0 &&
      typeof result.createdAt === 'string' && result.createdAt.length > 0 &&
      typeof result.boot === 'string' && result.boot.length > 0 &&
      typeof result.nonce === 'string' && result.nonce.length >= 16 &&
      typeof result.release === 'string' && path.isAbsolute(result.release)
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
    // Compute reachability before deleting anything. Malformed metadata or a
    // linked metadata tree aborts cleanup rather than dropping a reference.
    const metadata: Array<{filename:string; value:Record<string, unknown>}> = [];
    const collect = (value: unknown): void => {
      if (typeof value === 'string' && path.isAbsolute(value) && within(releasesRoot, value)) {
        const relative = path.relative(releasesRoot, value).split(path.sep)[0];
        retained.push(path.join(releasesRoot, relative));
      } else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    collect(snapshot.records);
    const verified = await AttemptJournal.inspect(root, {fs:this.fs});
    if(verified.attemptId!==snapshot.attemptId || verified.fence!==snapshot.fence || verified.sequence!==snapshot.sequence)
      throw new Error('retention journal changed before reachability scan');
    const history = await AttemptJournal.inspectHistory(root, {fs:this.fs});
    const historyRecords = history.flatMap(attempt => attempt.records);
    collect(historyRecords);
    const scan = async (directory:string):Promise<void> => {
      if (!(await this.fs.exists(directory))) return;
      for (const name of await this.fs.readdir(directory)) {
        const filename=path.join(directory,name);
        const info=await this.fs.lstat(filename);
        if(info.isSymbolicLink()) throw new Error('retention metadata contains a link');
        if(info.isDirectory()) await scan(filename);
        else if(name.endsWith('.json')) {
          const value=JSON.parse((await this.fs.readFile(filename)).toString('utf8'));
          metadata.push({filename,value}); collect(value);
        }
      }
    };
    await scan(path.join(root,'backups'));
    const deleted: string[] = [];
    const diagnostics=metadata.filter(item=>path.basename(item.filename)==='manifest.json' && path.basename(path.dirname(path.dirname(item.filename)))==='diagnostics');
    // A backup reference grants deletion authority only for the exact DB-local
    // directory bound by a validated rollback intent. Metadata alone is not authority.
    const targets = new Map<string,string>();
    for (const item of diagnostics) {
      const value=item.value;
      if (value.diagnosticDirectory === undefined) continue;
      const token=createHash('sha256').update(`${value.attemptId}:${value.fence}`).digest('hex').slice(0,24);
      if (typeof value.databasePath!=='string' || !path.isAbsolute(value.databasePath)) throw new Error('diagnostic reference database malformed');
      const expected=path.join(path.dirname(value.databasePath),'.filestation-update-diagnostics',token);
      const bound=historyRecords.some(record => {
        if(record.kind!=='intent' || record.action!=='rollback-database' || record.context.attemptId!==value.attemptId || record.context.fence!==value.fence) return false;
        const payload=record.payload as Record<string,unknown> | undefined;
        return payload !== undefined && payload.databasePath===value.databasePath && payload.diagnosticDirectory===expected && payload.restoreTag===token && typeof payload.snapshotPath==='string' && path.dirname(item.filename)===path.join(path.dirname(payload.snapshotPath),'diagnostics',`${value.attemptId}-${value.fence}`);
      });
      if (!bound || value.diagnosticDirectory!==expected || value.restoreTag!==token) throw new Error('diagnostic reference is not journal-bound');
      if (await this.fs.exists(expected)) {
        if (await this.fs.realpath(expected)!==expected || (await this.fs.lstat(expected)).isSymbolicLink()) throw new Error('diagnostic target drift');
        const local=JSON.parse((await this.fs.readFile(path.join(expected,'manifest.json'))).toString('utf8'));
        if(local.attemptId!==value.attemptId || local.fence!==value.fence || local.detached!==true) throw new Error('diagnostic manifest mismatch');
        collect(local);
      }
      targets.set(item.filename,expected);
    }
    const retainedKeys = new Set(retained.map(value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)));
    diagnostics.sort((a,b)=>String(b.value.createdAt).localeCompare(String(a.value.createdAt)) || a.filename.localeCompare(b.filename));
    // Latest failure requires an exact-ID administrator acknowledgment. Keep at
    // most two additional sets; snapshots and bootstrap assets are never pruned.
    const keepDiagnostics=new Set(diagnostics.filter((item,index)=>index===0 && item.value.administratorAcknowledged!==true).map(item=>item.filename));
    let other=0;
    for(const item of diagnostics) {
      if(keepDiagnostics.has(item.filename)) continue;
      if(item.value.administratorAcknowledged===true) continue;
      if(other++ < 2) keepDiagnostics.add(item.filename);
    }
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
    for(const item of diagnostics) {
      const directory=path.dirname(item.filename);
      const target=targets.get(item.filename);
      if(keepDiagnostics.has(item.filename)) retained.push(directory,...(target ? [target] : []));
      else {
        if(target && await this.fs.exists(target)) {await rm(target,{recursive:true,force:false});deleted.push(target);}
        await rm(directory,{recursive:true,force:false}); deleted.push(directory);
      }
    }
    return { eligible: true, deleted, retained };
  }

  async acknowledgeDiagnostic(exactId:string):Promise<void> {
    if(!BACKUP_ID.test(exactId) || exactId.includes('..')) throw new Error('diagnostic id must be exact');
    const backups=path.join(path.resolve(this.root),'backups');
    const matches:string[]=[];
    for(const backup of await this.fs.readdir(backups)) {
      const parent=path.join(backups,backup);
      if((await this.fs.lstat(parent)).isSymbolicLink()) throw new Error('linked backup denied');
      const directory=path.join(parent,'diagnostics',exactId);
      if(await this.fs.exists(directory)) {
        if((await this.fs.lstat(path.join(parent,'diagnostics'))).isSymbolicLink() || (await this.fs.lstat(directory)).isSymbolicLink()) throw new Error('linked diagnostic denied');
        matches.push(path.join(directory,'manifest.json'));
      }
    }
    if(matches.length!==1) throw new Error('diagnostic id absent or ambiguous');
    const value=JSON.parse((await this.fs.readFile(matches[0])).toString('utf8'));
    await this.fs.writeAtomic(matches[0],Buffer.from(JSON.stringify({...value,administratorAcknowledged:true})+'\n'),{mode:0o600});
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
    const assertDirectory = async (directory:string) => {
      const info=await this.fs.lstat(directory);
      if(!info.isDirectory() || info.isSymbolicLink() || await this.fs.realpath(directory)!==directory)
        throw new Error('bootstrap backup ancestry must be canonical link-free directory');
      return `${info.dev}:${info.ino}`;
    };
    const ancestry=[path.resolve(this.root),backupsRoot,backupRoot];
    const identities=await Promise.all(ancestry.map(assertDirectory));
    const manifestPath=path.join(backupRoot,'MANIFEST.json');
    const readIdentity=async () => {
      const info=await this.fs.lstat(manifestPath);
      if(!info.isFile() || info.isSymbolicLink() || await this.fs.realpath(manifestPath)!==manifestPath)
        throw new Error('bootstrap backup manifest must be canonical');
      const bytes=await this.fs.readFile(manifestPath);
      const manifest=JSON.parse(bytes.toString('utf8'));
      const managedPath=path.join(path.resolve(this.root),'managed-install.json');
      const managedInfo=await this.fs.lstat(managedPath);
      if(!managedInfo.isFile() || managedInfo.isSymbolicLink() || await this.fs.realpath(managedPath)!==managedPath)
        throw new Error('bootstrap installation identity must be canonical');
      const managed=JSON.parse((await this.fs.readFile(managedPath)).toString('utf8'));
      if(manifest.schemaVersion!==1 || manifest.kind!=='bootstrap-backup' || manifest.backupId!==backupId || manifest.installRoot!==path.resolve(this.root) || !manifest.installId || manifest.installId!==managed.installId || managed.bootstrapBackupId!==backupId)
        throw new Error('bootstrap backup identity mismatch');
      return createHash('sha256').update(bytes).digest('hex');
    };
    const manifestIdentity=await readIdentity();
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
        // Recheck every ancestor and exact selected backup immediately before
        // recursive deletion; a real leaf under a redirected parent is unsafe.
        for(let index=0;index<ancestry.length;index++) {
          if(await assertDirectory(ancestry[index])!==identities[index]) throw new Error('bootstrap backup directory identity changed');
        }
        if(await readIdentity()!==manifestIdentity) throw new Error('bootstrap backup manifest changed');
        const actual=await this.fs.realpath(target);
        const latest=await this.fs.lstat(target);
        if(actual!==target || !within(backupRoot,actual) || latest.isSymbolicLink() || !latest.isDirectory() || latest.dev!==info.dev || latest.ino!==info.ino)
          throw new Error('bootstrap recovery asset identity changed');
        await rm(target, { recursive: true, force: false });
        removed.push(target);
      }
    }
    return removed;
  }
}
