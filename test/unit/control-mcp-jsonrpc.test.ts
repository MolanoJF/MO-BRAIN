import { describe, expect, test } from 'bun:test';
import { handleRpc, LATEST_PROTOCOL } from '../../src/control/mcp/jsonrpc.ts';
import { createLimiter } from '../../src/control/mcp/rateLimit.ts';

const h = {
  listTools: () => [{ name: 'org_get', description: 'd', inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false as const }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }],
  callTool: async (name: string, args: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ name, args }) }], structuredContent: { name, args: args as never }, isError: false }),
};

describe('handleRpc', () => {
  test('initialize negotiates a supported version, else the latest', async () => {
    const asked = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, h);
    expect((asked.body as any).result.protocolVersion).toBe('2025-03-26');
    expect((asked.body as any).result.serverInfo.name).toBe('mobrain-control');
    expect((asked.body as any).result.capabilities).toEqual({ tools: { listChanged: false } });
    const odd = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, h);
    expect((odd.body as any).result.protocolVersion).toBe(LATEST_PROTOCOL);
  });

  test('a notification is 202 with no body', async () => {
    expect(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, h)).toEqual({ status: 202, body: null });
  });

  test('ping, tools/list, tools/call', async () => {
    expect((await handleRpc({ jsonrpc: '2.0', id: 'p', method: 'ping' }, h)).body).toEqual({ jsonrpc: '2.0', id: 'p', result: {} });
    expect(((await handleRpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, h)).body as any).result.tools[0].name).toBe('org_get');
    const call = await handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'org_get', arguments: { a: 1 } } }, h);
    expect((call.body as any).result.structuredContent).toEqual({ name: 'org_get', args: { a: 1 } });
  });

  test('tools/call without a name is -32602', async () => {
    const r = await handleRpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: {} }, h);
    expect((r.body as any).error.code).toBe(-32602);
  });

  test('batches, non-objects and bad envelopes are -32600 with HTTP 400', async () => {
    for (const bad of [[{ jsonrpc: '2.0', id: 1, method: 'ping' }], 'x', null, { id: 1, method: 'ping' }, { jsonrpc: '2.0', id: {}, method: 'ping' }]) {
      const r = await handleRpc(bad, h);
      expect(r.status).toBe(400);
      expect((r.body as any).error.code).toBe(-32600);
    }
  });

  test('an unknown method is -32601', async () => {
    expect(((await handleRpc({ jsonrpc: '2.0', id: 6, method: 'resources/list' }, h)).body as any).error.code).toBe(-32601);
  });
});

describe('createLimiter', () => {
  test('allows a burst, then refuses with a retry-after, then refills', () => {
    let t = 0;
    const l = createLimiter({ capacity: 2, refillPerSec: 1, now: () => t });
    expect(l.take('k').ok).toBe(true);
    expect(l.take('k').ok).toBe(true);
    expect(l.take('k')).toEqual({ ok: false, retryAfterS: 1 });
    expect(l.take('other').ok).toBe(true);
    t = 1000;
    expect(l.take('k').ok).toBe(true);
  });
});
