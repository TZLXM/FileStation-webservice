import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { MaintenanceInterceptor } from './maintenance.interceptor';
import { MaintenanceAdmissionGuard } from './maintenance-admission.guard';
import { WriteBarrierService } from './write-barrier.service';
import { WriteFreezeService } from './write-freeze.service';
import {
  HANDOFF_SPAWNER,
} from '../updates/handoff-spawner';
import { AnonymousPipeHandoffSpawner } from '../updates/handoff-spawner';

@Global()
@Module({
  providers: [
    WriteFreezeService,
    WriteBarrierService,
    MaintenanceAdmissionGuard,
    MaintenanceInterceptor,
    {
      provide: AnonymousPipeHandoffSpawner,
      useFactory: () => new AnonymousPipeHandoffSpawner(),
    },
    {
      provide: HANDOFF_SPAWNER,
      useExisting: AnonymousPipeHandoffSpawner,
    },
    {
      provide: APP_GUARD,
      useExisting: MaintenanceAdmissionGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useExisting: MaintenanceInterceptor,
    },
  ],
  exports: [
    WriteFreezeService,
    WriteBarrierService,
    HANDOFF_SPAWNER,
  ],
})
export class MaintenanceModule {}
