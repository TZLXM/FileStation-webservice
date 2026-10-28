import type {
  LocalizedReleaseSummary,
  UpdateArtifact,
  UpdateStatusResponse,
} from '@filestation/shared';
import type { VerifiedManifestV1 } from '@filestation/update-core';
import type {
  BootIdentity,
} from '@filestation/updater';
import type { MaintenanceAttempt } from '../maintenance/write-freeze.service';

export type UpdateCapabilityMode =
  | 'managed'
  | 'docker'
  | 'unmanaged'
  | 'unsupported'
  | 'unavailable';

export interface UpdateCapability {
  mode: UpdateCapabilityMode;
  supported: boolean;
  install_root: string | null;
  updater_version: string | null;
  platform: string;
  reason: string | null;
}

export interface UpdateSelection {
  version: string;
  manifest_sha256: string;
  artifact_sha256: string;
}

export interface VerifiedUpdateCandidate {
  manifest: VerifiedManifestV1;
  artifact: UpdateArtifact;
  manifest_sha256: string;
}

export interface UpdateCheckView extends UpdateStatusResponse {
  checked_at: string | null;
  decision:
    | 'available'
    | 'same_version'
    | 'downgrade'
    | 'unsupported_platform'
    | 'node_required'
    | 'updater_required'
    | 'manual_bootstrap'
    | 'invalid_version'
    | 'unavailable';
  publisher_status: 'unconfigured' | 'configured';
  capability: UpdateCapability;
  updater_version: string | null;
  manifest_sha256: string | null;
  artifact_sha256: string | null;
  artifact_filename: string | null;
  archive_size: number | null;
  unpacked_size: number | null;
  release_summaries: Record<'zh-CN' | 'en', LocalizedReleaseSummary> | null;
  release_notes_url: string | null;
  upgrade_guide_url: string | null;
}

export interface PreparedUpdateReceipt {
  readonly prepared_id: string;
  readonly manifest_sha256: string;
  readonly artifact_sha256: string;
  readonly version: string;
  readonly platform: string;
  readonly arch: 'x64';
  readonly staging_path: string;
  readonly verified_size: number;
  readonly unpacked_size: number;
  readonly expires_at: number;
}

export interface InstallAcceptance {
  attempt: MaintenanceAttempt;
  attempt_id: string;
  fence: number;
  prepared_id: string;
  phase: 'PREPARED';
  accepted_at: string;
}

export interface UpdateJournalIdentity {
  current(): Promise<BootIdentity>;
  processCreatedAt(pid: number): Promise<string>;
}
