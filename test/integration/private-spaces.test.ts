import { mock, test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { randomUUID } from 'node:crypto';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(48);
process.env.BETTER_AUTH_SECRET ??= 'b'.repeat(48);
process.env.CONTROL_DATABASE_URL ??=
  'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';
process.env.PUBLIC_URL ??= 'http://127.0.0.1:3131';

type CallOpts = { json?: boolean; dryRun?: boolean; timeoutMs?: number };
type Call = { op: string; params?: Record<string, unknown>; opts?: CallOpts };
type OpsResult = {
  ok: boolean; exitCode: number; argv: string[];
  stdout: string; stderr: string; json: unknown;
};

const calls: Call[] = [];
const seedSpaceCalls: string[] = [];
const registeredSources: string[] = [];
let grantSeq = 0;

function grantReceipt(clientId: string): unknown {
  return {
    client_id: clientId,
    mcp_url: 'http://127.0.0.1:3131/mcp',
    profile: 'memory-writer',
    harness: 'generic',
    source_id: 'customers',
    expires_at: null,
    renewable: true,
    credentials: 'private-file',
  };
}

function grantJson(dryRun: boolean): unknown {
  if (dryRun) {
    return { status: 'preview', grant: { profile: 'memory-writer', sourceId: 'customers' } };
  }
  const n = grantSeq++;
  return grantReceipt(n === 0 ? 'gbrain_cl_mock' : `gbrain_cl_mock_${n}`);
}

const HANDOFF = {
  version: 1,
  mcp_url: 'http://127.0.0.1:3131/mcp',
  issuer_url: 'http://127.0.0.1:3131',
  client_id: 'gbrain_cl_mock_handoff',
  client_secret: 'not-a-real-secret-not-a-real-secret-not-a-real',
  access_token: 'gbrain_at_mock_handoff',
  expires_at: 1789657429,
  profile: 'memory-writer',
  harness: 'generic',
  source_id: 'customers',
};

function defaultOk(op: string, opts?: CallOpts): OpsResult {
  let json: unknown = { ok: true };
  if (op === 'mcp.grant') json = grantJson(Boolean(opts?.dryRun));
  else if (op === 'sources.list') json = { sources: registeredSources.map((id) => ({ id })) };
  return {
    ok: true,
    exitCode: 0,
    argv: ['gbrain', ...op.split('.')],
    stdout: '{}',
    stderr: '',
    json,
  };
}

type TreeFixture = {
  sourceId: string;
  root: string;
  entries: Array<{ path: string; size: number; isMarkdown: boolean }>;
};

let treeHandler: (sourceId: string) => TreeFixture =
  (sourceId) => ({ sourceId, root: `/repos/${sourceId}`, entries: [] });

let callOpsHandler: (op: string, params?: Record<string, unknown>, opts?: CallOpts) => Promise<OpsResult> | OpsResult =
  (op, _params, opts) => defaultOk(op, opts);

mock.module('../../src/control/opsClient.ts', () => ({
  // `src/control/spend.ts` imports this alongside the others; a mock that
  // omits a real export makes the whole graph unloadable (Slice 4 hazard (a)).
  brainUsage: async () => { throw new Error('ops unreachable'); },
  callOps: async (op: string, params?: Record<string, unknown>, opts?: CallOpts) => {
    calls.push({ op, params, opts });
    const result = await callOpsHandler(op, params, opts);
    if (op === 'sources.add' && result.ok && typeof params?.id === 'string'
      && !registeredSources.includes(params.id)) {
      registeredSources.push(params.id);
    }
    return result;
  },
  patchFilePlaneConfig: async () => {},
  putSchemaPack: async () => {},
  putSchemaPackJson: async () => {},
  readSchemaPackRaw: async () => null,
  gitImport: async () => { throw new Error("gitImport is not mocked here"); },
  gitScaffold: async () => ({ created: [], skipped: [], sha: null }),
  removeSchemaPack: async () => ({ removed: false }),
  seedSpace: async (sourceId: string) => { seedSpaceCalls.push(sourceId); },
  gitSetRemote: async (r: { url: string }) => ({ url: r.url, branch: 'main' }),
  gitClearRemote: async () => ({ removed: true }),
  resetBrainSchema: async () => {},
  pauseBrainWriters: async () => {},
  resumeBrainWriters: async () => {},
  takeGrantCredentials: async () => HANDOFF,
  deleteCredentialJournal: async () => ({ deleted: true }),
  opsHealthy: async () => true,
  commitAsMember: async () => ({ committed: false, sha: null }),
  inspectRepos: async () => [],
  writeReport: async () => ({ relPath: '', committed: false, sha: null }),
  cancelRun: async () => ({ cancelled: false }),
  gitRange: async () => ({ commits: [], files: [] }),
  gitPathExists: async () => ({ paths: [] }),
  gitRevertRange: async () => ({ outcome: 'nothing_to_revert' }),
  auditTail: async () => [],
  gitTree: async (sourceId: string) => treeHandler(sourceId),
  gitExportBundle: async () => new Response(null),
  gitReadFile: async () => ({ content: '', sha: '', size: 0 }),
  gitWriteFile: async () => ({ committed: true, sha: 'written-sha' }),
}));

const { default: app } = await import('../../src/control/app.ts');
const { runMigrations, getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { bootstrapFirstAdmin } = await import('../../src/control/bootstrap.ts');
const { eq, and } = await import('drizzle-orm');

pinDb();

let orgId = '';
let ownerCookie = '';
let adminCookie = '';
let memberCookie = '';
let viewerCookie = '';

const PASS = 'a-long-enough-password';

async function signIn(email: string, password: string): Promise<string> {
  const res = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie') ?? '';
}

async function hit(
  method: string,
  path: string,
  cookie?: string,
  body?: unknown,
  ip = '203.0.113.30',
) {
  const headers: Record<string, string> = { 'x-forwarded-for': ip };
  if (cookie) headers.cookie = cookie;
  const hasBody = method !== 'GET' && method !== 'DELETE';
  if (hasBody || body !== undefined) headers['content-type'] = 'application/json';
  return app.request(path, {
    method,
    headers,
    body: hasBody ? JSON.stringify(body ?? {}) : undefined,
  });
}

async function signUpAndMember(
  email: string,
  role: 'admin' | 'member' | 'viewer',
): Promise<{ cookie: string; membershipId: string; userId: string }> {
  const signed = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASS, name: email }),
  });
  expect(signed.status).toBe(200);
  const [u] = await getDb().select().from(schema.users).where(eq(schema.users.email, email));
  const membershipId = randomUUID();
  await getDb().insert(schema.memberships).values({
    id: membershipId, userId: u!.id, organizationId: orgId, role,
  });
  const cookie = await signIn(email, PASS);
  return { cookie, membershipId, userId: u!.id };
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
  const boot = await bootstrapFirstAdmin('ps-owner@example.test', PASS, 'PrivateCo', { brainMode: 'company' });
  orgId = boot.orgId;
  ownerCookie = await signIn('ps-owner@example.test', PASS);
  adminCookie = (await signUpAndMember('ps-admin@example.test', 'admin')).cookie;
  memberCookie = (await signUpAndMember('ps-member@example.test', 'member')).cookie;
  viewerCookie = (await signUpAndMember('ps-viewer@example.test', 'viewer')).cookie;
}, 90_000);

beforeEach(() => {
  calls.length = 0;
  seedSpaceCalls.length = 0;
  registeredSources.length = 0;
  grantSeq = 0;
  treeHandler = (sourceId) => ({ sourceId, root: `/repos/${sourceId}`, entries: [] });
  callOpsHandler = (op, _params, opts) => defaultOk(op, opts);
});

afterAll(async () => {
  await closeDb();
});

describe('invite-time provisioning', () => {
  test('admin POST /api/members creates a private space and an active writer connection', async () => {
    const email = `ps-invite-${randomUUID().slice(0, 8)}@example.test`;
    const res = await hit('POST', '/api/members', adminCookie, { email, role: 'member' });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      id: string;
      privateSpace: { ok: boolean; spaceId?: string; connectionId?: string };
    };
    expect(body.privateSpace.ok).toBe(true);
    expect(body.privateSpace.spaceId).toBeTruthy();

    const [space] = await getDb().select().from(schema.spaces)
      .where(eq(schema.spaces.id, body.privateSpace.spaceId!));
    expect(space).toBeDefined();
    expect(space?.ownerMembershipId).toBe(body.id);
    expect(space?.sourceId).toMatch(/^my-space-/);

    const [conn] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, body.privateSpace.connectionId!));
    expect(conn).toBeDefined();
    expect(conn?.writeSpaceId).toBe(space!.id);
    expect(conn?.membershipId).toBe(body.id);
    expect(conn?.state).toBe('active');

    // A NEWLY created private Space is seeded and registered as a gbrain source.
    expect(seedSpaceCalls).toContain(space!.sourceId);
    expect(calls.some((c) => c.op === 'sources.add' && c.params?.id === space!.sourceId)).toBe(true);
    // ...and synced, so gbrain's `sync_freshness` doctor check does not fail on
    // a source with a repo path and a null `last_sync_at` (C8).
    expect(calls.some((c) => c.op === 'sync' && c.params?.source === space!.sourceId)).toBe(true);
  });

  test('a failed sync does not fail provisioning', async () => {
    callOpsHandler = (op, _params, opts) => {
      if (op === 'sync') {
        return {
          ok: false, exitCode: 1, argv: ['gbrain', 'sync'],
          stdout: '', stderr: 'sync exploded', json: null,
        };
      }
      return defaultOk(op, opts);
    };

    const email = `ps-syncfail-${randomUUID().slice(0, 8)}@example.test`;
    const res = await hit('POST', '/api/members', adminCookie, { email, role: 'member' });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      id: string;
      privateSpace: { ok: boolean; spaceId?: string; connectionId?: string; error?: string };
    };
    expect(body.privateSpace.ok).toBe(true);

    const active = await getDb().select().from(schema.connections).where(and(
      eq(schema.connections.membershipId, body.id),
      eq(schema.connections.state, 'active'),
    ));
    expect(active.length).toBe(1);
    expect(active[0]!.writeSpaceId).toBe(body.privateSpace.spaceId!);
  });

  test('a failed grant leaves the membership intact and the pending space+connection retryable', async () => {
    callOpsHandler = (op, _params, opts) => {
      if (op === 'mcp.grant') {
        return {
          ok: false, exitCode: 1, argv: ['gbrain', 'mcp', 'grant'],
          stdout: '', stderr: 'mcp_setup_failed', json: null,
        };
      }
      return defaultOk(op, opts);
    };

    const email = `ps-retry-${randomUUID().slice(0, 8)}@example.test`;
    const invited = await hit('POST', '/api/members', adminCookie, { email, role: 'member' });
    expect(invited.status).toBe(200);
    const body = await invited.json() as {
      id: string;
      privateSpace: { ok: boolean; error?: string };
    };
    expect(body.privateSpace.ok).toBe(false);

    const [membership] = await getDb().select().from(schema.memberships)
      .where(eq(schema.memberships.id, body.id));
    expect(membership).toBeDefined();

    const spacesForMember = await getDb().select().from(schema.spaces)
      .where(eq(schema.spaces.ownerMembershipId, body.id));
    expect(spacesForMember.length).toBe(1);
    expect(spacesForMember[0]!.sourceId).toMatch(/^my-space-/);
    const spaceId = spacesForMember[0]!.id;

    callOpsHandler = (op, _params, opts) => defaultOk(op, opts);

    const retried = await hit('POST', `/api/members/${body.id}/private-space`, adminCookie);
    expect(retried.status).toBe(200);
    const retriedBody = await retried.json() as { ok: boolean; spaceId: string; connectionId: string };
    expect(retriedBody.ok).toBe(true);

    const owned = await getDb().select().from(schema.spaces)
      .where(eq(schema.spaces.ownerMembershipId, body.id));
    expect(owned.length).toBe(1);
    expect(owned[0]!.id).toBe(spaceId);

    const conns = (await getDb().select().from(schema.connections)
      .where(eq(schema.connections.membershipId, body.id)))
      .filter((c) => c.state !== 'revoked');
    expect(conns.length).toBe(1);
    expect(conns[0]!.writeSpaceId).toBe(spaceId);
    expect(conns[0]!.membershipId).toBe(body.id);
    expect(conns[0]!.state).toBe('active');
    expect(conns[0]!.profile).toBe('memory-writer');
  });

  test('two members get distinct gbrain source names', async () => {
    for (const n of [1, 2]) {
      const email = `ps-two-${n}-${randomUUID().slice(0, 8)}@example.test`;
      const res = await hit('POST', '/api/members', adminCookie, { email, role: 'member' });
      expect(res.status).toBe(200);
      const body = await res.json() as { privateSpace: { ok: boolean } };
      expect(body.privateSpace.ok).toBe(true);
    }

    const adds = calls.filter((c) => c.op === 'sources.add');
    const names = adds.map((c) => c.params?.name);
    expect(names.length).toBe(2);
    expect(new Set(names).size).toBe(names.length);
    for (const c of adds) expect(c.params?.name).toBe(c.params?.id);
  });

  test('a sources.add failure is reported, not swallowed, and a retry registers the source', async () => {
    let failsLeft = 1;
    callOpsHandler = (op, _params, opts) => {
      if (op === 'sources.add' && failsLeft > 0) {
        failsLeft -= 1;
        return {
          ok: false, exitCode: 1, argv: ['gbrain', 'sources', 'add'],
          stdout: '', stderr: 'sources add exploded', json: null,
        };
      }
      return defaultOk(op, opts);
    };

    const email = `ps-srcfail-${randomUUID().slice(0, 8)}@example.test`;
    const invited = await hit('POST', '/api/members', adminCookie, { email, role: 'member' });
    expect(invited.status).toBe(200);
    const body = await invited.json() as { id: string; privateSpace: { ok: boolean; error?: string } };
    expect(body.privateSpace.ok).toBe(false);
    expect(body.privateSpace.error).toBe('private_space_source_failed');

    const active = await getDb().select().from(schema.connections).where(and(
      eq(schema.connections.membershipId, body.id),
      eq(schema.connections.state, 'active'),
    ));
    expect(active.length).toBe(0);
    const anyConns = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.membershipId, body.id));
    expect(anyConns.filter((c) => c.state !== 'revoked').length).toBe(0);

    const addsBefore = calls.filter((c) => c.op === 'sources.add').length;
    const retried = await hit('POST', `/api/members/${body.id}/private-space`, adminCookie);
    expect(retried.status).toBe(200);
    const retriedBody = await retried.json() as { ok: boolean };
    expect(retriedBody.ok).toBe(true);
    expect(calls.filter((c) => c.op === 'sources.add').length).toBeGreaterThan(addsBefore);
  });

  test('an id collision while sources.list is unavailable counts as registered', async () => {
    callOpsHandler = (op, _params, opts) => {
      if (op === 'sources.list') {
        return {
          ok: false, exitCode: 1, argv: ['gbrain', 'sources', 'list'],
          stdout: '', stderr: 'sources list unavailable', json: null,
        };
      }
      if (op === 'sources.add') {
        return {
          ok: false, exitCode: 1, argv: ['gbrain', 'sources', 'add'],
          stdout: '',
          stderr: 'ERROR: duplicate key value violates unique constraint "sources_pkey"',
          json: null,
        };
      }
      return defaultOk(op, opts);
    };

    const email = `ps-idc-${randomUUID().slice(0, 8)}@example.test`;
    const res = await hit('POST', '/api/members', adminCookie, { email, role: 'member' });
    expect(res.status).toBe(200);
    const body = await res.json() as { privateSpace: { ok: boolean; error?: string } };
    expect(body.privateSpace.ok).toBe(true);
  });

  test('a name collision while sources.list is unavailable is not treated as registered', async () => {
    callOpsHandler = (op, _params, opts) => {
      if (op === 'sources.list') {
        return {
          ok: false, exitCode: 1, argv: ['gbrain', 'sources', 'list'],
          stdout: '', stderr: 'sources list unavailable', json: null,
        };
      }
      if (op === 'sources.add') {
        return {
          ok: false, exitCode: 1, argv: ['gbrain', 'sources', 'add'],
          stdout: '',
          stderr: 'ERROR: duplicate key value violates unique constraint "sources_name_key"',
          json: null,
        };
      }
      return defaultOk(op, opts);
    };

    const email = `ps-namec-${randomUUID().slice(0, 8)}@example.test`;
    const res = await hit('POST', '/api/members', adminCookie, { email, role: 'member' });
    expect(res.status).toBe(200);
    const body = await res.json() as { privateSpace: { ok: boolean; error?: string } };
    expect(body.privateSpace.ok).toBe(false);
    expect(body.privateSpace.error).toBe('private_space_source_failed');
  });
});

describe('access-overview privacy', () => {
  test("an admin never sees another member's private space; the owner does", async () => {
    const { cookie, membershipId } = await signUpAndMember(
      `ps-priv-${randomUUID().slice(0, 8)}@example.test`, 'member',
    );
    const created = await hit('POST', '/api/private-space', cookie);
    expect(created.status).toBe(200);
    const { spaceId } = await created.json() as { spaceId: string };
    const [space] = await getDb().select().from(schema.spaces).where(eq(schema.spaces.id, spaceId));
    expect(space?.ownerMembershipId).toBe(membershipId);

    const adminView = await hit('GET', '/api/access-overview', adminCookie);
    expect(adminView.status).toBe(200);
    const adminBody = await adminView.json() as { spaces: Array<{ id: string; name: string }> };
    expect(adminBody.spaces.some((s) => s.id === spaceId)).toBe(false);
    expect(adminBody.spaces.some((s) => s.name === space!.name)).toBe(false);

    const ownerView = await hit('GET', '/api/access-overview', cookie);
    const ownerBody = await ownerView.json() as { spaces: Array<{ id: string }> };
    expect(ownerBody.spaces.some((s) => s.id === spaceId)).toBe(true);
  });
});

describe('private-space profile', () => {
  test('a viewer-role member private connection compiles to memory-writer', async () => {
    const email = `ps-viewer-${randomUUID().slice(0, 8)}@example.test`;
    const created = await hit('POST', '/api/members', adminCookie, { email, role: 'viewer' });
    expect(created.status).toBe(200);
    const body = await created.json() as { id: string; privateSpace: { ok: boolean; connectionId?: string } };
    expect(body.privateSpace.ok).toBe(true);

    const [conn] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, body.privateSpace.connectionId!));
    expect(conn?.membershipId).toBe(body.id);
    expect(conn?.profile).toBe('memory-writer');
  });
});

describe('self-service POST /api/private-space', () => {
  test('provisions once and then refuses with already_provisioned', async () => {
    const { cookie, membershipId } = await signUpAndMember(
      `ps-self-${randomUUID().slice(0, 8)}@example.test`, 'member',
    );

    const first = await hit('POST', '/api/private-space', cookie);
    expect(first.status).toBe(200);
    const provisioned = await first.json() as { ok: boolean; spaceId: string; sourceId: string; connectionId: string };
    expect(provisioned.ok).toBe(true);
    expect(provisioned.sourceId).toMatch(/^my-space-/);

    const [conn] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, provisioned.connectionId));
    expect(conn?.writeSpaceId).toBe(provisioned.spaceId);
    expect(conn?.membershipId).toBe(membershipId);
    expect(conn?.state).toBe('active');

    const second = await hit('POST', '/api/private-space', cookie);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'already_provisioned' });

    const owned = await getDb().select().from(schema.spaces)
      .where(eq(schema.spaces.ownerMembershipId, membershipId));
    expect(owned.length).toBe(1);
  });

  test('repairs an owned but inactive space instead of returning already_provisioned', async () => {
    const { cookie, membershipId } = await signUpAndMember(
      `ps-repair-${randomUUID().slice(0, 8)}@example.test`, 'member',
    );
    const sourceId = `my-space-${membershipId.slice(0, 8).toLowerCase()}`;
    const spaceId = randomUUID();
    await getDb().insert(schema.spaces).values({
      id: spaceId,
      organizationId: orgId,
      sourceId,
      name: 'My Space',
      kind: 'local-git',
      localPath: `/srv/brain-repos/${sourceId}`,
      ownerMembershipId: membershipId,
    });

    const repaired = await hit('POST', '/api/private-space', cookie);
    expect(repaired.status).toBe(200);
    const body = await repaired.json() as { ok: boolean; spaceId: string; connectionId: string };
    expect(body.ok).toBe(true);
    expect(body.spaceId).toBe(spaceId);

    const [conn] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, body.connectionId));
    expect(conn?.state).toBe('active');
    expect(conn?.writeSpaceId).toBe(spaceId);
    expect(conn?.membershipId).toBe(membershipId);

    const second = await hit('POST', '/api/private-space', cookie);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'already_provisioned' });
  });
});

describe('org private-spaces toggle', () => {
  test('disabling blocks new provisioning; a bad body is 400; re-enabling restores it', async () => {
    const off = await hit('PATCH', '/api/org/private-spaces', adminCookie, { enabled: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ enabled: false });

    const email = `ps-off-${randomUUID().slice(0, 8)}@example.test`;
    const invited = await hit('POST', '/api/members', adminCookie, { email, role: 'member' });
    expect(invited.status).toBe(200);
    const invitedBody = await invited.json() as { id: string; privateSpace: { ok: boolean; error?: string } };
    expect(invitedBody.privateSpace.ok).toBe(false);
    expect(invitedBody.privateSpace.error).toBe('private_spaces_disabled');
    const invitedSpaces = await getDb().select().from(schema.spaces)
      .where(eq(schema.spaces.ownerMembershipId, invitedBody.id));
    expect(invitedSpaces).toEqual([]);

    const { cookie } = await signUpAndMember(
      `ps-off-self-${randomUUID().slice(0, 8)}@example.test`, 'member',
    );
    const self = await hit('POST', '/api/private-space', cookie);
    expect(self.status).toBe(409);
    expect(await self.json()).toEqual({ error: 'private_spaces_disabled' });

    const bad = await hit('PATCH', '/api/org/private-spaces', adminCookie, { enabled: 'yes' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_enabled' });

    const on = await hit('PATCH', '/api/org/private-spaces', adminCookie, { enabled: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ enabled: true });
  });
});

describe('offboarding a private-space owner', () => {
  test('the personal space is removed and does not become a company space', async () => {
    const email = `ps-offboard-${randomUUID().slice(0, 8)}@example.test`;
    const created = await hit('POST', '/api/members', adminCookie, { email, role: 'member' });
    expect(created.status).toBe(200);
    const member = await created.json() as { id: string; privateSpace: { ok: boolean; spaceId?: string } };
    expect(member.privateSpace.ok).toBe(true);
    const spaceId = member.privateSpace.spaceId!;

    const del = await hit('DELETE', `/api/members/${member.id}`, adminCookie);
    expect(del.status).toBe(200);

    const [space] = await getDb().select().from(schema.spaces).where(eq(schema.spaces.id, spaceId));
    expect(space).toBeUndefined();

    const [gone] = await getDb().select().from(schema.memberships)
      .where(eq(schema.memberships.id, member.id));
    expect(gone).toBeUndefined();

    const adminView = await hit('GET', '/api/access-overview', adminCookie);
    const adminBody = await adminView.json() as { spaces: Array<{ id: string }> };
    expect(adminBody.spaces.some((s) => s.id === spaceId)).toBe(false);
  });
});

describe('files routes enforce private-space access', () => {
  test('the owner reads the tree; another member and an admin get 403', async () => {
    const { cookie } = await signUpAndMember(
      `ps-files-${randomUUID().slice(0, 8)}@example.test`, 'member',
    );
    const created = await hit('POST', '/api/private-space', cookie);
    expect(created.status).toBe(200);
    const { sourceId } = await created.json() as { sourceId: string };

    treeHandler = (id) => ({
      sourceId: id,
      root: `/repos/${id}`,
      entries: [{ path: 'notes.md', size: 3, isMarkdown: true }],
    });

    const owner = await hit('GET', `/api/spaces/${sourceId}/files`, cookie);
    expect(owner.status).toBe(200);
    const tree = await owner.json() as TreeFixture;
    expect(tree.entries).toEqual([{ path: 'notes.md', size: 3, isMarkdown: true }]);

    expect((await hit('GET', `/api/spaces/${sourceId}/files`, memberCookie)).status).toBe(403);
    expect((await hit('GET', `/api/spaces/${sourceId}/files`, adminCookie)).status).toBe(403);
    expect((await hit('GET', `/api/spaces/${sourceId}/files`, viewerCookie)).status).toBe(403);
    expect((await hit('GET', `/api/spaces/${sourceId}/files`, ownerCookie)).status).toBe(403);
  });
});
