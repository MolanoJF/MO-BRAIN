import { mock, test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';

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

function defaultTake(path: string) {
  takes.push(path);
  return { client_id: 'gbrain_cl_taken', client_secret: SECRET };
}

let takeHandler: (path: string) => Promise<unknown> | unknown = defaultTake;

function grantJson(clientId: string): unknown {
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

function defaultOk(op: string, opts?: CallOpts): OpsResult {
  return {
    ok: true,
    exitCode: 0,
    argv: ['gbrain', ...op.split('.')],
    stdout: '{}',
    stderr: '',
    json: op === 'mcp.grant' && !opts?.dryRun ? grantJson('gbrain_cl_mock') : { ok: true },
  };
}

let callOpsHandler: (op: string, params?: Record<string, unknown>, opts?: CallOpts) => Promise<OpsResult> | OpsResult =
  (op, _params, opts) => defaultOk(op, opts);

mock.module('../../src/control/opsClient.ts', () => ({
  // `src/control/spend.ts` imports this alongside the others; a mock that
  // omits a real export makes the whole graph unloadable (Slice 4 hazard (a)).
  brainUsage: async () => { throw new Error('ops unreachable'); },
  callOps: async (op: string, params?: Record<string, unknown>, opts?: CallOpts) => {
    calls.push({ op, params, opts });
    return callOpsHandler(op, params, opts);
  },
  takeGrantCredentials: async (path: string) => takeHandler(path),
  // Task 5's revoke path, reached through the app's new /api/runs mount
  // (agent/token.ts imports this alongside the others); a mock that omits a real
  // export makes the whole graph unloadable.
  deleteCredentialJournal: async () => ({ deleted: true }),
  patchFilePlaneConfig: async () => {},
  putSchemaPack: async () => {},
  putSchemaPackJson: async () => {},
  gitScaffold: async () => ({ created: [], skipped: [], sha: null }),
  removeSchemaPack: async () => ({ removed: false }),
  seedSpace: async () => {},
  resetBrainSchema: async () => {},
  opsHealthy: async () => true,
  commitAsMember: async () => ({ committed: false, sha: null }),
  inspectRepos: async () => [],
  // S1: routes/files.ts imports these alongside the rest, so a mock that omits
  // them makes the whole app graph unloadable.
  gitTree: async (sourceId: string) => ({ sourceId, root: `/repos/${sourceId}`, entries: [] }),
  gitReadFile: async (sourceId: string, path: string) => ({ content: '', sha: '', size: 0 }),
  gitWriteFile: async (req: { sourceId: string; path: string; content: string; expectedSha: string }) =>
    ({ committed: true, sha: 'written-sha' }),
}));

const { mintClaimLink, claim } = await import('../../src/control/claim.ts');
const { grantCredentialsOutPath, serverCredentialsOutPath, serverClientName } =
  await import('../../src/control/connections.ts');
const { runMigrations, getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { bootstrapFirstAdmin } = await import('../../src/control/bootstrap.ts');
const { clientName } = await import('../../src/contracts/compile.ts');
const { eq } = await import('drizzle-orm');

pinDb();

const EMAIL = 'member@example.test';
let orgId = '';
let actor = '';
let membershipId = '';
let writeSpace: { id: string; sourceId: string };
let writeSpace2: { id: string; sourceId: string };
let readSpace: { id: string; sourceId: string };

async function insertPending(space: { id: string; sourceId: string }, harness = 'generic') {
  const id = randomUUID();
  await getDb().insert(schema.connections).values({
    id,
    organizationId: orgId,
    membershipId,
    writeSpaceId: space.id,
    readSpaceIds: [readSpace.id],
    harness,
    clientName: clientName(membershipId, space.sourceId),
    gbrainClientId: null,
    profile: 'memory-writer',
    tokenTtl: 3600,
    state: 'pending',
  });
  return id;
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
  const boot = await bootstrapFirstAdmin('claim-admin@example.test', 'a-long-enough-password', 'ClaimCo');
  orgId = boot.orgId;
  actor = boot.userId;
  const [m] = await getDb().select().from(schema.memberships)
    .where(eq(schema.memberships.organizationId, orgId));
  if (!m) throw new Error('bootstrap membership missing');
  membershipId = m.id;

  writeSpace = { id: randomUUID(), sourceId: 'customers' };
  writeSpace2 = { id: randomUUID(), sourceId: 'internal' };
  readSpace = { id: randomUUID(), sourceId: 'shared' };
  await getDb().insert(schema.spaces).values([
    { id: writeSpace.id, organizationId: orgId, sourceId: writeSpace.sourceId, name: 'Customers', kind: 'local-git' },
    { id: writeSpace2.id, organizationId: orgId, sourceId: writeSpace2.sourceId, name: 'Internal', kind: 'local-git' },
    { id: readSpace.id, organizationId: orgId, sourceId: readSpace.sourceId, name: 'Shared', kind: 'local-git' },
  ]);
}, 90_000);

beforeEach(async () => {
  calls.length = 0;
  takes.length = 0;
  callOpsHandler = (op, _params, opts) => defaultOk(op, opts);
  takeHandler = defaultTake;
  await getDb().delete(schema.claimLinks);
  await getDb().delete(schema.connections);
  await getDb().delete(schema.auditLog);
});

afterAll(async () => {
  await closeDb();
});

describe('mintClaimLink', () => {
  test('returns the raw token once and persists only sha256(token)', async () => {
    const minted = await mintClaimLink(orgId, membershipId, EMAIL, actor);
    expect(minted.token.length).toBeGreaterThan(20);
    const ttl = minted.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(ttl).toBeLessThan(25 * 60 * 60 * 1000);

    const rows = await getDb().select().from(schema.claimLinks);
    expect(rows.length).toBe(1);
    expect(rows[0]!.tokenHash).toBe(createHash('sha256').update(minted.token).digest('hex'));
    expect(JSON.stringify(rows)).not.toContain(minted.token);
  });

  test('a second mint replaces the live unclaimed link', async () => {
    const first = await mintClaimLink(orgId, membershipId, EMAIL, actor);
    const second = await mintClaimLink(orgId, membershipId, EMAIL, actor);
    expect(second.token).not.toBe(first.token);

    const live = await getDb().select().from(schema.claimLinks);
    expect(live.length).toBe(1);
    expect(live[0]!.tokenHash).toBe(createHash('sha256').update(second.token).digest('hex'));

    let err: unknown;
    try {
      await claim(first.token, EMAIL);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/invalid|expired|used/i);
  });
});

describe('claim', () => {
  test('expired link rejected', async () => {
    const minted = await mintClaimLink(orgId, membershipId, EMAIL, actor);
    await getDb().update(schema.claimLinks)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.claimLinks.membershipId, membershipId));

    let err: unknown;
    try {
      await claim(minted.token, EMAIL);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/expired/i);
    expect(calls.some((c) => c.op === 'mcp.grant' && c.opts?.dryRun !== true)).toBe(false);
  });

  test('wrong email rejected', async () => {
    const minted = await mintClaimLink(orgId, membershipId, EMAIL, actor);
    let err: unknown;
    try {
      await claim(minted.token, 'other@example.test');
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/email/i);

    const [row] = await getDb().select().from(schema.claimLinks);
    expect(row?.claimedAt).toBeNull();
    expect(calls.some((c) => c.op === 'mcp.grant' && c.opts?.dryRun !== true)).toBe(false);
  });

  test('email match is case-insensitive', async () => {
    await insertPending(writeSpace);
    const minted = await mintClaimLink(orgId, membershipId, 'Member@Example.TEST', actor);
    const result = await claim(minted.token, 'member@example.test');
    expect(result.membershipId).toBe(membershipId);
    expect(result.connections.length).toBe(1);
  });

  test('second use of a burned link rejected', async () => {
    await insertPending(writeSpace);
    const minted = await mintClaimLink(orgId, membershipId, EMAIL, actor);
    await claim(minted.token, EMAIL);

    let err: unknown;
    try {
      await claim(minted.token, EMAIL);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/used|claimed|burned/i);
  });

  test('concurrent claims — exactly one wins', async () => {
    const pendingId = await insertPending(writeSpace);
    const minted = await mintClaimLink(orgId, membershipId, EMAIL, actor);

    const settled = await Promise.allSettled([
      claim(minted.token, EMAIL),
      claim(minted.token, EMAIL),
    ]);
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    // D8 (Task 5): one Connection is TWO gbrain clients — the member's and the
    // server-side one — so a winning claim grants twice and hands off two
    // credentials files. Exactly one claim wins, so exactly one Connection's
    // worth of provisioning happened: 2 grants, 2 takes, never 4.
    const grants = calls.filter((c) => c.op === 'mcp.grant' && c.opts?.dryRun !== true);
    expect(grants.length).toBe(2);
    expect(takes.length).toBe(2);

    const [row] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, pendingId));
    expect(row?.state).toBe('active');
    expect(row?.gbrainClientId).toBeTruthy();
  });

  test('raw token appears in no claim_links column', async () => {
    const minted = await mintClaimLink(orgId, membershipId, EMAIL, actor);
    const rows = await getDb().select().from(schema.claimLinks);
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows)).not.toContain(minted.token);
    for (const [k, v] of Object.entries(rows[0]!)) {
      expect(String(v ?? ''), k).not.toBe(minted.token);
      expect(String(v ?? ''), k).not.toContain(minted.token);
    }
  });

  test('membership with two pending Connections provisions both', async () => {
    const a = await insertPending(writeSpace);
    const b = await insertPending(writeSpace2);
    const minted = await mintClaimLink(orgId, membershipId, EMAIL, actor);
    const result = await claim(minted.token, EMAIL);

    expect(result.connections.length).toBe(2);
    const ids = result.connections.map((c) => c.connectionId).sort();
    expect(ids).toEqual([a, b].sort());

    // D8 (Task 5): two pending Connections, two clients each — 4 grants and 4
    // handoffs, one per client (the server client's taken inside
    // provisionConnection, the member's taken by claim itself).
    const grants = calls.filter((c) => c.op === 'mcp.grant' && c.opts?.dryRun !== true);
    expect(grants.length).toBe(4);
    expect(takes.length).toBe(4);

    for (const id of [a, b]) {
      const [row] = await getDb().select().from(schema.connections)
        .where(eq(schema.connections.id, id));
      expect(row?.state).toBe('active');
      expect(row?.gbrainClientId).toBeTruthy();
    }
  });

  test('credentials from takeGrantCredentials are on the claim result and not persisted', async () => {
    const pendingId = await insertPending(writeSpace, 'claude-code');
    const minted = await mintClaimLink(orgId, membershipId, EMAIL, actor);
    const result = await claim(minted.token, EMAIL);

    expect(result.connections.length).toBe(1);
    expect(result.connections[0]!.connectionId).toBe(pendingId);
    expect(result.connections[0]!.credentials).toEqual({
      client_id: 'gbrain_cl_taken',
      client_secret: SECRET,
    });
    expect(result.connections[0]!.harness).toBe('claude-code');
    expect(result.connections[0]!.mcp_url).toBe('http://127.0.0.1:3131/mcp');

    // D8 (Task 5): the member's client and the server-side client carry the
    // SAME compiled scoping, so the two grants differ only in name — the server
    // client's is `serverClientName(memberClientName)`.
    const grantNames = calls.filter((c) => c.op === 'mcp.grant' && c.opts?.dryRun !== true)
      .map((c) => c.params?.name);
    expect(grantNames).toEqual([
      clientName(membershipId, writeSpace.sourceId),
      serverClientName(clientName(membershipId, writeSpace.sourceId)),
    ]);

    // One handoff per client, from one file each, never a shared file: the
    // server client's is taken inside provisionServerClient (which is how its
    // secret reaches the `secrets` table), the member's by claim after
    // provisionConnection returns — and only the member's lands on the result.
    expect(takes).toEqual([
      serverCredentialsOutPath(pendingId),
      grantCredentialsOutPath(pendingId),
    ]);

    const claimRows = await getDb().select().from(schema.claimLinks);
    const connRows = await getDb().select().from(schema.connections);
    const audits = await getDb().select().from(schema.auditLog);
    expect(JSON.stringify(claimRows)).not.toContain(SECRET);
    expect(JSON.stringify(connRows)).not.toContain(SECRET);
    expect(JSON.stringify(audits)).not.toContain(SECRET);
    expect(JSON.stringify(claimRows)).not.toContain(minted.token);
  });

  test('grant failure after burn compensates pending and remint retries', async () => {
    const pendingId = await insertPending(writeSpace);
    const liveName = clientName(membershipId, writeSpace.sourceId);
    const minted = await mintClaimLink(orgId, membershipId, EMAIL, actor);

    callOpsHandler = (op, _params, opts) => {
      if (op === 'mcp.grant' && !opts?.dryRun) {
        return {
          ok: false, exitCode: 1, argv: ['gbrain', 'mcp', 'grant'],
          stdout: '', stderr: 'grant failed', json: null,
        };
      }
      return defaultOk(op, opts);
    };

    let err: unknown;
    try {
      await claim(minted.token, EMAIL);
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/claim provision failed; remint to retry/i);

    const [row] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, pendingId));
    expect(row?.state).toBe('pending');
    expect(row?.clientName).toBe(liveName);
    expect(row?.gbrainClientId).toBeNull();

    let replay: unknown;
    try {
      await claim(minted.token, EMAIL);
    } catch (e) {
      replay = e;
    }
    expect(String(replay)).toMatch(/used|claimed|burned/i);

    callOpsHandler = (op, _params, opts) => defaultOk(op, opts);
    const reminted = await mintClaimLink(orgId, membershipId, EMAIL, actor);
    const result = await claim(reminted.token, EMAIL);
    expect(result.connections.length).toBe(1);
    expect(result.connections[0]!.connectionId).toBe(pendingId);

    const [active] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, pendingId));
    expect(active?.state).toBe('active');
  });

  test('take failure after grant revokes, restores pending client_name, remint retries', async () => {
    const pendingId = await insertPending(writeSpace);
    const liveName = clientName(membershipId, writeSpace.sourceId);
    const minted = await mintClaimLink(orgId, membershipId, EMAIL, actor);

    takeHandler = async () => {
      throw new Error('take exploded');
    };

    let err: unknown;
    try {
      await claim(minted.token, EMAIL);
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/claim provision failed; remint to retry/i);
    expect(String(err)).toMatch(/take exploded/);

    const revoke = calls.find((c) => c.op === 'auth.revokeClient');
    expect(revoke).toBeDefined();
    expect(revoke!.params).not.toHaveProperty('reissue');

    const [row] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, pendingId));
    expect(row?.state).toBe('pending');
    expect(row?.clientName).toBe(liveName);
    expect(row?.gbrainClientId).toBeNull();
    expect(row?.revokedAt).toBeNull();

    takeHandler = defaultTake;
    const reminted = await mintClaimLink(orgId, membershipId, EMAIL, actor);
    const result = await claim(reminted.token, EMAIL);
    expect(result.connections.length).toBe(1);
    expect(result.connections[0]!.connectionId).toBe(pendingId);
    expect(result.connections[0]!.credentials).toEqual({
      client_id: 'gbrain_cl_taken',
      client_secret: SECRET,
    });

    const [active] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, pendingId));
    expect(active?.state).toBe('active');
    expect(active?.clientName).toBe(liveName);
  });
});
