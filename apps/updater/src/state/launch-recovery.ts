import path from "node:path";
import { AttemptJournal } from "./attempt-journal";
import { pathWithin, sameCanonicalPath } from "../bootstrap/path-plan";
import { DurableFileSystem } from "../platform/durable-fs";

/** No recovery orchestration here: refuse every state without a safe launch proof. */
export async function assertLaunchRecoverySafe(root: string, release: string, fs: DurableFileSystem): Promise<void> {
  const marker = await unresolvedRecoveryMarker(root, fs);
  if (marker) throw new Error(`Task 9 recovery required: unresolved ${marker}`);
  let snapshot;
  try { snapshot = await AttemptJournal.inspect(root, { fs }); }
  catch { throw new Error("Task 9 recovery required: uncertain or truncated journal"); }
  if (!snapshot.initialized) return;
  if (snapshot.pending || snapshot.phase !== "COMMITTED")
    throw new Error(`Task 9 recovery required: journal phase ${snapshot.phase} or pending action`);
  // COMMITTED is authoritative only for its target version, never the old tree.
  let version: unknown;
  try { version = JSON.parse((await fs.readFile(path.join(release, "package.json"))).toString("utf8")).version; }
  catch { throw new Error("COMMITTED authority cannot verify current release version; recovery required"); }
  const switched = [...snapshot.records].reverse().find(record => record.kind === "intent" && ["attach-current", "replace-current"].includes(record.action ?? ""));
  const payload = switched?.payload as { target?: unknown } | undefined;
  if (!switched || typeof payload?.target !== "string" ||
      !pathWithin(path.join(root, "releases"), payload.target) ||
      !sameCanonicalPath(await fs.realpath(payload.target), release))
    throw new Error("COMMITTED switch target differs from current release; recovery required");
  if (version !== snapshot.targetVersion)
    throw new Error("COMMITTED authority differs from current release; recovery required");
}

/** Inspect actual Task 5 staging names without creating or protecting anything. */
export async function unresolvedRecoveryMarker(root: string, fs: DurableFileSystem): Promise<string | undefined> {
  if (await fs.exists(path.join(path.dirname(root), `.${path.basename(root)}.bootstrap.lock`))) return "bootstrap owner lock";
  for (const marker of [".bootstrap-in-progress.json", "update.lock", "update.recovery.lock"]) {
    if (await fs.exists(path.join(root, marker))) return marker;
  }
  for (const name of await fs.readdir(root)) if (name.startsWith(".current.tmp-")) return name;
  const releases = path.join(root, "releases");
  if (await fs.exists(releases)) {
    for (const name of await fs.readdir(releases)) if (name.startsWith(".stage-attempt-")) return name;
  }
  return undefined;
}
