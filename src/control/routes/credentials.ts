/**
 * Stored credentials: GitHub tokens (per member, per company) and the model
 * provider keys. Every reply is status only (configured / updatedAt / version);
 * a value is never returned, not even a fragment of one, and never audited.
 */
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { requireRole, ROLE_RANK, type Role } from '../rbac.ts';
import { callerFor } from '../zone.ts';
import { orgMode } from '../capabilities.ts';
import { rotateSecret, storeSecret } from '../secrets.ts';
import { patchFilePlaneConfig, gitSetRemote } from '../opsClient.ts';
import { validateGithubToken } from '../spaceRemote.ts';
import { scrub } from '../spaceRemoteOps.ts';
import {
  GITHUB_ORG_SECRET, githubMemberSecret, credentialStatus, type CredentialStatus,
} from '../credentials.ts';

export const ANTHROPIC_SECRET = 'anthropic_api_key';
export const OPENAI_SECRET = 'openai_api_key';

export type CredentialsResponse = {
  github: { member: CredentialStatus; org?: CredentialStatus };
  anthropic?: CredentialStatus;
  openai?: CredentialStatus;
};
export type RefreshResult = { ok: true; refreshed: string[]; failed: { sourceId: string; error: string }[] };

export type CredentialDeps = {
  validateToken?: (token: string) => Promise<{ login: string }>;
  gitSetRemote?: typeof gitSetRemote;
  patchFilePlaneConfig?: typeof patchFilePlaneConfig;
};

/** Printable, no whitespace: the same shape the ops credential file accepts. */
const TOKEN_RE = /^[\x21-\x7e]{1,512}$/;
const KEY_PREFIX = 'sk-ant-';

/** Accepts `sk-ant-api...` keys and `sk-ant-oat...` OAuth tokens (proxy.ts upstreamAuth tells them apart). */
export function anthropicKeyError(key: unknown): string | null {
  if (typeof key !== 'string' || !key) return 'key is required';
  if (!TOKEN_RE.test(key)) return 'key must be 1-512 printable characters with no whitespace';
  if (!key.startsWith(KEY_PREFIX)) return `key must start with ${KEY_PREFIX}`;
  return null;
}

async function audit(orgId: string, actor: string, action: string, target: string, after: unknown) {
  // Never the value: `after` is a redacted summary.
  await getDb().insert(schema.auditLog)
    .values({ id: randomUUID(), organizationId: orgId, actor, action, target, before: null, after: after as object });
}

const isAdmin = (role: Role) => ROLE_RANK[role] >= ROLE_RANK.admin;

/**
 * The company token applies in company mode, and also wherever an ownerless
 * (company) Space still exists: switching back to personal mode keeps those
 * Spaces, and their remotes resolve the org token (credentials.ts).
 */
async function usesOrgToken(orgId: string): Promise<boolean> {
  if ((await orgMode(orgId)) === 'company') return true;
  const [row] = await getDb().select({ id: schema.spaces.id }).from(schema.spaces)
    .where(and(eq(schema.spaces.organizationId, orgId), isNull(schema.spaces.ownerMembershipId))).limit(1);
  return !!row;
}

const fail = (message: string, status: number) => Object.assign(new Error(message), { status });

async function putSecret(orgId: string, name: string, value: string) {
  const existing = (await credentialStatus(orgId, [name]))[name];
  return existing?.configured ? rotateSecret(orgId, name, value) : storeSecret(orgId, name, value);
}

export function createCredentialRoutes(deps: CredentialDeps = {}): Hono {
  const validate = deps.validateToken ?? validateGithubToken;
  const setRemote = deps.gitSetRemote ?? gitSetRemote;
  const patchPlane = deps.patchFilePlaneConfig ?? patchFilePlaneConfig;
  const app = new Hono();

  const guard = (min: Role, handler: (c: any, ctx: { userId: string; orgId: string; role: Role; membershipId: string }) => Promise<Response>) =>
    async (c: any) => {
      let ctx;
      try { ctx = await requireRole(c, min); } catch (r) { return r as Response; }
      try { return await handler(c, await callerFor(ctx)); }
      catch (e: any) { return c.json({ error: e?.message ?? 'credentials_error' }, e?.status ?? 400); }
    };

  app.get('/credentials', guard('viewer', async (c, caller) => {
    const admin = isAdmin(caller.role);
    const company = admin && (await usesOrgToken(caller.orgId));
    const names = [githubMemberSecret(caller.membershipId)];
    if (company) names.push(GITHUB_ORG_SECRET);
    if (admin) names.push(ANTHROPIC_SECRET, OPENAI_SECRET);
    const s = await credentialStatus(caller.orgId, names);
    const body: CredentialsResponse = { github: { member: s[githubMemberSecret(caller.membershipId)]! } };
    if (company) body.github.org = s[GITHUB_ORG_SECRET]!;
    if (admin) { body.anthropic = s[ANTHROPIC_SECRET]!; body.openai = s[OPENAI_SECRET]!; }
    return c.json(body);
  }));

  /** Scope check shared by PUT and DELETE on /credentials/github. */
  async function scopeSecret(scope: unknown, caller: { orgId: string; role: Role; membershipId: string }) {
    if (scope === 'member') return githubMemberSecret(caller.membershipId);
    if (scope === 'org') {
      if (!isAdmin(caller.role)) throw fail('forbidden', 403);
      await requireCompany(caller.orgId);
      return GITHUB_ORG_SECRET;
    }
    throw fail("scope must be 'member' or 'org'", 400);
  }
  async function requireCompany(orgId: string) {
    if (!(await usesOrgToken(orgId))) throw fail('company_mode_required', 403);
  }

  app.put('/credentials/github', guard('viewer', async (c, caller) => {
    const body = await c.req.json().catch(() => ({}));
    const secretName = await scopeSecret(body?.scope, caller);
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!TOKEN_RE.test(token)) return c.json({ error: 'token must be 1-512 printable characters with no whitespace' }, 400);
    try { await validate(token); }
    catch (e: any) { return c.json({ error: scrub(e?.message ?? 'github_error', token) }, 400); }

    await putSecret(caller.orgId, secretName, token);
    await audit(caller.orgId, caller.userId, 'credentials.github.set', secretName, { scope: body.scope });

    // Re-point every existing remote in this scope so the ops credential files match.
    const owner = body.scope === 'member'
      ? eq(schema.spaces.ownerMembershipId, caller.membershipId)
      : isNull(schema.spaces.ownerMembershipId);
    const spaces = await getDb().select({
      id: schema.spaces.id, sourceId: schema.spaces.sourceId, gitRemote: schema.spaces.gitRemote,
    }).from(schema.spaces).where(and(
      eq(schema.spaces.organizationId, caller.orgId), isNotNull(schema.spaces.gitRemote), owner,
    ));
    const out: RefreshResult = { ok: true, refreshed: [], failed: [] };
    for (const s of spaces) {
      try {
        await setRemote({ sourceId: s.sourceId, url: s.gitRemote!, token });
        await getDb().update(schema.spaces).set({ deployKeySecretId: secretName }).where(eq(schema.spaces.id, s.id));
        out.refreshed.push(s.sourceId);
      } catch (e: any) {
        out.failed.push({ sourceId: s.sourceId, error: scrub(String(e?.message ?? 'remote_error'), token) });
      }
    }
    await audit(caller.orgId, caller.userId, 'credentials.github.refresh', secretName,
      { scope: body.scope, refreshed: out.refreshed, failed: out.failed.map((f) => f.sourceId) });
    return c.json(out);
  }));

  /**
   * secrets.ts has no delete (rotation only adds versions), so this removes the
   * scope's rows directly. Existing remotes keep working: their ops credential
   * files are untouched until the next connect or token save.
   */
  app.delete('/credentials/github', guard('viewer', async (c, caller) => {
    const scope = c.req.query('scope') ?? (await c.req.json().catch(() => ({})))?.scope;
    const secretName = await scopeSecret(scope, caller);
    await getDb().delete(schema.secrets)
      .where(and(eq(schema.secrets.organizationId, caller.orgId), eq(schema.secrets.name, secretName)));
    await audit(caller.orgId, caller.userId, 'credentials.github.delete', secretName, { scope });
    return c.json({ ok: true });
  }));

  app.put('/credentials/anthropic', guard('admin', async (c, caller) => {
    const key = (await c.req.json().catch(() => ({})))?.key;
    const bad = anthropicKeyError(key);
    if (bad) return c.json({ error: bad }, 400);
    // A new version is live on the next gateway call (readSecret takes the latest).
    const { version } = await putSecret(caller.orgId, ANTHROPIC_SECRET, key);
    await audit(caller.orgId, caller.userId, 'credentials.anthropic.set', ANTHROPIC_SECRET, { version });
    return c.json({ ok: true, version });
  }));

  app.put('/credentials/openai', guard('admin', async (c, caller) => {
    const key = (await c.req.json().catch(() => ({})))?.key;
    if (typeof key !== 'string' || !TOKEN_RE.test(key)) {
      return c.json({ error: 'key must be 1-512 printable characters with no whitespace' }, 400);
    }
    const { version } = await putSecret(caller.orgId, OPENAI_SECRET, key);
    await patchPlane({ [OPENAI_SECRET]: key });
    await audit(caller.orgId, caller.userId, 'credentials.openai.set', OPENAI_SECRET, { version });
    return c.json({ ok: true, version });
  }));

  return app;
}

export const credentialRoutes = createCredentialRoutes();
