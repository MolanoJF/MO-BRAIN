import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { requireRole, type Role } from '../rbac.ts';
import {
  createPendingConnection,
  previewConnection,
  revokeConnection,
  type ConnectionInput,
} from '../connections.ts';
import { annotateAdapters } from '../harness.ts';

export const connectionRoutes = new Hono();

const capability = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../contracts/v0.50.0.0/capability.json'), 'utf8'),
) as { wellKnown?: { adapters?: Array<{ id: string }>; profiles?: unknown } };

async function audit(orgId: string, actor: string, action: string, target: string, after: unknown) {
  // S3c: `after` is a redacted summary — never a raw request body.
  await getDb().insert(schema.auditLog)
    .values({ id: randomUUID(), organizationId: orgId, actor, action, target, before: null, after: after as object });
}

const guard = (min: Role, handler: (c: any, ctx: { userId: string; orgId: string; role: Role }) => Promise<Response>) =>
  async (c: any) => {
    let ctx;
    try { ctx = await requireRole(c, min); } catch (r) { return r as Response; }
    try { return await handler(c, ctx); }
    catch (e: any) { return c.json({ error: e?.message ?? 'connections_error' }, e?.status ?? 400); }
  };

function asRole(value: string): Role {
  if (value === 'owner' || value === 'admin' || value === 'member' || value === 'viewer') return value;
  throw Object.assign(new Error(`invalid membership role ${value}`), { status: 400 });
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

async function connectionInputFromBody(orgId: string, body: unknown): Promise<ConnectionInput> {
  const b = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const membershipId = typeof b.membershipId === 'string' ? b.membershipId : '';
  const writeSpaceId = typeof b.writeSpaceId === 'string' ? b.writeSpaceId : '';
  const harness = typeof b.harness === 'string' ? b.harness : '';
  if (!membershipId || !writeSpaceId || !harness) {
    throw Object.assign(new Error('membershipId, writeSpaceId and harness are required'), { status: 400 });
  }
  const [m] = await getDb().select().from(schema.memberships)
    .where(and(eq(schema.memberships.id, membershipId), eq(schema.memberships.organizationId, orgId)));
  if (!m) throw Object.assign(new Error('membership not found'), { status: 404 });
  const input: ConnectionInput = {
    organizationId: orgId,
    membershipId,
    writeSpaceId,
    readSpaceIds: asStringArray(b.readSpaceIds),
    harness,
    memberRole: asRole(m.role),
  };
  if (typeof b.connectionId === 'string') input.connectionId = b.connectionId;
  if (Array.isArray(b.boundSlugPrefixes)) input.boundSlugPrefixes = asStringArray(b.boundSlugPrefixes);
  if (typeof b.tokenTtl === 'number') input.tokenTtl = b.tokenTtl;
  if (typeof b.budgetUsdPerDay === 'number') input.budgetUsdPerDay = b.budgetUsdPerDay;
  return input;
}

connectionRoutes.get('/harnesses', guard('viewer', async (c) => {
  return c.json({
    adapters: annotateAdapters(capability.wellKnown?.adapters ?? []),
    profiles: capability.wellKnown?.profiles ?? [],
  });
}));

connectionRoutes.get('/connections', guard('admin', async (c, { orgId }) => {
  const rows = await getDb().select().from(schema.connections)
    .where(eq(schema.connections.organizationId, orgId));
  return c.json({ connections: rows });
}));

connectionRoutes.post('/connections/preview', guard('admin', async (c, { orgId }) => {
  const preview = await previewConnection(await connectionInputFromBody(orgId, await c.req.json()));
  return c.json(preview);
}));

connectionRoutes.post('/connections', guard('admin', async (c, { userId, orgId }) => {
  const input = await connectionInputFromBody(orgId, await c.req.json());
  delete input.connectionId;
  const created = await createPendingConnection(input);
  await audit(orgId, userId, 'connection.create', created.connectionId, {
    profile: created.compiled.profile,
    state: 'pending',
  });
  return c.json({ id: created.connectionId, state: 'pending', compiled: created.compiled });
}));

connectionRoutes.post('/connections/:id/revoke', guard('admin', async (c, { userId, orgId }) => {
  const id = c.req.param('id');
  const [row] = await getDb().select({
    id: schema.connections.id,
    organizationId: schema.connections.organizationId,
  }).from(schema.connections).where(eq(schema.connections.id, id));
  if (!row || row.organizationId !== orgId) return c.json({ error: 'connection not found' }, 404);
  await revokeConnection(id, userId);
  return c.json({ ok: true });
}));
