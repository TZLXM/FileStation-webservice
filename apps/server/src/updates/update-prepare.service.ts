import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import {
  extractVerifiedArchive,
  inspectArchive,
  openVerifiedArchive,
  validateReleaseAssetUrl,
} from '@filestation/update-core';
import { UpdateCapabilityService } from './update-capability.service';
import { UpdateCheckService } from './update-check.service';
import { UpdateSpacePreflightService } from './update-space-preflight.service';
import { UpdateOperationReservationService } from './update-operation-reservation.service';
import {
  UPDATE_FETCH,
  UPDATE_NOW,
  UPDATE_RANDOM_ID,
} from './updates.tokens';
import {
  PreparedUpdateReceipt,
  UpdateSelection,
  VerifiedUpdateCandidate,
} from './update-types';

const DEFAULT_PREPARED_TTL_MS = 15 * 60 * 1000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;
const DOWNLOAD_HOSTS = new Set([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);

interface PreparedEntry {
  receipt: PreparedUpdateReceipt;
  stageDirectory: string;
}

function within(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function downloadUrl(value: string, initial: URL): URL {
  const url = new URL(value, initial);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw new Error('Untrusted update download redirect');
  }
  if (url.hostname === 'github.com') {
    validateReleaseAssetUrl(url.href);
    return url;
  }
  if (
    DOWNLOAD_HOSTS.has(url.hostname) &&
    url.pathname.startsWith('/') &&
    !url.href.includes('\\')
  ) {
    return url;
  }
  throw new Error('Untrusted update download redirect');
}

@Injectable()
export class UpdatePrepareService implements OnModuleDestroy {
  private readonly prepared = new Map<string, PreparedEntry>();
  private readonly preparing = new Set<Promise<PreparedUpdateReceipt>>();
  private readonly downloads = new Set<AbortController>();
  private stopped = false;

  constructor(
    private readonly checks: UpdateCheckService,
    private readonly capability: UpdateCapabilityService,
    private readonly space: UpdateSpacePreflightService,
    private readonly operations: UpdateOperationReservationService,
    private readonly config: ConfigService,
    @Inject(UPDATE_FETCH) private readonly fetchImpl: typeof fetch,
    @Inject(UPDATE_NOW) private readonly now: () => number,
    @Inject(UPDATE_RANDOM_ID) private readonly randomId: () => string,
  ) {}

  async prepare(selection: UpdateSelection): Promise<PreparedUpdateReceipt> {
    if(this.stopped) throw new ConflictException('Update preparation is shutting down');
    const pending=this.prepareOwned(selection);
    this.preparing.add(pending);
    try {return await pending;} finally {this.preparing.delete(pending);}
  }

  private async prepareOwned(selection: UpdateSelection): Promise<PreparedUpdateReceipt> {
    const capability = await this.capability.inspect();
    if (
      capability.mode !== 'managed' ||
      !capability.supported ||
      !capability.install_root
    ) {
      throw new ConflictException({
        code: capability.reason ?? 'UPDATE_UNSUPPORTED',
        message: 'This installation cannot prepare an automatic update',
      });
    }
    const candidate = await this.checks.resolveCandidate(selection);
    if (
      candidate.manifest.version !== selection.version ||
      candidate.manifest_sha256 !== selection.manifest_sha256 ||
      candidate.artifact.sha256 !== selection.artifact_sha256
    ) {
      throw new ConflictException({
        code: 'UPDATE_SELECTION_STALE',
        message: 'The verified update selection changed; check again',
      });
    }
    if (
      candidate.artifact.platform !== capability.platform ||
      candidate.artifact.arch !== 'x64'
    ) {
      throw new ConflictException({
        code: 'UPDATE_PLATFORM_UNSUPPORTED',
        message: 'The verified artifact does not target this installation',
      });
    }

    const root = path.resolve(capability.install_root);
    const actualRoot = await realpath(root);
    if (actualRoot !== root) {
      throw new ConflictException({
        code: 'UPDATE_INSTALL_ROOT_INVALID',
        message: 'The managed install root is not canonical',
      });
    }
    const operation = await this.operations.acquire(root, 'prepare');
    try {
      if(this.stopped) throw new ConflictException('Update preparation is shutting down');
      const stagingRoot = path.join(root, '.filestation-update-staging');
      await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      const stagingStat = await lstat(stagingRoot);
      if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink()) {
        throw new ConflictException({
          code: 'UPDATE_STAGING_UNSAFE',
          message: 'The update staging root is unsafe',
        });
      }
      if ((await realpath(stagingRoot)) !== stagingRoot) {
        throw new ConflictException({
          code: 'UPDATE_STAGING_UNSAFE',
          message: 'The update staging root escapes the managed installation',
        });
      }

      const stageDirectory = await mkdtemp(
        path.join(stagingRoot, 'prepare-'),
      );
      let completed = false;
      try {
        await this.space.assertSufficient(root, stageDirectory, candidate);
        const archivePath = path.join(
          stageDirectory,
          candidate.artifact.filename,
        );
        await this.downloadArtifact(candidate, archivePath);
        const archiveInfo = await stat(archivePath);
        if (archiveInfo.size !== candidate.artifact.archive_size) {
          throw new BadGatewayException({
            code: 'UPDATE_DOWNLOAD_SIZE_MISMATCH',
            message: 'The downloaded update archive size is invalid',
          });
        }

        const handle = await openVerifiedArchive(
          archivePath,
          candidate.artifact.sha256,
        );
        const payloadPath = path.join(stageDirectory, 'payload');
        try {
          const plan = await inspectArchive(handle, {
            format: candidate.artifact.format,
            version: candidate.manifest.version,
            platform: candidate.artifact.platform,
            unpackedSize: candidate.artifact.unpacked_size,
            maxArchiveBytes: candidate.artifact.archive_size,
            maxTotalBytes: candidate.artifact.unpacked_size,
          });
          if (plan.unpackedSize !== candidate.artifact.unpacked_size) {
            throw new Error('Unpacked size does not match the signed manifest');
          }
          await extractVerifiedArchive(handle, plan, payloadPath);
        } finally {
          await handle.close();
        }

        const verifiedPayload = await realpath(payloadPath);
        if(this.stopped) throw new ConflictException('Update preparation is shutting down');
        if (!within(stageDirectory, verifiedPayload)) {
          throw new Error('Extracted payload escaped its staging tree');
        }
        const preparedId = this.randomId();
        if (this.prepared.has(preparedId)) {
          throw new Error('Prepared update identifier collision');
        }
        const expiresAt =
          this.now() +
          (this.config.get<number>('app.updatePreparedTtlMs') ??
            DEFAULT_PREPARED_TTL_MS);
        const receipt: PreparedUpdateReceipt = Object.freeze({
          space_budget: Object.freeze({
            database_migration: candidate.manifest.database_migration,
            migration_workspace_multiplier: candidate.manifest.migration_workspace_multiplier,
            migration_workspace_min_bytes: candidate.manifest.migration_workspace_min_bytes,
          }),
          prepared_id: preparedId,
          manifest_sha256: candidate.manifest_sha256,
          artifact_sha256: candidate.artifact.sha256,
          version: candidate.manifest.version,
          platform: candidate.artifact.platform,
          arch: candidate.artifact.arch,
          staging_path: verifiedPayload,
          verified_size: archiveInfo.size,
          unpacked_size: planSize(candidate),
          expires_at: expiresAt,
        });
        this.prepared.set(preparedId, { receipt, stageDirectory });
        completed = true;
        return receipt;
      } finally {
        if (!completed) {
          await rm(stageDirectory, { recursive: true, force: true });
        }
      }
    } finally {
      await operation.release();
    }
  }

  async consume(preparedId: string): Promise<PreparedUpdateReceipt | null> {
    const entry = this.prepared.get(preparedId);
    if (!entry) return null;
    this.prepared.delete(preparedId);
    if (entry.receipt.expires_at <= this.now()) {
      await rm(entry.stageDirectory, { recursive: true, force: true });
      return null;
    }
    return entry.receipt;
  }

  async cancel(preparedId: string): Promise<void> {
    const entry = this.prepared.get(preparedId);
    if (!entry) return;
    this.prepared.delete(preparedId);
    await rm(entry.stageDirectory, { recursive: true, force: true });
  }

  async discard(receipt: PreparedUpdateReceipt): Promise<void> {
    const stageDirectory = path.dirname(receipt.staging_path);
    await rm(stageDirectory, { recursive: true, force: true });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    for(const download of this.downloads) download.abort();
    await Promise.allSettled([...this.preparing]);
    const entries = [...this.prepared.values()];
    this.prepared.clear();
    await Promise.all(
      entries.map((entry) =>
        rm(entry.stageDirectory, { recursive: true, force: true }),
      ),
    );
  }

  private async downloadArtifact(
    candidate: VerifiedUpdateCandidate,
    destination: string,
  ): Promise<void> {
    const initial = validateReleaseAssetUrl(candidate.artifact.url);
    const controller = new AbortController();
    this.downloads.add(controller);
    if(this.stopped) controller.abort();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.get<number>('app.updateDownloadTimeoutMs') ??
        DEFAULT_DOWNLOAD_TIMEOUT_MS,
    );
    let current = initial;
    try {
      for (let redirects = 0; ; redirects += 1) {
        const response = await this.fetchImpl(current.href, {
          redirect: 'manual',
          credentials: 'omit',
          signal: controller.signal,
          headers: { Accept: 'application/octet-stream' },
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location || redirects >= MAX_REDIRECTS) {
            throw new Error('Update download redirect limit');
          }
          current = downloadUrl(location, current);
          continue;
        }
        if (
          response.status !== 200 ||
          response.redirected ||
          (response.url && response.url !== current.href) ||
          !response.body
        ) {
          await response.body?.cancel();
          throw new Error('Unexpected update download response');
        }
        const declared = response.headers.get('content-length');
        if (
          declared &&
          (!/^\d+$/.test(declared) ||
            Number(declared) !== candidate.artifact.archive_size)
        ) {
          await response.body.cancel();
          throw new Error('Update download content length mismatch');
        }

        const file = await open(destination, 'wx', 0o600);
        const hash = createHash('sha256');
        let observed = 0;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          reader = response.body.getReader();
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            const bytes = Buffer.from(chunk.value);
            observed += bytes.length;
            if (observed > candidate.artifact.archive_size) {
              throw new Error('Update download exceeded its signed size');
            }
            hash.update(bytes);
            await file.write(bytes);
          }
          if (
            observed !== candidate.artifact.archive_size ||
            hash.digest('hex') !== candidate.artifact.sha256
          ) {
            throw new Error('Update download hash or size mismatch');
          }
          await file.sync();
        } finally {
          await reader?.cancel().catch(() => undefined);
          await file.close();
        }
        return;
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new BadGatewayException({
          code: 'UPDATE_DOWNLOAD_TIMEOUT',
          message: 'The update download timed out',
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.downloads.delete(controller);
    }
  }
}

function planSize(candidate: VerifiedUpdateCandidate): number {
  return candidate.artifact.unpacked_size;
}
