import { Hono } from 'hono';
import { normalize, join } from 'node:path';

export function staticRoutes(uiDir: string): Hono {
  const r = new Hono();
  r.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));
  r.get('*', async (c) => {
    const rel = normalize(decodeURIComponent(c.req.path)).replace(/^(\.\.(\/|$))+/, '');
    if (rel !== '/' && !rel.includes('..')) {
      const f = Bun.file(join(uiDir, rel));
      if (await f.exists()) {
        const headers: Record<string, string> = {};
        if (rel.startsWith('/assets/')) headers['cache-control'] = 'public, max-age=31536000, immutable';
        return new Response(f, { headers });
      }
    }
    return new Response(Bun.file(join(uiDir, 'index.html')), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
  });
  return r;
}
