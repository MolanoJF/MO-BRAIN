import { Hono } from 'hono';
import { join } from 'node:path';
import type { Deps } from '../app.ts';
import { requireUser, type AppEnv } from '../http.ts';
import { skillsBundle } from '../install.ts';

export function installRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  // The CLI is not a secret; a member downloads it before they have a key.
  r.get('/install/mobrain', () => new Response(Bun.file(join(deps.env.appDir, 'bin', 'mobrain')), {
    headers: { 'content-type': 'text/x-shellscript; charset=utf-8' } }));
  r.get('/install/skills.tar.gz', async (c) => {
    requireUser(c);
    const body = await skillsBundle(deps.env.gbrainSkillsDir, join(deps.env.appDir, 'skills'));
    return new Response(body, { headers: { 'content-type': 'application/gzip' } });
  });
  return r;
}
