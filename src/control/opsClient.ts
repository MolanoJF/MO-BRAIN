import type { OpsResponse } from '../ops/dispatch.ts';
import type { GitRange, RepoStatus, RevertOutcome, RevertRequest } from '../ops/git.ts';

export type { RepoStatus };

const OPS_URL = process.env.OPS_RPC_URL ?? 'http://gbrain-ops:3140';
const TOKEN = process.env.OPS_RPC_TOKEN ?? '';

async function post<T>(path: string, body: unknown, timeoutMs = 600_000): Promise<T> {
  const res = await fetch(`${OPS_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await res.json();
  if (!res.ok) throw new Error((payload as { error?: string }).error ?? `ops rpc ${res.status}`);
  return payload as T;
}

/**
 * The ONLY way the control plane reaches gbrain. It holds no brain
 * DATABASE_URL and mounts GBRAIN_HOME read-only (S2), so every privileged
 * action crosses this boundary.
 */
export async function callOps<T = unknown>(
  op: string,
  params: Record<string, unknown> = {},
  opts: { json?: boolean; dryRun?: boolean; timeoutMs?: number; runId?: string } = {},
): Promise<OpsResponse & { json: T | null }> {
  return post('/rpc', {
    op, params, json: opts.json, dryRun: opts.dryRun, timeoutMs: opts.timeoutMs, runId: opts.runId,
  }, opts.timeoutMs);
}

/** Write + commit a run report into a Space repo. Ops holds the repos; we do not (S2). */
export async function writeReport(args: {
  sourceId: string; job: string; stamp: string; reportBody: string;
  actor: { name: string; email: string };
}): Promise<{ relPath: string; committed: boolean; sha: string | null }> {
  return post('/fileplane/report', args, 120_000);
}

/** Overlap policy 'kill_previous'. Idempotent: an already-finished run reports false. */
export async function cancelRun(runId: string): Promise<{ cancelled: boolean }> {
  return post('/rpc/cancel', { runId }, 15_000);
}

export async function patchFilePlaneConfig(patch: Record<string, unknown>): Promise<void> {
  await post('/fileplane/config', { patch }, 60_000);
}

/** Commit AS the member. Caller must pass membership→user identity, not a request-body actor. */
export async function commitAsMember(
  sourceId: string,
  actor: { name: string; email: string },
  message: string,
): Promise<{ committed: boolean; sha: string | null }> {
  return post('/git/commit', { sourceId, actor, message }, 60_000);
}

/** Stale-lock and uncommitted/unpushed drift from gbrain-ops (S2). */
export async function inspectRepos(): Promise<RepoStatus[]> {
  const payload = await post<{ repos?: RepoStatus[] }>('/git/inspect', {}, 30_000);
  return Array.isArray(payload.repos) ? payload.repos : [];
}

/**
 * D10 — the read-only brain diff for one Space: `git log` plus
 * `git diff --name-status` over `<before>..<after>`. A ref ops cannot resolve
 * comes back as a thrown `unknown ref: …`, never an empty range.
 */
export async function gitRange(sourceId: string, before: string, after: string): Promise<GitRange> {
  return post('/git/range', { sourceId, before, after }, 60_000);
}

/**
 * D10 steps 1+2 — the range comes back as ONE new commit signed by `actor`.
 * `nothing_to_revert` and `conflict` are RESULTS, not thrown errors: they are
 * refusals the console renders as choices, and only the latter's `detail` is
 * git's own words. An invalid `sourceId` or an unresolvable ref throws.
 *
 * The revert is one locked sequence inside ops; a range can be large, so this
 * budgets more than a single git read.
 */
export async function gitRevertRange(req: RevertRequest): Promise<RevertOutcome> {
  return post('/git/revert-range', req, 120_000);
}

export async function putSchemaPack(name: string, yaml: string): Promise<void> {
  await post('/fileplane/schema-pack', { name, yaml }, 60_000);
}

export async function seedSpace(sourceId: string): Promise<void> {
  await post('/fileplane/seed-space', { sourceId }, 60_000);
}

/** Clear worker cold-start schema so wizard init can choose embedding dims. */
export async function resetBrainSchema(): Promise<void> {
  await post('/fileplane/reset-brain-schema', {}, 120_000);
}

/**
 * Read-then-delete one ops-side --credentials-out file. The secret crosses
 * the RPC once; the control plane must not log the body (S3c).
 */
export async function takeGrantCredentials(path: string): Promise<unknown> {
  const payload = await post<{ credentials?: unknown }>('/fileplane/take-grant-credentials', { path }, 30_000);
  return payload.credentials;
}

/**
 * F7: delete the private credential journal `mcp grant` retained for a client we
 * have just revoked. Revoking the client does not remove the journal, so this is
 * the step that stops a dead secret from sitting on the file plane. The path is
 * computed ops-side from the client id — no path crosses the RPC.
 */
export async function deleteCredentialJournal(clientId: string): Promise<{ deleted: boolean }> {
  return post('/fileplane/delete-credential-journal', { clientId }, 30_000);
}

/** Tail the supervisor's own audit log (Task 6) — the only way to tell a
 *  clean SIGTERM exit from a MAX_CRASHES exit inside the same drain window
 *  (U9). A dedicated route, not an allowlisted operation: it takes no argv,
 *  just a line count, and the path it reads is fixed server-side. */
export async function auditTail(lines = 50): Promise<string[]> {
  const payload = await post<{ lines?: string[] }>('/fileplane/audit-tail', { lines }, 30_000);
  return Array.isArray(payload.lines) ? payload.lines : [];
}

export async function opsHealthy(): Promise<boolean> {
  try { return (await fetch(`${OPS_URL}/healthz`, { signal: AbortSignal.timeout(5_000) })).ok; }
  catch { return false; }
}
