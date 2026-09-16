import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { existsSync } from 'node:fs';

const SKIP_SLICE1_E2E_ENV = 'BRAINSTAND_ALLOW_SKIP_SLICE1_E2E';

const BASE = process.env.E2E_BASE_URL ?? 'https://localhost:8443';
// --env-file .env when present; project dir stays compose/ so volume paths resolve.
const COMPOSE = [
  'docker', 'compose',
  ...(existsSync('.env') ? ['--env-file', '.env'] as const : []),
  '-f', 'compose/docker-compose.yml',
  '-f', 'compose/docker-compose.dev.yml',
];

// Caddy's internal CA in dev; a real cert in production.
const fetchInsecure = (path: string, init?: RequestInit) =>
  fetch(`${BASE}${path}`, { ...init, tls: { rejectUnauthorized: false } } as RequestInit);

const compose = (...args: string[]) =>
  Bun.spawn([...COMPOSE, ...args], { stdout: 'inherit', stderr: 'inherit' }).exited;

const composeExec = (service: string, argv: string[], timeoutMs = 300_000) => {
  const p = Bun.spawn(
    [...COMPOSE, 'exec', '-T', service, ...argv],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const timer = setTimeout(() => p.kill(), timeoutMs);
  return Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    .then(([stdout, stderr, exitCode]) => {
      clearTimeout(timer);
      return { stdout, stderr, exitCode };
    });
};

/**
 * Probed once at module load — ahead of every `test.skipIf` below.
 * Must finish in a few seconds: a multi-hour e2e against a down docker
 * daemon is a hang (Ruling 30), not a gate.
 */
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

let cookie = '';

beforeAll(async () => {
  if (!dockerAvailable) return;
  await compose('up', '-d', '--wait');
  // Two DIFFERENT containers answer these two URLs behind the same proxy:
  // /api/health is the console (boots first), /.well-known/gbrain is
  // gbrain-serve. Waiting only on the console let the reserved-path assertions
  // race gbrain-serve's boot — observed as a 502 on a cold stack right after
  // restore.e2e's `down -v`. Wait on the surface those assertions read, bounded
  // (Ruling 30) so a genuinely dead gbrain-serve still fails the assertion
  // instead of hanging the suite. Real time, not fake timers: the thing being
  // awaited is a container binding a port, which no clock can advance — same
  // as every other readiness poll in this file.
  for (let i = 0; i < 120; i++) {
    try {
      const [consoleHealth, serveDiscovery] = await Promise.all([
        fetchInsecure('/api/health'),
        fetchInsecure('/.well-known/gbrain'),
      ]);
      if (consoleHealth.status < 500 && serveDiscovery.status === 200) return;
    } catch {}
    await Bun.sleep(2000);
  }
  throw new Error('stack did not become reachable');
}, 1_800_000);

afterAll(async () => {
  if (!dockerAvailable) return;
  await compose('down', '-v');
}, 300_000);

describe('Slice 1 exit gate', () => {
  test('slice1 e2e tests are not silently skipped', () => {
    if (dockerAvailable) return;
    if (process.env[SKIP_SLICE1_E2E_ENV] === '1') return;
    throw new Error(
      'docker compose is not usable, so the slice1 e2e suite was skipped rather than run. ' +
        'Install/start Docker, then rerun:\n\n' +
        '  bun run test:e2e\n\n' +
        `If skipping is genuinely intended for this run, set ${SKIP_SLICE1_E2E_ENV}=1 ` +
        'to acknowledge it explicitly.',
    );
  });

  test.skipIf(!dockerAvailable)('docker compose up gives a reachable /api/health', async () => {
    const res = await fetchInsecure('/api/health');
    expect(res.status).toBeLessThan(500);
    expect((await res.json()).components.controlDb).toBe('ok');
  });

  // S1: the single most important negative assertion in this slice.
  test.skipIf(!dockerAvailable)('/admin is NOT reachable from the internet', async () => {
    for (const p of ['/admin', '/admin/', '/admin/api/grants', '/admin/events']) {
      expect((await fetchInsecure(p)).status).toBe(404);
    }
  });

  test.skipIf(!dockerAvailable)('gbrain reserved paths route to gbrain-serve, not the console', async () => {
    const wk = await fetchInsecure('/.well-known/gbrain');
    expect(wk.status).toBe(200);
    const body = await wk.json();
    expect(body.protocol).toBe('mcp');
    expect(body.version).toBe(process.env.GBRAIN_VERSION ?? '0.50.0.0');
  });

  test.skipIf(!dockerAvailable)('/health belongs to gbrain-serve and is not the console health', async () => {
    const body = await (await fetchInsecure('/health')).json();
    expect(body).not.toHaveProperty('components.controlDb');
  });

  test.skipIf(!dockerAvailable)('the wizard reaches ready', async () => {
    const boot = await fetchInsecure('/api/bootstrap', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.test', password: 'a-long-enough-password', orgName: 'Acme' }),
    });
    expect([200, 409]).toContain(boot.status);

    const signIn = await fetchInsecure('/api/auth/sign-in/email', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.test', password: 'a-long-enough-password' }),
    });
    expect(signIn.status).toBe(200);
    // Bun/undici: getSetCookie() when present; else first Set-Cookie header.
    const setCookies = typeof signIn.headers.getSetCookie === 'function'
      ? signIn.headers.getSetCookie()
      : [signIn.headers.get('set-cookie') ?? ''];
    cookie = setCookies.filter(Boolean).map((c) => c.split(';')[0]!).join('; ');
    expect(cookie.length).toBeGreaterThan(0);

    const post = (p: string, b: unknown) => fetchInsecure(p, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(b),
    });

    expect((await post('/api/wizard/provider', {
      provider: 'openai', apiKey: process.env.OPENAI_API_KEY ?? 'sk-e2e-placeholder',
      embeddingModel: 'openai:text-embedding-3-small',
    })).status).toBe(200);
    expect((await post('/api/wizard/search-mode', { mode: 'fast' })).status).toBe(200);
    expect((await post('/api/wizard/schema', { pack: 'gbrain-base-v2' })).status).toBe(200);
    expect((await post('/api/wizard/space', { sourceId: 'shared', name: 'Shared' })).status).toBe(200);

    const finish = await post('/api/wizard/finish', {});
    const finishBody = await finish.json() as { lifecycle?: string; steps?: unknown; error?: string };
    expect(finish.status).toBe(200);
    expect(finishBody.lifecycle).toBe('ready');
  }, 2_400_000);

  test.skipIf(!dockerAvailable)('a put_page then search round trip works', async () => {
    // sh -c is for printf/git only (not gbrain — S2 lint). Identity via -c flags.
    const seed = await composeExec('gbrain-ops', [
      'sh', '-c',
      `printf '# E2E probe\\n\\nThe end to end probe page.\\n' > /srv/brain-repos/shared/e2e-probe.md && ` +
      `cd /srv/brain-repos/shared && ` +
      `git -c user.email=e2e@brainstand.local -c user.name=e2e ` +
      `add -A && git -c user.email=e2e@brainstand.local -c user.name=e2e ` +
      `commit -qm e2e`,
    ]);
    if (seed.exitCode !== 0) throw new Error(`seed e2e-probe failed: ${seed.stderr}`);

    const sync = await composeExec('gbrain-ops', ['gbrain', 'sync', '--all'], 900_000);
    if (sync.exitCode !== 0) throw new Error(`sync failed: ${sync.stderr || sync.stdout}`);

    const embed = await composeExec('gbrain-ops', ['gbrain', 'embed', '--stale'], 900_000);
    if (embed.exitCode !== 0) throw new Error(`embed failed: ${embed.stderr || embed.stdout}`);

    const search = await composeExec('gbrain-ops', [
      'gbrain', 'search', 'end to end probe', '--json',
    ], 120_000);
    expect(search.stdout).toContain('e2e-probe');
  }, 1_800_000);

  test.skipIf(!dockerAvailable)('stop and start preserves data', async () => {
    await compose('stop');
    await compose('start');
    for (let i = 0; i < 60; i++) {
      try { if ((await fetchInsecure('/api/health')).status < 500) break; } catch {}
      await Bun.sleep(2000);
    }
    const state = await (await fetchInsecure('/api/wizard/state', { headers: { cookie } })).json() as {
      lifecycle: string;
      spaces: { sourceId: string }[];
    };
    expect(state.lifecycle).toBe('ready');
    expect(state.spaces.map((s) => s.sourceId)).toContain('shared');
  }, 600_000);
});
