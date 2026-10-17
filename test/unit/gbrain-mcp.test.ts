// test/unit/gbrain-mcp.test.ts
import { describe, expect, test } from 'bun:test';
import { McpError, mcpCaller } from '../../src/server/gbrain/mcp.ts';

function fakeFetch(reply: { status?: number; body: string; type?: string }, seen: Request[] = []) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(input, init));
    return new Response(reply.body, { status: reply.status ?? 200, headers: { 'content-type': reply.type ?? 'application/json' } });
  }) as typeof fetch;
}
const ok = (payload: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });

describe('mcpCaller', () => {
  test('posts a tools/call with the bearer and returns the parsed tool JSON', async () => {
    const seen: Request[] = [];
    const call = mcpCaller('http://gbrain:3131/mcp', 'tok', fakeFetch({ body: ok({ pages: [1] }) }, seen));
    expect(await call<unknown>('list_pages', { limit: 1 })).toEqual({ pages: [1] });
    const req = seen[0]!;
    expect(req.headers.get('authorization')).toBe('Bearer tok');
    expect(await req.json()).toMatchObject({ method: 'tools/call', params: { name: 'list_pages', arguments: { limit: 1 } } });
  });

  test('reads an SSE-framed reply', async () => {
    const call = mcpCaller('http://x/mcp', 't', fakeFetch({ body: `event: message\ndata: ${ok({ a: 1 })}\n\n`, type: 'text/event-stream' }));
    expect(await call<unknown>('x', {})).toEqual({ a: 1 });
  });

  test('a 401 is an McpError with status 401', async () => {
    const call = mcpCaller('http://x/mcp', 't', fakeFetch({ status: 401, body: '{}' }));
    await expect(call('x', {})).rejects.toMatchObject({ status: 401 });
  });

  test('an isError tool result is an McpError carrying the text', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'source_not_readable' }] } });
    const call = mcpCaller('http://x/mcp', 't', fakeFetch({ body }));
    const err = await call('get_page', {}).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    if (!(err instanceof McpError)) throw err;
    expect(String(err.message)).toContain('source_not_readable');
    expect(err.code).toBe(null);
  });

  test('a JSON isError body exposes its machine code', async () => {
    const text = JSON.stringify({ error: 'page_not_found', code: 'page_not_found', message: 'Page not found: notes/x' });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text }] } });
    const err = await mcpCaller('http://x/mcp', 't', fakeFetch({ body }))('get_page', {}).catch((e) => e);
    if (!(err instanceof McpError)) throw err;
    expect(err.code).toBe('page_not_found');
    expect(err.status).toBe(422);
    expect(err.tool).toBe('get_page');
  });

  test('a non-JSON text block is returned as a string', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'plain words' }] } });
    expect(await mcpCaller('http://x/mcp', 't', fakeFetch({ body }))<unknown>('x', {})).toBe('plain words');
  });
});
