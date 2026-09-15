import { mock, test, expect, describe, beforeAll, afterAll } from 'bun:test';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(48);
process.env.BETTER_AUTH_SECRET ??= 'b'.repeat(48);
process.env.CONTROL_DATABASE_URL ??=
  'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';

// Slice 0 stack is down; unit-cover seedSpaceRepo separately. Mock the ops
// boundary so wizard control-plane logic (lifecycle, secrets, Space=source)
// is exercised without a live gbrain binary.
const callOpsCalls: { op: string; opts?: { json?: boolean; timeoutMs?: number } }[] = [];
let resetBrainSchemaCalls = 0;

mock.module('../../src/control/opsClient.ts', () => ({
  callOps: async (op: string, _params?: Record<string, unknown>, opts?: { json?: boolean; timeoutMs?: number }) => {
    callOpsCalls.push({ op, opts });
    return {
      ok: true,
      exitCode: 0,
      argv: ['gbrain', ...op.split('.')],
      stdout: op === 'schema.list' ? 'Bundled packs:\n  gbrain-base-v2\n' : 'ok',
      stderr: '',
      json: null,
    };
  },
  patchFilePlaneConfig: async () => {},
  putSchemaPack: async () => {},
  seedSpace: async () => {},
  resetBrainSchema: async () => { resetBrainSchemaCalls += 1; },
  takeGrantCredentials: async () => ({}),
  opsHealthy: async () => true,
}));

const { default: app } = await import('../../src/control/app.ts');
const { runMigrations, getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { bootstrapFirstAdmin } = await import('../../src/control/bootstrap.ts');
const { eq } = await import('drizzle-orm');

// Pin at module load so a sibling file cannot close the pool before our beforeAll.
pinDb();

let cookie = '';
let orgId = '';

beforeAll(async () => {
  await runMigrations();
  for (const t of [
    schema.spaces, schema.secrets, schema.auditLog,
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
    expect((await call('/api/wizard/search-mode', { mode: 'fast' })).status).toBe(200);
    const [brain] = await getDb().select().from(schema.brains);
    expect(brain?.searchMode).toBe('fast');
    expect(brain?.lifecycle).toBe('mode-selected');
  });

  test('an unknown search mode is rejected', async () => {
    expect((await call('/api/wizard/search-mode', { mode: 'turbo' })).status).toBe(400);
  });

  // S4b: Space = source is a HARD RULE, surfaced as a blocking choice.
  test('the space step refuses a duplicate source id', async () => {
    await call('/api/wizard/schema', { pack: 'gbrain-base-v2' });
    expect((await call('/api/wizard/space', { sourceId: 'shared', name: 'Shared' })).status).toBe(200);
    const dup = await call('/api/wizard/space', { sourceId: 'shared', name: 'Shared again' });
    expect(dup.status).toBe(409);
    expect((await dup.json() as { error: string }).error).toMatch(/already a Space/i);
  });

  test('the space step rejects an invalid source id', async () => {
    const res = await call('/api/wizard/space', { sourceId: '../etc', name: 'Bad' });
    expect(res.status).toBe(400);
  });

  test('state carries the isolation warning for the space step', async () => {
    const body = await (await call('/api/wizard/state')).json() as WizardState;
    expect(body.isolationNotice).toMatch(/every member with read on that Space/i);
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
});
