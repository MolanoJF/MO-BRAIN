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
const takes: string[] = [];
const SECRET = 'sk-secret-once';
const PASS = 'a-long-enough-password';

function grantJson(dryRun: boolean): unknown {
  if (dryRun) {
    return { status: 'preview', grant: { profile: 'memory-writer', sourceId: 'customers' } };
  }
  return {
    client_id: 'gbrain_cl_mock',
    mcp_url: 'http://127.0.0.1:3131/mcp',
    profile: 'memory-writer',
    harness: 'generic',
    source_id: 'customers',
    expires_at: null,
    renewable: true,
    credentials: 'private-file',
  };
}

function defaultOk(op: string, opts?: CallOpts): OpsResult {
  return {
    ok: true,
    exitCode: 0,
    argv: ['gbrain', ...op.split('.')],
    stdout: '{}',
    stderr: '',
    json: op === 'mcp.grant' ? grantJson(Boolean(opts?.dryRun)) : { ok: true },
  };
}

let callOpsHandler: (op: string, params?: Record<string, unknown>, opts?: CallOpts) => Promise<OpsResult> | OpsResult =
  (op, _params, opts) => defaultOk(op, opts);

mock.module('../../src/control/opsClient.ts', () => ({
  callOps: async (op: string, params?: Record<string, unknown>, opts?: CallOpts) => {
    calls.push({ op, params, opts });
    return callOpsHandler(op, params, opts);
  },
  patchFilePlaneConfig: async () => {},
  putSchemaPack: async () => {},
  seedSpace: async () => {},
  resetBrainSchema: async () => {},
  takeGrantCredentials: async (path: string) => {
    takes.push(path);
    return { client_id: 'gbrain_cl_taken', client_secret: SECRET };
  },
  opsHealthy: async () => true,
}));

const { default: app } = await import('../../src/control/app.ts');
const { runMigrations, getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { bootstrapFirstAdmin } = await import('../../src/control/bootstrap.ts');
const { eq } = await import('drizzle-orm');

pinDb();

let orgId = '';
let ownerCookie = '';
let adminCookie = '';
let memberCookie = '';
let viewerCookie = '';
let writeSpace: { id: string; sourceId: string };
let readSpace: { id: string; sourceId: string };

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
  ip = '203.0.113.10',
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

beforeAll(async () => {
  await runMigrations();
  for (const t of [
    schema.claimLinks, schema.connections, schema.spaces, schema.secrets, schema.auditLog,
    schema.sessions, schema.accounts, schema.verifications,
    schema.memberships, schema.brains, schema.organizations, schema.users,
  ]) {
    await getDb().delete(t);
  }
  const boot = await bootstrapFirstAdmin('rt-owner@example.test', PASS, 'RouteCo');
  orgId = boot.orgId;

  for (const { email, role } of [
    { email: 'rt-admin@example.test', role: 'admin' as const },
    { email: 'rt-member@example.test', role: 'member' as const },
    { email: 'rt-viewer@example.test', role: 'viewer' as const },
  ]) {
    const signed = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASS, name: email }),
    });
    expect(signed.status).toBe(200);
    const [u] = await getDb().select().from(schema.users).where(eq(schema.users.email, email));
    await getDb().insert(schema.memberships).values({
      id: randomUUID(), userId: u!.id, organizationId: orgId, role,
    });
  }

  ownerCookie = await signIn('rt-owner@example.test', PASS);
  adminCookie = await signIn('rt-admin@example.test', PASS);
  memberCookie = await signIn('rt-member@example.test', PASS);
  viewerCookie = await signIn('rt-viewer@example.test', PASS);

  writeSpace = { id: randomUUID(), sourceId: 'customers' };
  readSpace = { id: randomUUID(), sourceId: 'shared' };
  await getDb().insert(schema.spaces).values([
    { id: writeSpace.id, organizationId: orgId, sourceId: writeSpace.sourceId, name: 'Customers', kind: 'local-git' },
    { id: readSpace.id, organizationId: orgId, sourceId: readSpace.sourceId, name: 'Shared', kind: 'local-git' },
  ]);
}, 90_000);

beforeEach(async () => {
  calls.length = 0;
  takes.length = 0;
  callOpsHandler = (op, _params, opts) => defaultOk(op, opts);
});

afterAll(async () => {
  await closeDb();
});

const ROUTE_TABLE: {
  method: string;
  path: string;
  body?: unknown;
  unauth: number;
  viewer: number;
  member: number;
  admin: number;
}[] = [
  { method: 'GET', path: '/api/members', unauth: 401, viewer: 403, member: 403, admin: 200 },
  { method: 'POST', path: '/api/members', unauth: 401, viewer: 403, member: 403, admin: 400 },
  { method: 'DELETE', path: '/api/members/not-a-real-id', unauth: 401, viewer: 403, member: 403, admin: 404 },
  { method: 'POST', path: '/api/members/not-a-real-id/claim-link', unauth: 401, viewer: 403, member: 403, admin: 404 },
  { method: 'GET', path: '/api/connections', unauth: 401, viewer: 403, member: 403, admin: 200 },
  { method: 'POST', path: '/api/connections', unauth: 401, viewer: 403, member: 403, admin: 400 },
  { method: 'POST', path: '/api/connections/preview', unauth: 401, viewer: 403, member: 403, admin: 400 },
  { method: 'POST', path: '/api/connections/not-a-real-id/revoke', unauth: 401, viewer: 403, member: 403, admin: 404 },
  { method: 'GET', path: '/api/harnesses', unauth: 401, viewer: 200, member: 200, admin: 200 },
  { method: 'GET', path: '/api/access-overview', unauth: 401, viewer: 200, member: 200, admin: 200 },
  { method: 'POST', path: '/api/claim/not-a-real-token', body: { email: 'claim-table@example.test' }, unauth: 400, viewer: 400, member: 400, admin: 400 },
];

describe('route table', () => {
  for (const row of ROUTE_TABLE) {
    test(`${row.method} ${row.path}`, async () => {
      expect((await hit(row.method, row.path, undefined, row.body)).status).toBe(row.unauth);
      expect((await hit(row.method, row.path, viewerCookie, row.body)).status).toBe(row.viewer);
      expect((await hit(row.method, row.path, memberCookie, row.body)).status).toBe(row.member);
      expect((await hit(row.method, row.path, adminCookie, row.body)).status).toBe(row.admin);
      expect((await hit(row.method, row.path, ownerCookie, row.body)).status).toBe(row.admin);
    });
  }

  test('GET /admin is not a JSON admin surface', async () => {
    const res = await app.request('/admin');
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      expect(res.status).toBe(404);
    }
  });
});

describe('POST /api/connections is pending (A3)', () => {
  test('creates a pending row and does not provision', async () => {
    const [m] = await getDb().select().from(schema.memberships)
      .where(eq(schema.memberships.userId, (
        await getDb().select().from(schema.users).where(eq(schema.users.email, 'rt-member@example.test'))
      )[0]!.id));
    const res = await hit('POST', '/api/connections', adminCookie, {
      membershipId: m!.id,
      writeSpaceId: writeSpace.id,
      readSpaceIds: [readSpace.id],
      harness: 'generic',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; state: string };
    expect(body.state).toBe('pending');

    const [row] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, body.id));
    expect(row?.state).toBe('pending');
    expect(row?.gbrainClientId).toBeNull();
    expect(calls.some((c) => c.op === 'mcp.grant' && c.opts?.dryRun !== true)).toBe(false);
  });
});

describe('GET /api/harnesses', () => {
  test('serves capability.json wellKnown adapters and profiles, not a live fetch', async () => {
    calls.length = 0;
    const res = await hit('GET', '/api/harnesses', viewerCookie);
    expect(res.status).toBe(200);
    const body = await res.json() as { adapters: { id: string }[]; profiles: unknown };
    expect(body.adapters.length).toBeGreaterThan(0);
    expect(body.adapters.some((a) => a.id === 'claude-code')).toBe(true);
    expect(JSON.stringify(body.profiles)).toMatch(/memory-writer/);
    expect(calls.length).toBe(0);
  });
});

describe('POST /api/claim/:token email-in-body', () => {
  test('email in the JSON body works; query-string email is ignored', async () => {
    const email = `rt-claim-${randomUUID().slice(0, 8)}@example.test`;
    const created = await hit('POST', '/api/members', adminCookie, { email, role: 'member' });
    expect(created.status).toBe(200);
    const member = await created.json() as { id: string };

    const assigned = await hit('POST', '/api/connections', adminCookie, {
      membershipId: member.id,
      writeSpaceId: writeSpace.id,
      readSpaceIds: [readSpace.id],
      harness: 'generic',
    });
    expect(assigned.status).toBe(200);

    const minted = await hit('POST', `/api/members/${member.id}/claim-link`, adminCookie, {});
    expect(minted.status).toBe(200);
    const { token } = await minted.json() as { token: string };
    expect(token.length).toBeGreaterThan(20);

    const queryOnly = await app.request(
      `/api/claim/${token}?email=${encodeURIComponent(email)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.20' },
        body: JSON.stringify({}),
      },
    );
    expect(queryOnly.status).toBe(400);

    const wrongBody = await app.request(
      `/api/claim/${token}?email=${encodeURIComponent(email)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.21' },
        body: JSON.stringify({ email: 'other@example.test' }),
      },
    );
    expect(wrongBody.status).toBe(400);
    const [link] = await getDb().select().from(schema.claimLinks)
      .where(eq(schema.claimLinks.membershipId, member.id));
    expect(link?.claimedAt).toBeNull();

    const ok = await app.request(`/api/claim/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.22' },
      body: JSON.stringify({ email }),
    });
    expect(ok.status).toBe(200);
    const claimed = await ok.json() as {
      membershipId: string;
      connections: Array<{ connectionId: string; credentials: unknown }>;
    };
    expect(claimed.membershipId).toBe(member.id);
    expect(claimed.connections.length).toBe(1);
    expect(claimed.connections[0]!.credentials).toEqual({
      client_id: 'gbrain_cl_taken',
      client_secret: SECRET,
    });
    const audits = await getDb().select().from(schema.auditLog);
    expect(JSON.stringify(audits)).not.toContain(SECRET);
    expect(JSON.stringify(audits)).not.toContain(token);
  });

  test('is rate-limited by IP', async () => {
    const ip = '198.51.100.7';
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (await hit('POST', '/api/claim/rate-limit-token', undefined, { email: 'rl@example.test' }, ip)).status;
    }
    expect(last).toBe(429);
  });
});

describe('DELETE /api/members/:id offboard', () => {
  test('revokes connections and orphans write spaces (does not delete them)', async () => {
    const email = `rt-offboard-${randomUUID().slice(0, 8)}@example.test`;
    const created = await hit('POST', '/api/members', adminCookie, { email, role: 'member' });
    expect(created.status).toBe(200);
    const member = await created.json() as { id: string };

    const spaceId = randomUUID();
    await getDb().insert(schema.spaces).values({
      id: spaceId, organizationId: orgId, sourceId: `desk-${spaceId.slice(0, 8)}`,
      name: 'Desk', kind: 'local-git',
    });

    const assigned = await hit('POST', '/api/connections', adminCookie, {
      membershipId: member.id,
      writeSpaceId: spaceId,
      readSpaceIds: [readSpace.id],
      harness: 'generic',
    });
    expect(assigned.status).toBe(200);
    const conn = await assigned.json() as { id: string };

    await getDb().update(schema.connections).set({
      state: 'active', gbrainClientId: 'gbrain_cl_live', provisionedAt: new Date(),
    }).where(eq(schema.connections.id, conn.id));

    const res = await hit('DELETE', `/api/members/${member.id}`, adminCookie);
    expect(res.status).toBe(200);
    const body = await res.json() as { revoked: number; spaces: string };
    expect(body.revoked).toBe(1);
    expect(body.spaces).toBe('orphaned');

    const [space] = await getDb().select().from(schema.spaces).where(eq(schema.spaces.id, spaceId));
    expect(space).toBeDefined();
    expect(space?.sourceId).toMatch(/^desk-/);

    const [gone] = await getDb().select().from(schema.memberships)
      .where(eq(schema.memberships.id, member.id));
    expect(gone).toBeUndefined();

    const revoke = calls.find((c) => c.op === 'auth.revokeClient');
    expect(revoke).toBeDefined();
    expect(revoke!.opts?.json).not.toBe(true);
    expect(revoke!.params?.clientId).toBe('gbrain_cl_live');
  });
});
