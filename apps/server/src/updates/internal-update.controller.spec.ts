import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  InternalUpdateController,
  InternalUpdateHealthService,
} from './internal-update.controller';
import { PromoteReadyService } from './promote-ready.service';
import {
  TRUSTED_STARTUP_ACCESS,
  TrustedStartupAccess,
  UPDATE_STARTUP_INTENT,
  UpdateStartupIntent,
} from '../maintenance/startup-authority';
import { InternalUpdateAccessGuard } from '../maintenance/internal-update-health.controller';

const intent: UpdateStartupIntent = {
  mode: 'gated',
  attempt: {
    attemptId: 'attempt-internal-01',
    fence: 9,
    installRoot: 'C:\\fixture\\install',
    backupId: 'backup-internal-01',
    targetVersion: '0.2.5',
  },
};

describe('internal update controller', () => {
  let app: INestApplication;
  let healthCalls: number;
  let promoteCalls: Array<Record<string, unknown>>;
  let accessCalls: Array<{ purpose: string; method: string; stage: string }>;

  beforeEach(async () => {
    healthCalls = 0;
    promoteCalls = [];
    accessCalls = [];
    const access: TrustedStartupAccess = {
      async authorizeStartup() {},
      async authorizeRequest(_receivedIntent, credentials) {
        accessCalls.push({
          purpose: credentials.purpose,
          method: credentials.method,
          stage: credentials.stage,
        });
        const valid =
          (credentials.purpose === 'health' &&
            credentials.method === 'GET' &&
            credentials.capability === 'health-token') ||
          (credentials.purpose === 'promote' &&
            credentials.method === 'POST' &&
            credentials.capability === 'promote-token');
        if (!valid || credentials.stage !== 'gated') {
          throw new Error('capability rejected');
        }
      },
      signReceipt(payload) {
        return `signed:${JSON.stringify(payload)}`;
      },
    };
    const module = await Test.createTestingModule({
      controllers: [InternalUpdateController],
      providers: [
        InternalUpdateAccessGuard,
        {
          provide: TRUSTED_STARTUP_ACCESS,
          useValue: access,
        },
        {
          provide: UPDATE_STARTUP_INTENT,
          useValue: intent,
        },
        {
          provide: InternalUpdateHealthService,
          useValue: {
            check: async () => {
              healthCalls += 1;
              return {
                status: 'gated',
                attempt_id: intent.attempt.attemptId,
                fence: intent.attempt.fence,
                phase: 'MIGRATED_VERIFIED',
                version: '0.2.5',
              };
            },
          },
        },
        {
          provide: PromoteReadyService,
          useValue: {
            prepare: async (body: Record<string, unknown>) => {
              promoteCalls.push(body);
              return {
                schema_version: 1,
                readiness: {
                  attempt_id: intent.attempt.attemptId,
                  fence: intent.attempt.fence,
                  target_version: '0.2.5',
                  migration_id: '1800000000000',
                  schema_sha256: 'a'.repeat(64),
                  health: 'ok',
                },
                receipt: 'deterministic-ready-receipt',
              };
            },
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects loopback without a capability and never uses an admin JWT as authority', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/internal/update/health')
      .set('X-Forwarded-For', '127.0.0.1')
      .set('X-Real-IP', '127.0.0.1')
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/internal/update/promote-ready')
      .set('X-Forwarded-For', '127.0.0.1')
      .set('Authorization', 'Bearer administrator-access-token')
      .send({ schema_version: 1 })
      .expect(401);

    expect(healthCalls).toBe(0);
    expect(promoteCalls).toEqual([]);
  });

  it('rejects a capability issued for a different method or purpose', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/internal/update/promote-ready')
      .set('X-FileStation-Update-Capability', 'health-token')
      .send({ schema_version: 1 })
      .expect(401);

    await request(app.getHttpServer())
      .get('/api/v1/internal/update/health')
      .set('X-FileStation-Update-Capability', 'promote-token')
      .expect(401);
  });

  it('returns retryable health and deterministic promote receipts without serializing the capability', async () => {
    const healthOne = await request(app.getHttpServer())
      .get('/api/v1/internal/update/health')
      .set('X-FileStation-Update-Capability', 'health-token')
      .expect(200);
    const healthTwo = await request(app.getHttpServer())
      .get('/api/v1/internal/update/health/')
      .set('X-FileStation-Update-Capability', 'health-token')
      .expect(200);
    expect(healthTwo.body).toEqual(healthOne.body);
    expect(healthOne.text).not.toContain('health-token');

    const first = await request(app.getHttpServer())
      .post('/api/v1/internal/update/promote-ready')
      .set('X-FileStation-Update-Capability', 'promote-token')
      .send({ schema_version: 1 })
      .expect(201);
    const retry = await request(app.getHttpServer())
      .post('/api/v1/internal/update/promote-ready')
      .set('X-FileStation-Update-Capability', 'promote-token')
      .send({ schema_version: 1 })
      .expect(201);

    expect(retry.body).toEqual(first.body);
    expect(first.text).not.toContain('promote-token');
    expect(promoteCalls).toHaveLength(2);
    expect(accessCalls).toContainEqual({
      purpose: 'health',
      method: 'GET',
      stage: 'gated',
    });
    expect(accessCalls).toContainEqual({
      purpose: 'promote',
      method: 'POST',
      stage: 'gated',
    });
  });
});
