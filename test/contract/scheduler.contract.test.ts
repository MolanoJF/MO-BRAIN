import { test, expect, describe, beforeAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { buildArgv } from '../../src/contracts/argv.ts';
import { execOperation, assertOk } from '../../src/contracts/exec.ts';
import { composeUp, resetBrain, seedGitSource, BRAIN_DB_URL } from '../helpers/stack.ts';

const PROBE_SOURCE = 'slice3-probe';

beforeAll(async () => {
  await composeUp();
}, 1_800_000);

describe('scheduler operation shapes (no container needed)', () => {
  test("embed accepts --source so a Connection-scoped embed is expressible", () => {
    expect(buildArgv(OPERATIONS.embed!, { stale: true, source: PROBE_SOURCE }, { json: true }))
      .toEqual(['embed', '--stale', '--source', PROBE_SOURCE, '--json']);
  });

  test('dream is expressible as the nightly maintenance cycle', () => {
    expect(buildArgv(OPERATIONS.dream!, { source: PROBE_SOURCE }, { json: true }))
      .toEqual(['dream', '--source', PROBE_SOURCE, '--json']);
    expect(buildArgv(OPERATIONS.dream!, { source: PROBE_SOURCE }, { json: true, dryRun: true }))
      .toEqual(['dream', '--source', PROBE_SOURCE, '--dry-run', '--json']);
  });

  test("sources.push takes the source id as a POSITIONAL, like the real CLI", () => {
    expect(buildArgv(OPERATIONS['sources.push']!, { id: PROBE_SOURCE }, { json: true }))
      .toEqual(['sources', 'push', PROBE_SOURCE, '--json']);
  });

  test('sources.push declares only exit 0 as success — 5 and 1 are real failures', () => {
    // Upstream src/commands/sources.ts runPush: 0 pushed/skipped_in_flight,
    // 5 blocked (secrets / tracked deny / unscannable) or refused (visibility),
    // 1 pull conflict / push failure, 2 usage, 4 source not found.
    expect([...OPERATIONS['sources.push']!.okExitCodes]).toEqual([0]);
  });

  test('doctor still declares okExitCodes [0] — a blocker IS a failure for our gate', () => {
    expect([...OPERATIONS.doctor!.okExitCodes]).toEqual([0]);
  });
});

describe('scheduler operations against the pinned container', () => {
  // Plan defect (adapted, no assertion weakened): the plan's block performs
  // only `resetBrain()` + `seedGitSource()`. Two further steps are required
  // against the pinned container, both confirmed empirically here:
  //   1. `resetBrain()` drops the schema, and the brain a later command
  //      auto-creates from that state carries the DEFAULT embedding model
  //      (zeroentropyai:zembed-1), whose key this environment does not have —
  //      `embed --stale --source` then dies in its embedding-credential
  //      preflight (src/core/embed-preflight.ts, "requires
  //      ZEROENTROPY_API_KEY") with exit 1. Re-initializing with a keyed
  //      model is the repo-wide convention (every other contract test's
  //      beforeAll calls `init` with openai:text-embedding-3-small).
  //   2. `seedGitSource()` only puts a git repo on disk; it does NOT register
  //      the source. Unregistered, `dream --source` exits 1 and `sources push
  //      <id>` exits 4 with no JSON receipt ("Source ... not found or is
  //      archived").
  // Every assertion in this block is the plan's, unchanged.
  beforeAll(async () => {
    await resetBrain();
    assertOk(OPERATIONS.init!, await execOperation(OPERATIONS.init!, {
      nonInteractive: true, force: true, url: BRAIN_DB_URL,
      embeddingModel: 'openai:text-embedding-3-small',
    }, { timeoutMs: 600_000 }));
    await seedGitSource(PROBE_SOURCE);
    assertOk(OPERATIONS['sources.add']!, await execOperation(OPERATIONS['sources.add']!, {
      id: PROBE_SOURCE, path: `/srv/brain-repos/${PROBE_SOURCE}`,
    }, { timeoutMs: 300_000 }));
  }, 900_000);

  test('dream --dry-run --json previews without writing', async () => {
    const r = await execOperation(OPERATIONS.dream!, { source: PROBE_SOURCE },
      { json: true, dryRun: true, timeoutMs: 600_000 });
    expect(r.exitCode).toBe(0);
    expect(r.json).not.toBeNull();
  }, 900_000);

  test('sources push on a repo with no origin fails loudly, never silently', async () => {
    // seedGitSource creates a local repo with no remote. Upstream's runPush
    // maps "not a git repo / no origin" to status 'error' -> exit 1.
    const r = await execOperation(OPERATIONS['sources.push']!, { id: PROBE_SOURCE },
      { json: true, timeoutMs: 300_000 });
    expect(r.exitCode).not.toBe(0);
    const body = r.json as { status?: string; reason?: string } | null;
    // The JSON receipt is printed BEFORE the non-zero exit, so it is readable.
    expect(body?.status).toBeTruthy();
    expect(['error', 'push_failed', 'pull_conflict']).toContain(body!.status!);
  }, 600_000);

  test('embed --stale --source scopes to one source and exits clean', async () => {
    const r = await execOperation(OPERATIONS.embed!, { stale: true, source: PROBE_SOURCE },
      { json: true, timeoutMs: 600_000 });
    expect(r.exitCode).toBe(0);
  }, 900_000);
});

// ---------------------------------------------------------------------------
// Task 16 — Seam Gate A: the ops RPC seam, headless.
//
// Where the Task 5 blocks above drive the SLICE0 compose project through
// `composeExec`, Gate A drives the MAIN product stack's `gbrain-ops` over the
// host port its dev override publishes (compose/docker-compose.dev.yml maps
// 3140:3140; the base file publishes nothing, by invariant). The slice0
// `gbrain-ops` is the pinned `brainstand/gbrain-base` image and is never
// rebuilt from this working tree, so `/fileplane/report` and `/rpc/cancel` do
// not exist there at all — and a stale main-stack container is exactly what
// A2/A4 catch, because the allowlist they load comes out of the image.
//
// Consequence for the fixture: PROBE_SOURCE has to exist in the MAIN stack's
// brain (the one the rebuilt container serves), not only in slice0's. It is
// seeded below, and reset to a virgin state each run.
// ---------------------------------------------------------------------------

const MAIN_COMPOSE = [
  '--env-file', '.env',
  '-f', 'compose/docker-compose.yml',
  '-f', 'compose/docker-compose.dev.yml',
];

/** gbrain-ops's published RPC port, per the dev override. */
const OPS = 'http://localhost:3140';

/** Bun loads `.env` into `process.env`; the fallback covers a non-Bun runner. */
function dotenvValue(key: string): string {
  try {
    return (readFileSync('.env', 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] ?? '').trim();
  } catch { return ''; }
}

const OPS_TOKEN = process.env.OPS_RPC_TOKEN ?? dotenvValue('OPS_RPC_TOKEN');

/** The emitted allowlist document, as `operations:emit` writes it (A1). */
type EmittedDoc = { operations: { id: string; params: { name: string }[] }[] };
/** Upstream `buildSingleSyncJsonEnvelope` (A7). */
type SyncReceipt = { added: number; modified: number };
/** `/fileplane/report` (A5) and `/rpc/cancel` (A8) response bodies. */
type ReportWrite = { relPath: string; committed: boolean; sha: string | null };
type CancelResult = { cancelled: boolean };

type RawResult = { exitCode: number; stdout: string; stderr: string };

/**
 * Exec inside the MAIN stack's `gbrain-ops`. Same `-T` headless shape as
 * `composeExec`; the difference is which compose project it addresses.
 */
async function mainExec(argv: string[]): Promise<RawResult> {
  // Bun Shell: array interpolation means every element stays one argv entry
  // (no shell string, ever). `.nothrow()` keeps a non-zero exit inspectable
  // instead of throwing, and there is no timer to bind the call to the clock.
  const r = await Bun.$`docker compose ${MAIN_COMPOSE} exec -T gbrain-ops ${argv}`.quiet().nothrow();
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

/**
 * `sync` prints the embed cost-gate object BEFORE its receipt, and the ops
 * server parses stdout from the FIRST `{`, so `json` comes back null for
 * `sync`. Reading the last balanced JSON value is the repo-wide client
 * convention — `src/contracts/exec.ts` documents exactly that rule. The
 * server's own value wins whenever it parsed.
 */
function lastJsonValue(stdout: string): unknown {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try { return JSON.parse(line); } catch { /* keep scanning backwards */ }
  }
  return null;
}

async function opsPostRaw(
  path: string, body: unknown, timeoutMs = 600_000,
): Promise<{ status: number; body: unknown }> {
  if (!OPS_TOKEN) {
    throw new Error('OPS_RPC_TOKEN is empty (expected in .env) — every RPC call would 401');
  }
  const res = await fetch(`${OPS}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${OPS_TOKEN}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function opsPost<T = unknown>(path: string, body: unknown, timeoutMs = 600_000): Promise<T> {
  return (await opsPostRaw(path, body, timeoutMs)).body as T;
}

type OpsRpcResult = {
  ok?: boolean; exitCode?: number; argv?: string[];
  stdout?: string; stderr?: string; json?: unknown; error?: string;
};

async function opsRpc(
  op: string,
  params: Record<string, unknown> = {},
  opts: { json?: boolean; dryRun?: boolean; timeoutMs?: number; runId?: string } = {},
): Promise<OpsRpcResult> {
  const { body } = await opsPostRaw('/rpc', {
    op, params, json: opts.json, dryRun: opts.dryRun, timeoutMs: opts.timeoutMs, runId: opts.runId,
  }, (opts.timeoutMs ?? 600_000) + 30_000);
  // The response is the compiled server's own JSON; the shape is checked by the
  // assertions in each gate test below, not here.
  const result = (body ?? {}) as OpsRpcResult;
  if (result.json == null && typeof result.stdout === 'string') {
    result.json = lastJsonValue(result.stdout);
  }
  return result;
}

/** Mirrors the e2e suites' probe: is `docker compose` usable at all? */
async function probeDockerCompose(): Promise<boolean> {
  try {
    return (await Bun.$`docker compose version`.quiet().nothrow()).exitCode === 0;
  } catch { return false; }
}

const dockerAvailable = await probeDockerCompose();

/**
 * Register PROBE_SOURCE in the MAIN stack's brain and leave it virgin.
 *
 * `sources add` already imports the seed commit, so A5's report commit is the
 * only thing a later sync can see as new — which A7's `added + modified > 0`
 * depends on. The reset is what makes that true on a re-run: `writeReport`
 * never overwrites, it appends `-2`, `-3`, …, so A5's fixed `relPath` is only
 * reproducible against a Space with no `reports/` history.
 */
async function ensureProbeSource(): Promise<void> {
  const list = await mainExec(['gbrain', 'sources', 'list', '--json']);
  if (list.exitCode !== 0) throw new Error(`sources list failed: ${list.stderr}`);

  if (list.stdout.includes(`"id": "${PROBE_SOURCE}"`)) {
    const removed = await mainExec(
      ['gbrain', 'sources', 'remove', PROBE_SOURCE, '--confirm-destructive'],
    );
    if (removed.exitCode !== 0) {
      throw new Error(`sources remove failed (${removed.exitCode}): ${removed.stderr}`);
    }
  }

  const dir = `/srv/brain-repos/${PROBE_SOURCE}`;
  // sh -c is for git only; gbrain itself is always an argv array (G2).
  const seeded = await mainExec(['sh', '-c',
    `set -e; rm -rf ${dir}; mkdir -p ${dir}; cd ${dir}; git init -q; ` +
    `echo "# ${PROBE_SOURCE}" > README.md; git add -A; ` +
    'git -c user.email=gate-a@brainstand.local -c user.name=gate-a commit -q -m seed',
  ]);
  if (seeded.exitCode !== 0) throw new Error(`git seed failed (${seeded.exitCode}): ${seeded.stderr}`);

  const added = await mainExec(['gbrain', 'sources', 'add', PROBE_SOURCE, '--path', dir]);
  if (added.exitCode !== 0) {
    throw new Error(`sources add failed (${added.exitCode}): ${added.stdout}\n${added.stderr}`);
  }
}

describe('Slice 3 seam gate A', () => {
  beforeAll(async () => {
    if (!dockerAvailable) return;
    await ensureProbeSource();
  }, 900_000);

  test('slice3 contract tests are not silently skipped', () => {
    if (dockerAvailable) return;
    if (process.env.BRAINSTAND_ALLOW_SKIP_SLICE3_CONTRACT === '1') return;
    throw new Error(
      'docker compose is not usable, so the slice3 contract suite was skipped rather than run. '
        + 'Install/start Docker, then rerun:\n\n  bun test test/contract/scheduler.contract.test.ts\n\n'
        + 'If skipping is genuinely intended, set BRAINSTAND_ALLOW_SKIP_SLICE3_CONTRACT=1.',
    );
  });

  test('A1. the emitted allowlist carries the three new shapes', async () => {
    const doc = JSON.parse(readFileSync('contracts/v0.50.0.0/operations.json', 'utf8')) as EmittedDoc;
    const byId = Object.fromEntries(doc.operations.map((o) => [o.id, o]));
    expect(byId['dream']).toBeDefined();
    expect(byId['sources.push']).toBeDefined();
    expect(byId['embed']!.params.map((p) => p.name)).toContain('source');
  });

  test('A2. gbrain-ops dispatches dream through the RPC, not just the module', async () => {
    const r = await opsRpc('dream', { source: PROBE_SOURCE }, { json: true, dryRun: true });
    expect(r.error).toBeUndefined();          // NOT "unknown operation"
    expect(r.exitCode).toBe(0);
  }, 900_000);

  test('A3. gbrain-ops REFUSES an operation outside the allowlist', async () => {
    const r = await opsRpc('autopilot', {}, {});
    expect(r.error).toMatch(/unknown operation/);
  });

  test('A4. gbrain-ops refuses a param the spec does not declare', async () => {
    const r = await opsRpc('sync', { sourceId: 'typo-not-source' }, { json: true });
    expect(r.error).toMatch(/unknown param/);
  });

  test('A5. a report write lands in the Space repo and is committed as the member', async () => {
    const written = await opsPost<ReportWrite>('/fileplane/report', {
      sourceId: PROBE_SOURCE, job: 'gate-a', stamp: '2026-09-15-0230',
      reportBody: '# gate a\n', actor: { name: 'Ada Member', email: 'ada@example.test' },
    });
    expect(written.relPath).toBe('reports/gate-a/2026-09-15-0230.md');

    const show = await mainExec(
      ['git', '-C', `/srv/brain-repos/${PROBE_SOURCE}`, 'log', '-1', '--format=%an <%ae>']);
    expect(show.stdout.trim()).toBe('Ada Member <ada@example.test>');

    // Sync imports COMMITS, not the working tree: a dirty tree is a page the
    // brain cannot see.
    const status = await mainExec(
      ['git', '-C', `/srv/brain-repos/${PROBE_SOURCE}`, 'status', '--porcelain']);
    expect(status.stdout.trim()).toBe('');
  }, 300_000);

  test('A6. a traversing report path is refused at the RPC boundary', async () => {
    for (const bad of [
      { job: '../../etc', stamp: '2026-09-15-0230' },
      { job: 'ok', stamp: '../../../passwd' },
      { sourceId: '../escape', job: 'ok', stamp: '2026-09-15-0230' },
    ]) {
      const r = await opsPostRaw('/fileplane/report', {
        sourceId: PROBE_SOURCE, reportBody: 'x',
        actor: { name: 'a', email: 'a@b.test' }, ...bad,
      });
      expect(r.status).toBe(400);
    }
  });

  test('A7. the committed report is importable — sync sees it as a page', async () => {
    const sync = await opsRpc('sync', { source: PROBE_SOURCE }, { json: true });
    expect(sync.exitCode).toBe(0);
    // buildSingleSyncJsonEnvelope: { added, modified, deleted, ... }
    const receipt = sync.json as SyncReceipt;  // the receipt asserted on the next line
    expect(receipt.added + receipt.modified).toBeGreaterThan(0);
  }, 900_000);

  test('A8. cancel is authorized and idempotent', async () => {
    const unauthorized = await fetch(`${OPS}/rpc/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'nope' }),
    });
    expect(unauthorized.status).toBe(401);

    const r = await opsPost<CancelResult>('/rpc/cancel', { runId: 'not-a-live-run' });
    expect(r.cancelled).toBe(false);   // idempotent, not an error
  });

  test('A9. doctor --json still has no top-level blockers key at this pin', async () => {
    // Slice 0 findings V6, re-asserted here because Task 12's weekly-health
    // report renderer depends on it. A regression must fail loudly.
    const r = await opsRpc('doctor', {}, { json: true });
    expect(Object.keys(r.json as object)).not.toContain('blockers');
    expect(r.json).toHaveProperty('checks');
    expect(r.json).toHaveProperty('status');
  }, 900_000);
});
