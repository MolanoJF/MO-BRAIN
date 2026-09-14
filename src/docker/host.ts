import { REDACTED } from '../contracts/types.ts';

const COMPOSE_FILE = 'compose/docker-compose.slice0.yml';

export type RawResult = { exitCode: number; stdout: string; stderr: string };

async function run(argv: string[], timeoutMs = 300_000): Promise<RawResult> {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export async function composeUp(): Promise<void> {
  const r = await run(['docker', 'compose', '-f', COMPOSE_FILE, 'up', '-d', '--wait']);
  if (r.exitCode !== 0) throw new Error(`compose up failed (${r.exitCode}): ${r.stderr}`);
}

export async function composeDown(): Promise<void> {
  await run(['docker', 'compose', '-f', COMPOSE_FILE, 'down', '-v']);
}

/**
 * Exec inside a compose service. `-T` disables TTY allocation, which is what
 * makes every invocation headless — the thing Slice 0 exists to prove.
 * argv is passed as separate process arguments; there is no shell.
 */
export async function composeExec(
  service: string,
  argv: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<RawResult> {
  const envArgs = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return run(
    ['docker', 'compose', '-f', COMPOSE_FILE, 'exec', '-T', ...envArgs, service, ...argv],
    opts.timeoutMs,
  );
}

/** Redact anything that looks like a credential before a result reaches a log. */
export function scrubOutput(text: string): string {
  return text
    .replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/gi, `$1${REDACTED}@`)
    .replace(/("?client_secret"?\s*[:=]\s*"?)[^",\s]+/gi, `$1${REDACTED}`)
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, REDACTED);
}
