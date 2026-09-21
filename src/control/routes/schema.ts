import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
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

export type PackPageType = {
  name: string;
  primitive: string;
  pathPrefixes: string[];
  aliases: string[];
  extractable: boolean;
};

export type PackDetail = {
  name: string;
  version: string | null;
  description: string | null;
  extends: string | null;
  pageTypes: PackPageType[];
  linkVerbs: string[];
  takesKinds: string[];
  error: string | null;
};

/** gbrain's SNAKE_CASE manifest, MEASURED against 0.50.5.0 (S4). Only the
 *  fields this route maps are listed; `schema show --json` carries more. */
type RawManifest = {
  name?: string;
  version?: string | null;
  description?: string | null;
  extends?: string | null;
  page_types?: Array<{
    name?: string; primitive?: string; path_prefixes?: string[];
    aliases?: string[]; extractable?: boolean;
  }>;
  link_types?: Array<{ name?: string }>;
  takes_kinds?: string[];
};

/**
 * Resolved pack details, keyed by `${gbrainVersion}:${pack}`.
 *
 * Packs only change when their manifest is rewritten (`PUT /schema/pack`, which
 * calls invalidateSchemaPackCache) or when gbrain is upgraded — and the version
 * in the key makes the upgrade lane invalidate itself automatically, so there is
 * no separate upgrade hook to forget. Seven packs × one spawn each is ~1s cold.
 */
const packDetailCache = new Map<string, PackDetail>();

export function invalidateSchemaPackCache(): void {
  packDetailCache.clear();
}

/**
 * One pack's EFFECTIVE manifest, through gbrain's own resolver.
 *
 * The positional form `gbrain schema show <pack>` prints the UNRESOLVED
 * manifest, so it must never be used: `gbrain-creator` shows 1 page type raw
 * and 27 effective (MEASURED, S4). `schema.show` is registered with `params: []`
 * for exactly that reason — the pack name travels as Task 1's `packOverride`
 * env seam (tier 2), which routes through `resolvePack` / `mergeInheritedManifest`.
 * Never reimplement the `extends` merge in TypeScript; it is child-wins
 * de-duplication, not a union.
 */
async function packDetail(version: string, pack: string): Promise<PackDetail> {
  const key = `${version}:${pack}`;
  const cached = packDetailCache.get(key);
  if (cached) return cached;

  const r = await callOps<RawManifest>('schema.show', {},
    { json: true, packOverride: pack, timeoutMs: 60_000 });
  const detail = toPackDetail(pack, r);
  packDetailCache.set(key, detail);
  return detail;
}

function toPackDetail(
  name: string,
  r: { ok: boolean; exitCode: number; stdout: string; stderr: string; json: RawManifest | null },
): PackDetail {
  // A pack that fails to resolve says so, with empty arrays — never a silent
  // empty list that masquerades as "this pack brings nothing".
  if (!r.ok || !r.json) {
    const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
    return {
      name, version: null, description: null, extends: null,
      pageTypes: [], linkVerbs: [], takesKinds: [],
      error: text || `schema show exited ${r.exitCode} with no manifest`,
    };
  }
  const m = r.json;
  return {
    name,
    version: m.version ?? null,
    description: m.description ?? null,
    extends: m.extends ?? null,
    pageTypes: (m.page_types ?? []).map((p) => ({
      name: p.name ?? '',
      primitive: p.primitive ?? '',
      pathPrefixes: p.path_prefixes ?? [],
      aliases: p.aliases ?? [],
      extractable: p.extractable === true,
    })),
    linkVerbs: (m.link_types ?? [])
      .map((l) => l.name)
      .filter((n): n is string => typeof n === 'string' && n !== ''),
    takesKinds: m.takes_kinds ?? [],
    error: null,
  };
}

/** Resolves a Space id against the ORG's OWN rows. Never interpolate a client
 *  string into a gbrain config key or argv without this. */
async function spaceExists(orgId: string, sourceId: string): Promise<boolean> {
  const [row] = await getDb().select({ id: schema.spaces.id }).from(schema.spaces)
    .where(and(eq(schema.spaces.organizationId, orgId), eq(schema.spaces.sourceId, sourceId)));
  return row !== undefined;
}

/**
 * `gbrain config get <key>` reads the DB plane, which is the truth for a
 * per-source override. It prints the value on the first line then a
 * `[config] source: ...` note; a missing key exits 1 with
 * `Config key not found`. `callOps` returns `{ ok: false }` on that — it does
 * NOT throw on a non-zero op exit. Parse the first non-`[config]` line.
 * MEASURED; docs/schema-pack-findings.md S1 and S6 probe 1.
 */
async function readConfigValue(key: string): Promise<string | null> {
  const r = await callOps<never>('config.get', { key }, { timeoutMs: 60_000 });
  if (!r.ok) return null;
  const line = (r.stdout ?? '').split('\n').map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('[config]'));
  return line ?? null;
}

export type SourcePackResolution = {
  sourceId: string; name: string; kind: string;
  pack: string | null; tier: string | null;
  pageTypes: number | null; linkVerbs: number | null;
  inherited: boolean;
};

/**
 * The pack each Space resolves, for the org's own `spaces` rows.
 *
 * S6 Gate 2: `gbrain schema active --source <id>` IGNORES its argument at
 * 0.50.5.0 and never reports `Source: per-source-db`, so there is NO honest
 * per-source READBACK. Instead we read the STORED INTENT (`config get
 * schema_pack.source.<id>`): when set, that override is what gbrain resolves
 * at tier 3 and we report tier `per-source-db`; when absent, the brain-wide
 * pack applies and we mark `inherited`. We never render a resolved-looking
 * state we did not read back — the honesty rule that already makes
 * `/schema/apply` answer 409. See docs/schema-pack-findings.md S1/S2/S6.
 */
export async function resolveSourcePacks(orgId: string): Promise<SourcePackResolution[]> {
  const rows = await getDb().select().from(schema.spaces)
    .where(eq(schema.spaces.organizationId, orgId));
  const brain = await loadBrain(orgId);
  const active = await readActive();
  const version = brain.gbrainVersion ?? '';

  const out: SourcePackResolution[] = [];
  for (const row of rows) {
    const stored = await readConfigValue(`schema_pack.source.${row.sourceId}`);
    const inherited = stored === null;
    const pack = stored ?? active.pack;
    const tier = stored !== null ? 'per-source-db' : active.source;

    // COUNTS come from the Task 3 cache. If the detail failed to resolve, both
    // stay null — never a fabricated 0.
    let pageTypes: number | null = null;
    let linkVerbs: number | null = null;
    if (pack) {
      const detail = await packDetail(version, pack);
      if (!detail.error) {
        pageTypes = detail.pageTypes.length;
        linkVerbs = detail.linkVerbs.length;
      }
    }
    out.push({
      sourceId: row.sourceId, name: row.name, kind: row.kind,
      pack, tier, pageTypes, linkVerbs, inherited,
    });
  }
  return out;
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

/**
 * Every known pack's EFFECTIVE manifest, via gbrain's own resolver.
 *
 * Counts are the resolved ones, not the raw file's: `gbrain-creator` brings 27
 * effective page types from a 27-base + 1-own child-wins merge, where its raw
 * file declares 1 (MEASURED, S4). Serving the raw manifest here would be a
 * false claim; the whole point of Task 1's packOverride seam is to avoid it.
 */
schemaRoutes.get('/schema/packs', guard('admin', async (c, { orgId }) => {
  const brain = await loadBrain(orgId);
  const names = await listSchemaPacks();
  const version = brain.gbrainVersion ?? '';
  const packs = await Promise.all(names.map((name) => packDetail(version, name)));
  return c.json({ packs });
}));

/**
 * Per-Space pack: the STORED INTENT (or the inherited brain-wide pack).
 * See resolveSourcePacks for why this is a `config get` read and not a
 * `schema active --source` readback (S6 Gate 2 failed).
 */
schemaRoutes.get('/schema/sources', guard('admin', async (c, { orgId }) => {
  return c.json({ sources: await resolveSourcePacks(orgId) });
}));

/**
 * Set one Space's pack override (gbrain tier 3, `schema_pack.source.<id>`).
 *
 * Same validate + lint gate `/schema/apply` runs, then a readback. `sourceId`
 * is validated against the org's own `spaces` rows FIRST — never interpolate a
 * client string into a config key. The `force` param is REQUIRED: the key is
 * not in gbrain's `KNOWN_CONFIG_KEY_PREFIXES`, so `config set` exits 1 with
 * `Unknown config key` without it (S1/S6 probe 1).
 *
 * If the readback disagrees the write is NOT reported as applied: same 409
 * shape and same refusal to round a mismatch up as `/schema/apply`.
 */
schemaRoutes.post('/schema/sources/:sourceId', guard('admin', async (c, { userId, orgId }) => {
  const sourceId = c.req.param('sourceId') ?? '';
  if (!(await spaceExists(orgId, sourceId))) return c.json({ error: `unknown source ${sourceId}` }, 400);

  const { pack } = await c.req.json();
  if (typeof pack !== 'string' || !PACK_NAME.test(pack)) return c.json({ error: 'pack is required' }, 400);

  const known = await listSchemaPacks();
  if (!known.includes(pack)) return c.json({ error: `unknown schema pack ${pack}`, packs: known }, 400);

  const invalid = await validationError(pack);
  if (invalid) return c.json({ error: invalid }, 400);

  const report = await lint(pack, false);
  if (!report.ok) return c.json({ error: 'pack lint failed', lint: report }, 400);

  const key = `schema_pack.source.${sourceId}`;
  const write = await callOps('config.set', { key, value: pack, force: true }, { timeoutMs: 60_000 });
  if (!write.ok) {
    return c.json({ error: `config set failed (exit ${write.exitCode})`, detail: write.stderr }, 400);
  }

  const stored = await readConfigValue(key);
  if (stored !== pack) {
    await audit(orgId, userId, 'schema.source.pack.diverged', sourceId, {
      requested: pack, stored, tier: 'per-source-db',
    });
    return c.json({
      ok: false,
      error:
        `the per-source override was written to ${key} but the engine's stored value ` +
        `reads back as ${stored ?? 'nothing'}, not ${pack}. Refusing to report this as applied.`,
      requested: pack,
      active: { pack: stored, source: 'per-source-db' },
    }, 409);
  }

  await audit(orgId, userId, 'schema.source.pack', sourceId, { pack, tier: 'per-source-db' });
  return c.json({ ok: true, sourceId, pack, tier: 'per-source-db', inherited: false });
}));

/**
 * Clear one Space's pack override, returning it to the brain-wide pack.
 *
 * `config.unset` exits 1 on an already-absent key, so success is judged by the
 * readback, not the exit code: an absent key IS the requested end state. If the
 * key survives the unset we answer 409 rather than claim a reset.
 */
schemaRoutes.delete('/schema/sources/:sourceId', guard('admin', async (c, { userId, orgId }) => {
  const sourceId = c.req.param('sourceId') ?? '';
  if (!(await spaceExists(orgId, sourceId))) return c.json({ error: `unknown source ${sourceId}` }, 400);

  const key = `schema_pack.source.${sourceId}`;
  await callOps('config.unset', { key }, { timeoutMs: 60_000 });
  const stored = await readConfigValue(key);
  if (stored !== null) {
    await audit(orgId, userId, 'schema.source.pack.reset_failed', sourceId, { stored });
    return c.json({
      ok: false,
      error: `${key} still reads back as ${stored}; the per-source override was not cleared.`,
      sourceId,
    }, 409);
  }

  const active = await readActive();
  await audit(orgId, userId, 'schema.source.pack.reset', sourceId, {
    pack: active.pack, tier: active.source,
  });
  return c.json({ ok: true, sourceId, pack: active.pack, tier: active.source, inherited: true });
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
 * mode. Sync is additive-only: it fills blank types (`type IS NULL OR type =
 * ''`) and cannot reclassify, delete or unembed (S3).
 *
 * An optional `{ source }` fences the run to one Space. `--source` is PROVEN to
 * fence count, sample and UPDATE alike (Task 0 gate 4, S6 probe 4). Absent,
 * the brain-wide behavior is unchanged. The source is validated against the
 * org's own `spaces` rows before it reaches argv.
 */
schemaRoutes.post('/schema/preview', guard('admin', async (c, { orgId }) => {
  const body = await c.req.json().catch(() => ({}));
  const source = typeof body?.source === 'string' ? body.source : undefined;
  if (source !== undefined && !(await spaceExists(orgId, source))) {
    return c.json({ error: `unknown source ${source}` }, 400);
  }
  const r = await callOps<unknown>('schema.sync',
    source !== undefined ? { source } : {}, { json: true, timeoutMs: 300_000 });
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
  // An optional `{ source }` runs the per-Space backfill (gate 4 passed). The
  // audit target names the Space, not 'brain', when a fence is in play.
  const body = await c.req.json().catch(() => ({}));
  const source = typeof body?.source === 'string' ? body.source : undefined;
  if (source !== undefined && !(await spaceExists(orgId, source))) {
    return c.json({ error: `unknown source ${source}` }, 400);
  }

  const r = await callOps<{ total_applied: number; total_would_apply: number }>(
    'schema.sync', { apply: true, ...(source !== undefined ? { source } : {}) },
    { json: true, timeoutMs: 900_000 },
  );
  if (!r.json) return c.json({ error: `schema sync exited ${r.exitCode}`, detail: r.stderr }, 400);
  await audit(orgId, userId, 'schema.sync', source ?? 'brain', {
    applied: r.json.total_applied, wouldApply: r.json.total_would_apply,
    ...(source !== undefined ? { source } : {}),
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

  // The manifest on disk just changed. The cache is version-keyed, so an
  // upgrade invalidates itself, but this write does not move the version.
  invalidateSchemaPackCache();

  return c.json({ ok: invalid === null, name, error: invalid, lint: report });
}));
