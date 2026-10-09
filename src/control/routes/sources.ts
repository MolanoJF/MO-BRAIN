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
import { grantsFor } from '../grants.ts';
import { inspectRepos } from '../opsClient.ts';
import { canManageSpace, manageableSpace } from '../sourceAccess.ts';
import { isAdminRole } from '../zone.ts';

/**
 * `/api/sources/*` — the unified Sources API. A Space is a gbrain source; this
 * is where a member sees the Sources they can open and manages their own
 * private one, and where an admin adds, renames, archives and removes company
 * Sources. `canManage` says which, per row (`../sourceAccess.ts`).
 *
 * `GET` joins our `spaces` rows with gbrain's live `sources.list` and Task 4's
 * pack resolution, and FLAGS mismatches (a source in one plane but not the
 * other) rather than hiding them. Adding a Source is `admin`-only; the routes
 * that change one answer the same `unknown source` to anyone who may not.
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

sourceRoutes.get('/sources', guard('viewer', async (c, ctx) => {
  const caller = await callerFor(ctx);
  const orgId = caller.orgId;
  const admin = isAdminRole(caller.role);
  const spaceRows = await getDb().select({
    id: schema.spaces.id, sourceId: schema.spaces.sourceId,
    gitRemote: schema.spaces.gitRemote, owner: schema.spaces.ownerMembershipId,
  }).from(schema.spaces).where(eq(schema.spaces.organizationId, orgId));
  // Own private Space; company Spaces for an admin, else only the granted ones.
  const granted = admin ? null : new Set((await grantsFor(orgId, caller.membershipId)).map((g) => g.spaceId));
  const visible = new Set(spaceRows
    .filter((r) => r.owner === null ? granted === null || granted.has(r.id) : r.owner === caller.membershipId)
    .map((r) => r.sourceId));
  const hidden = new Set(spaceRows.filter((r) => !visible.has(r.sourceId)).map((r) => r.sourceId));

  const [packResolvedAll, listed] = await Promise.all([
    resolveSourcePacks(orgId),
    callOps<{ sources: GbrainSource[] }>('sources.list', {}, { json: true, timeoutMs: 60_000 }),
  ]);
  const packResolved = packResolvedAll.filter((s) => visible.has(s.sourceId));
  const remotes = new Map(spaceRows.map((r) => [r.sourceId, r.gitRemote]));
  const owners = new Map(spaceRows.map((r) => [r.sourceId, r.owner]));
  // Drift in the working repo: uncommitted pages the brain cannot see, commits not yet pushed.
  const repoStatus = new Map<string, Awaited<ReturnType<typeof inspectRepos>>[number]>();
  try { for (const r of await inspectRepos()) repoStatus.set(r.sourceId, r); } catch { /* status stays null */ }

  // A failed `sources.list` is NOT an empty brain: rows keep `pageCount: null`,
  // never 0, and the payload says the list could not be read.
  const gbrain = listed.ok && listed.json && Array.isArray(listed.json.sources)
    ? listed.json.sources
    : null;
  const byId = new Map((gbrain ?? []).map((s) => [s.id, s]));

  const sources = packResolved.map((s) => {
    const g = byId.get(s.sourceId);
    const owner = owners.get(s.sourceId) ?? null;
    const repo = remotes.get(s.sourceId) ? repoStatus.get(s.sourceId) : undefined;
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
      gitStatus: repo
        ? { branch: repo.branch, uncommittedFiles: repo.uncommittedFiles, unpushedCommits: repo.unpushedCommits }
        : null,
      private: owner !== null,
      canManage: canManageSpace(caller, { ownerMembershipId: owner }),
    };
  });

  // The drift flags are for the admin who can act on them.
  const known = new Set(packResolvedAll.map((s) => s.sourceId));
  // gbrain's own `default` source never has a `spaces` row, so it is not a
  // mismatch to flag while empty. When it holds pages, those are reported via
  // `builtinDefault` (the console words that specially), not in `unregistered`.
  const builtin = byId.get(GBRAIN_FALLBACK_SOURCE_ID);
  const builtinDefault = admin && builtin && (builtin.page_count ?? 0) > 0 && !known.has(builtin.id)
    ? { pageCount: builtin.page_count as number }
    : null;
  const unregistered = !admin ? [] : (gbrain ?? [])
    .filter((s) => !known.has(s.id) && !hidden.has(s.id) && s.id !== GBRAIN_FALLBACK_SOURCE_ID)
    .map((s) => s.id);

  return c.json({ sources, unregistered, builtinDefault, sourcesListOk: gbrain !== null });
}));

sourceRoutes.post('/sources', guard('admin', async (c, { userId, orgId }) => {
  const { sourceId, name, description } = await c.req.json();
  // ONE implementation, shared with `/api/wizard/space`, so they cannot drift.
  const result = await addSpaceSource({ userId, orgId }, { sourceId, name, description }, 'source.add');
  if (!result.ok) return c.json(result.body, result.status);
  return c.json({ ok: true, sourceId: result.sourceId, isolationNotice: ISOLATION_NOTICE });
}));

sourceRoutes.patch('/sources/:sourceId', guard('viewer', async (c, ctx) => {
  const sourceId = c.req.param('sourceId') ?? '';
  const owned = await manageableSpace(ctx, sourceId);
  if (!owned) return c.json({ error: `unknown source ${sourceId}` }, 400);
  const { space } = owned;
  const { userId, orgId } = ctx;

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
 * member's own `/api/my/space/remote`. The Space must be one the caller may
 * manage (never another member's private Space). */

async function ownedSpace(c: any, ctx: { userId: string; orgId: string; role: Role }) {
  return (await manageableSpace(ctx, c.req.param('sourceId') ?? ''))?.space ?? null;
}

const respond = (c: any, r: { status: number; body: object }) => c.json(r.body, r.status);

sourceRoutes.put('/sources/:sourceId/remote', guard('viewer', async (c, ctx) => {
  const space = await ownedSpace(c, ctx);
  if (!space) return c.json({ error: `unknown source ${c.req.param('sourceId') ?? ''}` }, 400);
  return respond(c, await connectRemote(ctx, space, await c.req.json().catch(() => ({}))));
}));

sourceRoutes.post('/sources/:sourceId/remote/push', guard('viewer', async (c, ctx) => {
  const space = await ownedSpace(c, ctx);
  if (!space) return c.json({ error: `unknown source ${c.req.param('sourceId') ?? ''}` }, 400);
  return respond(c, await pushRemote(ctx, space));
}));

sourceRoutes.delete('/sources/:sourceId/remote', guard('viewer', async (c, ctx) => {
  const space = await ownedSpace(c, ctx);
  if (!space) return c.json({ error: `unknown source ${c.req.param('sourceId') ?? ''}` }, 400);
  return respond(c, await disconnectRemote(ctx, space));
}));

sourceRoutes.delete('/sources/:sourceId', guard('viewer', async (c, ctx) => {
  const { userId, orgId } = ctx;
  const sourceId = c.req.param('sourceId') ?? '';
  const owned = await manageableSpace(ctx, sourceId);
  if (!owned) return c.json({ error: `unknown source ${sourceId}` }, 400);
  const { space } = owned;
  // A private Space is the write target of its owner's agent connection, and
  // `connections.write_space_id` has no ON DELETE: gbrain would archive it and
  // then the row delete would fail. Not retirable from here.
  if (space.ownerMembershipId !== null) return c.json({ error: 'private_space_permanent' }, 409);

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
