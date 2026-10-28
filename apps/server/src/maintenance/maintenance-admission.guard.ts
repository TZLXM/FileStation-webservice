import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { MAINTENANCE_ALLOWED } from './maintenance-allowed.decorator';
import {
  MaintenanceUnavailableError,
  WriteBarrierService,
  WriteLease,
} from './write-barrier.service';

export const MAINTENANCE_LEASE_REQUEST = Symbol(
  'MAINTENANCE_LEASE_REQUEST',
);

export interface MaintenanceRequestLease {
  readonly lease: WriteLease;
  transportDone: boolean;
  handlerStarted: boolean;
  handlerDone: boolean;
  released: boolean;
}

export interface MaintenanceLeaseRequest extends Request {
  [MAINTENANCE_LEASE_REQUEST]?: MaintenanceRequestLease;
}

export function releaseMaintenanceRequestLeaseIfSettled(
  state: MaintenanceRequestLease,
): void {
  if (
    state.released ||
    !state.transportDone ||
    (state.handlerStarted && !state.handlerDone)
  ) {
    return;
  }
  state.released = true;
  state.lease.release();
}

export function registerMaintenanceRequestLease(
  request: MaintenanceLeaseRequest,
  response: Response,
  lease: WriteLease,
): MaintenanceRequestLease {
  const state: MaintenanceRequestLease = {
    lease,
    transportDone: false,
    handlerStarted: false,
    handlerDone: false,
    released: false,
  };
  request[MAINTENANCE_LEASE_REQUEST] = state;
  const transportDone = () => {
    state.transportDone = true;
    releaseMaintenanceRequestLeaseIfSettled(state);
  };
  response.once('finish', transportDone);
  response.once('close', transportDone);
  return state;
}

@Injectable()
export class MaintenanceAdmissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly barrier: WriteBarrierService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const allowed = this.reflector.getAllAndOverride<boolean>(
      MAINTENANCE_ALLOWED,
      [context.getHandler(), context.getClass()],
    );
    if (allowed) return true;

    const request = context
      .switchToHttp()
      .getRequest<MaintenanceLeaseRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    try {
      const lease = await this.barrier.acquire('http');
      registerMaintenanceRequestLease(request, response, lease);
      return true;
    } catch (error) {
      if (!(error instanceof MaintenanceUnavailableError)) throw error;
      response.setHeader('Retry-After', '5');
      throw new ServiceUnavailableException({
        code: error.code,
        message:
          'FileStation is temporarily unavailable while an update is prepared',
      });
    }
  }
}
