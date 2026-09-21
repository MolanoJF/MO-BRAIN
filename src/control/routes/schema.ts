import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { requireRole, type Role } from '../rbac.ts';
import { callOps, patchFilePlaneConfig, putSchemaPack } from '../opsClient.ts';
import { listSchemaPacks } from './wizard.ts';
import { parseSchemaActiveProse, type SchemaActive } from '../../contracts/capability.ts';

export const schemaRoutes = new Hono();

/** Same guard as the pack directory name in src/ops/fileplane.ts. */
const PACK_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** gbrain's own manifest cap is generous; ours is a sanity bound, not policy. */
const MAX_PACK_BYTES = 512 * 1024;

async function audit(orgId: string, actor: string, action: string, target: string, after: unknown) {
  // S3c: `after` is a redacted summary — never a raw request body, and never
  // a pack's YAML.
  await getDb().insert(schema.auditLog)
    .values({ id: randomUUID(), organizationId: orgId, actor, action, target, before: null, after: after as object });
}

const guard = (min: Role, handler: (c: any, ctx: { userId: string; orgId: string; role: Role }) => Promise<Response>) =>
  async (c: any) => {
    let ctx;
    try { ctx = await requireRole(c, min); } catch (r) { return r as Response; }
    try { return await handler(c, ctx); }
    catch (e: any) { return c.json({ error: e?.message ?? 'schema_error' }, e?.status ?? 400); }
  };

async function loadBrain(orgId: string) {
  const [brain] = await getDb().select().from(schema.brains)
    .where(eq(schema.brains.organizationId, orgId));
  if (!brain) throw new Error('no brain for organization');
  return brain;
}

/** The resolved truth, never our stored intent. */
async function readActive(): Promise<SchemaActive> {
  const r = await callOps<never>('schema.active', {}, { timeoutMs: 60_000 });
  return parseSchemaActiveProse(r.stdout ?? '');
}

/**
 * gbrain's manifest-shape check. Not redundant with lint: `schema lint <name>`
 * answers the misleading `Pack not found` when a pack exists but fails to
 * parse, while `validate` gives the real diagnosis (MEASURED; see
 * docs/schema-pack-findings.md S5). Returns null when the pack is fine.
 */
async function validationError(pack: string): Promise<string | null> {
  const r = await callOps<never>('schema.validate', { packName: pack }, { timeoutMs: 60_000 });
  if (r.ok) return null;
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
  return text || `schema validate exited ${r.exitCode}`;
}

type LintReport = {
  ok: boolean;
  errors: { rule: string; message: string; hint?: string }[];
  warnings: { rule: string; message: string; hint?: string }[];
};

async function lint(pack: string | undefined, withDb: boolean): Promise<LintReport> {
  // packName MUST precede --with-db: a bare `--with-db` is swallowed as the
  // positional pack name and answers `Pack not found: --with-db` (Work Item S).
  // buildArgv emits params in array order, so this is handled by the registry
  // entry's param ordering — pass them as named params and do not reorder.
  const r = await callOps<LintReport>('schema.lint',
    { ...(pack ? { packName: pack } : {}), ...(withDb ? { withDb: true } : {}) },
    { json: true, timeoutMs: 300_000 });
  if (r.json) return r.json;
  // A malformed pack makes lint print prose, not JSON. Surface that honestly
  // rather than reporting an empty clean report.
  return {
    ok: false,
    errors: [{ rule: 'lint_unavailable', message: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() || `schema lint exited ${r.exitCode}` }],
    warnings: [],
  };
}

/**
 * Current state: what we stored, what gbrain actually resolves, and whether
 * those disagree.
 *
 * `diverged` is the load-bearing field. A brain-DB-plane `schema_pack`
 * (tier 4) outranks the ~/.gbrain/config.json value we write (tier 6), and in
 * that state `gbrain schema use` reports success while changing nothing
 * (MEASURED). The page shows the tier so an admin can see WHY.
 */
schemaRoutes.get('/schema', guard('admin', async (c, { orgId }) => {
  const brain = await loadBrain(orgId);
  const [packs, active] = await Promise.all([listSchemaPacks(), readActive()]);
  const stored = brain.schemaPack ?? null;
  return c.json({
    stored,
    active: {
      pack: active.pack, version: active.version, source: active.source,
      identity: active.identity, pageTypes: active.pageTypes, linkVerbs: active.linkVerbs,
    },
    packs,
    // Only a stored intent can diverge; a brain that never chose one is not
    // "diverged" just because init picked gbrain-base-v2.
    diverged: stored !== null && active.pack !== null && active.pack !== stored,
  });
}));

schemaRoutes.post('/schema/validate', guard('admin', async (c) => {
  const { pack } = await c.req.json();
  if (typeof pack !== 'string' || !PACK_NAME.test(pack)) return c.json({ error: 'pack is required' }, 400);
  const err = await validationError(pack);
  return c.json({ ok: err === null, error: err });
}));

schemaRoutes.post('/schema/lint', guard('admin', async (c) => {
  const body = await c.req.json();
  const pack = typeof body?.pack === 'string' ? body.pack : undefined;
  if (pack !== undefined && !PACK_NAME.test(pack)) return c.json({ error: `invalid pack name ${pack}` }, 400);
  return c.json(await lint(pack, body?.withDb === true));
}));

/**
 * `gbrain schema sync` with no `--apply` — the preview. There is no
 * `--dry-run` here: the flag is rejected before dispatch
 * (`unknown flag --dry-run for 'gbrain schema'`), and preview IS the default
 * mode. Reads the whole brain; no source fence, because a pack is brain-wide.
 */
schemaRoutes.post('/schema/preview', guard('admin', async (c) => {
  const r = await callOps<unknown>('schema.sync', {}, { json: true, timeoutMs: 300_000 });
  if (!r.json) return c.json({ error: `schema sync exited ${r.exitCode}`, detail: r.stderr }, 400);
  return c.json(r.json);
}));

/**
 * Activate a pack.
 *
 * Deliberately NOT `gbrain schema use`: that does an unlocked
 * read-modify-write of the whole config.json, a second unserialized writer to
 * the file S3's advisory lock exists to protect. `patchFilePlaneConfig` writes
 * the same tier-6 field through the one serialized writer and merges instead
 * of rewriting. We give up `schema use`'s built-in validation and buy it back
 * with the explicit validate + lint gate above it.
 *
 * Every apply ends with a `schema active` readback. If the engine resolved a
 * different pack — which happens whenever a tier above 6 is set — this
 * answers 409 and leaves the stored column alone. Reporting that as success
 * would be exactly the false green honesty rule 5 forbids.
 */
schemaRoutes.post('/schema/apply', guard('admin', async (c, { userId, orgId }) => {
  const { pack } = await c.req.json();
  if (typeof pack !== 'string' || !PACK_NAME.test(pack)) return c.json({ error: 'pack is required' }, 400);

  const known = await listSchemaPacks();
  if (!known.includes(pack)) return c.json({ error: `unknown schema pack ${pack}`, packs: known }, 400);

  const invalid = await validationError(pack);
  if (invalid) return c.json({ error: invalid }, 400);

  const report = await lint(pack, false);
  if (!report.ok) return c.json({ error: 'pack lint failed', lint: report }, 400);

  const brain = await loadBrain(orgId);
  await patchFilePlaneConfig({ schema_pack: pack });
  const active = await readActive();

  if (active.pack !== pack) {
    await audit(orgId, userId, 'schema.apply.diverged', pack, {
      requested: pack, resolved: active.pack, source: active.source,
    });
    return c.json({
      ok: false,
      error:
        `gbrain still resolves ${active.pack ?? 'no pack'} from the "${active.source}" tier, ` +
        `which outranks the config.json value just written. ` +
        (active.source === 'db-config' || active.source === 'per-source-db'
          ? 'Clear the brain-DB-plane schema_pack to let this choice take effect.'
          : 'Clear the higher-priority source to let this choice take effect.'),
      requested: pack,
      active: { pack: active.pack, source: active.source },
    }, 409);
  }

  await getDb().update(schema.brains)
    .set({ schemaPack: pack, updatedAt: new Date() })
    .where(eq(schema.brains.id, brain.id));
  await audit(orgId, userId, 'schema.apply', pack, {
    pack, source: active.source, warnings: report.warnings.length,
  });

  return c.json({
    ok: true,
    active: { pack: active.pack, version: active.version, source: active.source, identity: active.identity },
    lint: report,
  });
}));

/**
 * `gbrain schema sync --apply`.
 *
 * Additive only, and that is a measured property, not an assumption: both the
 * probe and the chunked UPDATE are fenced by
 * `(type IS NULL OR type = '')`, so it fills blank types and cannot
 * reclassify, delete or unembed anything. Verified against the pinned
 * container with a pack whose prefixes deliberately targeted already-typed
 * pages — zero rows changed. See docs/schema-pack-findings.md S3.
 */
schemaRoutes.post('/schema/sync', guard('admin', async (c, { userId, orgId }) => {
  const r = await callOps<{ total_applied: number; total_would_apply: number }>(
    'schema.sync', { apply: true }, { json: true, timeoutMs: 900_000 },
  );
  if (!r.json) return c.json({ error: `schema sync exited ${r.exitCode}`, detail: r.stderr }, 400);
  await audit(orgId, userId, 'schema.sync', 'brain', {
    applied: r.json.total_applied, wouldApply: r.json.total_would_apply,
  });
  return c.json(r.json);
}));

/**
 * Install or replace a custom pack.
 *
 * The YAML goes to the FILE plane, never gbrain's DB plane — gbrain only ever
 * reads packs from `~/.gbrain/schema-packs/<name>/pack.yaml`, and that path is
 * on the shared `gbrain-home` volume, so the write survives restarts and is
 * visible to gbrain-serve and gbrain-worker too (MEASURED).
 *
 * Writing does not activate. The response carries validate + lint so the admin
 * sees whether the pack is usable before choosing to apply it.
 */
schemaRoutes.put('/schema/pack', guard('admin', async (c, { userId, orgId }) => {
  const { name, yaml } = await c.req.json();
  if (typeof name !== 'string' || !PACK_NAME.test(name)) {
    return c.json({ error: 'name must be lowercase letters, digits and hyphens' }, 400);
  }
  if (typeof yaml !== 'string' || yaml.trim() === '') return c.json({ error: 'yaml is required' }, 400);
  if (Buffer.byteLength(yaml, 'utf8') > MAX_PACK_BYTES) {
    return c.json({ error: `pack manifest exceeds ${MAX_PACK_BYTES} bytes` }, 400);
  }

  await putSchemaPack(name, yaml);
  const invalid = await validationError(name);
  const report = invalid ? null : await lint(name, false);

  // S3c: the audit row records SHAPE, never the manifest body.
  await audit(orgId, userId, 'schema.pack.write', name, {
    name, bytes: Buffer.byteLength(yaml, 'utf8'), valid: invalid === null,
  });

  return c.json({ ok: invalid === null, name, error: invalid, lint: report });
}));
