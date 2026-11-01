import { Module } from '@nestjs/common';
import { KeyObject, createPublicKey, randomUUID } from 'node:crypto';
import {
  getUpdatePublicKeySpkiBase64,
} from '@filestation/shared';
import {
  PlatformBootIdentityProvider,
} from '@filestation/updater';
import packageMetadata from '../../package.json';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { UpdateStatusController } from '../maintenance/update-status.controller';
import { UpdateStatusService } from '../maintenance/update-status.service';
import { SecurityModule } from '../security/security.module';
import {
  HandoffUpdateInstallExecutor,
  UpdateInstallCoordinator,
} from './update-install-coordinator';
import { ApplicationShutdownService } from './application-shutdown.service';
import { UpdateCapabilityService } from './update-capability.service';
import { UpdateCheckService } from './update-check.service';
import { UpdatePrepareService } from './update-prepare.service';
import { UpdateReauthService } from './update-reauth.service';
import { UpdateSpacePreflightService } from './update-space-preflight.service';
import { UpdateOperationReservationService } from './update-operation-reservation.service';
import { UpdateAuditReconciler } from './update-audit-reconciler';
import { DatabaseSnapshotService } from './database-snapshot.service';
import {
  UPDATE_FETCH,
  UPDATE_INSTALL_EXECUTOR,
  UPDATE_JOURNAL_IDENTITY,
  UPDATE_NODE_VERSION,
  UPDATE_NOW,
  UPDATE_PRODUCT_VERSION,
  UPDATE_RANDOM,
  UPDATE_RANDOM_ID,
  UPDATE_TRUSTED_KEY,
} from './updates.tokens';

function trustedKey(): KeyObject | null {
  const encoded = getUpdatePublicKeySpkiBase64();
  if (!encoded) return null;
  try {
    return createPublicKey({
      key: Buffer.from(encoded, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return null;
  }
}

@Module({
  imports: [SecurityModule, AuthModule, AuditModule],
  controllers: [UpdateStatusController],
  providers: [
    UpdateStatusService,
    UpdateCapabilityService,
    UpdateCheckService,
    UpdateSpacePreflightService,
    UpdatePrepareService,
    UpdateOperationReservationService,
    UpdateReauthService,
    UpdateAuditReconciler,
    ApplicationShutdownService,
    DatabaseSnapshotService,
    HandoffUpdateInstallExecutor,
    UpdateInstallCoordinator,
    {
      provide: UPDATE_INSTALL_EXECUTOR,
      useExisting: HandoffUpdateInstallExecutor,
    },
    {
      provide: UPDATE_FETCH,
      useFactory: () =>
        ((url: string | URL | Request, init?: RequestInit) =>
          globalThis.fetch(url, init)) as typeof fetch,
    },
    {
      provide: UPDATE_TRUSTED_KEY,
      useValue: trustedKey,
    },
    {
      provide: UPDATE_NOW,
      useValue: () => Date.now(),
    },
    {
      provide: UPDATE_RANDOM,
      useValue: () => Math.random(),
    },
    {
      provide: UPDATE_RANDOM_ID,
      useValue: randomUUID,
    },
    {
      provide: UPDATE_PRODUCT_VERSION,
      useValue: packageMetadata.version,
    },
    {
      provide: UPDATE_NODE_VERSION,
      useValue: process.versions.node,
    },
    {
      provide: UPDATE_JOURNAL_IDENTITY,
      useFactory: () => new PlatformBootIdentityProvider(),
    },
  ],
})
export class UpdatesModule {}
