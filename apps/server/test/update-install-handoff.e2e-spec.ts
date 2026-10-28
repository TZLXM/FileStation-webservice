import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { setupFullApplication } from '../src/common/http/application-setup';
import { FileLifecycleService } from '../src/files/file-lifecycle.service';
import { StorageService } from '../src/files/storage.service';
import { WriteBarrierService } from '../src/maintenance/write-barrier.service';
import { UpdateCapabilityService } from '../src/updates/update-capability.service';
import {
  UpdateInstallContext,
} from '../src/updates/update-install-coordinator';
import { UpdatePrepareService } from '../src/updates/update-prepare.service';
import {
  UPDATE_INSTALL_EXECUTOR,
  UPDATE_JOURNAL_IDENTITY,
  UPDATE_RANDOM_ID,
} from '../src/updates/updates.tokens';
import {
  PreparedUpdateReceipt,
  UpdateCapability,
} from '../src/updates/update-types';

describe('update install response handoff (e2e)', () => {
  let root: string;
  let app: INestApplication;
  let adminToken: string;
  let receipt: PreparedUpdateReceipt;
  let execute: jest.Mock<Promise<void>, [UpdateInstallContext]>;
  const platform =
    process.platform === 'win32' ? 'windows-x64' : 'linux-x64';

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'filestation-handoff-'));
    process.env.FILESTATION_DB_PATH = path.join(root, 'test.db');
    process.env.FILESTATION_STORAGE_PATH = path.join(root, 'storage');
    process.env.FILESTATION_TEMP_PATH = path.join(root, 'temp');
    process.env.FILESTATION_INSTALL_ROOT = root;
    process.env.JWT_SECRET = 'e2e-update-handoff-secret';
    process.env.NODE_ENV = 'test';
    await mkdir(process.env.FILESTATION_STORAGE_PATH, { recursive: true });
    await mkdir(process.env.FILESTATION_TEMP_PATH, { recursive: true });

    const staging = path.join(
      root,
      '.filestation-update-staging',
      'fixture',
      'payload',
    );
    await mkdir(staging, { recursive: true });
    receipt = Object.freeze({
      prepared_id: '07523e2b-37ee-40cb-980f-cce36310e45f',
      manifest_sha256: 'a'.repeat(64),
      artifact_sha256: 'b'.repeat(64),
      version: '0.2.5',
      platform,
      arch: 'x64',
      staging_path: await realpath(staging),
      verified_size: 64,
      unpacked_size: 64,
      expires_at: Date.now() + 15 * 60 * 1000,
    });
    const capability: UpdateCapability = {
      mode: 'managed',
      supported: true,
      install_root: root,
      updater_version: '0.2.0',
      platform,
      reason: null,
    };
    execute = jest.fn(
      async (_context: UpdateInstallContext) => undefined,
    );

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(UpdatePrepareService)
      .useValue({
        prepare: jest.fn(),
        consume: jest.fn(async () => receipt),
        discard: jest.fn(),
      })
      .overrideProvider(UpdateCapabilityService)
      .useValue({ inspect: jest.fn(async () => capability) })
      .overrideProvider(UPDATE_INSTALL_EXECUTOR)
      .useValue({
        assertAvailable: jest.fn(async () => undefined),
        execute,
      })
      .overrideProvider(UPDATE_JOURNAL_IDENTITY)
      .useValue({
        current: async () => ({
          provider: 'windows-cim',
          value: 'win32:fixture',
        }),
        processCreatedAt: async () => 'win32:process',
        isProcessAlive: async () => true,
      })
      .overrideProvider(UPDATE_RANDOM_ID)
      .useValue(
        jest
          .fn()
          .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
          .mockReturnValueOnce('22222222-2222-4222-8222-222222222222')
          .mockReturnValue('33333333-3333-4333-8333-333333333333'),
      )
      .compile();

    app = moduleFixture.createNestApplication();
    setupFullApplication(app, app.get(ConfigService));
    app.use(cookieParser());
    await app.init();
    await app.get(StorageService).activate();
    await app.get(FileLifecycleService).activate();
    const initToken = await app.get(AuthService).generateInitToken();
    await request(app.getHttpServer())
      .post('/api/v1/auth/init')
      .set('X-Init-Token', initToken)
      .send({ username: 'admin', password: 'StrongP@ssw0rd' })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'StrongP@ssw0rd' })
      .expect(200);
    adminToken = login.body.data.access_token;
  });

  afterAll(async () => {
    await app.close();
    await execute.mock.calls[0]?.[0].ownership.recoveryGuard.release();
    delete process.env.FILESTATION_DB_PATH;
    delete process.env.FILESTATION_STORAGE_PATH;
    delete process.env.FILESTATION_TEMP_PATH;
    delete process.env.FILESTATION_INSTALL_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('returns 202 before maintenance and then invokes the exact executor contract', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/updates/install')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        prepared_id: receipt.prepared_id,
        password: 'StrongP@ssw0rd',
      })
      .expect(202);

    expect(response.body).toEqual({
      attempt_id: '11111111-1111-4111-8111-111111111111',
      prepared_id: receipt.prepared_id,
      fence: 1,
      phase: 'PREPARED',
      accepted_at: expect.any(String),
    });
    for (let attempt = 0; attempt < 100 && execute.mock.calls.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(execute).toHaveBeenCalledWith({
      contract_version: 2,
      onProgress: expect.any(Function),
      attempt: expect.objectContaining({
        attemptId: response.body.attempt_id,
        targetVersion: receipt.version,
      }),
      receipt,
      ownership: expect.objectContaining({ lock: expect.anything(), journal: expect.anything(), recoveryGuard: expect.anything() }),
    });
    expect(app.get(WriteBarrierService).accepting).toBe(false);

    await request(app.getHttpServer())
      .get('/api/v1/updates/status')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/updates/check')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(503);
  });
});
