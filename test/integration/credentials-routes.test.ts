/**
 * Stored credentials: status never carries a value, org scope is admin + company
 * (mode, or a leftover company Space) only, a token save re-points existing remotes (partial failure reported and
 * scrubbed), and connectRemote resolves the stored token.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { installOpsMock } from '../helpers/opsMock.ts';

installOpsMock();

const { Hono } = await import('hono');
const { eq, and } = await import('drizzle-orm');
const { getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { buildZoneFixture } = await import('../helpers/zoneFixture.ts');
type ZoneFixture = Awaited<ReturnType<typeof buildZoneFixture>>;
const { createCredentialRoutes } = await import('../../src/control/routes/credentials.ts');
const { resolveGithubToken, GITHUB_ORG_SECRET, githubMemberSecret } = await import('../../src/control/credentials.ts');
const { connectRemote } = await import('../../src/control/spaceRemoteOps.ts');
const { storeSecret } = await import('../../src/control/secrets.ts');

pinDb();

const MEMBER_TOKEN = 'ghp_MEMBER_TOKEN_not_real_0123456789';
const ORG_TOKEN = 'ghp_ORG_TOKEN_not_real_0123456789';
const ANT_KEY = 'sk-ant-api03-not-a-real-secret-abcdef';

let fx: ZoneFixture;
const setCalls: { sourceId: string; url: string; token: string }[] = [];
const patched: Record<string, string>[] = [];
let failFor = new Set<string>();

const app = new Hono().route('/api', createCredentialRoutes({
  validateToken: async (t) => { if (t === 'bad') throw new Error('GitHub rejected this token.'); return { login: 'x' }; },
  gitSetRemote: async (r) => {
    setCalls.push(r);
    if (failFor.has(r.sourceId)) throw new Error(`boom with ${r.token} inside`);
    return { url: r.url, branch: 'main' };
  },
  patchFilePlaneConfig: async (p) => { patched.push(p as Record<string, string>); },
}));

const call = (method: string, path: string, cookie: string, body?: unknown) => app.request(`/api${path}`, {
  method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});

beforeAll(async () => { fx = await buildZoneFixture(); }, 120_000);
afterAll(async () => { await closeDb(); });
beforeEach(() => { setCalls.length = 0; patched.length = 0; failFor = new Set(); });

describe('resolveGithubToken precedence', () => {
  test('explicit > private owner token > org token > null', async () => {
    const orgId = fx.orgId;
    await storeSecret(orgId, githubMemberSecret(fx.alice.membershipId), MEMBER_TOKEN);
    await storeSecret(orgId, GITHUB_ORG_SECRET, ORG_TOKEN);
    const priv = { ownerMembershipId: fx.alice.membershipId };
    expect((await resolveGithubToken({ orgId, space: priv, explicitToken: 'ex' }))?.token).toBe('ex');
    expect((await resolveGithubToken({ orgId, space: priv }))?.token).toBe(MEMBER_TOKEN);
    expect((await resolveGithubToken({ orgId, space: { ownerMembershipId: null } }))?.token).toBe(ORG_TOKEN);
    expect(await resolveGithubToken({ orgId, space: { ownerMembershipId: fx.bob.membershipId } })).toBeNull();
  });
});

describe('GET /credentials', () => {
  test('status only, org entries only for admins, no value anywhere', async () => {
    await storeSecret(fx.orgId, 'anthropic_api_key', ANT_KEY);
    const m = await call('GET', '/credentials', fx.alice.cookie);
    const mText = await m.text();
    expect(m.status).toBe(200);
    const mj = JSON.parse(mText);
    expect(mj.github.member.configured).toBe(true);
    expect(mj.github.org).toBeUndefined();
    expect(mj.anthropic).toBeUndefined();
    for (const secret of [MEMBER_TOKEN, ORG_TOKEN, ANT_KEY]) expect(mText).not.toContain(secret);

    const a = await call('GET', '/credentials', fx.admin.cookie);
    const aText = await a.text();
    const aj = JSON.parse(aText);
    expect(aj.github.org.configured).toBe(true);
    expect(aj.github.member.configured).toBe(false);
    expect(aj.anthropic).toMatchObject({ configured: true, version: 1 });
    expect(aj.openai.configured).toBe(false);
    for (const secret of [MEMBER_TOKEN, ORG_TOKEN, ANT_KEY, 'sk-ant']) expect(aText).not.toContain(secret);
  });
});

describe('PUT /credentials/github', () => {
  test('org scope: a member is forbidden; personal mode is refused', async () => {
    const r = await call('PUT', '/credentials/github', fx.alice.cookie, { scope: 'org', token: ORG_TOKEN });
    expect(r.status).toBe(403);
    expect((await r.json() as any).error).toBe('forbidden');

    // Personal mode with no company Space left: there is nothing an org token could serve.
    await getDb().update(schema.organizations).set({ brainMode: 'personal' }).where(eq(schema.organizations.id, fx.orgId));
    const [companySpace] = await getDb().select().from(schema.spaces).where(eq(schema.spaces.id, fx.companySpaceId));
    await getDb().delete(schema.spaces).where(eq(schema.spaces.id, fx.companySpaceId));
    const p = await call('PUT', '/credentials/github', fx.admin.cookie, { scope: 'org', token: ORG_TOKEN });
    expect(p.status).toBe(403);
    expect((await p.json() as any).error).toBe('company_mode_required');
    expect((await (await call('GET', '/credentials', fx.admin.cookie)).json() as any).github.org).toBeUndefined();

    // Back to personal with a company Space still present (a company -> personal switch keeps it):
    // its remote resolves the org token, so the admin can still see and set it.
    await getDb().insert(schema.spaces).values(companySpace!);
    expect((await (await call('GET', '/credentials', fx.admin.cookie)).json() as any).github.org).toBeDefined();
    await getDb().update(schema.organizations).set({ brainMode: 'company' }).where(eq(schema.organizations.id, fx.orgId));
  });

  test('a rejected token stores nothing', async () => {
    const r = await call('PUT', '/credentials/github', fx.bob.cookie, { scope: 'member', token: 'bad' });
    expect(r.status).toBe(400);
    const g = await (await call('GET', '/credentials', fx.bob.cookie)).json() as any;
    expect(g.github.member.configured).toBe(false);
  });

  test('org save re-points company remotes only; partial failure is scrubbed', async () => {
    const db = getDb();
    const mk = async (sourceId: string, owner: string | null) => {
      const { randomUUID } = await import('node:crypto');
      await db.insert(schema.spaces).values({
        id: randomUUID(), organizationId: fx.orgId, sourceId, name: sourceId, kind: 'remote-git',
        gitRemote: `https://github.com/o/${sourceId}.git`, ownerMembershipId: owner,
      });
    };
    await mk('co-ok', null); await mk('co-bad', null);
    await db.update(schema.spaces).set({ gitRemote: 'https://github.com/o/priv.git' })
      .where(eq(schema.spaces.id, fx.admin.privateSpaceId));
    failFor = new Set(['co-bad']);

    const r = await call('PUT', '/credentials/github', fx.admin.cookie, { scope: 'org', token: ORG_TOKEN });
    const text = await r.text();
    expect(r.status).toBe(200);
    const j = JSON.parse(text);
    expect(j.refreshed).toEqual(['co-ok']);
    expect(j.failed).toEqual([{ sourceId: 'co-bad', error: 'boom with *** inside' }]);
    expect(text).not.toContain(ORG_TOKEN);
    expect(setCalls.map((c) => c.sourceId).sort()).toEqual(['co-bad', 'co-ok']);
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.organizationId, fx.orgId));
    expect(JSON.stringify(audits)).not.toContain(ORG_TOKEN);
  });

  test('member scope re-points only the caller private Space; DELETE removes the secret', async () => {
    const r = await call('PUT', '/credentials/github', fx.admin.cookie, { scope: 'member', token: MEMBER_TOKEN });
    expect((await r.json() as any).refreshed).toEqual([fx.admin.privateSourceId]);
    const d = await call('DELETE', '/credentials/github?scope=member', fx.admin.cookie);
    expect(d.status).toBe(200);
    const g = await (await call('GET', '/credentials', fx.admin.cookie)).json() as any;
    expect(g.github.member.configured).toBe(false);
  });
});

describe('provider keys', () => {
  test('anthropic: admin only, shape checked, new version', async () => {
    expect((await call('PUT', '/credentials/anthropic', fx.alice.cookie, { key: ANT_KEY })).status).toBe(403);
    expect((await call('PUT', '/credentials/anthropic', fx.admin.cookie, { key: 'has space' })).status).toBe(400);
    expect((await call('PUT', '/credentials/anthropic', fx.admin.cookie, { key: 'nope' })).status).toBe(400);
    const ok = await call('PUT', '/credentials/anthropic', fx.admin.cookie, { key: 'sk-ant-oat01-abc' });
    expect(await ok.json()).toEqual({ ok: true, version: 2 });
  });

  test('openai: stores, patches the file plane, does not advance the lifecycle', async () => {
    const [before] = await getDb().select().from(schema.brains).where(eq(schema.brains.organizationId, fx.orgId));
    const r = await call('PUT', '/credentials/openai', fx.admin.cookie, { key: 'sk-openai-test' });
    expect(r.status).toBe(200);
    expect(patched).toEqual([{ openai_api_key: 'sk-openai-test' }]);
    const [after] = await getDb().select().from(schema.brains).where(eq(schema.brains.organizationId, fx.orgId));
    expect(after?.lifecycle).toBe(before?.lifecycle);
  });
});

describe('connectRemote token resolution', () => {
  test('no body token and none stored -> github_token_missing', async () => {
    const space = { id: fx.bob.privateSpaceId, sourceId: fx.bob.privateSourceId, name: 'b', gitRemote: null };
    const r = await connectRemote({ userId: fx.bob.userId, orgId: fx.orgId }, space, { mode: 'url', url: 'https://github.com/o/r.git' });
    expect(r).toEqual({ status: 400, body: { error: 'github_token_missing' } });
  });

  test('uses the stored shared token without copying it into a per-remote secret', async () => {
    const space = { id: fx.alice.privateSpaceId, sourceId: fx.alice.privateSourceId, name: 'a', gitRemote: null };
    const r = await connectRemote({ userId: fx.alice.userId, orgId: fx.orgId }, space,
      { mode: 'url', url: 'https://github.com/o/r.git', push: false });
    expect(r.status).toBe(200);
    const [row] = await getDb().select().from(schema.spaces).where(eq(schema.spaces.id, space.id));
    expect(row?.deployKeySecretId).toBe(githubMemberSecret(fx.alice.membershipId));
    const copies = await getDb().select().from(schema.secrets).where(and(
      eq(schema.secrets.organizationId, fx.orgId), eq(schema.secrets.name, `space_remote_token_${space.sourceId}`)));
    expect(copies).toHaveLength(0);
  });
});
