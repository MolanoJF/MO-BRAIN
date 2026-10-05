import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { SQL } from 'bun';

// The control plane severs a half-open socket at IDLE_TIMEOUT_S = 60
// (src/control/app.ts). Stay strictly below it so a failed quiesce returns an
// honest 503 with its diagnostic instead of an empty-body 499 from the 60 s
// teardown. With the entrypoint sweeping orphans the pause should succeed in
// seconds, so the shorter budget is safe.
const QUIET_TIMEOUT_MS = 45_000;
const QUIET_POLL_MS = 500;
// The supervisor status probe shells out to gbrain; cap it so a poll cannot
// spend more than its bounded budget. If the child ignores SIGTERM, the probe
// escalates to SIGKILL after KILL_GRACE_MS, so a hung probe still closes and
// the throw stays within its budget plus that grace (small next to the 60 s
// control-plane teardown).
const SUPERVISOR_PROBE_TIMEOUT_MS = 15_000;
// After SIGTERM, wait this long for 'close' before SIGKILL. A TERM-resistant
// gbrain would otherwise never emit 'close' and the await would block forever.
const KILL_GRACE_MS = 2_000;
// After the supervisor is down, a writer backend may still be draining; give it
// this long before terminating it, so a clean shutdown is never force-killed.
const QUIET_GRACE_MS = 15_000;

/** One row of `pg_stat_activity` for the brain DB, with no query text. */
export interface Backend {
  pid: number;
  usename: string;
  applicationName: string;
  clientAddr: string | null;
  backendType: string;
  state: string | null;
  idleSeconds: number | null;
}

export function pauseFilePath(): string {
  return join(process.env.GBRAIN_HOME ?? '/srv/gbrain-home', '.mobrain-writers-paused');
}

async function defaultWritePause(): Promise<void> {
  const path = pauseFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${new Date().toISOString()}\n`, { mode: 0o644 });
}

async function defaultClearPause(): Promise<void> {
  await unlink(pauseFilePath()).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e;
  });
}

/** The slice of a spawned child `runGbrain` needs; exported for its unit test. */
export interface GbrainChild {
  kill: (signal: NodeJS.Signals) => unknown;
  stderr: { on: (event: 'data', listener: (chunk: unknown) => void) => unknown };
  on: (event: 'close', listener: (code: number | null) => void) => unknown;
}

export function runGbrain(
  argv: string[],
  timeoutMs: number,
  deps: { spawn?: (argv: string[]) => GbrainChild; killGraceMs?: number } = {},
): Promise<{ exitCode: number; stderr: string }> {
  const spawnChild = deps.spawn
    ?? ((a: string[]) => spawn('gbrain', a, { stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as GbrainChild);
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS;
  return new Promise((resolve) => {
    const child = spawnChild(argv);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode: code ?? -1, stderr });
    });
  });
}

/**
 * Every other connection to the brain DB, with enough identity to name a
 * lingering writer in the quiesce error. `query` is deliberately not selected:
 * it can hold user content and is not needed to identify the writer.
 */
export async function listOtherBackends(): Promise<Backend[]> {
  const url = process.env.GBRAIN_DATABASE_URL;
  if (!url) throw new Error('GBRAIN_DATABASE_URL is required to quiesce writers');
  const brain = new SQL(url, { max: 1 });
  try {
    const rows = await brain.unsafe(
      'SELECT pid, usename, application_name, client_addr::text AS client_addr, backend_type, state, ' +
      'EXTRACT(EPOCH FROM now() - state_change)::float AS idle ' +
      'FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() ' +
      'ORDER BY backend_start',
    ) as Array<{
      pid: number;
      usename: string;
      application_name: string;
      client_addr: string | null;
      backend_type: string;
      state: string | null;
      idle: number | null;
    }>;
    return rows.map((r) => ({
      pid: Number(r.pid),
      usename: r.usename,
      applicationName: r.application_name,
      clientAddr: r.client_addr,
      backendType: r.backend_type,
      state: r.state,
      idleSeconds: r.idle === null ? null : Number(r.idle),
    }));
  } finally {
    await brain.end().catch(() => {});
  }
}

/**
 * Terminate the named writer connections only. The predicate repeats the
 * identity guard -- own database, a `client backend`, the current user -- so a
 * blanket `pg_terminate_backend` can never take out a background or system
 * backend, even if a caller passes a pid it should not.
 */
export async function terminateWriterBackends(pids: number[]): Promise<void> {
  if (pids.length === 0) return;
  const url = process.env.GBRAIN_DATABASE_URL;
  if (!url) throw new Error('GBRAIN_DATABASE_URL is required to quiesce writers');
  const brain = new SQL(url, { max: 1 });
  try {
    await brain.unsafe(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity ' +
      "WHERE pid = ANY($1::int[]) AND datname = current_database() " +
      "AND backend_type = 'client backend' AND usename = current_user",
      [pids],
    );
  } finally {
    await brain.end().catch(() => {});
  }
}

export interface WaitUntilQuietDeps {
  supervisorDown?: (timeoutMs: number) => Promise<boolean>;
  listBackends?: () => Promise<Backend[]>;
  terminate?: (pids: number[]) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  graceMs?: number;
  timeoutMs?: number;
}

function renderBackend(b: Backend): string {
  const idle = b.idleSeconds === null ? 'null' : `${b.idleSeconds.toFixed(1)}s`;
  return `[pid=${b.pid},app="${b.applicationName}",user=${b.usename},` +
    `addr=${b.clientAddr ?? 'null'},type=${b.backendType},` +
    `state=${b.state ?? 'null'},idle=${idle}]`;
}

export async function defaultWaitUntilQuiet(deps: WaitUntilQuietDeps = {}): Promise<void> {
  const supervisorDown = deps.supervisorDown;
  const listBackends = deps.listBackends ?? listOtherBackends;
  const terminate = deps.terminate ?? terminateWriterBackends;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const graceMs = deps.graceMs ?? QUIET_GRACE_MS;
  const timeoutMs = deps.timeoutMs ?? QUIET_TIMEOUT_MS;

  const start = now();
  let downSince: number | null = null;
  let lastDown = false;
  for (;;) {
    // Check the deadline BEFORE the supervisor probe. The status probe can take
    // its whole (bounded) budget, so a poll that starts just under the deadline
    // must decide to give up first -- waiting until after the probe would let
    // the throw cross into the control plane's 60 s teardown window.
    if (now() - start > timeoutMs) {
      const backends = await listBackends();
      const rendered = backends.map(renderBackend).join(', ');
      throw new Error(
        `writers did not quiesce within ${timeoutMs}ms (supervisor ${lastDown ? 'down' : 'up'}, ` +
        `other backends ${backends.length}: ${rendered}). ` +
        'gbrain-serve and gbrain-worker must use gbrain-gated-entrypoint.sh',
      );
    }

    // Never let the probe spend more than the time left in the budget (bounded
    // by its own cap and the SIGKILL grace), so the deadline is enforced within
    // one poll interval plus that grace.
    const remaining = Math.max(0, timeoutMs - (now() - start));
    const probeTimeoutMs = Math.min(SUPERVISOR_PROBE_TIMEOUT_MS, remaining);
    const down = supervisorDown
      ? await supervisorDown(probeTimeoutMs)
      : (await runGbrain(['jobs', 'supervisor', 'status', '--json'], probeTimeoutMs)).exitCode === 1;
    lastDown = down;
    const backends = await listBackends();
    if (down && backends.length === 0) return;

    if (down) {
      if (downSince === null) downSince = now();
      // Never force a writer while the supervisor is still up; once it is down
      // and the drain grace has elapsed, terminate the lingering client
      // backends so the count converges instead of timing out.
      if (now() - downSince >= graceMs) {
        const doomed = backends
          .filter((b) => b.backendType === 'client backend')
          .map((b) => b.pid);
        if (doomed.length > 0) await terminate(doomed);
      }
    } else {
      downSince = null;
    }

    await sleep(QUIET_POLL_MS);
  }
}

export async function pauseBrainWriters(deps?: {
  writePause?: () => Promise<void>;
  waitUntilQuiet?: () => Promise<void>;
}): Promise<void> {
  await (deps?.writePause ?? defaultWritePause)();
  await (deps?.waitUntilQuiet ?? defaultWaitUntilQuiet)();
}

export async function resumeBrainWriters(deps?: {
  clearPause?: () => Promise<void>;
}): Promise<void> {
  await (deps?.clearPause ?? defaultClearPause)();
}
