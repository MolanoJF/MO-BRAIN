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

function grantJson(dryRun: boolean): unknown {
  if (dryRun) {
    return { status: 'preview', grant: { profile: 'memory-writer', sourceId: 'customers' } };
  }
  return {
    status: 'granted',
    grant: { clientId: 'gbrain_cl_mock' },
    credentials: { client_id: 'gbrain_cl_mock', credentials: 'private-file', mcp_url: 'http://127.0.0.1:3131/mcp' },
    credential_file: '/srv/gbrain-home/.creds-mock.json',
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
  opsHealthy: async () => true,
}));

const { previewConnection, provisionConnection, revokeConnection } =
  await import('../../src/control/connections.ts');
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
  callOpsHandler = (op, _params, opts) => defaultOk(op, opts);
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
    expect(result.credentials).toEqual(grantJson(false));

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
});
