/**
 * `/api/spaces/*` — Stage 1's read-only Space Files browse (plan §1.4/§1.6).
 *
 * The Space picker (`GET /api/spaces`) is an ADDITION to the plan's Files
 * routes: the console needs the list of Spaces the caller can reach before it
 * can ask for one's tree. It is the only route here that is not in §1.4.
 *
 * Every route resolves the Space by `(organizationId, sourceId)` FIRST — that
 * pair is uniquely indexed — then asks `spaceAccess` for the caller's grant.
 * A null grant is a 403; `admin`/`owner` yields `write` and is allowed. Ops
 * owns path validation: a traversal or a missing file is a thrown error the
 * guard maps to a 400, and that is the boundary working as designed.
 */
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { syncAndEmbed } from '../../agent/reindex.ts';
import { getDb, schema } from '../db/client.ts';
import { actorIdentity } from '../actor.ts';
import { requireRole, type Role } from '../rbac.ts';
import { accessFromGrants, spaceAccess } from '../spaceAccess.ts';
import { grantsFor } from '../grants.ts';
import { callerFor, canSeeZone } from '../zone.ts';
import { manageableSpace } from '../sourceAccess.ts';
import { callOps, gitExportBundle, gitReadFile, gitTree, gitWriteFile } from '../opsClient.ts';

export const fileRoutes = new Hono();

/** The `runs.ts` wrapper, verbatim: a thrown Response IS the 401/403. */
function errorResponse(e: unknown, fallback: string): Response {
  if (e instanceof Response) return e;
  const status = e && typeof e === 'object' && 'status' in e && typeof e.status === 'number'
    ? e.status
    : 400;
  const message = e instanceof Error ? e.message : fallback;
  return Response.json({ error: message }, { status });
}

const guard = (
  min: Role,
  handler: (c: Context, ctx: { userId: string; orgId: string; role: Role }) => Promise<Response>,
) =>
  async (c: Context) => {
    let ctx: { userId: string; orgId: string; role: Role };
    try { ctx = await requireRole(c, min); } catch (e) { return errorResponse(e, 'unauthorized'); }
    try { return await handler(c, ctx); }
    catch (e) { return errorResponse(e, 'files_error'); }
  };

type SpaceRow = { id: string; sourceId: string; name: string; ownerMembershipId: string | null };

/** The `(organizationId, sourceId)` pair is uniquely indexed, so this is at
 *  most one row — and a Space from another org can never be resolved here. */
async function spaceFor(orgId: string, sourceId: string): Promise<SpaceRow | null> {
  const [space] = await getDb().select({
    id: schema.spaces.id,
    sourceId: schema.spaces.sourceId,
    name: schema.spaces.name,
    ownerMembershipId: schema.spaces.ownerMembershipId,
  }).from(schema.spaces).where(and(
    eq(schema.spaces.organizationId, orgId),
    eq(schema.spaces.sourceId, sourceId),
  ));
  return space ?? null;
}

/** `requireRole` returns only `{userId, orgId, role}`; `spaceAccess` needs the
 *  membership id, and this is the one local resolution of it. */
async function membershipIdFor(userId: string, orgId: string): Promise<string | null> {
  const [m] = await getDb().select({ id: schema.memberships.id }).from(schema.memberships)
    .where(and(
      eq(schema.memberships.userId, userId),
      eq(schema.memberships.organizationId, orgId),
    ));
  return m?.id ?? null;
}

/** The resolve → membership → grant sequence both file routes run. */
async function readGate(
  c: Context,
  ctx: { userId: string; orgId: string; role: Role },
  sourceId: string,
): Promise<{ space: SpaceRow } | { denied: Response }> {
  const space = await spaceFor(ctx.orgId, sourceId);
  if (!space) return { denied: c.json({ error: 'space_not_found' }, 404) };
  const membershipId = await membershipIdFor(ctx.userId, ctx.orgId);
  if (!membershipId) return { denied: c.json({ error: 'forbidden' }, 403) };
  const access = await spaceAccess(ctx.orgId, membershipId, ctx.role, space.id);
  if (access === null) return { denied: c.json({ error: 'forbidden' }, 403) };
  return { space };
}

// S1 §1.6 — the Space picker. Only Spaces the caller can actually open are
// returned, each with the same `access` the file routes will enforce.
fileRoutes.get('/spaces', guard('viewer', async (c, ctx) => {
  const spaces = await getDb().select({
    id: schema.spaces.id,
    sourceId: schema.spaces.sourceId,
    name: schema.spaces.name,
    ownerMembershipId: schema.spaces.ownerMembershipId,
  }).from(schema.spaces).where(eq(schema.spaces.organizationId, ctx.orgId));

  const membershipId = await membershipIdFor(ctx.userId, ctx.orgId);
  if (!membershipId) return c.json({ error: 'forbidden' }, 403);
  const grants = await grantsFor(ctx.orgId, membershipId);

  const visible = spaces.flatMap((space) => {
    const access = accessFromGrants(ctx.role, grants, space.id, space.ownerMembershipId, membershipId);
    return access === null ? [] : [{
      ...space, access, zone: space.ownerMembershipId === null ? 'company' as const : 'personal' as const,
    }];
  });
  return c.json({ spaces: visible });
}));

fileRoutes.get('/spaces/:sourceId/files', guard('viewer', async (c, ctx) => {
  const sourceId = c.req.param('sourceId') ?? '';
  const gate = await readGate(c, ctx, sourceId);
  if ('denied' in gate) return gate.denied;
  return c.json(await gitTree(gate.space.sourceId));
}));

// The export — the full git repo (every ref, every commit) as a `.bundle` a
// member can `git clone` locally and later push to a remote of their own.
// Whoever may MANAGE the Space (`canManageSpace`): its owner for a private
// Space, an admin for a company one. A bundle hands over the whole history at
// once, including anything a since-deleted page's commits still carry, so this
// is stricter than the read-only browse above rather than reusing `readGate`.
// Someone else's personal Space is the same 404 as a missing Space.
fileRoutes.get('/spaces/:sourceId/export', guard('viewer', async (c, ctx) => {
  const sourceId = c.req.param('sourceId') ?? '';
  const space = (await manageableSpace(ctx, sourceId))?.space;
  if (!space) return c.json({ error: 'space_not_found' }, 404);

  const upstream = await gitExportBundle(space.sourceId);
  if (!upstream.ok) {
    const payload = await upstream.json().catch(() => ({})) as { error?: string };
    return c.json({ error: payload.error ?? 'export_failed' }, 400);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(upstream.body, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${space.sourceId}-${stamp}.bundle"`,
    },
  });
}));

// Hono 4.13.8 does NOT expose a bare `*` segment through `c.req.param('*')` — a
// wildcard route with `:sourceId` in it captures only the named params, so the
// named-regex param `:path{.*}` is the form that actually carries the file path.
fileRoutes.get('/spaces/:sourceId/files/:path{.*}', guard('viewer', async (c, ctx) => {
  const sourceId = c.req.param('sourceId') ?? '';
  const path = c.req.param('path') ?? '';
  if (!path) return c.json({ error: 'path_required' }, 400);
  const gate = await readGate(c, ctx, sourceId);
  if ('denied' in gate) return gate.denied;
  return c.json(await gitReadFile(gate.space.sourceId, path));
}));

// S2 §2.3 — the write path. `member`, NOT `viewer`: a viewer can only ever
// read, and the Space grant must be `write` (a read Connection is a 403). An
// admin/owner resolves to `write` from the role alone, which is the explicit
// bypass the response and audit carry rather than hide.
fileRoutes.put('/spaces/:sourceId/files/:path{.*}', guard('member', async (c, ctx) => {
  const sourceId = c.req.param('sourceId') ?? '';
  const path = c.req.param('path') ?? '';
  if (!path) return c.json({ error: 'path_required' }, 400);

  const body = await c.req.json().catch(() => null) as
    { content?: unknown; expectedSha?: unknown; message?: unknown } | null;
  if (!body || typeof body.content !== 'string'
    || typeof body.expectedSha !== 'string' || body.expectedSha === '') {
    return c.json({ error: 'content and expectedSha are required' }, 400);
  }
  const content = body.content;
  const expectedSha = body.expectedSha;
  const message = typeof body.message === 'string' && body.message ? body.message : `edit ${path}`;

  // 1. The `(organizationId, sourceId)` resolve: a Space from another org can
  //    never be reached here.
  const space = await spaceFor(ctx.orgId, sourceId);
  if (!space) return c.json({ error: 'space_not_found' }, 404);

  // 2. The member's grant for THIS Space. `null` or `read` is a 403 — the
  //    read-only Connection cannot write through the console.
  const membershipId = await membershipIdFor(ctx.userId, ctx.orgId);
  if (!membershipId) return c.json({ error: 'forbidden' }, 403);
  const access = await spaceAccess(ctx.orgId, membershipId, ctx.role, space.id);
  if (access !== 'write') return c.json({ error: 'forbidden' }, 403);

  // 6. `bypass` is the admin/owner reaching a Space their GRANTS do not
  //    grant write to. The viewer-role derivation isolates the grant half
  //    (a viewer never gets the role-based write), so `!grantWrite` means the
  //    role alone opened the door — the explicit bypass, not a silent one.
  const grants = await grantsFor(ctx.orgId, membershipId);
  const grantWrite = accessFromGrants(
    'viewer', grants, space.id, space.ownerMembershipId, membershipId,
  ) === 'write';
  const bypass = (ctx.role === 'admin' || ctx.role === 'owner') && !grantWrite;

  // 3. The commit identity is the session's user, never a request body.
  const actor = await actorIdentity(ctx.userId);

  // 4. Read-compare-write-commit under one repo lock, ops-side.
  const result = await gitWriteFile({
    sourceId: space.sourceId, path, content, expectedSha, actor, message,
  });

  // The stale outcome is a RESULT the console renders as a choice, not a
  // thrown error: nothing was written, and the current sha is the reload option.
  if (!result.committed) {
    return c.json({ committed: false, error: 'stale', sha: result.sha, bypass });
  }

  // 5. The brain must move, or this route must not report a write. The commit
  //    already landed, so the thrown message says exactly that — honesty rule 7.
  const index = await syncAndEmbed(space.sourceId, { callOps });
  const embed = index.embed;
  if (index.sync.classification !== 'ok' || embed === null || embed.classification !== 'ok') {
    const failing = embed ?? index.sync;
    throw new Error(
      `space file commit ${result.sha} landed for ${space.sourceId}:${path} but the brain index did not move: `
      + `${failing.argv.join(' ')} exited ${failing.exitCode} (${failing.classification}) `
      + `${failing.stderr.trim()}. Honesty rule 7: a written file the brain never imported is not written.`,
    );
  }

  // 7. S3c: before/after are REDACTED summaries — SHAs and a byte COUNT only.
  //    The file's content never reaches the audit row.
  await getDb().insert(schema.auditLog).values({
    id: randomUUID(),
    organizationId: ctx.orgId,
    actor: ctx.userId,
    action: 'space.file.write',
    target: `${space.sourceId}:${path}`,
    before: { sha: expectedSha },
    after: { sha: result.sha, bytes: Buffer.byteLength(content, 'utf8'), bypass },
  });

  // 8. The whole receipt, so the console can render the commit and the index.
  return c.json({
    committed: true,
    sha: result.sha,
    bypass,
    index: { sync: index.sync, embed: index.embed },
  });
}));
