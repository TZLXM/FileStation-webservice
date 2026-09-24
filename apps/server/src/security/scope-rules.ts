import { ForbiddenException } from '@nestjs/common';

export interface PrincipalLike {
  principalType: 'admin' | 'api_token';
  scopes?: string[];
}

/**
 * scope 判定纯函数（由 JwtAuthGuard 在认证后内嵌调用；单测直接覆盖全部分支）。
 * 判定顺序固定：无主体 → admin 放行 → 未标注端点默认拒绝 → 缺 scope 拒绝。
 */
export function assertPrincipalScopes(user: PrincipalLike | undefined, required: string[] | undefined): void {
  if (!user) {
    throw new ForbiddenException({ code: 'NO_PRINCIPAL', message: 'No authenticated principal' });
  }
  if (user.principalType === 'admin') return;

  if (!required || required.length === 0) {
    throw new ForbiddenException({
      code: 'ENDPOINT_NOT_SCOPED',
      message: 'This endpoint is not available for API tokens',
    });
  }
  const granted = user.scopes ?? [];
  const missing = required.filter((scope) => !granted.includes(scope));
  if (missing.length > 0) {
    throw new ForbiddenException({
      code: 'INSUFFICIENT_SCOPE',
      message: `Missing scopes: ${missing.join(', ')}`,
    });
  }
}
