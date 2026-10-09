import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from './db/client.ts';
import { provisionConnection, revokeConnection } from './connections.ts';
import { callOps, seedSpace } from './opsClient.ts';
import type { Role } from './rbac.ts';

/** Deterministic, collision-free per membership. Mirrors `clientName`'s bs-<memberId8>-<slug>. */
export function privateSpaceSourceId(membershipId: string): string {
  return `my-space-${membershipId.slice(0, 8).toLowerCase()}`;
}

/**
 * The gbrain-side source name. gbrain's `sources.name` is `TEXT NOT NULL
 * UNIQUE`, so a private Space — one per membership — registers under its
 * already-unique `sourceId`; a shared Space keeps its human-readable name
 * (falling back to the id). The console label is the control-DB `spaces.name`,
 * which stays 'My Space', and is untouched here.
 */
export function gbrainSourceName(
  space: { sourceId: string; ownerMembershipId?: string | null; name?: string | null },
): string {
  return space.ownerMembershipId ? space.sourceId : (space.name ?? space.sourceId);
}

export const PRIVATE_SPACE_HARNESS = 'generic';

export type ProvisionPrivateSpaceResult =
  | { ok: true; spaceId: string; sourceId: string; connectionId: string }
  | { ok: false; error: string; status: 400 | 404 | 409 | 502 };

/**
 * gbrain's `sources` PRIMARY-KEY unique violation. Only an id collision means
 * THIS exact source is already registered. A `sources_name_key` (name)
 * collision may belong to a different source, so it must not be treated as a
 * successful registration. Used only when `sources.list` could not be read.
 */
const SOURCE_ID_COLLISION = /sources_pkey/;

function isIdCollision(stderr: string, sourceId: string): boolean {
  return SOURCE_ID_COLLISION.test(stderr) || stderr.includes(`(id)=(${sourceId})`);
}

/** True when present, false when absent, null when the list cannot be read. */
async function isSourceRegistered(sourceId: string): Promise<boolean | null> {
  try {
    const r = await callOps<{ sources?: Array<{ id?: string }> }>(
      'sources.list', {}, { json: true, timeoutMs: 60_000 },
    );
    if (!r.ok || !Array.isArray(r.json?.sources)) return null;
    return r.json!.sources!.some((s) => s.id === sourceId);
  } catch {
    return null;
  }
}

/**
 * Sync a source this call just registered so gbrain stamps `last_sync_at`. A
 * federated source with a repo path and a null `last_sync_at` fails gbrain's
 * `sync_freshness` doctor check, so an unsynced private Space makes the whole
 * brain unhealthy. Non-fatal by design: the result is reported to the caller's
 * audit, never thrown, so a transient sync failure cannot fail provisioning or
 * roll back the connection.
 *
 * The timeout is bounded below the control plane's 60 s request boundary
 * (src/control/app.ts IDLE_TIMEOUT_S): a hung inline sync must fail honestly
 * here, never surface as the empty-body 499 that boundary produces.
 */
async function syncRegisteredSource(sourceId: string): Promise<boolean> {
  try {
    const r = await callOps('sync', { source: sourceId, noPull: true, noEmbed: true }, { json: true, timeoutMs: 30_000 });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Seed + register one private Space's gbrain source. Returns ok when the
 * source is registered OR already existed; never throws. `syncOk` reports
 * whether the just-registered source was synced (false when registration
 * failed or the sync itself did).
 */
async function registerPrivateSpaceSource(
  space: { sourceId: string; localPath?: string | null; name?: string | null; ownerMembershipId?: string | null },
): Promise<{ ok: boolean; syncOk: boolean }> {
  try {
    await seedSpace(space.sourceId);
    const r = await callOps('sources.add', {
      id: space.sourceId,
      path: space.localPath ?? `/srv/brain-repos/${space.sourceId}`,
      name: gbrainSourceName(space),
      federated: true,
    }, { timeoutMs: 300_000 });
    if (r.ok || isIdCollision(r.stderr ?? '', space.sourceId)) {
      return { ok: true, syncOk: await syncRegisteredSource(space.sourceId) };
    }
    return { ok: false, syncOk: false };
  } catch {
    return { ok: false, syncOk: false };
  }
}

/**
 * Folders for a private Space this call just registered, from the pack the
 * Space resolves — the same scaffold the wizard's `/finish` and the Schema page
 * run, so an invited member's Space is not the one Space with only a seed
 * README. Create-only and idempotent. Non-fatal by design (a Space without
 * folders is usable); the outcome goes to the audit row. `routes/schema.ts` is
 * imported lazily because it sits above this module in the import graph.
 */
async function scaffoldPrivateSpace(orgId: string, actor: string, sourceId: string): Promise<string | null> {
  try {
    const [{ scaffoldSpaces }, { resolveSourcePacks, effectivePack }] = await Promise.all([
      import('./scaffold.ts'), import('./routes/schema.ts'),
    ]);
    const [brain] = await getDb().select({ gbrainVersion: schema.brains.gbrainVersion }).from(schema.brains)
      .where(eq(schema.brains.organizationId, orgId));
    const [r] = await scaffoldSpaces(orgId, actor, {
      resolveSourcePacks, effectivePack: (p) => effectivePack(brain?.gbrainVersion ?? '', p),
    }, [sourceId]);
    return r?.error ?? (r ? null : 'space did not resolve');
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function audit(orgId: string, actor: string, action: string, target: string, after: unknown) {
  // S3c: `after` is a redacted summary — never a raw request body.
  await getDb().insert(schema.auditLog)
    .values({ id: randomUUID(), organizationId: orgId, actor, action, target, before: null, after: after as object });
}

/** Cheap refusals. Callers that revoke first must check this before the revoke. */
export async function privateSpaceRefusal(
  orgId: string,
  membershipId: string,
): Promise<{ ok: false; error: string; status: 404 | 409 } | null> {
  const [org] = await getDb()
    .select({ privateSpacesEnabled: schema.organizations.privateSpacesEnabled })
    .from(schema.organizations).where(eq(schema.organizations.id, orgId));
  if (!org) return { ok: false, error: 'organization_not_found', status: 404 };
  if (!org.privateSpacesEnabled) return { ok: false, error: 'private_spaces_disabled', status: 409 };

  const [membership] = await getDb()
    .select({ id: schema.memberships.id })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.id, membershipId), eq(schema.memberships.organizationId, orgId)));
  if (!membership) return { ok: false, error: 'member_not_found', status: 404 };
  return null;
}

export async function provisionPrivateSpace(
  orgId: string,
  membershipId: string,
  actor: string,
): Promise<ProvisionPrivateSpaceResult> {
  const refused = await privateSpaceRefusal(orgId, membershipId);
  if (refused) return refused;

  const [membership] = await getDb()
    .select({ id: schema.memberships.id, role: schema.memberships.role })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.id, membershipId), eq(schema.memberships.organizationId, orgId)));
  if (!membership) return { ok: false, error: 'member_not_found', status: 404 };

  let [space] = await getDb().select().from(schema.spaces).where(and(
    eq(schema.spaces.organizationId, orgId),
    eq(schema.spaces.ownerMembershipId, membershipId),
  ));

  if (!space) {
    const sourceId = privateSpaceSourceId(membershipId);
    try {
      await getDb().insert(schema.spaces).values({
        id: randomUUID(),
        organizationId: orgId,
        sourceId,
        name: 'My Space',
        kind: 'local-git',
        localPath: `/srv/brain-repos/${sourceId}`,
        ownerMembershipId: membershipId,
      });
    } catch (e) {
      // A concurrent invite/retry raced us to the partial unique index; the row
      // it created is the one we want.
      if (!isUniqueViolation(e)) throw e;
    }
    [space] = await getDb().select().from(schema.spaces).where(and(
      eq(schema.spaces.organizationId, orgId),
      eq(schema.spaces.ownerMembershipId, membershipId),
    ));
  }
  if (!space) throw new Error('private_space_insert_failed');

  const [active] = await getDb().select().from(schema.connections).where(and(
    eq(schema.connections.organizationId, orgId),
    eq(schema.connections.membershipId, membershipId),
    eq(schema.connections.writeSpaceId, space.id),
    eq(schema.connections.state, 'active'),
  ));
  if (active) {
    return { ok: true, spaceId: space.id, sourceId: space.sourceId, connectionId: active.id };
  }

  const [pending] = await getDb().select({ id: schema.connections.id }).from(schema.connections).where(and(
    eq(schema.connections.organizationId, orgId),
    eq(schema.connections.membershipId, membershipId),
    eq(schema.connections.writeSpaceId, space.id),
    eq(schema.connections.state, 'pending'),
  ));

  // Registration is keyed on gbrain's live source list, not on `created`, so a
  // retry after a partial failure re-registers a missing source. The failure is
  // surfaced (never swallowed) and the connection is NOT provisioned without it.
  // `syncRegisteredSource` runs whenever this branch registers — a fresh
  // `sources.add` or an id-collision recovery while the list was unreadable —
  // and is idempotent, so a repeat cannot double-count.
  let syncOk: boolean | null = null;
  let scaffoldError: string | null | undefined;
  const registered = await isSourceRegistered(space.sourceId);
  if (registered !== true) {
    const ensured = await registerPrivateSpaceSource(space);
    if (!ensured.ok) {
      return { ok: false, error: 'private_space_source_failed', status: 502 };
    }
    syncOk = ensured.syncOk;
    scaffoldError = await scaffoldPrivateSpace(orgId, actor, space.sourceId);
  }

  // `privateSpace: true` is derived inside connections.ts from the write Space's
  // ownerMembershipId; never passed here.
  const provisioned = await provisionConnection({
    organizationId: orgId,
    membershipId,
    writeSpaceId: space.id,
    readSpaceIds: [],
    harness: PRIVATE_SPACE_HARNESS,
    memberRole: membership.role as Role,
    ...(pending ? { connectionId: pending.id } : {}),
  }, actor);

  await audit(orgId, actor, 'member.privateSpace', space.id, {
    sourceId: space.sourceId,
    connectionId: provisioned.connectionId,
    ...(syncOk === null ? {} : { syncOk }),
    ...(scaffoldError === undefined ? {} : { scaffoldError }),
  });

  return { ok: true, spaceId: space.id, sourceId: space.sourceId, connectionId: provisioned.connectionId };
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; errno?: string; cause?: { code?: string; errno?: string } };
  const code = err.errno ?? err.code ?? err.cause?.errno ?? err.cause?.code;
  return code === '23505';
}

/**
 * Detach everything that writes to a private Space so it can be archived or
 * removed: its schedules (and their alerts), then its connections, revoked in
 * gbrain and deleted (`connections.write_space_id` has no ON DELETE). The same
 * sequence member offboarding runs. The member keeps their membership and can
 * provision a fresh private Space afterwards.
 */
export async function detachPrivateSpaceConnections(spaceId: string, actor: string): Promise<number> {
  const conns = await getDb().select({ id: schema.connections.id }).from(schema.connections)
    .where(eq(schema.connections.writeSpaceId, spaceId));
  const ids = conns.map((c) => c.id);
  if (ids.length === 0) return 0;

  const scheds = await getDb().select({ id: schema.schedules.id }).from(schema.schedules)
    .where(inArray(schema.schedules.connectionId, ids));
  const schedIds = scheds.map((x) => x.id);
  if (schedIds.length > 0) {
    await getDb().delete(schema.scheduleAlerts).where(inArray(schema.scheduleAlerts.scheduleId, schedIds));
    await getDb().delete(schema.heldNotifications).where(inArray(schema.heldNotifications.scheduleId, schedIds));
    await getDb().delete(schema.schedules).where(inArray(schema.schedules.id, schedIds));
  }
  for (const id of ids) await revokeConnection(id, actor);
  await getDb().delete(schema.connections).where(inArray(schema.connections.id, ids));
  return ids.length;
}
