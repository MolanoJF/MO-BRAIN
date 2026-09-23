# Zones 1 — Privacy and Grants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "personal" actually private across every control-plane route, replace connection-derived access with explicit `space_grants`, and let a member choose which company Spaces their own agent may read.

**Architecture:** One module, `src/control/zone.ts`, owns the zone rule (a Space's zone is its owner; everything inherits its write Space's zone) as a pure function plus its SQL twin. Every list/detail route that returns schedules, runs, alerts, connections or sources filters through it and answers 404 for an invisible row. A new `space_grants` table is the single source of company-Space access; `spaceAccess.ts` reads it instead of connections, and admin connection creation writes grants so existing flows keep working.

**Tech Stack:** Bun 1.3, Hono, Drizzle ORM (Postgres), Better Auth, React 19 console, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-09-22-personal-and-company-zones-design.md` (§1, §4, §5.1)

## Global Constraints

- An object in another member's personal zone answers **404**, never 403, for every role including `owner`/`admin`.
- An object whose write Space cannot be resolved (null connection, deleted connection) is company zone and **admin-only**.
- Personal Spaces are never granted; `space_grants` rows reference company Spaces only.
- Admins see personal spend only as one row per member (`personal:<membershipId>`), never schedule names.
- Audit `after` payloads are redacted summaries, never raw request bodies (S3c).
- Migrations are hand-written SQL in `src/control/db/migrations/` plus a `meta/_journal.json` entry; no drizzle snapshot is generated (matches 0009/0010).
- Integration tests need the control Postgres at `CONTROL_DATABASE_URL` (default `postgres://gbrain:ci-not-a-real-secret@localhost:5432/control`) and are run one file per process: `bun test test/integration/<file>.test.ts`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `src/control/zone.ts` (new) | Zone type, `canSeeZone` (pure), `visibleZoneSql` (SQL twin), `callerFor` |
| `src/control/grants.ts` (new) | `grantsFor`, `upsertGrant`, `grantsForConnection`, `removeGrant` |
| `src/control/routes/grants.ts` (new) | Admin `GET/PUT/DELETE /api/grants` |
| `src/control/routes/myConnection.ts` (new) | `GET/PUT /api/my/connection` |
| `src/control/db/migrations/0011_space_grants.sql` (new) | Table + backfill |
| `src/control/db/schema.ts` | `spaceGrants` table |
| `src/control/spaceAccess.ts` | `accessFromGrants` replaces `accessFromConnections` |
| `src/control/routes/files.ts`, `routes/members.ts` | Use grants |
| `src/control/routes/schedules.ts`, `routes/runs.ts` | Zone filtering |
| `src/control/routes/connections.ts`, `routes/sources.ts` | Zone filtering + grant writes |
| `src/control/spend.ts` | Collapse personal schedules |
| `src/control/app.ts` | Mount new routes |
| `src/console/api.ts`, `src/console/pages/GrantsCard.tsx` (new), `src/console/pages/Access.tsx` | Admin grant editor |
| `test/helpers/opsMock.ts`, `test/helpers/zoneFixture.ts` (new) | Shared integration harness |
| `test/unit/zone.test.ts`, `test/unit/space-access.test.ts`, `test/unit/grants-card.test.ts` | Unit tests |
| `test/integration/zones.test.ts` (new) | End-to-end privacy assertions |

---

### Task 1: The zone rule

**Files:**
- Create: `src/control/zone.ts`
- Test: `test/unit/zone.test.ts`

**Interfaces:**
- Produces:
  - `type Zone = { kind: 'personal'; ownerMembershipId: string } | { kind: 'company' }`
  - `type Caller = { userId: string; orgId: string; role: Role; membershipId: string }`
  - `zoneOf(ownerMembershipId: string | null): Zone`
  - `isAdminRole(role: Role): boolean`
  - `canSeeZone(caller: Pick<Caller,'role'|'membershipId'>, writeSpace: { ownerMembershipId: string | null } | null): boolean`
  - `visibleZoneSql(caller: Pick<Caller,'role'|'membershipId'>): SQL` — valid only in a query that joins `schema.spaces` as the write Space
  - `callerFor(ctx: { userId: string; orgId: string; role: Role }): Promise<Caller>` — throws `{status:403}` error when the user has no membership in the org

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/zone.test.ts
import { test, expect, describe } from 'bun:test';
import { zoneOf, canSeeZone, isAdminRole } from '../../src/control/zone.ts';

const me = 'm-me';
const other = 'm-other';

describe('zoneOf', () => {
  test('null owner is company, a set owner is personal', () => {
    expect(zoneOf(null)).toEqual({ kind: 'company' });
    expect(zoneOf(me)).toEqual({ kind: 'personal', ownerMembershipId: me });
  });
});

describe('canSeeZone — the privacy table', () => {
  const roles = ['owner', 'admin', 'member', 'viewer'] as const;

  for (const role of roles) {
    test(`${role}: own personal zone is visible`, () => {
      expect(canSeeZone({ role, membershipId: me }, { ownerMembershipId: me })).toBe(true);
    });
    test(`${role}: someone else's personal zone is NOT visible`, () => {
      expect(canSeeZone({ role, membershipId: me }, { ownerMembershipId: other })).toBe(false);
    });
    test(`${role}: company zone is visible`, () => {
      expect(canSeeZone({ role, membershipId: me }, { ownerMembershipId: null })).toBe(true);
    });
  }

  test('an unresolved write Space is admin-only', () => {
    expect(canSeeZone({ role: 'owner', membershipId: me }, null)).toBe(true);
    expect(canSeeZone({ role: 'admin', membershipId: me }, null)).toBe(true);
    expect(canSeeZone({ role: 'member', membershipId: me }, null)).toBe(false);
    expect(canSeeZone({ role: 'viewer', membershipId: me }, null)).toBe(false);
  });

  test('isAdminRole', () => {
    expect(isAdminRole('owner')).toBe(true);
    expect(isAdminRole('admin')).toBe(true);
    expect(isAdminRole('member')).toBe(false);
    expect(isAdminRole('viewer')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/zone.test.ts`
Expected: FAIL — `Cannot find module '../../src/control/zone.ts'`

- [ ] **Step 3: Write the implementation**

```ts
// src/control/zone.ts
/**
 * The zone rule (spec §4) — the ONE derivation of "whose is this, and may the
 * caller see it". A Space's zone is its owner (`owner_membership_id`): set means
 * personal, null means company. Connections, schedules, runs and alerts have no
 * zone of their own; they inherit the zone of the Space they WRITE to.
 *
 * `canSeeZone` is the pure rule; `visibleZoneSql` is its SQL twin for list
 * queries. The two must agree — test/integration/zones.test.ts exercises the
 * SQL form against every role the unit test pins for the pure one.
 *
 * `Role` is a type-only import on purpose: importing a VALUE from rbac.ts
 * would load Better Auth at module init, which unit tests must not need.
 */
import { and, eq, isNotNull, isNull, or, type SQL } from 'drizzle-orm';
import type { Role } from './rbac.ts';
import { getDb, schema } from './db/client.ts';

export type Zone = { kind: 'personal'; ownerMembershipId: string } | { kind: 'company' };

export type Caller = { userId: string; orgId: string; role: Role; membershipId: string };

export function zoneOf(ownerMembershipId: string | null): Zone {
  return ownerMembershipId === null
    ? { kind: 'company' }
    : { kind: 'personal', ownerMembershipId };
}

export function isAdminRole(role: Role): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * `writeSpace` is the Space the object writes to, or `null` when none resolves
 * (a schedule whose connection was set-null'd, a run whose connection was
 * deleted). Nobody can prove an unresolved object was theirs, so it is company
 * zone and admin-only. A personal zone is its owner's alone — the admin/owner
 * override does NOT pierce it.
 */
export function canSeeZone(
  caller: Pick<Caller, 'role' | 'membershipId'>,
  writeSpace: { ownerMembershipId: string | null } | null,
): boolean {
  if (writeSpace === null) return isAdminRole(caller.role);
  if (writeSpace.ownerMembershipId !== null) return writeSpace.ownerMembershipId === caller.membershipId;
  return true;
}

/**
 * The SQL twin of `canSeeZone`, for a query that LEFT JOINs `schema.spaces` as
 * the write Space. On a LEFT JOIN miss both `spaces.id` and
 * `spaces.owner_membership_id` are null, so "company" must also require a
 * resolved row — otherwise an unresolved object would read as company for
 * everyone.
 */
export function visibleZoneSql(caller: Pick<Caller, 'role' | 'membershipId'>): SQL {
  const own = eq(schema.spaces.ownerMembershipId, caller.membershipId);
  const company = and(isNotNull(schema.spaces.id), isNull(schema.spaces.ownerMembershipId))!;
  return isAdminRole(caller.role)
    ? or(own, company, isNull(schema.spaces.id))!
    : or(own, company)!;
}

/** `requireRole` returns no membership id; every zone check needs one. */
export async function callerFor(ctx: { userId: string; orgId: string; role: Role }): Promise<Caller> {
  const [m] = await getDb().select({ id: schema.memberships.id }).from(schema.memberships)
    .where(and(
      eq(schema.memberships.userId, ctx.userId),
      eq(schema.memberships.organizationId, ctx.orgId),
    ));
  if (!m) throw Object.assign(new Error('forbidden'), { status: 403 });
  return { ...ctx, membershipId: m.id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/zone.test.ts`
Expected: PASS (15 tests)

- [ ] **Step 5: Commit**

```bash
git add src/control/zone.ts test/unit/zone.test.ts
git commit -m "feat(zones): the zone rule — personal is owner-only, unresolved is admin-only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `space_grants` replaces connection-derived access

**Files:**
- Create: `src/control/db/migrations/0011_space_grants.sql`
- Modify: `src/control/db/migrations/meta/_journal.json` (append entry)
- Modify: `src/control/db/schema.ts` (import `primaryKey`; add `spaceGrants` after `spaces`)
- Create: `src/control/grants.ts`
- Modify: `src/control/spaceAccess.ts` (whole file)
- Modify: `src/control/routes/files.ts:74-122` (`memberConnsFor`, `GET /spaces`)
- Modify: `src/control/routes/members.ts:211-265` (`/access-overview`)
- Modify: `src/control/routes/connections.ts:104-113` (`POST /connections` writes grants)
- Create: `test/helpers/opsMock.ts`, `test/helpers/zoneFixture.ts`
- Replace: `test/unit/space-access.test.ts`
- Create: `test/integration/zones.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `schema.spaceGrants` columns `organizationId, membershipId, spaceId, access ('read'|'write'), grantedBy, createdAt`; PK `(membershipId, spaceId)`
  - `type GrantRow = { spaceId: string; access: string }` (in `spaceAccess.ts`)
  - `accessFromGrants(role: Role, grants: readonly GrantRow[], spaceId: string, ownerMembershipId: string | null, requestingMembershipId: string): 'write' | 'read' | null`
  - `grantsFor(orgId: string, membershipId: string): Promise<GrantRow[]>` (in `grants.ts`)
  - `upsertGrant(orgId: string, membershipId: string, spaceId: string, access: 'read' | 'write', actor: string): Promise<void>`
  - `grantsForConnection(input: { organizationId: string; membershipId: string; writeSpaceId: string; readSpaceIds: string[] }, actor: string): Promise<void>`
  - Test helpers: `installOpsMock(): OpsMock`, `buildZoneFixture(): Promise<ZoneFixture>`, `hit(method, path, cookie?, body?)`, `insertCommandSchedule(...)`, `insertAgentRun(...)`

- [ ] **Step 1: Create the shared ops mock helper**

This is the `mock.module` block from `test/integration/private-spaces.test.ts:9-101`, moved so every zones test file shares one copy. It must be called before `app.ts` is imported.

```ts
// test/helpers/opsMock.ts
import { mock } from 'bun:test';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(48);
process.env.BETTER_AUTH_SECRET ??= 'b'.repeat(48);
process.env.CONTROL_DATABASE_URL ??=
  'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';
process.env.PUBLIC_URL ??= 'http://127.0.0.1:3131';

export type CallOpts = { json?: boolean; dryRun?: boolean; timeoutMs?: number };
export type OpsCall = { op: string; params?: Record<string, unknown>; opts?: CallOpts };
export type OpsResult = {
  ok: boolean; exitCode: number; argv: string[];
  stdout: string; stderr: string; json: unknown;
};

export type OpsMock = {
  calls: OpsCall[];
  seedSpaceCalls: string[];
  reset(): void;
};

const HANDOFF = {
  version: 1,
  mcp_url: 'http://127.0.0.1:3131/mcp',
  issuer_url: 'http://127.0.0.1:3131',
  client_id: 'gbrain_cl_mock_handoff',
  client_secret: 'not-a-real-secret-not-a-real-secret-not-a-real',
  access_token: 'gbrain_at_mock_handoff',
  expires_at: 1789657429,
  profile: 'memory-writer',
  harness: 'generic',
  source_id: 'customers',
};

export function installOpsMock(): OpsMock {
  const calls: OpsCall[] = [];
  const seedSpaceCalls: string[] = [];
  let grantSeq = 0;

  const grantJson = (dryRun: boolean): unknown => {
    if (dryRun) return { status: 'preview', grant: { profile: 'memory-writer', sourceId: 'customers' } };
    const n = grantSeq++;
    return {
      client_id: `gbrain_cl_mock_${n}`,
      mcp_url: 'http://127.0.0.1:3131/mcp',
      profile: 'memory-writer',
      harness: 'generic',
      source_id: 'customers',
      expires_at: null,
      renewable: true,
      credentials: 'private-file',
    };
  };

  const ok = (op: string, opts?: CallOpts): OpsResult => ({
    ok: true, exitCode: 0, argv: ['gbrain', ...op.split('.')], stdout: '{}', stderr: '',
    json: op === 'mcp.grant' ? grantJson(Boolean(opts?.dryRun)) : { ok: true },
  });

  mock.module('../../src/control/opsClient.ts', () => ({
    brainUsage: async () => { throw new Error('ops unreachable'); },
    callOps: async (op: string, params?: Record<string, unknown>, opts?: CallOpts) => {
      calls.push({ op, params, opts });
      return ok(op, opts);
    },
    patchFilePlaneConfig: async () => {},
    putSchemaPack: async () => {},
    putSchemaPackJson: async () => {},
    gitScaffold: async () => ({ created: [], skipped: [], sha: null }),
    removeSchemaPack: async () => ({ removed: false }),
    seedSpace: async (sourceId: string) => { seedSpaceCalls.push(sourceId); },
    resetBrainSchema: async () => {},
    takeGrantCredentials: async () => HANDOFF,
    deleteCredentialJournal: async () => ({ deleted: true }),
    opsHealthy: async () => true,
    commitAsMember: async () => ({ committed: false, sha: null }),
    inspectRepos: async () => [],
    writeReport: async () => ({ relPath: '', committed: false, sha: null }),
    cancelRun: async () => ({ cancelled: false }),
    gitRange: async () => ({ commits: [], files: [] }),
    gitPathExists: async () => ({ paths: [] }),
    gitRevertRange: async () => ({ outcome: 'nothing_to_revert' }),
    auditTail: async () => [],
    gitTree: async (sourceId: string) => ({ sourceId, root: `/repos/${sourceId}`, entries: [] }),
    gitExportBundle: async () => new Response(null),
    gitReadFile: async () => ({ content: '', sha: '', size: 0 }),
    gitWriteFile: async () => ({ committed: true, sha: 'written-sha' }),
  }));

  return {
    calls,
    seedSpaceCalls,
    reset() { calls.length = 0; seedSpaceCalls.length = 0; },
  };
}
```

If `bun test` reports `SyntaxError: Export named 'X' not found` for `opsClient.ts`, add `X` to this object with the same stub shape `private-spaces.test.ts` uses — the real module's export list is the authority.

- [ ] **Step 2: Create the fixture helper**

```ts
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
```

- [ ] **Step 3: Write the failing unit test**

Replace `test/unit/space-access.test.ts` entirely:

```ts
// test/unit/space-access.test.ts
import { test, expect, describe } from 'bun:test';
import { accessFromGrants } from '../../src/control/spaceAccess.ts';

const me = 'm-me';
const other = 'm-other';
const company = 's-company';
const mine = 's-mine';

describe('accessFromGrants', () => {
  test('a personal Space is write for its owner, for every role', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      expect(accessFromGrants(role, [], mine, me, me)).toBe('write');
    }
  });

  test("someone else's personal Space is null for every role — grants cannot pierce it", () => {
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      expect(accessFromGrants(role, [{ spaceId: mine, access: 'write' }], mine, other, me)).toBeNull();
    }
  });

  test('admin and owner reach every company Space without a grant', () => {
    expect(accessFromGrants('owner', [], company, null, me)).toBe('write');
    expect(accessFromGrants('admin', [], company, null, me)).toBe('write');
  });

  test('member and viewer reach a company Space only through a grant', () => {
    expect(accessFromGrants('member', [], company, null, me)).toBeNull();
    expect(accessFromGrants('member', [{ spaceId: company, access: 'read' }], company, null, me)).toBe('read');
    expect(accessFromGrants('viewer', [{ spaceId: company, access: 'write' }], company, null, me)).toBe('write');
  });

  test('an unknown access value is no access, never a guess', () => {
    expect(accessFromGrants('member', [{ spaceId: company, access: 'admin' }], company, null, me)).toBeNull();
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `bun test test/unit/space-access.test.ts`
Expected: FAIL — `Export named 'accessFromGrants' not found`

- [ ] **Step 5: Add the table and migration**

In `src/control/db/schema.ts`, change the import on lines 1-3 to include `primaryKey`:

```ts
import {
  pgTable, text, timestamp, boolean, integer, jsonb, uniqueIndex, index, check, primaryKey,
} from 'drizzle-orm/pg-core';
```

Add directly after the `spaces` table (after its closing `]);`):

```ts
/**
 * D7 (zones spec): explicit access to COMPANY Spaces. A personal Space is never
 * granted — its owner reaches it by ownership and nobody else reaches it at
 * all — so every row here points at a Space whose `owner_membership_id` is null.
 * Admin/owner reach every company Space without a row.
 */
export const spaceGrants = pgTable('space_grants', {
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  membershipId: text('membership_id').notNull()
    .references(() => memberships.id, { onDelete: 'cascade' }),
  spaceId: text('space_id').notNull()
    .references(() => spaces.id, { onDelete: 'cascade' }),
  access: text('access').notNull(),
  grantedBy: text('granted_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.membershipId, t.spaceId], name: 'space_grants_pk' }),
  index('space_grants_org_idx').on(t.organizationId),
  check('space_grant_access_valid', sql`${t.access} in ('read','write')`),
]);
```

Create `src/control/db/migrations/0011_space_grants.sql`:

```sql
CREATE TABLE "space_grants" (
	"organization_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"space_id" text NOT NULL,
	"access" text NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_grants_pk" PRIMARY KEY("membership_id","space_id"),
	CONSTRAINT "space_grant_access_valid" CHECK ("space_grants"."access" in ('read','write'))
);--> statement-breakpoint
ALTER TABLE "space_grants" ADD CONSTRAINT "space_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_grants" ADD CONSTRAINT "space_grants_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_grants" ADD CONSTRAINT "space_grants_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "space_grants_org_idx" ON "space_grants" USING btree ("organization_id");--> statement-breakpoint
-- Backfill: the access every member had through a live connection becomes a
-- grant. Company Spaces only; a write anywhere beats a read.
INSERT INTO "space_grants" ("organization_id", "membership_id", "space_id", "access", "granted_by")
SELECT c."organization_id", c."membership_id", s."id",
       CASE WHEN bool_or(c."write_space_id" = s."id") THEN 'write' ELSE 'read' END,
       'migration:0011'
FROM "connections" c
JOIN "spaces" s
  ON s."organization_id" = c."organization_id"
 AND s."owner_membership_id" IS NULL
 AND (c."write_space_id" = s."id" OR c."read_space_ids" ? s."id")
WHERE c."state" IN ('pending', 'active')
GROUP BY c."organization_id", c."membership_id", s."id"
ON CONFLICT DO NOTHING;
```

Append to the `entries` array in `src/control/db/migrations/meta/_journal.json` (after the `0010_private_member_spaces` entry, with a comma after that entry's `}`):

```json
    {
      "idx": 11,
      "version": "7",
      "when": 1792000000000,
      "tag": "0011_space_grants",
      "breakpoints": true
    }
```

- [ ] **Step 6: Write `grants.ts` and rewrite `spaceAccess.ts`**

```ts
// src/control/grants.ts
/**
 * `space_grants` reads and writes. The ONE place grants are created, so the
 * "company Spaces only" and "write never downgrades" rules live here once.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from './db/client.ts';
import type { GrantRow } from './spaceAccess.ts';

export async function grantsFor(orgId: string, membershipId: string): Promise<GrantRow[]> {
  return getDb().select({ spaceId: schema.spaceGrants.spaceId, access: schema.spaceGrants.access })
    .from(schema.spaceGrants)
    .where(and(
      eq(schema.spaceGrants.organizationId, orgId),
      eq(schema.spaceGrants.membershipId, membershipId),
    ));
}

export async function upsertGrant(
  orgId: string, membershipId: string, spaceId: string, access: 'read' | 'write', actor: string,
): Promise<void> {
  await getDb().insert(schema.spaceGrants)
    .values({ organizationId: orgId, membershipId, spaceId, access, grantedBy: actor })
    .onConflictDoUpdate({
      target: [schema.spaceGrants.membershipId, schema.spaceGrants.spaceId],
      set: { access, grantedBy: actor },
    });
}

/**
 * An admin-created connection implies the access it compiles to: write on its
 * write Space, read on each read Space. Personal Spaces are skipped (ownership
 * is their access), and an existing `write` is never downgraded to `read`.
 */
export async function grantsForConnection(
  input: { organizationId: string; membershipId: string; writeSpaceId: string; readSpaceIds: string[] },
  actor: string,
): Promise<void> {
  const ids = [input.writeSpaceId, ...input.readSpaceIds];
  const rows = await getDb().select({ id: schema.spaces.id, owner: schema.spaces.ownerMembershipId })
    .from(schema.spaces)
    .where(and(eq(schema.spaces.organizationId, input.organizationId), inArray(schema.spaces.id, ids)));
  const company = new Set(rows.filter((r) => r.owner === null).map((r) => r.id));
  const existing = new Map(
    (await grantsFor(input.organizationId, input.membershipId)).map((g) => [g.spaceId, g.access]),
  );

  if (company.has(input.writeSpaceId)) {
    await upsertGrant(input.organizationId, input.membershipId, input.writeSpaceId, 'write', actor);
  }
  for (const id of input.readSpaceIds) {
    if (!company.has(id) || id === input.writeSpaceId || existing.get(id) === 'write') continue;
    await upsertGrant(input.organizationId, input.membershipId, id, 'read', actor);
  }
}
```

```ts
// src/control/spaceAccess.ts
/**
 * S1 — the ONE derivation of "can this membership touch this Space, and how".
 *
 * The Access matrix (`/access-overview`) and the Files routes both call this,
 * so a cell the page renders as `read` is exactly a read the Files browser
 * will allow.
 *
 * Zones spec D7: access to a COMPANY Space comes from `space_grants`, not from
 * connection rows. A personal Space (`ownerMembershipId` non-null) is `write`
 * for its owner and `null` for everyone else — the admin/owner override does
 * not pierce it, and no grant can either.
 */
import { and, eq } from 'drizzle-orm';
import type { Role } from './rbac.ts';
import { getDb, schema } from './db/client.ts';
import { grantsFor } from './grants.ts';

export type GrantRow = { spaceId: string; access: string };

export function accessFromGrants(
  role: Role,
  grants: readonly GrantRow[],
  spaceId: string,
  ownerMembershipId: string | null,
  requestingMembershipId: string,
): 'write' | 'read' | null {
  if (ownerMembershipId !== null) return ownerMembershipId === requestingMembershipId ? 'write' : null;
  if (role === 'admin' || role === 'owner') return 'write';
  const grant = grants.find((g) => g.spaceId === spaceId);
  if (grant?.access === 'write') return 'write';
  if (grant?.access === 'read') return 'read';
  return null;
}

/** DB-backed. Scoped to the org as well as the membership. */
export async function spaceAccess(
  orgId: string,
  membershipId: string,
  role: Role,
  spaceId: string,
): Promise<'write' | 'read' | null> {
  const [space] = await getDb().select({ ownerMembershipId: schema.spaces.ownerMembershipId })
    .from(schema.spaces).where(and(eq(schema.spaces.organizationId, orgId), eq(schema.spaces.id, spaceId)));
  if (!space) return null;
  return accessFromGrants(role, await grantsFor(orgId, membershipId), spaceId, space.ownerMembershipId, membershipId);
}
```

- [ ] **Step 7: Run the unit test**

Run: `bun test test/unit/space-access.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 8: Switch the two callers and the connection-create route**

In `src/control/routes/files.ts`:
- Change the import on line 21 to `import { accessFromGrants, spaceAccess } from '../spaceAccess.ts';` and add `import { grantsFor } from '../grants.ts';`.
- Delete `memberConnsFor` (lines 74-86, the function and its comment).
- In `GET /spaces`, replace
  ```ts
  const conns = await memberConnsFor(ctx.orgId, membershipId);

  const visible = spaces.flatMap((space) => {
    const access = accessFromConnections(ctx.role, conns, space.id, space.ownerMembershipId, membershipId);
  ```
  with
  ```ts
  const grants = await grantsFor(ctx.orgId, membershipId);

  const visible = spaces.flatMap((space) => {
    const access = accessFromGrants(ctx.role, grants, space.id, space.ownerMembershipId, membershipId);
  ```

In `src/control/routes/members.ts`:
- Change line 10 to `import { accessFromGrants } from '../spaceAccess.ts';`.
- In `/access-overview`, replace everything from `const conns = await getDb().select().from(schema.connections)` through the end of the `for (const member of memberRows)` loop with:

```ts
  const grants = await getDb().select({
    membershipId: schema.spaceGrants.membershipId,
    spaceId: schema.spaceGrants.spaceId,
    access: schema.spaceGrants.access,
  }).from(schema.spaceGrants).where(eq(schema.spaceGrants.organizationId, orgId));

  // ONE derivation, shared with the Files routes (spaceAccess.ts).
  const grantsByMembership = new Map<string, typeof grants>();
  for (const g of grants) {
    const list = grantsByMembership.get(g.membershipId);
    if (list) list.push(g); else grantsByMembership.set(g.membershipId, [g]);
  }

  const cells: Array<{ membershipId: string; spaceId: string; access: 'read' | 'write' }> = [];
  for (const member of memberRows) {
    const memberGrants = grantsByMembership.get(member.membershipId) ?? [];
    for (const space of spaces) {
      const access = accessFromGrants(
        member.role as Role, memberGrants, space.id, space.ownerMembershipId, member.membershipId,
      );
      if (access !== null) cells.push({ membershipId: member.membershipId, spaceId: space.id, access });
    }
  }
```

  Remove `inArray` from the `drizzle-orm` import in `members.ts` if nothing else uses it (`grep -n inArray src/control/routes/members.ts`).

In `src/control/routes/connections.ts`, add `import { grantsForConnection } from '../grants.ts';` and change `POST /connections` so the grant follows the connection:

```ts
connectionRoutes.post('/connections', guard('admin', async (c, { userId, orgId }) => {
  const input = await connectionInputFromBody(orgId, await c.req.json());
  delete input.connectionId;
  const created = await createPendingConnection(input);
  // Zones D7: access is a grant, not a side effect of a connection existing.
  await grantsForConnection(input, userId);
  await audit(orgId, userId, 'connection.create', created.connectionId, {
    profile: created.compiled.profile,
    state: 'pending',
  });
  return c.json({ id: created.connectionId, state: 'pending', compiled: created.compiled });
}));
```

Confirm nothing references the old name: `grep -rn accessFromConnections src test` → no output.

- [ ] **Step 9: Write the integration test (backfill + grant-based Files access)**

```ts
// test/integration/zones.test.ts
import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { installOpsMock } from '../helpers/opsMock.ts';

const ops = installOpsMock();

const { getDb, schema, closeDb, pinDb } = await import('../../src/control/db/client.ts');
const { sql, and, eq } = await import('drizzle-orm');
const { buildZoneFixture, hit } = await import('../helpers/zoneFixture.ts');
type ZoneFixture = Awaited<ReturnType<typeof buildZoneFixture>>;

pinDb();
let fx: ZoneFixture;

beforeAll(async () => { fx = await buildZoneFixture(); }, 120_000);
beforeEach(() => ops.reset());
afterAll(async () => { await closeDb(); });

describe('grants — the migration backfill', () => {
  test('a live connection becomes a grant on company Spaces only; write beats read', async () => {
    const readOnlyId = randomUUID();
    await getDb().insert(schema.spaces).values({
      id: readOnlyId, organizationId: fx.orgId, sourceId: 'company-ro', name: 'RO',
      kind: 'local-git', localPath: '/srv/brain-repos/company-ro', ownerMembershipId: null,
    });
    await getDb().insert(schema.connections).values({
      id: randomUUID(), organizationId: fx.orgId, membershipId: fx.bob.membershipId,
      writeSpaceId: fx.companySpaceId, readSpaceIds: [readOnlyId, fx.alice.privateSpaceId],
      harness: 'generic', clientName: `bs-backfill-${randomUUID().slice(0, 6)}`,
      profile: 'memory-writer', tokenTtl: 3600, state: 'active',
    });

    const migration = readFileSync('src/control/db/migrations/0011_space_grants.sql', 'utf8');
    const backfill = migration.split('--> statement-breakpoint').find((s) => s.includes('INSERT INTO "space_grants"'))!;
    await getDb().execute(sql.raw(backfill));

    const rows = await getDb().select().from(schema.spaceGrants)
      .where(eq(schema.spaceGrants.membershipId, fx.bob.membershipId));
    const byspace = Object.fromEntries(rows.map((r) => [r.spaceId, r.access]));
    expect(byspace[fx.companySpaceId]).toBe('write');
    expect(byspace[readOnlyId]).toBe('read');
    expect(byspace[fx.alice.privateSpaceId]).toBeUndefined(); // personal Spaces are never granted

    await getDb().delete(schema.spaceGrants).where(eq(schema.spaceGrants.membershipId, fx.bob.membershipId));
    await getDb().delete(schema.connections).where(and(
      eq(schema.connections.membershipId, fx.bob.membershipId),
      eq(schema.connections.writeSpaceId, fx.companySpaceId),
    ));
    await getDb().delete(schema.spaces).where(eq(schema.spaces.id, readOnlyId));
  });
});

describe('Files — access comes from grants', () => {
  test('a member without a grant cannot see the company Space; with a read grant they can', async () => {
    const before = await (await hit('GET', '/api/spaces', fx.alice.cookie)).json() as { spaces: Array<{ id: string; access: string }> };
    expect(before.spaces.map((s) => s.id)).toEqual([fx.alice.privateSpaceId]);

    await getDb().insert(schema.spaceGrants).values({
      organizationId: fx.orgId, membershipId: fx.alice.membershipId, spaceId: fx.companySpaceId,
      access: 'read', grantedBy: 'test',
    });
    const after = await (await hit('GET', '/api/spaces', fx.alice.cookie)).json() as { spaces: Array<{ id: string; access: string }> };
    const company = after.spaces.find((s) => s.id === fx.companySpaceId);
    expect(company?.access).toBe('read');
    expect(after.spaces.some((s) => s.id === fx.bob.privateSpaceId)).toBe(false);

    await getDb().delete(schema.spaceGrants).where(eq(schema.spaceGrants.membershipId, fx.alice.membershipId));
  });

  test("an owner still cannot open a member's private Space", async () => {
    const res = await hit('GET', `/api/spaces/${fx.alice.privateSourceId}/files`, fx.owner.cookie);
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 10: Run the integration tests**

Run: `bun test test/integration/zones.test.ts`
Expected: PASS (3 tests)

Run: `bun test test/integration/private-spaces.test.ts` and `bun test test/integration/connections.test.ts`
Expected: PASS. If a test fails because it creates a connection by **inserting a row directly** and then expects `/access-overview` or Files to show access, add the grant that connection implies in that test's setup, right after the insert:

```ts
await getDb().insert(schema.spaceGrants).values({
  organizationId: orgId, membershipId: <the connection's membershipId>, spaceId: <the company Space id>,
  access: 'read', // or 'write' when the Space was the connection's writeSpaceId
  grantedBy: 'test',
});
```

Tests that create connections through `POST /api/connections` need no change (the route now writes grants).

- [ ] **Step 11: Commit**

```bash
git add src/control/db/schema.ts src/control/db/migrations/0011_space_grants.sql src/control/db/migrations/meta/_journal.json \
  src/control/grants.ts src/control/spaceAccess.ts src/control/routes/files.ts src/control/routes/members.ts \
  src/control/routes/connections.ts test/helpers/opsMock.ts test/helpers/zoneFixture.ts \
  test/unit/space-access.test.ts test/integration/zones.test.ts test/integration/private-spaces.test.ts test/integration/connections.test.ts
git commit -m "feat(zones): space_grants is the source of company-Space access

Backfilled from live connections; admin-created connections write their
implied grants; Files and the Access matrix read grants.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Admin grants API

**Files:**
- Modify: `src/control/grants.ts` (add `removeGrant`)
- Create: `src/control/routes/grants.ts`
- Modify: `src/control/app.ts` (mount)
- Test: `test/integration/zones.test.ts` (append)

**Interfaces:**
- Consumes: `upsertGrant`, `grantsFor` (Task 2); `revokeConnection(connectionId, actor)`, `provisionConnection(input, actor)` from `src/control/connections.ts`.
- Produces:
  - `removeGrant(orgId: string, membershipId: string, spaceId: string, actor: string): Promise<{ removed: boolean; revoked: string[]; rescoped: string[] }>`
  - `GET /api/grants` (admin) → `{ grants: Array<{ membershipId: string; spaceId: string; access: 'read'|'write' }> }`
  - `PUT /api/grants` (admin) body `{ membershipId, spaceId, access }` → `{ ok: true }`; 400 `personal_space_not_grantable` | `invalid_access`; 404 `member_not_found` | `space_not_found`
  - `DELETE /api/grants` (admin) body `{ membershipId, spaceId }` → `{ removed, revoked, rescoped }`
  - `export const grantRoutes: Hono`

- [ ] **Step 1: Write the failing tests** — append to `test/integration/zones.test.ts`:

```ts
describe('admin grants API', () => {
  test('PUT then GET a grant; members cannot call it', async () => {
    const put = await hit('PUT', '/api/grants', fx.admin.cookie, {
      membershipId: fx.alice.membershipId, spaceId: fx.companySpaceId, access: 'read',
    });
    expect(put.status).toBe(200);

    const list = await (await hit('GET', '/api/grants', fx.admin.cookie)).json() as { grants: Array<{ membershipId: string; spaceId: string; access: string }> };
    expect(list.grants).toContainEqual({ membershipId: fx.alice.membershipId, spaceId: fx.companySpaceId, access: 'read' });

    expect((await hit('GET', '/api/grants', fx.alice.cookie)).status).toBe(403);
    expect((await hit('PUT', '/api/grants', fx.alice.cookie, {
      membershipId: fx.alice.membershipId, spaceId: fx.companySpaceId, access: 'write',
    })).status).toBe(403);
  });

  test('a personal Space cannot be granted', async () => {
    const res = await hit('PUT', '/api/grants', fx.admin.cookie, {
      membershipId: fx.bob.membershipId, spaceId: fx.alice.privateSpaceId, access: 'read',
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('personal_space_not_grantable');
  });

  test("DELETE rescopes the member's private connection instead of revoking it", async () => {
    await getDb().update(schema.connections)
      .set({ readSpaceIds: [fx.companySpaceId] })
      .where(eq(schema.connections.id, fx.alice.privateConnectionId));

    const res = await hit('DELETE', '/api/grants', fx.admin.cookie, {
      membershipId: fx.alice.membershipId, spaceId: fx.companySpaceId,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { removed: boolean; revoked: string[]; rescoped: string[] };
    expect(body.removed).toBe(true);
    expect(body.rescoped).toEqual([fx.alice.privateConnectionId]);
    expect(body.revoked).toEqual([]);

    const [conn] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, fx.alice.privateConnectionId));
    expect(conn?.state).toBe('active');
    expect(conn?.readSpaceIds).toEqual([]);
    expect(ops.calls.some((c) => c.op === 'auth.rescopeClient')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/integration/zones.test.ts`
Expected: the three new tests FAIL with 404 (route not mounted).

- [ ] **Step 3: Add `removeGrant`** — append to `src/control/grants.ts`:

```ts
import { provisionConnection, revokeConnection } from './connections.ts';
import type { Role } from './rbac.ts';

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Removing access must remove what the access was USED for. A connection that
 * writes to the Space is revoked. A connection that only reads it is revoked,
 * too — unless it is the member's own private connection, which is rescoped to
 * drop the Space so their personal agent keeps working.
 */
export async function removeGrant(
  orgId: string, membershipId: string, spaceId: string, actor: string,
): Promise<{ removed: boolean; revoked: string[]; rescoped: string[] }> {
  const deleted = await getDb().delete(schema.spaceGrants).where(and(
    eq(schema.spaceGrants.organizationId, orgId),
    eq(schema.spaceGrants.membershipId, membershipId),
    eq(schema.spaceGrants.spaceId, spaceId),
  )).returning({ spaceId: schema.spaceGrants.spaceId });

  const [membership] = await getDb().select({ role: schema.memberships.role }).from(schema.memberships)
    .where(eq(schema.memberships.id, membershipId));
  const conns = await getDb().select().from(schema.connections).where(and(
    eq(schema.connections.organizationId, orgId),
    eq(schema.connections.membershipId, membershipId),
    inArray(schema.connections.state, ['pending', 'active']),
  ));

  const revoked: string[] = [];
  const rescoped: string[] = [];
  for (const conn of conns) {
    const reads = asStringArray(conn.readSpaceIds);
    if (conn.writeSpaceId !== spaceId && !reads.includes(spaceId)) continue;

    const [write] = await getDb().select({ owner: schema.spaces.ownerMembershipId }).from(schema.spaces)
      .where(eq(schema.spaces.id, conn.writeSpaceId));
    const ownPrivate = write?.owner === membershipId && conn.writeSpaceId !== spaceId;
    const remaining = reads.filter((id) => id !== spaceId);

    if (ownPrivate && conn.state === 'pending') {
      await getDb().update(schema.connections).set({ readSpaceIds: remaining })
        .where(eq(schema.connections.id, conn.id));
      rescoped.push(conn.id);
    } else if (ownPrivate && membership) {
      await provisionConnection({
        organizationId: orgId, membershipId, writeSpaceId: conn.writeSpaceId, readSpaceIds: remaining,
        harness: conn.harness, memberRole: membership.role as Role, connectionId: conn.id, tokenTtl: conn.tokenTtl,
      }, actor);
      rescoped.push(conn.id);
    } else {
      await revokeConnection(conn.id, actor);
      revoked.push(conn.id);
    }
  }
  return { removed: deleted.length > 0, revoked, rescoped };
}
```

(Place the two new imports at the top of the file with the existing ones.)

- [ ] **Step 4: Add the routes**

```ts
// src/control/routes/grants.ts
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { requireRole, type Role } from '../rbac.ts';
import { removeGrant, upsertGrant } from '../grants.ts';

export const grantRoutes = new Hono();

const guard = (min: Role, handler: (c: any, ctx: { userId: string; orgId: string; role: Role }) => Promise<Response>) =>
  async (c: any) => {
    let ctx;
    try { ctx = await requireRole(c, min); } catch (r) { return r as Response; }
    try { return await handler(c, ctx); }
    catch (e: any) { return c.json({ error: e?.message ?? 'grants_error' }, e?.status ?? 400); }
  };

async function audit(orgId: string, actor: string, action: string, target: string, after: unknown) {
  await getDb().insert(schema.auditLog)
    .values({ id: randomUUID(), organizationId: orgId, actor, action, target, before: null, after: after as object });
}

async function readTarget(c: any, orgId: string) {
  const body = await c.req.json().catch(() => ({}));
  const membershipId = typeof body?.membershipId === 'string' ? body.membershipId : '';
  const spaceId = typeof body?.spaceId === 'string' ? body.spaceId : '';
  const [membership] = await getDb().select({ id: schema.memberships.id }).from(schema.memberships)
    .where(and(eq(schema.memberships.id, membershipId), eq(schema.memberships.organizationId, orgId)));
  if (!membership) throw Object.assign(new Error('member_not_found'), { status: 404 });
  const [space] = await getDb().select({ owner: schema.spaces.ownerMembershipId }).from(schema.spaces)
    .where(and(eq(schema.spaces.id, spaceId), eq(schema.spaces.organizationId, orgId)));
  // A personal Space answers exactly like a missing one would to anyone but
  // its owner — but an admin granting it is a programming error worth naming.
  if (!space) throw Object.assign(new Error('space_not_found'), { status: 404 });
  if (space.owner !== null) throw Object.assign(new Error('personal_space_not_grantable'), { status: 400 });
  return { body, membershipId, spaceId };
}

grantRoutes.get('/grants', guard('admin', async (c, { orgId }) => {
  const grants = await getDb().select({
    membershipId: schema.spaceGrants.membershipId,
    spaceId: schema.spaceGrants.spaceId,
    access: schema.spaceGrants.access,
  }).from(schema.spaceGrants)
    .innerJoin(schema.spaces, eq(schema.spaces.id, schema.spaceGrants.spaceId))
    .where(and(eq(schema.spaceGrants.organizationId, orgId), isNull(schema.spaces.ownerMembershipId)));
  return c.json({ grants });
}));

grantRoutes.put('/grants', guard('admin', async (c, { userId, orgId }) => {
  const { body, membershipId, spaceId } = await readTarget(c, orgId);
  const access = body?.access;
  if (access !== 'read' && access !== 'write') return c.json({ error: 'invalid_access' }, 400);
  await upsertGrant(orgId, membershipId, spaceId, access, userId);
  await audit(orgId, userId, 'grant.put', membershipId, { spaceId, access });
  return c.json({ ok: true });
}));

grantRoutes.delete('/grants', guard('admin', async (c, { userId, orgId }) => {
  const { membershipId, spaceId } = await readTarget(c, orgId);
  const result = await removeGrant(orgId, membershipId, spaceId, userId);
  await audit(orgId, userId, 'grant.delete', membershipId, {
    spaceId, revoked: result.revoked.length, rescoped: result.rescoped.length,
  });
  return c.json(result);
}));
```

In `src/control/app.ts`, add `import { grantRoutes } from './routes/grants.ts';` beside the other route imports and `app.route('/api', grantRoutes);` directly after `app.route('/api', members);`.

- [ ] **Step 5: Run the tests**

Run: `bun test test/integration/zones.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add src/control/grants.ts src/control/routes/grants.ts src/control/app.ts test/integration/zones.test.ts
git commit -m "feat(zones): admin grants API; removing a grant revokes or rescopes what used it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Schedules are zone-filtered

**Files:**
- Modify: `src/control/routes/schedules.ts` (imports; `loadOwnConnection` 180-197; `loadScheduleRow` 244-248; `GET /schedules` 554-559; every call site of `loadScheduleRow`/`loadOwnConnection`)
- Test: `test/integration/zones.test.ts` (append)

**Interfaces:**
- Consumes: `callerFor`, `visibleZoneSql`, `type Caller` (Task 1); fixture `insertCommandSchedule` (Task 2).
- Produces: `loadScheduleRow(caller: Caller, id: string)`, `loadOwnConnection(caller: Caller, connectionId: unknown)` — both return `null` for a row outside the caller's visible zones.

- [ ] **Step 1: Write the failing tests** — append:

```ts
const { insertCommandSchedule } = await import('../helpers/zoneFixture.ts');

describe('schedules are private to their zone', () => {
  let aliceSchedule = '';
  let companySchedule = '';
  let orphanSchedule = '';

  beforeAll(async () => {
    aliceSchedule = await insertCommandSchedule(fx.orgId, fx.alice.privateConnectionId, 'alice-inbox-digest');
    const companyConn = randomUUID();
    await getDb().insert(schema.connections).values({
      id: companyConn, organizationId: fx.orgId, membershipId: fx.admin.membershipId,
      writeSpaceId: fx.companySpaceId, readSpaceIds: [], harness: 'generic',
      clientName: `bs-company-${companyConn.slice(0, 6)}`, profile: 'coding-agent', tokenTtl: 3600, state: 'active',
    });
    companySchedule = await insertCommandSchedule(fx.orgId, companyConn, 'company-sync');
    orphanSchedule = await insertCommandSchedule(fx.orgId, null, 'orphaned-job');
  });

  const names = async (cookie: string) =>
    ((await (await hit('GET', '/api/schedules', cookie)).json()) as { schedules: Array<{ name: string }> })
      .schedules.map((s) => s.name).sort();

  test('each caller lists only their own personal schedules plus company ones', async () => {
    expect(await names(fx.alice.cookie)).toEqual(['alice-inbox-digest', 'company-sync']);
    expect(await names(fx.bob.cookie)).toEqual(['company-sync']);
    expect(await names(fx.owner.cookie)).toEqual(['company-sync', 'orphaned-job']);
  });

  test("an owner gets 404 on a member's personal schedule, its runs, and its actions", async () => {
    expect((await hit('GET', `/api/schedules/${aliceSchedule}`, fx.owner.cookie)).status).toBe(404);
    expect((await hit('GET', `/api/schedules/${aliceSchedule}/runs`, fx.owner.cookie)).status).toBe(404);
    expect((await hit('POST', `/api/schedules/${aliceSchedule}/run-now`, fx.owner.cookie, {})).status).toBe(404);
    expect((await hit('PATCH', `/api/schedules/${aliceSchedule}`, fx.owner.cookie, { enabled: false })).status).toBe(404);
    expect((await hit('DELETE', `/api/schedules/${aliceSchedule}`, fx.owner.cookie)).status).toBe(404);
  });

  test('the owning member still reads their own schedule', async () => {
    expect((await hit('GET', `/api/schedules/${aliceSchedule}`, fx.alice.cookie)).status).toBe(200);
  });

  test("an admin cannot create a schedule on a member's private connection", async () => {
    const res = await hit('POST', '/api/schedules', fx.admin.cookie, {
      name: 'sneaky', connectionId: fx.alice.privateConnectionId, operation: 'sync',
      kind: 'interval', intervalSeconds: 3600,
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/integration/zones.test.ts`
Expected: FAIL — bob sees `alice-inbox-digest`; the owner's GET returns 200.

- [ ] **Step 3: Implement**

In `src/control/routes/schedules.ts` add the import:

```ts
import { callerFor, visibleZoneSql, type Caller } from '../zone.ts';
```

Replace `loadOwnConnection` (lines 175-197, doc comment kept):

```ts
async function loadOwnConnection(
  caller: Caller, connectionId: unknown,
): Promise<{ id: string; memberRole: Role } | null> {
  if (typeof connectionId !== 'string' || !connectionId) return null;
  const [row] = await getDb().select({
    id: schema.connections.id,
    organizationId: schema.connections.organizationId,
    memberUserId: schema.memberships.userId,
    memberRole: schema.memberships.role,
    writeSpaceOwner: schema.spaces.ownerMembershipId,
  })
    .from(schema.connections)
    .innerJoin(schema.memberships, eq(schema.connections.membershipId, schema.memberships.id))
    .innerJoin(schema.spaces, eq(schema.connections.writeSpaceId, schema.spaces.id))
    .where(eq(schema.connections.id, connectionId));

  if (!row || row.organizationId !== caller.orgId) return null;
  // Zones: a personal connection is its owner's alone — the admin override
  // below never reaches it.
  if (row.writeSpaceOwner !== null && row.writeSpaceOwner !== caller.membershipId) return null;
  if (!ownsConnection(caller.role, caller.userId, row.memberUserId)) return null;
  return { id: row.id, memberRole: asRole(row.memberRole) };
}
```

Replace `loadScheduleRow`:

```ts
/** One schedule in this org, or null when it is not the caller's to see —
 *  including a schedule in someone else's personal zone (zones spec §4). */
async function loadScheduleRow(caller: Caller, id: string): Promise<ScheduleView | null> {
  const [row] = await scheduleQuery().where(and(
    eq(schema.schedules.id, id),
    eq(schema.schedules.organizationId, caller.orgId),
    visibleZoneSql(caller),
  ));
  return row ? toView(row) : null;
}
```

Replace `GET /schedules`:

```ts
scheduleRoutes.get('/schedules', guard('viewer', async (c, ctx) => {
  const caller = await callerFor(ctx);
  const rows = await scheduleQuery()
    .where(and(eq(schema.schedules.organizationId, caller.orgId), visibleZoneSql(caller)))
    .orderBy(schema.schedules.name);
  return c.json({ schedules: rows.map(toView) });
}));
```

Then update every remaining handler that calls `loadScheduleRow` or `loadOwnConnection` — `GET /schedules/:id` (line 562), `POST /schedules` (654), `PATCH /schedules/:id` (833), `DELETE /schedules/:id` (949), `GET /schedules/:id/runs` (969), `POST /schedules/:id/run-now` (996). In each, add `const caller = await callerFor({ userId, orgId, role });` as the handler's first statement (for handlers whose destructure lacks `userId`/`role`, change the destructure to `(c, ctx)` and use `const caller = await callerFor(ctx);`), then replace:
- `loadScheduleRow(orgId, X)` → `loadScheduleRow(caller, X)`
- `loadOwnConnection(orgId, X, userId, role)` → `loadOwnConnection(caller, X)`

Verify: `grep -n "loadScheduleRow(orgId\|loadOwnConnection(orgId" src/control/routes/schedules.ts` → no output. Ensure `and` is imported from `drizzle-orm` in this file.

- [ ] **Step 4: Run the tests**

Run: `bun test test/integration/zones.test.ts` → PASS
Run: `bun test test/integration/scheduler-routes.test.ts` → PASS (existing behaviour for company schedules is unchanged)

- [ ] **Step 5: Commit**

```bash
git add src/control/routes/schedules.ts test/integration/zones.test.ts
git commit -m "fix(zones): personal schedules are invisible outside their owner, admins included

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Runs and alerts are zone-filtered

**Files:**
- Modify: `src/control/routes/runs.ts` (`GET /`, `GET /:id`, `POST /:id/revert`)
- Modify: `src/control/routes/schedules.ts` (`GET /schedule-alerts`, `POST /schedule-alerts/:id/ack`)
- Test: `test/integration/zones.test.ts` (append)

**Interfaces:**
- Consumes: `callerFor`, `visibleZoneSql`, `type Caller`; fixture `insertAgentRun`.
- Produces: `runVisible(caller: Caller, runId: string): Promise<boolean>` (module-private in `runs.ts`).

- [ ] **Step 1: Write the failing tests** — append:

```ts
const { insertAgentRun } = await import('../helpers/zoneFixture.ts');

describe('runs and alerts are private to their zone', () => {
  let aliceRun = '';
  let aliceScheduleId = '';

  beforeAll(async () => {
    const r = await insertAgentRun(fx.orgId, fx.alice.privateConnectionId, 'alice-calendar-prep');
    aliceRun = r.runId;
    aliceScheduleId = r.scheduleId;
    await getDb().insert(schema.scheduleAlerts).values({
      id: randomUUID(), organizationId: fx.orgId, scheduleId: aliceScheduleId, kind: 'run_failed',
    });
  });

  test("an owner does not see a member's personal run in the list or by id, and cannot revert it", async () => {
    const list = await (await hit('GET', '/api/runs', fx.owner.cookie)).json() as { runs: Array<{ scheduleName: string }> };
    expect(list.runs.some((r) => r.scheduleName === 'alice-calendar-prep')).toBe(false);
    expect((await hit('GET', `/api/runs/${aliceRun}`, fx.owner.cookie)).status).toBe(404);
    expect((await hit('POST', `/api/runs/${aliceRun}/revert`, fx.owner.cookie, {})).status).toBe(404);
  });

  test('the owning member sees their run', async () => {
    const list = await (await hit('GET', '/api/runs', fx.alice.cookie)).json() as { runs: Array<{ scheduleName: string }> };
    expect(list.runs.some((r) => r.scheduleName === 'alice-calendar-prep')).toBe(true);
    expect((await hit('GET', `/api/runs/${aliceRun}`, fx.alice.cookie)).status).toBe(200);
  });

  test("alerts on a personal schedule are the owner's only", async () => {
    const forBob = await (await hit('GET', '/api/schedule-alerts', fx.bob.cookie)).json() as { alerts: Array<{ scheduleId: string }> };
    expect(forBob.alerts.some((a) => a.scheduleId === aliceScheduleId)).toBe(false);
    const forAlice = await (await hit('GET', '/api/schedule-alerts', fx.alice.cookie)).json() as { alerts: Array<{ scheduleId: string }> };
    expect(forAlice.alerts.some((a) => a.scheduleId === aliceScheduleId)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/integration/zones.test.ts`
Expected: FAIL — the owner sees `alice-calendar-prep`.

- [ ] **Step 3: Implement runs**

In `src/control/routes/runs.ts` add `import { callerFor, visibleZoneSql, type Caller } from '../zone.ts';`.

In `GET /`, add `const caller = await callerFor(ctx);` first, then add two joins after the `schedules` join and the zone predicate:

```ts
    .innerJoin(schema.schedules, eq(schema.schedules.id, schema.scheduleRuns.scheduleId))
    .leftJoin(schema.connections, eq(schema.connections.id, schema.agentRuns.connectionId))
    .leftJoin(schema.spaces, eq(schema.spaces.id, schema.connections.writeSpaceId))
    .where(and(
      eq(schema.agentRuns.organizationId, caller.orgId),
      eq(schema.schedules.jobType, 'agent_prompt'),
      visibleZoneSql(caller),
    ))
```

In `GET /:id`, add `const caller = await callerFor(ctx);` first; after the existing `.leftJoin(schema.connections, …)` add `.leftJoin(schema.spaces, eq(schema.spaces.id, schema.connections.writeSpaceId))`, and extend the `where` with `visibleZoneSql(caller)` (the existing `run_not_found` 404 then covers invisible runs).

Add above the revert route:

```ts
/** Zones: a run in someone else's personal zone does not exist for the caller. */
async function runVisible(caller: Caller, runId: string): Promise<boolean> {
  const [row] = await getDb().select({ id: schema.agentRuns.runId })
    .from(schema.agentRuns)
    .leftJoin(schema.connections, eq(schema.connections.id, schema.agentRuns.connectionId))
    .leftJoin(schema.spaces, eq(schema.spaces.id, schema.connections.writeSpaceId))
    .where(and(
      eq(schema.agentRuns.runId, runId),
      eq(schema.agentRuns.organizationId, caller.orgId),
      visibleZoneSql(caller),
    ));
  return row !== undefined;
}
```

and make the revert handler's first lines:

```ts
runRoutes.post('/:id/revert', guard('admin', async (c, ctx) => {
  if (!await runVisible(await callerFor(ctx), runIdParam(c))) return c.json({ error: 'run_not_found' }, 404);
```

- [ ] **Step 4: Implement alerts**

In `src/control/routes/schedules.ts` add `getTableColumns` to the `drizzle-orm` import and replace `GET /schedule-alerts`:

```ts
scheduleRoutes.get('/schedule-alerts', guard('viewer', async (c, ctx) => {
  const caller = await callerFor(ctx);
  const alerts = await getDb().select(getTableColumns(schema.scheduleAlerts))
    .from(schema.scheduleAlerts)
    .leftJoin(schema.schedules, eq(schema.schedules.id, schema.scheduleAlerts.scheduleId))
    .leftJoin(schema.connections, eq(schema.connections.id, schema.schedules.connectionId))
    .leftJoin(schema.spaces, eq(schema.spaces.id, schema.connections.writeSpaceId))
    .where(and(eq(schema.scheduleAlerts.organizationId, caller.orgId), visibleZoneSql(caller)))
    .orderBy(desc(schema.scheduleAlerts.at))
    .limit(100);
  return c.json({ alerts });
}));
```

In `POST /schedule-alerts/:id/ack`, change the destructure to `(c, ctx)`, set `const { userId, orgId } = ctx; const caller = await callerFor(ctx);`, and replace the alert lookup so it joins the same three tables and adds `visibleZoneSql(caller)` to its `where` (an invisible alert then hits the existing `alert not found` 404):

```ts
  const [row] = await getDb().select({
    id: schema.scheduleAlerts.id,
    organizationId: schema.scheduleAlerts.organizationId,
    kind: schema.scheduleAlerts.kind,
    acknowledgedAt: schema.scheduleAlerts.acknowledgedAt,
  }).from(schema.scheduleAlerts)
    .leftJoin(schema.schedules, eq(schema.schedules.id, schema.scheduleAlerts.scheduleId))
    .leftJoin(schema.connections, eq(schema.connections.id, schema.schedules.connectionId))
    .leftJoin(schema.spaces, eq(schema.spaces.id, schema.connections.writeSpaceId))
    .where(and(eq(schema.scheduleAlerts.id, id), visibleZoneSql(caller)));
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/integration/zones.test.ts` → PASS
Run: `bun test test/integration/agent-runs.test.ts` and `bun test test/integration/scheduler-routes.test.ts` → PASS

- [ ] **Step 6: Commit**

```bash
git add src/control/routes/runs.ts src/control/routes/schedules.ts test/integration/zones.test.ts
git commit -m "fix(zones): personal runs, run events and alerts are owner-only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Connections and sources are zone-filtered

**Files:**
- Modify: `src/control/routes/connections.ts` (`GET /connections`, `POST /connections/preview`, `POST /connections`, `POST /connections/:id/revoke`)
- Modify: `src/control/routes/sources.ts` (`GET /sources`, `PATCH /sources/:sourceId`, `DELETE /sources/:sourceId`)
- Test: `test/integration/zones.test.ts` (append)

**Interfaces:**
- Consumes: `callerFor`, `visibleZoneSql`.
- Produces: `POST /connections` and `/connections/preview` answer 400 `personal_space_not_grantable` when any referenced Space is personal.

- [ ] **Step 1: Write the failing tests** — append:

```ts
describe('connections and sources hide other members\' personal rows', () => {
  test("GET /connections omits other members' private connections", async () => {
    const body = await (await hit('GET', '/api/connections', fx.owner.cookie)).json() as { connections: Array<{ id: string }> };
    const ids = body.connections.map((c) => c.id);
    expect(ids).toContain(fx.owner.privateConnectionId);
    expect(ids).not.toContain(fx.alice.privateConnectionId);
  });

  test("an owner cannot revoke a member's private connection", async () => {
    expect((await hit('POST', `/api/connections/${fx.alice.privateConnectionId}/revoke`, fx.owner.cookie, {})).status).toBe(404);
  });

  test('an admin cannot create a connection that touches a personal Space', async () => {
    const res = await hit('POST', '/api/connections', fx.admin.cookie, {
      membershipId: fx.bob.membershipId, writeSpaceId: fx.companySpaceId,
      readSpaceIds: [fx.alice.privateSpaceId], harness: 'generic',
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('personal_space_not_grantable');
  });

  test("GET /sources omits other members' private Spaces; PATCH/DELETE on them is unknown", async () => {
    const body = await (await hit('GET', '/api/sources', fx.owner.cookie)).json() as { sources: Array<{ sourceId: string }> };
    const ids = body.sources.map((s) => s.sourceId);
    expect(ids).toContain(fx.owner.privateSourceId);
    expect(ids).not.toContain(fx.alice.privateSourceId);
    expect((await hit('PATCH', `/api/sources/${fx.alice.privateSourceId}`, fx.owner.cookie, { name: 'x' })).status).toBe(400);
    expect((await hit('DELETE', `/api/sources/${fx.alice.privateSourceId}`, fx.owner.cookie, { mode: 'archive' })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/integration/zones.test.ts` → FAIL.

- [ ] **Step 3: Implement connections**

In `src/control/routes/connections.ts` add `import { callerFor, visibleZoneSql } from '../zone.ts';`, add `getTableColumns, inArray, isNotNull` to the `drizzle-orm` import, then add:

```ts
/** Zones: a connection an admin issues lives in the company zone. A personal
 *  Space is reachable only through its owner's own private connection. */
async function assertCompanyOnly(input: ConnectionInput): Promise<void> {
  const ids = [input.writeSpaceId, ...input.readSpaceIds];
  const [personal] = await getDb().select({ id: schema.spaces.id }).from(schema.spaces).where(and(
    eq(schema.spaces.organizationId, input.organizationId),
    inArray(schema.spaces.id, ids),
    isNotNull(schema.spaces.ownerMembershipId),
  ));
  if (personal) throw Object.assign(new Error('personal_space_not_grantable'), { status: 400 });
}
```

Call `await assertCompanyOnly(input);` in `POST /connections/preview` (before `previewConnection`) and in `POST /connections` (before `createPendingConnection`).

Replace `GET /connections`:

```ts
connectionRoutes.get('/connections', guard('admin', async (c, ctx) => {
  const caller = await callerFor(ctx);
  const rows = await getDb().select(getTableColumns(schema.connections))
    .from(schema.connections)
    .leftJoin(schema.spaces, eq(schema.spaces.id, schema.connections.writeSpaceId))
    .where(and(eq(schema.connections.organizationId, caller.orgId), visibleZoneSql(caller)));
  return c.json({ connections: rows });
}));
```

In `POST /connections/:id/revoke`, select the write Space's owner too and 404 when it is someone else's:

```ts
connectionRoutes.post('/connections/:id/revoke', guard('admin', async (c, ctx) => {
  const caller = await callerFor(ctx);
  const id = c.req.param('id');
  const [row] = await getDb().select({ id: schema.connections.id })
    .from(schema.connections)
    .leftJoin(schema.spaces, eq(schema.spaces.id, schema.connections.writeSpaceId))
    .where(and(
      eq(schema.connections.id, id),
      eq(schema.connections.organizationId, caller.orgId),
      visibleZoneSql(caller),
    ));
  if (!row) return c.json({ error: 'connection not found' }, 404);
  await revokeConnection(id, caller.userId);
  return c.json({ ok: true });
}));
```

- [ ] **Step 4: Implement sources**

In `src/control/routes/sources.ts` add `import { callerFor } from '../zone.ts';`.

In `GET /sources`, after `requireRole`, compute the hidden set and filter `packResolved` before mapping:

```ts
sourceRoutes.get('/sources', guard('admin', async (c, ctx) => {
  const caller = await callerFor(ctx);
  const orgId = caller.orgId;
  const hidden = new Set((await getDb().select({
    sourceId: schema.spaces.sourceId, owner: schema.spaces.ownerMembershipId,
  }).from(schema.spaces).where(eq(schema.spaces.organizationId, orgId)))
    .filter((s) => s.owner !== null && s.owner !== caller.membershipId)
    .map((s) => s.sourceId));

  const [packResolvedAll, listed] = await Promise.all([
    resolveSourcePacks(orgId),
    callOps<{ sources: GbrainSource[] }>('sources.list', {}, { json: true, timeoutMs: 60_000 }),
  ]);
  const packResolved = packResolvedAll.filter((s) => !hidden.has(s.sourceId));
```

and in the same handler, make `unregistered` also exclude hidden ids:

```ts
  const known = new Set(packResolvedAll.map((s) => s.sourceId));
  const unregistered = (gbrain ?? []).filter((s) => !known.has(s.id) && !hidden.has(s.id)).map((s) => s.id);
```

In `PATCH` and `DELETE /sources/:sourceId`, right after `const space = await spaceFor(orgId, sourceId);`, treat someone else's personal Space as unknown (both handlers: change the destructure to `(c, ctx)`, add `const caller = await callerFor(ctx); const { userId, orgId } = caller;` as the first line):

```ts
  if (!space || (space.ownerMembershipId !== null && space.ownerMembershipId !== caller.membershipId)) {
    return c.json({ error: `unknown source ${sourceId}` }, 400);
  }
```

(replacing the existing `if (!space) return …` line).

- [ ] **Step 5: Run the tests**

Run: `bun test test/integration/zones.test.ts` → PASS
Run: `bun test test/integration/connections.test.ts` and `bun test test/integration/sources-routes.test.ts` → PASS

- [ ] **Step 6: Commit**

```bash
git add src/control/routes/connections.ts src/control/routes/sources.ts test/integration/zones.test.ts
git commit -m "fix(zones): admins cannot list, revoke, grant into or rename a member's private Space

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Spend shows personal automations only as a per-member total

**Files:**
- Modify: `src/control/spend.ts` (`spendBySchedule`, new `collapsePersonal`)
- Test: `test/unit/spend.test.ts` (append), `test/integration/zones.test.ts` (append)

**Interfaces:**
- Produces: `collapsePersonal(row: { scheduleId: string | null; scheduleLabel: string | null; ownerMembershipId: string | null; ownerEmail: string | null; costUsd: string | null }): { scheduleId: string | null; scheduleLabel: string | null; costUsd: string | null }`

- [ ] **Step 1: Write the failing unit test** — append to `test/unit/spend.test.ts`:

```ts
import { collapsePersonal } from '../../src/control/spend.ts';

describe('collapsePersonal — admins never see personal schedule names', () => {
  test('a company schedule keeps its id and name', () => {
    expect(collapsePersonal({
      scheduleId: 's1', scheduleLabel: 'company-sync', ownerMembershipId: null, ownerEmail: null, costUsd: '0.10',
    })).toEqual({ scheduleId: 's1', scheduleLabel: 'company-sync', costUsd: '0.10' });
  });

  test('a personal schedule becomes one row per member', () => {
    expect(collapsePersonal({
      scheduleId: 's2', scheduleLabel: 'alice-inbox-digest', ownerMembershipId: 'm-alice',
      ownerEmail: 'alice@example.test', costUsd: '0.25',
    })).toEqual({
      scheduleId: 'personal:m-alice', scheduleLabel: 'Personal automations (alice@example.test)', costUsd: '0.25',
    });
  });

  test('a departed owner is still collapsed, never named by schedule', () => {
    expect(collapsePersonal({
      scheduleId: 's3', scheduleLabel: 'secret', ownerMembershipId: 'm-gone', ownerEmail: null, costUsd: null,
    }).scheduleLabel).toBe('Personal automations (former member)');
  });
});
```

(If `describe` is not already imported at the top of that file, add it to the `bun:test` import.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/unit/spend.test.ts` → FAIL (`collapsePersonal` not exported).

- [ ] **Step 3: Implement** — in `src/control/spend.ts` add `import { alias } from 'drizzle-orm/pg-core';` and replace `spendBySchedule`:

```ts
/**
 * Zones spec D4: an admin sees a member's personal automations only as ONE
 * row per member — the total, never which automations they run.
 */
export function collapsePersonal(row: {
  scheduleId: string | null; scheduleLabel: string | null;
  ownerMembershipId: string | null; ownerEmail: string | null; costUsd: string | null;
}): { scheduleId: string | null; scheduleLabel: string | null; costUsd: string | null } {
  if (row.ownerMembershipId === null) {
    return { scheduleId: row.scheduleId, scheduleLabel: row.scheduleLabel, costUsd: row.costUsd };
  }
  return {
    scheduleId: `personal:${row.ownerMembershipId}`,
    scheduleLabel: `Personal automations (${row.ownerEmail ?? 'former member'})`,
    costUsd: row.costUsd,
  };
}

/** Per schedule, with personal schedules collapsed per member (above). */
export async function spendBySchedule(orgId: string, days: number): Promise<SpendRow[]> {
  const owner = alias(schema.memberships, 'space_owner');
  const ownerUser = alias(schema.users, 'space_owner_user');
  const rows = await getDb().select({
    scheduleId: schema.schedules.id,
    scheduleLabel: schema.schedules.name,
    ownerMembershipId: schema.spaces.ownerMembershipId,
    ownerEmail: ownerUser.email,
    costUsd: schema.agentRuns.costUsd,
  })
    .from(schema.agentRuns)
    .innerJoin(schema.scheduleRuns, eq(schema.agentRuns.runId, schema.scheduleRuns.id))
    .leftJoin(schema.schedules, eq(schema.scheduleRuns.scheduleId, schema.schedules.id))
    .leftJoin(schema.connections, eq(schema.agentRuns.connectionId, schema.connections.id))
    .leftJoin(schema.spaces, eq(schema.connections.writeSpaceId, schema.spaces.id))
    .leftJoin(owner, eq(schema.spaces.ownerMembershipId, owner.id))
    .leftJoin(ownerUser, eq(owner.userId, ownerUser.id))
    .where(and(eq(schema.agentRuns.organizationId, orgId), withinWindow(days)));

  return rollup(rows.map(collapsePersonal), 'scheduleId', 'scheduleLabel');
}
```

- [ ] **Step 4: Add the integration assertion** — append to `test/integration/zones.test.ts`:

```ts
describe('spend', () => {
  test("the admin Spend page never names a member's personal schedule", async () => {
    const body = await (await hit('GET', '/api/spend?days=30', fx.owner.cookie)).json() as {
      ours: { bySchedule: Array<{ key: string; label: string }>; byMember: Array<{ label: string }> };
    };
    const labels = body.ours.bySchedule.map((r) => r.label);
    expect(labels).not.toContain('alice-calendar-prep');
    expect(labels).toContain('Personal automations (z-alice@example.test)');
    expect(body.ours.byMember.map((r) => r.label)).toContain('z-alice@example.test');
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/unit/spend.test.ts` → PASS
Run: `bun test test/integration/zones.test.ts` → PASS
Run: `bun test test/integration/spend.test.ts` → PASS

- [ ] **Step 6: Commit**

```bash
git add src/control/spend.ts test/unit/spend.test.ts test/integration/zones.test.ts
git commit -m "feat(zones): Spend collapses personal automations to one row per member

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: A member scopes their own agent's company reads

**Files:**
- Create: `src/control/routes/myConnection.ts`
- Modify: `src/control/app.ts` (mount)
- Test: `test/integration/zones.test.ts` (append)

**Interfaces:**
- Consumes: `callerFor`, `isAdminRole` (Task 1); `grantsFor` (Task 2); `provisionConnection` (connections.ts).
- Produces:
  - `GET /api/my/connection` (viewer) → `{ space: { id, sourceId, name }, connection: { id, state, readSpaceIds: string[] } | null, readable: Array<{ id, sourceId, name }> }`; 404 `no_private_space`
  - `PUT /api/my/connection` (viewer) body `{ readSpaceIds: string[] }` → `{ ok: true, readSpaceIds }`; 400 `space_not_readable`; 404 `no_private_connection`; 409 `connection_pending`
  - `export const myConnectionRoutes: Hono`

- [ ] **Step 1: Write the failing tests** — append:

```ts
describe('my connection — self-service read scope', () => {
  test('a member without a grant has nothing readable; with one they can add it', async () => {
    const before = await (await hit('GET', '/api/my/connection', fx.bob.cookie)).json() as {
      space: { id: string }; connection: { id: string; readSpaceIds: string[] } | null; readable: Array<{ id: string }>;
    };
    expect(before.space.id).toBe(fx.bob.privateSpaceId);
    expect(before.connection?.id).toBe(fx.bob.privateConnectionId);
    expect(before.readable).toEqual([]);

    const refused = await hit('PUT', '/api/my/connection', fx.bob.cookie, { readSpaceIds: [fx.companySpaceId] });
    expect(refused.status).toBe(400);
    expect((await refused.json() as { error: string }).error).toBe('space_not_readable');

    await hit('PUT', '/api/grants', fx.admin.cookie, {
      membershipId: fx.bob.membershipId, spaceId: fx.companySpaceId, access: 'read',
    });
    const ok = await hit('PUT', '/api/my/connection', fx.bob.cookie, { readSpaceIds: [fx.companySpaceId] });
    expect(ok.status).toBe(200);

    const [conn] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.id, fx.bob.privateConnectionId));
    expect(conn?.readSpaceIds).toEqual([fx.companySpaceId]);
  });

  test("another member's private Space is never readable", async () => {
    const res = await hit('PUT', '/api/my/connection', fx.bob.cookie, { readSpaceIds: [fx.alice.privateSpaceId] });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/integration/zones.test.ts` → FAIL (404, route missing).

- [ ] **Step 3: Implement**

```ts
// src/control/routes/myConnection.ts
/**
 * Zones spec §5.1 — a member manages their OWN private connection's read scope.
 *
 * There is exactly one connection per (member, write Space): the client name
 * is `bs-<member8>-<spaceSlug>` and must be unique (connections.ts
 * `assertNoCollision`). So "my agent" is the private connection
 * `provisionPrivateSpace` created, and self-service is choosing which company
 * Spaces it may read — within the member's grants.
 */
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { requireRole, type Role } from '../rbac.ts';
import { callerFor, isAdminRole, type Caller } from '../zone.ts';
import { grantsFor } from '../grants.ts';
import { provisionConnection } from '../connections.ts';

export const myConnectionRoutes = new Hono();

const guard = (handler: (c: any, caller: Caller) => Promise<Response>) =>
  async (c: any) => {
    let ctx: { userId: string; orgId: string; role: Role };
    try { ctx = await requireRole(c, 'viewer'); } catch (r) { return r as Response; }
    try { return await handler(c, await callerFor(ctx)); }
    catch (e: any) { return c.json({ error: e?.message ?? 'my_connection_error' }, e?.status ?? 400); }
  };

async function mine(caller: Caller) {
  const [space] = await getDb().select().from(schema.spaces).where(and(
    eq(schema.spaces.organizationId, caller.orgId),
    eq(schema.spaces.ownerMembershipId, caller.membershipId),
  ));
  if (!space) return { space: null, connection: null };
  const [connection] = await getDb().select().from(schema.connections).where(and(
    eq(schema.connections.organizationId, caller.orgId),
    eq(schema.connections.membershipId, caller.membershipId),
    eq(schema.connections.writeSpaceId, space.id),
    inArray(schema.connections.state, ['pending', 'active']),
  ));
  return { space, connection: connection ?? null };
}

/** Company Spaces this caller may read: all of them for an admin, else granted ones. */
async function readable(caller: Caller) {
  const company = await getDb().select({ id: schema.spaces.id, sourceId: schema.spaces.sourceId, name: schema.spaces.name })
    .from(schema.spaces)
    .where(and(eq(schema.spaces.organizationId, caller.orgId), isNull(schema.spaces.ownerMembershipId)));
  if (isAdminRole(caller.role)) return company;
  const granted = new Set((await grantsFor(caller.orgId, caller.membershipId)).map((g) => g.spaceId));
  return company.filter((s) => granted.has(s.id));
}

myConnectionRoutes.get('/my/connection', guard(async (c, caller) => {
  const { space, connection } = await mine(caller);
  if (!space) return c.json({ error: 'no_private_space' }, 404);
  const reads = Array.isArray(connection?.readSpaceIds)
    ? (connection!.readSpaceIds as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  return c.json({
    space: { id: space.id, sourceId: space.sourceId, name: space.name },
    connection: connection ? { id: connection.id, state: connection.state, readSpaceIds: reads } : null,
    readable: await readable(caller),
  });
}));

myConnectionRoutes.put('/my/connection', guard(async (c, caller) => {
  const body = await c.req.json().catch(() => ({}));
  const requested = Array.isArray(body?.readSpaceIds)
    ? [...new Set((body.readSpaceIds as unknown[]).filter((x): x is string => typeof x === 'string'))]
    : null;
  if (requested === null) return c.json({ error: 'readSpaceIds is required' }, 400);

  const { space, connection } = await mine(caller);
  if (!space || !connection) return c.json({ error: 'no_private_connection' }, 404);
  if (connection.state === 'pending') return c.json({ error: 'connection_pending' }, 409);

  const allowed = new Set((await readable(caller)).map((s) => s.id));
  if (requested.some((id) => !allowed.has(id))) return c.json({ error: 'space_not_readable' }, 400);

  await provisionConnection({
    organizationId: caller.orgId, membershipId: caller.membershipId, writeSpaceId: space.id,
    readSpaceIds: requested, harness: connection.harness, memberRole: caller.role,
    connectionId: connection.id, tokenTtl: connection.tokenTtl,
  }, caller.userId);

  await getDb().insert(schema.auditLog).values({
    id: randomUUID(), organizationId: caller.orgId, actor: caller.userId,
    action: 'connection.selfScope', target: connection.id, before: null,
    after: { readSpaces: requested.length },
  });
  return c.json({ ok: true, readSpaceIds: requested });
}));
```

In `src/control/app.ts`: `import { myConnectionRoutes } from './routes/myConnection.ts';` and `app.route('/api', myConnectionRoutes);` after the `grantRoutes` mount.

- [ ] **Step 4: Run the tests**

Run: `bun test test/integration/zones.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/control/routes/myConnection.ts src/control/app.ts test/integration/zones.test.ts
git commit -m "feat(zones): members choose which granted company Spaces their agent reads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Admin grant editor in the console

**Files:**
- Modify: `src/console/api.ts` (add `grantsApi`)
- Create: `src/console/pages/GrantsCard.tsx`
- Modify: `src/console/pages/Access.tsx` (render `<GrantsCard …/>`)
- Test: `test/unit/grants-card.test.ts`

**Interfaces:**
- Consumes: `GET/PUT/DELETE /api/grants` (Task 3).
- Produces: `grantsApi.list()`, `grantsApi.put(row)`, `grantsApi.remove(membershipId, spaceId)`; `nextAccess(current: 'none'|'read'|'write'): 'none'|'read'|'write'`; `GrantsCard({ members, spaces })`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/grants-card.test.ts
import { test, expect } from 'bun:test';
import { nextAccess } from '../../src/console/pages/GrantsCard.tsx';

test('a grant cell cycles none → read → write → none', () => {
  expect(nextAccess('none')).toBe('read');
  expect(nextAccess('read')).toBe('write');
  expect(nextAccess('write')).toBe('none');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/unit/grants-card.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

Append to `src/console/api.ts`:

```ts
/** Zones D7 — admin-issued access to COMPANY Spaces. */
export type GrantRow = { membershipId: string; spaceId: string; access: 'read' | 'write' };

export const grantsApi = {
  list: () => api.get<{ grants: GrantRow[] }>('/grants'),
  put: (row: GrantRow) => api.put<{ ok: true }>('/grants', row),
  remove: (membershipId: string, spaceId: string) =>
    api.delete<{ removed: boolean; revoked: string[]; rescoped: string[] }>('/grants', { membershipId, spaceId }),
};
```

```tsx
// src/console/pages/GrantsCard.tsx
import { useEffect, useState } from 'react';
import { grantsApi, type GrantRow } from '../api.ts';
import { Button, Card, Notice } from '../ui/index.tsx';

type Access = 'none' | 'read' | 'write';
type Member = { id: string; email: string; role: string };
type Space = { id: string; name: string };

/** One click moves a cell one step; removing a grant is the step after write. */
export function nextAccess(current: Access): Access {
  return current === 'none' ? 'read' : current === 'read' ? 'write' : 'none';
}

/**
 * Who may read or write each COMPANY Space. Admins and owners are not listed:
 * they reach every company Space without a grant. Personal Spaces never
 * appear — nobody but their owner can be given them.
 */
export function GrantsCard({ members, spaces }: { members: Member[]; spaces: Space[] }) {
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => setGrants((await grantsApi.list()).grants);
  useEffect(() => { void load().catch((e) => setError(String(e?.message ?? e))); }, []);

  const grantees = members.filter((m) => m.role === 'member' || m.role === 'viewer');
  const accessOf = (membershipId: string, spaceId: string): Access =>
    grants.find((g) => g.membershipId === membershipId && g.spaceId === spaceId)?.access ?? 'none';

  const cycle = async (membershipId: string, spaceId: string) => {
    setBusy(true); setError(null);
    try {
      const next = nextAccess(accessOf(membershipId, spaceId));
      if (next === 'none') await grantsApi.remove(membershipId, spaceId);
      else await grantsApi.put({ membershipId, spaceId, access: next });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Grant change failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h2 className="font-medium">Company access</h2>
      <p className="text-sm text-muted">
        Click a cell to cycle none → read → write. Removing access also revokes the
        member's connections that used it.
      </p>
      {error && <Notice tone="danger">{error}</Notice>}
      {grantees.length === 0 || spaces.length === 0 ? (
        <p className="text-sm text-muted">No members or company Spaces yet.</p>
      ) : (
        <table className="text-sm">
          <thead>
            <tr><th className="text-left pr-4">Member</th>{spaces.map((s) => <th key={s.id} className="pr-4">{s.name}</th>)}</tr>
          </thead>
          <tbody>
            {grantees.map((m) => (
              <tr key={m.id}>
                <td className="pr-4">{m.email}</td>
                {spaces.map((s) => (
                  <td key={s.id} className="pr-4">
                    <Button disabled={busy} onClick={() => cycle(m.id, s.id)}>{accessOf(m.id, s.id)}</Button>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
```

In `src/console/pages/Access.tsx`:
- Add `import { GrantsCard } from './GrantsCard.tsx';`.
- Extend the local `Space` type on line 16 to `type Space = { id: string; sourceId: string; name: string; ownerMembershipId?: string | null };` (the `/access-overview` payload already carries `ownerMembershipId`).
- Render the card as the first child of the page's top-level returned container:

```tsx
<GrantsCard members={members} spaces={spaces.filter((s) => !s.ownerMembershipId)} />
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test test/unit/grants-card.test.ts` → PASS
Run: `bunx tsc --noEmit -p tsconfig.json` → no new errors in `src/console/pages/GrantsCard.tsx` or `Access.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/console/api.ts src/console/pages/GrantsCard.tsx src/console/pages/Access.tsx test/unit/grants-card.test.ts
git commit -m "feat(console): company access grid on the Access tab

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Full verification

**Files:** none new; fixes only where a suite regresses.

- [ ] **Step 1: Unit suite**

Run: `bun run test:unit`
Expected: all pass. Any failure referencing `accessFromConnections` means a test still imports the removed export — port its cases to `accessFromGrants` semantics (a personal Space is `write` for its owner with no connection).

- [ ] **Step 2: Integration suite, isolated**

Run: `bun run test:integration:isolated`
Expected: `0 failed`. For a failure in a test that inserts connection rows directly and then asserts access, add the implied `space_grants` row (see Task 2 Step 10).

- [ ] **Step 3: Lint the forbidden patterns**

Run: `bun run lint:forbidden`
Expected: pass.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A test src
git commit -m "test(zones): align suites with grant-based access

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Skip this commit if Steps 1-3 needed no changes.
