// test/helpers/zoneFixture.ts
import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

/** Imported lazily so the test file's `installOpsMock()` runs first. */
async function deps() {
  const { default: app } = await import('../../src/control/app.ts');
  const db = await import('../../src/control/db/client.ts');
  const { bootstrapFirstAdmin } = await import('../../src/control/bootstrap.ts');
  return { app, ...db, bootstrapFirstAdmin };
}

export const PASS = 'a-long-enough-password';

export type Actor = {
  email: string; userId: string; membershipId: string; cookie: string;
  privateSpaceId: string; privateSourceId: string; privateConnectionId: string;
};

export type ZoneFixture = {
  orgId: string;
  owner: Actor; admin: Actor; alice: Actor; bob: Actor;
  companySpaceId: string; companySourceId: string;
};

export async function hit(method: string, path: string, cookie?: string, body?: unknown): Promise<Response> {
  const { app } = await deps();
  const headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.40' };
  if (cookie) headers.cookie = cookie;
  const hasBody = body !== undefined || (method !== 'GET' && method !== 'DELETE');
  if (hasBody) headers['content-type'] = 'application/json';
  return app.request(path, { method, headers, body: hasBody ? JSON.stringify(body ?? {}) : undefined });
}

async function signIn(email: string): Promise<string> {
  const res = await hit('POST', '/api/auth/sign-in/email', undefined, { email, password: PASS });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie') ?? '';
}

async function addMember(orgId: string, email: string, role: 'admin' | 'member'): Promise<{ userId: string; membershipId: string }> {
  const { getDb, schema } = await deps();
  const res = await hit('POST', '/api/auth/sign-up/email', undefined, { email, password: PASS, name: email });
  expect(res.status).toBe(200);
  const [u] = await getDb().select().from(schema.users).where(sql`${schema.users.email} = ${email}`);
  const membershipId = randomUUID();
  await getDb().insert(schema.memberships).values({ id: membershipId, userId: u!.id, organizationId: orgId, role });
  return { userId: u!.id, membershipId };
}

async function withPrivateSpace(email: string, userId: string, membershipId: string): Promise<Actor> {
  const cookie = await signIn(email);
  const res = await hit('POST', '/api/private-space', cookie, {});
  expect(res.status).toBe(200);
  const body = await res.json() as { spaceId: string; sourceId: string; connectionId: string };
  return {
    email, userId, membershipId, cookie,
    privateSpaceId: body.spaceId, privateSourceId: body.sourceId, privateConnectionId: body.connectionId,
  };
}

/** Wipes every org-scoped table, then builds: owner, admin, alice, bob (members),
 *  each with a provisioned private Space, plus one company Space. */
export async function buildZoneFixture(): Promise<ZoneFixture> {
  const { getDb, schema, runMigrations, bootstrapFirstAdmin } = await deps();
  await runMigrations();
  await getDb().execute(sql`TRUNCATE users, organizations, runner_presence RESTART IDENTITY CASCADE`);

  const boot = await bootstrapFirstAdmin('z-owner@example.test', PASS, 'ZoneCo');
  const orgId = boot.orgId;
  const [ownerM] = await getDb().select().from(schema.memberships)
    .where(sql`${schema.memberships.userId} = ${boot.userId}`);

  const owner = await withPrivateSpace('z-owner@example.test', boot.userId, ownerM!.id);
  const a = await addMember(orgId, 'z-admin@example.test', 'admin');
  const admin = await withPrivateSpace('z-admin@example.test', a.userId, a.membershipId);
  const al = await addMember(orgId, 'z-alice@example.test', 'member');
  const alice = await withPrivateSpace('z-alice@example.test', al.userId, al.membershipId);
  const b = await addMember(orgId, 'z-bob@example.test', 'member');
  const bob = await withPrivateSpace('z-bob@example.test', b.userId, b.membershipId);

  const companySpaceId = randomUUID();
  const companySourceId = 'company-kb';
  await getDb().insert(schema.spaces).values({
    id: companySpaceId, organizationId: orgId, sourceId: companySourceId, name: 'Company KB',
    kind: 'local-git', localPath: `/srv/brain-repos/${companySourceId}`, ownerMembershipId: null,
  });

  return { orgId, owner, admin, alice, bob, companySpaceId, companySourceId };
}

/** A gbrain_command schedule — satisfies shape_matches_job_type and shape_matches_kind. */
export async function insertCommandSchedule(orgId: string, connectionId: string | null, name: string): Promise<string> {
  const { getDb, schema } = await deps();
  const id = randomUUID();
  await getDb().insert(schema.schedules).values({
    id, organizationId: orgId, connectionId, name, operation: 'sync',
    kind: 'interval', intervalSeconds: 3600, anchorAt: new Date(), createdBy: 'test',
  });
  return id;
}

/** An agent_prompt schedule + one schedule_run + its agent_run. Returns ids. */
export async function insertAgentRun(
  orgId: string, connectionId: string | null, scheduleName: string, costUsd = '0.25',
): Promise<{ scheduleId: string; runId: string }> {
  const { getDb, schema } = await deps();
  const scheduleId = randomUUID();
  await getDb().insert(schema.schedules).values({
    id: scheduleId, organizationId: orgId, connectionId, name: scheduleName,
    jobType: 'agent_prompt', operation: null,
    agentPrompt: 'run the digest skill', agentModel: 'claude-sonnet-5', agentMaxTokens: 4096,
    agentBudgetUsd: '1.00', agentHarnessVersion: '2.1.274',
    kind: 'interval', intervalSeconds: 3600, anchorAt: new Date(), createdBy: 'test',
  });
  const runId = randomUUID();
  await getDb().insert(schema.scheduleRuns).values({
    id: runId, scheduleId, organizationId: orgId, slot: `slot-${runId.slice(0, 8)}`,
    fireAt: new Date(), state: 'succeeded', startedAt: new Date(), finishedAt: new Date(),
  });
  await getDb().insert(schema.agentRuns).values({
    runId, organizationId: orgId, connectionId, model: 'claude-sonnet-5',
    harnessVersion: '2.1.274', budgetUsd: '1.00', costUsd,
  });
  return { scheduleId, runId };
}
