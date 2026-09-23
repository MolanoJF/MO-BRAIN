import { Hono } from 'hono';
import type { Context } from 'hono';
import { auth, googleConfigured } from '../auth.ts';
import {
  isBootstrapped, bootstrapFirstAdmin, bootstrapFirstAdminForSession, defaultBrainName,
} from '../bootstrap.ts';
import { requireRole } from '../rbac.ts';
import { getDb, schema } from '../db/client.ts';
import { eq } from 'drizzle-orm';

export const authRoutes = new Hono();

authRoutes.on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw));

// D4: registered OUTSIDE the /auth/* wildcard on purpose — Better Auth owns
// everything under /auth, and this is ours, not a route it should ever see.
authRoutes.get('/auth-config', (c) => c.json({ google: googleConfigured }));

authRoutes.get('/me', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const userId = session?.user?.id;
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const [row] = await getDb().select({ id: schema.memberships.id }).from(schema.memberships)
    .where(eq(schema.memberships.userId, userId));
  return c.json({ email: session.user.email, hasMembership: !!row });
});

authRoutes.get('/bootstrap', async (c) => c.json({ bootstrapped: await isBootstrapped() }));

authRoutes.post('/bootstrap', async (c) => {
  if (await isBootstrapped()) return c.json({ error: 'already_bootstrapped' }, 409);
  const body = await c.req.json();
  try {
    // Email+password path: nothing here logs the body (S3c: it carries a password).
    if (typeof body.email === 'string' && typeof body.password === 'string') {
      // Zones spec D6: the name is optional — a personal brain is named after its person.
      const name = typeof body.orgName === 'string' && body.orgName.trim()
        ? body.orgName.trim() : defaultBrainName(String(body.email));
      return c.json(await bootstrapFirstAdmin(body.email, body.password, name));
    }
    // New path: no password given, so the caller must already be signed in
    // (they clicked "Continue with Google" first).
    const orgName = body?.orgName;
    if (!orgName) return c.json({ error: 'orgName is required' }, 400);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user?.id) return c.json({ error: 'sign_in_required' }, 401);
    return c.json(await bootstrapFirstAdminForSession(session.user.id, orgName));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'bootstrap_failed' }, 400);
  }
});

/** Resolve the caller's session and their org, or throw a 401/403 response. */
export async function requireAdmin(c: Context) {
  return requireRole(c, 'admin');
}
