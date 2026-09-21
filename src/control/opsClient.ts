import type { OpsResponse } from '../ops/dispatch.ts';
import type {
  GitRange, ReadFileResult, RepoStatus, RepoTree, RevertOutcome, RevertRequest, TreeProbe,
  WriteFileOutcome, WriteFileRequest,
} from '../ops/git.ts';
import type { BrainUsage } from '../ops/usage.ts';

export type { ReadFileResult, RepoStatus, RepoTree, WriteFileOutcome, WriteFileRequest };

/**
 * Resolve the ops endpoint at CALL time, not at module load.
 *
 * Binding it at load was a process-wide hazard: `bun test` runs several files
 * in one process, and a sibling file that mutates `process.env.OPS_RPC_URL`
 * (scripts/connection-e2e.ts points it at an unreachable `:1` to prove the
 * audit-before-delete path survives an ops failure) permanently decided the URL
 * for every later file that lazily imported this module. Inside compose the
 * variable is constant, so call-time resolution changes nothing there.
 */
function opsUrl(): string {
  return process.env.OPS_RPC_URL ?? 'http://gbrain-ops:3140';
}

function opsToken(): string {
  return process.env.OPS_RPC_TOKEN ?? '';
}

async function post<T>(path: string, body: unknown, timeoutMs = 600_000): Promise<T> {
  const res = await fetch(`${opsUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${opsToken()}` },
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
 *
 * `packOverride` is the ONE env override the RPC accepts (Task 1): a single
 * validated pack name injected as `GBRAIN_SCHEMA_PACK` for one spawn, so a
 * pack can be inspected without activating it. See src/ops/server.ts.
 */
export async function callOps<T = unknown>(
  op: string,
  params: Record<string, unknown> = {},
  opts: {
    json?: boolean; dryRun?: boolean; timeoutMs?: number; runId?: string; packOverride?: string;
  } = {},
): Promise<OpsResponse & { json: T | null }> {
  return post('/rpc', {
    op, params, json: opts.json, dryRun: opts.dryRun, timeoutMs: opts.timeoutMs, runId: opts.runId,
    packOverride: opts.packOverride,
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
 * F16 — the revert's purge guard. Read-only: what the write Space's WORKING
 * TREE holds at each path, tracked or not. Ops REFUSES (throws) rather than
 * answering `onDisk: false` when the Space, the repo or a path cannot be read,
 * so a caller must never treat a thrown call as "the file is gone" — but it can
 * treat a returned `onDisk: false` as the filesystem's own word.
 */
export async function gitPathExists(sourceId: string, paths: readonly string[]): Promise<TreeProbe> {
  return post('/git/path-exists', { sourceId, paths }, 60_000);
}

/** S1 — the Space repo's working tree, for the Files browser. Read-only. */
export async function gitTree(sourceId: string): Promise<RepoTree> {
  return post('/git/tree', { sourceId }, 30_000);
}

/** S1 — one file's text plus the git blob sha the editor must send back on save. */
export async function gitReadFile(sourceId: string, path: string): Promise<ReadFileResult> {
  return post('/git/read-file', { sourceId, path }, 30_000);
}

/** S2 — write one file and commit it as the acting member. Read-compare-write-commit under one repo lock. */
export async function gitWriteFile(req: WriteFileRequest): Promise<WriteFileOutcome> {
  return post('/git/write-file', req, 60_000);
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

/**
 * D8: gbrain's own spend ledger, as the ops-side `get_usage` read maps it.
 * Read-only; the mint/revoke lifecycle stays on the ops side of the boundary.
 */
export async function brainUsage(days: number): Promise<BrainUsage> {
  return post('/usage', { days }, 60_000);
}

export async function opsHealthy(): Promise<boolean> {
  try { return (await fetch(`${opsUrl()}/healthz`, { signal: AbortSignal.timeout(5_000) })).ok; }
  catch { return false; }
}
