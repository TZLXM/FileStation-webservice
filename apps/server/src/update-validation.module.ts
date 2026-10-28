import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import {
  InternalUpdateAccessGuard,
  InternalUpdateHealthController,
  InternalUpdateHealthService,
} from './maintenance/internal-update-health.controller';
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
      controllers: [InternalUpdateHealthController],
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
      ],
    };
  }
}
