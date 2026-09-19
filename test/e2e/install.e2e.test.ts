// test/e2e/install.e2e.test.ts
/**
 * Gate A (D1) — the clean-host install proof.
 *
 * This is the only test in the repository that runs `scripts/install.sh` to
 * completion. Every other installer test sets BRAINSTAND_SKIP_UP=1, which is
 * why the `up` leg was broken for five slices without a red suite.
 *
 * It must run where NO image of ours is present. A8 asserts that.
 */
import { afterAll, expect, test } from 'bun:test';

const RUN = process.env.CLEAN_INSTALL_E2E === '1';
const maybe = RUN ? test : test.skip;
const WORK = process.env.CLEAN_INSTALL_DIR ?? '/tmp/clean-install';

/**
 * `docker compose up -d --wait` gates only Postgres, so install.sh returning 0
 * does NOT mean Caddy answers. A3–A5 read the public door over Caddy, so they
 * race its certificate/route bring-up unless we wait for the one endpoint the
 * whole stack must make true. Poll until 200 or the deadline; the failure names
 * the last status so a red run says what it saw.
 */
const READY_TIMEOUT_MS = 300_000;
async function awaitReady(deadlineMs = READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let last = 'no response';
  for (;;) {
    try {
      const res = await fetch('https://localhost/api/health', { tls: { rejectUnauthorized: false } });
      last = `status=${res.status}`;
      if (res.status === 200) return;
    } catch (e) {
      last = `error=${(e as Error).message}`;
    }
    if (Date.now() > deadline) {
      throw new Error(`the stack never became ready within ${deadlineMs}ms (last: ${last})`);
    }
    await Bun.sleep(2000);
  }
}

maybe('A1: preflight passes on this host and says so', async () => {
  const r = Bun.spawnSync(['bash', 'scripts/preflight.sh'], {
    env: { ...process.env, PREFLIGHT_SKIP_DNS: '1' },
  });
  console.log(`MEASURED preflight on a clean runner: exit=${r.exitCode}`);
  expect(r.exitCode).toBe(0);
}, 120_000);

maybe('A2: the installer runs to completion and the stack reports healthy', async () => {
  const r = Bun.spawnSync(['bash', 'scripts/install.sh'], {
    env: {
      ...process.env,
      DOMAIN: 'localhost', BRAINSTAND_ENV_PATH: `${WORK}/.env`,
      SKIP_PREFLIGHT: '0', PREFLIGHT_SKIP_DNS: '1',
    },
    stdin: new Blob(['n\n']),   // D12: the runner question, answered no.
  });
  console.log(`MEASURED install.sh: exit=${r.exitCode}\n${r.stderr.toString().slice(-2000)}`);
  expect(r.exitCode).toBe(0);
  // install.sh exits with the stack merely *started*; the readiness we act on
  // is the public /api/health contract, not compose's Postgres-only --wait.
  await awaitReady();
}, 900_000);

maybe('A3: /api/health is 200 with pin.matches true and both components ok', async () => {
  await awaitReady();
  const res = await fetch('https://localhost/api/health', { tls: { rejectUnauthorized: false } });
  expect(res.status).toBe(200);
  const health = await res.json() as any;
  console.log(`MEASURED health on a clean install: ${JSON.stringify(health.pin)} ${JSON.stringify(health.components)}`);
  expect(health.pin.matches).toBe(true);
  expect(health.components.controlDb).toBe('ok');
  expect(health.components.ops).toBe('ok');
}, 180_000);

maybe('A4: the runner lane is DISABLED, because the question was answered no', async () => {
  const health = await (await fetch('https://localhost/api/health', { tls: { rejectUnauthorized: false } })).json() as any;
  expect(health.runner.state).toBe('disabled');
  const env = await Bun.file(`${WORK}/.env`).text();
  expect(env).toMatch(/^RUNNER_TOKEN=\s*$/m);
  expect(env).not.toContain('COMPOSE_PROFILES=runner');
}, 120_000);

maybe('A5: the console door is the bootstrap form on a box with no admin', async () => {
  const html = await (await fetch('https://localhost/', { tls: { rejectUnauthorized: false } })).text();
  expect(html).toContain('<div id="root">');
  // The console chooses the bootstrap form from this PUBLIC signal (App.tsx's
  // phaseFor), not from the wizard state. `/api/wizard/state` is admin-gated by
  // design, so on a box with no admin it must 401 — asserting the gate here is
  // the stronger form of "no admin can read the lifecycle yet".
  const boot = await (await fetch('https://localhost/api/bootstrap', { tls: { rejectUnauthorized: false } })).json() as any;
  expect(boot.bootstrapped).toBe(false);
  const gate = await fetch('https://localhost/api/wizard/state', { tls: { rejectUnauthorized: false } });
  expect(gate.status).toBe(401);
}, 120_000);

maybe('A6: /admin is NOT routed (S1)', async () => {
  for (const p of ['/admin', '/admin/api/agents', '/admin/events']) {
    const res = await fetch(`https://localhost${p}`, { tls: { rejectUnauthorized: false } });
    expect(res.status).toBe(404);
  }
}, 120_000);

maybe('A7: .env is mode 600 and holds four distinct generated secrets', async () => {
  const { statSync } = await import('node:fs');
  expect((statSync(`${WORK}/.env`).mode & 0o777).toString(8)).toBe('600');
  const env = await Bun.file(`${WORK}/.env`).text();
  const vals = ['POSTGRES_PASSWORD', 'OPS_RPC_TOKEN', 'ENCRYPTION_KEY', 'BETTER_AUTH_SECRET']
    .map((k) => env.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1] ?? '');
  expect(vals.every((v) => v.length >= 32)).toBe(true);
  expect(new Set(vals).size).toBe(4);   // four secrets, not one reused four times
}, 120_000);

maybe('A8: nothing was BUILT — every image came from the registry', async () => {
  const r = Bun.spawnSync(['docker', 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}}\t{{.CreatedSince}}']);
  const lines = r.stdout.toString().trim().split('\n').filter((l) => l.includes(process.env.IMAGE_NAMESPACE!));
  console.log(`MEASURED images present after a clean install:\n${lines.join('\n')}`);
  expect(lines.length).toBeGreaterThanOrEqual(2);
  // A locally built image has no RepoDigest; a pulled one does.
  for (const line of lines) {
    const ref = line.split('\t')[0]!;
    const d = Bun.spawnSync(['docker', 'image', 'inspect', ref, '--format', '{{len .RepoDigests}}']);
    expect(Number(d.stdout.toString().trim())).toBeGreaterThan(0);
  }
}, 120_000);

afterAll(() => {
  if (!RUN) return;
  Bun.spawnSync(['docker', 'compose', '--env-file', `${WORK}/.env`, '-f', 'compose/docker-compose.yml', 'down', '-v']);
}, 300_000);
