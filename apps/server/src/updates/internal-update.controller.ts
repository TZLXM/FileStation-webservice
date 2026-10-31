import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  InternalUpdateAccessGuard,
  InternalUpdateHealthService,
  InternalUpdatePurpose,
} from '../maintenance/internal-update-health.controller';
import { MaintenanceAllowed } from '../maintenance/maintenance-allowed.decorator';
import {
  PromoteReadyRequest,
  PromoteReadyService,
} from './promote-ready.service';

@Controller('internal/update')
@UseGuards(InternalUpdateAccessGuard)
@MaintenanceAllowed()
export class InternalUpdateController {
  constructor(
    private readonly health: InternalUpdateHealthService,
    private readonly promote: PromoteReadyService,
  ) {}

  @Get('health')
  @InternalUpdatePurpose('health')
  check() {
    return this.health.check();
  }

  @Post('promote-ready')
  @HttpCode(HttpStatus.CREATED)
  @InternalUpdatePurpose('promote')
  promoteReady(@Body() body: PromoteReadyRequest) {
    return this.promote.prepare(body);
  }
}

export { InternalUpdateHealthService };
