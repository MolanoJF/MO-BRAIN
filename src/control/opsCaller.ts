/**
 * How a HOST-SIDE process reaches gbrain-ops.
 *
 * The control plane inside compose does NOT use this — it uses opsClient.ts
 * directly, because `gbrain-ops:3140` resolves in that network and a
 * `compose exec` relay from inside a container would be absurd. This module
 * exists for scripts/backup.ts, scripts/restore.ts and scripts/upgrade.ts,
 * which run on the host, where S2 means no ops port is published in
 * production and a bare fetch to OPS_RPC_URL cannot work.
 *
 * It is an INTERFACE that callers receive, not a module they import for its
 * side effects (Slice 4 hazard (a)): a file handed its caller cannot be
 * answered by a sibling test's process-wide `mock.module`.
 */
import { callOps, auditTail as httpAuditTail } from './opsClient.ts';

export type OpsCaller = {
  readonly kind: 'http' | 'relay' | 'stub';
  auditTail(lines: number): Promise<string[]>;
  supervisorStatus(): Promise<{ running: boolean; workers: unknown[] } | null>;
};

/** The relay's argv, exported so a unit test can assert its shape without a daemon. */
export function relayArgv(compose: readonly string[]): string[] {
  return [...compose, 'exec', '-T', 'gbrain-ops', 'bun', '-e', RELAY_PROGRAM];
}

const RELAY_PROGRAM = `
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const req = JSON.parse(input);
  const base = process.env.OPS_RPC_URL ?? 'http://127.0.0.1:3140';
  const res = await fetch(base + req.path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.OPS_RPC_TOKEN },
    body: JSON.stringify(req.body),
  });
  process.stdout.write(await res.text());
`;

/** Feed text to a command's stdin — argv array only; the text never reaches
 *  argv, so a credential in it is never a credential in `ps` (S3c). */
async function feedString(argv: string[], input: string, timeoutMs = 60_000) {
  const p = Bun.spawn(argv, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    await p.stdin.write(input);
    await p.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timer); }
}

/** Moved verbatim from quiesce.ts:196-206 — `httpAuditTail` plus a
 *  `callOps('jobs.supervisorStatus', {}, { json: true, timeoutMs: 30_000 })`
 *  mapped to `{ running: !!json.running, workers: json.workers ?? [] }` —
 *  with `kind: 'http'` added. Works only where ops publishes a reachable
 *  port: the dev override, Gate A, and test/e2e. Never production (S2). */
export function httpOpsCaller(): OpsCaller {
  return {
    kind: 'http',
    auditTail: (lines) => httpAuditTail(lines),
    async supervisorStatus() {
      const r = await callOps<{ running?: boolean; workers?: unknown[] }>(
        'jobs.supervisorStatus', {}, { json: true, timeoutMs: 30_000 },
      );
      return r.json ? { running: !!r.json.running, workers: r.json.workers ?? [] } : null;
    },
  };
}

/** Moved verbatim from quiesce.ts:214-240, with `kind: 'relay'` added and the
 *  inline program replaced by RELAY_PROGRAM above so `relayArgv` and the
 *  caller cannot drift apart. Production-safe: it reaches ops through
 *  `compose exec -T gbrain-ops bun -e`, the same relay scripts/restore.ts
 *  already uses, so it needs no published port. */
export function relayOpsCaller(compose: readonly string[]): OpsCaller {
  const relay = async <T>(path: string, body: unknown): Promise<T> => {
    const r = await feedString(relayArgv(compose), JSON.stringify({ path, body }));
    if (r.exitCode !== 0) throw new Error(`ops relay ${path} failed: ${r.stderr}`);
    return JSON.parse(r.stdout) as T;
  };
  return {
    kind: 'relay',
    auditTail: async (lines) => {
      const r = await relay<{ lines?: string[] }>('/fileplane/audit-tail', { lines });
      return Array.isArray(r.lines) ? r.lines : [];
    },
    supervisorStatus: async () => {
      const r = await relay<{ json: { running?: boolean; workers?: unknown[] } | null }>(
        '/rpc', { op: 'jobs.supervisorStatus', params: {}, json: true, timeoutMs: 30_000 },
      );
      return r.json ? { running: !!r.json.running, workers: r.json.workers ?? [] } : null;
    },
  };
}

export type SelectOptions = { probe?: () => Promise<boolean> };

/**
 * D6's other half: choosing the lane is a MEASUREMENT, not an assumption.
 * The probe is a 2s GET of ops' own /healthz over OPS_RPC_URL. It answers
 * "is there a published port here", which is true in dev and false in
 * production — and a caller that guesses wrong silently is exactly the bug
 * scripts/backup.ts shipped.
 */
export async function defaultOpsCaller(
  compose: readonly string[], opts: SelectOptions = {},
): Promise<OpsCaller> {
  const probe = opts.probe ?? (async () => {
    const url = process.env.OPS_RPC_URL ?? 'http://gbrain-ops:3140';
    try { return (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2_000) })).ok; }
    catch { return false; }
  });
  return (await probe()) ? httpOpsCaller() : relayOpsCaller(compose);
}
