import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { DataSource } from 'typeorm';
import {
  planRequiredSpace,
  SqliteMetrics,
  VolumePathSet,
} from '@filestation/updater';
import type { VerifiedUpdateCandidate } from './update-types';

async function fileBytes(filename: string): Promise<number> {
  try {
    return (await stat(filename)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

@Injectable()
export class UpdateSpacePreflightService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  async assertSufficient(
    root: string,
    stagingDirectory: string,
    candidate: VerifiedUpdateCandidate,
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
    const metrics: SqliteMetrics = {
      pageCount: Number(pageCount?.page_count ?? 0),
      pageSize: Number(pageSize?.page_size ?? 0),
      dbFileBytes: await fileBytes(database),
      walBytes: await fileBytes(`${database}-wal`),
      shmBytes: await fileBytes(`${database}-shm`),
      snapshotBytes: await fileBytes(database),
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
      restoreTemp: path.join(temp, 'update-restore'),
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
      { artifactPlatform: candidate.artifact.platform },
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
