import type { ExecResult, OperationSpec, ParamValues } from './types.ts';
import { buildArgv, redactArgv } from './argv.ts';
import { composeExec, scrubOutput } from '../docker/host.ts';

/**
 * Run one allowlisted gbrain operation. Returns a redacted argv so the caller
 * can log the result verbatim (S3c: never log a credential-bearing body).
 *
 * `opts.env` (Task 12): per-invocation environment overrides, layered on top
 * of the container's own environment by docker-compose-exec's `-e`. The
 * tutorial's isolation check needs this to point each simulated teammate at
 * their OWN `GBRAIN_HOME` (a separate thin-client config per member) without
 * disturbing gbrain-ops's own admin identity — every other caller omits it
 * and behaves exactly as before.
 */
export async function execOperation<T = unknown>(
  spec: OperationSpec,
  values: ParamValues,
  opts: { json?: boolean; dryRun?: boolean; service?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<ExecResult<T>> {
  const argv = buildArgv(spec, values, { json: opts.json, dryRun: opts.dryRun });
  const raw = await composeExec(opts.service ?? 'gbrain-ops', ['gbrain', ...argv], {
    timeoutMs: opts.timeoutMs,
    env: opts.env,
  });

  let json: T | null = null;
  if (opts.json) {
    // Parse the LAST balanced JSON value on stdout: gbrain may emit progress
    // or diagnostic lines — some of which contain `{`/`[` — before the
    // machine-readable receipt (inv-051-b, Failure B).
    json = extractReceiptJson(raw.stdout) as T | null;
  }

  return {
    argv: redactArgv(spec, ['gbrain', ...argv]),
    exitCode: raw.exitCode,
    stdout: scrubOutput(raw.stdout),
    stderr: scrubOutput(raw.stderr),
    json,
  };
}

/**
 * Scan stdout for the LAST complete, balanced top-level JSON object/array that
 * `JSON.parse`s, with string/escape awareness so a bracket inside a string is
 * not a boundary. Returns null when no balanced value parses. Matches the
 * comment on `execOperation`: the first-brace slice it replaced threw on any
 * leading diagnostic line carrying a bracket (inv-051-b, Failure B).
 */
export function extractReceiptJson(stdout: string): unknown | null {
  let found = false;
  let last: unknown = null;
  for (let i = 0; i < stdout.length; i++) {
    const ch = stdout[i];
    if (ch !== '{' && ch !== '[') continue;
    const end = matchingBracket(stdout, i);
    if (end === -1) continue;
    try {
      last = JSON.parse(stdout.slice(i, end + 1));
      found = true;
    } catch {
      // Balanced but not JSON (e.g. a prose brace): keep scanning.
    }
    i = end;
  }
  return found ? last : null;
}

/** Index of the bracket matching `start`, or -1. String/escape aware. */
function matchingBracket(s: string, start: number): number {
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Throw unless the exit code is one the operation declares acceptable. */
export function assertOk(spec: OperationSpec, r: ExecResult): void {
  if (!spec.okExitCodes.includes(r.exitCode)) {
    throw new Error(
      `${spec.id} exited ${r.exitCode} (expected one of ${spec.okExitCodes.join(',')})\n` +
      `argv: ${r.argv.join(' ')}\nstderr: ${r.stderr}`,
    );
  }
}
