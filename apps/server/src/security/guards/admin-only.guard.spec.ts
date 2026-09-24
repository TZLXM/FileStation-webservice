import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ApiTokensController } from '../../api-tokens/api-tokens.controller';
import { AdminOnlyGuard } from './admin-only.guard';
import { JwtAuthGuard } from './jwt-auth.guard';

function contextFor(user?: { principalType: string }): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function captureGuardError(user?: { principalType: string }): unknown {
  try {
    new AdminOnlyGuard().canActivate(contextFor(user));
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('AdminOnlyGuard', () => {
  it('allows an admin principal', () => {
    expect(new AdminOnlyGuard().canActivate(contextFor({ principalType: 'admin' }))).toBe(true);
  });

  it('rejects a missing principal with ForbiddenException code ADMIN_ONLY', () => {
    const error = captureGuardError();

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getStatus()).toBe(403);
    expect((error as ForbiddenException).getResponse()).toMatchObject({ code: 'ADMIN_ONLY' });
  });

  it('rejects an API token principal with ForbiddenException code ADMIN_ONLY', () => {
    const error = captureGuardError({ principalType: 'api_token' });

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getStatus()).toBe(403);
    expect((error as ForbiddenException).getResponse()).toMatchObject({ code: 'ADMIN_ONLY' });
  });

  it('runs the JWT guard before the admin-only guard on API token routes', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ApiTokensController);

    expect(guards).toEqual([JwtAuthGuard, AdminOnlyGuard]);
  });
});
