import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { finalize, Observable } from 'rxjs';
import { MAINTENANCE_ALLOWED } from './maintenance-allowed.decorator';
import {
  MAINTENANCE_LEASE_REQUEST,
  MaintenanceLeaseRequest,
  registerMaintenanceRequestLease,
  releaseMaintenanceRequestLeaseIfSettled,
} from './maintenance-admission.guard';
import {
  MaintenanceUnavailableError,
  WriteBarrierService,
  WriteLease,
} from './write-barrier.service';

@Injectable()
export class MaintenanceInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly barrier: WriteBarrierService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const allowed = this.reflector.getAllAndOverride<boolean>(
      MAINTENANCE_ALLOWED,
      [context.getHandler(), context.getClass()],
    );
    if (allowed) return next.handle();

    const request = context
      .switchToHttp()
      .getRequest<MaintenanceLeaseRequest>();
    const existingState = request[MAINTENANCE_LEASE_REQUEST];
    if (existingState) {
      existingState.handlerStarted = true;
      return this.runInsideLease(existingState.lease, next).pipe(
        finalize(() => {
          existingState.handlerDone = true;
          releaseMaintenanceRequestLeaseIfSettled(existingState);
        }),
      );
    }

    let lease: WriteLease;
    try {
      lease = await this.barrier.acquire('http');
      const response = context.switchToHttp().getResponse();
      registerMaintenanceRequestLease(request, response, lease);
    } catch (error) {
      if (!(error instanceof MaintenanceUnavailableError)) throw error;
      const response = context.switchToHttp().getResponse();
      response.setHeader('Retry-After', '5');
      throw new ServiceUnavailableException({
        code: error.code,
        message:
          'FileStation is temporarily unavailable while an update is prepared',
      });
    }

    const requestState = request[MAINTENANCE_LEASE_REQUEST]!;
    requestState.handlerStarted = true;
    return this.runInsideLease(lease, next).pipe(
      finalize(() => {
        requestState.handlerDone = true;
        releaseMaintenanceRequestLeaseIfSettled(requestState);
      }),
    );
  }

  private runInsideLease(
    lease: WriteLease,
    next: CallHandler,
  ): Observable<unknown> {
    return new Observable((subscriber) =>
      this.barrier.runInLeaseContext(lease, () =>
        next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (error) => subscriber.error(error),
          complete: () => subscriber.complete(),
        }),
      ),
    );
  }
}
