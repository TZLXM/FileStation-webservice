import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UpdateCapabilityService } from './update-capability.service';

describe('UpdateCapabilityService', () => {
  let root: string;
  let service: UpdateCapabilityService;
  const originalContainer = process.env.FILESTATION_CONTAINER;

  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(path.join(tmpdir(), 'filestation-capability-')),
    );
    await mkdir(path.join(root, 'updater'), { recursive: true });
    await writeFile(
      path.join(root, 'managed-install.json'),
      JSON.stringify({
        schemaVersion: 1,
        installId: 'fixture-install',
        installRoot: root,
        currentPath: path.join(root, 'current'),
        environmentPath: path.join(root, '.env'),
        paths: {
          database: path.join(root, 'data', 'filestation.db'),
          storage: path.join(root, 'data', 'storage'),
          temp: path.join(root, 'data', 'temp'),
        },
        bootstrapBackupId: 'fixture-backup',
        bootstrapFingerprint: 'a'.repeat(64),
        createdAt: '2026-10-28T00:00:00.000Z',
      }),
    );
    await writeFile(
      path.join(root, 'updater', 'package.json'),
      JSON.stringify({
        name: '@filestation/updater',
        version: '1.4.2',
      }),
    );
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UpdateCapabilityService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'app.updateInstallRoot' ? root : undefined,
            ),
          },
        },
      ],
    }).compile();
    service = module.get(UpdateCapabilityService);
  });

  afterEach(async () => {
    if (originalContainer === undefined) {
      delete process.env.FILESTATION_CONTAINER;
    } else {
      process.env.FILESTATION_CONTAINER = originalContainer;
    }
    await rm(root, { recursive: true, force: true });
  });

  it('reads the independently installed updater package, not a bundled release copy', async () => {
    const status = await service.inspect();

    expect(status).toEqual(
      expect.objectContaining({
        mode: 'managed',
        supported: true,
        install_root: root,
        updater_version: '1.4.2',
      }),
    );
  });

  it('fails closed for Docker and for a missing external updater package', async () => {
    process.env.FILESTATION_CONTAINER = 'docker';
    await expect(service.inspect()).resolves.toMatchObject({
      mode: 'docker',
      supported: false,
      reason: 'DOCKER_MANUAL_UPGRADE',
    });
    delete process.env.FILESTATION_CONTAINER;

    await rm(path.join(root, 'updater', 'package.json'));
    await expect(service.inspect()).resolves.toMatchObject({
      mode: 'managed',
      supported: false,
      reason: 'UPDATER_METADATA_INVALID',
    });
  });
});
