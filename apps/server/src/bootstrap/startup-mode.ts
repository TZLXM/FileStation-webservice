import { access } from "node:fs/promises";
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
    await access(filename);
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

  if (environment.FILESTATION_MANAGED_LAUNCH === "true") {
    throw new Error("managed launch requested but managed-install.json is missing");
  }
  return { mode: "legacy", root: path.resolve(input.cwd) };
}
