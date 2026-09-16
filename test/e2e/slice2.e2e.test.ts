import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
// Bind host OPS URL before any opsClient evaluate — static imports are hoisted.
import './host-ops-env.ts';
import { existsSync } from 'node:fs';
import { buildArgv, redactArgv } from '../../src/contracts/argv.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { scrubOutput } from '../../src/docker/host.ts';
import type { OperationSpec, ParamValues } from '../../src/contracts/types.ts';

const SKIP_SLICE2_E2E_ENV = 'BRAINSTAND_ALLOW_SKIP_SLICE2_E2E';

const BASE = process.env.E2E_BASE_URL ?? 'https://localhost:8443';
const ADMIN_EMAIL = 'admin@example.test';
const ADMIN_PASSWORD = 'a-long-enough-password';
const PROBE_QUERY = 'performance review';
const SHARED_PROBE = 'Ship the widget in March';
const CUSTOMERS_PROBE = 'Acme wants faster onboarding';
const RUN_ID = Date.now().toString(36);

const WRITE_FENCE_AFFECTS = [
  'extract_entities',
  'extract_facts',
  'forget_fact',
  'ontology_propose',
  'sources_add',
  'sources_remove',
  'POST /ingest',
  'put_page automatic fact extraction skipped',
];

const SPACES = [
  { sourceId: 'shared', name: 'Shared', file: 'widget-launch.md',
    body: '# Widget launch plan\n\nShip the widget in March.\n' },
  { sourceId: 'customers', name: 'Customers', file: 'acme-notes.md',
    body: '# Customer notes\n\nAcme wants faster onboarding.\n' },
  { sourceId: 'internal', name: 'Internal', file: 'performance-review.md',
    body: '# Performance review process\n\nAnnual cycle runs in Q4.\n' },
] as const;

// Dummy interpolation only — compose exec still parses ${VAR:?required} even
// against an already-up project. Real CI/env values win when set.
const COMPOSE_ENV: Record<string, string> = {
  ...process.env as Record<string, string>,
  DOMAIN: process.env.DOMAIN ?? 'localhost',
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD ?? 'change-me-in-a-real-deployment',
  OPS_RPC_TOKEN: process.env.OPS_RPC_TOKEN ?? 'compose-exec-placeholder',
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? 'compose-exec-placeholder-32-characters',
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? 'compose-exec-placeholder-32-characters',
};

const COMPOSE = [
  'docker', 'compose',
  ...(existsSync('.env') ? ['--env-file', '.env'] as const : []),
  '-f', 'compose/docker-compose.yml',
  '-f', 'compose/docker-compose.dev.yml',
];

const fetchInsecure = (path: string, init?: RequestInit) =>
  fetch(`${BASE}${path}`, { ...init, tls: { rejectUnauthorized: false } } as RequestInit);

const compose = (...args: string[]) =>
  Bun.spawn([...COMPOSE, ...args], { stdout: 'inherit', stderr: 'inherit', env: COMPOSE_ENV }).exited;

const composeExec = (
  service: string,
  argv: string[],
  timeoutMs = 300_000,
  env?: Record<string, string>,
) => {
  const envArgs = Object.entries(env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const p = Bun.spawn(
    [...COMPOSE, 'exec', '-T', ...envArgs, service, ...argv],
    { stdout: 'pipe', stderr: 'pipe', env: COMPOSE_ENV },
  );
  const timer = setTimeout(() => p.kill(), timeoutMs);
  return Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    .then(([stdout, stderr, exitCode]) => {
      clearTimeout(timer);
      return { stdout, stderr, exitCode };
    });
};

async function probeDockerCompose(): Promise<boolean> {
  try {
    const p = Bun.spawn(['docker', 'compose', 'version'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    });
    const timer = setTimeout(() => p.kill(), 5_000);
    try {
      return (await p.exited) === 0;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

const dockerAvailable = await probeDockerCompose();

type SpaceRow = { id: string; sourceId: string; name: string };
type MemberRow = { id: string; email: string; role: string };
type Compiled = {
  profile: string;
  sourceId: string;
  federatedRead: string[];
  warnings: Array<{ id: string; severity: string; affects: string[] }>;
};
type ConnectionRow = { id: string; membershipId: string; writeSpaceId: string; state: string; compiled?: Compiled };
type ClaimConnection = {
  connectionId: string;
  credentials: { client_id?: string; client_secret?: string };
  harness: string;
  mcp_url: string;
};
type Overview = {
  members: Array<{ membershipId: string; email: string; role: string }>;
  spaces: SpaceRow[];
  cells: Array<{ membershipId: string; spaceId: string; access: string }>;
};

let cookie = '';
let spacesBySource: Record<string, SpaceRow> = {};
const members: Record<string, MemberRow> = {};
const connections: Record<string, ConnectionRow[]> = {};
const claims: Record<string, { token: string; result?: { membershipId: string; connections: ClaimConnection[] } }> = {};
const thinHomes: Record<string, string> = {};
let pairingHome = '';
let pairingConnectionId = '';
let dualRevokeId = '';
let dualSurviveHome = '';
let dualRevokeHome = '';
let hostsRewritten = false;

const DISJOINT = [
  { key: 'cShared', write: 'shared', reads: ['shared'] },
  { key: 'cCustomers', write: 'customers', reads: ['customers'] },
  { key: 'cInternal', write: 'internal', reads: ['internal'] },
] as const;

const DUAL = [
  { write: 'customers', reads: ['customers', 'shared'] },
  { write: 'internal', reads: ['internal', 'customers'] },
] as const;

function jsonHeaders(extra: Record<string, string> = {}) {
  return { 'content-type': 'application/json', cookie, ...extra };
}

function post(path: string, body: unknown) {
  return fetchInsecure(path, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
}

function get(path: string) {
  return fetchInsecure(path, { headers: { cookie } });
}

async function readJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    throw new Error(`${label} ${res.status} ${ct}: ${text.slice(0, 300)}`);
  }
  try { return JSON.parse(text) as T; }
  catch {
    throw new Error(`${label} ${res.status} unparseable: ${text.slice(0, 300)}`);
  }
}

function harvestCookie(res: Response): string {
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') ?? ''];
  return setCookies.filter(Boolean).map((c) => c.split(';')[0]!).join('; ');
}

function parseLastJson(text: string): unknown | null {
  const trimmed = text.trim();
  const start = Math.min(
    ...[trimmed.indexOf('{'), trimmed.indexOf('[')].filter((i) => i >= 0),
  );
  if (!Number.isFinite(start) || start < 0) return null;
  try { return JSON.parse(trimmed.slice(start)); } catch { return null; }
}

async function gbrain(
  spec: OperationSpec,
  values: ParamValues,
  opts: { json?: boolean; timeoutMs?: number; env?: Record<string, string> } = {},
) {
  const argv = buildArgv(spec, values, { json: opts.json });
  const raw = await composeExec('gbrain-ops', ['gbrain', ...argv], opts.timeoutMs ?? 120_000, {
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    ...opts.env,
  });
  return {
    argv: redactArgv(spec, ['gbrain', ...argv]),
    exitCode: raw.exitCode,
    stdout: scrubOutput(raw.stdout),
    stderr: scrubOutput(raw.stderr),
    json: opts.json ? parseLastJson(raw.stdout) : null,
  };
}

function requireGateBReady(): void {
  if (!cookie) throw new Error('Gate C needs the admin cookie from Gate B');
  for (const s of SPACES) {
    if (!spacesBySource[s.sourceId]?.id) {
      throw new Error(`Gate C needs wizard spaces from Gate B; missing ${s.sourceId}`);
    }
  }
}

function compiledOf(row: ConnectionRow): Compiled {
  if (!row.compiled) throw new Error(`connection ${row.id} missing compiled payload`);
  return row.compiled;
}

function allowedSources(compiled: Compiled): Set<string> {
  return new Set([compiled.sourceId, ...compiled.federatedRead]);
}

/** whoami may echo `source_id` inside `federated_read`; compare the readable set. */
function sameReadSet(
  who: { source_id?: string; federated_read?: string[] } | null,
  compiled: Compiled,
): boolean {
  if (!who?.source_id) return false;
  const actual = new Set(
    [who.source_id, ...(Array.isArray(who.federated_read) ? who.federated_read : [])]
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  const expected = allowedSources(compiled);
  if (actual.size !== expected.size) return false;
  for (const id of actual) if (!expected.has(id)) return false;
  return true;
}

function claimedConn(memberKey: string, connectionId: string): ClaimConnection {
  const found = claims[memberKey]?.result?.connections.find((c) => c.connectionId === connectionId);
  if (!found) throw new Error(`claim for ${memberKey} missing connection ${connectionId}`);
  return found;
}

function homeKey(memberKey: string, sourceId: string): string {
  return `${memberKey}:${sourceId}`;
}

async function initThinClient(home: string, cred: ClaimConnection): Promise<void> {
  const issuerUrl = (cred.mcp_url.replace(/\/mcp\/?$/, '') || 'https://localhost');
  const init = await gbrain(OPERATIONS['init.mcpOnly']!, {
    issuerUrl,
    mcpUrl: cred.mcp_url,
    oauthClientId: cred.credentials.client_id,
    oauthClientSecret: cred.credentials.client_secret,
    force: true,
  }, { json: true, timeoutMs: 180_000, env: { GBRAIN_HOME: home } });
  if (init.exitCode !== 0) {
    throw new Error(`init.mcpOnly failed (exit ${init.exitCode}): ${init.stderr || init.stdout}`);
  }
}

async function createMemberWithConnections(
  key: string,
  email: string,
  specs: ReadonlyArray<{ write: string; reads: readonly string[] }>,
): Promise<void> {
  const res = await post('/api/members', { email, role: 'member' });
  expect(res.status).toBe(200);
  const body = await readJson<MemberRow>(res, 'POST /api/members');
  expect(body.id).toBeTruthy();
  members[key] = { ...body, email };

  connections[key] = [];
  for (const spec of specs) {
    const writeSpace = spacesBySource[spec.write]!;
    const readSpaceIds = spec.reads.map((id) => spacesBySource[id]!.id);
    const created = await post('/api/connections', {
      membershipId: body.id,
      writeSpaceId: writeSpace.id,
      readSpaceIds,
      harness: 'generic',
    });
    expect(created.status).toBe(200);
    const conn = await readJson<ConnectionRow>(created, 'POST /api/connections');
    expect(conn.state).toBe('pending');
    expect(conn.id).toBeTruthy();
    expect(conn.compiled?.sourceId).toBe(spec.write);
    connections[key]!.push(conn);
  }
}

async function claimMember(key: string): Promise<void> {
  const minted = await post(`/api/members/${members[key]!.id}/claim-link`, {});
  expect(minted.status).toBe(200);
  const { token } = await readJson<{ token: string }>(minted, 'POST claim-link');
  expect(token.length).toBeGreaterThan(20);
  claims[key] = { token };

  const ok = await fetchInsecure(`/api/claim/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: members[key]!.email }),
  });
  expect(ok.status).toBe(200);
  const claimed = await readJson<{ membershipId: string; connections: ClaimConnection[] }>(ok, `claim ${key}`);
  expect(claimed.membershipId).toBe(members[key]!.id);
  expect(claimed.connections.length).toBe(connections[key]!.length);
  for (const c of claimed.connections) {
    expect(c.credentials?.client_id).toBeTruthy();
    expect(c.credentials?.client_secret).toBeTruthy();
    expect(c.mcp_url).toMatch(/\/mcp$/);
  }
  claims[key]!.result = claimed;
}

async function provisionThinClients(key: string): Promise<void> {
  for (const row of connections[key]!) {
    const compiled = compiledOf(row);
    const cred = claimedConn(key, row.id);
    const home = `/srv/gbrain-home/member-slice2-${key}-${compiled.sourceId}-${RUN_ID}`;
    thinHomes[homeKey(key, compiled.sourceId)] = home;
    await initThinClient(home, cred);
  }
}

function uuidList(ids: string[]): string {
  for (const id of ids) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error(`refusing to interpolate non-uuid ${id}`);
    }
  }
  return ids.map((id) => `'${id}'`).join(',');
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(actual)) return false;
  const left = actual.map(String).sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((x, i) => x === right[i]);
}

function searchHits(json: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(json)) return json as Array<Record<string, unknown>>;
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    for (const k of ['results', 'hits', 'items']) {
      if (Array.isArray(o[k])) return o[k] as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function hitSourceIds(hits: Array<Record<string, unknown>>): string[] {
  return hits
    .map((r) => (r.source_id ?? r.sourceId) as string | undefined)
    .filter((sid): sid is string => typeof sid === 'string' && sid.length > 0);
}

async function pointLocalhostAtCaddy(): Promise<void> {
  const dns = await composeExec('gbrain-ops', ['getent', 'hosts', 'caddy']);
  const ip = dns.stdout.trim().split(/\s+/)[0];
  if (!ip) throw new Error(`could not resolve caddy: ${dns.stderr}`);
  const script =
    `const fs = require('fs');` +
    `const hosts = fs.readFileSync('/etc/hosts','utf8');` +
    `if (!fs.existsSync('/tmp/hosts.slice2.bak')) fs.writeFileSync('/tmp/hosts.slice2.bak', hosts);` +
    `const next = hosts` +
    `.replace(/127\\.0\\.0\\.1\\s+localhost/g, ${JSON.stringify(ip)} + ' localhost')` +
    `.replace(/172\\.\\d+\\.\\d+\\.\\d+\\s+localhost/g, ${JSON.stringify(ip)} + ' localhost');` +
    `fs.writeFileSync('/etc/hosts', next);`;
  const r = await composeExec('gbrain-ops', ['bun', '-e', script]);
  if (r.exitCode !== 0) throw new Error(`hosts rewrite failed: ${r.stderr}`);
  hostsRewritten = true;
}

async function restoreLocalhost(): Promise<void> {
  if (!hostsRewritten) return;
  const script =
    `const fs = require('fs');` +
    `if (fs.existsSync('/tmp/hosts.slice2.bak')) {` +
    `  fs.writeFileSync('/etc/hosts', fs.readFileSync('/tmp/hosts.slice2.bak'));` +
    `}`;
  await composeExec('gbrain-ops', ['bun', '-e', script]).catch(() => undefined);
  hostsRewritten = false;
}

beforeAll(async () => {
  if (!dockerAvailable) return;
  let reachable = false;
  try { reachable = (await fetchInsecure('/api/health')).status < 500; } catch { /* stack down */ }
  if (!reachable) {
    await compose('up', '-d', '--wait');
    for (let i = 0; i < 120; i++) {
      try { if ((await fetchInsecure('/api/health')).status < 500) { reachable = true; break; } } catch {}
      await Bun.sleep(2000);
    }
  }
  if (!reachable) throw new Error('stack did not become reachable');
}, 1_800_000);

afterAll(async () => {
  if (!dockerAvailable) return;
  await restoreLocalhost();
}, 60_000);

describe('Slice 2 seam gate B', () => {
  test('slice2 e2e tests are not silently skipped', () => {
    if (dockerAvailable) return;
    if (process.env[SKIP_SLICE2_E2E_ENV] === '1') return;
    throw new Error(
      'docker compose is not usable, so the slice2 e2e suite was skipped rather than run. ' +
        'Install/start Docker, then rerun:\n\n' +
        '  bun test test/e2e/slice2.e2e.test.ts\n\n' +
        `If skipping is genuinely intended for this run, set ${SKIP_SLICE2_E2E_ENV}=1 ` +
        'to acknowledge it explicitly.',
    );
  });

  test.skipIf(!dockerAvailable)('1. bootstrap + sign in harvests the cookie', async () => {
    const boot = await fetchInsecure('/api/bootstrap', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, orgName: 'Acme' }),
    });
    expect([200, 409]).toContain(boot.status);

    const signIn = await fetchInsecure('/api/auth/sign-in/email', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    expect(signIn.status).toBe(200);
    cookie = harvestCookie(signIn);
    expect(cookie.length).toBeGreaterThan(0);
  });

  test.skipIf(!dockerAvailable)('2. wizard reaches ready with three Spaces', async () => {
    const stateRes = await get('/api/wizard/state');
    expect(stateRes.status).toBe(200);
    let state = await stateRes.json() as { lifecycle: string; spaces: { sourceId: string }[] };

    if (state.lifecycle !== 'ready') {
      const provider = await post('/api/wizard/provider', {
        provider: 'openai',
        apiKey: process.env.OPENAI_API_KEY ?? 'sk-e2e-placeholder',
        embeddingModel: 'openai:text-embedding-3-small',
      });
      expect([200, 409]).toContain(provider.status);

      const mode = await post('/api/wizard/search-mode', { mode: 'fast' });
      expect([200, 409]).toContain(mode.status);

      const schema = await post('/api/wizard/schema', { pack: 'gbrain-base-v2' });
      expect([200, 409]).toContain(schema.status);
    }

    for (const s of SPACES) {
      const res = await post('/api/wizard/space', { sourceId: s.sourceId, name: s.name });
      expect([200, 409, 400]).toContain(res.status);
    }

    state = await (await get('/api/wizard/state')).json() as typeof state;
    if (state.lifecycle !== 'ready') {
      const finish = await post('/api/wizard/finish', {});
      const finishBody = await finish.json() as { lifecycle?: string; steps?: unknown; error?: string };
      if (finish.status !== 200 && !process.env.OPENAI_API_KEY) {
        const sync = await composeExec('gbrain-ops', ['gbrain', 'sync', '--all', '--no-embed', '--json'], 900_000);
        if (sync.exitCode !== 0) throw new Error(`sync --no-embed failed: ${sync.stderr || sync.stdout}`);
      } else {
        expect(finish.status).toBe(200);
        expect(finishBody.lifecycle).toBe('ready');
      }
    }

    state = await (await get('/api/wizard/state')).json() as typeof state;
    const sourceIds = state.spaces.map((s) => s.sourceId).sort();
    expect(sourceIds).toEqual(['customers', 'internal', 'shared']);
    if (process.env.OPENAI_API_KEY) expect(state.lifecycle).toBe('ready');

    for (const s of SPACES) {
      const escaped = s.body.replace(/'/g, `'\\''`);
      const seed = await composeExec('gbrain-ops', [
        'sh', '-c',
        `printf '${escaped}' > /srv/brain-repos/${s.sourceId}/${s.file} && ` +
        `cd /srv/brain-repos/${s.sourceId} && ` +
        `git -c user.email=e2e@brainstand.local -c user.name=e2e ` +
        `add -A && git -c user.email=e2e@brainstand.local -c user.name=e2e ` +
        `commit -qm e2e-${s.sourceId} || true`,
      ]);
      if (seed.exitCode !== 0) throw new Error(`seed ${s.sourceId} failed: ${seed.stderr}`);
    }

    if (process.env.OPENAI_API_KEY) {
      const sync = await composeExec('gbrain-ops', ['gbrain', 'sync', '--all'], 900_000);
      if (sync.exitCode !== 0) throw new Error(`sync failed: ${sync.stderr || sync.stdout}`);
      const embed = await composeExec('gbrain-ops', ['gbrain', 'embed', '--stale'], 900_000);
      if (embed.exitCode !== 0) throw new Error(`embed failed: ${embed.stderr || embed.stdout}`);
    } else {
      const sync = await composeExec('gbrain-ops', ['gbrain', 'sync', '--all', '--no-embed', '--json'], 900_000);
      if (sync.exitCode !== 0) throw new Error(`sync --no-embed failed: ${sync.stderr || sync.stdout}`);
    }

    const overviewRes = await get('/api/access-overview');
    expect(overviewRes.status).toBe(200);
    const overview = await readJson<Overview>(overviewRes, 'GET /api/access-overview');
    spacesBySource = Object.fromEntries(overview.spaces.map((s) => [s.sourceId, s]));
    for (const s of SPACES) expect(spacesBySource[s.sourceId]?.id).toBeTruthy();
  }, 2_400_000);

  test.skipIf(!dockerAvailable)('3. POST /api/members x3 and /api/connections x4 (one member, two writes)', async () => {
    const specs = [
      { key: 'pairing', email: `slice2-pairing-${RUN_ID}@example.test`,
        writes: ['customers'], reads: ['customers', 'shared', 'internal'] },
      { key: 'isolated', email: `slice2-isolated-${RUN_ID}@example.test`,
        writes: ['shared'], reads: ['shared'] },
      { key: 'twoWrite', email: `slice2-twowrite-${RUN_ID}@example.test`,
        writes: ['customers', 'internal'], reads: ['customers', 'internal', 'shared'] },
    ] as const;

    for (const spec of specs) {
      const res = await post('/api/members', { email: spec.email, role: 'member' });
      expect(res.status).toBe(200);
      const body = await readJson<MemberRow>(res, 'POST /api/members');
      expect(body.id).toBeTruthy();
      members[spec.key] = { ...body, email: spec.email };
    }

    let created = 0;
    for (const spec of specs) {
      const member = members[spec.key]!;
      connections[spec.key] = [];
      for (const write of spec.writes) {
        const writeSpace = spacesBySource[write]!;
        const readSpaceIds = spec.reads.map((id) => spacesBySource[id]!.id);
        const res = await post('/api/connections', {
          membershipId: member.id,
          writeSpaceId: writeSpace.id,
          readSpaceIds,
          harness: 'generic',
        });
        expect(res.status).toBe(200);
        const body = await readJson<ConnectionRow>(res, 'POST /api/connections');
        expect(body.state).toBe('pending');
        expect(body.id).toBeTruthy();
        connections[spec.key]!.push(body);
        created += 1;
      }
    }
    expect(created).toBe(4);
    expect(connections.twoWrite!.length).toBe(2);
  });

  test.skipIf(!dockerAvailable)('4. POST /api/connections/preview carries warnings[] and fence affects', async () => {
    const pairing = members.pairing!;
    const res = await post('/api/connections/preview', {
      membershipId: pairing.id,
      connectionId: connections.pairing![0]!.id,
      writeSpaceId: spacesBySource.customers!.id,
      readSpaceIds: ['customers', 'shared', 'internal'].map((id) => spacesBySource[id]!.id),
      harness: 'generic',
      boundSlugPrefixes: ['alice-example/'],
    });
    expect(res.status).toBe(200);
    const body = await readJson<{ compiled: Compiled; previewSource: string }>(res, 'POST /api/connections/preview');
    expect(Array.isArray(body.compiled.warnings)).toBe(true);
    expect(body.compiled.warnings.length).toBeGreaterThan(0);
    const fence = body.compiled.warnings.find((w) => w.id === 'write-fence-disables-extraction');
    expect(fence).toBeDefined();
    expect(fence!.affects).toEqual(WRITE_FENCE_AFFECTS);
  });

  test.skipIf(!dockerAvailable)('5. claim-link x3; right email credentials; wrong email + replay rejected', async () => {
    for (const key of ['pairing', 'isolated', 'twoWrite'] as const) {
      const minted = await post(`/api/members/${members[key]!.id}/claim-link`, {});
      expect(minted.status).toBe(200);
      const { token } = await readJson<{ token: string }>(minted, 'POST claim-link');
      expect(token.length).toBeGreaterThan(20);
      claims[key] = { token };
    }

    const pairingToken = claims.pairing!.token;
    const wrong = await fetchInsecure(`/api/claim/${pairingToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'wrong@example.test' }),
    });
    expect(wrong.status).toBe(400);
    const wrongBody = await readJson<{ error?: string }>(wrong, 'claim wrong email');
    expect(wrongBody.error ?? '').toMatch(/email/i);

    for (const key of ['pairing', 'isolated', 'twoWrite'] as const) {
      const ok = await fetchInsecure(`/api/claim/${claims[key]!.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: members[key]!.email }),
      });
      expect(ok.status).toBe(200);
      const claimed = await readJson<{ membershipId: string; connections: ClaimConnection[] }>(ok, `claim ${key}`);
      expect(claimed.membershipId).toBe(members[key]!.id);
      expect(claimed.connections.length).toBe(connections[key]!.length);
      for (const c of claimed.connections) {
        expect(c.credentials?.client_id).toBeTruthy();
        expect(c.credentials?.client_secret).toBeTruthy();
        expect(c.mcp_url).toMatch(/\/mcp$/);
      }
      claims[key]!.result = claimed;
    }
    expect(claims.twoWrite!.result!.connections.length).toBe(2);

    const replay = await fetchInsecure(`/api/claim/${pairingToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: members.pairing!.email }),
    });
    expect(replay.status).toBe(400);
    const replayBody = await readJson<{ error?: string }>(replay, 'claim replay');
    expect(replayBody.error ?? '').toMatch(/already used|invalid/i);
  }, 600_000);

  test.skipIf(!dockerAvailable)('6. thin client whoami + scoped search through the product path', async () => {
    await pointLocalhostAtCaddy();

    const pairingClaim = claims.pairing!.result!.connections[0]!;
    const isolatedClaim = claims.isolated!.result!.connections[0]!;
    pairingConnectionId = pairingClaim.connectionId;
    pairingHome = `/srv/gbrain-home/member-slice2-pairing-${RUN_ID}`;
    const isolatedHome = `/srv/gbrain-home/member-slice2-isolated-${RUN_ID}`;

    const issuerUrl = (pairingClaim.mcp_url.replace(/\/mcp\/?$/, '') || 'https://localhost');

    for (const [home, cred] of [
      [pairingHome, pairingClaim] as const,
      [isolatedHome, isolatedClaim] as const,
    ]) {
      const init = await gbrain(OPERATIONS['init.mcpOnly']!, {
        issuerUrl,
        mcpUrl: cred.mcp_url,
        oauthClientId: cred.credentials.client_id,
        oauthClientSecret: cred.credentials.client_secret,
        force: true,
      }, { json: true, timeoutMs: 180_000, env: { GBRAIN_HOME: home } });
      if (init.exitCode !== 0) {
        throw new Error(`init.mcpOnly failed (exit ${init.exitCode}): ${init.stderr || init.stdout}`);
      }
    }

    const pairingCompiled = connections.pairing![0]!.compiled;
    const who = await gbrain(OPERATIONS.whoami!, {}, {
      json: true, env: { GBRAIN_HOME: pairingHome },
    });
    expect(who.exitCode).toBe(0);
    const whoBody = who.json as { transport?: string; source_id?: string; federated_read?: string[] } | null;
    expect(whoBody?.transport).toBe('oauth');
    expect(whoBody?.source_id).toBe(pairingCompiled?.sourceId ?? 'customers');
    if (pairingCompiled) {
      expect(sameStrings(whoBody?.federated_read, pairingCompiled.federatedRead)).toBe(true);
    } else {
      expect(sameStrings(whoBody?.federated_read, ['internal', 'shared'])).toBe(true);
    }

    const pairingSearch = await gbrain(OPERATIONS.search!, { query: PROBE_QUERY }, {
      json: true, env: { GBRAIN_HOME: pairingHome },
    });
    expect(pairingSearch.exitCode).toBe(0);
    const pairingSources = hitSourceIds(searchHits(pairingSearch.json));
    const pairingAllowed = new Set(['customers', 'shared', 'internal']);
    expect(pairingSources.every((sid) => pairingAllowed.has(sid))).toBe(true);
    expect(pairingSources).toContain('internal');

    const isolatedSearch = await gbrain(OPERATIONS.search!, { query: PROBE_QUERY }, {
      json: true, env: { GBRAIN_HOME: isolatedHome },
    });
    expect(isolatedSearch.exitCode).toBe(0);
    const isolatedSources = hitSourceIds(searchHits(isolatedSearch.json));
    expect(isolatedSources).not.toContain('internal');
    expect(isolatedSources.every((sid) => sid === 'shared')).toBe(true);
  }, 600_000);

  test.skipIf(!dockerAvailable)('7. revoke makes thin-client search fail and drops access-overview', async () => {
    const res = await post(`/api/connections/${pairingConnectionId}/revoke`, {});
    expect(res.status).toBe(200);

    const searchAfter = await gbrain(OPERATIONS.search!, { query: PROBE_QUERY }, {
      json: true, timeoutMs: 60_000, env: { GBRAIN_HOME: pairingHome },
    });
    expect(OPERATIONS.search!.okExitCodes.includes(searchAfter.exitCode)).toBe(false);

    const overviewRes = await get('/api/access-overview');
    expect(overviewRes.status).toBe(200);
    const overview = await readJson<Overview>(overviewRes, 'GET /api/access-overview after revoke');
    const pairingCells = overview.cells.filter((c) => c.membershipId === members.pairing!.id);
    expect(pairingCells.length).toBe(0);
  }, 180_000);

  test.skipIf(!dockerAvailable)('8. /admin is still 404', async () => {
    for (const p of ['/admin', '/admin/', '/admin/api/grants', '/admin/events']) {
      expect((await fetchInsecure(p)).status).toBe(404);
    }
  });
});

describe('Slice 2 seam gate C', () => {
  test.skipIf(!dockerAvailable)('C1. three Spaces, three Members with disjoint grants', async () => {
    requireGateBReady();

    for (const spec of DISJOINT) {
      await createMemberWithConnections(
        spec.key,
        `slice2-${spec.key}-${RUN_ID}@example.test`,
        [{ write: spec.write, reads: spec.reads }],
      );
      expect(connections[spec.key]!.length).toBe(1);
    }

    const overviewRes = await get('/api/access-overview');
    expect(overviewRes.status).toBe(200);
    const overview = await readJson<Overview>(overviewRes, 'GET /api/access-overview');
    expect(overview.spaces.map((s) => s.sourceId).sort()).toEqual(['customers', 'internal', 'shared']);

    const spaceSets = DISJOINT.map((spec) => {
      const cells = overview.cells.filter((c) => c.membershipId === members[spec.key]!.id);
      expect(cells.length).toBeGreaterThan(0);
      expect(cells.every((c) => {
        const space = overview.spaces.find((s) => s.id === c.spaceId);
        return space?.sourceId === spec.write;
      })).toBe(true);
      return new Set(cells.map((c) => c.spaceId));
    });
    for (let i = 0; i < spaceSets.length; i++) {
      for (let j = i + 1; j < spaceSets.length; j++) {
        for (const id of spaceSets[i]!) expect(spaceSets[j]!.has(id)).toBe(false);
      }
    }
  });

  test.skipIf(!dockerAvailable)('C2. per Connection whoami reports oauth + compiled source_id and federated_read', async () => {
    requireGateBReady();
    await pointLocalhostAtCaddy();

    for (const spec of DISJOINT) {
      await claimMember(spec.key);
      await provisionThinClients(spec.key);
    }

    for (const spec of DISJOINT) {
      const row = connections[spec.key]![0]!;
      const compiled = compiledOf(row);
      const home = thinHomes[homeKey(spec.key, compiled.sourceId)];
      if (!home) throw new Error(`missing thin home for ${spec.key}:${compiled.sourceId}`);
      const who = await gbrain(OPERATIONS.whoami!, {}, {
        json: true, env: { GBRAIN_HOME: home },
      });
      if (who.exitCode !== 0) {
        throw new Error(`whoami ${spec.key} exit ${who.exitCode}: ${who.stderr || who.stdout}`);
      }
      expect(who.exitCode).toBe(0);
      const whoBody = who.json as { transport?: string; source_id?: string; federated_read?: string[] } | null;
      expect(whoBody?.transport).toBe('oauth');
      expect(whoBody?.source_id).toBe(compiled.sourceId);
      if (!sameReadSet(whoBody, compiled)) {
        throw new Error(
          `whoami read set mismatch for ${spec.key}: who=${JSON.stringify(whoBody)} compiled=${JSON.stringify(compiled)}`,
        );
      }
    }
  }, 900_000);

  test.skipIf(!dockerAvailable)('C3. per Connection search is scoped; internal-access member sees internal', async () => {
    requireGateBReady();

    let sawInternal = false;
    for (const spec of DISJOINT) {
      const row = connections[spec.key]![0]!;
      const compiled = compiledOf(row);
      const allowed = allowedSources(compiled);
      const home = thinHomes[homeKey(spec.key, compiled.sourceId)];
      if (!home) throw new Error(`missing thin home for ${spec.key}:${compiled.sourceId}`);
      const search = await gbrain(OPERATIONS.search!, { query: PROBE_QUERY, limit: '20' }, {
        json: true, env: { GBRAIN_HOME: home },
      });
      expect(search.exitCode).toBe(0);
      const sources = hitSourceIds(searchHits(search.json));
      expect(sources.every((sid) => allowed.has(sid))).toBe(true);
      if (allowed.has('internal')) {
        expect(sources).toContain('internal');
        sawInternal = true;
      } else {
        expect(sources).not.toContain('internal');
      }
    }
    expect(sawInternal).toBe(true);
  }, 600_000);

  test.skipIf(!dockerAvailable)('C4. two-write member holds exactly two Connections; each token scoped to its own', async () => {
    requireGateBReady();
    await pointLocalhostAtCaddy();

    await createMemberWithConnections(
      'cDual',
      `slice2-cDual-${RUN_ID}@example.test`,
      DUAL,
    );
    expect(connections.cDual!.length).toBe(2);
    const writeSources = connections.cDual!.map((c) => compiledOf(c).sourceId).sort();
    expect(writeSources).toEqual(['customers', 'internal']);
    expect(new Set(writeSources).size).toBe(2);

    await claimMember('cDual');
    expect(claims.cDual!.result!.connections.length).toBe(2);
    await provisionThinClients('cDual');

    const scopedSourceIds: string[] = [];
    for (const row of connections.cDual!) {
      const compiled = compiledOf(row);
      const home = thinHomes[homeKey('cDual', compiled.sourceId)]!;
      const who = await gbrain(OPERATIONS.whoami!, {}, { json: true, env: { GBRAIN_HOME: home } });
      expect(who.exitCode).toBe(0);
      const whoBody = who.json as { transport?: string; source_id?: string; federated_read?: string[] } | null;
      expect(whoBody?.transport).toBe('oauth');
      expect(whoBody?.source_id).toBe(compiled.sourceId);
      if (!sameReadSet(whoBody, compiled)) {
        throw new Error(
          `whoami read set mismatch for cDual/${compiled.sourceId}: who=${JSON.stringify(whoBody)} compiled=${JSON.stringify(compiled)}`,
        );
      }
      scopedSourceIds.push(whoBody!.source_id!);

      const probe = compiled.sourceId === 'internal' ? CUSTOMERS_PROBE : SHARED_PROBE;
      const search = await gbrain(OPERATIONS.search!, { query: probe, limit: '20' }, {
        json: true, env: { GBRAIN_HOME: home },
      });
      expect(search.exitCode).toBe(0);
      const sources = hitSourceIds(searchHits(search.json));
      const allowed = allowedSources(compiled);
      expect(sources.every((sid) => allowed.has(sid))).toBe(true);
      if (compiled.sourceId === 'internal') {
        expect(sources).toContain('customers');
        expect(sources).not.toContain('shared');
        dualSurviveHome = home;
      } else {
        expect(sources).toContain('shared');
        expect(sources).not.toContain('internal');
        dualRevokeHome = home;
        dualRevokeId = row.id;
      }
    }
    expect(new Set(scopedSourceIds).size).toBe(2);
  }, 900_000);

  test.skipIf(!dockerAvailable)('C5. revoke one Connection fails that client; the other Connection still works', async () => {
    requireGateBReady();
    expect(dualRevokeId).toBeTruthy();
    expect(dualRevokeHome).toBeTruthy();
    expect(dualSurviveHome).toBeTruthy();

    const res = await post(`/api/connections/${dualRevokeId}/revoke`, {});
    expect(res.status).toBe(200);

    const dead = await gbrain(OPERATIONS.search!, { query: PROBE_QUERY }, {
      json: true, timeoutMs: 60_000, env: { GBRAIN_HOME: dualRevokeHome },
    });
    expect(OPERATIONS.search!.okExitCodes.includes(dead.exitCode)).toBe(false);

    const live = await gbrain(OPERATIONS.search!, { query: CUSTOMERS_PROBE, limit: '20' }, {
      json: true, env: { GBRAIN_HOME: dualSurviveHome },
    });
    expect(live.exitCode).toBe(0);
    const liveSources = hitSourceIds(searchHits(live.json));
    expect(liveSources.every((sid) => sid === 'internal' || sid === 'customers')).toBe(true);
    expect(liveSources).toContain('customers');
    expect(liveSources).not.toContain('shared');
  }, 180_000);

  test.skipIf(!dockerAvailable)('C6. audit_log row for each revoke precedes its delete', async () => {
    const ids = [pairingConnectionId, dualRevokeId].filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);

    const sql = `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
      SELECT c.id, c.state,
             (a.at <= c.revoked_at) AS audit_before_delete,
             a.after
      FROM connections c
      INNER JOIN audit_log a ON a.target = c.id AND a.action = 'connection.revoke'
      WHERE c.id IN (${uuidList(ids)})
    ) t;`;
    const raw = await composeExec('postgres', [
      'psql', '-U', 'gbrain', '-d', 'control', '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql,
    ]);
    if (raw.exitCode !== 0) throw new Error(`audit query failed: ${raw.stderr || raw.stdout}`);

    const rows = JSON.parse(raw.stdout.trim() || '[]') as Array<{
      id: string; state: string; audit_before_delete: boolean; after: unknown;
    }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const row = byId.get(id);
      expect(row).toBeDefined();
      expect(row!.state).toBe('revoked');
      expect(row!.audit_before_delete).toBe(true);
      expect(JSON.stringify(row)).not.toMatch(/client_secret/);
    }
  });

  test.skipIf(!dockerAvailable)('C7. /admin is 404', async () => {
    for (const p of ['/admin', '/admin/', '/admin/api/grants', '/admin/events']) {
      expect((await fetchInsecure(p)).status).toBe(404);
    }
  });

  test.skipIf(!dockerAvailable)('C8. doctor --json exit 0', async () => {
    const doctor = await gbrain(OPERATIONS.doctor!, {}, { json: true, timeoutMs: 900_000 });
    expect(doctor.exitCode).toBe(0);
  }, 900_000);
});
