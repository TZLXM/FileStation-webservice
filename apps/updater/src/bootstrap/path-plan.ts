import { realpath } from "node:fs/promises";
import path from "node:path";

export type ManagedPathKey = "database" | "storage" | "temp";
export type RelativePathPolicy = "preserve" | "managed";

export interface ManagedInstallPaths {
  database: string;
  storage: string;
  temp: string;
}

export interface BootstrapPathChange {
  key: ManagedPathKey;
  configured: string;
  previous: string;
  proposed: string;
  changed: boolean;
  requestedPolicy: RelativePathPolicy | "absolute";
}

export interface BootstrapPathPlan {
  legacyRoot: string;
  installRoot: string;
  previous: ManagedInstallPaths;
  proposed: ManagedInstallPaths;
  changes: BootstrapPathChange[];
  relativePathPolicy: RelativePathPolicy;
}

export interface BootstrapPathPlanInput {
  legacyRoot: string;
  installRoot: string;
  configuredPaths?: Partial<ManagedInstallPaths>;
  overrides?: Partial<ManagedInstallPaths>;
  relativePathPolicy?: RelativePathPolicy;
  acceptPathChange?: boolean;
}

const DEFAULT_PATHS: ManagedInstallPaths = {
  database: "./data/filestation.db",
  storage: "./data/storage",
  temp: "./data/temp",
};
const PATH_KEYS: ManagedPathKey[] = ["database", "storage", "temp"];

function nativePath(candidate: string): string {
  return candidate.replace(/^\\\\\?\\/, "");
}

export function canonicalPathKey(candidate: string): string {
  const normalized = path.resolve(nativePath(candidate)).replace(/[\\/]+$/, "");
  return process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

export function sameCanonicalPath(left: string, right: string): boolean {
  return canonicalPathKey(left) === canonicalPathKey(right);
}

export function pathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export async function canonicalizePotentialPath(
  candidate: string,
  base: string,
): Promise<string> {
  let cursor = path.resolve(base, nativePath(candidate));
  const missing: string[] = [];
  for (;;) {
    try {
      const existing = await realpath(cursor);
      return path.resolve(existing, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      const basename = path.basename(cursor);
      if (basename) missing.push(basename);
      cursor = parent;
    }
  }
}

export async function planBootstrapPaths(
  input: BootstrapPathPlanInput,
): Promise<BootstrapPathPlan> {
  const legacyRoot = await canonicalizePotentialPath(input.legacyRoot, process.cwd());
  const installRoot = await canonicalizePotentialPath(input.installRoot, process.cwd());
  const configured = { ...DEFAULT_PATHS };
  for (const key of PATH_KEYS) {
    const value = input.configuredPaths?.[key];
    if (value !== undefined) configured[key] = value;
  }
  const previous = {} as ManagedInstallPaths;
  const proposed = {} as ManagedInstallPaths;
  const changes: BootstrapPathChange[] = [];
  let sawRelative = false;

  for (const key of PATH_KEYS) {
    const raw = configured[key];
    const isRelative = !path.isAbsolute(nativePath(raw));
    sawRelative ||= isRelative;
    previous[key] = await canonicalizePotentialPath(raw, legacyRoot);
  }

  if (sawRelative && !input.relativePathPolicy) {
    throw new Error(
      "relative FileStation paths require an explicit --relative-path-policy preserve|managed decision",
    );
  }
  const relativePathPolicy = input.relativePathPolicy ?? "preserve";

  for (const key of PATH_KEYS) {
    const raw = configured[key];
    const relative = !path.isAbsolute(nativePath(raw));
    const override = input.overrides?.[key];
    let requestedPolicy: BootstrapPathChange["requestedPolicy"];
    if (override !== undefined) {
      if (!path.isAbsolute(nativePath(override))) {
        throw new Error(`--${key} must be an absolute canonical path`);
      }
      proposed[key] = await canonicalizePotentialPath(override, process.cwd());
      requestedPolicy = "absolute";
    } else if (!relative) {
      proposed[key] = previous[key];
      requestedPolicy = "absolute";
    } else {
      proposed[key] = await canonicalizePotentialPath(
        raw,
        relativePathPolicy === "preserve" ? legacyRoot : installRoot,
      );
      requestedPolicy = relativePathPolicy;
    }
    const changed = !sameCanonicalPath(previous[key], proposed[key]);
    if (
      changed &&
      requestedPolicy === "absolute" &&
      input.acceptPathChange !== true
    ) {
      throw new Error(
        `${key} path change requires --accept-path-change after administrator review`,
      );
    }
    changes.push({
      key,
      configured: configured[key],
      previous: previous[key],
      proposed: proposed[key],
      changed,
      requestedPolicy,
    });
  }

  return {
    legacyRoot,
    installRoot,
    previous,
    proposed,
    changes,
    relativePathPolicy,
  };
}
