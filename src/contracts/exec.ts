import type { ExecResult, OperationSpec, ParamValues } from './types.ts';
import { buildArgv, redactArgv } from './argv.ts';
import { extractReceiptJson } from './json.ts';
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

/** Throw unless the exit code is one the operation declares acceptable. */
export function assertOk(spec: OperationSpec, r: ExecResult): void {
  if (!spec.okExitCodes.includes(r.exitCode)) {
    throw new Error(
      `${spec.id} exited ${r.exitCode} (expected one of ${spec.okExitCodes.join(',')})\n` +
      `argv: ${r.argv.join(' ')}\nstderr: ${r.stderr}`,
    );
  }
}
