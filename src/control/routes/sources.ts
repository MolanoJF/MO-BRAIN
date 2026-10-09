import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { requireRole, type Role } from '../rbac.ts';
import { callerFor } from '../zone.ts';
import { callOps } from '../opsClient.ts';
import { connectRemote, disconnectRemote, pushRemote } from '../spaceRemoteOps.ts';
import { addSpaceSource, ISOLATION_NOTICE } from './wizard.ts';
import { resolveSourcePacks } from './schema.ts';
import { requireCapability } from '../capabilities.ts';

/**
 * `/api/sources/*` — the Sources admin API (Task 5). A Space is a gbrain
 * source; this is where an admin adds, renames, archives and removes one, and
 * sees the schema pack each resolves.
 *
 * `GET` joins our `spaces` rows with gbrain's live `sources.list` and Task 4's
 * pack resolution, and FLAGS mismatches (a source in one plane but not the
 * other) rather than hiding them. Every route is `admin`-only: removal is
 * destructive and irreversible.
 */
export const sourceRoutes = new Hono();

type GbrainSource = {
  id: string;
  name: string;
  local_path: string | null;
  federated: boolean;
  page_count: number | null;
  last_sync_at: string | null;
};

/** gbrain's built-in fallback source: unrouted writes land here. The console
 *  never creates it, so it has no `spaces` row and must not be listed as an
 *  unregistered source unless it actually holds pages. */
const GBRAIN_FALLBACK_SOURCE_ID = 'default';

type SpaceRow = {
  id: string; sourceId: string; name: string; kind: string;
  ownerMembershipId: string | null; gitRemote: string | null;
};

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
    catch (e: any) { return c.json({ error: e?.message ?? 'sources_error' }, e?.status ?? 400); }
  };

/** The `(organizationId, sourceId)` pair is uniquely indexed, so a Space from
 *  another org can never be resolved here. Validated before ANY destructive
 *  call or interpolated into a gbrain config key. */
async function spaceFor(orgId: string, sourceId: string): Promise<SpaceRow | null> {
  const [space] = await getDb().select({
    id: schema.spaces.id,
    sourceId: schema.spaces.sourceId,
    name: schema.spaces.name,
    kind: schema.spaces.kind,
    ownerMembershipId: schema.spaces.ownerMembershipId,
    gitRemote: schema.spaces.gitRemote,
  }).from(schema.spaces).where(and(
    eq(schema.spaces.organizationId, orgId),
    eq(schema.spaces.sourceId, sourceId),
  ));
  return space ?? null;
}

/**
 * Delete the `spaces` row and clear the per-source pack override together.
 *
 * There is deliberately NO `spaces.schema_pack` column: gbrain's DB config is
 * the truth for tier 3, so a mirrored column would only add a divergence
 * surface. Removing the Space must therefore clear the key too, or a future
 * source reusing the id would inherit a pack nobody chose for it.
 */
async function dropSourceRow(spaceId: string, sourceId: string): Promise<void> {
  await getDb().delete(schema.spaces).where(eq(schema.spaces.id, spaceId));
  await callOps('config.unset', { key: `schema_pack.source.${sourceId}` }, { timeoutMs: 60_000 });
}

/**
 * gbrain soft-delete, then drop the `spaces` row and the per-source pack key.
 * Callers must already have removed connections that write here:
 * `connections.write_space_id` has no ON DELETE, so the row delete fails
 * while one remains. Deleting the membership instead SET NULLs
 * `owner_membership_id` and publishes a personal Space as company.
 */
export async function archiveSpace(space: { id: string; sourceId: string }): Promise<
  { ok: true } | { ok: false; exitCode: number; stderr: string }
> {
  const r = await callOps('sources.archive', { id: space.sourceId }, { timeoutMs: 120_000 });
  if (!r.ok) return { ok: false, exitCode: r.exitCode, stderr: r.stderr ?? '' };
  await dropSourceRow(space.id, space.sourceId);
  return { ok: true };
}

sourceRoutes.get('/sources', guard('admin', async (c, ctx) => {
  const caller = await callerFor(ctx);
  const orgId = caller.orgId;
  const hidden = new Set((await getDb().select({
    sourceId: schema.spaces.sourceId, owner: schema.spaces.ownerMembershipId,
  }).from(schema.spaces).where(eq(schema.spaces.organizationId, orgId)))
    .filter((s) => s.owner !== null && s.owner !== caller.membershipId)
    .map((s) => s.sourceId));

  const [packResolvedAll, listed] = await Promise.all([
    resolveSourcePacks(orgId),
    callOps<{ sources: GbrainSource[] }>('sources.list', {}, { json: true, timeoutMs: 60_000 }),
  ]);
  const packResolved = packResolvedAll.filter((s) => !hidden.has(s.sourceId));
  const spaceRows = await getDb().select({
    sourceId: schema.spaces.sourceId, gitRemote: schema.spaces.gitRemote, owner: schema.spaces.ownerMembershipId,
  }).from(schema.spaces).where(eq(schema.spaces.organizationId, orgId));
  const remotes = new Map(spaceRows.map((r) => [r.sourceId, r.gitRemote]));
  const owners = new Map(spaceRows.map((r) => [r.sourceId, r.owner]));

  // A failed `sources.list` is NOT an empty brain: rows keep `pageCount: null`,
  // never 0, and the payload says the list could not be read.
  const gbrain = listed.ok && listed.json && Array.isArray(listed.json.sources)
    ? listed.json.sources
    : null;
  const byId = new Map((gbrain ?? []).map((s) => [s.id, s]));

  const sources = packResolved.map((s) => {
    const g = byId.get(s.sourceId);
    return {
      sourceId: s.sourceId,
      name: s.name,
      kind: s.kind,
      pack: s.pack,
      tier: s.tier,
      pageTypes: s.pageTypes,
      linkVerbs: s.linkVerbs,
      inherited: s.inherited,
      pageCount: g?.page_count ?? null,
      lastSyncAt: g?.last_sync_at ?? null,
      federated: g?.federated ?? null,
      inGbrain: g !== undefined,
      gitRemote: remotes.get(s.sourceId) ?? null,
      private: owners.get(s.sourceId) != null,
    };
  });

  // Flag the other direction of the mismatch too: a gbrain source with no
  // `spaces` row is invisible to the console unless we name it.
  const known = new Set(packResolvedAll.map((s) => s.sourceId));
  // gbrain's own `default` source never has a `spaces` row, so it is not a
  // mismatch to flag while empty. When it holds pages, those are reported via
  // `builtinDefault` (the console words that specially), not in `unregistered`.
  const builtin = byId.get(GBRAIN_FALLBACK_SOURCE_ID);
  const builtinDefault = builtin && (builtin.page_count ?? 0) > 0 && !known.has(builtin.id)
    ? { pageCount: builtin.page_count as number }
    : null;
  const unregistered = (gbrain ?? [])
    .filter((s) => !known.has(s.id) && !hidden.has(s.id) && s.id !== GBRAIN_FALLBACK_SOURCE_ID)
    .map((s) => s.id);

  return c.json({ sources, unregistered, builtinDefault, sourcesListOk: gbrain !== null });
}));

sourceRoutes.post('/sources', guard('admin', async (c, { userId, orgId }) => {
  await requireCapability(orgId, 'sharedSources');
  const { sourceId, name, description } = await c.req.json();
  // ONE implementation, shared with `/api/wizard/space`, so they cannot drift.
  const result = await addSpaceSource({ userId, orgId }, { sourceId, name, description }, 'source.add');
  if (!result.ok) return c.json(result.body, result.status);
  return c.json({ ok: true, sourceId: result.sourceId, isolationNotice: ISOLATION_NOTICE });
}));

sourceRoutes.patch('/sources/:sourceId', guard('admin', async (c, ctx) => {
  const caller = await callerFor(ctx);
  const { userId, orgId } = caller;
  const sourceId = c.req.param('sourceId') ?? '';
  const space = await spaceFor(orgId, sourceId);
  if (!space || (space.ownerMembershipId !== null && space.ownerMembershipId !== caller.membershipId)) {
    return c.json({ error: `unknown source ${sourceId}` }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return c.json({ error: 'name is required' }, 400);

  // The id is immutable; only the display name moves. A private Space's gbrain
  // name must stay equal to its sourceId (`gbrainSourceName` in privateSpaces.ts;
  // gbrain's `sources_name_key` is unique), so its rename is `spaces.name` only.
  if (space.ownerMembershipId === null) {
    const r = await callOps('sources.rename', { id: sourceId, newName: name }, { timeoutMs: 60_000 });
    if (!r.ok) return c.json({ error: `sources rename failed (exit ${r.exitCode})`, detail: r.stderr }, 400);
  }

  await getDb().update(schema.spaces).set({ name }).where(eq(schema.spaces.id, space.id));
  await audit(orgId, userId, 'source.rename', sourceId, { name });
  return c.json({ ok: true, sourceId, name });
}));

/* Git remote for a Space — logic in `../spaceRemoteOps.ts`, shared with the
 * member's own `/api/my/space/remote`. Admin-only here, and the Space must be
 * visible to the caller (never another member's private Space). */

async function ownedSpace(c: any, ctx: { userId: string; orgId: string; role: Role }) {
  const caller = await callerFor(ctx);
  const sourceId = c.req.param('sourceId') ?? '';
  const space = await spaceFor(caller.orgId, sourceId);
  if (!space || (space.ownerMembershipId !== null && space.ownerMembershipId !== caller.membershipId)) return null;
  return space;
}

const respond = (c: any, r: { status: number; body: object }) => c.json(r.body, r.status);

sourceRoutes.put('/sources/:sourceId/remote', guard('admin', async (c, ctx) => {
  const space = await ownedSpace(c, ctx);
  if (!space) return c.json({ error: `unknown source ${c.req.param('sourceId') ?? ''}` }, 400);
  return respond(c, await connectRemote(ctx, space, await c.req.json().catch(() => ({}))));
}));

sourceRoutes.post('/sources/:sourceId/remote/push', guard('admin', async (c, ctx) => {
  const space = await ownedSpace(c, ctx);
  if (!space) return c.json({ error: `unknown source ${c.req.param('sourceId') ?? ''}` }, 400);
  return respond(c, await pushRemote(ctx, space));
}));

sourceRoutes.delete('/sources/:sourceId/remote', guard('admin', async (c, ctx) => {
  const space = await ownedSpace(c, ctx);
  if (!space) return c.json({ error: `unknown source ${c.req.param('sourceId') ?? ''}` }, 400);
  return respond(c, await disconnectRemote(ctx, space));
}));

sourceRoutes.delete('/sources/:sourceId', guard('admin', async (c, ctx) => {
  const caller = await callerFor(ctx);
  const { userId, orgId } = caller;
  const sourceId = c.req.param('sourceId') ?? '';
  const space = await spaceFor(orgId, sourceId);
  if (!space || (space.ownerMembershipId !== null && space.ownerMembershipId !== caller.membershipId)) {
    return c.json({ error: `unknown source ${sourceId}` }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const mode = typeof body?.mode === 'string' ? body.mode : 'archive';
  if (mode !== 'archive' && mode !== 'remove') {
    return c.json({ error: 'mode must be archive or remove' }, 400);
  }

  // Archive is the DEFAULT and the primary action gbrain's own help recommends
  // ("For most workflows prefer the soft-delete path"): hide from search,
  // preserve data for 72h.
  if (mode === 'archive') {
    const archived = await archiveSpace(space);
    if (!archived.ok) {
      return c.json({ error: `sources archive failed (exit ${archived.exitCode})`, detail: archived.stderr }, 400);
    }
    await audit(orgId, userId, 'source.archive', sourceId, { mode });
    return c.json({ ok: true, mode, sourceId });
  }

  // Remove CASCADES pages, chunks and embeddings. Refuse until the caller
  // explicitly confirms, and hand back the `--dry-run` impact preview so the
  // confirmation is informed. `--dry-run` is passed as an ORDINARY param:
  // `sources.remove` has `supportsDryRun: false` (the generic mechanism appends
  // `--dry-run` too late / only when gbrain declares it), so it must be the
  // op's own `dryRun` flag. MEASURED, docs/archive/schema-pack-findings.md S6 probe 6.
  if (body?.confirm !== true) {
    const preview = await callOps('sources.remove', { id: sourceId, dryRun: true }, { timeoutMs: 120_000 });
    if (!preview.ok) {
      return c.json({
        error: `sources remove dry-run failed (exit ${preview.exitCode})`,
        detail: preview.stderr || preview.stdout,
      }, 400);
    }
    return c.json({
      error: 'confirmation_required',
      mode: 'remove',
      sourceId,
      preview: preview.stdout,
    }, 409);
  }

  // Preview first (captured for the receipt), THEN the destructive call.
  const preview = await callOps('sources.remove', { id: sourceId, dryRun: true }, { timeoutMs: 120_000 });
  const r = await callOps('sources.remove', { id: sourceId, confirmDestructive: true }, { timeoutMs: 300_000 });
  if (!r.ok) {
    return c.json({
      error: `sources remove failed (exit ${r.exitCode})`,
      detail: r.stderr || r.stdout,
      preview: preview.stdout,
    }, 400);
  }

  await dropSourceRow(space.id, sourceId);
  await audit(orgId, userId, 'source.remove', sourceId, { mode });
  return c.json({ ok: true, mode, sourceId, preview: preview.stdout });
}));
