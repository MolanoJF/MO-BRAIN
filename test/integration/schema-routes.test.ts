import { test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(48);
process.env.BETTER_AUTH_SECRET ??= 'b'.repeat(48);
process.env.CONTROL_DATABASE_URL ??=
  'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';
process.env.PUBLIC_URL ??= 'http://127.0.0.1:3131';

const PASS = 'correct-horse-battery-staple-1';

// The ops seam. Each test sets `opsHandler` to decide what gbrain "answers".
type OpsReply = { ok: boolean; exitCode: number; stdout: string; stderr: string; json: unknown };
type CallOpts = { json?: boolean; dryRun?: boolean; timeoutMs?: number; packOverride?: string };
let opsHandler: (op: string, params: Record<string, unknown>, opts?: CallOpts) => OpsReply;
const filePlanePatches: Record<string, unknown>[] = [];
const packWrites: { name: string; yaml: string }[] = [];

mock.module('../../src/control/opsClient.ts', () => ({
  // --- the three this suite drives ---
  callOps: async (op: string, params: Record<string, unknown> = {}, opts?: CallOpts) => opsHandler(op, params, opts),
  patchFilePlaneConfig: async (patch: Record<string, unknown>) => { filePlanePatches.push(patch); },
  putSchemaPack: async (name: string, yaml: string) => { packWrites.push({ name, yaml }); },
  putSchemaPackJson: async () => {},
  removeSchemaPack: async () => ({ removed: false }),
  // --- the rest of the module's real exports, required for the app graph to
  //     load at all under per-file isolation. Copy verbatim from
  //     test/integration/routes.test.ts and keep in sync with opsClient.ts. ---
  brainUsage: async () => { throw new Error('ops unreachable'); },
  seedSpace: async () => {},
  resetBrainSchema: async () => {},
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
const LIST = 'Bundled packs:\n  gbrain-base\n  gbrain-base-v2\n\nInstalled packs (~/.gbrain/schema-packs/):\n  hr-policies\n';
const LIST_WITH_CREATOR = 'Bundled packs:\n  gbrain-base\n  gbrain-creator\n\nInstalled packs (~/.gbrain/schema-packs/):\n  hr-policies\n';
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
  expect(body.packs).toEqual(['gbrain-base', 'gbrain-base-v2', 'hr-policies']);
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

test('PUT /schema/pack writes the manifest then validates it', async () => {
  opsHandler = (op) => {
    if (op === 'schema.validate') return ok('✓ hr-policies v1.0.0: valid manifest');
    if (op === 'schema.lint') return ok('', { ok: true, errors: [], warnings: [] });
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('PUT', '/api/schema/pack', ownerCookie,
    { name: 'hr-policies', yaml: 'api_version: gbrain-schema-pack-v1\n' });
  expect(res.status).toBe(200);
  expect(packWrites).toEqual([{ name: 'hr-policies', yaml: 'api_version: gbrain-schema-pack-v1\n' }]);
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
  await hit('PUT', '/api/schema/pack', ownerCookie, { name: 'hr-policies', yaml: 'secret-marker-do-not-log' });
  expect(JSON.stringify(await lastAudit())).not.toContain('secret-marker-do-not-log');
});

test('GET /schema/packs reports EFFECTIVE counts, not the raw manifest', async () => {
  // The regression: `gbrain-creator`'s raw file declares 1 page type but its
  // effective manifest is 27 (S4). Reading the raw positional manifest here
  // would show 1; this asserts the resolved count comes through gbrain's own
  // resolver via the packOverride env seam.
  opsHandler = (op, params, opts) => {
    if (op === 'schema.list') return ok(LIST_WITH_CREATOR);
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
  opsHandler = (op, params) => {
    if (op === 'schema.list') return ok(LIST);
    if (op === 'schema.validate') return ok('✓ hr-policies v1.0.0: valid manifest');
    if (op === 'schema.lint') return ok('', { ok: true, errors: [], warnings: [] });
    if (op === 'config.set') {
      expect(params).toEqual({ key: 'schema_pack.source.customers', value: 'hr-policies', force: true });
      return ok('Set schema_pack.source.customers = hr-policies');
    }
    if (op === 'config.get') return ok('hr-policies\n[config] source: db plane\n');
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
