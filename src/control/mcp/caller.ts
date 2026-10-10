/**
 * Spec agent-control-mcp D2/D5: a bearer → the human it belongs to.
 *
 * 1. Ops presents the bearer to gbrain's `whoami` (gbrain verifies it) and we
 *    read the OAuth client id. Only that answer is cached, ≤ 60 s, keyed by a
 *    SHA-256 of the token — never the token.
 * 2. The client id must be a `connections.gbrain_client_id`. Connection state,
 *    the membership role and the data-only flag (`control_enabled`) are re-read
 *    on EVERY call, so a revoke, a role change or a data-only flip takes effect
 *    immediately, cache or not.
 * 3. A per-run token is its own OAuth client (`agent_runs.gbrain_client_id`),
 *    and `connections.server_client_id` is the server-side minting client:
 *    both are runner identities and are refused (D5).
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { mcpWhoami } from '../opsClient.ts';
import { ROLE_RANK, type Role } from '../rbac.ts';
import type { WhoamiReply } from '../../ops/whoami.ts';
import type { ControlCaller } from './callerEnv.ts';

export type Refusal =
  | 'invalid_token' | 'identity_unavailable' | 'not_oauth' | 'runner_token'
  | 'unknown_client' | 'connection_inactive' | 'no_membership' | 'control_disabled';

export type Resolution =
  | { ok: true; caller: ControlCaller }
  | {
    ok: false; status: 401 | 403 | 503; error: Refusal;
    /** Present when the refusal names someone: who to write the audit row as. */
    audit?: { orgId: string | null; actor: string; clientId: string };
  };

export type ResolverDeps = {
  whoami: (bearer: string) => Promise<WhoamiReply>;
  now: () => number;
  ttlMs: number;
};

const MAX_TTL_MS = 60_000;
const DEFAULT_TTL_MS = 30_000;
const MAX_CACHED = 10_000;
const cache = new Map<string, { clientId: string; expiresAt: number }>();

export function tokenKey(bearer: string): string {
  return createHash('sha256').update(bearer).digest('hex');
}

export function clearCallerCache(): void {
  cache.clear();
}

function ttlFromEnv(): number {
  const raw = Number(process.env.CONTROL_MCP_IDENTITY_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(raw) ? Math.max(0, Math.min(raw, MAX_TTL_MS)) : DEFAULT_TTL_MS;
}

export function defaultResolverDeps(): ResolverDeps {
  return { whoami: mcpWhoami, now: Date.now, ttlMs: ttlFromEnv() };
}

/** The OAuth client id in a `whoami` identity. Which key carries it is not yet
 *  pinned: the §8 `whoami` probe was never written. `test/contract/control-mcp.contract.test.ts`
 *  exercises this path end to end against the real ops. */
export function clientIdFromWhoami(identity: Record<string, unknown>): string | null {
  if (identity.transport !== 'oauth') return null;
  const client = identity.client;
  const nested = client !== null && typeof client === 'object'
    ? [(client as Record<string, unknown>).id, (client as Record<string, unknown>).client_id]
    : [client];
  for (const v of [identity.client_id, identity.clientId, ...nested]) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

type ClientLookup = { ok: true; clientId: string } | { ok: false; status: 401 | 403 | 503; error: Refusal };

async function clientIdFor(bearer: string, deps: ResolverDeps): Promise<ClientLookup> {
  const key = tokenKey(bearer);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > deps.now()) return { ok: true, clientId: hit.clientId };
  cache.delete(key);

  let reply: WhoamiReply;
  try {
    reply = await deps.whoami(bearer);
  } catch {
    // Ops unreachable: say so. Never tell an agent its token is bad when it isn't.
    return { ok: false, status: 503, error: 'identity_unavailable' };
  }
  if (!reply.ok) {
    return reply.status === 401 || reply.status === 400
      ? { ok: false, status: 401, error: 'invalid_token' }
      : { ok: false, status: 503, error: 'identity_unavailable' };
  }
  const clientId = clientIdFromWhoami(reply.identity);
  if (!clientId) return { ok: false, status: 403, error: 'not_oauth' };
  if (deps.ttlMs > 0) {
    if (cache.size >= MAX_CACHED) cache.clear();
    cache.set(key, { clientId, expiresAt: deps.now() + deps.ttlMs });
  }
  return { ok: true, clientId };
}

export async function resolveCaller(bearer: string, deps: ResolverDeps = defaultResolverDeps()): Promise<Resolution> {
  const id = await clientIdFor(bearer, deps);
  if (!id.ok) return id;
  const { clientId } = id;
  const db = getDb();

  const rows = await db.select().from(schema.connections)
    .where(eq(schema.connections.gbrainClientId, clientId));
  const conn = rows.find((r) => r.state === 'active') ?? rows[0];

  if (!conn) {
    const [server] = await db.select({ id: schema.connections.id, orgId: schema.connections.organizationId })
      .from(schema.connections).where(eq(schema.connections.serverClientId, clientId));
    if (server) {
      return { ok: false, status: 403, error: 'runner_token',
        audit: { orgId: server.orgId, actor: `connection-server:${server.id}`, clientId } };
    }
    const [run] = await db.select({ runId: schema.agentRuns.runId, orgId: schema.agentRuns.organizationId })
      .from(schema.agentRuns).where(eq(schema.agentRuns.gbrainClientId, clientId));
    if (run) {
      return { ok: false, status: 403, error: 'runner_token',
        audit: { orgId: run.orgId ?? null, actor: `run:${run.runId}`, clientId } };
    }
    return { ok: false, status: 403, error: 'unknown_client' };
  }

  const [m] = await db.select().from(schema.memberships).where(eq(schema.memberships.id, conn.membershipId));
  if (!m || m.organizationId !== conn.organizationId || !Object.prototype.hasOwnProperty.call(ROLE_RANK, m.role)) {
    return { ok: false, status: 403, error: 'no_membership',
      audit: { orgId: conn.organizationId, actor: `connection:${conn.id}`, clientId } };
  }
  if (conn.state !== 'active') {
    return { ok: false, status: 403, error: 'connection_inactive',
      audit: { orgId: conn.organizationId, actor: m.userId, clientId } };
  }
  if (conn.controlEnabled === false) {
    return { ok: false, status: 403, error: 'control_disabled',
      audit: { orgId: conn.organizationId, actor: m.userId, clientId } };
  }
  return {
    ok: true,
    caller: {
      userId: m.userId, orgId: conn.organizationId, role: m.role as Role,
      membershipId: m.id, connectionId: conn.id, clientId,
    },
  };
}
