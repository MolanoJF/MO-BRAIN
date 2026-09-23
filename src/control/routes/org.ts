/**
 * The organization's own settings: its name and its mode (zones spec §5.2).
 *
 * Company → personal is D3: allowed only while the owner is the org's ONLY
 * membership and no invite is still claimable. Once someone else could be
 * inside, switching back would strand them, so it is a 409, never a warning.
 * Company Spaces created meanwhile are left as they are — ordinary sources.
 */
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { requireRole, type Role } from '../rbac.ts';
import { asBrainMode, capabilitiesFor } from '../capabilities.ts';

export const orgRoutes = new Hono();

const guard = (min: Role, handler: (c: any, ctx: { userId: string; orgId: string; role: Role }) => Promise<Response>) =>
  async (c: any) => {
    let ctx;
    try { ctx = await requireRole(c, min); } catch (r) { return r as Response; }
    try { return await handler(c, ctx); }
    catch (e: any) { return c.json({ error: e?.message ?? 'org_error' }, e?.status ?? 400); }
  };

async function audit(orgId: string, actor: string, action: string, after: unknown) {
  await getDb().insert(schema.auditLog)
    .values({ id: randomUUID(), organizationId: orgId, actor, action, target: orgId, before: null, after: after as object });
}

async function memberCount(orgId: string): Promise<number> {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.memberships)
    .where(eq(schema.memberships.organizationId, orgId));
  return row?.n ?? 0;
}

async function openInvites(orgId: string): Promise<number> {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.claimLinks)
    .where(and(
      eq(schema.claimLinks.organizationId, orgId),
      isNull(schema.claimLinks.claimedAt),
      gt(schema.claimLinks.expiresAt, new Date()),
    ));
  return row?.n ?? 0;
}

orgRoutes.get('/org', guard('viewer', async (c, { orgId, role }) => {
  const [org] = await getDb().select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
  if (!org) return c.json({ error: 'organization_not_found' }, 404);
  const brainMode = asBrainMode(org.brainMode);
  return c.json({
    id: org.id, name: org.name, brainMode,
    capabilities: capabilitiesFor(brainMode),
    memberCount: await memberCount(orgId),
    role,
  });
}));

orgRoutes.patch('/org', guard('admin', async (c, { userId, orgId }) => {
  const body = await c.req.json().catch(() => ({}));
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return c.json({ error: 'name is required' }, 400);
  await getDb().update(schema.organizations).set({ name }).where(eq(schema.organizations.id, orgId));
  await audit(orgId, userId, 'org.rename', { name });
  return c.json({ ok: true, name });
}));

orgRoutes.patch('/org/mode', guard('owner', async (c, { userId, orgId }) => {
  const body = await c.req.json().catch(() => ({}));
  const mode = body?.mode;
  if (mode !== 'personal' && mode !== 'company') return c.json({ error: 'invalid_mode' }, 400);

  if (mode === 'personal' && ((await memberCount(orgId)) > 1 || (await openInvites(orgId)) > 0)) {
    return c.json({ error: 'team_exists' }, 409);
  }

  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  await getDb().update(schema.organizations)
    .set(name ? { brainMode: mode, name } : { brainMode: mode })
    .where(eq(schema.organizations.id, orgId));
  await audit(orgId, userId, 'org.mode', { mode, renamed: Boolean(name) });
  return c.json({ ok: true, brainMode: mode });
}));
