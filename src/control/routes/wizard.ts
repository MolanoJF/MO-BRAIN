import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { requireAdmin } from './auth.ts';
import { storeSecret } from '../secrets.ts';
import { callOps, patchFilePlaneConfig, seedSpace, resetBrainSchema, putSchemaPackJson, pauseBrainWriters, resumeBrainWriters } from '../opsClient.ts';
import { provisionPrivateSpace, privateSpaceSourceId, gbrainSourceName } from '../privateSpaces.ts';
import { canAdvance, nextStep, SEARCH_MODES, LIFECYCLE_ORDER } from '../lifecycle.ts';
import type { Lifecycle } from '../lifecycle.ts';
import { OPERATIONS } from '../../contracts/registry.ts';
import { parseSchemaActiveProse } from '../../contracts/capability.ts';
import { resolveSourcePacks, effectivePack, validationError, lint } from './schema.ts';
import { scaffoldSpaces, type ScaffoldResult } from '../scaffold.ts';
import { validateDraft, draftToManifest } from '../schemaDraft.ts';
import { requireCapability } from '../capabilities.ts';
import { visiblePackNames } from '../../contracts/packs.ts';

/**
 * Json flag for wizard `/finish` callOps. Only request --json when the
 * contract supports it — blanket `json: true` hard-fails init and config.set
 * (supportsJson: false) inside buildArgv / ops RPC.
 */
export function finishCallOpts(op: string): { json?: boolean } {
  const spec = OPERATIONS[op];
  if (!spec) throw new Error(`unknown finish operation ${op}`);
  return spec.supportsJson ? { json: true } : {};
}

export const wizard = new Hono();

/**
 * Space = source is a hard rule. There is no "folders within a Space have
 * different access": folder isolation is convention the agent polices itself,
 * so the moment someone puts HR docs in hr/ inside the company Space, every
 * member with read on that Space retrieves them via semantic search.
 */
export const ISOLATION_NOTICE =
  'A Source is a whole gbrain source. Folders inside it are NOT access boundaries — ' +
  'every member with read on that Source can retrieve everything in it via semantic search. ' +
  'If something needs isolation, it needs its own Source.';

export const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

async function loadBrain(orgId: string) {
  const [brain] = await getDb().select().from(schema.brains)
    .where(eq(schema.brains.organizationId, orgId));
  if (!brain) throw new Error('no brain for organization');
  return brain;
}

async function advance(brainId: string, from: Lifecycle, to: Lifecycle, patch: Record<string, unknown> = {}) {
  if (!canAdvance(from, to)) {
    throw Object.assign(new Error(`cannot advance from ${from} to ${to}`), { status: 409 });
  }
  await getDb().update(schema.brains)
    .set({ ...patch, lifecycle: to, updatedAt: new Date() })
    .where(eq(schema.brains.id, brainId));
}

async function audit(orgId: string, actor: string, action: string, target: string, after: unknown) {
  // S3c: `after` is a redacted summary — never a raw request body.
  await getDb().insert(schema.auditLog)
    .values({ id: randomUUID(), organizationId: orgId, actor, action, target, before: null, after: after as object });
}

function redactStepStderr(stderr: string): string {
  return stderr
    .replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/gi, '$1[redacted]@')
    .slice(-500);
}

const guard = (handler: (c: any, ctx: { userId: string; orgId: string }) => Promise<Response>) =>
  async (c: any) => {
    let ctx;
    try { ctx = await requireAdmin(c); } catch (r) { return r as Response; }
    try { return await handler(c, ctx); }
    catch (e: any) { return c.json({ error: e?.message ?? 'wizard_error' }, e?.status ?? 400); }
  };

wizard.get('/state', guard(async (c, { orgId }) => {
  const brain = await loadBrain(orgId);
  const spaces = await getDb().select().from(schema.spaces)
    .where(eq(schema.spaces.organizationId, orgId));
  return c.json({
    lifecycle: brain.lifecycle,
    order: LIFECYCLE_ORDER,
    nextStep: nextStep(brain.lifecycle as Lifecycle),
    searchModes: SEARCH_MODES,
    searchMode: brain.searchMode,
    embeddingModel: brain.embeddingModel,
    schemaPack: brain.schemaPack,
    spaces: spaces.map((s) => ({ sourceId: s.sourceId, name: s.name, kind: s.kind })),
    isolationNotice: ISOLATION_NOTICE,
  });
}));

/**
 * Step 1 — provider key. Two destinations, neither of them gbrain's DB plane
 * (V11): our encrypted secrets table (source of truth) and the file plane
 * (what gbrain actually reads), written under the advisory lock (S3).
 *
 * Slice 0 finding carried forward (docs/slice-0-findings.md V3/V11,
 * Work Item A, 2026-09-15): Slice 0 confirmed `gbrain config set
 * <vendor>_api_key` itself avoids the DB plane, and this route's design
 * (write the key here, BEFORE `/finish` ever calls `init`) is the right
 * shape — it is what makes headless `init` resolvable without Slice 0's
 * own env-var passthrough shortcut (which is Slice-0-only and must not be
 * copied into this compose). One assumption is still UNVERIFIED, though:
 * Slice 0 only validated gbrain's own `config set` CLI path — it never
 * validated that `patchFilePlaneConfig`'s direct file write lands in the
 * same file, in the same format, that `gbrain init`/`gbrain config show`
 * actually read. Before relying on this in Task 9's tests, add a
 * round-trip check: call this route, then `gbrain config show` inside
 * gbrain-ops, and confirm the key name actually appears.
 */
wizard.post('/provider', guard(async (c, { userId, orgId }) => {
  const { provider, apiKey, embeddingModel } = await c.req.json();
  if (!provider || !apiKey || !embeddingModel) {
    return c.json({ error: 'provider, apiKey and embeddingModel are required' }, 400);
  }
  const brain = await loadBrain(orgId);
  const keyName = `${provider}_api_key`;

  await storeSecret(orgId, keyName, apiKey);
  await patchFilePlaneConfig({ [keyName]: apiKey });
  await advance(brain.id, brain.lifecycle as Lifecycle, 'provider-configured', { embeddingModel });
  await audit(orgId, userId, 'wizard.provider', keyName, { provider, embeddingModel });

  // Never echo the key.
  return c.json({ ok: true, lifecycle: 'provider-configured', keyName });
}));

/**
 * Step 2 — the one mandatory human decision (V4).
 *
 * Spec P6: bootstrap stores `mobrain-personal`, so when a pack is already
 * stored this step also passes `schema-selected` — the Schema step no longer
 * exists for a fresh install. A legacy brain with no stored pack stops at
 * `mode-selected` and the console still renders the Schema step for it.
 */
wizard.post('/search-mode', guard(async (c, { userId, orgId }) => {
  const { mode } = await c.req.json();
  if (!SEARCH_MODES.some((m) => m.id === mode)) return c.json({ error: `unknown search mode ${mode}` }, 400);

  const brain = await loadBrain(orgId);
  await advance(brain.id, brain.lifecycle as Lifecycle, 'mode-selected', { searchMode: mode });
  let lifecycle: Lifecycle = 'mode-selected';
  if (brain.schemaPack) {
    await advance(brain.id, 'mode-selected', 'schema-selected');
    lifecycle = 'schema-selected';
  }
  await audit(orgId, userId, 'wizard.searchMode', brain.id, { mode, schemaPack: brain.schemaPack ?? null });
  return c.json({ ok: true, lifecycle, mode });
}));

/**
 * Step 3 — schema pack, rendered from `gbrain schema list`.
 *
 * Slice 0 finding carried forward (docs/slice-0-findings.md V2, Work Item K,
 * 2026-09-15): `schema list` accepts `--json` on the command line without
 * erroring, but silently IGNORES it and always prints human prose —
 * `runList()`'s own handler never reads its argument. Slice 0's registry
 * marks this operation `supportsJson: false`, so requesting `{ json: true }`
 * as originally drafted here either throws inside the exec layer's
 * `buildArgv` ("schema.list does not support --json") or, if gbrain-ops's
 * RPC server swallows that into a non-throwing response, silently yields
 * `json: null` — an empty pack list shown to the user with no visible
 * error. Fixed: call it WITHOUT `json`, and parse the stable
 * `Bundled packs:` prose block the same way Slice 0's own
 * `parseSchemaPacksProse()` (src/contracts/capability.ts) already does.
 */
/**
 * Every pack gbrain will accept: bundled plus user-installed. Prose-parsed
 * because `schema list` ignores `--json` (Work Item K) — asking for it throws
 * in buildArgv. Both the wizard step and the Schema admin page validate
 * against this, so an unknown name is refused before it reaches gbrain.
 */
export async function listSchemaPackSections(): Promise<{ bundled: string[]; installed: string[] }> {
  const r = await callOps<never>('schema.list', {}, { timeoutMs: 60_000 });
  const bundled: string[] = [];
  const installed: string[] = [];
  let section: 'none' | 'bundled' | 'installed' = 'none';
  for (const line of (r.stdout ?? '').split('\n')) {
    if (/^\s*Bundled packs:\s*$/.test(line)) { section = 'bundled'; continue; }
    if (/^\s*Installed packs\b/.test(line)) { section = 'installed'; continue; }
    if (section === 'none') continue;
    const t = line.trim();
    // A blank line ends a block; the "No user-installed packs" sentence is
    // prose, not a pack name.
    if (t === '') { section = 'none'; continue; }
    if (/^No user-installed packs/.test(t)) { section = 'none'; continue; }
    (section === 'bundled' ? bundled : installed).push(t);
  }
  return { bundled, installed };
}

/** Every known pack, bundled first. Kept as the concatenation of the two
 *  sections so existing callers are unchanged. */
export async function listSchemaPacks(): Promise<string[]> {
  const { bundled, installed } = await listSchemaPackSections();
  return [...bundled, ...installed];
}

wizard.get('/schema-packs', guard(async (c) => {
  return c.json({ packs: visiblePackNames(await listSchemaPacks(), null) });
}));

/**
 * Step 3 — schema pack.
 *
 * The pack is PERSISTED here and APPLIED at /finish via
 * `gbrain init --schema-pack`. It deliberately is not applied here: at this
 * point in the wizard the brain has not been init'd, and `init` writes
 * config.json's `schema_pack` itself (gbrain's own init default is still
 * `gbrain-base-v2`, which is why Mobrain always passes the pack explicitly —
 * it stores `mobrain-personal`), so a pre-init write would simply be stamped
 * over. See
 * docs/schema-pack-findings.md S2.
 *
 * Validated against gbrain's own pack list rather than a hardcoded set, so a
 * user-installed pack is selectable the moment it is on disk.
 */
wizard.post('/schema', guard(async (c, { userId, orgId }) => {
  const body = await c.req.json().catch(() => ({}));

  // Branch A (gated on S7 probe 7): a brand-new brain can start on a pack the
  // admin designs right here, because gbrain's validate / lint / show are all
  // DB-free and answer before `init` runs. The draft is front-gated by our own
  // `validateDraft`, written once as `pack.json` through the file plane, then
  // gbrain's own validate + lint are the authority — the same gate every other
  // write path runs. Only a clean pack is stored and allowed to advance.
  if (body?.draft !== undefined) {
    const v = validateDraft(body.draft);
    if (!v.ok) return c.json({ error: 'invalid draft', errors: v.errors }, 400);
    const name = v.draft.name;

    const known = await listSchemaPacks();
    if (known.includes(name)) return c.json({ error: `${name} already exists`, packs: known }, 409);
    if (v.draft.extends && !known.includes(v.draft.extends)) {
      return c.json({ error: `unknown parent pack ${v.draft.extends}`, packs: known }, 400);
    }

    const brain = await loadBrain(orgId);
    await putSchemaPackJson(name, draftToManifest(v.draft, brain.gbrainVersion ?? '0.50.5.0'));

    const invalid = await validationError(name);
    const report = invalid ? null : await lint(name, false);
    if (invalid || !report?.ok) {
      // Created, not activated. The pack stays on disk so the admin can fix it,
      // but the wizard does NOT advance and nothing is stored — /finish can
      // never be handed a pack gbrain refused. Never a green.
      await audit(orgId, userId, 'wizard.schema.draft', name, {
        name, valid: invalid === null, lint: report?.ok ?? false,
      });
      return c.json({ ok: false, name, error: invalid ?? 'pack lint failed', lint: report });
    }

    await advance(brain.id, brain.lifecycle as Lifecycle, 'schema-selected', { schemaPack: name });
    await audit(orgId, userId, 'wizard.schema', name, { pack: name, mode: 'draft' });
    return c.json({ ok: true, lifecycle: 'schema-selected', pack: name, name, error: null, lint: report });
  }

  const { pack } = body;
  if (!pack || typeof pack !== 'string') return c.json({ error: 'pack is required' }, 400);

  const known = await listSchemaPacks();
  if (!known.includes(pack)) {
    return c.json({ error: `unknown schema pack ${pack}`, packs: known }, 400);
  }

  const brain = await loadBrain(orgId);
  await advance(brain.id, brain.lifecycle as Lifecycle, 'schema-selected', { schemaPack: pack });
  await audit(orgId, userId, 'wizard.schema', pack, { pack });
  return c.json({ ok: true, lifecycle: 'schema-selected', pack });
}));

/** The shared Space-creation result. `body` is the exact refusal shape the
 *  wizard has always returned, so both callers render the same conflict. */
export type AddSpaceResult =
  | { ok: true; sourceId: string; scaffold?: ScaffoldResult[] }
  | { ok: false; status: 400 | 409; body: Record<string, unknown> };

/**
 * Create one Space = one gbrain source: seed the git repo, `sources.add`,
 * record the `spaces` row, advance the lifecycle, audit.
 *
 * LIFTED VERBATIM from the wizard's `/space` step so the wizard and the
 * Sources admin page cannot drift. The ordering below is load-bearing:
 *
 *  - Ruling 1: seed a committed git repo BEFORE sources.add (V12 / Work Item D).
 *  - Drop json: true — sources add does not support --json (Work Item N).
 *  - --federated: a Space is the brain's own corpus, so an UNQUALIFIED read must
 *    span it. Left unset, gbrain's inclusion check (`isSourceFederated`, literal
 *    true) treats the source as isolated, and the sole-non-default resolver tier
 *    only rescues a single-Space brain — with 2+ Spaces the anchor falls back to
 *    'default' and `gbrain search` (no --source) sees no Space at all.
 *
 * `auditAction` is a parameter because the two callers are different events
 * ('wizard.space' vs 'source.add'); everything else is identical.
 */
export async function addSpaceSource(
  { userId, orgId }: { userId: string; orgId: string },
  { sourceId, name, description, ownerMembershipId }:
    { sourceId?: string; name?: string; description?: string; ownerMembershipId?: string },
  auditAction = 'wizard.space',
): Promise<AddSpaceResult> {
  if (!sourceId || !SOURCE_ID.test(sourceId)) {
    return { ok: false, status: 400, body: { error: 'sourceId must be lowercase letters, digits and hyphens' } };
  }

  const [dup] = await getDb().select().from(schema.spaces)
    .where(and(eq(schema.spaces.organizationId, orgId), eq(schema.spaces.sourceId, sourceId)));
  if (dup) {
    return { ok: false, status: 409, body: { error: `${sourceId} is already a Source`, isolationNotice: ISOLATION_NOTICE } };
  }

  const brain = await loadBrain(orgId);
  const localPath = `/srv/brain-repos/${sourceId}`;

  await seedSpace(sourceId);
  const r = await callOps('sources.add', {
    id: sourceId, path: localPath,
    name: gbrainSourceName({ sourceId, name, ownerMembershipId }), federated: true,
  }, { timeoutMs: 300_000 });
  if (!r.ok) return { ok: false, status: 400, body: { error: `sources add failed (exit ${r.exitCode})`, detail: r.stderr } };

  await getDb().insert(schema.spaces).values({
    id: randomUUID(), organizationId: orgId, sourceId,
    name: name ?? sourceId, description: description ?? null,
    kind: 'local-git', localPath,
    ...(ownerMembershipId ? { ownerMembershipId } : {}),
  });
  // The wizard advances from `schema-selected`. The Sources admin page adds to
  // an already-`ready` brain, where `sources-added` is a STEP BACKWARD that
  // `canAdvance` refuses — skip it there rather than throw 409 at an admin
  // doing exactly what the page offers. `canAdvance(from, from)` is true, so
  // the wizard's idempotent retry is preserved.
  if (canAdvance(brain.lifecycle as Lifecycle, 'sources-added')) {
    await advance(brain.id, brain.lifecycle as Lifecycle, 'sources-added');
  }
  await audit(orgId, userId, auditAction, sourceId, {
    sourceId, kind: 'local-git',
    ...(ownerMembershipId ? { ownerMembershipId } : {}),
  });

  // A Space added to an already-ready brain gets its folders right away, from
  // the pack THAT Space resolves. During the wizard the brain is not ready yet
  // and `/finish` scaffolds once, after every sources.add, so doing it here
  // would be premature and duplicate.
  const scaffold = brain.lifecycle === 'ready'
    ? await scaffoldSpaces(orgId, userId, {
        resolveSourcePacks, effectivePack: (p) => effectivePack(brain.gbrainVersion ?? '', p),
      }, [sourceId])
    : undefined;

  return { ok: true, sourceId, ...(scaffold ? { scaffold } : {}) };
}

/** Step 4 — the first Space. One gbrain source, git-backed, created via the CLI lane. */
wizard.post('/space', guard(async (c, { userId, orgId }) => {
  await requireCapability(orgId, 'sharedSources');
  const { sourceId, name, description } = await c.req.json();
  const result = await addSpaceSource({ userId, orgId }, { sourceId, name, description });
  if (!result.ok) return c.json(result.body, result.status);

  return c.json({ ok: true, lifecycle: 'sources-added', sourceId: result.sourceId, isolationNotice: ISOLATION_NOTICE });
}));

/**
 * Step 4 (fresh install) — the signed-in member's own private Space. A new
 * brain starts with exactly one source, and it is this one; shared Spaces are
 * added later from the Sources page. No Connection is created here — `/finish`
 * provisions it, once the brain is real.
 */
wizard.post('/private-space', guard(async (c, { userId, orgId }) => {
  const [membership] = await getDb().select({ id: schema.memberships.id }).from(schema.memberships)
    .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.organizationId, orgId)));
  if (!membership) return c.json({ error: 'not a member' }, 403);

  const sourceId = privateSpaceSourceId(membership.id);
  const [space] = await getDb().select().from(schema.spaces).where(and(
    eq(schema.spaces.organizationId, orgId),
    eq(schema.spaces.sourceId, sourceId),
  ));

  if (space) {
    if (space.ownerMembershipId !== membership.id) {
      return c.json({ error: `${sourceId} is already a Space owned by another member` }, 409);
    }
    const brain = await loadBrain(orgId);
    if (canAdvance(brain.lifecycle as Lifecycle, 'sources-added')) {
      await advance(brain.id, brain.lifecycle as Lifecycle, 'sources-added');
    }
    return c.json({ ok: true, lifecycle: 'sources-added', sourceId });
  }

  const result = await addSpaceSource(
    { userId, orgId },
    { sourceId, name: 'My Space', ownerMembershipId: membership.id },
    'wizard.privateSpace',
  );
  if (!result.ok) return c.json(result.body, result.status);
  return c.json({ ok: true, lifecycle: 'sources-added', sourceId: result.sourceId });
}));

/** Step 5 — init, config, sync, doctor. The brain becomes real here. */
wizard.post('/finish', guard(async (c, { userId, orgId }) => {
  const brain = await loadBrain(orgId);
  if (brain.lifecycle !== 'sources-added') {
    return c.json({ error: `cannot finish from ${brain.lifecycle}` }, 409);
  }

  const steps: { id: string; ok: boolean; exitCode: number; stderr?: string }[] = [];
  const run = async (id: string, op: string, params: Record<string, unknown>, timeoutMs = 900_000) => {
    const r = await callOps(op, params, { ...finishCallOpts(op), timeoutMs });
    steps.push({
      id, ok: r.ok, exitCode: r.exitCode,
      ...(r.ok ? {} : { stderr: redactStepStderr(r.stderr ?? '') }),
    });
    return r;
  };

  // Serve and the worker cold-start vector(1280) on any reconnect. The pause
  // file keeps their entrypoint from starting gbrain until init has created
  // the 1536-d schema. A failed init leaves the pause in place so a retry
  // cannot race a half-written config.json.
  try {
    await pauseBrainWriters();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return c.json({ error: message }, 503);
  }
  await resetBrainSchema();
  const initResult = await run('init', 'init', {
    nonInteractive: true,
    force: true,
    embeddingModel: brain.embeddingModel ?? 'openai:text-embedding-3-small',
    // Undocumented but allowlisted (see the registry entry). Omitted entirely
    // when unset so init falls back to its own gbrain-base-v2 default rather
    // than being handed an empty pack name.
    ...(brain.schemaPack ? { schemaPack: brain.schemaPack } : {}),
  });
  if (initResult.ok) await resumeBrainWriters();
  // resetBrainSchema wiped gbrain's sources table; re-register Spaces we already
  // recorded in the control DB during /space (git repos on disk survive).
  // --federated again: this IS the row that survives, so the flag must be set
  // here too (see /space for why an unset flag hides every Space from an
  // unqualified read on a multi-Space brain).
  const spaces = await getDb().select().from(schema.spaces)
    .where(eq(schema.spaces.organizationId, orgId));
  for (const s of spaces) {
    await run(`sources.add:${s.sourceId}`, 'sources.add', {
      id: s.sourceId, path: s.localPath ?? `/srv/brain-repos/${s.sourceId}`, name: gbrainSourceName(s),
      federated: true,
    }, 300_000);
  }
  // The chosen pack's folders, one README per page type, before the first
  // sync so a teammate's first page lands in a folder that already explains
  // itself. README.md is a gbrain metafile, so sync never imports it (S7).
  // A scaffold failure is reported, never fatal: the brain is still usable.
  const scaffold = await scaffoldSpaces(orgId, userId, {
    resolveSourcePacks, effectivePack: (p) => effectivePack(brain.gbrainVersion ?? '', p),
  }).catch((e) => [{ sourceId: '*', pack: null, created: [], skipped: [], error: String(e?.message ?? e) }]);
  if (brain.searchMode) await run('search-mode', 'config.set', { key: 'search.mode', value: brain.searchMode });
  await run('sync', 'sync', { all: true });
  await run('embed', 'embed', { stale: true });

  const doctor = await run('doctor', 'doctor', {});

  // Honesty: report the pack the engine actually RESOLVED, not the one we
  // asked for. A brain-DB-plane schema_pack (tier 4) outranks the
  // config.json value init writes (tier 6), so these can legitimately differ.
  const activeRaw = await callOps<never>('schema.active', {}, { timeoutMs: 60_000 });
  const active = parseSchemaActiveProse(activeRaw.stdout ?? '');

  const ok = steps.every((s) => s.ok);
  if (ok) await advance(brain.id, 'sources-added', 'ready');
  await audit(orgId, userId, 'wizard.finish', brain.id, {
    steps,
    doctorExit: doctor.exitCode,
    schemaPackRequested: brain.schemaPack ?? null,
    schemaPackResolved: active.pack,
    schemaPackSource: active.source,
  });

  if (ok) {
    try {
      const [membership] = await getDb().select({ id: schema.memberships.id }).from(schema.memberships)
        .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.organizationId, orgId)));
      if (membership) {
        const [owned] = await getDb().select({ id: schema.spaces.id }).from(schema.spaces).where(and(
          eq(schema.spaces.organizationId, orgId),
          eq(schema.spaces.ownerMembershipId, membership.id),
        ));
        if (owned) await provisionPrivateSpace(orgId, membership.id, userId);
      }
    } catch { /* never let this change ok or the response */ }
  }

  return c.json({
    ok, lifecycle: ok ? 'ready' : brain.lifecycle, steps,
    schemaPack: { requested: brain.schemaPack ?? null, resolved: active.pack, source: active.source },
    scaffold,
  }, ok ? 200 : 500);
}));
