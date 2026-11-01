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

function componentIs(candidate: string, expected: string): boolean {
  const component = path.basename(candidate);
  return process.platform === "win32"
    ? component.toLowerCase() === expected
    : component === expected;
}

function executableRoots(executable: string): {
  deploymentRoot?: string;
  managedRoot?: string;
} {
  const directory = path.dirname(path.resolve(executable));
  if (!componentIs(directory, "dist")) return {};
  const workspace = path.dirname(directory);
  const parent = path.dirname(workspace);
  // The standalone updater lives at <installRoot>/updater/dist/cli.js.
  if (componentIs(workspace, "updater") && componentIs(executable, "cli.js")) {
    return { managedRoot: parent };
  }
  if (!componentIs(workspace, "server") || !componentIs(parent, "apps")) {
    return {};
  }
  const deploymentRoot = path.dirname(parent);
  const container = path.dirname(deploymentRoot);
  // Bootstrap publishes releases/<version>-<fingerprint>/apps/server/dist.
  // Current may also be supplied lexically; real server entry resolves its link.
  const managedRoot = componentIs(container, "releases")
    ? path.dirname(container)
    : componentIs(deploymentRoot, "current") ? container : undefined;
  return { deploymentRoot, managedRoot };
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

  const { deploymentRoot, managedRoot } = executableRoots(input.executableRealpath);
  if (managedRoot) {
    if (!(await exists(path.join(managedRoot, "managed-install.json")))) {
      throw new Error(`managed-install.json is missing for managed layout at ${managedRoot}`);
    }
    return { mode: "managed", root: managedRoot };
  }

  // Only inspect the actual deployment and cwd. Generic children of an ancestor
  // (updater/releases/current) can belong to an unrelated neighboring project.
  const candidates = new Set([deploymentRoot, path.resolve(input.cwd)]);
  for (const root of candidates) {
    if (!root) continue;
    if (await exists(path.join(root, "managed-install.json"))) {
      return { mode: "managed", root };
    }
    const markers = [".bootstrap-in-progress.json", "update-attempt.journal", "update.lock", "update.recovery.lock"];
    // Preserve fail-closed owned layout detection without inspecting siblings of
    // the deployment (or generic entries in an unrelated cwd).
    if (root === deploymentRoot) markers.push("current", "releases", "updater");
    for (const marker of markers) {
      if (await exists(path.join(root, marker))) {
        throw new Error(`managed-install.json is missing for managed layout at ${root}`);
      }
    }
  }

  if (environment.FILESTATION_MANAGED_LAUNCH === "true") {
    throw new Error("managed launch requested but managed-install.json is missing");
  }
  return { mode: "legacy", root: path.resolve(input.cwd) };
}
