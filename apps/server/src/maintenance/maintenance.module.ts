import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { MaintenanceInterceptor } from './maintenance.interceptor';
import { MaintenanceAdmissionGuard } from './maintenance-admission.guard';
import { WriteBarrierService } from './write-barrier.service';
import { WriteFreezeService } from './write-freeze.service';
import {
  HANDOFF_SPAWNER,
} from '../updates/handoff-spawner';
import { RefusingHandoffSpawner } from '../updates/handoff-spawner';

@Global()
@Module({
  providers: [
    WriteFreezeService,
    WriteBarrierService,
    MaintenanceAdmissionGuard,
    MaintenanceInterceptor,
    RefusingHandoffSpawner,
    {
      provide: HANDOFF_SPAWNER,
      useExisting: RefusingHandoffSpawner,
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
