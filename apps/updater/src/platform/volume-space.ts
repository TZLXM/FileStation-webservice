import path from "node:path";
import { lstat, stat } from "node:fs/promises";
import {
  NodeDurableFileSystem,
  createWindowsNativeApi,
} from "./durable-fs";

const DEFAULT_MINIMUM_SAFETY_MARGIN = 64 * 1024 * 1024;

export interface VolumePathSet {
  installRoot: string;
  artifactStaging: string;
  releases: string;
  retainedRelease: string;
  database: string;
  wal: string;
  shm: string;
  temp: string;
  backups: string;
  snapshot: string;
  restoreTemp: string;
}

export interface VolumeManifest {
  database_migration: boolean;
  migration_workspace_multiplier: number;
  migration_workspace_min_bytes: number;
  artifacts: Array<{
    platform?: "windows-x64" | "linux-x64";
    archive_size: number;
    unpacked_size: number;
  }>;
}

export interface SqliteMetrics {
  pageCount: number;
  pageSize: number;
  dbFileBytes: number;
  walBytes: number;
  shmBytes: number;
  snapshotBytes: number;
}

export interface VolumeBudgetComponent {
  name: string;
  bytes: number;
  path: string;
}

export interface VolumePlan {
  volumeId: string;
  availableBytes: number;
  requiredBytes: number;
  safetyMarginBytes: number;
  sufficient: boolean;
  components: VolumeBudgetComponent[];
}

export interface VolumePlanOptions {
  resolveVolumeId?: (candidate: string) => Promise<string>;
  readAvailableBytes?: (
    volumeId: string,
    candidate: string,
  ) => Promise<number>;
  minimumSafetyMarginBytes?: number;
  retainedReleaseBytes?: number;
  artifactPlatform?: "windows-x64" | "linux-x64";
}

export interface VolumeRecheck {
  plan: VolumePlan[];
  changed: boolean;
  sufficient: boolean;
}

export interface ActualVolume {
  volumeId: string;
  availableBytes: number;
  capacityBytes: number;
}

function integer(value: number, field: string, allowZero = true): number {
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1)
  )
    throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}

function validateManifest(manifest: VolumeManifest): void {
  if (!manifest || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length)
    throw new Error("manifest artifacts are missing");
  for (const artifact of manifest.artifacts) {
    integer(artifact.archive_size, "artifact archive size", false);
    integer(artifact.unpacked_size, "artifact unpacked size", false);
  }
  if (manifest.database_migration) {
    integer(manifest.migration_workspace_min_bytes, "migration minimum");
    if (
      typeof manifest.migration_workspace_multiplier !== "number" ||
      !Number.isFinite(manifest.migration_workspace_multiplier) ||
      manifest.migration_workspace_multiplier < 2 ||
      manifest.migration_workspace_multiplier > 64
    )
      throw new Error("migration workspace multiplier is invalid");
  } else if (
    manifest.migration_workspace_multiplier !== 0 ||
    manifest.migration_workspace_min_bytes !== 0
  ) {
    throw new Error("non-migration manifest must use zero workspace fields");
  }
}

function validateMetrics(metrics: SqliteMetrics): void {
  for (const [field, value] of Object.entries(metrics))
    integer(value, field);
}

function normalize(candidate: string): string {
  if (typeof candidate !== "string" || !candidate.trim())
    throw new Error("volume path is empty");
  return path.resolve(candidate);
}

async function firstExistingAncestor(candidate: string): Promise<string> {
  let cursor = path.resolve(candidate);
  while (true) {
    try {
      await lstat(cursor);
      return cursor;
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error as { code?: string }).code !== "ENOENT"
      )
        throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}

export function windowsVolumeIdentity(candidate: string, api: { volumePath(filename: string): string; volumeGuid(mount: string): string }): string {
  return `win32:${api.volumeGuid(api.volumePath(candidate)).toLowerCase()}`;
}

export async function probeActualVolume(
  candidate: string,
): Promise<ActualVolume> {
  const normalized = normalize(candidate);
  const existing = await firstExistingAncestor(normalized);
  const durable = new NodeDurableFileSystem();
  const space = await durable.statfs(existing);
  if (process.platform === "win32") {
    const api = createWindowsNativeApi();

    return {
      volumeId: windowsVolumeIdentity(existing, api),
      ...space,
    };
  }
  const value = await stat(existing);
  return {
    volumeId: `posix:${value.dev}`,
    ...space,
  };
}

function artifactTotals(
  manifest: VolumeManifest,
  selectedPlatform: "windows-x64" | "linux-x64",
): {
  archive: number;
  unpacked: number;
} {
  const hasPlatformLabels = manifest.artifacts.some(
    (artifact) => artifact.platform !== undefined,
  );
  const selected = hasPlatformLabels
    ? manifest.artifacts.filter(
        (artifact) => artifact.platform === selectedPlatform,
      )
    : manifest.artifacts;
  if (!selected.length)
    throw new Error(
      `manifest has no artifact for ${selectedPlatform}`,
    );
  let archive = 0;
  let unpacked = 0;
  for (const artifact of selected) {
    archive += artifact.archive_size;
    unpacked += artifact.unpacked_size;
  }
  integer(archive, "aggregate artifact archive size");
  integer(unpacked, "aggregate unpacked size");
  return { archive, unpacked };
}

function migrationBytes(
  manifest: VolumeManifest,
  metrics: SqliteMetrics,
): number {
  if (!manifest.database_migration) return 0;
  const logicalPages = metrics.pageCount * metrics.pageSize;
  integer(logicalPages, "SQLite logical page bytes");
  const base = Math.max(
    logicalPages,
    metrics.dbFileBytes,
    metrics.snapshotBytes,
  );
  return Math.max(
    Math.ceil(base * manifest.migration_workspace_multiplier),
    manifest.migration_workspace_min_bytes,
  );
}

function componentsFor(
  paths: VolumePathSet,
  manifest: VolumeManifest,
  metrics: SqliteMetrics,
  retainedReleaseBytes: number,
  selectedPlatform: "windows-x64" | "linux-x64",
): VolumeBudgetComponent[] {
  const artifacts = artifactTotals(manifest, selectedPlatform);
  return [
    {
      name: "artifact-archive",
      bytes: artifacts.archive,
      path: normalize(paths.artifactStaging),
    },
    {
      name: "artifact-unpacked",
      bytes: artifacts.unpacked,
      path: normalize(paths.releases),
    },
    {
      name: "retained-release",
      bytes: retainedReleaseBytes,
      path: normalize(paths.retainedRelease),
    },
    {
      name: "install-root",
      bytes: 0,
      path: normalize(paths.installRoot),
    },
    {
      name: "database",
      bytes: metrics.dbFileBytes,
      path: normalize(paths.database),
    },
    {
      name: "database-wal",
      bytes: metrics.walBytes,
      path: normalize(paths.wal),
    },
    {
      name: "database-shm",
      bytes: metrics.shmBytes,
      path: normalize(paths.shm),
    },
    {
      name: "temp-workspace",
      bytes: 0,
      path: normalize(paths.temp),
    },
    {
      name: "backup-directory",
      bytes: 0,
      path: normalize(paths.backups),
    },
    {
      name: "snapshot",
      bytes: metrics.snapshotBytes,
      path: normalize(paths.snapshot),
    },
    {
      name: "restore-temp",
      bytes: metrics.snapshotBytes,
      path: normalize(paths.restoreTemp),
    },
    {
      name: "migration-workspace",
      bytes: migrationBytes(manifest, metrics),
      path: normalize(paths.database),
    },
  ];
}

export async function planRequiredSpace(
  paths: VolumePathSet,
  manifest: VolumeManifest,
  sqliteMetrics: SqliteMetrics,
  options: VolumePlanOptions = {},
): Promise<VolumePlan[]> {
  validateManifest(manifest);
  validateMetrics(sqliteMetrics);
  const minimumMargin = integer(
    options.minimumSafetyMarginBytes ?? DEFAULT_MINIMUM_SAFETY_MARGIN,
    "minimum safety margin",
  );
  const selectedPlatform =
    options.artifactPlatform ??
    (process.platform === "win32" ? "windows-x64" : "linux-x64");
  const retained = integer(
    options.retainedReleaseBytes ??
      artifactTotals(manifest, selectedPlatform).unpacked,
    "retained release bytes",
  );
  const resolve =
    options.resolveVolumeId ?? (async (candidate) => (await probeActualVolume(candidate)).volumeId);
  const available =
    options.readAvailableBytes ??
    (async (_volumeId, candidate) =>
      (await probeActualVolume(candidate)).availableBytes);

  const grouped = new Map<
    string,
    { components: VolumeBudgetComponent[]; samplePath: string }
  >();
  for (const component of componentsFor(
    paths,
    manifest,
    sqliteMetrics,
    retained,
    selectedPlatform,
  )) {
    const volumeId = await resolve(component.path);
    if (!volumeId) throw new Error("volume resolver returned an empty id");
    const group = grouped.get(volumeId);
    if (group) group.components.push(component);
    else
      grouped.set(volumeId, {
        components: [component],
        samplePath: component.path,
      });
  }

  const plans: VolumePlan[] = [];
  for (const [volumeId, group] of grouped) {
    const subtotal = group.components.reduce(
      (sum, component) => sum + component.bytes,
      0,
    );
    integer(subtotal, `volume ${volumeId} subtotal`);
    const safetyMarginBytes = Math.max(
      minimumMargin,
      Math.ceil(subtotal * 0.1),
    );
    const requiredBytes = subtotal + safetyMarginBytes;
    integer(requiredBytes, `volume ${volumeId} required bytes`);
    const availableBytes = integer(
      await available(volumeId, group.samplePath),
      `volume ${volumeId} available bytes`,
    );
    plans.push({
      volumeId,
      availableBytes,
      requiredBytes,
      safetyMarginBytes,
      sufficient: availableBytes >= requiredBytes,
      components: group.components,
    });
  }
  return plans.sort((left, right) =>
    left.volumeId.localeCompare(right.volumeId),
  );
}

function samePlan(left: VolumePlan[], right: VolumePlan[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Call immediately before entering maintenance with fresh WAL and
 * filesystem statistics. The function never frees or deletes rollback assets.
 */
export async function recheckRequiredSpace(
  paths: VolumePathSet,
  manifest: VolumeManifest,
  sqliteMetrics: SqliteMetrics,
  previousPlan: VolumePlan[],
  options: VolumePlanOptions = {},
): Promise<VolumeRecheck> {
  const plan = await planRequiredSpace(
    paths,
    manifest,
    sqliteMetrics,
    options,
  );
  return {
    plan,
    changed: !samePlan(previousPlan, plan),
    sufficient: plan.every((entry) => entry.sufficient),
  };
}
