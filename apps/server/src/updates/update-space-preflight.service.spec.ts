import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import {
  mkdir,
  mkdtemp,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DataSource } from 'typeorm';
import {
  UpdateSpacePreflightService,
  UPDATE_VOLUME_PLAN_OPTIONS,
} from './update-space-preflight.service';
import { VerifiedUpdateCandidate } from './update-types';

const logicalBytes = 200 * 1024 * 1024;

describe('UpdateSpacePreflightService', () => {
  let base: string;
  let root: string;
  let database: string;
  let temp: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'filestation-update-space-'));
    root = path.join(base, 'install');
    database = path.join(base, 'database', 'filestation.db');
    temp = path.join(base, 'temp');
    await Promise.all([
      mkdir(root, { recursive: true }),
      mkdir(path.dirname(database), { recursive: true }),
      mkdir(temp, { recursive: true }),
    ]);
    await writeFile(database, Buffer.alloc(4096, 1));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function service(available: Record<string, number>): UpdateSpacePreflightService {
    const dataSource = {
      query: jest.fn(async (sql: string) =>
        sql.includes('page_count')
          ? [{ page_count: logicalBytes / 4096 }]
          : [{ page_size: 4096 }],
      ),
    } as unknown as DataSource;
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'app.dbPath') return database;
        if (key === 'app.storagePath') return path.join(base, 'storage');
        if (key === 'app.tempPath') return temp;
        return undefined;
      }),
    } as unknown as ConfigService;
    const volumeOptions = {
      minimumSafetyMarginBytes: 0,
      retainedReleaseBytes: 0,
      artifactPlatform: 'windows-x64' as const,
      resolveVolumeId: async (candidate: string) => {
        const relative = path.relative(base, candidate);
        if (
          relative === `install${path.sep}backups` ||
          relative.startsWith(`install${path.sep}backups${path.sep}`)
        ) {
          return 'backup-volume';
        }
        if (
          relative === 'install' ||
          relative.startsWith(`install${path.sep}`)
        ) {
          return 'install-volume';
        }
        if (relative.startsWith(`database${path.sep}`)) return 'database-volume';
        if (relative.startsWith(`temp${path.sep}`) || relative === 'temp') {
          return 'temp-volume';
        }
        throw new Error(`unexpected volume path ${candidate}`);
      },
      readAvailableBytes: async (volumeId: string) => available[volumeId] ?? 0,
    };
    return new UpdateSpacePreflightService(
      dataSource,
      config,
      volumeOptions,
    );
  }

  const candidate: Pick<VerifiedUpdateCandidate, 'manifest' | 'artifact'> = {
    manifest: {
      database_migration: false,
      migration_workspace_multiplier: 0,
      migration_workspace_min_bytes: 0,
    } as VerifiedUpdateCandidate['manifest'],
    artifact: {
      platform: 'windows-x64',
      archive_size: 1,
      unpacked_size: 1,
    } as VerifiedUpdateCandidate['artifact'],
  };

  it('rejects before maintenance when the WAL-inclusive snapshot exceeds the backup volume', async () => {
    const preflight = service({
      'install-volume': logicalBytes * 2,
      'database-volume': logicalBytes * 2,
      'temp-volume': logicalBytes * 2,
      'backup-volume': logicalBytes / 2,
    });

    let failure: ConflictException | undefined;
    try {
      await preflight.assertSufficient(root, path.join(root, 'staging'), {
        manifest: candidate.manifest,
        artifact: candidate.artifact,
      });
    } catch (error) {
      if (error instanceof ConflictException) failure = error;
      else throw error;
    }

    expect(failure?.getResponse()).toMatchObject({
      code: 'UPDATE_DISK_SPACE_INSUFFICIENT',
      volumes: expect.arrayContaining([
        expect.objectContaining({
          required_bytes: expect.any(Number),
        }),
      ]),
    });
    const response = failure?.getResponse() as {
      volumes: Array<{
        volume_id: string;
        required_bytes: number;
        available_bytes: number;
      }>;
    };
    const backup = response.volumes.find(
      (volume) => volume.volume_id === 'backup-volume',
    );
    expect(backup).toBeDefined();
    expect(backup?.available_bytes).toBe(logicalBytes / 2);
    expect(backup?.required_bytes).toBeGreaterThanOrEqual(logicalBytes);
  });

  it('charges restore publication beside the database instead of upload temp', async () => {
    const preflight = service({
      'install-volume': logicalBytes * 2,
      'database-volume': logicalBytes * 2,
      'temp-volume': 0,
      'backup-volume': logicalBytes * 2,
    });

    await expect(
      preflight.assertSufficient(root, path.join(root, 'staging'), {
        manifest: candidate.manifest,
        artifact: candidate.artifact,
      }),
    ).resolves.toBeUndefined();
  });
});
