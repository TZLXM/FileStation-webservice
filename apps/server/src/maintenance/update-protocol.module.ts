import { DynamicModule, Module } from '@nestjs/common';
import {
  InternalUpdateAccessGuard,
  InternalUpdateHealthService,
} from './internal-update-health.controller';
import { InternalUpdateController } from '../updates/internal-update.controller';
import { PromoteReadyService } from '../updates/promote-ready.service';
import {
  TRUSTED_STARTUP_ACCESS,
  TrustedStartupAccess,
  UPDATE_STARTUP_INTENT,
  UpdateStartupIntent,
} from './startup-authority';

export interface UpdateProtocolModuleOptions {
  access: TrustedStartupAccess;
  intent: UpdateStartupIntent;
}

@Module({})
export class UpdateProtocolModule {
  static register(options: UpdateProtocolModuleOptions): DynamicModule {
    return {
      module: UpdateProtocolModule,
      controllers: [InternalUpdateController],
      providers: [
        {
          provide: TRUSTED_STARTUP_ACCESS,
          useValue: options.access,
        },
        {
          provide: UPDATE_STARTUP_INTENT,
          useValue: options.intent,
        },
        InternalUpdateAccessGuard,
        InternalUpdateHealthService,
        PromoteReadyService,
      ],
    };
  }
}
