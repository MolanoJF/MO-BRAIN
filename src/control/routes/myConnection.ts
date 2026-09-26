// src/control/routes/myConnection.ts
/**
 * Zones spec §5.1 — a member manages their OWN private connection's read scope.
 *
 * There is exactly one connection per (member, write Space): the client name
 * is `bs-<member8>-<spaceSlug>` and must be unique (connections.ts
 * `assertNoCollision`). So "my agent" is the private connection
 * `provisionPrivateSpace` created, and self-service is choosing which company
 * Spaces it may read — within the member's grants.
 */
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { requireRole, type Role } from '../rbac.ts';
import { callerFor, isAdminRole, type Caller } from '../zone.ts';
import { grantsFor } from '../grants.ts';
import { skillsPublished } from '../configValue.ts';
import {
  grantCredentialsOutPath,
  mcpUrl,
  memberClientSecretName,
  provisionConnection,
  revokeConnection,
} from '../connections.ts';
import { wiringSnippet } from '../harness.ts';
import { deleteCredentialJournal, takeGrantCredentials } from '../opsClient.ts';
import { provisionPrivateSpace } from '../privateSpaces.ts';
import { readSecret, storeSecret } from '../secrets.ts';

export const myConnectionRoutes = new Hono();

const guard = (handler: (c: any, caller: Caller) => Promise<Response>) =>
  async (c: any) => {
    let ctx: { userId: string; orgId: string; role: Role };
    try { ctx = await requireRole(c, 'viewer'); } catch (r) { return r as Response; }
    try { return await handler(c, await callerFor(ctx)); }
    catch (e: any) { return c.json({ error: e?.message ?? 'my_connection_error' }, e?.status ?? 400); }
  };

async function mine(caller: Caller) {
  const [space] = await getDb().select().from(schema.spaces).where(and(
    eq(schema.spaces.organizationId, caller.orgId),
    eq(schema.spaces.ownerMembershipId, caller.membershipId),
  ));
  if (!space) return { space: null, connection: null };
  const [connection] = await getDb().select().from(schema.connections).where(and(
    eq(schema.connections.organizationId, caller.orgId),
    eq(schema.connections.membershipId, caller.membershipId),
    eq(schema.connections.writeSpaceId, space.id),
    inArray(schema.connections.state, ['pending', 'active']),
  ));
  return { space, connection: connection ?? null };
}

/** Company Spaces this caller may read: all of them for an admin, else granted ones. */
async function readable(caller: Caller) {
  const company = await getDb().select({ id: schema.spaces.id, sourceId: schema.spaces.sourceId, name: schema.spaces.name })
    .from(schema.spaces)
    .where(and(eq(schema.spaces.organizationId, caller.orgId), isNull(schema.spaces.ownerMembershipId)));
  if (isAdminRole(caller.role)) return company;
  const granted = new Set((await grantsFor(caller.orgId, caller.membershipId)).map((g) => g.spaceId));
  return company.filter((s) => granted.has(s.id));
}

myConnectionRoutes.get('/my/connection', guard(async (c, caller) => {
  const { space, connection } = await mine(caller);
  if (!space) return c.json({ error: 'no_private_space' }, 404);
  const reads = Array.isArray(connection?.readSpaceIds)
    ? (connection!.readSpaceIds as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  return c.json({
    space: { id: space.id, sourceId: space.sourceId, name: space.name },
    connection: connection ? { id: connection.id, state: connection.state, readSpaceIds: reads } : null,
    readable: await readable(caller),
  });
}));

myConnectionRoutes.put('/my/connection', guard(async (c, caller) => {
  const body = await c.req.json().catch(() => ({}));
  const requested = Array.isArray(body?.readSpaceIds)
    ? [...new Set((body.readSpaceIds as unknown[]).filter((x): x is string => typeof x === 'string'))]
    : null;
  if (requested === null) return c.json({ error: 'readSpaceIds is required' }, 400);

  const { space, connection } = await mine(caller);
  if (!space || !connection) return c.json({ error: 'no_private_connection' }, 404);
  if (connection.state === 'pending') return c.json({ error: 'connection_pending' }, 409);

  const allowed = new Set((await readable(caller)).map((s) => s.id));
  if (requested.some((id) => !allowed.has(id))) return c.json({ error: 'space_not_readable' }, 400);

  await provisionConnection({
    organizationId: caller.orgId, membershipId: caller.membershipId, writeSpaceId: space.id,
    readSpaceIds: requested, harness: connection.harness, memberRole: caller.role,
    connectionId: connection.id, tokenTtl: connection.tokenTtl,
  }, caller.userId);

  await getDb().insert(schema.auditLog).values({
    id: randomUUID(), organizationId: caller.orgId, actor: caller.userId,
    action: 'connection.selfScope', target: connection.id, before: null,
    after: { readSpaces: requested.length },
  });
  return c.json({ ok: true, readSpaceIds: requested });
}));

function asHandoff(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseStored(raw: string): Record<string, unknown> | null {
  try { return asHandoff(JSON.parse(raw) as unknown); }
  catch { return null; }
}

function handoffMcpUrl(handoff: Record<string, unknown>): string {
  const url = handoff.mcp_url;
  return typeof url === 'string' && url.length > 0 ? url : mcpUrl();
}

/** The creds file is gone. Other ops failures must not look like a missing handoff. */
function credentialsFileGone(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return message.includes('ENOENT') || message.toLowerCase().includes('no such file');
}

/**
 * Active connections only. A secret row can outlive a failed grant; the caller
 * must already have rejected pending. Take is the fallback when no handoff is
 * stored — a missing file is not a revoke.
 */
async function loadHandoff(
  orgId: string,
  connection: { id: string; gbrainClientId: string | null },
): Promise<{ ok: true; handoff: Record<string, unknown> } | { ok: false }> {
  const name = memberClientSecretName(connection.id);
  const stored = await readSecret(orgId, name);
  if (stored != null) {
    const parsed = parseStored(stored);
    if (parsed) return { ok: true, handoff: parsed };
  }
  let taken: unknown;
  try {
    taken = await takeGrantCredentials(grantCredentialsOutPath(connection.id));
  } catch (e) {
    if (credentialsFileGone(e)) return { ok: false };
    throw e;
  }
  const handoff = asHandoff(taken);
  if (!handoff) return { ok: false };
  await storeSecret(orgId, name, JSON.stringify(handoff));
  if (connection.gbrainClientId) await deleteCredentialJournal(connection.gbrainClientId);
  return { ok: true, handoff };
}

async function present(connection: { harness: string }, handoff: Record<string, unknown>) {
  const mcp_url = handoffMcpUrl(handoff);
  const clientId = handoff.client_id;
  const snippet = wiringSnippet(connection.harness, {
    client_id: typeof clientId === 'string' && clientId.length > 0 ? clientId : undefined,
    mcp_url,
  }, { skills: await skillsPublished() });
  return { mcp_url, harness: connection.harness, credentials: handoff, snippet };
}

myConnectionRoutes.get('/my/mcp', guard(async (c, caller) => {
  const { space, connection } = await mine(caller);
  if (!space) return c.json({ error: 'no_private_space' }, 404);
  if (!connection) return c.json({ error: 'no_private_connection' }, 404);
  // Pending is not readable, even when a secret row was stored before the grant failed.
  if (connection.state === 'pending') return c.json({ error: 'connection_pending' }, 409);
  const loaded = await loadHandoff(caller.orgId, connection);
  if (!loaded.ok) return c.json({ error: 'credentials_unavailable' }, 409);
  return c.json(await present(connection, loaded.handoff));
}));

myConnectionRoutes.post('/my/mcp/reissue', guard(async (c, caller) => {
  const { connection } = await mine(caller);
  if (!connection) return c.json({ error: 'no_private_connection' }, 404);
  await revokeConnection(connection.id, caller.userId);
  const created = await provisionPrivateSpace(caller.orgId, caller.membershipId, caller.userId);
  if (!created.ok) return c.json({ error: created.error }, created.status);
  const [fresh] = await getDb().select().from(schema.connections).where(and(
    eq(schema.connections.id, created.connectionId),
    eq(schema.connections.organizationId, caller.orgId),
  ));
  if (!fresh || fresh.state !== 'active') return c.json({ error: 'no_private_connection' }, 404);
  const loaded = await loadHandoff(caller.orgId, fresh);
  if (!loaded.ok) return c.json({ error: 'credentials_unavailable' }, 409);
  return c.json(await present(fresh, loaded.handoff));
}));
