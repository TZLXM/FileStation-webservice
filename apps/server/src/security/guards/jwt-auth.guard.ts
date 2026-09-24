import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { REQUIRED_SCOPES_KEY } from '../decorators/require-scopes.decorator';
import { assertPrincipalScopes } from '../scope-rules';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ok = (await super.canActivate(context)) as boolean;
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    assertPrincipalScopes(context.switchToHttp().getRequest().user, required);
    return ok;
  }

  handleRequest(err: any, user: any, info: any) {
    if (err || !user) {
      throw err || new UnauthorizedException('Invalid or expired token');
    }
    return user;
  }
}
