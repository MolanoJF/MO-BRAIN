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
const opsCalls: { op: string; params: Record<string, unknown>; opts?: CallOpts }[] = [];
const seedCalls: string[] = [];

mock.module('../../src/control/opsClient.ts', () => ({
  callOps: async (op: string, params: Record<string, unknown> = {}, opts?: CallOpts) => {
    opsCalls.push({ op, params, opts });
    return opsHandler(op, params, opts);
  },
  patchFilePlaneConfig: async () => {},
  putSchemaPack: async () => {},
  putSchemaPackJson: async () => {},
  gitScaffold: async () => ({ created: [], skipped: [], sha: null }),
  removeSchemaPack: async () => ({ removed: false }),
  seedSpace: async (sourceId: string) => { seedCalls.push(sourceId); },
  // --- the rest of the module's real exports, required for the app graph to
  //     load at all under per-file isolation. Copy verbatim from
  //     test/integration/schema-routes.test.ts and keep in sync with opsClient.ts. ---
  brainUsage: async () => { throw new Error('ops unreachable'); },
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
  const headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.11' };
  if (cookie) headers.cookie = cookie;
  // DELETE carries a body here (`{ mode, confirm }`), so a body is sent
  // whenever one is explicitly provided, whatever the method.
  const hasBody = body !== undefined;
  if (hasBody) headers['content-type'] = 'application/json';
  return app.request(path, { method, headers, body: hasBody ? JSON.stringify(body) : undefined });
}

const ok = (stdout: string, json: unknown = null): OpsReply =>
  ({ ok: true, exitCode: 0, stdout, stderr: '', json });
const fail = (exitCode: number, stdout: string, stderr = ''): OpsReply =>
  ({ ok: false, exitCode, stdout, stderr, json: null });

const ACTIVE = (pack: string, source = 'home-config') =>
  `Active pack: ${pack} v1.0.0\nSource: ${source}\nPack identity: ${pack}@1.0.0+deadbeef\nPage types: 19\nLink verbs: 17\n`;

const showJson = (pageTypes: number, linkTypes: number) => ({
  name: 'gbrain-base-v2', version: '1.0.0', description: 'a pack', extends: null,
  page_types: Array.from({ length: pageTypes }, (_, i) => ({
    name: `type-${i}`, primitive: 'concept', path_prefixes: [`p${i}/`], aliases: [], extractable: true,
  })),
  link_types: Array.from({ length: linkTypes }, (_, i) => ({ name: `verb-${i}` })),
  takes_kinds: ['fact'],
});

async function insertSpace(sourceId: string, name = sourceId) {
  await getDb().insert(schema.spaces).values({
    id: randomUUID(), organizationId: orgId, sourceId, name,
    kind: 'local-git', localPath: `/srv/brain-repos/${sourceId}`,
  });
}

const spaceRow = async (sourceId: string) => {
  const [row] = await getDb().select().from(schema.spaces).where(eq(schema.spaces.sourceId, sourceId));
  return row ?? null;
};
const unsetCalls = () => opsCalls.filter((c) => c.op === 'config.unset');
const lastAudit = async () => {
  const [row] = await getDb().select().from(schema.auditLog)
    .where(eq(schema.auditLog.organizationId, orgId))
    .orderBy(desc(schema.auditLog.at)).limit(1);
  return row;
};

beforeAll(async () => {
  await runMigrations();
  for (const t of [
    schema.claimLinks, schema.connections, schema.spaces, schema.secrets, schema.auditLog,
    schema.sessions, schema.accounts, schema.verifications,
    schema.memberships, schema.brains, schema.organizations, schema.users,
  ]) {
    await getDb().delete(t);
  }
  const boot = await bootstrapFirstAdmin('sources-owner@example.test', PASS, 'SourcesCo');
  orgId = boot.orgId;
  ownerCookie = await signIn('sources-owner@example.test', PASS);
  memberCookie = await makeMember('sources-member@example.test');
});

beforeEach(async () => {
  opsCalls.length = 0;
  seedCalls.length = 0;
  invalidateSchemaPackCache();
  await getDb().delete(schema.auditLog);
  await getDb().delete(schema.spaces);
});

afterAll(async () => {
  await closeDb();
});

test('GET /sources joins live gbrain counts and flags an unregistered source', async () => {
  await insertSpace('customers', 'Customers');
  opsHandler = (op, params, opts) => {
    if (op === 'sources.list') {
      expect(opts?.json).toBe(true);
      return ok('', {
        sources: [
          { id: 'customers', name: 'Customers', local_path: '/srv/brain-repos/customers', federated: true, page_count: 7, last_sync_at: '2026-09-17T06:12:52.152Z' },
          { id: 'legacy', name: 'Legacy', local_path: null, federated: false, page_count: 2, last_sync_at: null },
        ],
      });
    }
    if (op === 'config.get') return fail(1, 'Config key not found: schema_pack.source.customers');
    if (op === 'schema.active') return ok(ACTIVE('gbrain-base-v2'));
    if (op === 'schema.show') return ok('', showJson(19, 17));
    throw new Error(`unexpected op ${op}`);
  };

  const res = await hit('GET', '/api/sources', ownerCookie);
  expect(res.status).toBe(200);
  const body = await res.json();
  const customers = body.sources.find((s: any) => s.sourceId === 'customers');
  expect(customers).toMatchObject({
    name: 'Customers', kind: 'local-git', pageCount: 7,
    lastSyncAt: '2026-09-17T06:12:52.152Z', federated: true, inGbrain: true,
    pack: 'gbrain-base-v2', tier: 'home-config', inherited: true,
  });
  expect(body.unregistered).toEqual(['legacy']);
  expect(body.sourcesListOk).toBe(true);
});

test('GET /sources reports null counts when sources.list fails, never 0', async () => {
  await insertSpace('customers', 'Customers');
  opsHandler = (op) => {
    if (op === 'sources.list') return fail(1, '', 'ops down');
    if (op === 'config.get') return fail(1, 'Config key not found: schema_pack.source.customers');
    if (op === 'schema.active') return ok(ACTIVE('gbrain-base-v2'));
    if (op === 'schema.show') return ok('', showJson(19, 17));
    throw new Error(`unexpected op ${op}`);
  };
  const body = await (await hit('GET', '/api/sources', ownerCookie)).json();
  expect(body.sources[0].pageCount).toBeNull();
  expect(body.sources[0].inGbrain).toBe(false);
  expect(body.unregistered).toEqual([]);
  expect(body.sourcesListOk).toBe(false);
});

test('POST /sources adds a Space through the shared wizard helper', async () => {
  opsHandler = (op, params) => {
    if (op === 'sources.add') {
      expect(params).toMatchObject({ id: 'marketing', path: '/srv/brain-repos/marketing', federated: true });
      return ok('Created source "marketing"');
    }
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('POST', '/api/sources', ownerCookie, { sourceId: 'marketing', name: 'Marketing' });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, sourceId: 'marketing' });
  expect(body.isolationNotice).toMatch(/NOT access boundaries/);
  expect(seedCalls).toEqual(['marketing']);
  expect(await spaceRow('marketing')).toMatchObject({ name: 'Marketing', kind: 'local-git' });
  expect((await lastAudit())?.action).toBe('source.add');
});

test('POST /sources rejects an invalid source id and a duplicate Space', async () => {
  opsHandler = () => { throw new Error('must not reach gbrain'); };
  expect((await hit('POST', '/api/sources', ownerCookie, { sourceId: '../etc', name: 'Bad' })).status).toBe(400);

  await insertSpace('shared', 'Shared');
  const dup = await hit('POST', '/api/sources', ownerCookie, { sourceId: 'shared', name: 'Again' });
  expect(dup.status).toBe(409);
  expect((await dup.json()).error).toMatch(/already a Source/);
});

test('PATCH /sources/:sourceId renames and updates the spaces row', async () => {
  await insertSpace('customers', 'Customers');
  opsHandler = (op, params) => {
    if (op === 'sources.rename') {
      expect(params).toEqual({ id: 'customers', newName: 'Customers Ltd' });
      return ok('Renamed source "customers"');
    }
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('PATCH', '/api/sources/customers', ownerCookie, { name: 'Customers Ltd' });
  expect(res.status).toBe(200);
  expect(await spaceRow('customers')).toMatchObject({ name: 'Customers Ltd' });
  expect((await lastAudit())?.action).toBe('source.rename');
});

test('DELETE /sources/:sourceId defaults to archive and clears the pack key', async () => {
  await insertSpace('customers', 'Customers');
  opsHandler = (op) => {
    if (op === 'sources.archive') return ok('Source "customers" archived (soft-deleted).');
    if (op === 'config.unset') return ok('Unset schema_pack.source.customers');
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('DELETE', '/api/sources/customers', ownerCookie);
  expect(res.status).toBe(200);
  expect((await res.json()).mode).toBe('archive');
  expect(await spaceRow('customers')).toBeNull();
  expect(unsetCalls().map((c) => c.params.key)).toEqual(['schema_pack.source.customers']);
  expect((await lastAudit())?.action).toBe('source.archive');
});

test('DELETE /sources/:sourceId remove requires confirmation and previews first', async () => {
  await insertSpace('customers', 'Customers');
  opsHandler = (op, params) => {
    if (op === 'sources.remove') {
      expect(params.dryRun).toBe(true);
      return ok('DESTRUCTIVE OPERATION — Impact Preview\nPages: 3 Chunks: 9 Embeddings: 9');
    }
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('DELETE', '/api/sources/customers', ownerCookie, { mode: 'remove' });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.error).toBe('confirmation_required');
  expect(body.preview).toMatch(/Impact Preview/);
  // Nothing was deleted without confirmation.
  expect(await spaceRow('customers')).not.toBeNull();
  expect(opsCalls.filter((c) => c.op === 'sources.remove')).toHaveLength(1);
  expect(unsetCalls()).toHaveLength(0);
});

test('DELETE /sources/:sourceId remove cascades when confirmed and cleans up', async () => {
  await insertSpace('customers', 'Customers');
  opsHandler = (op, params) => {
    if (op === 'sources.remove' && params.dryRun === true) return ok('Impact Preview: 3 pages');
    if (op === 'sources.remove' && params.confirmDestructive === true) return ok('Removed source "customers".');
    if (op === 'config.unset') return ok('Unset schema_pack.source.customers');
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('DELETE', '/api/sources/customers', ownerCookie, { mode: 'remove', confirm: true });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, mode: 'remove', sourceId: 'customers' });
  expect(body.preview).toMatch(/Impact Preview/);
  expect(await spaceRow('customers')).toBeNull();
  expect(unsetCalls().map((c) => c.params.key)).toEqual(['schema_pack.source.customers']);
  expect((await lastAudit())?.action).toBe('source.remove');
});

test('a non-admin cannot reach the sources routes', async () => {
  opsHandler = () => { throw new Error('must not reach gbrain'); };
  expect((await hit('GET', '/api/sources', memberCookie)).status).toBe(403);
  expect((await hit('POST', '/api/sources', memberCookie, { sourceId: 'x', name: 'X' })).status).toBe(403);
});
