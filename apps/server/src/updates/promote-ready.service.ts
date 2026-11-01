import {
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  InternalUpdateHealthService,
} from '../maintenance/internal-update-health.controller';
import {
  TRUSTED_STARTUP_ACCESS,
  TrustedStartupAccess,
  UPDATE_STARTUP_INTENT,
  UpdateStartupIntent,
} from '../maintenance/startup-authority';

export interface PromoteReadyRequest {
  schema_version: 1;
}

export interface PromoteReadiness {
  attempt_id: string;
  fence: number;
  target_version: string;
  migration_id: string;
  schema_sha256: string;
  health: 'ok';
}

export interface PromoteReadyResponse {
  schema_version: 1;
  readiness: PromoteReadiness;
  receipt: string;
}

@Injectable()
export class PromoteReadyService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly health: InternalUpdateHealthService,
    @Inject(TRUSTED_STARTUP_ACCESS)
    private readonly access: TrustedStartupAccess,
    @Inject(UPDATE_STARTUP_INTENT)
    private readonly intent: UpdateStartupIntent,
  ) {}

  async prepare(body: PromoteReadyRequest): Promise<PromoteReadyResponse> {
    if (
      !body ||
      typeof body !== 'object' ||
      body.schema_version !== 1 ||
      Object.keys(body).length !== 1
    ) {
      throw new ConflictException({
        code: 'UPDATE_READY_SCHEMA_INVALID',
        message: 'The update readiness protocol schema is unsupported',
      });
    }
    if (this.intent.mode !== 'gated') {
      throw new ConflictException({
        code: 'UPDATE_PROMOTE_UNAVAILABLE',
        message: 'Promote readiness is available only in gated startup',
      });
    }

    const health = await this.health.check();
    if (
      health.status !== 'gated' ||
      health.attempt_id !== this.intent.attempt.attemptId ||
      health.fence !== this.intent.attempt.fence ||
      health.version !== this.intent.attempt.targetVersion
    ) {
      throw new ConflictException({
        code: 'UPDATE_READY_STATE_CHANGED',
        message: 'The gated update state or target version changed',
      });
    }

    const migrations = (await this.dataSource.query(
      `SELECT name FROM migrations ORDER BY id`,
    )) as Array<{ name: string }>;
    const schema = (await this.dataSource.query(
      `SELECT type, name, tbl_name, sql
         FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    )) as Array<Record<string, unknown>>;
    const readiness: PromoteReadiness = {
      attempt_id: this.intent.attempt.attemptId,
      fence: this.intent.attempt.fence,
      target_version: this.intent.attempt.targetVersion,
      migration_id:
        migrations.at(-1)?.name ?? 'schema-baseline',
      schema_sha256: createHash('sha256')
        .update(JSON.stringify(schema))
        .digest('hex'),
      health: 'ok',
    };
    if (!this.access.signReceipt) {
      throw new ConflictException({
        code: 'UPDATE_CAPABILITY_UNAVAILABLE',
        message: 'The inherited update capability is unavailable',
      });
    }
    return {
      schema_version: 1,
      readiness,
      receipt: this.access.signReceipt(readiness),
    };
  }
}
