import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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

  it('preserves the MCP tool schema and argument validation contract', async () => {
    const filesService = {
      findAll: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new McpService(
      filesService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      auditService as any,
    );
    const server = service.buildServer(principal, 'http://localhost');
    const client = new Client({ name: 'mcp-schema-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      const listFiles = listed.tools.find((tool) => tool.name === 'list_files');
      expect(listFiles?.inputSchema).toMatchObject({
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          page_size: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          folder_id: { type: 'string' },
        },
      });

      const valid = await client.callTool({ name: 'list_files', arguments: {} });
      expect(valid.isError).not.toBe(true);
      expect(filesService.findAll).toHaveBeenNthCalledWith(1, 1, 20, undefined);

      const invalid = await client.callTool({
        name: 'list_files',
        arguments: { page_size: 101 },
      });
      expect(invalid.isError).toBe(true);
      expect(filesService.findAll).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
