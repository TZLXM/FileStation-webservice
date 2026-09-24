import { ForbiddenException } from '@nestjs/common';
import { assertPrincipalScopes } from './scope-rules';

function expectForbiddenCode(fn: () => void, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ForbiddenException);
    expect((e as ForbiddenException).getResponse()).toMatchObject({ code });
    return;
  }
  throw new Error(`expected ForbiddenException(${code})`);
}

describe('assertPrincipalScopes', () => {
  it('admin 主体无条件放行（含未标注端点）', () => {
    expect(() => assertPrincipalScopes({ principalType: 'admin' }, ['files:write'])).not.toThrow();
    expect(() => assertPrincipalScopes({ principalType: 'admin' }, undefined)).not.toThrow();
  });

  it('api_token 主体 scope 覆盖全部 required 则放行', () => {
    expect(() =>
      assertPrincipalScopes({ principalType: 'api_token', scopes: ['files:read', 'shares:write'] }, ['files:read']),
    ).not.toThrow();
  });

  it('api_token 主体缺 scope → INSUFFICIENT_SCOPE', () => {
    expectForbiddenCode(
      () => assertPrincipalScopes({ principalType: 'api_token', scopes: ['files:read'] }, ['files:write']),
      'INSUFFICIENT_SCOPE',
    );
  });

  it('未标注 scopes 的端点拒绝 api_token 主体（ENDPOINT_NOT_SCOPED，默认拒绝）', () => {
    expectForbiddenCode(
      () => assertPrincipalScopes({ principalType: 'api_token', scopes: ['files:read'] }, undefined),
      'ENDPOINT_NOT_SCOPED',
    );
  });

  it('@RequireScopes() 空参（元数据为 [] 而非 undefined）同样视为未标注 → ENDPOINT_NOT_SCOPED', () => {
    expectForbiddenCode(
      () => assertPrincipalScopes({ principalType: 'api_token', scopes: ['files:read'] }, []),
      'ENDPOINT_NOT_SCOPED',
    );
  });

  it('无主体 → NO_PRINCIPAL', () => {
    expectForbiddenCode(() => assertPrincipalScopes(undefined, ['files:read']), 'NO_PRINCIPAL');
  });
});
