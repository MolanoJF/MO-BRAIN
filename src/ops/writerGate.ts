import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { SQL } from 'bun';

const QUIET_TIMEOUT_MS = 60_000;
const QUIET_POLL_MS = 500;

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

function runGbrain(argv: string[], timeoutMs: number): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('gbrain', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stderr });
    });
  });
}

async function otherBackends(): Promise<number> {
  const url = process.env.GBRAIN_DATABASE_URL;
  if (!url) throw new Error('GBRAIN_DATABASE_URL is required to quiesce writers');
  const brain = new SQL(url, { max: 1 });
  try {
    const rows = await brain.unsafe(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()',
    ) as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  } finally {
    await brain.end().catch(() => {});
  }
}

export async function defaultWaitUntilQuiet(): Promise<void> {
  const deadline = Date.now() + QUIET_TIMEOUT_MS;
  let last = 'supervisor status not yet read';
  for (;;) {
    const status = await runGbrain(['jobs', 'supervisor', 'status', '--json'], 15_000);
    const backends = await otherBackends();
    // Exit 1 is "not running" (registry okExitCodes). Exit 0 means it is still up.
    const supervisorDown = status.exitCode === 1;
    if (supervisorDown && backends === 0) return;
    last = `supervisor exit ${status.exitCode}, other backends ${backends}`;
    if (Date.now() > deadline) {
      throw new Error(
        `writers did not quiesce within ${QUIET_TIMEOUT_MS}ms (${last}). ` +
        'gbrain-serve and gbrain-worker must use gbrain-gated-entrypoint.sh',
      );
    }
    await Bun.sleep(QUIET_POLL_MS);
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
