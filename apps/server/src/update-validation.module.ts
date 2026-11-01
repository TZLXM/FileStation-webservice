import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import {
  InternalUpdateAccessGuard,
  InternalUpdateHealthService,
} from './maintenance/internal-update-health.controller';
import { InternalUpdateController } from './updates/internal-update.controller';
import { PromoteReadyService } from './updates/promote-ready.service';
import {
  TRUSTED_STARTUP_ACCESS,
  TrustedStartupAccess,
  UPDATE_STARTUP_INTENT,
  UpdateStartupIntent,
} from './maintenance/startup-authority';

export interface UpdateValidationModuleOptions {
  access: TrustedStartupAccess;
  intent: UpdateStartupIntent;
}

@Module({})
export class UpdateValidationModule {
  static register(options: UpdateValidationModuleOptions): DynamicModule {
    return {
      module: UpdateValidationModule,
      imports: [
        ConfigModule.forRoot({
          load: [configuration],
          isGlobal: true,
        }),
        DatabaseModule,
      ],
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
