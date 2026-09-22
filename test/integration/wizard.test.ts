import { mock, test, expect, describe, beforeAll, afterAll } from 'bun:test';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(48);
process.env.BETTER_AUTH_SECRET ??= 'b'.repeat(48);
process.env.CONTROL_DATABASE_URL ??=
  'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';

// Slice 0 stack is down; unit-cover seedSpaceRepo separately. Mock the ops
// boundary so wizard control-plane logic (lifecycle, secrets, Space=source)
// is exercised without a live gbrain binary.
//
// The FULL ops surface is listed, not just the calls this file makes: the app's
// import graph links routes whose modules name every export, and a partial
// `mock.module` factory makes this file fail to load when it runs alone (the
// Slice 4 `mock.module` hazard). Mirrors test/integration/spend.test.ts.
const callOpsCalls: {
  op: string; opts?: { json?: boolean; timeoutMs?: number }; params?: Record<string, unknown>;
}[] = [];
let resetBrainSchemaCalls = 0;
let grantSeq = 0;
const seedSpaceCalls: string[] = [];
// Task 9: the JSON pack writes the wizard's schema step makes through the file
// plane, recorded so the draft branch's manifest can be asserted.
const jsonPackWrites: { name: string; manifest: object }[] = [];
// Task 6: op ids in call order, and where the scaffold landed inside that order.
// `scaffoldAt` is stamped by the gitScaffold mock, which is not a callOps call.
const opsOrder: string[] = [];
const scaffolds: { sourceId: string; entries: { dir: string; readme: string }[] }[] = [];
let scaffoldAt = -1;

mock.module('../../src/control/opsClient.ts', () => ({
  callOps: async (
    op: string,
    params?: Record<string, unknown>,
    opts?: { json?: boolean; timeoutMs?: number; packOverride?: string },
  ) => {
    callOpsCalls.push({ op, opts, params });
    opsOrder.push(op);
    // The wizard's schema step calls gbrain's own validate + lint on a written
    // draft; both are DB-free at the pin (S7 probe 7). A clean envelope is what
    // lets the draft advance the lifecycle.
    if (op === 'schema.validate') {
      return {
        ok: true, exitCode: 0, argv: ['gbrain', 'schema', 'validate'],
        stdout: '✓ valid', stderr: '', json: null,
      };
    }
    if (op === 'schema.lint') {
      return {
        ok: true, exitCode: 0, argv: ['gbrain', 'schema', 'lint'],
        stdout: '', stderr: '', json: { ok: true, errors: [], warnings: [] },
      };
    }
    // A Space resolves its pack through the brain-wide active pack when no
    // per-source override is stored, so `config.get` must read back absent.
    if (op === 'config.get') {
      return {
        ok: false, exitCode: 1, argv: ['gbrain', 'config', 'get'],
        stdout: '', stderr: 'Config key not found', json: null,
      };
    }
    // effectivePack resolves through `schema show` with the packOverride seam.
    if (op === 'schema.show') {
      return {
        ok: true, exitCode: 0, argv: ['gbrain', 'schema', 'show'],
        stdout: '', stderr: '',
        json: {
          name: opts?.packOverride ?? 'gbrain-base-v2',
          page_types: [{ name: 'person', primitive: 'entity', path_prefixes: ['people/'] }],
        },
      };
    }
    // Private-space provisioning grants a Connection through mcp.grant; the
    // envelope below is what provisionConnection reads back to record the grant.
    const json = op === 'mcp.grant'
      ? {
          client_id: `gbrain_cl_mock_${grantSeq++}`,
          mcp_url: 'http://127.0.0.1:3131/mcp',
          profile: 'memory-writer',
          harness: 'generic',
          source_id: params?.source,
          expires_at: null,
          renewable: true,
          credentials: 'private-file',
        }
      : null;
    return {
      ok: true,
      exitCode: 0,
      argv: ['gbrain', ...op.split('.')],
      stdout: op === 'schema.list'
        ? 'Bundled packs:\n  gbrain-base-v2\n'
        : op === 'schema.active'
          ? 'Active pack: gbrain-base-v2 v2.0.0\nSource: home-config\n'
          : 'ok',
      stderr: '',
      json,
    };
  },
  brainUsage: async () => { throw new Error('ops unreachable'); },
  writeReport: async () => ({ relPath: '', committed: false, sha: null }),
  cancelRun: async () => ({ cancelled: false }),
  patchFilePlaneConfig: async () => {},
  putSchemaPack: async () => {},
  putSchemaPackJson: async (name: string, manifest: object) => { jsonPackWrites.push({ name, manifest }); },
  gitScaffold: async (req: { sourceId: string; entries: { dir: string; readme: string }[] }) => {
    scaffoldAt = opsOrder.length;
    scaffolds.push({ sourceId: req.sourceId, entries: req.entries });
    return { created: req.entries.map((e) => `${e.dir}README.md`), skipped: [], sha: 'scaffold-sha' };
  },
  removeSchemaPack: async () => ({ removed: false }),
  seedSpace: async (sourceId: string) => { seedSpaceCalls.push(sourceId); },
  resetBrainSchema: async () => { resetBrainSchemaCalls += 1; },
  takeGrantCredentials: async () => ({
    version: 1,
    mcp_url: 'http://127.0.0.1:3131/mcp',
    client_id: 'gbrain_cl_mock_handoff',
    client_secret: 'not-a-real-secret-not-a-real-secret-not-a-real',
  }),
  deleteCredentialJournal: async () => ({ deleted: true }),
  auditTail: async () => [],
  opsHealthy: async () => true,
  commitAsMember: async () => ({ committed: false, sha: null }),
  inspectRepos: async () => [],
  gitRange: async () => ({ sourceId: '', before: '', after: '', commits: [], files: [] }),
  gitPathExists: async () => ({ sourceId: '', paths: [] }),
  gitRevertRange: async () => ({ reverted: false, reason: 'nothing_to_revert' }),
  // S1: routes/files.ts imports these alongside the rest, so a mock that omits
  // them makes the whole app graph unloadable.
  gitTree: async (sourceId: string) => ({ sourceId, root: `/repos/${sourceId}`, entries: [] }),
  gitReadFile: async (sourceId: string, path: string) => ({ content: '', sha: '', size: 0 }),
  gitWriteFile: async (req: { sourceId: string; path: string; content: string; expectedSha: string }) =>
    ({ committed: true, sha: 'written-sha' }),
}));

const { default: app } = await import('../../src/control/app.ts');
const { runMigrations, getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { bootstrapFirstAdmin } = await import('../../src/control/bootstrap.ts');
const { eq, and } = await import('drizzle-orm');

// Pin at module load so a sibling file cannot close the pool before our beforeAll.
pinDb();

let cookie = '';
let orgId = '';
let adminMembershipId = '';

beforeAll(async () => {
  await runMigrations();
  for (const t of [
    schema.claimLinks, schema.connections, schema.spaces, schema.secrets, schema.auditLog,
    schema.sessions, schema.accounts, schema.verifications,
    schema.memberships, schema.brains, schema.organizations, schema.users,
  ]) {
    await getDb().delete(t);
  }
  ({ orgId } = await bootstrapFirstAdmin('admin@example.test', 'a-long-enough-password', 'Acme'));

  const res = await app.request('/api/auth/sign-in/email', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.test', password: 'a-long-enough-password' }),
  });
  cookie = res.headers.get('set-cookie') ?? '';
}, 90_000);

afterAll(async () => {
  await closeDb();
});

const call = (path: string, body?: unknown) =>
  app.request(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });

type WizardState = {
  lifecycle: string;
  nextStep: string | null;
  searchModes: unknown[];
  isolationNotice: string;
};

describe('wizard', () => {
  test('state starts at uninitialized with provider as the next step', async () => {
    const body = await (await call('/api/wizard/state')).json() as WizardState;
    expect(body.lifecycle).toBe('uninitialized');
    expect(body.nextStep).toBe('provider-configured');
  });

  test('state exposes the search-mode cost matrix', async () => {
    const body = await (await call('/api/wizard/state')).json() as WizardState;
    expect(body.searchModes.length).toBeGreaterThanOrEqual(3);
  });

  test('a step cannot be skipped', async () => {
    expect((await call('/api/wizard/schema', { pack: 'gbrain-base-v2' })).status).toBe(409);
  });

  // The provider key goes to the FILE plane and our secrets table — never to
  // gbrain's DB plane (V11), and never back over the wire.
  test('the provider step stores the key encrypted and advances', async () => {
    const res = await call('/api/wizard/provider', {
      provider: 'openai', apiKey: 'sk-wizard-test-key',
      embeddingModel: 'openai:text-embedding-3-small',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('sk-wizard-test-key');

    const [row] = await getDb().select().from(schema.secrets)
      .where(eq(schema.secrets.organizationId, orgId));
    expect(row?.name).toBe('openai_api_key');
    expect(JSON.stringify(row)).not.toContain('sk-wizard-test-key');

    const [brain] = await getDb().select().from(schema.brains);
    expect(brain?.lifecycle).toBe('provider-configured');
  });

  test('the search-mode step records the choice', async () => {
    expect((await call('/api/wizard/search-mode', { mode: 'conservative' })).status).toBe(200);
    const [brain] = await getDb().select().from(schema.brains);
    expect(brain?.searchMode).toBe('conservative');
    expect(brain?.lifecycle).toBe('mode-selected');
  });

  test('an unknown search mode is rejected', async () => {
    expect((await call('/api/wizard/search-mode', { mode: 'turbo' })).status).toBe(400);
  });

  // A fresh install's wizard creates exactly ONE source: the signed-in
  // member's own private Space. Shared Spaces come later from the Sources page.
  test('the private-space step creates the admin\'s own private source', async () => {
    expect((await call('/api/wizard/schema', { pack: 'gbrain-base-v2' })).status).toBe(200);
    const res = await call('/api/wizard/private-space', {});
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; lifecycle: string; sourceId: string };
    expect(body.ok).toBe(true);
    expect(body.lifecycle).toBe('sources-added');
    expect(body.sourceId).toMatch(/^my-space-/);

    const [admin] = await getDb().select().from(schema.users)
      .where(eq(schema.users.email, 'admin@example.test'));
    const [membership] = await getDb().select().from(schema.memberships).where(and(
      eq(schema.memberships.userId, admin!.id),
      eq(schema.memberships.organizationId, orgId),
    ));
    adminMembershipId = membership!.id;

    const [space] = await getDb().select().from(schema.spaces).where(and(
      eq(schema.spaces.organizationId, orgId),
      eq(schema.spaces.sourceId, body.sourceId),
    ));
    expect(space?.ownerMembershipId).toBe(adminMembershipId);
  });

  test('a second private-space POST is idempotent and creates no second space', async () => {
    const res = await call('/api/wizard/private-space', {});
    expect(res.status).toBe(200);
    const body = await res.json() as { lifecycle: string; sourceId: string };
    expect(body.lifecycle).toBe('sources-added');

    const owned = await getDb().select().from(schema.spaces).where(and(
      eq(schema.spaces.organizationId, orgId),
      eq(schema.spaces.ownerMembershipId, adminMembershipId),
    ));
    expect(owned.length).toBe(1);
  });

  // S4b: Space = source is a HARD RULE, surfaced as a blocking choice.
  test('the space step refuses a duplicate source id', async () => {
    await call('/api/wizard/schema', { pack: 'gbrain-base-v2' });
    expect((await call('/api/wizard/space', { sourceId: 'shared', name: 'Shared' })).status).toBe(200);
    const dup = await call('/api/wizard/space', { sourceId: 'shared', name: 'Shared again' });
    expect(dup.status).toBe(409);
    expect((await dup.json() as { error: string }).error).toMatch(/already a Source/i);
  });

  test('the space step rejects an invalid source id', async () => {
    const res = await call('/api/wizard/space', { sourceId: '../etc', name: 'Bad' });
    expect(res.status).toBe(400);
  });

  test('state carries the isolation warning for the space step', async () => {
    const body = await (await call('/api/wizard/state')).json() as WizardState;
    expect(body.isolationNotice).toMatch(/every member with read on that Source/i);
  });

  // Critical fix: old shared run() always passed json:true, which hard-fails
  // init and config.set (supportsJson: false) in buildArgv / ops RPC.
  test('finish does not pass json:true for init or config.set', async () => {
    callOpsCalls.length = 0;
    resetBrainSchemaCalls = 0;
    const res = await call('/api/wizard/finish', {});
    expect(res.status).toBe(200);
    // Worker cold-start compensation: wipe before init (must not be a silent no-op).
    expect(resetBrainSchemaCalls).toBe(1);
    const byOp = Object.fromEntries(callOpsCalls.map((c) => [c.op, c.opts]));
    expect(byOp.init?.json).not.toBe(true);
    expect(byOp['config.set']?.json).not.toBe(true);
    expect(byOp['sources.add']?.json).not.toBe(true);
    expect(byOp.sync?.json).toBe(true);
    expect(byOp.embed?.json).toBe(true);
    expect(byOp.doctor?.json).toBe(true);
    expect(callOpsCalls.some((c) => c.op === 'sources.add')).toBe(true);
    const [brain] = await getDb().select().from(schema.brains);
    expect(brain?.lifecycle).toBe('ready');
  });

  // The follow-up: once the brain is ready, finishing the wizard also gives the
  // bootstrapped admin/owner their private "My Space" — source seeded and
  // registered, one active writer Connection pointing at it.
  test('finish gives the bootstrapped owner a private source and connection', async () => {
    const [admin] = await getDb().select().from(schema.users)
      .where(eq(schema.users.email, 'admin@example.test'));
    const [membership] = await getDb().select().from(schema.memberships).where(and(
      eq(schema.memberships.userId, admin!.id),
      eq(schema.memberships.organizationId, orgId),
    ));
    expect(membership).toBeDefined();

    const owned = await getDb().select().from(schema.spaces).where(and(
      eq(schema.spaces.organizationId, orgId),
      eq(schema.spaces.ownerMembershipId, membership!.id),
    ));
    expect(owned.length).toBe(1);
    expect(owned[0]!.sourceId).toMatch(/^my-space-/);
    const space = owned[0]!;

    const [conn] = await getDb().select().from(schema.connections).where(and(
      eq(schema.connections.organizationId, orgId),
      eq(schema.connections.membershipId, membership!.id),
      eq(schema.connections.writeSpaceId, space.id),
      eq(schema.connections.state, 'active'),
    ));
    expect(conn).toBeDefined();
    // The bootstrapped admin is role `owner`; a private Space is always
    // writer-or-better, and owner compiles to coding-agent.
    expect(['memory-writer', 'coding-agent']).toContain(conn?.profile ?? '');

    expect(seedSpaceCalls).toContain(space.sourceId);
    expect(callOpsCalls.some((c) => c.op === 'sources.add' && c.params?.id === space.sourceId)).toBe(true);
  });

  // Task 6 — a new brain's Spaces are scaffolded from the pack each resolves,
  // after every source is registered and before the first sync.
  test('finish scaffolds every Space from its pack, after sources.add and before sync', async () => {
    await getDb().update(schema.brains).set({ lifecycle: 'sources-added' });
    const spaceIds = (await getDb().select().from(schema.spaces)).map((s) => s.sourceId);
    opsOrder.length = 0;
    scaffolds.length = 0;
    scaffoldAt = -1;

    const res = await call('/api/wizard/finish', {});
    const body = await res.json() as { scaffold: { sourceId: string; error: string | null }[] };
    expect(res.status).toBe(200);

    expect(scaffolds.map((s) => s.sourceId)).toEqual(spaceIds); // every Space
    expect(scaffolds[0]!.entries.map((e) => e.dir)).toContain('people/');
    // Ordering: scaffold happens after every sources.add and BEFORE sync.
    expect(opsOrder.indexOf('sync')).toBeGreaterThan(opsOrder.lastIndexOf('sources.add'));
    expect(scaffoldAt).toBeGreaterThan(opsOrder.lastIndexOf('sources.add'));
    expect(scaffoldAt).toBeLessThan(opsOrder.indexOf('sync'));
    expect(body.scaffold.every((r) => r.error === null)).toBe(true);

    const [brain] = await getDb().select().from(schema.brains);
    expect(brain?.lifecycle).toBe('ready');
  });

  // A Space added to a ready brain (the Sources page, not the wizard) gets its
  // folders immediately, scoped to that Space alone.
  test('POST /api/sources on a ready brain scaffolds the new source once', async () => {
    opsOrder.length = 0;
    scaffolds.length = 0;
    scaffoldAt = -1;

    const res = await call('/api/sources', { sourceId: 'legal', name: 'Legal' });
    expect(res.status).toBe(200);
    expect(scaffolds.map((s) => s.sourceId)).toEqual(['legal']);
    expect(scaffolds[0]!.entries.map((e) => e.dir)).toContain('people/');
  });

  // Task 9 (Branch A, gated on S7 probe 7): the schema step can start a brain
  // on a pack the admin designs. gbrain's validate / lint / show are DB-free, so
  // the draft is written as pack.json and linted BEFORE `init` ever runs, then
  // stored as the brain's choice. A later /finish hands it to
  // `gbrain init --schema-pack`, exactly like a template pick.
  test('the schema step accepts a custom draft, writes pack.json and stores it', async () => {
    const draft = {
      name: 'legal-ops', description: 'Contracts', extends: 'gbrain-base-v2',
      pageTypes: [{
        name: 'contract', primitive: 'entity', folder: 'contracts/', description: 'Signed',
        extraPrefixes: [], aliases: [], extractable: true, expertRouting: false,
      }],
      linkVerbs: [],
    };
    await getDb().update(schema.brains).set({ lifecycle: 'schema-selected' });
    jsonPackWrites.length = 0;

    const res = await call('/api/wizard/schema', { draft });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; pack: string; name: string };
    expect(body.ok).toBe(true);
    expect(body.pack).toBe('legal-ops');

    expect(jsonPackWrites.at(-1)!.name).toBe('legal-ops');
    expect((jsonPackWrites.at(-1)!.manifest as any).page_types[0].path_prefixes).toEqual(['contracts/']);

    const [stored] = await getDb().select().from(schema.brains);
    expect(stored?.schemaPack).toBe('legal-ops');
    expect(stored?.lifecycle).toBe('schema-selected');

    // A later /finish passes schemaPack: draft.name to init.
    await getDb().update(schema.brains).set({ lifecycle: 'sources-added' });
    callOpsCalls.length = 0;
    const fin = await call('/api/wizard/finish', {});
    expect(fin.status).toBe(200);
    const init = callOpsCalls.find((c) => c.op === 'init');
    expect(init?.params?.schemaPack).toBe('legal-ops');
  });
});
