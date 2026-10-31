import { ConflictException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AttemptJournal,
  UpdateCapabilityAuthority,
  encodeInheritedCapability,
} from '@filestation/updater';
import {
  InheritedTrustedStartupAccess,
} from '../src/maintenance/inherited-startup-access';
import {
  UpdateProtocolModule,
} from '../src/maintenance/update-protocol.module';
import {
  InternalUpdateHealthService,
} from '../src/maintenance/internal-update-health.controller';
import { PromoteReadyService } from '../src/updates/promote-ready.service';
import { UpdateStartupIntent } from '../src/maintenance/startup-authority';

describe('internal update protocol (e2e)', () => {
  let root: string;
  let app: INestApplication;
  let authority: UpdateCapabilityAuthority;
  const intent: UpdateStartupIntent = {
    mode: 'gated',
    attempt: {
      attemptId: 'attempt-internal-e2e',
      fence: 4,
      installRoot: '',
      backupId: 'backup-internal-e2e',
      targetVersion: '0.2.5',
    },
  };

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'filestation-internal-e2e-'));
    intent.attempt.installRoot = root;
    const journal = await AttemptJournal.open(root);
    await journal.beginAttempt({
      attemptId: intent.attempt.attemptId,
      fence: intent.attempt.fence,
      currentVersion: '0.2.0',
      targetVersion: intent.attempt.targetVersion,
      previousVersion: '0.2.0',
      backupId: intent.attempt.backupId,
      phase: 'PREPARED',
      owner: {
        bootIdentity: 'fixture-boot',
        pid: 1234,
        processCreatedAt: 'fixture-created',
        heartbeatAt: new Date().toISOString(),
        handoffIdentityHash: 'a'.repeat(64),
      },
    });
    const validation = await journal.appendIntent({
      attemptId: intent.attempt.attemptId,
      fence: intent.attempt.fence,
      action: 'validate-release',
      phase: 'MIGRATING',
    });
    await journal.appendCompletion({
      attemptId: intent.attempt.attemptId,
      fence: intent.attempt.fence,
      intentId: validation.id,
      phase: 'MIGRATED_VERIFIED',
    });
    authority = new UpdateCapabilityAuthority(Buffer.alloc(32, 0x61));
    const access = await InheritedTrustedStartupAccess.fromInherited(
      (async function* () {
        yield encodeInheritedCapability(authority);
      })(),
    );
    const module = await Test.createTestingModule({
      imports: [UpdateProtocolModule.register({ access, intent })],
    })
      .overrideProvider(InternalUpdateHealthService)
      .useValue({
        check: async () => ({
          status: 'gated',
          attempt_id: intent.attempt.attemptId,
          fence: intent.attempt.fence,
          phase: 'MIGRATED_VERIFIED',
          version: '0.2.5',
        }),
      })
      .overrideProvider(PromoteReadyService)
      .useValue({
        prepare: async (body: { schema_version?: number }) => {
          if (body?.schema_version !== 1) {
            throw new ConflictException({
              code: 'UPDATE_READY_SCHEMA_INVALID',
            });
          }
          return {
            schema_version: 1,
            readiness: {
              attempt_id: intent.attempt.attemptId,
              fence: intent.attempt.fence,
              target_version: '0.2.5',
              migration_id: '1800000000000',
              schema_sha256: 'b'.repeat(64),
              health: 'ok',
            },
            receipt: 'fixture-ready-receipt',
          };
        },
      })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it('requires the inherited capability even from loopback', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/internal/update/health')
      .set('X-Forwarded-For', '127.0.0.1')
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/internal/update/promote-ready')
      .set('X-Forwarded-For', '127.0.0.1')
      .set('Authorization', 'Bearer administrator-jwt')
      .send({ schema_version: 1 })
      .expect(401);
  });

  it('returns one deterministic READY receipt for retries', async () => {
    const token = authority.issue({
      attemptId: intent.attempt.attemptId,
      fence: intent.attempt.fence,
      purpose: 'promote',
      method: 'POST',
      stage: 'gated',
      expiresAt: Date.now() + 60_000,
    });
    const first = await request(app.getHttpServer())
      .post('/api/v1/internal/update/promote-ready')
      .set('X-FileStation-Update-Capability', token)
      .send({ schema_version: 1 })
      .expect(201);
    const retry = await request(app.getHttpServer())
      .post('/api/v1/internal/update/promote-ready/')
      .set('X-FileStation-Update-Capability', token)
      .send({ schema_version: 1 })
      .expect(201);
    expect(retry.body).toEqual(first.body);
    expect(first.text).not.toContain(token);
  });
});
