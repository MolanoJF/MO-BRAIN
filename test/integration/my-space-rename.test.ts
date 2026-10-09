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

mock.module('../../src/control/opsClient.ts', () => ({
  callOps: async (op: string, params: Record<string, unknown> = {}, opts?: CallOpts) => {
    opsCalls.push({ op, params, opts });
    return opsHandler(op, params, opts);
  },
  patchFilePlaneConfig: async () => {},
  putSchemaPack: async () => {},
  putSchemaPackJson: async () => {},
  gitScaffold: async () => ({ created: [], skipped: [], sha: null }),
  readSchemaPackRaw: async () => null,
  removeSchemaPack: async () => ({ removed: false }),
  seedSpace: async () => {},
  // --- the rest of the module's real exports, required for the app graph to
  //     load at all under per-file isolation. Copy verbatim from
  //     test/integration/schema-routes.test.ts and keep in sync with opsClient.ts. ---
  brainUsage: async () => { throw new Error('ops unreachable'); },
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
  gitSetRemote: async () => ({ configured: true }),
  gitClearRemote: async () => ({ removed: true }),
  gitWriteFile: async () => ({ committed: true, sha: 'written-sha' }),
}));

const { default: app } = await import('../../src/control/app.ts');
const { runMigrations, getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { bootstrapFirstAdmin } = await import('../../src/control/bootstrap.ts');
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


const spaceRow = async (sourceId: string) => {
  const [row] = await getDb().select().from(schema.spaces).where(eq(schema.spaces.sourceId, sourceId));
  return row ?? null;
};

async function membershipIdOf(email: string) {
  const [row] = await getDb().select({ id: schema.memberships.id }).from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.users.email, email));
  return row!.id;
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
  const boot = await bootstrapFirstAdmin('myspace-owner@example.test', PASS, 'MySpaceCo', { brainMode: 'company' });
  orgId = boot.orgId;
  ownerCookie = await signIn('myspace-owner@example.test', PASS);
  memberCookie = await makeMember('myspace-member@example.test');
});

beforeEach(async () => {
  opsCalls.length = 0;
  opsHandler = () => { throw new Error('PATCH /my/space must not reach gbrain'); };
  await getDb().delete(schema.auditLog);
  await getDb().delete(schema.spaces);
});

afterAll(async () => {
  await closeDb();
});

async function insertPrivateSpace(sourceId: string, ownerEmail: string, name: string) {
  await getDb().insert(schema.spaces).values({
    id: randomUUID(), organizationId: orgId, sourceId, name,
    kind: 'local-git', localPath: `/srv/brain-repos/${sourceId}`,
    ownerMembershipId: await membershipIdOf(ownerEmail),
  });
}

test('PATCH /my/space renames the caller\'s private Space without a gbrain call', async () => {
  await insertPrivateSpace('priv-a', 'myspace-member@example.test', 'Old');
  await insertPrivateSpace('priv-b', 'myspace-owner@example.test', 'Other');
  const res = await hit('PATCH', '/api/my/space', memberCookie, { name: '  New name  ' });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, sourceId: 'priv-a', name: 'New name' });
  expect(await spaceRow('priv-a')).toMatchObject({ name: 'New name' });
  expect(await spaceRow('priv-b')).toMatchObject({ name: 'Other' });
  expect(opsCalls).toHaveLength(0);
  const [row] = await getDb().select().from(schema.auditLog)
    .where(eq(schema.auditLog.organizationId, orgId)).orderBy(desc(schema.auditLog.at)).limit(1);
  expect(row).toMatchObject({ action: 'source.rename', target: 'priv-a', after: { name: 'New name' } });
});

test('PATCH /my/space rejects an empty or missing name with 400', async () => {
  await insertPrivateSpace('priv-a', 'myspace-member@example.test', 'Old');
  expect((await hit('PATCH', '/api/my/space', memberCookie, { name: '   ' })).status).toBe(400);
  expect((await hit('PATCH', '/api/my/space', memberCookie, {})).status).toBe(400);
  expect(await spaceRow('priv-a')).toMatchObject({ name: 'Old' });
});

test('PATCH /my/space returns no_private_space when the caller has none', async () => {
  const res = await hit('PATCH', '/api/my/space', memberCookie, { name: 'X' });
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBe('no_private_space');
});

test('PATCH /my/space needs a signed-in caller', async () => {
  expect((await hit('PATCH', '/api/my/space', undefined, { name: 'X' })).status).toBe(401);
});
