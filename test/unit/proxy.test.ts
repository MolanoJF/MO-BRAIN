// test/unit/proxy.test.ts
import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { proxyRoutes, PROXIED } from '../../src/server/routes/proxy.ts';

test('forwards MCP and OAuth paths to gbrain with method, body, auth and forwarded headers', async () => {
  const seen: Request[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(input, init));
    return new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const app = new Hono();
  app.route('/', proxyRoutes('http://gbrain:3131', fetchImpl));
  const r = await app.request('http://127.0.0.1:8787/mcp?x=1', {
    method: 'POST', body: '{"a":1}', headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
  });
  expect(r.status).toBe(200);
  const req = seen[0]!;
  expect(req.url).toBe('http://gbrain:3131/mcp?x=1');
  expect(req.method).toBe('POST');
  expect(req.headers.get('authorization')).toBe('Bearer t');
  expect(req.headers.get('x-forwarded-host')).toBe('127.0.0.1:8787');
  expect(await req.text()).toBe('{"a":1}');
  expect(PROXIED).toContain('/.well-known/*');
  expect(PROXIED).not.toContain('/admin');
});
