import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, KeyObject } from 'node:crypto';
import {
  fetchLatestRelease,
  selectUpdate,
  VerifiedManifestV1,
} from '@filestation/update-core';
import { UpdateCapabilityService } from './update-capability.service';
import { WriteBarrierService } from '../maintenance/write-barrier.service';
import {
  UPDATE_FETCH,
  UPDATE_NODE_VERSION,
  UPDATE_NOW,
  UPDATE_PRODUCT_VERSION,
  UPDATE_RANDOM,
  UPDATE_TRUSTED_KEY,
} from './updates.tokens';
import {
  UpdateCapability,
  UpdateCheckView,
  UpdateSelection,
  VerifiedUpdateCandidate,
} from './update-types';

const CACHE_WINDOW_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MANUAL_INTERVAL_MS = 60_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 30 * 60 * 1000;
const MAINTENANCE_RECHECK_MS = 60_000;

interface CacheEntry {
  status: UpdateCheckView;
  candidate: VerifiedUpdateCandidate | null;
  expiresAt: number;
  lastAttemptAt: number;
  lastRefreshError?: {
    error_code: string;
    message: string;
    checked_at: string;
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function manifestDigest(manifest: VerifiedManifestV1): string {
  return createHash('sha256')
    .update(canonicalJson(manifest), 'utf8')
    .digest('hex');
}

function cloneStatus(status: UpdateCheckView): UpdateCheckView {
  return structuredClone(status);
}

@Injectable()
export class UpdateCheckService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(UpdateCheckService.name);
  private cache?: CacheEntry;
  private inFlight?: Promise<UpdateCheckView>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private failedAttempts = 0;

  constructor(
    private readonly capabilityService: UpdateCapabilityService,
    private readonly config: ConfigService,
    @Inject(UPDATE_FETCH) private readonly fetchImpl: typeof fetch,
    @Inject(UPDATE_TRUSTED_KEY)
    private readonly trustedKey: () => KeyObject | null,
    @Inject(UPDATE_NOW) private readonly now: () => number,
    @Inject(UPDATE_RANDOM) private readonly random: () => number,
    @Inject(UPDATE_PRODUCT_VERSION) private readonly productVersion: string,
    @Inject(UPDATE_NODE_VERSION) private readonly nodeVersion: string,
    @Optional()
    private readonly barrier?: WriteBarrierService,
  ) {}

  onApplicationBootstrap(): void {
    this.stopped = false;
    this.failedAttempts = 0;
    void this.runScheduledCheck();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  getCachedStatus(): UpdateCheckView {
    if (!this.cache) return this.unavailableStatus(null, 'not checked', null);
    const status = cloneStatus(this.cache.status);
    if (this.cache.lastRefreshError) {
      status.error_code = this.cache.lastRefreshError.error_code;
      status.message = this.cache.lastRefreshError.message;
    }
    return status;
  }

  async check(options: { force: boolean }): Promise<UpdateCheckView> {
    if (this.inFlight) {
      return cloneStatus(await this.inFlight);
    }
    const pending = this.performCheck(options);
    this.inFlight = pending;
    try {
      return cloneStatus(await pending);
    } finally {
      if (this.inFlight === pending) this.inFlight = undefined;
    }
  }

  private async performCheck(options: {
    force: boolean;
  }): Promise<UpdateCheckView> {
    const now = this.now();
    const key = this.trustedKey();
    if (!key) {
      return this.failWithoutFetch(
        'PUBLISHER_UNCONFIGURED',
        'Update publisher key is not configured',
        null,
      );
    }

    let capability: UpdateCapability;
    try {
      capability = await this.capabilityService.inspect();
    } catch {
      return this.failWithoutFetch(
        'UPDATE_CAPABILITY_UNAVAILABLE',
        'Update capability could not be determined',
        null,
      );
    }

    if (this.cache && !options.force && now < this.cache.expiresAt) {
      return this.getCachedStatus();
    }
    const manualInterval =
      this.config.get<number>('app.updateManualCheckIntervalMs') ??
      DEFAULT_MANUAL_INTERVAL_MS;
    if (
      this.cache &&
      now - this.cache.lastAttemptAt < manualInterval
    ) {
      return this.getCachedStatus();
    }

    const base = this.unavailableStatus(capability, 'checking', null);
    try {
      const manifest = await fetchLatestRelease({
        fetch: this.fetchImpl,
        trustedKey: key,
      });
      const digest = manifestDigest(manifest);
      const canInstallAutomatically =
        capability.mode === 'managed' &&
        capability.supported &&
        capability.install_root !== null &&
        capability.updater_version !== null;
      const selectionUpdaterVersion = canInstallAutomatically
        ? capability.updater_version!
        : capability.mode === 'managed' &&
            capability.reason === 'UPDATER_METADATA_INVALID'
          ? '0.0.0'
          : manifest.min_updater_version;
      const decision = selectUpdate(
        manifest,
        this.productVersion,
        process.platform,
        process.arch,
        selectionUpdaterVersion,
        this.nodeVersion,
      );
      const releaseFactsAvailable = ![
        'same_version',
        'downgrade',
        'invalid_version',
      ].includes(decision.status);
      const matchingArtifact = manifest.artifacts.find((artifact) => {
        const os = process.platform === 'win32' ? 'windows' : process.platform;
        return artifact.os === os && artifact.arch === process.arch;
      });
      const status: UpdateCheckView = {
        ...base,
        stage: 'idle',
        checked_at: new Date(now).toISOString(),
        decision: decision.status,
        available_version:
          releaseFactsAvailable ? manifest.version : null,
        candidate_commit:
          releaseFactsAvailable ? manifest.commit : null,
        manifest_sha256: digest,
        artifact_sha256:
          releaseFactsAvailable ? matchingArtifact?.sha256 ?? null : null,
        artifact_filename:
          releaseFactsAvailable ? matchingArtifact?.filename ?? null : null,
        archive_size:
          releaseFactsAvailable
            ? matchingArtifact?.archive_size ?? null
            : null,
        unpacked_size:
          releaseFactsAvailable
            ? matchingArtifact?.unpacked_size ?? null
            : null,
        release_summaries: manifest.release_summaries,
        release_notes_url: manifest.release_notes_url,
        upgrade_guide_url: manifest.upgrade_guide_url,
        message: this.resultMessage(capability, decision.status),
      };
      const candidate: VerifiedUpdateCandidate | null =
        decision.status === 'available' &&
        decision.artifact !== undefined &&
        canInstallAutomatically
          ? {
              manifest,
              artifact: decision.artifact,
              manifest_sha256: digest,
            }
          : null;
      const ttl = Math.round(
        CACHE_WINDOW_MS * (0.9 + 0.2 * this.random()),
      );
      this.cache = {
        status,
        candidate,
        expiresAt: now + ttl,
        lastAttemptAt: now,
        lastRefreshError: undefined,
      };
      return status;
    } catch {
      if (this.cache) {
        this.cache.lastAttemptAt = now;
        this.cache.lastRefreshError = {
          error_code: 'UPDATE_CHECK_FAILED',
          message: 'Update check failed; using the cached result',
          checked_at: new Date(now).toISOString(),
        };
        return this.getCachedStatus();
      }
      const failed: UpdateCheckView = {
        ...base,
        stage: 'failed',
        checked_at: new Date(now).toISOString(),
        decision: 'unavailable',
        error_code: 'UPDATE_CHECK_FAILED',
        message: 'Update check failed',
      };
      this.cache = {
        status: failed,
        candidate: null,
        expiresAt: now + CACHE_WINDOW_MS,
        lastAttemptAt: now,
      };
      return failed;
    }
  }

  async resolveCandidate(
    selection: UpdateSelection,
  ): Promise<VerifiedUpdateCandidate> {
    if (!this.cache?.candidate) {
      await this.check({ force: false });
    }
    const candidate = this.cache?.candidate;
    if (
      !candidate ||
      candidate.manifest.version !== selection.version ||
      candidate.manifest_sha256 !== selection.manifest_sha256 ||
      candidate.artifact.sha256 !== selection.artifact_sha256
    ) {
      throw new ConflictException({
        code: 'UPDATE_SELECTION_STALE',
        message: 'The verified update selection changed; check again',
      });
    }
    return candidate;
  }

  private unavailableStatus(
    capability: UpdateCapability | null,
    message: string,
    errorCode: string | null,
  ): UpdateCheckView {
    return {
      stage: errorCode ? 'failed' : 'idle',
      current_version: this.productVersion,
      available_version: null,
      candidate_commit: null,
      progress_percent: null,
      error_code: errorCode,
      message,
      checked_at: null,
      decision: 'unavailable',
      publisher_status: this.trustedKey() ? 'configured' : 'unconfigured',
      capability:
        capability ?? {
          mode: 'unavailable',
          supported: false,
          install_root: null,
          updater_version: null,
          platform: `${process.platform}-${process.arch}`,
          reason: errorCode,
        },
      updater_version: capability?.updater_version ?? null,
      manifest_sha256: null,
      artifact_sha256: null,
      artifact_filename: null,
      archive_size: null,
      unpacked_size: null,
      release_summaries: null,
      release_notes_url: null,
      upgrade_guide_url: null,
    };
  }

  private failWithoutFetch(
    code: string,
    message: string,
    capability: UpdateCapability | null,
  ): UpdateCheckView {
    return this.unavailableStatus(capability, message, code);
  }

  private capabilityMessage(capability: UpdateCapability): string {
    switch (capability.reason) {
      case 'DOCKER_MANUAL_UPGRADE':
        return 'Update the container image through the Docker deployment workflow';
      case 'UNMANAGED_INSTALL':
        return 'Automatic updates require a managed FileStation installation';
      case 'UNSUPPORTED_PLATFORM':
        return 'Automatic updates are available only on Windows x64 and Linux x64';
      case 'UPDATER_METADATA_INVALID':
        return 'The installed updater package is missing or invalid';
      default:
        return 'Automatic update capability is unavailable';
    }
  }

  private decisionMessage(decision: string): string {
    switch (decision) {
      case 'available':
        return 'A verified stable update is available';
      case 'same_version':
        return 'FileStation is up to date';
      case 'updater_required':
        return 'The installed updater must be upgraded manually';
      case 'manual_bootstrap':
        return 'This installation must be migrated manually before automatic updates';
      case 'node_required':
        return 'A newer supported Node.js runtime is required';
      case 'unsupported_platform':
        return 'The release does not support this platform';
      case 'downgrade':
        return 'The release is older than the installed version';
      case 'invalid_version':
        return 'The installed or release version is invalid';
      default:
        return 'No update is available';
    }
  }

  private resultMessage(
    capability: UpdateCapability,
    decision: string,
  ): string {
    const decisionMessage = this.decisionMessage(decision);
    const installAvailable =
      capability.mode === 'managed' &&
      capability.supported &&
      capability.install_root !== null &&
      capability.updater_version !== null;
    return installAvailable
      ? decisionMessage
      : `${decisionMessage}. ${this.capabilityMessage(capability)}`;
  }

  private async runScheduledCheck(): Promise<void> {
    if (this.stopped) return;
    if (this.barrier && !this.barrier.accepting) {
      this.schedule(MAINTENANCE_RECHECK_MS);
      return;
    }

    try {
      const status = await this.check({ force: true });
      if (status.error_code === 'UPDATE_CHECK_FAILED') {
        this.failedAttempts += 1;
        this.schedule(this.retryDelay());
      } else {
        this.failedAttempts = 0;
        this.schedule(this.periodicDelay());
      }
    } catch {
      this.failedAttempts += 1;
      this.logger.warn('scheduled update check failed');
      this.schedule(this.retryDelay());
    }
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runScheduledCheck();
    }, Math.max(0, delay));
    this.timer.unref?.();
  }

  private periodicDelay(): number {
    return Math.round(CACHE_WINDOW_MS * (0.9 + 0.2 * this.random()));
  }

  private retryDelay(): number {
    const backoff = Math.min(
      RETRY_MAX_MS,
      RETRY_BASE_MS * 2 ** Math.max(0, this.failedAttempts - 1),
    );
    return Math.round(backoff * (0.9 + 0.2 * this.random()));
  }
}
