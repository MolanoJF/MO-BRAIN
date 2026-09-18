import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
// Bind host OPS URL before opsClient (and backup/restore) evaluate — static
// imports are hoisted; this side-effect module must be first among our deps.
import './host-ops-env.ts';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBackup } from '../../scripts/backup.ts';
import { runRestore } from '../../scripts/restore.ts';
import { callOps, opsHealthy, seedSpace } from '../../src/control/opsClient.ts';

const SKIP_RESTORE_E2E_ENV = 'BRAINSTAND_ALLOW_SKIP_RESTORE_E2E';

let dir: string;
const KNOWN_SLUG = 'restore-probe';
const KNOWN_TEXT = 'The restore probe page proves a known page survives.';

// --env-file .env when present; project dir stays compose/ so volume paths resolve.
const COMPOSE = [
  'docker', 'compose',
  ...(existsSync('.env') ? ['--env-file', '.env'] as const : []),
  '-f', 'compose/docker-compose.yml',
  '-f', 'compose/docker-compose.dev.yml',
];

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
 * Must finish in a few seconds: a multi-hour restore e2e against a down
 * docker daemon is a hang (Ruling 30), not a gate.
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

/**
 * `up -d --wait` gates on POSTGRES' healthcheck; gbrain-ops declares none (only
 * postgres does), so compose is satisfied once that container is RUNNING —
 * which is not the same instant as the host being able to reach the ops RPC
 * published at 127.0.0.1:3140. This file is the one that cycles the volumes, so
 * the brain it restores is nearly empty, `runRestore` returns in seconds, and
 * the host-side `sources.list` below runs only a moment after the containers
 * were created. Measured here: a 1s poller saw the published surface refuse
 * connections for ~8s around restore's own `down -v` + `up`, and this leg
 * failed in the directory run and passed alone minutes later on identical code
 * — a readiness race, not a failed restore.
 *
 * Bounded (Ruling 30): a genuinely dead ops surface still fails the assertion
 * this guards instead of hanging the suite, and no assertion changes — this
 * waits for the surface the assertion reads THROUGH, exactly as slice1 waits on
 * both HTTP surfaces before reading them. `opsHealthy()` is the shipped probe
 * (GET /healthz, unauthenticated); the thing awaited is another container
 * publishing a port, so it is a real poll and no fake clock can advance it.
 */
async function waitForOpsRpc(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await opsHealthy()) return;
    await Bun.sleep(500);
  }
  throw new Error(
    `the ops RPC at ${process.env.OPS_RPC_URL ?? 'http://127.0.0.1:3140'} never answered /healthz `
      + `within ${timeoutMs}ms`,
  );
}

beforeAll(async () => {
  if (!dockerAvailable) return;
  dir = await mkdtemp(join(tmpdir(), 'bs-restore-'));
  await compose('up', '-d', '--wait');
  // The file's own first host-side call is callOps('init') below: same surface,
  // same cold-stack window. A real poll, not a fake clock — the thing awaited is
  // another container binding its port.
  await waitForOpsRpc();

  // Virgin CI stacks need init before sources.add. Re-init on an existing
  // brain may exit non-zero (dim mismatch / already templated) — that is fine.
  await callOps('init', {
    nonInteractive: true,
    embeddingModel: 'openai:text-embedding-3-small',
  }, { timeoutMs: 900_000 }).catch(() => undefined);

  // Self-contained: seed a committed git repo (V12), register it, write probe.
  await seedSpace('shared');
  const added = await callOps('sources.add', {
    id: 'shared',
    path: '/srv/brain-repos/shared',
    name: 'Shared company wiki',
  }, { timeoutMs: 300_000 });
  if (!added.ok && !/already (exists|registered)|duplicate|unique/i.test(added.stderr + added.stdout)) {
    throw new Error(`sources.add shared failed: ${added.stderr || added.stdout}`);
  }

  // Seed a known page. sh -c is for printf/git only (not gbrain — S2 lint).
  const seed = await composeExec('gbrain-ops', [
    'sh', '-c',
    `printf '# Restore probe\\n\\n${KNOWN_TEXT}\\n' > /srv/brain-repos/shared/${KNOWN_SLUG}.md && ` +
    `cd /srv/brain-repos/shared && ` +
    `git -c user.email=restore@brainstand.local -c user.name=restore ` +
    `add -A && git -c user.email=restore@brainstand.local -c user.name=restore ` +
    `commit -qm 'restore probe'`,
  ]);
  if (seed.exitCode !== 0) throw new Error(`seed probe failed: ${seed.stderr}`);

  // CI has no embed provider key; sync without --no-embed fails closed with
  // embedding_credentials_missing and imports 0 pages. --no-embed is not on
  // the ops allowlist, so invoke it via argv compose exec (still no shell).
  const sync = await composeExec('gbrain-ops', [
    'gbrain', 'sync', '--all', '--no-embed', '--json',
  ], 900_000);
  if (sync.exitCode !== 0) {
    throw new Error(`sync --no-embed failed: ${sync.stderr || sync.stdout}`);
  }

  // Best-effort embed when a key is present; keyword search still proves the page.
  if (process.env.OPENAI_API_KEY) {
    await callOps('config.set', {
      key: 'openai_api_key',
      value: process.env.OPENAI_API_KEY,
    }, { timeoutMs: 60_000 }).catch(() => undefined);
    await callOps('embed', { stale: true }, { json: true, timeoutMs: 900_000 }).catch(() => undefined);
  }

  // Register a Connection so restore's re-issue list exercises real client rows
  // (V9: gbrain hashes secrets — restore cannot recover plaintext credentials).
  await callOps('auth.registerClient', {
    name: 'restore-reissue-probe',
    grantTypes: 'client_credentials',
    scopes: 'read',
    source: 'shared',
  }, { timeoutMs: 120_000 }).catch(() => undefined);
}, 1_800_000);

afterAll(async () => {
  if (!dockerAvailable) return;
  await compose('down', '-v');
  if (dir) await rm(dir, { recursive: true, force: true });
}, 600_000);

describe('restore', () => {
  test('restore e2e tests are not silently skipped', () => {
    if (dockerAvailable) return;
    if (process.env[SKIP_RESTORE_E2E_ENV] === '1') return;
    throw new Error(
      'docker compose is not usable, so the restore e2e suite was skipped rather than run. ' +
        'Install/start Docker, then rerun:\n\n' +
        '  bun test test/e2e/restore.e2e.test.ts\n\n' +
        `If skipping is genuinely intended for this run, set ${SKIP_RESTORE_E2E_ENV}=1 ` +
        'to acknowledge it explicitly.',
    );
  });

  test.skipIf(!dockerAvailable)('an empty stack restored from a backup reproduces a known page', async () => {
    await runBackup(dir);

    // Destroy everything, then bring an empty stack back up.
    await compose('down', '-v');
    await compose('up', '-d', '--wait');

    const report = await runRestore(dir);
    expect(report.ok).toBe(true);
    expect(report.doctorExitCode).toBe(0);

    // The stack is up, but THIS read is a host-side one: it goes through
    // gbrain-ops' published port, and `up -d --wait` gates on postgres alone
    // (gbrain-ops has no healthcheck). Wait for the surface the assertion reads
    // before asserting on it.
    await waitForOpsRpc();
    const search = await callOps<{ sources?: unknown[] }>('sources.list', {}, { json: true, timeoutMs: 120_000 });
    expect(search.ok).toBe(true);

    const probe = await composeExec('gbrain-ops', [
      'gbrain', 'search', 'restore probe', '--json',
    ], 120_000);
    expect(probe.stdout).toContain(KNOWN_SLUG);
  }, 3_600_000);

  // V9: gbrain's backup excludes every credential and restore starts no
  // automation, so a naive restore leaves intact knowledge and zero working
  // agent connections. The product does the re-issue and says who must refresh.
  test.skipIf(!dockerAvailable)('restore reports which connections need re-issued credentials', async () => {
    const report = await runRestore(dir);
    expect(Array.isArray(report.connectionsNeedingReissue)).toBe(true);
  }, 1_800_000);

  // Restoring to a new domain invalidates every grant: OAuth redirect URIs
  // and issuer URLs are domain-bound.
  test.skipIf(!dockerAvailable)('restoring to a new domain flags bulk re-provisioning', async () => {
    const report = await runRestore(dir, { newDomain: 'brain-new.example.test' });
    expect(report.domainChanged).toBe(true);
  }, 1_800_000);
});
