import { describe, expect, test } from 'bun:test';

process.env.GBRAIN_MCP_URL = 'http://gbrain-serve.test/mcp';
delete process.env.GBRAIN_MCP_TLS_INSECURE;

const { whoamiFor } = await import('../../src/ops/whoami.ts');

const BEARER = 'gbrain_at_0123456789abcdef';

function fakeFetch(respond: (req: { url: string; init: RequestInit }) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond({ url, init });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const sse = (payload: unknown) => new Response(
  `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);

describe('whoamiFor', () => {
  test('refuses a bearer that could split a header, without dialing gbrain', async () => {
    const f = fakeFetch(() => new Response('{}'));
    for (const bad of ['short', `${BEARER}\r\nx: y`, `${BEARER} extra`, 42, undefined]) {
      expect(await whoamiFor(bad, f.impl)).toEqual({ ok: false, status: 400, error: 'invalid_bearer' });
    }
    expect(f.calls.length).toBe(0);
  });

  test('presents the bearer to the whoami tool and returns its JSON identity', async () => {
    const identity = { transport: 'oauth', client_id: 'gbrain_cl_abc', source_id: 'customers' };
    const f = fakeFetch(() => sse({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify(identity) }] },
    }));
    expect(await whoamiFor(BEARER, f.impl)).toEqual({ ok: true, identity });
    expect(f.calls[0]!.url).toBe('http://gbrain-serve.test/mcp');
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${BEARER}`);
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} },
    });
  });

  test('a 401 from gbrain is invalid_token', async () => {
    const f = fakeFetch(() => new Response('{"error":"invalid_token"}', { status: 401 }));
    expect(await whoamiFor(BEARER, f.impl)).toEqual({ ok: false, status: 401, error: 'invalid_token' });
  });

  test('a 5xx is a 502, never an auth failure', async () => {
    const f = fakeFetch(() => new Response('boom', { status: 500 }));
    expect(await whoamiFor(BEARER, f.impl)).toEqual({ ok: false, status: 502, error: 'gbrain_http_500' });
  });

  test('an unreachable gbrain is a 502', async () => {
    const f = fakeFetch(() => { throw new TypeError('fetch failed'); });
    expect(await whoamiFor(BEARER, f.impl)).toEqual({ ok: false, status: 502, error: 'gbrain_unreachable' });
  });

  test('a JSON-RPC error frame or a non-object identity is malformed', async () => {
    const err = fakeFetch(() => sse({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'nope' } }));
    expect(await whoamiFor(BEARER, err.impl)).toEqual({ ok: false, status: 502, error: 'whoami_malformed' });
    const arr = fakeFetch(() => sse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '[1]' }] } }));
    expect(await whoamiFor(BEARER, arr.impl)).toEqual({ ok: false, status: 502, error: 'whoami_malformed' });
  });
});
