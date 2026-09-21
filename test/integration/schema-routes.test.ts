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
let opsHandler: (op: string, params: Record<string, unknown>) => OpsReply;
const filePlanePatches: Record<string, unknown>[] = [];
const packWrites: { name: string; yaml: string }[] = [];

mock.module('../../src/control/opsClient.ts', () => ({
  // --- the three this suite drives ---
  callOps: async (op: string, params: Record<string, unknown> = {}) => opsHandler(op, params),
  patchFilePlaneConfig: async (patch: Record<string, unknown>) => { filePlanePatches.push(patch); },
  putSchemaPack: async (name: string, yaml: string) => { packWrites.push({ name, yaml }); },
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
const ACTIVE = (pack: string, source = 'home-config') =>
  `Active pack: ${pack} v1.0.0\nSource: ${source}\nPack identity: ${pack}@1.0.0+deadbeef\nPage types: 3\nLink verbs: 2\n`;

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
  await setStoredPack(null);
  await getDb().delete(schema.auditLog);
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

test('a non-admin cannot reach any schema route', async () => {
  opsHandler = () => { throw new Error('must not reach gbrain'); };
  expect((await hit('GET', '/api/schema', memberCookie)).status).toBe(403);
  expect((await hit('POST', '/api/schema/apply', memberCookie, { pack: 'gbrain-base' })).status).toBe(403);
});
