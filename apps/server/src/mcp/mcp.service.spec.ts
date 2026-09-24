import { McpPrincipal, McpService } from './mcp.service';

describe('McpService scope enforcement', () => {
  const principal: McpPrincipal = {
    accountId: 'a1',
    tokenId: 't1',
    scopes: ['files:read'],
    ip: '10.0.0.0',
  };

  it('rejects a tool call when the token lacks its required scope', () => {
    const service = new McpService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    expect(() => service.assertScope(principal, 'files:write')).toThrow(/MISSING_SCOPE/);
  });

  it('allows a tool call when the token has its required scope', () => {
    const service = new McpService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    expect(() => service.assertScope(principal, 'files:read')).not.toThrow();
  });
});
