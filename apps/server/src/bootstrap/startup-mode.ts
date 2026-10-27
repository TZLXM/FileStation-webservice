import { lstat } from "node:fs/promises";
import path from "node:path";

export interface StartupModeInput {
  cwd: string;
  executableRealpath: string;
  environment?: NodeJS.ProcessEnv;
}

export type StartupMode =
  | { mode: "legacy"; root: string }
  | { mode: "managed"; root: string };

async function exists(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function ancestorCandidates(candidate: string): string[] {
  const result: string[] = [];
  let cursor = path.resolve(candidate);
  for (;;) {
    result.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) return result;
    cursor = parent;
  }
}

export async function detectStartupMode(
  input: StartupModeInput,
): Promise<StartupMode> {
  const environment = input.environment ?? process.env;
  const explicitRoot = environment.FILESTATION_INSTALL_ROOT;
  if (explicitRoot) {
    const root = path.resolve(explicitRoot);
    if (!(await exists(path.join(root, "managed-install.json")))) {
      throw new Error(`managed-install.json is missing at ${root}`);
    }
    return { mode: "managed", root };
  }

  const seen = new Set<string>();
  for (const candidate of [
    ...ancestorCandidates(input.executableRealpath),
    ...ancestorCandidates(input.cwd),
  ]) {
    const root = path.resolve(candidate);
    const key =
      process.platform === "win32" ? root.toLowerCase() : root;
    if (seen.has(key)) continue;
    seen.add(key);
    if (await exists(path.join(root, "managed-install.json"))) {
      return { mode: "managed", root };
    }
  }

  // A managed layout or durable marker cannot silently fall back to legacy.
  for (const candidate of seen) {
    for (const marker of ["current", "releases", "updater", ".bootstrap-in-progress.json", "update-attempt.journal", "update.lock", "update.recovery.lock"]) {
      if (marker === "updater" && path.basename(candidate).toLowerCase() === "apps") continue;
      if (await exists(path.join(candidate, marker)))
        throw new Error(`managed-install.json is missing for managed layout at ${candidate}`);
    }
  }

  if (environment.FILESTATION_MANAGED_LAUNCH === "true") {
    throw new Error("managed launch requested but managed-install.json is missing");
  }
  return { mode: "legacy", root: path.resolve(input.cwd) };
}
