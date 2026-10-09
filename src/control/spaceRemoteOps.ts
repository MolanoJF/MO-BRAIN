/**
 * Give a Space a git remote, push it, take it away. Shared by the admin's
 * `/api/sources/:id/remote` and a member's own `/api/my/space/remote`: the
 * caller decides WHICH Space the requester may touch; this decides what
 * happens to it.
 *
 * The token is stored encrypted and handed to the ops sidecar's credential
 * helper. It is never written to the repo, the remote URL, the audit log or a
 * reply (`scrub`).
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from './db/client.ts';
import { callOps, gitClearRemote, gitSetRemote } from './opsClient.ts';
import { storeSecret } from './secrets.ts';
import { createGithubRepo } from './spaceRemote.ts';
import { resolveGithubToken } from './credentials.ts';

export type RemoteSpace = {
  id: string; sourceId: string; name: string; gitRemote: string | null;
  /** Decides which stored GitHub token applies; looked up by id when the caller did not select it. */
  ownerMembershipId?: string | null;
};
export type RemoteResult = { status: number; body: object };

async function audit(orgId: string, actor: string, action: string, target: string, after: unknown) {
  // S3c: `after` is a redacted summary — never a raw request body.
  await getDb().insert(schema.auditLog)
    .values({ id: randomUUID(), organizationId: orgId, actor, action, target, before: null, after: after as object });
}

/** Strip the token (and its URL-encoded form) from anything that may be shown. */
export function scrub(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join('***').split(encodeURIComponent(token)).join('***');
}

const remoteSecretName = (sourceId: string) => `space_remote_token_${sourceId}`;

/** `gbrain sources push` — scan-gated add, commit, pull, push. Never throws on a refusal. */
async function pushSpace(sourceId: string, branch: string | null, token: string) {
  const r = await callOps('sources.push', { id: sourceId, ...(branch ? { branch } : {}) },
    { json: true, timeoutMs: 300_000 });
  return {
    pushed: r.ok,
    exitCode: r.exitCode,
    // gbrain's own words: a blocked secret scan or a non-private remote reads here.
    ...(r.ok ? {} : { detail: scrub((r.stderr || r.stdout || '').trim(), token) }),
  };
}

export async function connectRemote(
  ctx: { userId: string; orgId: string }, space: RemoteSpace, body: any,
): Promise<RemoteResult> {
  const { userId, orgId } = ctx;
  // An explicit token is the legacy per-remote path. Without one, the stored
  // GitHub token for this Space's scope (Settings -> Credentials) is used.
  const explicit = typeof body?.token === 'string' ? body.token.trim() : '';
  let ownerMembershipId = space.ownerMembershipId;
  if (ownerMembershipId === undefined) {
    const [row] = await getDb().select({ owner: schema.spaces.ownerMembershipId }).from(schema.spaces)
      .where(eq(schema.spaces.id, space.id));
    ownerMembershipId = row?.owner ?? null;
  }
  const resolved = await resolveGithubToken({ orgId, space: { ownerMembershipId }, explicitToken: explicit });
  if (!resolved) return { status: 400, body: { error: 'github_token_missing' } };
  const { token } = resolved;

  let url: string;
  let created: string | null = null;
  if (body?.mode === 'github') {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const owner = typeof body.owner === 'string' ? body.owner.trim() : '';
    try {
      const repo = await createGithubRepo({
        token, name, ...(owner ? { owner } : {}), description: `Mo-brain Space: ${space.name}`,
      });
      url = repo.cloneUrl;
      created = repo.fullName;
    } catch (e: any) {
      return { status: 400, body: { error: scrub(e?.message ?? 'github_error', token) } };
    }
  } else if (body?.mode === 'url') {
    url = typeof body.url === 'string' ? body.url.trim() : '';
  } else {
    return { status: 400, body: { error: "mode must be 'url' or 'github'" } };
  }

  let set: { url: string; branch: string | null };
  try {
    set = await gitSetRemote({ sourceId: space.sourceId, url, token });
  } catch (e: any) {
    return { status: 400, body: { error: scrub(e?.message ?? 'remote_error', token), ...(created ? { created } : {}) } };
  }

  // A shared token is referenced, never copied into a per-remote secret.
  const secretName = resolved.secretName ?? remoteSecretName(space.sourceId);
  if (!resolved.secretName) await storeSecret(orgId, secretName, token);
  await getDb().update(schema.spaces)
    .set({ gitRemote: set.url, kind: 'remote-git', deployKeySecretId: secretName })
    .where(eq(schema.spaces.id, space.id));
  await audit(orgId, userId, 'source.remote.set', space.sourceId, { remote: set.url, mode: body.mode, created });

  const push = body?.push === false ? null : await pushSpace(space.sourceId, set.branch, token);
  if (push) await audit(orgId, userId, 'source.remote.push', space.sourceId, { pushed: push.pushed, exitCode: push.exitCode });
  return { status: 200, body: { ok: true, sourceId: space.sourceId, remote: set.url, created, push } };
}

export async function pushRemote(
  ctx: { userId: string; orgId: string }, space: RemoteSpace,
): Promise<RemoteResult> {
  if (!space.gitRemote) return { status: 409, body: { error: 'This Space has no git remote.' } };
  const push = await pushSpace(space.sourceId, null, '');
  await audit(ctx.orgId, ctx.userId, 'source.remote.push', space.sourceId, { pushed: push.pushed, exitCode: push.exitCode });
  return { status: 200, body: { ok: true, sourceId: space.sourceId, remote: space.gitRemote, push } };
}

export async function disconnectRemote(
  ctx: { userId: string; orgId: string }, space: RemoteSpace,
): Promise<RemoteResult> {
  await gitClearRemote(space.sourceId);
  await getDb().update(schema.spaces)
    .set({ gitRemote: null, kind: 'local-git', deployKeySecretId: null })
    .where(eq(schema.spaces.id, space.id));
  await audit(ctx.orgId, ctx.userId, 'source.remote.clear', space.sourceId, { remote: space.gitRemote });
  return { status: 200, body: { ok: true, sourceId: space.sourceId } };
}
