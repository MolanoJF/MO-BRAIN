import { test, expect, beforeAll, afterAll } from 'bun:test';
import { execOperation, assertOk } from '../../src/contracts/exec.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { composeUp, composeDown, resetBrain, BRAIN_DB_URL } from '../helpers/stack.ts';

beforeAll(async () => {
  await composeUp();
  await resetBrain();
  assertOk(OPERATIONS.init!, await execOperation(OPERATIONS.init!, {
    nonInteractive: true, force: true, url: BRAIN_DB_URL,
    embeddingModel: 'openai:text-embedding-3-small',
  }, { timeoutMs: 600_000 }));
}, 900_000);
afterAll(async () => { await composeDown(); }, 120_000);

// V6: doctor exits non-zero on blockers — so the upgrade gate can be a real gate.
test('doctor --json emits a parseable report and a meaningful exit code', async () => {
  const spec = OPERATIONS.doctor!;
  const r = await execOperation(spec, {}, { json: true, timeoutMs: 600_000 });
  expect([0, 1, 2]).toContain(r.exitCode);
  expect(r.json).not.toBeNull();
}, 660_000);

test('doctor exit code 0 means no blockers', async () => {
  const r = await execOperation(OPERATIONS.doctor!, {}, { json: true, timeoutMs: 600_000 });
  const body = r.json as { blockers?: unknown[] } | null;
  if (r.exitCode === 0 && Array.isArray(body?.blockers)) {
    expect(body!.blockers!.length).toBe(0);
  }
}, 660_000);

// V5: the supervisor drains on SIGTERM. Exit codes (start): 0 clean shutdown,
// 1 max crashes, 2 another supervisor holds the PID lock, 3 PID file unwritable.
// `stop` waits UP TO 40s — not the 35s in the spec prose. Budget 60s.
test('jobs supervisor starts detached and reports running', async () => {
  const start = await execOperation(OPERATIONS['jobs.supervisor']!, {
    detach: true, concurrency: '2',
  }, { json: true, timeoutMs: 120_000 });
  expect([0]).toContain(start.exitCode);

  const status = await execOperation(OPERATIONS['jobs.supervisorStatus']!, {}, { json: true });
  expect(status.exitCode).toBe(0); // 0 if running, 1 if not
}, 180_000);

// Plan defect (Work Item H): `gbrain jobs supervisor start --detach` ALWAYS
// exits 0 from the invoking process's own perspective, whether or not the
// lock is actually free. `--detach` forks a fully detached, unref'd child
// (spawnDetachedSupervisor, src/core/minions/detached-stderr.ts) and the
// PARENT prints the start payload and calls `process.exit(0)`
// (src/commands/jobs.ts, the `if (detach) { ...; process.exit(0); }` branch)
// BEFORE a `MinionSupervisor` is even constructed — `acquirePidLock()` /
// `tryAcquireDbLock()`, where LOCK_HELD (exit 2) is decided
// (src/core/minions/supervisor.ts:686-693, 768-774), run only inside the
// detached CHILD, whose exit code nothing here ever observes. Manually
// confirmed against the reference checkout: issuing a SECOND `--detach`
// start while the first is running exits 0 every time, and `jobs supervisor
// status --json` afterward still shows only the original PID — the second
// child failed silently in the background. The lock collision is only
// synchronously observable from a FOREGROUND second start (no --detach):
// `acquirePidLock()` sees the first supervisor's live PID in the pidfile and
// calls `process.exit(ExitCodes.LOCK_HELD)` immediately, without blocking
// (confirmed: "Supervisor already running (PID: N). Exiting.", exit 2, in
// under a second). Fixed by dropping `--detach` from the second call.
test('a second supervisor exits 2 because the first holds the PID lock', async () => {
  const second = await execOperation(OPERATIONS['jobs.supervisor']!, {
    concurrency: '2',
  }, { timeoutMs: 30_000 });
  expect(second.exitCode).toBe(2);
}, 60_000);

test('jobs supervisor stop drains cleanly within the 40s window', async () => {
  const t0 = Date.now();
  const stop = await execOperation(OPERATIONS['jobs.supervisorStop']!, {}, { timeoutMs: 90_000 });
  const elapsed = Date.now() - t0;
  expect(stop.exitCode).toBe(0);
  expect(elapsed).toBeLessThan(60_000);

  const status = await execOperation(OPERATIONS['jobs.supervisorStatus']!, {}, { json: true });
  expect(status.exitCode).toBe(1); // not running
}, 120_000);

test('apply-migrations is non-interactive and idempotent', async () => {
  const spec = OPERATIONS.applyMigrations!;
  assertOk(spec, await execOperation(spec, { yes: true, nonInteractive: true }, { timeoutMs: 300_000 }));
  assertOk(spec, await execOperation(spec, { yes: true, nonInteractive: true }, { timeoutMs: 300_000 }));
}, 660_000);

// Task 13 registry coverage: sync/embed/sources.status were previously
// exercised only from scripts/ (capture-capability.ts, tutorial.ts against
// real seeded sources) -- never from a literal OPERATIONS reference inside
// test/contract, which is what the registry invariant test's (purely
// textual) coverage check actually looks for. This file's beforeAll
// registers no sources, so these assert the graceful-no-op contract:
// neither command should error just because there is nothing to do yet.
test('sync --all --json exits cleanly with no sources registered', async () => {
  const spec = OPERATIONS.sync!;
  assertOk(spec, await execOperation(spec, { all: true }, { json: true, timeoutMs: 120_000 }));
}, 150_000);

test('embed --stale --json exits cleanly with nothing stale', async () => {
  const spec = OPERATIONS.embed!;
  assertOk(spec, await execOperation(spec, { stale: true }, { json: true, timeoutMs: 120_000 }));
}, 150_000);

test('sources status --json reports the implicit default source', async () => {
  const spec = OPERATIONS['sources.status']!;
  const r = await execOperation(spec, {}, { json: true });
  assertOk(spec, r);
  expect(r.json).not.toBeNull();
});
