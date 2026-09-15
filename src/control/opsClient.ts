import type { OpsResponse } from '../ops/dispatch.ts';
import type { RepoStatus } from '../ops/git.ts';

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
  opts: { json?: boolean; dryRun?: boolean; timeoutMs?: number } = {},
): Promise<OpsResponse & { json: T | null }> {
  return post('/rpc', { op, params, json: opts.json, dryRun: opts.dryRun, timeoutMs: opts.timeoutMs },
    opts.timeoutMs);
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

export async function opsHealthy(): Promise<boolean> {
  try { return (await fetch(`${OPS_URL}/healthz`, { signal: AbortSignal.timeout(5_000) })).ok; }
  catch { return false; }
}
