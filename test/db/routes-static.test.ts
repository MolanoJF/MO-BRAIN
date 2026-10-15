// test/db/routes-static.test.ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { staticRoutes } from '../../src/server/routes/static.ts';

let dir: string; let app: Hono;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mb-ui-'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<html>app</html>');
  await writeFile(join(dir, 'assets', 'a.js'), 'js');
  app = new Hono(); app.route('/', staticRoutes(dir));
});
afterAll(async () => rm(dir, { recursive: true, force: true }));

test('serves assets with a long cache', async () => {
  const r = await app.request('/assets/a.js');
  expect(await r.text()).toBe('js');
  expect(r.headers.get('cache-control')).toContain('immutable');
});
test('falls back to index.html for app routes', async () => {
  expect(await (await app.request('/pages/p-x/people/ada')).text()).toBe('<html>app</html>');
});
test('unknown API paths are JSON 404s, not the app', async () => {
  const r = await app.request('/api/nope');
  expect(r.status).toBe(404);
  expect(await r.json()).toEqual({ error: 'not_found' });
});
test('path traversal never leaves the ui dir', async () => {
  expect(await (await app.request('/assets/../../etc/passwd')).text()).toBe('<html>app</html>');
});
