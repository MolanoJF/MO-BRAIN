import { mock, test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { packWorldReply, rawPacks, resetPackWorld } from '../helpers/packWorld.ts';

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
let failInit = false;
const finishOrder: string[] = [];
let grantSeq = 0;
const seedSpaceCalls: string[] = [];
// Task 9: the JSON pack writes the wizard's schema step makes through the file
// plane, recorded so the draft branch's manifest can be asserted.
const jsonPackWrites: { name: string; manifest: object }[] = [];
const removedPacks: string[] = [];
// Task 6: op ids in call order, and where the scaffold landed inside that order.
// `scaffoldAt` is stamped by the gitScaffold mock, which is not a callOps call.
const opsOrder: string[] = [];
const scaffolds: { sourceId: string; entries: { dir: string; readme: string }[] }[] = [];
let scaffoldAt = -1;
// Task 3: overridden by the visible-packs test below to exercise the full
// bundled + managed pack lineup; null keeps every other test's single-pack
// default (`Bundled packs:\n  gbrain-base-v2\n`).
let schemaListOverride: string | null = null;

mock.module('../../src/control/opsClient.ts', () => ({
  callOps: async (
    op: string,
    params?: Record<string, unknown>,
    opts?: { json?: boolean; timeoutMs?: number; packOverride?: string },
  ) => {
    callOpsCalls.push({ op, opts, params });
    opsOrder.push(op);
    finishOrder.push(op);
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
    const world = packWorldReply(op, params, opts);
    if (world) return world;
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
    if (op === 'init' && failInit) {
      return {
        ok: false, exitCode: 1, argv: ['gbrain', 'init'],
        stdout: '', stderr: 'Refusing to silently re-template existing brain\npostgres://gbrain:secret@postgres:5432/gbrain\n',
        json: null,
      };
    }
    return {
      ok: true,
      exitCode: 0,
      argv: ['gbrain', ...op.split('.')],
      stdout: op === 'schema.list'
        ? (schemaListOverride ?? 'Bundled packs:\n  gbrain-base-v2\n')
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
  putSchemaPackJson: async (name: string, manifest: object) => { jsonPackWrites.push({ name, manifest }); rawPacks[name] = manifest as any; },
  readSchemaPackRaw: async () => null,
  gitScaffold: async (req: { sourceId: string; entries: { dir: string; readme: string }[] }) => {
    scaffoldAt = opsOrder.length;
    scaffolds.push({ sourceId: req.sourceId, entries: req.entries });
    return { created: req.entries.map((e) => `${e.dir}README.md`), skipped: [], sha: 'scaffold-sha' };
  },
  removeSchemaPack: async (name: string) => { delete rawPacks[name]; removedPacks.push(name); return { removed: true }; },
  seedSpace: async (sourceId: string) => { seedSpaceCalls.push(sourceId); },
  gitSetRemote: async (r: { url: string }) => ({ url: r.url, branch: 'main' }),
  gitClearRemote: async () => ({ removed: true }),
  resetBrainSchema: async () => { resetBrainSchemaCalls += 1; finishOrder.push('reset'); },
  pauseBrainWriters: async () => { finishOrder.push('pause'); },
  resumeBrainWriters: async () => { finishOrder.push('resume'); },
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
  gitExportBundle: async () => new Response(null),
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
  ({ orgId } = await bootstrapFirstAdmin('admin@example.test', 'a-long-enough-password', 'Acme', { brainMode: 'company' }));

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

  // Spec P6: the pack is stored at bootstrap, so choosing a search mode
  // is the last decision before the private Space — there is no Schema step.
  test('the search-mode step records the choice and passes the stored pack', async () => {
    const res = await call('/api/wizard/search-mode', { mode: 'conservative' });
    expect(res.status).toBe(200);
    expect((await res.json() as { lifecycle: string }).lifecycle).toBe('schema-selected');
    const [brain] = await getDb().select().from(schema.brains);
    expect(brain?.searchMode).toBe('conservative');
    expect(brain?.lifecycle).toBe('schema-selected');
    expect(brain?.schemaPack).toBe('mobrain-core');
  });

  test('a legacy brain with no stored pack still stops at the Schema step', async () => {
    const [brain] = await getDb().select().from(schema.brains);
    await getDb().update(schema.brains).set({ lifecycle: 'provider-configured', schemaPack: null })
      .where(eq(schema.brains.id, brain!.id));
    const res = await call('/api/wizard/search-mode', { mode: 'conservative' });
    expect((await res.json() as { lifecycle: string }).lifecycle).toBe('mode-selected');
    await getDb().update(schema.brains).set({ lifecycle: 'schema-selected', schemaPack: 'gbrain-base-v2' })
      .where(eq(schema.brains.id, brain!.id));
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

  test('finish leaves writers paused when init fails and returns the stderr tail', async () => {
    failInit = true;
    finishOrder.length = 0;
    try {
      const res = await call('/api/wizard/finish', {});
      expect(res.status).toBe(500);
      const body = await res.json() as {
        ok: boolean;
        steps: { id: string; ok: boolean; stderr?: string }[];
      };
      expect(body.ok).toBe(false);
      const init = body.steps.find((s) => s.id === 'init');
      expect(init?.ok).toBe(false);
      expect(init?.stderr).toContain('Refusing to silently re-template');
      expect(init?.stderr).not.toContain('secret');
      expect(finishOrder).toContain('pause');
      expect(finishOrder).toContain('reset');
      expect(finishOrder).not.toContain('resume');
    } finally {
      failInit = false;
    }
  });

  // Critical fix: old shared run() always passed json:true, which hard-fails
  // init and config.set (supportsJson: false) in buildArgv / ops RPC.
  test('finish does not pass json:true for init or config.set', async () => {
    callOpsCalls.length = 0;
    resetBrainSchemaCalls = 0;
    finishOrder.length = 0;
    const res = await call('/api/wizard/finish', {});
    expect(res.status).toBe(200);
    // Worker cold-start compensation: wipe before init (must not be a silent no-op).
    expect(resetBrainSchemaCalls).toBe(1);
    expect(finishOrder.indexOf('pause')).toBeGreaterThanOrEqual(0);
    expect(finishOrder.indexOf('pause')).toBeLessThan(finishOrder.indexOf('reset'));
    expect(finishOrder.indexOf('reset')).toBeLessThan(finishOrder.indexOf('init'));
    expect(finishOrder.indexOf('init')).toBeLessThan(finishOrder.indexOf('resume'));
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
    schemaListOverride = 'Bundled packs:\n  gbrain-base-v2\n\nInstalled packs (~/.gbrain/schema-packs/):\n  mobrain-core\n';
    resetPackWorld();
    const draft = {
      name: 'legal-ops', description: 'Contracts', extends: 'mobrain-core',
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
    schemaListOverride = null;
  });

  // The core lock: every wizard path that stores a pack runs the activation gate.
  describe('the core lock', () => {
    const draft = (extendsName: string) => ({
      name: 'locked-ops', description: 'x', extends: extendsName,
      pageTypes: [{ name: 'thing', primitive: 'entity', folder: 'things/', description: '', extraPrefixes: [], aliases: [], extractable: false, expertRouting: false }],
      linkVerbs: [],
    });
    const LISTED = 'Bundled packs:\n  gbrain-base-v2\n\nInstalled packs (~/.gbrain/schema-packs/):\n  mobrain-core\n  mobrain-personal\n  stray\n';

    test('a draft that extends a gbrain pack is refused and nothing is written', async () => {
      schemaListOverride = LISTED.replace('mobrain-core', 'mobrain-core\n  gbrain-base-v2');
      resetPackWorld();
      await getDb().update(schema.brains).set({ lifecycle: 'schema-selected' });
      jsonPackWrites.length = 0;
      const res = await call('/api/wizard/schema', { draft: draft('gbrain-base-v2') });
      schemaListOverride = null;
      expect(res.status).toBe(400);
      expect((await res.json() as { code: string }).code).toBe('CORE_LOCKED');
      expect(jsonPackWrites).toHaveLength(0);
    });

    test('a draft whose resolved pack loses a core entry is removed again', async () => {
      schemaListOverride = LISTED;
      resetPackWorld();
      // gbrain's merge "lets the child win": simulate a pack that ends up redefining person.
      rawPacks['mobrain-core']!.page_types = rawPacks['mobrain-core']!.page_types!.map((t) => (t.name === 'person' ? { ...t, extractable: false } : t));
      removedPacks.length = 0;
      await getDb().update(schema.brains).set({ lifecycle: 'schema-selected' });
      const res = await call('/api/wizard/schema', { draft: draft('mobrain-core') });
      schemaListOverride = null;
      resetPackWorld();
      expect(res.status).toBe(400);
      expect((await res.json() as { code: string }).code).toBe('CORE_LOCKED');
      expect(removedPacks).toEqual(['locked-ops']);
    });

    test('choosing a pack outside the core family is refused, gbrain packs and Personal are allowed', async () => {
      schemaListOverride = LISTED;
      resetPackWorld();
      rawPacks.stray = { name: 'stray', extends: null, page_types: [] };
      await getDb().update(schema.brains).set({ lifecycle: 'schema-selected' });
      const refused = await call('/api/wizard/schema', { pack: 'stray' });
      expect(refused.status).toBe(400);
      expect((await refused.json() as { code: string }).code).toBe('CORE_LOCKED');
      for (const pack of ['mobrain-personal', 'gbrain-base-v2']) {
        await getDb().update(schema.brains).set({ lifecycle: 'schema-selected' });
        const okRes = await call('/api/wizard/schema', { pack });
        expect(okRes.status).toBe(200);
      }
      schemaListOverride = null;
    });
  });

  // I1: resetBrainSchema wipes gbrain's sources table, so /finish re-registers
  // every recorded Space. Two private Spaces must send DISTINCT sources.add
  // names — gbrain's sources.name is TEXT NOT NULL UNIQUE — or the second add
  // violates sources_name_key and /finish returns 500.
  test('finish re-registers two private Spaces under distinct gbrain source names', async () => {
    const otherUserId = randomUUID();
    await getDb().insert(schema.users).values({
      id: otherUserId, email: 'second-owner@example.test', name: 'Second Owner',
    });
    const otherMembershipId = randomUUID();
    await getDb().insert(schema.memberships).values({
      id: otherMembershipId, userId: otherUserId, organizationId: orgId, role: 'member',
    });
    const otherSourceId = `my-space-${otherMembershipId.slice(0, 8).toLowerCase()}`;
    await getDb().insert(schema.spaces).values({
      id: randomUUID(), organizationId: orgId, sourceId: otherSourceId, name: 'My Space',
      kind: 'local-git', localPath: `/srv/brain-repos/${otherSourceId}`,
      ownerMembershipId: otherMembershipId,
    });

    const [brain] = await getDb().select().from(schema.brains);
    await getDb().update(schema.brains).set({ lifecycle: 'sources-added' })
      .where(eq(schema.brains.id, brain!.id));

    callOpsCalls.length = 0;
    const res = await call('/api/wizard/finish', {});
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);

    const privateIds = (await getDb().select().from(schema.spaces)
      .where(eq(schema.spaces.organizationId, orgId)))
      .filter((s) => s.ownerMembershipId)
      .map((s) => s.sourceId)
      .sort();
    expect(privateIds.length).toBe(2);

    const adds = callOpsCalls.filter(
      (c) => c.op === 'sources.add' && privateIds.includes(String(c.params?.id)),
    );
    const names = adds.map((c) => String(c.params?.name)).sort();
    expect(names.length).toBe(2);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(privateIds);
  });
});

// Spec P6/P7: the wizard's pack list is the same visible-packs filter as the
// Schema admin page — every bundled pack except gbrain-base-v2 hidden, the
// managed pack shown.
test('GET /wizard/schema-packs hides every bundled pack except gbrain-base-v2', async () => {
  schemaListOverride = 'Bundled packs:\n  gbrain-base\n  gbrain-base-v2\n  gbrain-investor\n\n' +
    'Installed packs (~/.gbrain/schema-packs/):\n  mobrain-core\n';
  try {
    const res = await call('/api/wizard/schema-packs');
    expect(res.status).toBe(200);
    const body = await res.json() as { packs: string[] };
    expect(body.packs).toEqual(['gbrain-base-v2', 'mobrain-core']);
  } finally {
    schemaListOverride = null;
  }
});

// Console onboarding: one /prepare call replaces the mode, schema and Space
// steps, and /provider can be re-run until the brain is ready.
describe('wizard prepare', () => {
  const setBrain = async (patch: Record<string, unknown>) => {
    const [brain] = await getDb().select().from(schema.brains);
    await getDb().update(schema.brains).set(patch).where(eq(schema.brains.id, brain!.id));
  };
  const getBrain = async () => (await getDb().select().from(schema.brains))[0]!;
  const ownedSpaces = async () => (await getDb().select().from(schema.spaces)
    .where(eq(schema.spaces.organizationId, orgId))).filter((s) => s.ownerMembershipId);

  beforeAll(async () => {
    await getDb().delete(schema.connections);
    await getDb().delete(schema.spaces);
  });

  test('from provider-configured it lands on sources-added with the defaults', async () => {
    await setBrain({ lifecycle: 'provider-configured', searchMode: null, schemaPack: 'mobrain-core' });
    const res = await call('/api/wizard/prepare', {});
    expect(res.status).toBe(200);
    const body = await res.json() as { lifecycle: string; searchMode: string; schemaPack: string; sourceId: string };
    expect(body.lifecycle).toBe('sources-added');
    expect(body.searchMode).toBe('balanced');
    expect(body.schemaPack).toBe('mobrain-core');
    expect(body.sourceId).toMatch(/^my-space-/);
    const brain = await getBrain();
    expect(brain.lifecycle).toBe('sources-added');
    expect(brain.searchMode).toBe('balanced');
    expect((await ownedSpaces()).length).toBe(1);
    const audits = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, 'wizard.prepare'));
    expect(audits.length).toBe(1);
  });

  test('a second prepare is idempotent and creates no second Space', async () => {
    const res = await call('/api/wizard/prepare', {});
    expect(res.status).toBe(200);
    expect((await res.json() as { lifecycle: string }).lifecycle).toBe('sources-added');
    expect((await ownedSpaces()).length).toBe(1);
  });

  test('a legacy brain with no pack gets the default pack, checked against the list', async () => {
    await getDb().delete(schema.connections);
    await getDb().delete(schema.spaces);
    await setBrain({ lifecycle: 'provider-configured', searchMode: null, schemaPack: null });
    schemaListOverride = 'Bundled packs:\n  gbrain-base-v2\n\nInstalled packs (~/.gbrain/schema-packs/):\n  mobrain-core\n';
    try {
      const res = await call('/api/wizard/prepare', {});
      expect(res.status).toBe(200);
      expect((await res.json() as { schemaPack: string }).schemaPack).toBe('mobrain-core');
      expect((await getBrain()).schemaPack).toBe('mobrain-core');
    } finally { schemaListOverride = null; }
  });

  test('a default pack gbrain does not know is refused', async () => {
    await getDb().delete(schema.connections);
    await getDb().delete(schema.spaces);
    await setBrain({ lifecycle: 'provider-configured', searchMode: null, schemaPack: null });
    const res = await call('/api/wizard/prepare', {}); // default list holds gbrain-base-v2 only
    expect(res.status).toBe(400);
    expect((await getBrain()).lifecycle).toBe('mode-selected');
    await setBrain({ schemaPack: 'mobrain-core' });
    expect((await call('/api/wizard/prepare', {})).status).toBe(200);
  });

  test('a stored search mode is kept', async () => {
    await getDb().delete(schema.connections);
    await getDb().delete(schema.spaces);
    await setBrain({ lifecycle: 'provider-configured', searchMode: 'tokenmax', schemaPack: 'mobrain-core' });
    const res = await call('/api/wizard/prepare', {});
    expect((await res.json() as { searchMode: string }).searchMode).toBe('tokenmax');
    expect((await getBrain()).searchMode).toBe('tokenmax');
  });

  test('prepare from uninitialized or ready is 409', async () => {
    await setBrain({ lifecycle: 'uninitialized' });
    expect((await call('/api/wizard/prepare', {})).status).toBe(409);
    await setBrain({ lifecycle: 'ready' });
    expect((await call('/api/wizard/prepare', {})).status).toBe(409);
  });

  test('provider re-run at sources-added replaces the secret and keeps the lifecycle', async () => {
    await setBrain({ lifecycle: 'sources-added' });
    const res = await call('/api/wizard/provider', {
      provider: 'openai', apiKey: 'sk-second-key', embeddingModel: 'openai:text-embedding-3-small',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('sk-second-key');
    expect((await getBrain()).lifecycle).toBe('sources-added');
    // storeSecret versions: the newest row is the one that is read back.
    const { readSecret } = await import('../../src/control/secrets.ts');
    expect(await readSecret(orgId, 'openai_api_key')).toBe('sk-second-key');
    const rows = await getDb().select().from(schema.secrets).where(eq(schema.secrets.organizationId, orgId));
    expect(JSON.stringify(rows)).not.toContain('sk-second-key');
  });

  test('provider at ready is 409', async () => {
    await setBrain({ lifecycle: 'ready' });
    const res = await call('/api/wizard/provider', {
      provider: 'openai', apiKey: 'sk-third-key', embeddingModel: 'openai:text-embedding-3-small',
    });
    expect(res.status).toBe(409);
  });

  test('provider with verify:true and a failing check is refused and stores nothing', async () => {
    await setBrain({ lifecycle: 'uninitialized' });
    await getDb().delete(schema.secrets);
    const realFetch = globalThis.fetch;
    let sawKey = '';
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      sawKey = String((init?.headers as Record<string, string>).Authorization);
      return new Response('{}', { status: 401 });
    }) as unknown as typeof fetch;
    try {
      const res = await call('/api/wizard/provider', {
        provider: 'openai', apiKey: 'sk-bad-key', embeddingModel: 'openai:text-embedding-3-small', verify: true,
      });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(JSON.parse(text).error).toBe('invalid_api_key');
      expect(text).not.toContain('sk-bad-key');
      expect(sawKey).toBe('Bearer sk-bad-key');
    } finally { globalThis.fetch = realFetch; }
    expect((await getDb().select().from(schema.secrets)).length).toBe(0);
    expect((await getBrain()).lifecycle).toBe('uninitialized');
  });
});
