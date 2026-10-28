import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminOnlyGuard } from '../security/guards/admin-only.guard';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { MaintenanceAllowed } from './maintenance-allowed.decorator';
import { UpdateStatusService } from './update-status.service';

@Controller('updates')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
export class UpdateStatusController {
  constructor(private readonly status: UpdateStatusService) {}

  @Get('status')
  @MaintenanceAllowed()
  getStatus() {
    return this.status.getStatus();
  }
}
