import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, getTableColumns, inArray, isNotNull } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { requireRole, ROLE_RANK, type Role } from '../rbac.ts';
import {
  createPendingConnection,
  previewConnection,
  revokeConnection,
  type ConnectionInput,
} from '../connections.ts';
import { grantsForConnection } from '../grants.ts';
import { callerFor, visibleZoneSql } from '../zone.ts';
import { annotateAdapters } from '../harness.ts';
import { commitAsMember } from '../opsClient.ts';
import { GBRAIN_PIN, capabilityPath } from '../../contracts/pin.ts';

export const connectionRoutes = new Hono();

type CapabilityFile = { wellKnown?: { adapters?: Array<{ id: string }>; profiles?: unknown } };

function loadCapability(): CapabilityFile {
  const path = join(import.meta.dir, '../../..', capabilityPath());
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CapabilityFile;
  } catch (e) {
    // D8: capability.json for a freshly-bumped pin does not exist until
    // Task 8's capture runs post-upgrade — a missing file must not crash
    // the whole control plane at import time.
    console.error(`connections: no capability snapshot at ${path} yet (${(e as Error).message})`);
    return {};
  }
}

const capability = loadCapability();

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

/** Zones: a connection an admin issues lives in the company zone. A personal
 *  Space is reachable only through its owner's own private connection. */
async function assertCompanyOnly(input: ConnectionInput): Promise<void> {
  const ids = [input.writeSpaceId, ...input.readSpaceIds];
  const [personal] = await getDb().select({ id: schema.spaces.id }).from(schema.spaces).where(and(
    eq(schema.spaces.organizationId, input.organizationId),
    inArray(schema.spaces.id, ids),
    isNotNull(schema.spaces.ownerMembershipId),
  ));
  if (personal) throw Object.assign(new Error('personal_space_not_grantable'), { status: 400 });
}

connectionRoutes.get('/harnesses', guard('viewer', async (c) => {
  return c.json({
    adapters: annotateAdapters(capability.wellKnown?.adapters ?? []),
    profiles: capability.wellKnown?.profiles ?? [],
  });
}));

connectionRoutes.get('/connections', guard('admin', async (c, ctx) => {
  const caller = await callerFor(ctx);
  const rows = await getDb().select(getTableColumns(schema.connections))
    .from(schema.connections)
    .leftJoin(schema.spaces, eq(schema.spaces.id, schema.connections.writeSpaceId))
    .where(and(eq(schema.connections.organizationId, caller.orgId), visibleZoneSql(caller)));
  return c.json({ connections: rows });
}));

connectionRoutes.post('/connections/preview', guard('admin', async (c, { orgId }) => {
  const input = await connectionInputFromBody(orgId, await c.req.json());
  await assertCompanyOnly(input);
  const preview = await previewConnection(input);
  return c.json(preview);
}));

connectionRoutes.post('/connections', guard('admin', async (c, { userId, orgId }) => {
  const input = await connectionInputFromBody(orgId, await c.req.json());
  delete input.connectionId;
  await assertCompanyOnly(input);
  const created = await createPendingConnection(input);
  // Zones D7: access is a grant, not a side effect of a connection existing.
  await grantsForConnection(input, userId);
  await audit(orgId, userId, 'connection.create', created.connectionId, {
    profile: created.compiled.profile,
    state: 'pending',
  });
  return c.json({ id: created.connectionId, state: 'pending', compiled: created.compiled });
}));

connectionRoutes.post('/connections/:id/revoke', guard('admin', async (c, ctx) => {
  const caller = await callerFor(ctx);
  const id = c.req.param('id');
  const [row] = await getDb().select({ id: schema.connections.id })
    .from(schema.connections)
    .leftJoin(schema.spaces, eq(schema.spaces.id, schema.connections.writeSpaceId))
    .where(and(
      eq(schema.connections.id, id),
      eq(schema.connections.organizationId, caller.orgId),
      visibleZoneSql(caller),
    ));
  if (!row) return c.json({ error: 'connection not found' }, 404);
  await revokeConnection(id, caller.userId);
  return c.json({ ok: true });
}));

connectionRoutes.post('/connections/:id/commit', guard('viewer', async (c, ctx) => {
  const caller = await callerFor(ctx);
  const { userId, orgId, role } = caller;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const message = typeof (body as { message?: unknown })?.message === 'string'
    ? (body as { message: string }).message.trim()
    : '';
  if (!message) return c.json({ error: 'message required' }, 400);

  const [row] = await getDb()
    .select({
      id: schema.connections.id,
      organizationId: schema.connections.organizationId,
      sourceId: schema.spaces.sourceId,
      memberUserId: schema.memberships.userId,
      name: schema.users.name,
      email: schema.users.email,
    })
    .from(schema.connections)
    .innerJoin(schema.spaces, eq(schema.connections.writeSpaceId, schema.spaces.id))
    .innerJoin(schema.memberships, eq(schema.connections.membershipId, schema.memberships.id))
    .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
    .where(and(
      eq(schema.connections.id, id),
      eq(schema.connections.organizationId, orgId),
      visibleZoneSql(caller),
    ));
  if (!row || row.organizationId !== orgId) return c.json({ error: 'connection not found' }, 404);
  if (ROLE_RANK[role] < ROLE_RANK.admin && row.memberUserId !== userId) {
    return c.json({ error: 'forbidden' }, 403);
  }

  // Actor is the Connection's member, never name/email from the request body.
  const actor = { name: (row.name && row.name.trim()) || row.email, email: row.email };
  const result = await commitAsMember(row.sourceId, actor, message);
  await audit(orgId, userId, 'connection.commit', id, {
    sourceId: row.sourceId,
    committed: result.committed,
    sha: result.sha,
  });
  return c.json(result);
}));
