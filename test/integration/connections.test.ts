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
/** credentialsOut paths handed to takeGrantCredentials, in call order. */
const handoffsTaken: string[] = [];
/** Client ids whose credential journal ops was asked to delete. */
const journalDeletes: string[] = [];

let grantSeq = 0;

/** A grant receipt for a named client — the shape, without touching the
 *  per-grant counter, so assertions can compare against it. */
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
  // Pin receipt (credentialReceipt): top-level client_id, credentials is the
  // string 'private-file' — not { client_id } and not grant.clientId.
  // Distinct id per grant: a Connection mints the member's client AND the
  // server-side one, and a run mints its own.
  const n = grantSeq++;
  return grantReceipt(n === 0 ? 'gbrain_cl_mock' : `gbrain_cl_mock_${n}`);
}

/** The private handoff `mcp grant` wrote for the client it just minted. */
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
  return {
    ok: true,
    exitCode: 0,
    argv: ['gbrain', ...op.split('.')],
    stdout: '{}',
    stderr: '',
    json: op === 'mcp.grant' ? grantJson(Boolean(opts?.dryRun)) : { ok: true },
  };
}

/** What `takeGrantCredentials` returns. Swapped by the tests that exercise a
 *  mint whose handoff cannot be read. */
let handoffHandler: () => Promise<unknown> = async () => HANDOFF;

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
  patchFilePlaneConfig: async () => {},
  putSchemaPack: async () => {},
  putSchemaPackJson: async () => {},
  readSchemaPackRaw: async () => null,
  gitScaffold: async () => ({ created: [], skipped: [], sha: null }),
  removeSchemaPack: async () => ({ removed: false }),
  seedSpace: async () => {},
  gitSetRemote: async (r: { url: string }) => ({ url: r.url, branch: 'main' }),
  gitClearRemote: async () => ({ removed: true }),
  resetBrainSchema: async () => {},
  pauseBrainWriters: async () => {},
  resumeBrainWriters: async () => {},
  takeGrantCredentials: async (path: string) => {
    handoffsTaken.push(path);
    return handoffHandler();
  },
  deleteCredentialJournal: async (clientId: string) => {
    journalDeletes.push(clientId);
    return { deleted: true };
  },
  opsHealthy: async () => true,
  commitAsMember: async () => ({ committed: false, sha: null }),
  inspectRepos: async () => [],
  // The remaining real exports, for the same reason as `brainUsage` above:
  // under per-file isolation a partial mock REPLACES the module, so every
  // export the app graph imports must exist here or the graph fails to load.
  writeReport: async () => ({ relPath: '', committed: false, sha: null }),
  cancelRun: async () => ({ cancelled: false }),
  gitRange: async () => ({ commits: [], files: [] }),
  gitPathExists: async () => ({ paths: [] }),
  gitRevertRange: async () => ({ outcome: 'nothing_to_revert' }),
  auditTail: async () => [],
  // S1: routes/files.ts imports these alongside the rest, so a mock that omits
  // them makes the whole app graph unloadable.
  gitTree: async (sourceId: string) => ({ sourceId, root: `/repos/${sourceId}`, entries: [] }),
  gitExportBundle: async () => new Response(null),
  gitReadFile: async (sourceId: string, path: string) => ({ content: '', sha: '', size: 0 }),
  gitWriteFile: async (req: { sourceId: string; path: string; content: string; expectedSha: string }) =>
    ({ committed: true, sha: 'written-sha' }),
}));

const {
  previewConnection, provisionConnection, revokeConnection, createPendingConnection,
  retiredClientName, widenConnectionSurfaces,
} = await import('../../src/control/connections.ts');
const { serverClientSecretName, serverClientName, memberClientSecretName } =
  await import('../../src/control/connections.ts');
const { mintRunToken, revokeRunToken } = await import('../../src/agent/token.ts');
const { readSecret } = await import('../../src/control/secrets.ts');
const { runMigrations, getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { bootstrapFirstAdmin } = await import('../../src/control/bootstrap.ts');
const { clientName } = await import('../../src/contracts/compile.ts');
const { eq } = await import('drizzle-orm');

pinDb();

let orgId = '';
let actor = '';
let membershipId = '';
let writeSpace: { id: string; sourceId: string };
let readSpace: { id: string; sourceId: string };

function input(over: Partial<{
  connectionId: string;
  writeSpaceId: string;
  readSpaceIds: string[];
  harness: string;
  boundSlugPrefixes: string[];
  tokenTtl: number;
  budgetUsdPerDay: number;
}> = {}) {
  return {
    organizationId: orgId,
    membershipId,
    writeSpaceId: over.writeSpaceId ?? writeSpace.id,
    readSpaceIds: over.readSpaceIds ?? [readSpace.id],
    harness: over.harness ?? 'generic',
    memberRole: 'member' as const,
    ...over,
  };
}

async function insertConnection(state: 'pending' | 'active' | 'revoked', extra: {
  gbrainClientId?: string | null;
  clientName?: string;
  readSpaceIds?: string[];
} = {}) {
  const id = randomUUID();
  const name = extra.clientName ?? clientName(membershipId, writeSpace.sourceId);
  await getDb().insert(schema.connections).values({
    id,
    organizationId: orgId,
    membershipId,
    writeSpaceId: writeSpace.id,
    readSpaceIds: extra.readSpaceIds ?? [readSpace.id],
    harness: 'generic',
    clientName: name,
    gbrainClientId: extra.gbrainClientId === undefined
      ? (state === 'pending' ? null : 'gbrain_cl_live')
      : extra.gbrainClientId,
    profile: 'memory-writer',
    tokenTtl: 3600,
    state,
    provisionedAt: state === 'pending' ? null : new Date(),
  });
  return { id, clientName: name };
}

/** An agent_prompt schedule + its run row, so `agent_runs` has a real parent. */
async function insertAgentRun(gbrainClientId: string | null = 'gbrain_cl_run'): Promise<string> {
  const scheduleId = randomUUID();
  await getDb().insert(schema.schedules).values({
    id: scheduleId,
    organizationId: orgId,
    connectionId: null,
    name: `agent-job-${scheduleId.slice(0, 8)}`,
    jobType: 'agent_prompt',
    operation: null,
    agentPrompt: 'summarise the week',
    agentModel: 'haiku-4-5',
    agentMaxTokens: 2048,
    agentBudgetUsd: '1.00',
    agentHarnessVersion: '2.1.274',
    kind: 'interval',
    intervalSeconds: 3600,
    anchorAt: new Date(),
    enabled: false,
    createdBy: actor,
  });
  const runId = randomUUID();
  await getDb().insert(schema.scheduleRuns).values({
    id: runId,
    scheduleId,
    organizationId: orgId,
    slot: `agent-slot-${runId.slice(0, 8)}`,
    fireAt: new Date(),
    state: 'running',
  });
  await getDb().insert(schema.agentRuns).values({
    runId,
    organizationId: orgId,
    connectionId: null,
    model: 'haiku-4-5',
    harnessVersion: '2.1.274',
    budgetUsd: '1.00',
    gbrainClientId,
  });
  return runId;
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
  const boot = await bootstrapFirstAdmin('conn-admin@example.test', 'a-long-enough-password', 'ConnCo');
  orgId = boot.orgId;
  actor = boot.userId;
  const [m] = await getDb().select().from(schema.memberships)
    .where(eq(schema.memberships.organizationId, orgId));
  if (!m) throw new Error('bootstrap membership missing');
  membershipId = m.id;

  writeSpace = { id: randomUUID(), sourceId: 'customers' };
  readSpace = { id: randomUUID(), sourceId: 'shared' };
  await getDb().insert(schema.spaces).values([
    { id: writeSpace.id, organizationId: orgId, sourceId: writeSpace.sourceId, name: 'Customers', kind: 'local-git' },
    { id: readSpace.id, organizationId: orgId, sourceId: readSpace.sourceId, name: 'Shared', kind: 'local-git' },
  ]);
}, 90_000);

beforeEach(async () => {
  calls.length = 0;
  handoffsTaken.length = 0;
  journalDeletes.length = 0;
  grantSeq = 0;
  handoffHandler = async () => HANDOFF;
  callOpsHandler = (op, _params, opts) => defaultOk(op, opts);
  await getDb().delete(schema.agentRuns);
  await getDb().delete(schema.scheduleRuns);
  await getDb().delete(schema.schedules);
  await getDb().delete(schema.connections);
  await getDb().delete(schema.auditLog);
});

afterAll(async () => {
  await closeDb();
});

describe('previewConnection', () => {
  test('new connection preview uses mcp.grant with dryRun+json (previewSource server)', async () => {
    const preview = await previewConnection(input());
    expect(preview.previewSource).toBe('server');
    expect(preview.serverPreview).toEqual(grantJson(true));
    expect(preview.compiled.profile).toBe('memory-writer');
    expect(preview.compiled.sourceId).toBe('customers');
    expect(preview.diff.additions.length).toBeGreaterThan(0);

    const grant = calls.find((c) => c.op === 'mcp.grant');
    expect(grant).toBeDefined();
    expect(grant!.opts?.dryRun).toBe(true);
    expect(grant!.opts?.json).toBe(true);
    expect(grant!.params?.name).toBe(clientName(membershipId, writeSpace.sourceId));
    expect(grant!.params?.url).toBeTruthy();
    expect(grant!.params).not.toHaveProperty('reissue');
    expect(calls.some((c) => c.op === 'auth.rescopeClient')).toBe(false);
  });

  test('a rescope never requests --dry-run on auth.rescopeClient', async () => {
    const existing = await insertConnection('active');
    const preview = await previewConnection(input({
      connectionId: existing.id,
      readSpaceIds: [],
    }));

    expect(preview.previewSource).toBe('computed');
    expect(preview.serverPreview).toBeNull();
    expect(preview.diff.removals).toContain('shared');

    const rescope = calls.filter((c) => c.op === 'auth.rescopeClient');
    expect(rescope.every((c) => c.opts?.dryRun !== true)).toBe(true);
    expect(calls.some((c) => c.op === 'mcp.grant')).toBe(false);
  });

  test('collision on clientName fails loudly; never --reissue', async () => {
    const existing = await insertConnection('active');
    const [row] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, existing.id));
    expect(row?.clientName).toBe(clientName(membershipId, writeSpace.sourceId));

    let err: unknown;
    try {
      await previewConnection(input());
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/already used|collision|duplicate/i);
    expect(calls.some((c) => c.params && 'reissue' in c.params)).toBe(false);
    expect(calls.some((c) => c.op === 'mcp.grant')).toBe(false);
  });
});

describe('provisionConnection', () => {
  test('new grant uses credentialsOut, not --reissue, and persists gbrainClientId', async () => {
    const result = await provisionConnection(input(), actor);
    expect(result.connectionId).toBeTruthy();
    expect(result.credentials).toEqual(grantReceipt('gbrain_cl_mock'));

    const grant = calls.find((c) => c.op === 'mcp.grant');
    expect(grant).toBeDefined();
    expect(grant!.opts?.json).toBe(true);
    expect(grant!.opts?.dryRun).not.toBe(true);
    expect(grant!.params?.credentialsOut).toBeTruthy();
    expect(String(grant!.params?.credentialsOut)).toMatch(/^\/srv\/gbrain-home\//);
    expect(grant!.params).not.toHaveProperty('reissue');
    expect(grant!.params?.name).toBe(clientName(membershipId, writeSpace.sourceId));

    const [row] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, result.connectionId));
    expect(row?.state).toBe('active');
    expect(row?.gbrainClientId).toBe('gbrain_cl_mock');
    expect(row?.provisionedAt).toBeTruthy();
    expect(JSON.stringify(row)).not.toMatch(/client_secret|sk-/);

    const stored = await readSecret(orgId, memberClientSecretName(result.connectionId));
    expect(JSON.parse(String(stored))).toEqual(HANDOFF);
  });

  test('rescope never requests --dry-run on auth.rescopeClient', async () => {
    const existing = await insertConnection('active');
    await provisionConnection(input({ connectionId: existing.id, readSpaceIds: [] }), actor);

    const rescope = calls.filter((c) => c.op === 'auth.rescopeClient');
    expect(rescope.length).toBe(1);
    expect(rescope[0]!.opts?.dryRun).not.toBe(true);
    expect(rescope[0]!.params?.id).toBe('gbrain_cl_live');
    expect(rescope[0]!.params).not.toHaveProperty('reissue');
    expect(calls.some((c) => c.op === 'mcp.grant')).toBe(false);
  });

  test('mints the server-side client too, with the same compiled scoping (D8)', async () => {
    const result = await provisionConnection(
      input({ boundSlugPrefixes: ['customers/'], tokenTtl: 900 }),
      actor,
    );

    const grants = calls.filter((c) => c.op === 'mcp.grant');
    expect(grants.length).toBe(2);
    const [member, server] = grants;
    expect(member!.params?.name).toBe(clientName(membershipId, writeSpace.sourceId));
    expect(server!.params?.name).toBe(serverClientName(String(member!.params?.name)));
    expect(server!.opts?.json).toBe(true);
    expect(server!.params).not.toHaveProperty('reissue');

    // Identical compiled scoping: one compiler, so every scoping flag matches.
    for (const key of ['profile', 'source', 'federatedRead', 'boundSlugPrefixes', 'tokenTtl', 'budgetUsdPerDay']) {
      expect(server!.params?.[key]).toEqual(member!.params?.[key]);
    }
    expect(server!.params?.profile).toBe('memory-writer');
    expect(server!.params?.source).toBe('customers');
    expect(server!.params?.federatedRead).toEqual(['shared']);
    expect(server!.params?.boundSlugPrefixes).toBe('customers/');
    expect(server!.params?.tokenTtl).toBe('900');

    // Its own handoff, not the member's: the two secrets never share a file.
    expect(server!.params?.credentialsOut).not.toBe(member!.params?.credentialsOut);
    const serverOut = String(server!.params?.credentialsOut);
    expect(serverOut).toMatch(/^\/srv\/gbrain-home\/\.creds-[\w-]+-server\.json$/);
    expect(handoffsTaken).toEqual([String(member!.params?.credentialsOut), serverOut]);

    const [row] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, result.connectionId));
    expect(row?.gbrainClientId).toBe('gbrain_cl_mock');
    expect(row?.serverClientId).toBe('gbrain_cl_mock_1');
    expect(row?.state).toBe('active');

    // S3b: the secret is stored, envelope-encrypted, under the documented name.
    const stored = await readSecret(orgId, serverClientSecretName(result.connectionId));
    expect(JSON.parse(String(stored)).client_secret).toBe(HANDOFF.client_secret);
    // F7: the plaintext journal the grant retained is deleted, and no secret
    // ever reaches the connection row.
    expect(journalDeletes).toEqual(['gbrain_cl_mock', 'gbrain_cl_mock_1']);
    expect(JSON.stringify(row)).not.toMatch(/not-a-real-secret/);
  });

  test('a failed server-client grant leaves no live member client behind', async () => {
    callOpsHandler = async (op, params, opts) => {
      if (op === 'mcp.grant' && String(params?.name).endsWith('-server')) {
        return {
          ok: false, exitCode: 1, argv: ['gbrain', 'mcp', 'grant'],
          stdout: '', stderr: 'mcp_setup_failed', json: null,
        };
      }
      return defaultOk(op, opts);
    };

    let err: unknown;
    try {
      await provisionConnection(input(), actor);
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/server client/);

    const revoked = calls.filter((c) => c.op === 'auth.revokeClient').map((c) => c.params?.clientId);
    expect(revoked).toEqual(['gbrain_cl_mock']);

    const [row] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.organizationId, orgId));
    expect(row?.state).toBe('pending');
    expect(row?.gbrainClientId).toBeNull();
    expect(row?.serverClientId).toBeNull();
  });

  test('a rescope moves BOTH clients, so the pair never drifts (D8)', async () => {
    const result = await provisionConnection(input(), actor);
    calls.length = 0;

    const memberName = memberClientSecretName(result.connectionId);
    const versionsBefore = (await getDb().select({ version: schema.secrets.version })
      .from(schema.secrets)
      .where(eq(schema.secrets.name, memberName)))
      .map((r) => r.version)
      .sort((a, b) => a - b);
    expect(versionsBefore).toEqual([1]);

    await provisionConnection(
      input({ connectionId: result.connectionId, readSpaceIds: [] }),
      actor,
    );

    const versionsAfter = (await getDb().select({ version: schema.secrets.version })
      .from(schema.secrets)
      .where(eq(schema.secrets.name, memberName)))
      .map((r) => r.version)
      .sort((a, b) => a - b);
    expect(versionsAfter).toEqual(versionsBefore);

    const rescopes = calls.filter((c) => c.op === 'auth.rescopeClient');
    expect(rescopes.map((c) => c.params?.id)).toEqual(['gbrain_cl_mock_1', 'gbrain_cl_mock']);
    // The server client is rescoped first: a failure there has moved nothing the
    // member's client depends on.
    expect(rescopes.every((c) => c.opts?.dryRun !== true)).toBe(true);
    expect(calls.some((c) => c.op === 'mcp.grant')).toBe(false);
  });

  test('a failed server-client rescope leaves the member client untouched', async () => {
    const result = await provisionConnection(input(), actor);
    calls.length = 0;
    callOpsHandler = async (op, params, opts) => {
      if (op === 'auth.rescopeClient' && params?.id === 'gbrain_cl_mock_1') {
        return {
          ok: false, exitCode: 1, argv: ['gbrain', 'auth', 'rescope-client'],
          stdout: '', stderr: 'unknown client', json: null,
        };
      }
      return defaultOk(op, opts);
    };

    let err: unknown;
    try {
      await provisionConnection(input({ connectionId: result.connectionId, readSpaceIds: [] }), actor);
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/server client/);
    expect(calls.filter((c) => c.op === 'auth.rescopeClient').map((c) => c.params?.id))
      .toEqual(['gbrain_cl_mock_1']);
  });

  test('collision on clientName fails loudly; never --reissue', async () => {
    await insertConnection('active');
    let err: unknown;
    try {
      await provisionConnection(input(), actor);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/already used|collision|duplicate/i);
    expect(calls.some((c) => c.params && 'reissue' in c.params)).toBe(false);
    expect(calls.some((c) => c.op === 'mcp.grant')).toBe(false);
  });

  test('a new mint applies the compiled full surface to BOTH clients', async () => {
    await provisionConnection(input(), actor);

    const rescopes = calls.filter((c) => c.op === 'auth.rescopeClient');
    expect(rescopes.map((c) => c.params?.id).sort()).toEqual(['gbrain_cl_mock', 'gbrain_cl_mock_1']);
    for (const r of rescopes) {
      expect(r.params?.surface).toBe('full');
      expect(r.opts?.dryRun).not.toBe(true);
    }
  });

  test('a failed member surface rescope revokes both minted clients', async () => {
    callOpsHandler = async (op, params, opts) => {
      if (op === 'auth.rescopeClient' && params?.id === 'gbrain_cl_mock') {
        return {
          ok: false, exitCode: 1, argv: ['gbrain', 'auth', 'rescope-client'],
          stdout: '', stderr: 'boom', json: null,
        };
      }
      return defaultOk(op, opts);
    };

    let err: unknown;
    try { await provisionConnection(input(), actor); } catch (e) { err = e; }
    expect(String(err)).toMatch(/surface/);

    const revoked = calls.filter((c) => c.op === 'auth.revokeClient').map((c) => c.params?.clientId);
    expect(revoked.sort()).toEqual(['gbrain_cl_mock', 'gbrain_cl_mock_1']);
    const [row] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.organizationId, orgId));
    expect(row?.state).toBe('pending');
  });

  test('a failed server surface rescope revokes the server client and the member client', async () => {
    callOpsHandler = async (op, params, opts) => {
      if (op === 'auth.rescopeClient' && params?.id === 'gbrain_cl_mock_1') {
        return {
          ok: false, exitCode: 1, argv: ['gbrain', 'auth', 'rescope-client'],
          stdout: '', stderr: 'boom', json: null,
        };
      }
      return defaultOk(op, opts);
    };

    let err: unknown;
    try { await provisionConnection(input(), actor); } catch (e) { err = e; }
    expect(String(err)).toMatch(/surface/);
    const revoked = calls.filter((c) => c.op === 'auth.revokeClient').map((c) => c.params?.clientId);
    expect(revoked.sort()).toEqual(['gbrain_cl_mock', 'gbrain_cl_mock_1']);
  });
});

describe('widenConnectionSurfaces', () => {
  test('rescopes both clients of every active Connection to full and skips the rest', async () => {
    const active = await insertConnection('active');
    await getDb().update(schema.connections)
      .set({ serverClientId: 'gbrain_cl_live_server' })
      .where(eq(schema.connections.id, active.id));
    await insertConnection('revoked', { clientName: 'bs-revoked-x', gbrainClientId: 'gbrain_cl_dead' });

    const out = await widenConnectionSurfaces(actor);

    expect(out.widened).toEqual([active.id]);
    expect(out.failed).toEqual([]);
    const rescopes = calls.filter((c) => c.op === 'auth.rescopeClient');
    expect(rescopes.map((c) => c.params?.id)).toEqual(['gbrain_cl_live_server', 'gbrain_cl_live']);
    expect(rescopes.every((c) => c.params?.surface === 'full')).toBe(true);
    const audits = await getDb().select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'connection.widen_surface'));
    expect(audits.map((a) => a.target)).toEqual([active.id]);
  });

  test('one failing Connection is reported and does not stop the rest', async () => {
    const a = await insertConnection('active', { clientName: 'bs-a', gbrainClientId: 'gbrain_cl_a' });
    const b = await insertConnection('active', { clientName: 'bs-b', gbrainClientId: 'gbrain_cl_b' });
    callOpsHandler = async (op, params, opts) => {
      if (op === 'auth.rescopeClient' && params?.id === 'gbrain_cl_a') {
        return { ok: false, exitCode: 1, argv: [], stdout: '', stderr: 'gone', json: null };
      }
      return defaultOk(op, opts);
    };

    const out = await widenConnectionSurfaces(actor);
    expect(out.widened).toEqual([b.id]);
    expect(out.failed.map((f) => f.connectionId)).toEqual([a.id]);
  });
});

describe('revokeConnection', () => {
  test('auth.revokeClient is called without json: true', async () => {
    const existing = await insertConnection('active');
    await revokeConnection(existing.id, actor);

    const revoke = calls.find((c) => c.op === 'auth.revokeClient');
    expect(revoke).toBeDefined();
    expect(revoke!.opts?.json).not.toBe(true);
    expect(revoke!.params?.clientId).toBe('gbrain_cl_live');
    expect(revoke!.params).not.toHaveProperty('reissue');

    const [row] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, existing.id));
    expect(row?.state).toBe('revoked');
    expect(row?.revokedAt).toBeTruthy();
    expect(row?.clientName).toBe(retiredClientName(existing.id));
  });

  test('revoke frees client_name so the same membership+write Space can be re-created', async () => {
    const result = await provisionConnection(input(), actor);
    await revokeConnection(result.connectionId, actor);

    const [revoked] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, result.connectionId));
    expect(revoked?.state).toBe('revoked');
    expect(revoked?.clientName).toBe(retiredClientName(result.connectionId));
    expect(revoked?.clientName).not.toBe(clientName(membershipId, writeSpace.sourceId));

    const created = await createPendingConnection(input());
    expect(created.connectionId).not.toBe(result.connectionId);

    const [pending] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, created.connectionId));
    expect(pending?.state).toBe('pending');
    expect(pending?.clientName).toBe(clientName(membershipId, writeSpace.sourceId));
    expect(calls.some((c) => c.params && 'reissue' in c.params)).toBe(false);
  });

  test('audit row exists before the revoke call', async () => {
    const existing = await insertConnection('active');
    callOpsHandler = async (op, params, opts) => {
      if (op === 'auth.revokeClient') throw new Error('revoke exploded');
      return defaultOk(op, opts);
    };

    let err: unknown;
    try {
      await revokeConnection(existing.id, actor);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/revoke exploded/);

    const audits = await getDb().select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'connection.revoke'));
    expect(audits.length).toBe(1);
    expect(audits[0]!.target).toBe(existing.id);
    expect(JSON.stringify(audits[0])).not.toMatch(/client_secret/);

    const [row] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, existing.id));
    expect(row?.state).toBe('active');
    expect(row?.revokedAt).toBeNull();

    const revoke = calls.find((c) => c.op === 'auth.revokeClient');
    expect(revoke).toBeDefined();
    expect(revoke!.opts?.json).not.toBe(true);
  });

  test('failed revoke leaves state unchanged but keeps the audit row', async () => {
    const existing = await insertConnection('active');
    callOpsHandler = async (op, _params, opts) => {
      if (op === 'auth.revokeClient') {
        return {
          ok: false, exitCode: 1, argv: ['gbrain', 'auth', 'revoke-client'],
          stdout: '', stderr: 'No client found', json: null,
        };
      }
      return defaultOk(op, opts);
    };

    let err: unknown;
    try {
      await revokeConnection(existing.id, actor);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/revoke/i);

    const [row] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, existing.id));
    expect(row?.state).toBe('active');
    expect(row?.revokedAt).toBeNull();

    const audits = await getDb().select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'connection.revoke'));
    expect(audits.length).toBe(1);
  });

  test('revokes BOTH clients and deletes both credential journals (D8, F7)', async () => {
    const result = await provisionConnection(input(), actor);
    calls.length = 0;
    journalDeletes.length = 0;

    await revokeConnection(result.connectionId, actor);

    const revoked = calls.filter((c) => c.op === 'auth.revokeClient').map((c) => c.params?.clientId);
    expect(revoked).toEqual(['gbrain_cl_mock', 'gbrain_cl_mock_1']);
    expect(journalDeletes).toEqual(['gbrain_cl_mock', 'gbrain_cl_mock_1']);

    const [row] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, result.connectionId));
    expect(row?.state).toBe('revoked');
    expect(row?.revokedAt).toBeTruthy();
  });

  test('a failed server-client revoke does not mark the Connection revoked', async () => {
    const result = await provisionConnection(input(), actor);
    callOpsHandler = async (op, params, opts) => {
      if (op === 'auth.revokeClient' && params?.clientId === 'gbrain_cl_mock_1') {
        return {
          ok: false, exitCode: 1, argv: ['gbrain', 'auth', 'revoke-client'],
          stdout: '', stderr: 'No client found', json: null,
        };
      }
      return defaultOk(op, opts);
    };

    let err: unknown;
    try {
      await revokeConnection(result.connectionId, actor);
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/server client/);

    const [row] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, result.connectionId));
    expect(row?.state).toBe('active');
    expect(row?.revokedAt).toBeNull();
  });
});

describe('run token lane (D8)', () => {
  test('mints a run-scoped client carrying the Connection scoping and the RUN ttl', async () => {
    const conn = await insertConnection('active');
    calls.length = 0;

    const minted = await mintRunToken(conn.id, 900);

    const grant = calls.find((c) => c.op === 'mcp.grant');
    expect(grant).toBeDefined();
    expect(grant!.opts?.json).toBe(true);
    expect(String(grant!.params?.name)).toMatch(/^bs-run-[0-9a-f]{8}-[0-9a-f]{12}$/);
    expect(grant!.params).not.toHaveProperty('reissue');
    // The Connection's compiled scoping, verbatim.
    expect(grant!.params?.profile).toBe('memory-writer');
    expect(grant!.params?.source).toBe('customers');
    expect(grant!.params?.federatedRead).toEqual(['shared']);
    // The run's own deadline, not the Connection's 3600: TTL is defence in depth.
    expect(grant!.params?.tokenTtl).toBe('900');

    // One handoff, taken from the path the grant was told to write, and the
    // token out of it is what the runner gets.
    const runOut = String(grant!.params?.credentialsOut);
    expect(runOut).toMatch(/^\/srv\/gbrain-home\/\.creds-run-[0-9a-f]{12}\.json$/);
    expect(handoffsTaken).toEqual([runOut]);
    expect(minted).toEqual({
      gbrainClientId: 'gbrain_cl_mock',
      accessToken: HANDOFF.access_token,
    });
  });

  test('refuses a Connection that is not active', async () => {
    const conn = await insertConnection('pending');

    let err: unknown;
    try {
      await mintRunToken(conn.id, 900);
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/not active/);
    expect(calls.some((c) => c.op === 'mcp.grant')).toBe(false);
  });

  test('a mint whose handoff cannot be read revokes its own client', async () => {
    const conn = await insertConnection('active');
    handoffHandler = async () => { throw new Error('credentials file was not json'); };

    let err: unknown;
    try {
      await mintRunToken(conn.id, 900);
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/not json/);

    const revoked = calls.filter((c) => c.op === 'auth.revokeClient').map((c) => c.params?.clientId);
    expect(revoked).toEqual(['gbrain_cl_mock']);
    expect(journalDeletes).toEqual(['gbrain_cl_mock']);
  });

  test('revokeRunToken kills the run client, deletes its journal, and stamps the run', async () => {
    const runId = await insertAgentRun('gbrain_cl_run');

    expect(await revokeRunToken(runId)).toEqual({ revoked: true });

    const revoked = calls.filter((c) => c.op === 'auth.revokeClient').map((c) => c.params?.clientId);
    expect(revoked).toEqual(['gbrain_cl_run']);
    expect(journalDeletes).toEqual(['gbrain_cl_run']);

    const [row] = await getDb().select().from(schema.agentRuns)
      .where(eq(schema.agentRuns.runId, runId));
    expect(row?.tokenRevokedAt).toBeTruthy();
  });

  test('is idempotent: the second call no-ops and leaves the stamp set', async () => {
    const runId = await insertAgentRun('gbrain_cl_run');
    await revokeRunToken(runId);
    const [first] = await getDb().select().from(schema.agentRuns)
      .where(eq(schema.agentRuns.runId, runId));
    calls.length = 0;
    journalDeletes.length = 0;

    expect(await revokeRunToken(runId)).toEqual({ revoked: false });

    // A second `auth revoke-client` for a deleted client exits 1 (measured), so
    // the no-op must not reach ops at all.
    expect(calls.length).toBe(0);
    const [row] = await getDb().select().from(schema.agentRuns)
      .where(eq(schema.agentRuns.runId, runId));
    expect(row?.tokenRevokedAt).toBeTruthy();
    expect(row!.tokenRevokedAt!.getTime()).toBeGreaterThanOrEqual(first!.tokenRevokedAt!.getTime());
  });

  test('two racing callers revoke exactly once', async () => {
    const runId = await insertAgentRun('gbrain_cl_run');

    const [a, b] = await Promise.all([revokeRunToken(runId), revokeRunToken(runId)]);

    expect([a.revoked, b.revoked].filter(Boolean).length).toBe(1);
    expect(calls.filter((c) => c.op === 'auth.revokeClient').length).toBe(1);
  });

  test('a run whose mint never returned is stamped without an ops call', async () => {
    const runId = await insertAgentRun(null);

    expect(await revokeRunToken(runId)).toEqual({ revoked: true });
    expect(calls.length).toBe(0);

    const [row] = await getDb().select().from(schema.agentRuns)
      .where(eq(schema.agentRuns.runId, runId));
    expect(row?.tokenRevokedAt).toBeTruthy();
  });

  test('a failed revoke releases the stamp so a retry can revoke', async () => {
    const runId = await insertAgentRun('gbrain_cl_run');
    callOpsHandler = async (op, _params, opts) => {
      if (op === 'auth.revokeClient') {
        return {
          ok: false, exitCode: 1, argv: ['gbrain', 'auth', 'revoke-client'],
          stdout: '', stderr: 'No client found', json: null,
        };
      }
      return defaultOk(op, opts);
    };

    let err: unknown;
    try {
      await revokeRunToken(runId);
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/revokeClient/);
    let [row] = await getDb().select().from(schema.agentRuns)
      .where(eq(schema.agentRuns.runId, runId));
    expect(row?.tokenRevokedAt).toBeNull();

    callOpsHandler = (op, _params, opts) => defaultOk(op, opts);
    expect(await revokeRunToken(runId)).toEqual({ revoked: true });
    [row] = await getDb().select().from(schema.agentRuns)
      .where(eq(schema.agentRuns.runId, runId));
    expect(row?.tokenRevokedAt).toBeTruthy();
  });

  test('refuses a run id that does not exist', async () => {
    let err: unknown;
    try {
      await revokeRunToken(randomUUID());
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/not found/);
  });
});
