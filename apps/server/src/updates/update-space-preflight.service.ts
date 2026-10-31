import { ConflictException, Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lstat, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { DataSource } from 'typeorm';
import {
  planRequiredSpace,
  SqliteMetrics,
  VolumePathSet,
  VolumePlanOptions,
} from '@filestation/updater';
import type { PreparedUpdateReceipt, VerifiedUpdateCandidate } from './update-types';

export const UPDATE_VOLUME_PLAN_OPTIONS = Symbol('UPDATE_VOLUME_PLAN_OPTIONS');

type CandidateSpaceBudget = {
  manifest: Pick<VerifiedUpdateCandidate['manifest'], 'database_migration' | 'migration_workspace_multiplier' | 'migration_workspace_min_bytes'>;
  artifact: Pick<VerifiedUpdateCandidate['artifact'], 'platform' | 'archive_size' | 'unpacked_size'>;
};

async function fileBytes(filename: string): Promise<number> {
  try {
    return (await stat(filename)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

async function verifiedSnapshotFloor(root: string): Promise<number> {
  const backups = path.join(root, 'backups');
  let entries;
  try {
    entries = await readdir(backups, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }

  let floor = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const snapshot = path.join(backups, entry.name, 'update-snapshot.sqlite');
    try {
      const info = await lstat(snapshot);
      if (info.isFile() && !info.isSymbolicLink()) {
        floor = Math.max(floor, info.size);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return floor;
}

@Injectable()
export class UpdateSpacePreflightService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    @Optional() @Inject(UPDATE_VOLUME_PLAN_OPTIONS)
    private readonly volumeOptions: VolumePlanOptions = {},
  ) {}

  async assertPreparedSufficient(root: string, receipt: PreparedUpdateReceipt): Promise<void> {
    if (!receipt.space_budget) throw new Error('Prepared update sizing facts are unavailable');
    const platform = receipt.platform;
    if (platform !== 'windows-x64' && platform !== 'linux-x64') throw new Error('Prepared update platform is unsupported');
    await this.assertSufficient(root, path.dirname(receipt.staging_path), {
      manifest: receipt.space_budget,
      artifact: { platform, archive_size: receipt.verified_size, unpacked_size: receipt.unpacked_size },
    });
  }

  async assertSufficient(
    root: string,
    stagingDirectory: string,
    candidate: CandidateSpaceBudget,
  ): Promise<void> {
    const database = this.config.get<string>('app.dbPath');
    const storage = this.config.get<string>('app.storagePath');
    const temp = this.config.get<string>('app.tempPath');
    if (!database || !storage || !temp) {
      throw new ConflictException({
        code: 'UPDATE_PATHS_UNAVAILABLE',
        message: 'Managed update paths are not configured',
      });
    }

    const pageCount = (
      (await this.dataSource.query('PRAGMA page_count')) as Array<
        Record<string, unknown>
      >
    )[0];
    const pageSize = (
      (await this.dataSource.query('PRAGMA page_size')) as Array<
        Record<string, unknown>
      >
    )[0];
    const pageCountValue = Number(pageCount?.page_count ?? 0);
    const pageSizeValue = Number(pageSize?.page_size ?? 0);
    const dbFileBytes = await fileBytes(database);
    const logicalPageBytes = pageCountValue * pageSizeValue;
    const existingVerifiedSnapshotBytes = await verifiedSnapshotFloor(root);
    const metrics: SqliteMetrics = {
      pageCount: pageCountValue,
      pageSize: pageSizeValue,
      dbFileBytes,
      walBytes: await fileBytes(`${database}-wal`),
      shmBytes: await fileBytes(`${database}-shm`),
      snapshotBytes: Math.max(
        logicalPageBytes,
        dbFileBytes,
        existingVerifiedSnapshotBytes,
      ),
    };
    const paths: VolumePathSet = {
      installRoot: root,
      artifactStaging: stagingDirectory,
      releases: path.join(root, 'releases'),
      retainedRelease: path.join(root, 'current'),
      database,
      wal: `${database}-wal`,
      shm: `${database}-shm`,
      temp,
      backups: path.join(root, 'backups'),
      snapshot: path.join(root, 'backups', 'preflight', 'update-snapshot.sqlite'),
      restoreTemp: `${database}.restore-preflight`,
    };
    const plans = await planRequiredSpace(
      paths,
      {
        database_migration: candidate.manifest.database_migration,
        migration_workspace_multiplier:
          candidate.manifest.migration_workspace_multiplier,
        migration_workspace_min_bytes:
          candidate.manifest.migration_workspace_min_bytes,
        artifacts: [candidate.artifact],
      },
      metrics,
      { ...this.volumeOptions, artifactPlatform: candidate.artifact.platform },
    );
    if (plans.some((plan) => !plan.sufficient)) {
      throw new ConflictException({
        code: 'UPDATE_DISK_SPACE_INSUFFICIENT',
        message: 'There is not enough space to prepare the update safely',
        volumes: plans.map((plan) => ({
          volume_id: plan.volumeId,
          available_bytes: plan.availableBytes,
          required_bytes: plan.requiredBytes,
        })),
      });
    }
  }
}
