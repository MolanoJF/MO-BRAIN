import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { requireAdmin } from './auth.ts';
import { storeSecret } from '../secrets.ts';
import { callOps, patchFilePlaneConfig, seedSpace } from '../opsClient.ts';
import { canAdvance, nextStep, SEARCH_MODES, LIFECYCLE_ORDER } from '../lifecycle.ts';
import type { Lifecycle } from '../lifecycle.ts';

export const wizard = new Hono();

/**
 * Space = source is a hard rule. There is no "folders within a Space have
 * different access": folder isolation is convention the agent polices itself,
 * so the moment someone puts HR docs in hr/ inside the company Space, every
 * member with read on that Space retrieves them via semantic search.
 */
const ISOLATION_NOTICE =
  'A Space is a whole gbrain source. Folders inside it are NOT access boundaries — ' +
  'every member with read on that Space can retrieve everything in it via semantic search. ' +
  'If something needs isolation, it needs its own Space.';

const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

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

/** Step 2 — the one mandatory human decision (V4). */
wizard.post('/search-mode', guard(async (c, { userId, orgId }) => {
  const { mode } = await c.req.json();
  if (!SEARCH_MODES.some((m) => m.id === mode)) return c.json({ error: `unknown search mode ${mode}` }, 400);

  const brain = await loadBrain(orgId);
  await advance(brain.id, brain.lifecycle as Lifecycle, 'mode-selected', { searchMode: mode });
  await audit(orgId, userId, 'wizard.searchMode', brain.id, { mode });
  return c.json({ ok: true, lifecycle: 'mode-selected', mode });
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
wizard.get('/schema-packs', guard(async (c) => {
  const r = await callOps<never>('schema.list', {}, { timeoutMs: 60_000 });
  const bundled: string[] = [];
  let inBundled = false;
  for (const line of (r.stdout ?? '').split('\n')) {
    if (/^\s*Bundled packs:\s*$/.test(line)) { inBundled = true; continue; }
    if (!inBundled) continue;
    const t = line.trim();
    if (t === '') break;
    bundled.push(t);
  }
  return c.json({ packs: bundled });
}));

wizard.post('/schema', guard(async (c, { userId, orgId }) => {
  const { pack } = await c.req.json();
  if (!pack || typeof pack !== 'string') return c.json({ error: 'pack is required' }, 400);

  const brain = await loadBrain(orgId);
  await advance(brain.id, brain.lifecycle as Lifecycle, 'schema-selected');
  await audit(orgId, userId, 'wizard.schema', pack, { pack });
  return c.json({ ok: true, lifecycle: 'schema-selected', pack });
}));

/** Step 4 — the first Space. One gbrain source, git-backed, created via the CLI lane. */
wizard.post('/space', guard(async (c, { userId, orgId }) => {
  const { sourceId, name, description } = await c.req.json();
  if (!sourceId || !SOURCE_ID.test(sourceId)) {
    return c.json({ error: 'sourceId must be lowercase letters, digits and hyphens' }, 400);
  }

  const [dup] = await getDb().select().from(schema.spaces)
    .where(and(eq(schema.spaces.organizationId, orgId), eq(schema.spaces.sourceId, sourceId)));
  if (dup) return c.json({ error: `${sourceId} is already a Space`, isolationNotice: ISOLATION_NOTICE }, 409);

  const brain = await loadBrain(orgId);
  const localPath = `/srv/brain-repos/${sourceId}`;

  // Ruling 1: seed a committed git repo BEFORE sources.add (V12 / Work Item D).
  // Drop json: true — sources add does not support --json (Work Item N).
  await seedSpace(sourceId);
  const r = await callOps('sources.add', {
    id: sourceId, path: localPath, name: name ?? sourceId,
  }, { timeoutMs: 300_000 });
  if (!r.ok) return c.json({ error: `sources add failed (exit ${r.exitCode})`, detail: r.stderr }, 400);

  await getDb().insert(schema.spaces).values({
    id: randomUUID(), organizationId: orgId, sourceId,
    name: name ?? sourceId, description: description ?? null,
    kind: 'local-git', localPath,
  });
  await advance(brain.id, brain.lifecycle as Lifecycle, 'sources-added');
  await audit(orgId, userId, 'wizard.space', sourceId, { sourceId, kind: 'local-git' });

  return c.json({ ok: true, lifecycle: 'sources-added', sourceId, isolationNotice: ISOLATION_NOTICE });
}));

/** Step 5 — init, config, sync, doctor. The brain becomes real here. */
wizard.post('/finish', guard(async (c, { userId, orgId }) => {
  const brain = await loadBrain(orgId);
  if (brain.lifecycle !== 'sources-added') {
    return c.json({ error: `cannot finish from ${brain.lifecycle}` }, 409);
  }

  const steps: { id: string; ok: boolean; exitCode: number }[] = [];
  const run = async (id: string, op: string, params: Record<string, unknown>, timeoutMs = 900_000) => {
    const r = await callOps(op, params, { json: true, timeoutMs });
    steps.push({ id, ok: r.ok, exitCode: r.exitCode });
    return r;
  };

  // GBRAIN_DATABASE_URL is already in the ops container's environment, so the
  // connection string never passes through the control plane (S2, V3).
  await run('init', 'init', {
    nonInteractive: true, embeddingModel: brain.embeddingModel ?? 'openai:text-embedding-3-small',
  });
  if (brain.searchMode) await run('search-mode', 'config.set', { key: 'search.mode', value: brain.searchMode });
  await run('sync', 'sync', { all: true });
  await run('embed', 'embed', { stale: true });

  const doctor = await run('doctor', 'doctor', {});
  const ok = steps.every((s) => s.ok);
  if (ok) await advance(brain.id, 'sources-added', 'ready');
  await audit(orgId, userId, 'wizard.finish', brain.id, { steps, doctorExit: doctor.exitCode });

  return c.json({ ok, lifecycle: ok ? 'ready' : brain.lifecycle, steps }, ok ? 200 : 500);
}));
