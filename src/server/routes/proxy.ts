import { Hono } from 'hono';

/** Paths served by gbrain. gbrain's /admin dashboard is deliberately absent. */
export const PROXIED = ['/mcp', '/mcp/*', '/authorize', '/token', '/register', '/revoke', '/.well-known/*', '/health'];

export function proxyRoutes(gbrainUrl: string, fetchImpl: typeof fetch = fetch): Hono {
  const r = new Hono();
  const handler = async (c: import('hono').Context) => {
    const url = new URL(c.req.url);
    const headers = new Headers(c.req.raw.headers);
    headers.delete('host');
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
    const hasBody = !['GET', 'HEAD'].includes(c.req.method);
    const res = await fetchImpl(`${gbrainUrl}${url.pathname}${url.search}`, {
      method: c.req.method,
      headers,
      body: hasBody ? await c.req.raw.arrayBuffer() : undefined,
      redirect: 'manual',
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  };
  for (const p of PROXIED) r.all(p, handler);
  return r;
}
