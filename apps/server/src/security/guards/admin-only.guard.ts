import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

@Injectable()
export class AdminOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (req.user?.principalType !== 'admin') {
      throw new ForbiddenException({
        code: 'ADMIN_ONLY',
        message: 'This endpoint requires an admin session',
      });
    }
    return true;
  }
}
