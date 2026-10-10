import { test, expect, beforeAll, afterAll, beforeEach, afterEach, describe, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(48);
process.env.BETTER_AUTH_SECRET ??= 'b'.repeat(48);
process.env.CONTROL_DATABASE_URL ??=
  'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';
process.env.PUBLIC_URL ??= 'http://127.0.0.1:3131';

import { packWorldReply, rawPacks, resetPackWorld } from '../helpers/packWorld.ts';

const PASS = 'correct-horse-battery-staple-1';

// The ops seam. Each test sets `opsHandler` to decide what gbrain "answers".
type OpsReply = { ok: boolean; exitCode: number; stdout: string; stderr: string; json: unknown };
type CallOpts = { json?: boolean; dryRun?: boolean; timeoutMs?: number; packOverride?: string };
let opsHandler: (op: string, params: Record<string, unknown>, opts?: CallOpts) => OpsReply;
const filePlanePatches: Record<string, unknown>[] = [];
const packWrites: { name: string; yaml: string }[] = [];
const jsonPackWrites: { name: string; manifest: any }[] = [];
const packRemoves: string[] = [];
// What `readSchemaPackRaw` answers: a pack already on disk, in its stored format.
const storedRaw: Record<string, { format: 'json' | 'yaml'; text: string }> = {};
// Hooks a test can set to react to a write happening (e.g. make a freshly
// written layer show up in the next `schema.list`), reset in beforeEach.
let onJsonPackWrite: () => void = () => {};
let onFilePlanePatch: () => void = () => {};
const scaffolds: {
  sourceId: string; entries: { dir: string; readme: string }[];
  actor: { name: string; email: string }; message: string;
}[] = [];

mock.module('../../src/control/opsClient.ts', () => ({
  // --- the three this suite drives ---
  // The core lock's reads (showRaw / the resolved show) come from the fake
  // pack store whenever it knows the pack; everything else is the test's handler.
  callOps: async (op: string, params: Record<string, unknown> = {}, opts?: CallOpts) =>
    packWorldReply(op, params, opts) ?? opsHandler(op, params, opts),
  patchFilePlaneConfig: async (patch: Record<string, unknown>) => { filePlanePatches.push(patch); onFilePlanePatch(); },
  putSchemaPack: async (name: string, yaml: string) => {
    packWrites.push({ name, yaml });
    rawPacks[name] = parseYaml(yaml) as any;
  },
  putSchemaPackJson: async (name: string, manifest: any) => {
    jsonPackWrites.push({ name, manifest }); rawPacks[name] = manifest; onJsonPackWrite();
  },
  readSchemaPackRaw: async (name: string) => storedRaw[name] ?? null,
  gitImport: async () => { throw new Error("gitImport is not mocked here"); },
  gitScaffold: async (req: { sourceId: string; entries: { dir: string; readme: string }[]; actor: { name: string; email: string }; message: string }) => {
    scaffolds.push(req);
    return { created: req.entries.map((e) => `${e.dir}README.md`), skipped: [], sha: 'scaffold-sha' };
  },
  removeSchemaPack: async (name: string) => { packRemoves.push(name); delete rawPacks[name]; return { removed: true }; },
  // --- the rest of the module's real exports, required for the app graph to
  //     load at all under per-file isolation. Copy verbatim from
  //     test/integration/routes.test.ts and keep in sync with opsClient.ts. ---
  brainUsage: async () => { throw new Error('ops unreachable'); },
  mcpWhoami: async (bearer: string) => (bearer.startsWith('tok-')
    ? { ok: true, identity: { transport: 'oauth', client_id: bearer.slice(4) } }
    : { ok: false, status: 401, error: 'invalid_token' }),
  seedSpace: async () => {},
  gitSetRemote: async (r: { url: string }) => ({ url: r.url, branch: 'main' }),
  gitClearRemote: async () => ({ removed: true }),
  resetBrainSchema: async () => {},
  pauseBrainWriters: async () => {},
  resumeBrainWriters: async () => {},
  takeGrantCredentials: async () => ({}),
  opsHealthy: async () => true,
  commitAsMember: async () => ({ committed: true, sha: 'abc123' }),
  inspectRepos: async () => [],
  writeReport: async () => ({ relPath: '', committed: false, sha: null }),
  cancelRun: async () => ({ cancelled: false }),
  deleteCredentialJournal: async () => ({ deleted: true }),
  gitRange: async () => ({ commits: [], files: [] }),
  gitPathExists: async () => ({ paths: [] }),
  gitRevertRange: async () => ({ outcome: 'nothing_to_revert' }),
  auditTail: async () => [],
  gitTree: async () => ({ sourceId: '', root: '', entries: [] }),
  gitExportBundle: async () => new Response(null),
  gitReadFile: async () => ({ content: '', sha: '', size: 0 }),
  gitWriteFile: async () => ({ committed: true, sha: 'written-sha' }),
}));

const { default: app } = await import('../../src/control/app.ts');
const { runMigrations, getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { bootstrapFirstAdmin } = await import('../../src/control/bootstrap.ts');
const { invalidateSchemaPackCache } = await import('../../src/control/routes/schema.ts');
const { eq, desc } = await import('drizzle-orm');

pinDb();

let orgId = '';
let brainId = '';
let ownerCookie = '';
let memberCookie = '';

async function signIn(email: string, password: string): Promise<string> {
  const res = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie') ?? '';
}

async function makeMember(email: string): Promise<string> {
  const signed = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASS, name: email }),
  });
  expect(signed.status).toBe(200);
  const [u] = await getDb().select().from(schema.users).where(eq(schema.users.email, email));
  await getDb().insert(schema.memberships).values({
    id: randomUUID(), userId: u!.id, organizationId: orgId, role: 'member',
  });
  return signIn(email, PASS);
}

async function hit(method: string, path: string, cookie?: string, body?: unknown) {
  const headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.10' };
  if (cookie) headers.cookie = cookie;
  const hasBody = method !== 'GET' && method !== 'DELETE';
  if (hasBody) headers['content-type'] = 'application/json';
  return app.request(path, { method, headers, body: hasBody ? JSON.stringify(body ?? {}) : undefined });
}

const storedPack = async (): Promise<string | null> => {
  const [b] = await getDb().select().from(schema.brains).where(eq(schema.brains.id, brainId));
  return b?.schemaPack ?? null;
};
const setStoredPack = async (pack: string | null) => {
  await getDb().update(schema.brains).set({ schemaPack: pack }).where(eq(schema.brains.id, brainId));
};
const lastAudit = async () => {
  // The timestamp column is `at`, not `created_at` (src/control/db/schema.ts:164).
  const [row] = await getDb().select().from(schema.auditLog)
    .where(eq(schema.auditLog.organizationId, orgId))
    .orderBy(desc(schema.auditLog.at)).limit(1);
  return row;
};

const ok = (stdout: string, json: unknown = null): OpsReply =>
  ({ ok: true, exitCode: 0, stdout, stderr: '', json });
const fail = (exitCode: number, stdout: string, stderr = ''): OpsReply =>
  ({ ok: false, exitCode, stdout, stderr, json: null });

// Verbatim shapes from the pinned 0.50.5.0 container.
const LIST = 'Bundled packs:\n  gbrain-base\n  gbrain-base-v2\n\nInstalled packs (~/.gbrain/schema-packs/):\n  hr-policies\n  mobrain-core\n  mobrain-personal\n';
const LIST_WITH_CREATOR = 'Bundled packs:\n  gbrain-base\n  gbrain-creator\n\nInstalled packs (~/.gbrain/schema-packs/):\n  hr-policies\n';
const LIST_SHIPPED = 'Bundled packs:\n  gbrain-base\n  gbrain-base-v2\n  gbrain-investor\n\n' +
  'Installed packs (~/.gbrain/schema-packs/):\n  mobrain-personal\n';
const ACTIVE = (pack: string, source = 'home-config') =>
  `Active pack: ${pack} v1.0.0\nSource: ${source}\nPack identity: ${pack}@1.0.0+deadbeef\nPage types: 3\nLink verbs: 2\n`;

/** An EFFECTIVE `schema show --json` manifest in gbrain's SNAKE_CASE shape. */
const showJson = (pageTypes: number, linkTypes: number, name = 'gbrain-base') => ({
  name, version: '1.0.0', description: 'a pack', extends: 'gbrain-base',
  page_types: Array.from({ length: pageTypes }, (_, i) => ({
    name: `type-${i}`, primitive: 'concept', path_prefixes: [`p${i}/`], aliases: [], extractable: true,
  })),
  link_types: Array.from({ length: linkTypes }, (_, i) => ({ name: `verb-${i}` })),
  takes_kinds: ['fact', 'take'],
});

async function insertSpace(sourceId: string, name = sourceId) {
  await getDb().insert(schema.spaces).values({
    id: randomUUID(), organizationId: orgId, sourceId, name,
    kind: 'local-git', localPath: `/srv/brain-repos/${sourceId}`,
  });
}

beforeAll(async () => {
  await runMigrations();
  for (const t of [
    schema.claimLinks, schema.connections, schema.spaces, schema.secrets, schema.auditLog,
    schema.sessions, schema.accounts, schema.verifications,
    schema.memberships, schema.brains, schema.organizations, schema.users,
  ]) {
    await getDb().delete(t);
  }
  const boot = await bootstrapFirstAdmin('schema-owner@example.test', PASS, 'SchemaCo');
  orgId = boot.orgId;
  ownerCookie = await signIn('schema-owner@example.test', PASS);
  const [brain] = await getDb().select().from(schema.brains).where(eq(schema.brains.organizationId, orgId));
  brainId = brain!.id;

  // A plain member, to prove the guard. Mint via the same path routes.test.ts
  // uses (bootstrapFirstAdmin + a membership row + sign-in).
  memberCookie = await makeMember('schema-member@example.test');
});

beforeEach(async () => {
  filePlanePatches.length = 0;
  packWrites.length = 0;
  jsonPackWrites.length = 0;
  packRemoves.length = 0;
  scaffolds.length = 0;
  onJsonPackWrite = () => {};
  onFilePlanePatch = () => {};
  resetPackWorld();
  rawPacks['hr-policies'] = { name: 'hr-policies', extends: 'mobrain-core', page_types: [{ name: 'policy', primitive: 'concept', path_prefixes: ['policies/'] }] };
  // The user pack most authoring tests edit: contract + governs, built on core.
  rawPacks['legal-ops'] = {
    name: 'legal-ops', extends: 'mobrain-core',
    page_types: [{ name: 'contract', primitive: 'entity', path_prefixes: ['contracts/'] }],
    link_types: [{ name: 'governs' }],
  };
  for (const k of Object.keys(storedRaw)) delete storedRaw[k];
  invalidateSchemaPackCache();
  await setStoredPack(null);
  await getDb().delete(schema.auditLog);
  await getDb().delete(schema.spaces);
});

afterAll(async () => {
  await closeDb();
});

test('GET /schema reports the stored pack, the resolved pack and the tier', async () => {
  opsHandler = (op) => {
    if (op === 'schema.list') return ok(LIST);
    if (op === 'schema.active') return ok(ACTIVE('gbrain-base-v2'));
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('GET', '/api/schema', ownerCookie);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.packs).toEqual(['gbrain-base', 'gbrain-base-v2', 'hr-policies', 'mobrain-core', 'mobrain-personal']);
  expect(body.active.pack).toBe('gbrain-base-v2');
  expect(body.active.source).toBe('home-config');
  expect(body.diverged).toBe(false);
});

test('GET /schema flags divergence when a DB-plane value shadows our write', async () => {
  // MEASURED trap: tier 4 outranks the tier 6 we write, and `schema use`
  // reports success while changing nothing. The page must say so.
  opsHandler = (op) => {
    if (op === 'schema.list') return ok(LIST);
    if (op === 'schema.active') return ok(ACTIVE('other-pack', 'db-config'));
    throw new Error(`unexpected op ${op}`);
  };
  await setStoredPack('hr-policies');
  const body = await (await hit('GET', '/api/schema', ownerCookie)).json();
  expect(body.diverged).toBe(true);
  expect(body.active.source).toBe('db-config');
});

test('GET /schema does not call a brain with no stored pack diverged', async () => {
  // A brain that never chose a pack is not "diverged" just because init
  // picked gbrain-base-v2 for it.
  opsHandler = (op) => {
    if (op === 'schema.list') return ok(LIST);
    if (op === 'schema.active') return ok(ACTIVE('gbrain-base-v2'));
    throw new Error(`unexpected op ${op}`);
  };
  const body = await (await hit('GET', '/api/schema', ownerCookie)).json();
  expect(body.stored).toBeNull();
  expect(body.diverged).toBe(false);
});

test('POST /schema/apply refuses an invalid pack and writes nothing', async () => {
  opsHandler = (op) => {
    if (op === 'schema.list') return ok(LIST);
    if (op === 'schema.validate') return fail(1, '', 'manifest validation failed: page_types.0.primitive');
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('POST', '/api/schema/apply', ownerCookie, { pack: 'hr-policies' });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/manifest validation failed/);
  expect(filePlanePatches).toEqual([]);
});

test('POST /schema/apply refuses an unknown pack before calling gbrain', async () => {
  opsHandler = (op) => {
    if (op === 'schema.list') return ok(LIST);
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('POST', '/api/schema/apply', ownerCookie, { pack: 'not-installed' });
  expect(res.status).toBe(400);
  expect(filePlanePatches).toEqual([]);
});

test('POST /schema/apply writes tier 6 and verifies with schema active', async () => {
  opsHandler = (op) => {
    if (op === 'schema.list') return ok(LIST);
    if (op === 'schema.validate') return ok('✓ hr-policies v1.0.0: valid manifest');
    if (op === 'schema.lint') return ok('', { ok: true, errors: [], warnings: [] });
    if (op === 'schema.active') return ok(ACTIVE('hr-policies'));
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('POST', '/api/schema/apply', ownerCookie, { pack: 'hr-policies' });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.active.pack).toBe('hr-policies');
  // Written through the lock-serialized file-plane writer, NOT `schema use`.
  expect(filePlanePatches).toEqual([{ schema_pack: 'hr-policies' }]);
  expect(await storedPack()).toBe('hr-policies');
});

test('POST /schema/apply reports divergence instead of success', async () => {
  opsHandler = (op) => {
    if (op === 'schema.list') return ok(LIST);
    if (op === 'schema.validate') return ok('✓ hr-policies v1.0.0: valid manifest');
    if (op === 'schema.lint') return ok('', { ok: true, errors: [], warnings: [] });
    // We wrote tier 6, but a tier-4 value wins. Never render this green.
    if (op === 'schema.active') return ok(ACTIVE('other-pack', 'db-config'));
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('POST', '/api/schema/apply', ownerCookie, { pack: 'hr-policies' });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.error).toMatch(/db-config/);
  // The stored column must NOT claim a pack the engine did not adopt.
  expect(await storedPack()).toBeNull();
});

test('POST /schema/apply refuses a pack whose lint has errors', async () => {
  opsHandler = (op) => {
    if (op === 'schema.list') return ok(LIST);
    if (op === 'schema.validate') return ok('✓ hr-policies v1.0.0: valid manifest');
    if (op === 'schema.lint') {
      return fail(1, JSON.stringify({ ok: false, errors: [{ rule: 'duplicate_type', message: 'x' }], warnings: [] }));
    }
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('POST', '/api/schema/apply', ownerCookie, { pack: 'hr-policies' });
  expect(res.status).toBe(400);
  expect(filePlanePatches).toEqual([]);
});

test('POST /schema/preview never applies', async () => {
  opsHandler = (op, params) => {
    if (op === 'schema.sync') {
      expect(params.apply).toBeUndefined();
      return ok('', { apply: false, total_would_apply: 4, total_applied: 0, per_prefix: [] });
    }
    throw new Error(`unexpected op ${op}`);
  };
  const body = await (await hit('POST', '/api/schema/preview', ownerCookie, {})).json();
  expect(body.apply).toBe(false);
  expect(body.total_applied).toBe(0);
});

test('POST /schema/sync applies and audits', async () => {
  opsHandler = (op, params) => {
    if (op === 'schema.sync') {
      expect(params.apply).toBe(true);
      return ok('', { apply: true, total_would_apply: 4, total_applied: 4, per_prefix: [] });
    }
    throw new Error(`unexpected op ${op}`);
  };
  const body = await (await hit('POST', '/api/schema/sync', ownerCookie, {})).json();
  expect(body.total_applied).toBe(4);
  expect(await lastAudit()).toMatchObject({ action: 'schema.sync' });
});

const HR_YAML = 'api_version: gbrain-schema-pack-v1\nname: hr-policies\nextends: mobrain-core\n';

test('PUT /schema/pack writes the manifest then validates it', async () => {
  opsHandler = (op) => {
    if (op === 'schema.validate') return ok('✓ hr-policies v1.0.0: valid manifest');
    if (op === 'schema.lint') return ok('', { ok: true, errors: [], warnings: [] });
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('PUT', '/api/schema/pack', ownerCookie,
    { name: 'hr-policies', yaml: HR_YAML });
  expect(res.status).toBe(200);
  expect(packWrites).toEqual([{ name: 'hr-policies', yaml: HR_YAML }]);
});

test('PUT /schema/pack rejects a name that is not a safe directory name', async () => {
  opsHandler = () => { throw new Error('must not reach gbrain'); };
  const res = await hit('PUT', '/api/schema/pack', ownerCookie, { name: '../etc', yaml: 'x: 1' });
  expect(res.status).toBe(400);
  expect(packWrites).toEqual([]);
});

test('the audit row never carries the pack YAML body', async () => {
  // S3c: `after` is a redacted summary, never a raw request body.
  opsHandler = (op) => {
    if (op === 'schema.validate') return ok('✓ hr-policies v1.0.0: valid manifest');
    if (op === 'schema.lint') return ok('', { ok: true, errors: [], warnings: [] });
    throw new Error(`unexpected op ${op}`);
  };
  await hit('PUT', '/api/schema/pack', ownerCookie, { name: 'hr-policies', yaml: `${HR_YAML}# secret-marker-do-not-log\n` });
  expect(JSON.stringify(await lastAudit())).not.toContain('secret-marker-do-not-log');
});

test('GET /schema/packs reports EFFECTIVE counts, not the raw manifest', async () => {
  // The regression: `gbrain-creator`'s raw file declares 1 page type but its
  // effective manifest is 27 (S4). Reading the raw positional manifest here
  // would show 1; this asserts the resolved count comes through gbrain's own
  // resolver via the packOverride env seam.
  opsHandler = (op, params, opts) => {
    if (op === 'schema.list') return ok(LIST_WITH_CREATOR);
    if (op === 'schema.active') return ok(ACTIVE('gbrain-creator'));
    if (op === 'schema.show') {
      // `params: []` is deliberate — a positional pack name is the raw path.
      expect(params).toEqual({});
      expect(opts?.packOverride).toBeTruthy();
      return ok('', showJson(27, 12, opts?.packOverride));
    }
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('GET', '/api/schema/packs', ownerCookie);
  expect(res.status).toBe(200);
  const body = await res.json();
  const creator = body.packs.find((p: any) => p.name === 'gbrain-creator');
  expect(creator.pageTypes.length).toBe(27);
  expect(creator.linkVerbs.length).toBe(12);
  expect(creator.error).toBeNull();
  expect(creator.extends).toBe('gbrain-base');
});

test('GET /schema/packs reports a pack that failed to resolve, never an empty list', async () => {
  opsHandler = (op, _params, opts) => {
    if (op === 'schema.list') return ok(LIST_WITH_CREATOR);
    if (op === 'schema.active') return ok(ACTIVE('gbrain-creator'));
    if (op === 'schema.show') {
      if (opts?.packOverride === 'gbrain-creator') return fail(1, '', 'boom: unresolvable');
      return ok('', showJson(27, 12, opts?.packOverride));
    }
    throw new Error(`unexpected op ${op}`);
  };
  const body = await (await hit('GET', '/api/schema/packs', ownerCookie)).json();
  const creator = body.packs.find((p: any) => p.name === 'gbrain-creator');
  expect(creator.pageTypes).toEqual([]);
  expect(creator.error).toMatch(/unresolvable/);
});

test('a managed pack is never served from the effectivePack cache, an ordinary pack still is', async () => {
  // I3: the ops process's boot seeder can rewrite mobrain-personal's manifest
  // (new pack version, same gbrain version), so the control-plane cache must
  // never serve a stale managed-pack PackDetail.
  const showCalls: Record<string, number> = {};
  let mobrainVersion = '1.0.0';
  // This test counts the handler's own `schema.show` calls.
  for (const n of ['mobrain-personal', 'gbrain-base-v2']) delete rawPacks[n];
  opsHandler = (op, _params, opts) => {
    if (op === 'schema.list') return ok(LIST_SHIPPED);
    if (op === 'schema.active') return ok(ACTIVE('mobrain-personal'));
    if (op === 'schema.show') {
      const pack = opts?.packOverride ?? '';
      showCalls[pack] = (showCalls[pack] ?? 0) + 1;
      const version = pack === 'mobrain-personal' ? mobrainVersion : '1.0.0';
      return ok('', { ...showJson(3, 2, pack), version });
    }
    throw new Error(`unexpected op ${op}`);
  };

  const first = await (await hit('GET', '/api/schema/packs', ownerCookie)).json();
  expect(first.packs.find((p: any) => p.name === 'mobrain-personal').version).toBe('1.0.0');
  expect(showCalls['mobrain-personal']).toBe(1);
  expect(showCalls['gbrain-base-v2']).toBe(1);

  mobrainVersion = '2.0.0';
  const second = await (await hit('GET', '/api/schema/packs', ownerCookie)).json();
  expect(second.packs.find((p: any) => p.name === 'mobrain-personal').version).toBe('2.0.0');
  expect(showCalls['mobrain-personal']).toBe(2);
  // An ordinary bundled pack is still served from cache: no second call.
  expect(showCalls['gbrain-base-v2']).toBe(1);
});

test('GET /schema/sources reads the stored intent and the inherited fallback', async () => {
  await insertSpace('customers', 'Customers');
  await insertSpace('internal', 'Internal');
  opsHandler = (op, params, opts) => {
    if (op === 'schema.active') return ok(ACTIVE('gbrain-base-v2'));
    if (op === 'config.get' && params.key === 'schema_pack.source.customers') {
      return ok('gbrain-investor\n[config] source: db plane\n');
    }
    if (op === 'config.get') return fail(1, 'Config key not found: schema_pack.source.internal');
    if (op === 'schema.show') return ok('', showJson(29, 12, opts?.packOverride));
    throw new Error(`unexpected op ${op}`);
  };
  const body = await (await hit('GET', '/api/schema/sources', ownerCookie)).json();
  const customers = body.sources.find((s: any) => s.sourceId === 'customers');
  expect(customers).toMatchObject({
    pack: 'gbrain-investor', tier: 'per-source-db', inherited: false, pageTypes: 29, linkVerbs: 12,
  });
  const internal = body.sources.find((s: any) => s.sourceId === 'internal');
  expect(internal).toMatchObject({ pack: 'gbrain-base-v2', tier: 'home-config', inherited: true });
});

test('POST /schema/sources writes the tier-3 override with force and reads it back', async () => {
  await insertSpace('customers');
  opsHandler = (op, params, opts) => {
    if (op === 'schema.list') return ok(LIST);
    if (op === 'schema.validate') return ok('✓ hr-policies v1.0.0: valid manifest');
    if (op === 'schema.lint') return ok('', { ok: true, errors: [], warnings: [] });
    if (op === 'config.set') {
      expect(params).toEqual({ key: 'schema_pack.source.customers', value: 'hr-policies', force: true });
      return ok('Set schema_pack.source.customers = hr-policies');
    }
    if (op === 'config.get') return ok('hr-policies\n[config] source: db plane\n');
    // The override lands, then this Space is scaffolded from the pack it now
    // resolves: the readback path needs `schema active` and the resolved manifest.
    if (op === 'schema.active') return ok(ACTIVE('hr-policies'));
    if (op === 'schema.show') return ok('', showJson(1, 0, opts?.packOverride));
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('POST', '/api/schema/sources/customers', ownerCookie, { pack: 'hr-policies' });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, sourceId: 'customers', pack: 'hr-policies', tier: 'per-source-db', inherited: false });
  expect((await lastAudit())?.action).toBe('schema.source.pack');
});

test('POST /schema/sources refuses a readback mismatch with 409', async () => {
  await insertSpace('customers');
  opsHandler = (op) => {
    if (op === 'schema.list') return ok(LIST);
    if (op === 'schema.validate') return ok('✓ hr-policies v1.0.0: valid manifest');
    if (op === 'schema.lint') return ok('', { ok: true, errors: [], warnings: [] });
    if (op === 'config.set') return ok('Set schema_pack.source.customers = hr-policies');
    // The engine stored something else — never round this up to success.
    if (op === 'config.get') return ok('gbrain-investor\n[config] source: db plane\n');
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('POST', '/api/schema/sources/customers', ownerCookie, { pack: 'hr-policies' });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.requested).toBe('hr-policies');
  expect(body.active).toEqual({ pack: 'gbrain-investor', source: 'per-source-db' });
  expect((await lastAudit())?.action).toBe('schema.source.pack.diverged');
});

test('DELETE /schema/sources clears the override and returns the inherited pack', async () => {
  await insertSpace('customers');
  opsHandler = (op, params) => {
    if (op === 'config.unset') {
      expect(params).toEqual({ key: 'schema_pack.source.customers' });
      return ok('Unset schema_pack.source.customers');
    }
    if (op === 'config.get') return fail(1, 'Config key not found: schema_pack.source.customers');
    if (op === 'schema.active') return ok(ACTIVE('gbrain-base-v2'));
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('DELETE', '/api/schema/sources/customers', ownerCookie);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, sourceId: 'customers', pack: 'gbrain-base-v2', tier: 'home-config', inherited: true });
  expect((await lastAudit())?.action).toBe('schema.source.pack.reset');
});

test('per-source writes validate the source against the org first', async () => {
  opsHandler = () => { throw new Error('must not reach gbrain'); };
  // `ghost` is not a Space in this org: refuse before any config key or op.
  expect((await hit('POST', '/api/schema/sources/ghost', ownerCookie, { pack: 'hr-policies' })).status).toBe(400);
  expect((await hit('DELETE', '/api/schema/sources/ghost', ownerCookie)).status).toBe(400);
});

test('POST /schema/preview fences to one source when given one', async () => {
  await insertSpace('customers');
  opsHandler = (op, params) => {
    if (op === 'schema.sync') {
      expect(params).toEqual({ source: 'customers' });
      return ok('', { apply: false, total_would_apply: 1, total_applied: 0, per_prefix: [] });
    }
    throw new Error(`unexpected op ${op}`);
  };
  const body = await (await hit('POST', '/api/schema/preview', ownerCookie, { source: 'customers' })).json();
  expect(body.apply).toBe(false);
  expect(body.total_would_apply).toBe(1);
});

test('POST /schema/preview rejects an unknown source', async () => {
  opsHandler = () => { throw new Error('must not reach gbrain'); };
  const res = await hit('POST', '/api/schema/preview', ownerCookie, { source: 'ghost' });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/unknown source/);
});

test('POST /schema/sync audits the fenced source, not the brain', async () => {
  await insertSpace('customers');
  opsHandler = (op, params) => {
    if (op === 'schema.sync') {
      expect(params).toEqual({ apply: true, source: 'customers' });
      return ok('', { apply: true, total_would_apply: 1, total_applied: 1, per_prefix: [] });
    }
    throw new Error(`unexpected op ${op}`);
  };
  const body = await (await hit('POST', '/api/schema/sync', ownerCookie, { source: 'customers' })).json();
  expect(body.total_applied).toBe(1);
  expect(await lastAudit()).toMatchObject({ action: 'schema.sync', target: 'customers' });
});

test('a non-admin cannot reach any schema route', async () => {
  opsHandler = () => { throw new Error('must not reach gbrain'); };
  expect((await hit('GET', '/api/schema', memberCookie)).status).toBe(403);
  expect((await hit('POST', '/api/schema/apply', memberCookie, { pack: 'gbrain-base' })).status).toBe(403);
});

// --- Task 5: custom-pack authoring (create / fork / mutate / delete / scaffold) ---

const draft = {
  name: 'legal-ops', description: 'Contracts', extends: 'mobrain-core',
  pageTypes: [{
    name: 'contract', primitive: 'entity', folder: 'contracts/', description: 'Signed',
    extraPrefixes: [], aliases: [], extractable: true, expertRouting: false,
  }],
  linkVerbs: [],
};

const INSTALLED_LEGAL_OPS =
  'Bundled packs:\n  gbrain-base-v2\n\nInstalled packs (~/.gbrain/schema-packs/):\n  legal-ops\n  mobrain-core\n  mobrain-personal\n';

test('POST /schema/packs (draft) writes pack.json, then validates and lints', async () => {
  opsHandler = (op) => {
    if (op === 'schema.list') return ok(LIST);
    if (op === 'schema.validate') return ok('✓ valid');
    if (op === 'schema.lint') return ok('', { ok: true, errors: [], warnings: [] });
    return ok('');
  };
  const res = await hit('POST', '/api/schema/packs', ownerCookie, { mode: 'draft', draft });
  expect(res.status).toBe(200);
  expect(jsonPackWrites.at(-1)!.name).toBe('legal-ops');
  expect((jsonPackWrites.at(-1)!.manifest as any).page_types[0].path_prefixes).toEqual(['contracts/']);
});

test('POST /schema/packs refuses a name that already exists', async () => {
  opsHandler = (op) => op === 'schema.list' ? ok(INSTALLED_LEGAL_OPS) : ok('');
  const res = await hit('POST', '/api/schema/packs', ownerCookie, { mode: 'draft', draft });
  expect(res.status).toBe(409);
  expect(jsonPackWrites).toEqual([]);
});

test('POST /schema/packs rejects an invalid draft with every error', async () => {
  opsHandler = (op) => op === 'schema.list' ? ok(LIST) : ok('');
  const res = await hit('POST', '/api/schema/packs', ownerCookie,
    { mode: 'draft', draft: { ...draft, name: 'Bad Name' } });
  expect(res.status).toBe(400);
  expect((await res.json()).errors.length).toBeGreaterThan(0);
});

test('POST /schema/packs/:name/mutations refuses a bundled pack before calling gbrain', async () => {
  const calls: string[] = [];
  opsHandler = (op) => { calls.push(op); return ok(''); };
  const res = await hit('POST', '/api/schema/packs/gbrain-base-v2/mutations', ownerCookie,
    { mutations: [{ op: 'add_type', name: 'x', primitive: 'entity', prefix: 'x/' }] });
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe('PACK_READONLY');
  expect(calls).not.toContain('schema.mutate');
});

test("a failed batch answers 409 with gbrain's code and index, even though call exited 0", async () => {
  opsHandler = (op) => {
    if (op === 'schema.list') return ok(INSTALLED_LEGAL_OPS);
    if (op === 'schema.mutate') return ok(JSON.stringify({
      error: 'mutation_failed', code: 'TYPE_NOT_FOUND', message: 'no such type', failed_at_index: 1,
      mutations_applied: 0, pack_unchanged: true }));
    return ok('');
  };
  const res = await hit('POST', '/api/schema/packs/legal-ops/mutations', ownerCookie, { mutations: [
    { op: 'add_type', name: 'memo', primitive: 'annotation', prefix: 'memos/' },
    { op: 'remove_type', name: 'contract' },
  ] });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.code).toBe('TYPE_NOT_FOUND');
  expect(body.failedAtIndex).toBe(1);
  expect(body.packUnchanged).toBe(true);
  expect((await lastAudit())?.action).toBe('schema.pack.mutate.failed');
});

test('a successful batch on the ACTIVE pack scaffolds new folders into inheriting Spaces', async () => {
  await insertSpace('team', 'Team');
  const memoManifest = {
    name: 'legal-ops', version: '1.0.0', description: 'Contracts', extends: 'gbrain-base-v2',
    page_types: [{ name: 'memo', primitive: 'annotation', path_prefixes: ['memos/'], aliases: [], extractable: false }],
    link_types: [], takes_kinds: ['fact'],
  };
  opsHandler = (op, params, opts) => {
    if (op === 'schema.list') return ok(INSTALLED_LEGAL_OPS);
    if (op === 'schema.active') return ok(ACTIVE('legal-ops'));
    if (op === 'schema.mutate') {
      // gbrain applies the batch: the pack now declares memo.
      rawPacks['legal-ops']!.page_types!.push({ name: 'memo', primitive: 'annotation', path_prefixes: ['memos/'] });
      return ok(JSON.stringify({ schema_version: 1, pack: 'legal-ops', batch_id: 'b1', mutations_applied: 1, results: [{}] }));
    }
    if (op === 'schema.validate') return ok('✓ valid');
    if (op === 'schema.lint') return ok('', { ok: true, errors: [], warnings: [] });
    if (op === 'schema.show') return ok('', memoManifest);
    if (op === 'config.get') return fail(1, 'Config key not found: schema_pack.source.team');
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('POST', '/api/schema/packs/legal-ops/mutations', ownerCookie,
    { mutations: [{ op: 'add_type', name: 'memo', primitive: 'annotation', prefix: 'memos/' }] });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.applied).toBe(1);
  expect(body.scaffolded.at(-1).sourceId).toBe('team');
  expect(scaffolds.at(-1)!.entries.map((e) => e.dir)).toContain('memos/');
});

test('DELETE /schema/packs/:name refuses the active pack and any overridden Space', async () => {
  opsHandler = (op) => {
    if (op === 'schema.active') return ok(ACTIVE('legal-ops'));
    if (op === 'config.get') return fail(1, 'Config key not found');
    return ok('');
  };
  const res = await hit('DELETE', '/api/schema/packs/legal-ops', ownerCookie);
  expect(res.status).toBe(409);
  expect((await res.json()).usedBy.brain).toBe(true);
  expect(packRemoves).toEqual([]);
});

test('DELETE /schema/packs/:name removes an unused user pack', async () => {
  opsHandler = (op) => {
    if (op === 'schema.active') return ok(ACTIVE('gbrain-base-v2'));
    if (op === 'schema.list') return ok(INSTALLED_LEGAL_OPS);
    return ok('');
  };
  const res = await hit('DELETE', '/api/schema/packs/legal-ops', ownerCookie);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, removed: true });
  expect(packRemoves).toEqual(['legal-ops']);
});

test('POST /schema/scaffold scaffolds the named Space', async () => {
  await insertSpace('team', 'Team');
  const manifest = {
    name: 'gbrain-base-v2', version: '1.0.0', description: null, extends: null,
    page_types: [{ name: 'person', primitive: 'entity', path_prefixes: ['people/'], aliases: [], extractable: true }],
    link_types: [], takes_kinds: ['fact'],
  };
  opsHandler = (op) => {
    if (op === 'schema.active') return ok(ACTIVE('gbrain-base-v2'));
    if (op === 'config.get') return fail(1, 'Config key not found');
    if (op === 'schema.show') return ok('', manifest);
    return ok('');
  };
  const res = await hit('POST', '/api/schema/scaffold', ownerCookie, { source: 'team' });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.results).toEqual([{ sourceId: 'team', pack: 'gbrain-base-v2', created: ['people/README.md'], skipped: [], error: null }]);
  expect((await lastAudit())?.action).toBe('schema.scaffold');
});

test('POST /schema/scaffold rejects an unknown Space', async () => {
  opsHandler = () => { throw new Error('must not reach gbrain'); };
  expect((await hit('POST', '/api/schema/scaffold', ownerCookie, { source: 'ghost' })).status).toBe(400);
});

test('GET /schema/packs/:name reports own vs inherited and the usedBy edges', async () => {
  await insertSpace('customers');
  opsHandler = (op, params, opts) => {
    if (op === 'schema.list') return ok(INSTALLED_LEGAL_OPS);
    if (op === 'schema.active') return ok(ACTIVE('legal-ops'));
    if (op === 'schema.show') return ok('', showJson(2, 1, 'legal-ops'));
    if (op === 'schema.showRaw') {
      expect(params).toEqual({ packName: 'legal-ops' });
      return ok('', { name: 'legal-ops', page_types: [{ name: 'contract' }], link_types: [{ name: 'governs' }] });
    }
    if (op === 'config.get') return ok('legal-ops\n[config] source: db plane\n');
    return ok('');
  };
  const res = await hit('GET', '/api/schema/packs/legal-ops', ownerCookie);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.editable).toBe(true);
  expect(body.own).toEqual({ pageTypes: ['contract'], linkVerbs: ['governs'] });
  expect(body.usedBy).toEqual({ brain: true, sources: ['customers'] });
  expect(body.effective.bundled).toBe(false);
});

test('GET /schema/packs/:name 404s an unknown pack and 400s a bad name', async () => {
  opsHandler = (op) => op === 'schema.list' ? ok(LIST) : ok('');
  expect((await hit('GET', '/api/schema/packs/nope', ownerCookie)).status).toBe(404);
  expect((await hit('GET', '/api/schema/packs/Bad_Name', ownerCookie)).status).toBe(400);
});

test('member gets 403 on every authoring route', async () => {
  for (const [m, p] of [['POST', '/api/schema/packs'], ['POST', '/api/schema/packs/x/mutations'],
    ['DELETE', '/api/schema/packs/x'], ['POST', '/api/schema/scaffold']] as const) {
    const res = await app.request(p, {
      method: m,
      headers: { cookie: memberCookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  }
});

test('GET /schema/packs hides every bundled pack except gbrain-base-v2', async () => {
  opsHandler = (op, _p, opts) => {
    if (op === 'schema.list') return ok(LIST_SHIPPED);
    if (op === 'schema.active') return ok(ACTIVE('mobrain-personal'));
    if (op === 'schema.show') return ok('', showJson(3, 2, opts?.packOverride));
    return ok('');
  };
  const res = await hit('GET', '/api/schema/packs', ownerCookie);
  expect(res.status).toBe(200);
  const names = (await res.json()).packs.map((p: { name: string }) => p.name);
  expect(names).toEqual(['gbrain-base-v2', 'mobrain-personal']);
});

test('GET /schema/packs keeps a legacy active pack visible', async () => {
  opsHandler = (op, _p, opts) => {
    if (op === 'schema.list') return ok(LIST_SHIPPED);
    if (op === 'schema.active') return ok(ACTIVE('gbrain-investor'));
    if (op === 'schema.show') return ok('', showJson(3, 2, opts?.packOverride));
    return ok('');
  };
  const names = (await (await hit('GET', '/api/schema/packs', ownerCookie)).json()).packs.map((p: { name: string }) => p.name);
  expect(names).toContain('gbrain-investor');
});

test('a managed pack is reported as managed, not bundled', async () => {
  opsHandler = (op, _p, opts) => {
    if (op === 'schema.list') return ok(LIST_SHIPPED);
    if (op === 'schema.active') return ok(ACTIVE('mobrain-personal'));
    if (op === 'schema.show') return ok('', showJson(3, 2, opts?.packOverride));
    return ok('');
  };
  const packs = (await (await hit('GET', '/api/schema/packs', ownerCookie)).json()).packs;
  const mp = packs.find((p: { name: string }) => p.name === 'mobrain-personal');
  expect(mp.managed).toBe(true);
  expect(mp.bundled).toBe(false);
});

test('DELETE refuses a managed pack', async () => {
  opsHandler = () => ok(LIST_SHIPPED);
  const res = await hit('DELETE', '/api/schema/packs/mobrain-personal', ownerCookie);
  expect(res.status).toBe(400);
  expect(packRemoves).toEqual([]);
});

test('PUT /schema/pack and fork refuse managed and layer names', async () => {
  opsHandler = () => ok(LIST_SHIPPED);
  const put = await hit('PUT', '/api/schema/pack', ownerCookie, { name: 'mobrain-personal', yaml: 'name: x' });
  expect(put.status).toBe(400);
  expect(packWrites).toEqual([]);
  const fork = await hit('POST', '/api/schema/packs', ownerCookie, { mode: 'fork', from: 'gbrain-base-v2', name: 'my-personal' });
  expect(fork.status).toBe(400);
});

// --- Task 4: auto-layer edits of mobrain-personal into my-personal ---

const LIST_LAYERED = 'Bundled packs:\n  gbrain-base-v2\n\nInstalled packs (~/.gbrain/schema-packs/):\n  mobrain-personal\n  my-personal\n';
const layerRaw = (types: string[] = []) => ({
  name: 'my-personal', version: '0.1.0', extends: 'mobrain-personal',
  page_types: types.map((n) => ({ name: n, primitive: 'concept', path_prefixes: [`${n}s/`], aliases: [] })),
  link_types: [],
});

test('editing mobrain-personal creates my-personal, mutates it, and activates it', async () => {
  let listed = LIST_SHIPPED;
  let active = 'mobrain-personal';
  const mutated: string[] = [];
  opsHandler = (op, params, opts) => {
    if (op === 'schema.list') return ok(listed);
    if (op === 'schema.active') return ok(ACTIVE(active));
    if (op === 'schema.showRaw') return ok('', layerRaw());
    if (op === 'schema.show') return ok('', { ...showJson(3, 2, opts?.packOverride), extends: opts?.packOverride === 'my-personal' ? 'mobrain-personal' : null });
    if (op === 'schema.mutate') {
      mutated.push(JSON.parse(String(params.payload)).pack);
      return ok(JSON.stringify({ schema_version: 1, pack: 'my-personal', batch_id: 'b9', mutations_applied: 1, results: [{}] }));
    }
    if (op === 'schema.validate') return ok('✓ valid');
    if (op === 'schema.lint') return ok('', { ok: true, errors: [], warnings: [] });
    if (op === 'config.get') return fail(1, 'Config key not found');
    return ok('');
  };
  onJsonPackWrite = () => { listed = LIST_LAYERED; };
  onFilePlanePatch = () => { active = 'my-personal'; };

  const res = await hit('POST', '/api/schema/packs/mobrain-personal/mutations', ownerCookie,
    { mutations: [{ op: 'add_type', name: 'recipe', primitive: 'media', prefix: 'recipes/' }] });

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.pack).toBe('my-personal');
  expect(body.activated).toBe(true);
  expect(jsonPackWrites.at(-1)!.name).toBe('my-personal');
  expect(jsonPackWrites.at(-1)!.manifest.extends).toBe('mobrain-personal');
  expect(mutated).toEqual(['my-personal']);
  expect(filePlanePatches.at(-1)).toEqual({ schema_pack: 'my-personal' });
  expect(await storedPack()).toBe('my-personal');
});

test('the first edit that activates the layer scaffolds Spaces inheriting it', async () => {
  // I2: the auto-layer activation must run BEFORE resolveSourcePacks is used
  // to decide which Spaces to scaffold, or a Space inheriting the brain-wide
  // pack still resolves the OLD active pack (mobrain-personal) and is skipped.
  await insertSpace('team', 'Team');
  let listed = LIST_SHIPPED;
  let active = 'mobrain-personal';
  opsHandler = (op, params, opts) => {
    if (op === 'schema.list') return ok(listed);
    if (op === 'schema.active') return ok(ACTIVE(active));
    if (op === 'schema.showRaw') return ok('', layerRaw());
    if (op === 'schema.show') return ok('', { ...showJson(3, 2, opts?.packOverride), extends: opts?.packOverride === 'my-personal' ? 'mobrain-personal' : null });
    if (op === 'schema.mutate') return ok(JSON.stringify({ schema_version: 1, pack: 'my-personal', batch_id: 'b12', mutations_applied: 1, results: [{}] }));
    if (op === 'schema.validate') return ok('✓ valid');
    if (op === 'schema.lint') return ok('', { ok: true, errors: [], warnings: [] });
    if (op === 'config.get') return fail(1, 'Config key not found: schema_pack.source.team');
    return ok('');
  };
  onJsonPackWrite = () => { listed = LIST_LAYERED; };
  onFilePlanePatch = () => { active = 'my-personal'; };

  const res = await hit('POST', '/api/schema/packs/mobrain-personal/mutations', ownerCookie,
    { mutations: [{ op: 'add_type', name: 'recipe', primitive: 'media', prefix: 'recipes/' }] });

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.activated).toBe(true);
  expect(body.scaffolded.map((s: any) => s.sourceId)).toContain('team');
  expect(scaffolds.some((s) => s.sourceId === 'team' && s.entries.length > 0)).toBe(true);
});

test('a second edit reuses the existing layer', async () => {
  rawPacks['my-personal'] = layerRaw(['recipe']) as any;
  opsHandler = (op, _p, opts) => {
    if (op === 'schema.list') return ok(LIST_LAYERED);
    if (op === 'schema.active') return ok(ACTIVE('my-personal'));
    if (op === 'schema.showRaw') return ok('', layerRaw(['recipe']));
    if (op === 'schema.show') return ok('', { ...showJson(3, 2, opts?.packOverride), extends: 'mobrain-personal' });
    if (op === 'schema.mutate') return ok(JSON.stringify({ schema_version: 1, pack: 'my-personal', batch_id: 'b10', mutations_applied: 1, results: [{}] }));
    if (op === 'schema.validate') return ok('✓ valid');
    if (op === 'schema.lint') return ok('', { ok: true, errors: [], warnings: [] });
    if (op === 'config.get') return fail(1, 'Config key not found');
    return ok('');
  };
  const res = await hit('POST', '/api/schema/packs/mobrain-personal/mutations', ownerCookie,
    { mutations: [{ op: 'add_prefix', type: 'recipe', prefix: 'cooking/' }] });
  expect(res.status).toBe(200);
  expect(jsonPackWrites).toEqual([]);
  expect((await res.json()).activated).toBe(false);
});

test('a new type introduced earlier in the same batch may be edited later in it', async () => {
  // C1: add_type recipe then add_prefix recipe cooking/ in one batch must not
  // be refused as INHERITED_READONLY — the layer does not own `recipe` yet in
  // its raw manifest, but the batch itself introduces it first.
  const mutated: string[] = [];
  rawPacks['my-personal'] = layerRaw() as any;
  opsHandler = (op, params, opts) => {
    if (op === 'schema.list') return ok(LIST_LAYERED);
    if (op === 'schema.showRaw') return ok('', layerRaw());
    if (op === 'schema.show') return ok('', { ...showJson(3, 2, opts?.packOverride), extends: 'mobrain-personal' });
    if (op === 'schema.mutate') {
      mutated.push(JSON.parse(String(params.payload)).pack);
      return ok(JSON.stringify({ schema_version: 1, pack: 'my-personal', batch_id: 'b11', mutations_applied: 2, results: [{}, {}] }));
    }
    if (op === 'schema.validate') return ok('✓ valid');
    if (op === 'schema.lint') return ok('', { ok: true, errors: [], warnings: [] });
    if (op === 'config.get') return fail(1, 'Config key not found');
    return ok('');
  };
  const res = await hit('POST', '/api/schema/packs/mobrain-personal/mutations', ownerCookie,
    { mutations: [
      { op: 'add_type', name: 'recipe', primitive: 'media', prefix: 'recipes/' },
      { op: 'add_prefix', type: 'recipe', prefix: 'cooking/' },
    ] });
  expect(res.status).toBe(200);
  expect(mutated).toEqual(['my-personal']);
});

test('a batch that edits a still-inherited type after adding another new one is still refused', async () => {
  const calls: string[] = [];
  opsHandler = (op, _p, opts) => {
    calls.push(op);
    if (op === 'schema.list') return ok(LIST_LAYERED);
    if (op === 'schema.showRaw') return ok('', layerRaw());
    if (op === 'schema.show') return ok('', { ...showJson(3, 2, opts?.packOverride), extends: 'mobrain-personal' });
    return ok('');
  };
  const res = await hit('POST', '/api/schema/packs/mobrain-personal/mutations', ownerCookie,
    { mutations: [
      { op: 'add_type', name: 'recipe', primitive: 'media', prefix: 'recipes/' },
      { op: 'remove_type', name: 'idea' },
    ] });
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe('INHERITED_READONLY');
  expect(calls).not.toContain('schema.mutate');
});

test('changing an inherited type is refused before gbrain runs', async () => {
  const calls: string[] = [];
  opsHandler = (op, _p, opts) => {
    calls.push(op);
    if (op === 'schema.list') return ok(LIST_LAYERED);
    if (op === 'schema.showRaw') return ok('', layerRaw());
    if (op === 'schema.show') return ok('', { ...showJson(3, 2, opts?.packOverride), extends: 'mobrain-personal' });
    return ok('');
  };
  const res = await hit('POST', '/api/schema/packs/mobrain-personal/mutations', ownerCookie,
    { mutations: [{ op: 'remove_type', name: 'idea' }] });
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe('INHERITED_READONLY');
  expect(calls).not.toContain('schema.mutate');
});

test('a foreign my-personal is never hijacked', async () => {
  opsHandler = (op, _p, opts) => {
    if (op === 'schema.list') return ok(LIST_LAYERED);
    if (op === 'schema.show') return ok('', { ...showJson(3, 2, opts?.packOverride), extends: 'gbrain-base-v2' });
    return ok('');
  };
  const res = await hit('POST', '/api/schema/packs/mobrain-personal/mutations', ownerCookie,
    { mutations: [{ op: 'add_type', name: 'recipe', primitive: 'media', prefix: 'recipes/' }] });
  expect(res.status).toBe(409);
});

// --- The core lock (mobrain-core plan, Task 5): one refusal per write path ---

const LOCK_LIST =
  'Bundled packs:\n  gbrain-base\n  gbrain-base-v2\n\nInstalled packs (~/.gbrain/schema-packs/):\n' +
  '  hr-policies\n  legal-ops\n  mobrain-core\n  mobrain-personal\n  stray\n';
const lockHandler = (extra: (op: string, params: Record<string, unknown>) => OpsReply | null = () => null) =>
  (op: string, params: Record<string, unknown>): OpsReply => {
    const x = extra(op, params);
    if (x) return x;
    if (op === 'schema.list') return ok(LOCK_LIST);
    if (op === 'schema.active') return ok(ACTIVE('mobrain-core'));
    if (op === 'schema.validate') return ok('✓ valid');
    if (op === 'schema.lint') return ok('', { ok: true, errors: [], warnings: [] });
    if (op === 'config.get') return fail(1, 'Config key not found');
    return ok('');
  };
const code = async (res: Response) => (await res.json()).code;

describe_lock();
function describe_lock() {
  test('draft: an extends that does not reach core is refused before any write', async () => {
    opsHandler = lockHandler();
    const res = await hit('POST', '/api/schema/packs', ownerCookie,
      { mode: 'draft', draft: { ...draft, name: 'x-ops', extends: 'gbrain-base-v2' } });
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('CORE_LOCKED');
    expect(jsonPackWrites).toEqual([]);
  });

  test('draft: a null extends or a core-named type is an invalid draft', async () => {
    opsHandler = lockHandler();
    const nul = await hit('POST', '/api/schema/packs', ownerCookie, { mode: 'draft', draft: { ...draft, name: 'x-ops', extends: null } });
    expect(nul.status).toBe(400);
    const dup = await hit('POST', '/api/schema/packs', ownerCookie,
      { mode: 'draft', draft: { ...draft, name: 'x-ops', pageTypes: [{ ...draft.pageTypes[0]!, name: 'person' }] } });
    expect(dup.status).toBe(400);
    expect(jsonPackWrites).toEqual([]);
  });

  test('draft: an L5 failure after the write removes the new pack', async () => {
    opsHandler = lockHandler();
    // gbrain "lets the child win": the written pack redefines core's person.
    onJsonPackWrite = () => { rawPacks['mobrain-core']!.page_types = rawPacks['mobrain-core']!.page_types!.filter((t) => t.name !== 'person'); };
    const res = await hit('POST', '/api/schema/packs', ownerCookie, { mode: 'draft', draft: { ...draft, name: 'x-ops' } });
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('CORE_LOCKED');
    expect(packRemoves).toEqual(['x-ops']);
  });

  test('fork: bundled, managed and layer sources are refused; a user pack that reaches core is allowed', async () => {
    opsHandler = lockHandler();
    for (const from of ['gbrain-base-v2', 'mobrain-core', 'mobrain-personal']) {
      const res = await hit('POST', '/api/schema/packs', ownerCookie, { mode: 'fork', from, name: 'copy-ops' });
      expect(res.status).toBe(400);
      expect(await code(res)).toBe('CORE_LOCKED');
    }
    const forks: string[] = [];
    opsHandler = lockHandler((op, p) => {
      if (op !== 'schema.fork') return null;
      forks.push(String(p.from));
      rawPacks['copy-ops'] = JSON.parse(JSON.stringify(rawPacks['legal-ops']));
      return ok('');
    });
    const good = await hit('POST', '/api/schema/packs', ownerCookie, { mode: 'fork', from: 'legal-ops', name: 'copy-ops' });
    expect(good.status).toBe(200);
    expect(forks).toEqual(['legal-ops']);
  });

  test('fork: a user pack whose chain misses core is refused', async () => {
    rawPacks.stray = { name: 'stray', extends: null, page_types: [] };
    opsHandler = lockHandler();
    const res = await hit('POST', '/api/schema/packs', ownerCookie, { mode: 'fork', from: 'stray', name: 'copy-ops' });
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('CORE_LOCKED');
  });

  test('PUT: an extends that misses core, a core-named type, and a borrow are refused before the write', async () => {
    opsHandler = lockHandler();
    const put = (yaml: string) => hit('PUT', '/api/schema/pack', ownerCookie, { name: 'hr-policies', yaml });
    const miss = await put('name: hr-policies\nextends: gbrain-base-v2\n');
    expect(miss.status).toBe(400);
    expect(await code(miss)).toBe('CORE_LOCKED');
    const none = await put('name: hr-policies\n');
    expect(none.status).toBe(400);
    const redeclared = await put('name: hr-policies\nextends: mobrain-core\npage_types:\n  - name: person\n    primitive: entity\n');
    expect(redeclared.status).toBe(400);
    expect((await redeclared.json()).violations[0].rule).toBe('L2');
    const borrow = await put('name: hr-policies\nextends: mobrain-core\nborrow_from: [company-brain]\n');
    expect((await borrow.json()).violations[0].rule).toBe('L4');
    const bad = await put('name: [unclosed');
    expect(bad.status).toBe(400);
    expect(packWrites).toEqual([]);
  });

  test('PUT: an L5 failure restores the previous manifest in the format it was read; a new pack is removed', async () => {
    const previous = 'name: hr-policies\nextends: mobrain-core\n# previous\n';
    storedRaw['hr-policies'] = { format: 'yaml', text: previous };
    opsHandler = lockHandler();
    const breakCore = () => { rawPacks['mobrain-core']!.link_types = rawPacks['mobrain-core']!.link_types!.filter((l) => l.name !== 'part_of'); };
    // The pack is written, and then resolves without part_of.
    const origPut = packWrites.push.bind(packWrites);
    packWrites.push = (...a) => { breakCore(); return origPut(...a); };
    const res = await hit('PUT', '/api/schema/pack', ownerCookie, { name: 'hr-policies', yaml: 'name: hr-policies\nextends: mobrain-core\n' });
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('CORE_LOCKED');
    expect(packWrites.at(-1)).toEqual({ name: 'hr-policies', yaml: previous });
    resetPackWorld();

    storedRaw['fresh-ops'] = undefined as any; delete storedRaw['fresh-ops'];
    packRemoves.length = 0;
    packWrites.push = (...a) => { breakCore(); return origPut(...a); };
    const fresh = await hit('PUT', '/api/schema/pack', ownerCookie, { name: 'fresh-ops', yaml: 'name: fresh-ops\nextends: mobrain-core\n' });
    expect(fresh.status).toBe(400);
    expect(packRemoves).toEqual(['fresh-ops']);
    packWrites.push = origPut;
  });

  test('mutations: add_type / add_link_type / remove_type on a core name is CORE_LOCKED on any user pack', async () => {
    const calls: string[] = [];
    opsHandler = lockHandler((op) => { calls.push(op); return null; });
    for (const m of [
      { op: 'add_type', name: 'person', primitive: 'entity', prefix: 'folks/' },
      { op: 'add_link_type', name: 'part_of' },
      { op: 'add_link_type', name: 'flows', inverse: 'has_part' },
      { op: 'remove_type', name: 'person' },
      { op: 'add_prefix', type: 'note', prefix: 'jots/' },
    ]) {
      const res = await hit('POST', '/api/schema/packs/legal-ops/mutations', ownerCookie, { mutations: [m] });
      expect(res.status).toBe(400);
      expect(await code(res)).toBe('CORE_LOCKED');
    }
    expect(calls).not.toContain('schema.mutate');
  });

  test('mutations: an edit to mobrain-core goes to my-brain, which is created on core and activated', async () => {
    let listed = LOCK_LIST;
    let active = 'mobrain-core';
    const mutated: string[] = [];
    opsHandler = lockHandler((op, p) => {
      if (op === 'schema.list') return ok(listed);
      if (op === 'schema.active') return ok(ACTIVE(active));
      if (op === 'schema.mutate') {
        mutated.push(JSON.parse(String(p.payload)).pack);
        return ok(JSON.stringify({ schema_version: 1, pack: 'my-brain', batch_id: 'b20', mutations_applied: 1, results: [{}] }));
      }
      return null;
    });
    onJsonPackWrite = () => { listed = LOCK_LIST.replace('  hr-policies\n', '  hr-policies\n  my-brain\n'); };
    onFilePlanePatch = () => { active = 'my-brain'; };
    const res = await hit('POST', '/api/schema/packs/mobrain-core/mutations', ownerCookie,
      { mutations: [{ op: 'add_type', name: 'recipe', primitive: 'media', prefix: 'recipes/' }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pack).toBe('my-brain');
    expect(body.activated).toBe(true);
    expect(jsonPackWrites.at(-1)!.manifest.extends).toBe('mobrain-core');
    expect(mutated).toEqual(['my-brain']);
    expect(await storedPack()).toBe('my-brain');
  });

  test('mutations: an L5 failure after the batch is reported and never activated', async () => {
    rawPacks['legal-ops']!.extends = 'mobrain-core';
    opsHandler = lockHandler((op) => {
      if (op !== 'schema.mutate') return null;
      // The batch lands, and the resolved pack now lacks core's note type.
      rawPacks['mobrain-core']!.page_types = rawPacks['mobrain-core']!.page_types!.filter((t) => t.name !== 'note');
      return ok(JSON.stringify({ schema_version: 1, pack: 'legal-ops', batch_id: 'b21', mutations_applied: 1, results: [{}] }));
    });
    const res = await hit('POST', '/api/schema/packs/legal-ops/mutations', ownerCookie,
      { mutations: [{ op: 'add_type', name: 'memo', primitive: 'annotation', prefix: 'memos/' }] });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('CORE_LOCKED');
    expect(body.activated).toBe(false);
    expect(filePlanePatches).toEqual([]);
  });

  test('apply, sources and the wizard share one gate: a pack outside the core family is refused', async () => {
    rawPacks.stray = { name: 'stray', extends: null, page_types: [] };
    await insertSpace('customers');
    opsHandler = lockHandler();
    const apply = await hit('POST', '/api/schema/apply', ownerCookie, { pack: 'stray' });
    expect(apply.status).toBe(400);
    expect(await code(apply)).toBe('CORE_LOCKED');
    const src = await hit('POST', '/api/schema/sources/customers', ownerCookie, { pack: 'stray' });
    expect(src.status).toBe(400);
    expect(await code(src)).toBe('CORE_LOCKED');
    expect(filePlanePatches).toEqual([]);
  });

  test('apply: gbrain fallback packs skip the lock, core and Personal pass it', async () => {
    for (const pack of ['gbrain-base-v2', 'mobrain-core', 'mobrain-personal']) {
      let active = 'mobrain-core';
      opsHandler = lockHandler((op) => (op === 'schema.active' ? ok(ACTIVE(active)) : null));
      onFilePlanePatch = () => { active = pack; };
      const res = await hit('POST', '/api/schema/apply', ownerCookie, { pack });
      expect({ pack, status: res.status }).toEqual({ pack, status: 200 });
    }
  });
}

// --- Task 13: the control MCP's schema tools ---

describe('control MCP schema tools', () => {
  const OWNER_CLIENT = 'gbrain_cl_schema_owner';
  const bearer = `tok-${OWNER_CLIENT}`;
  let connId = '';

  async function tool(name: string, args: Record<string, unknown>) {
    const res = await app.request('/api/control-mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { result: { isError: boolean; structuredContent: any } }).result;
  }

  // The outer beforeEach wipes `spaces`, which the connection's FK needs, so
  // the Space and Connection are made per test and removed after it.
  beforeEach(async () => {
    const [m] = await getDb().select().from(schema.memberships).where(eq(schema.memberships.organizationId, orgId));
    const spaceId = randomUUID();
    await getDb().insert(schema.spaces).values({
      id: spaceId, organizationId: orgId, sourceId: 'mcp-space', name: 'MCP',
      kind: 'local-git', localPath: '/srv/brain-repos/mcp-space',
      // Personal, so apply's company-Space scaffold step leaves it alone.
      ownerMembershipId: m!.id,
    });
    connId = randomUUID();
    await getDb().insert(schema.connections).values({
      id: connId, organizationId: orgId, membershipId: m!.id, writeSpaceId: spaceId, readSpaceIds: [],
      harness: 'generic', clientName: `bs-mcp-${connId.slice(0, 8)}`, gbrainClientId: OWNER_CLIENT,
      profile: 'memory-writer', tokenTtl: 3600, state: 'active',
    });
  });
  afterEach(async () => {
    await getDb().delete(schema.connections).where(eq(schema.connections.id, connId));
  });

  const healthy = (op: string) => {
    if (op === 'schema.list') return ok(LIST);
    if (op === 'schema.validate') return ok('✓ hr-policies v1.0.0: valid manifest');
    if (op === 'schema.lint') return ok('', { ok: true, errors: [], warnings: [] });
    if (op === 'schema.active') return ok(ACTIVE('hr-policies'));
    // The per-test Space makes apply's post-steps read its per-source pack
    // (`config.get`) and pack detail (`schema.show`). A failed read means
    // "inherits" / "counts unknown" in those helpers, never a fabricated value.
    return fail(1, '', `not stubbed: ${op}`);
  };

  test('schema_apply previews (current pack, validation, lint) and writes nothing', async () => {
    opsHandler = (op) => (op === 'schema.active' ? ok(ACTIVE('gbrain-base-v2')) : healthy(op));
    const p = await tool('schema_apply', { pack: 'hr-policies' });
    expect(p.isError).toBe(false);
    expect(p.structuredContent).toMatchObject({ preview: true, summary: { from: 'gbrain-base-v2', to: 'hr-policies' } });
    expect(filePlanePatches).toEqual([]);
    expect(await storedPack()).toBeNull();
  });

  test('schema_apply confirmed writes tier 6 exactly as the console does', async () => {
    opsHandler = (op) => (op === 'schema.active' ? ok(ACTIVE('gbrain-base-v2')) : healthy(op));
    const p = await tool('schema_apply', { pack: 'hr-policies' });
    opsHandler = (op) => {
      // The confirm re-runs the preview (still on base), then the route reads back hr-policies.
      if (op === 'schema.active') { opsHandler = healthy; return ok(ACTIVE('gbrain-base-v2')); }
      return healthy(op);
    };
    const r = await tool('schema_apply', { pack: 'hr-policies', confirm: p.structuredContent.confirmToken });
    expect(r.isError).toBe(false);
    expect(filePlanePatches).toEqual([{ schema_pack: 'hr-policies' }]);
    expect(await storedPack()).toBe('hr-policies');
  });

  test('schema_apply divergence is an error result, never a green', async () => {
    opsHandler = (op) => (op === 'schema.active' ? ok(ACTIVE('gbrain-base-v2')) : healthy(op));
    const p = await tool('schema_apply', { pack: 'hr-policies' });
    let actives = 0;
    opsHandler = (op) => {
      if (op === 'schema.active') return ++actives === 1 ? ok(ACTIVE('gbrain-base-v2')) : ok(ACTIVE('other-pack', 'db-config'));
      return healthy(op);
    };
    const r = await tool('schema_apply', { pack: 'hr-policies', confirm: p.structuredContent.confirmToken });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.status).toBe(409);
    expect(await storedPack()).toBeNull();
  });

  test('schema_sync with scope brain runs the apply sync and is audited', async () => {
    opsHandler = (op, params) => {
      if (op === 'schema.sync') {
        expect(params.apply).toBe(true);
        return ok('', { total_applied: 3, total_would_apply: 3 });
      }
      throw new Error(`unexpected op ${op}`);
    };
    const r = await tool('schema_sync', { scope: 'brain' });
    expect(r.isError).toBe(false);
    expect(r.structuredContent.total_applied).toBe(3);
    const rows = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, 'schema.sync'));
    expect(rows.length).toBe(1);
  });

  test('schema_sync with no scope is refused before gbrain runs', async () => {
    opsHandler = (op) => { throw new Error(`unexpected op ${op}`); };
    const r = await tool('schema_sync', {});
    expect(r.structuredContent.error).toBe('invalid_arguments');
  });

  test('schema_sync with scope source and no source is refused before gbrain runs', async () => {
    // A named one-Space fence must never degrade into the brain-wide apply:
    // dropping `source` from the body would read as "no fence" at the route.
    let reached = 0;
    opsHandler = (op) => { reached += 1; throw new Error(`unexpected op ${op}`); };
    const r = await tool('schema_sync', { scope: 'source' });
    expect(reached).toBe(0);
    expect(r.isError).toBe(true);
    expect(r.structuredContent.status).toBe(400);
    expect(r.structuredContent.error).toMatch(/unknown source/);
  });
});
