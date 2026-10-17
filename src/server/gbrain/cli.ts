export type CliResult = { exitCode: number; stdout: string; stderr: string };

/** Run gbrain with an argv array. Never a shell string. */
export async function runGbrain(
  argv: string[],
  opts: { timeoutMs?: number; env?: Record<string, string>; bin?: string; stdin?: string } = {},
): Promise<CliResult> {
  const proc = Bun.spawn([opts.bin ?? process.env.GBRAIN_BIN ?? 'gbrain', ...argv], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: opts.stdin === undefined ? 'ignore' : new TextEncoder().encode(opts.stdin),
    env: { ...process.env, ...opts.env },
  });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 120_000);
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

const R = '[REDACTED]';

export function scrub(text: string): string {
  return text
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, `$1${R}@`)
    .replace(/("?(?:client_secret|access_token|refresh_token|token)"?\s*[:=]\s*"?)[^",\s]+/gi, `$1${R}`)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, `$1${R}`)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, R);
}

/** The last balanced top-level JSON object or array in stdout, or null. */
export function lastJson(stdout: string): unknown {
  for (let end = stdout.length - 1; end >= 0; end--) {
    const close = stdout[end];
    if (close !== '}' && close !== ']') continue;
    const open = close === '}' ? '{' : '[';
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      if (stdout[i] === close) depth++;
      else if (stdout[i] === open) depth--;
      if (depth === 0) {
        try { return JSON.parse(stdout.slice(i, end + 1)); } catch { break; }
      }
    }
  }
  return null;
}

/** Throw a scrubbed error unless the exit code is 0. */
export function assertOk(label: string, r: CliResult): CliResult {
  if (r.exitCode !== 0) throw new Error(`${label} exited ${r.exitCode}: ${scrub(r.stderr || r.stdout).slice(0, 800)}`);
  return r;
}
