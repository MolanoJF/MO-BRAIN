import { Hono } from 'hono';
import type { Context } from 'hono';
import { auth } from '../auth.ts';
import { isBootstrapped, bootstrapFirstAdmin } from '../bootstrap.ts';
import { requireRole } from '../rbac.ts';

export const authRoutes = new Hono();

authRoutes.on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw));

authRoutes.get('/bootstrap', async (c) => c.json({ bootstrapped: await isBootstrapped() }));

authRoutes.post('/bootstrap', async (c) => {
  if (await isBootstrapped()) return c.json({ error: 'already_bootstrapped' }, 409);
  const { email, password, orgName } = await c.req.json();
  if (!email || !password || !orgName) return c.json({ error: 'email, password and orgName are required' }, 400);
  try {
    // S3c: the request carries a password — nothing here logs the body.
    return c.json(await bootstrapFirstAdmin(email, password, orgName));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'bootstrap_failed' }, 400);
  }
});

/** Resolve the caller's session and their org, or throw a 401/403 response. */
export async function requireAdmin(c: Context) {
  return requireRole(c, 'admin');
}
