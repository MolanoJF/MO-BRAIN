import type { ExecResult, OperationSpec, ParamValues } from './types.ts';
import { buildArgv, redactArgv } from './argv.ts';
import { composeExec, scrubOutput } from '../docker/host.ts';

/**
 * Run one allowlisted gbrain operation. Returns a redacted argv so the caller
 * can log the result verbatim (S3c: never log a credential-bearing body).
 */
export async function execOperation<T = unknown>(
  spec: OperationSpec,
  values: ParamValues,
  opts: { json?: boolean; dryRun?: boolean; service?: string; timeoutMs?: number } = {},
): Promise<ExecResult<T>> {
  const argv = buildArgv(spec, values, { json: opts.json, dryRun: opts.dryRun });
  const raw = await composeExec(opts.service ?? 'gbrain-ops', ['gbrain', ...argv], {
    timeoutMs: opts.timeoutMs,
  });

  let json: T | null = null;
  if (opts.json) {
    // Parse the LAST balanced JSON value on stdout: gbrain may emit progress
    // lines before the machine-readable receipt.
    const trimmed = raw.stdout.trim();
    const start = Math.min(
      ...[trimmed.indexOf('{'), trimmed.indexOf('[')].filter((i) => i >= 0),
    );
    if (Number.isFinite(start) && start >= 0) {
      try { json = JSON.parse(trimmed.slice(start)) as T; } catch { json = null; }
    }
  }

  return {
    argv: redactArgv(spec, ['gbrain', ...argv]),
    exitCode: raw.exitCode,
    stdout: scrubOutput(raw.stdout),
    stderr: scrubOutput(raw.stderr),
    json,
  };
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
