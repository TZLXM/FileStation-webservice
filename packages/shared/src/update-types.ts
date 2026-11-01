export const UPDATE_PROTOCOL_VERSION = 1 as const;

export const UPDATE_RELEASE_CATEGORIES = [
  "features",
  "fixes",
  "security",
  "upgrades",
  "breaking",
  "known_issues",
] as const;

export type UpdateReleaseCategory =
  (typeof UPDATE_RELEASE_CATEGORIES)[number];

export interface LocalizedReleaseItem {
  id: string;
  text: string;
}

export type LocalizedReleaseSummary = Partial<
  Record<UpdateReleaseCategory, LocalizedReleaseItem[]>
>;

export type UpdatePlatform = "linux-x64" | "windows-x64";
export type UpdateArchiveFormat = "tar.gz" | "zip";

export interface UpdateArtifact {
  platform: UpdatePlatform;
  os: "linux" | "windows";
  arch: "x64";
  filename: string;
  url: string;
  archive_size: number;
  unpacked_size: number;
  sha256: string;
  format: UpdateArchiveFormat;
}

export interface UpdateManifestV1 {
  version: string;
  commit: string;
  published_at: string;
  channel: "stable";
  minimum_node: string;
  database_migration: boolean;
  migration_workspace_multiplier: number;
  migration_workspace_min_bytes: number;
  breaking_changes: boolean;
  requires_manual_bootstrap: boolean;
  automatic_update_from: string;
  update_protocol: typeof UPDATE_PROTOCOL_VERSION;
  min_updater_version: string;
  release_notes_url: string;
  release_summaries: Record<"zh-CN" | "en", LocalizedReleaseSummary>;
  upgrade_guide_url: string;
  artifacts: UpdateArtifact[];
}

export type UpdateStage =
  | "idle"
  | "checking"
  | "downloading"
  | "verifying"
  | "backing_up"
  | "preparing"
  | "stopping"
  | "installing"
  | "starting"
  | "succeeded"
  | "failed"
  | "rolled_back";

export interface UpdateStatusResponse {
  stage: UpdateStage;
  current_version: string;
  available_version: string | null;
  candidate_commit: string | null;
  progress_percent: number | null;
  error_code: string | null;
  message: string | null;
}
