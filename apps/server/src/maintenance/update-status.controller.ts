import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AdminOnlyGuard } from '../security/guards/admin-only.guard';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { CheckUpdateDto } from '../updates/dto/check-update.dto';
import { InstallUpdateDto } from '../updates/dto/install-update.dto';
import { PrepareUpdateDto } from '../updates/dto/prepare-update.dto';
import { UpdateCheckService } from '../updates/update-check.service';
import { UpdateInstallCoordinator } from '../updates/update-install-coordinator';
import { UpdatePrepareService } from '../updates/update-prepare.service';
import { UpdateReauthService } from '../updates/update-reauth.service';
import { MaintenanceAllowed } from './maintenance-allowed.decorator';
import { UpdateStatusService } from './update-status.service';

@Controller('updates')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@ApiTags('updates')
@ApiBearerAuth('bearerAuth')
export class UpdateStatusController {
  constructor(
    private readonly status: UpdateStatusService,
    private readonly checks: UpdateCheckService,
    private readonly prepareService: UpdatePrepareService,
    private readonly reauth: UpdateReauthService,
    private readonly installs: UpdateInstallCoordinator,
    private readonly audit: AuditService,
  ) {}

  @Get('status')
  @MaintenanceAllowed()
  @ApiOperation({ summary: 'Read update and maintenance status without side effects' })
  async getStatus() {
    const [maintenance, cached] = await Promise.all([
      this.status.getStatus(),
      Promise.resolve(this.checks.getCachedStatus()),
    ]);
    return {
      ...cached,
      phase: maintenance.phase,
      attempt_id: maintenance.attempt_id,
      fence: maintenance.fence,
      target_version:
        maintenance.target_version ?? cached.available_version ?? undefined,
      updated_at: maintenance.updated_at,
    };
  }

  @Post('check')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check for a signed stable update' })
  async check(
    @Body() body: CheckUpdateDto,
    @Req() req: Request & { user: { id: string } },
  ) {
    const result = await this.checks.check({ force: body.force === true });
    await this.audit.record({
      accountId: req.user.id,
      action: AuditAction.UPDATE_CHECKED,
      resourceType: 'update',
      details: {
        decision: result.decision,
        available_version: result.available_version,
      },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return result;
  }

  @Post('prepare')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Download and verify one exact update artifact' })
  async prepare(
    @Body() body: PrepareUpdateDto,
    @Req() req: Request & { user: { id: string } },
  ) {
    const receipt = await this.prepareService.prepare(body);
    await this.audit.record({
      accountId: req.user.id,
      action: AuditAction.UPDATE_PREPARED,
      resourceType: 'update',
      resourceId: receipt.prepared_id,
      details: {
        version: receipt.version,
        manifest_sha256: receipt.manifest_sha256,
        artifact_sha256: receipt.artifact_sha256,
      },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return receipt;
  }

  @Post('install')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Confirm and schedule an exact prepared update after this response',
  })
  async install(
    @Body() body: InstallUpdateDto,
    @Req() req: Request & { user: { id: string } },
    @Res({ passthrough: true }) response: Response,
  ) {
    const reservation = await this.installs.reserveInstall(() => this.reauth.verify(
      req.user.id,
      body.password,
      body.totp_code,
      req.ip ?? 'unknown',
    ));
    let transferred = false;
    try {
      const receipt = await this.prepareService.consume(body.prepared_id);
      if (!receipt) {
        throw new ConflictException({
          code: 'UPDATE_RECEIPT_INVALID',
          message: 'The prepared update receipt is missing, expired, or consumed',
        });
      }
      let accepted;
      try {
        accepted = await this.installs.accept(receipt, reservation);
        transferred = true;
      } catch (error) {
        await this.prepareService.discard(receipt);
        throw error;
      }
      this.installs.scheduleAfterResponse(accepted.attempt, response);
      return {
        attempt_id: accepted.attempt_id,
        prepared_id: accepted.prepared_id,
        fence: accepted.fence,
        phase: accepted.phase,
        accepted_at: accepted.accepted_at,
      };
    } finally {
      if (!transferred) await reservation.release();
    }
  }
}
