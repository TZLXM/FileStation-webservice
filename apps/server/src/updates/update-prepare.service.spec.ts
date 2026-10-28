import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildSafePublisherZip,
  buildZip,
  createSignedManifestFixture,
} from '../../test/update-fixtures';
import {
  UpdateCapabilityService,
} from './update-capability.service';
import { UpdateCheckService } from './update-check.service';
import { UpdatePrepareService } from './update-prepare.service';
import { UpdateSpacePreflightService } from './update-space-preflight.service';
import {
  UPDATE_FETCH,
  UPDATE_NOW,
  UPDATE_RANDOM_ID,
} from './updates.tokens';
import {
  UpdateCapability,
  VerifiedUpdateCandidate,
} from './update-types';

function readyCapability(root: string): UpdateCapability {
  return {
    mode: 'managed',
    supported: true,
    install_root: root,
    updater_version: '0.2.0',
    platform: 'windows-x64',
    reason: null,
  };
}

describe('UpdatePrepareService', () => {
  let root: string;
  let now: number;
  let candidate: VerifiedUpdateCandidate;
  let capability: UpdateCapability;
  let fetchImpl: jest.MockedFunction<typeof fetch>;
  let preflight: { assertSufficient: jest.Mock };
  let service: UpdatePrepareService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'filestation-prepare-'));
    now = Date.parse('2026-10-28T00:00:00.000Z');
    const artifactBytes = buildSafePublisherZip();
    const fixture = createSignedManifestFixture(artifactBytes);
    candidate = {
      manifest: fixture.manifest,
      artifact: fixture.manifest.artifacts[0],
      manifest_sha256: fixture.digest,
    };
    capability = readyCapability(root);
    fetchImpl = jest.fn(async () =>
      new Response(artifactBytes, {
        status: 200,
        headers: { 'content-length': String(artifactBytes.length) },
      }),
    ) as unknown as jest.MockedFunction<typeof fetch>;
    preflight = {
      assertSufficient: jest.fn(async () => undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UpdatePrepareService,
        {
          provide: UpdateCheckService,
          useValue: { resolveCandidate: jest.fn(async () => candidate) },
        },
        {
          provide: UpdateCapabilityService,
          useValue: { inspect: jest.fn(async () => capability) },
        },
        {
          provide: UpdateSpacePreflightService,
          useValue: preflight,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'app.tempPath' ? path.join(root, 'temp') : undefined,
            ),
          },
        },
        { provide: UPDATE_FETCH, useValue: fetchImpl },
        { provide: UPDATE_NOW, useValue: () => now },
        {
          provide: UPDATE_RANDOM_ID,
          useValue: () => '123e4567-e89b-42d3-a456-426614174000',
        },
      ],
    }).compile();
    service = module.get(UpdatePrepareService);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('downloads and extracts exact bytes into one immutable, one-consumer receipt', async () => {
    const events: string[] = [];
    preflight.assertSufficient.mockImplementation(async () => {
      events.push('preflight');
    });
    fetchImpl.mockImplementation(async () => {
      events.push('download');
      const artifact = candidate.artifact;
      const bytes = buildSafePublisherZip();
      return new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(artifact.archive_size) },
      });
    });

    const receipt = await service.prepare({
      version: candidate.manifest.version,
      manifest_sha256: candidate.manifest_sha256,
      artifact_sha256: candidate.artifact.sha256,
    });

    expect(events).toEqual(['preflight', 'download']);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.space_budget)).toBe(true);
    expect(receipt).toEqual({
      space_budget: {
        database_migration: candidate.manifest.database_migration,
        migration_workspace_multiplier: candidate.manifest.migration_workspace_multiplier,
        migration_workspace_min_bytes: candidate.manifest.migration_workspace_min_bytes,
      },
      prepared_id: '123e4567-e89b-42d3-a456-426614174000',
      manifest_sha256: candidate.manifest_sha256,
      artifact_sha256: candidate.artifact.sha256,
      version: '0.2.5',
      platform: 'windows-x64',
      arch: 'x64',
      staging_path: expect.stringMatching(
        /\.filestation-update-staging[/\\].+[/\\]payload$/,
      ),
      verified_size: candidate.artifact.archive_size,
      unpacked_size: candidate.artifact.unpacked_size,
      expires_at: now + 15 * 60 * 1000,
    });
    await expect(
      readFile(
        path.join(receipt.staging_path, 'apps/server/dist/main.js'),
        'utf8',
      ),
    ).resolves.toBe('ok');

    expect(await service.consume(receipt.prepared_id)).toEqual(receipt);
    expect(await service.consume(receipt.prepared_id)).toBeNull();
  });

  it('rejects stale manifest or artifact selections before network work', async () => {
    await expect(
      service.prepare({
        version: '0.2.5',
        manifest_sha256: '0'.repeat(64),
        artifact_sha256: candidate.artifact.sha256,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'UPDATE_SELECTION_STALE' }),
    });

    expect(preflight.assertSufficient).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('removes only its random staging tree when archive policy rejects a path', async () => {
    const malicious = buildZip([
      {
        name: 'filestation-v0.2.5-win-x64/apps/server/dist/main.js',
      },
      {
        name: 'filestation-v0.2.5-win-x64/apps/web/dist/index.html',
      },
      {
        name: 'filestation-v0.2.5-win-x64/packages/shared/dist/index.js',
      },
      {
        name: 'filestation-v0.2.5-win-x64/node_modules/lib/index.js',
      },
      {
        name: 'filestation-v0.2.5-win-x64/../escape',
      },
    ]);
    const fixture = createSignedManifestFixture(malicious);
    candidate = {
      manifest: fixture.manifest,
      artifact: fixture.manifest.artifacts[0],
      manifest_sha256: fixture.digest,
    };
    fetchImpl.mockResolvedValue(
      new Response(malicious, {
        status: 200,
        headers: { 'content-length': String(malicious.length) },
      }),
    );

    await expect(
      service.prepare({
        version: '0.2.5',
        manifest_sha256: fixture.digest,
        artifact_sha256: candidate.artifact.sha256,
      }),
    ).rejects.toThrow(/Unsafe archive/);

    const stagingRoot = path.join(root, '.filestation-update-staging');
    expect(await readdir(stagingRoot)).toEqual([]);
    await expect(
      readFile(path.join(root, 'escape'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires a managed capability before any preflight or download', async () => {
    capability = readyCapability(root);
    capability = {
      ...capability,
      mode: 'docker',
      supported: false,
      reason: 'DOCKER_MANUAL_UPGRADE',
      updater_version: null,
    };

    await expect(
      service.prepare({
        version: '0.2.5',
        manifest_sha256: candidate.manifest_sha256,
        artifact_sha256: candidate.artifact.sha256,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DOCKER_MANUAL_UPGRADE' }),
    });

    expect(preflight.assertSufficient).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cancels the response reader when streamed bytes exceed the signed size', async () => {
    let cancelled = false;
    fetchImpl.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new Uint8Array(candidate.artifact.archive_size + 1),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      ),
    );

    await expect(
      service.prepare({
        version: '0.2.5',
        manifest_sha256: candidate.manifest_sha256,
        artifact_sha256: candidate.artifact.sha256,
      }),
    ).rejects.toThrow(/signed size/);

    expect(cancelled).toBe(true);
  });

  it('expires receipts before installation consumption', async () => {
    const receipt = await service.prepare({
      version: '0.2.5',
      manifest_sha256: candidate.manifest_sha256,
      artifact_sha256: candidate.artifact.sha256,
    });
    now = receipt.expires_at;

    expect(await service.consume(receipt.prepared_id)).toBeNull();
    expect(await readdir(path.join(root, '.filestation-update-staging'))).toEqual(
      [],
    );
  });
});
