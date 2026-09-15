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
let pairingHome = '';
let pairingConnectionId = '';
let hostsRewritten = false;

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
