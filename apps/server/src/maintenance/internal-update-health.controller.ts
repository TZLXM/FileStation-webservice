import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Inject,
  Injectable,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import path from 'node:path';
import { DataSource } from 'typeorm';
import { AttemptJournal } from '@filestation/updater';
import packageMetadata from '../../package.json';
import { MaintenanceAllowed } from './maintenance-allowed.decorator';
import {
  TRUSTED_STARTUP_ACCESS,
  TrustedStartupAccess,
  UPDATE_STARTUP_INTENT,
  UpdateStartupIntent,
} from './startup-authority';

interface UpdateProtocolRequest {
  headers: Record<string, string | string[] | undefined>;
}

@Injectable()
export class InternalUpdateAccessGuard implements CanActivate {
  constructor(
    @Inject(TRUSTED_STARTUP_ACCESS)
    private readonly access: TrustedStartupAccess,
    @Inject(UPDATE_STARTUP_INTENT)
    private readonly intent: UpdateStartupIntent,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<UpdateProtocolRequest>();
    const attemptId = request.headers['x-filestation-attempt'];
    const fenceValue = request.headers['x-filestation-fence'];
    const capability = request.headers['x-filestation-capability'];
    if (
      typeof attemptId !== 'string' ||
      typeof fenceValue !== 'string' ||
      (capability !== undefined && typeof capability !== 'string')
    ) {
      throw new UnauthorizedException();
    }
    const fence = Number(fenceValue);
    if (
      attemptId !== this.intent.attempt.attemptId ||
      fence !== this.intent.attempt.fence ||
      !Number.isSafeInteger(fence)
    ) {
      throw new UnauthorizedException();
    }
    try {
      await this.access.authorizeRequest(this.intent, {
        attemptId,
        fence,
        capability: capability as string | undefined,
      });
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}

@Injectable()
export class InternalUpdateHealthService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    @Inject(UPDATE_STARTUP_INTENT)
    private readonly intent: UpdateStartupIntent,
  ) {}

  async check() {
    const [integrityRows, foreignKeyRows, journalRows] = await Promise.all([
      this.dataSource.query(
        'PRAGMA integrity_check',
      ) as Promise<Array<{ integrity_check: string }>>,
      this.dataSource.query(
        'PRAGMA foreign_key_check',
      ) as Promise<Record<string, unknown>[]>,
      this.dataSource.query('PRAGMA journal_mode'),
    ]);
    if (
      integrityRows.length !== 1 ||
      integrityRows[0]?.integrity_check !== 'ok' ||
      foreignKeyRows.length !== 0
    ) {
      throw new Error('validation database integrity check failed');
    }
    const journalMode = String(journalRows[0]?.journal_mode);
    if (journalMode.toLowerCase() !== 'wal') {
      throw new Error('validation database is not in WAL mode');
    }
    for (const dependency of [
      'sqlite3',
      'typeorm',
      '@filestation/updater',
    ]) {
      require.resolve(dependency);
    }
    const snapshot = await AttemptJournal.inspect(
      this.intent.attempt.installRoot,
    );
    if (
      snapshot.attemptId !== this.intent.attempt.attemptId ||
      snapshot.fence !== this.intent.attempt.fence ||
      snapshot.pending ||
      !snapshot.owner?.heartbeatAt ||
      Date.now() - Date.parse(snapshot.owner.heartbeatAt) > 5 * 60 * 1000
    ) {
      throw new Error('validation attempt heartbeat is stale or mismatched');
    }
    const dbPath = this.config.get<string>('app.dbPath');
    return {
      status:
        this.intent.mode === 'validate'
          ? 'validating'
          : snapshot.phase === 'COMMITTED'
            ? 'committed'
            : 'gated',
      attempt_id: snapshot.attemptId,
      fence: snapshot.fence,
      phase: snapshot.phase,
      version: packageMetadata.version,
      node: process.version,
      dependencies: {
        sqlite3: true,
        typeorm: true,
        updater: true,
      },
      config: {
        database_configured:
          Boolean(dbPath) && path.isAbsolute(dbPath as string),
        storage_configured: path.isAbsolute(
          this.config.get<string>('app.storagePath') ?? '',
        ),
        temp_configured: path.isAbsolute(
          this.config.get<string>('app.tempPath') ?? '',
        ),
      },
      database: {
        integrity: 'ok',
        foreign_keys: 0,
        journal_mode: journalMode,
      },
      heartbeat_at: snapshot.owner.heartbeatAt,
    };
  }
}

@Controller('internal/update')
@UseGuards(InternalUpdateAccessGuard)
export class InternalUpdateHealthController {
  constructor(private readonly health: InternalUpdateHealthService) {}

  @Get('health')
  @MaintenanceAllowed()
  check() {
    return this.health.check();
  }
}
