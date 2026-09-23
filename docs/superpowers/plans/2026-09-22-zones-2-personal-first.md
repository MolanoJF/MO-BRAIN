# Zones 2 — Personal-First Setup and the Company Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fresh install sets up a personal brain on `gbrain-base-v2` with no schema or mode decisions, and the owner can later turn it into a company brain (and back, while still alone) from Settings → General.

**Architecture:** `organizations.brain_mode` (already in the schema, currently unread) becomes the one flag. `src/control/capabilities.ts` maps it to named capabilities (`invite`, `sharedSources`, `grants`) and a `requireCapability` guard that team routes call. A new `/api/org` route exposes the mode and lets the owner switch it under the D3 rule. The console reads the mode through an `OrgContext` and hides team surfaces in personal mode.

**Tech Stack:** Bun 1.3, Hono, Drizzle ORM (Postgres), React 19 console, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-09-22-personal-and-company-zones-design.md` (§1, D3, D5, D6, §5.2)

**Depends on:** `docs/superpowers/plans/2026-09-22-zones-1-privacy.md` (the grants routes it gates, and `test/helpers/zoneFixture.ts`).

## Global Constraints

- New bootstraps write `brain_mode = 'personal'` and `brains.schema_pack = 'gbrain-base-v2'`. Existing organizations are not migrated — they keep `'company'`.
- A personal-mode refusal is `403 { "error": "company_mode_required" }`.
- Company → personal (D3) only when the org has exactly one membership and no claim link that is unclaimed and unexpired; otherwise `409 { "error": "team_exists" }`.
- Only the `owner` may change the mode; `admin` may rename the brain.
- No lifecycle states are added or removed; legacy brains mid-wizard without a stored pack still get the Schema step.
- Integration tests: `bun test test/integration/<file>.test.ts` against the control Postgres; see plan 1's Global Constraints.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The untracked `docs/superpowers/plans/2026-09-22-google-exclusive-auth.md` introduces `createOrgForNewAdmin`; when it lands after this plan, that helper must take the `brainMode`/`schemaPack` defaults from `bootstrapFirstAdmin` below, not re-hardcode `'company'`.

## File Structure

| File | Responsibility |
|---|---|
| `src/control/bootstrap.ts` | Personal + default pack; optional mode for tests |
| `src/control/routes/auth.ts` | Optional brain name with a default |
| `src/control/routes/wizard.ts` | Search-mode step also passes `schema-selected` when a pack is stored |
| `src/control/capabilities.ts` (new) | Mode → capabilities; `requireCapability` |
| `src/control/routes/members.ts`, `sources.ts`, `grants.ts`, `wizard.ts` | Enforce capabilities |
| `src/control/routes/org.ts` (new) | `GET /api/org`, `PATCH /api/org`, `PATCH /api/org/mode` |
| `src/console/OrgContext.tsx` (new) | `OrgProvider`, `useOrg()` |
| `src/console/settings/tabs.ts`, `SettingsPanel.tsx`, `AppShell.tsx`, `App.tsx` | `general` tab; hide team tabs in personal mode |
| `src/console/pages/General.tsx` (new) | Brain name + company switch |
| `src/console/pages/Bootstrap.tsx`, `Wizard.tsx`, `Sources.tsx` | Copy; hide add-source in personal mode |

---

### Task 1: Bootstrap creates a personal brain on the default pack

**Files:**
- Modify: `src/control/bootstrap.ts:17-43`
- Modify: `src/control/routes/auth.ts:13-23`
- Modify: `test/integration/auth.test.ts:97-101`
- Modify: `test/helpers/zoneFixture.ts` (company mode for the zones fixture)
- Modify: `test/integration/private-spaces.test.ts`, `test/integration/routes.test.ts`, `test/integration/sources-routes.test.ts`, `test/integration/wizard.test.ts` (their `bootstrapFirstAdmin` call)

**Interfaces:**
- Produces: `bootstrapFirstAdmin(email: string, password: string, orgName: string, opts?: { brainMode?: 'personal' | 'company' }): Promise<{ userId: string; orgId: string; brainId: string }>`; `defaultBrainName(email: string): string`; `DEFAULT_SCHEMA_PACK = 'gbrain-base-v2'`.

- [ ] **Step 1: Write the failing test** — replace the `'the org defaults to company mode'` test in `test/integration/auth.test.ts` (line 97-101) with:

```ts
  // Zones spec D6: every install starts as ONE person's brain on gbrain's
  // recommended default pack. Company mode is a later settings change.
  test('the org starts in personal mode on gbrain-base-v2', async () => {
    const [o] = await getDb().select().from(schema.organizations);
    expect(o?.brainMode).toBe('personal');
    const [b] = await getDb().select().from(schema.brains);
    expect(b?.schemaPack).toBe('gbrain-base-v2');
  });
```

and add, in the same `describe`, a unit-level check of the default name (the import goes with the file's other dynamic imports):

```ts
  test('a brain name defaults from the email', async () => {
    const { defaultBrainName } = await import('../../src/control/bootstrap.ts');
    expect(defaultBrainName('jane.doe@example.test')).toBe("jane.doe's brain");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/integration/auth.test.ts`
Expected: FAIL — `brainMode` is `'company'`; `defaultBrainName` is not exported.

- [ ] **Step 3: Implement** — in `src/control/bootstrap.ts`:

```ts
/** Zones spec D6: the pack gbrain itself recommends, stored explicitly so the
 *  Schema tab shows it and `diverged` checks have a stored value to compare. */
export const DEFAULT_SCHEMA_PACK = 'gbrain-base-v2';

export function defaultBrainName(email: string): string {
  const local = email.split('@')[0]?.trim() || 'My';
  return `${local}'s brain`;
}

/**
 * Creates the first user, their org, and an UNINITIALIZED brain row. The brain
 * becomes real only when the wizard runs `gbrain init`.
 *
 * Zones spec D6: a fresh install is a PERSONAL brain. `opts.brainMode` exists
 * for test setups that exercise team routes; the HTTP route never passes it.
 */
export async function bootstrapFirstAdmin(
  email: string, password: string, orgName: string,
  opts: { brainMode?: 'personal' | 'company' } = {},
) {
  if (await isBootstrapped()) throw new Error('already_bootstrapped');

  const signed = await auth.api.signUpEmail({ body: { email, password, name: email } });
  const userId = (signed as { user?: { id?: string } }).user?.id;
  if (!userId) throw new Error('sign_up_failed');

  const orgId = randomUUID();
  const brainId = randomUUID();
  const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'org';
  const brainMode = opts.brainMode ?? 'personal';

  const db = getDb();
  await db.insert(schema.organizations).values({ id: orgId, name: orgName, slug, brainMode });
  await db.insert(schema.memberships).values({ id: randomUUID(), userId, organizationId: orgId, role: 'owner' });
  await db.insert(schema.brains).values({
    id: brainId, organizationId: orgId,
    gbrainHome: process.env.GBRAIN_HOME ?? '/srv/gbrain-home',
    engine: 'postgres', gbrainVersion: process.env.GBRAIN_VERSION ?? null,
    lifecycle: 'uninitialized',
    schemaPack: DEFAULT_SCHEMA_PACK,
  });
  await db.insert(schema.auditLog).values({
    id: randomUUID(), organizationId: orgId, actor: userId,
    action: 'bootstrap', target: orgId, before: null, after: { orgName, slug, brainMode },
  });

  return { userId, orgId, brainId };
}
```

In `src/control/routes/auth.ts`, change the import to `import { isBootstrapped, bootstrapFirstAdmin, defaultBrainName } from '../bootstrap.ts';` and the POST handler to:

```ts
authRoutes.post('/bootstrap', async (c) => {
  if (await isBootstrapped()) return c.json({ error: 'already_bootstrapped' }, 409);
  const { email, password, orgName } = await c.req.json();
  if (!email || !password) return c.json({ error: 'email and password are required' }, 400);
  // Zones spec D6: the name is optional — a personal brain is named after its person.
  const name = typeof orgName === 'string' && orgName.trim() ? orgName.trim() : defaultBrainName(String(email));
  try {
    // S3c: the request carries a password — nothing here logs the body.
    return c.json(await bootstrapFirstAdmin(email, password, name));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'bootstrap_failed' }, 400);
  }
});
```

- [ ] **Step 4: Keep team-route test setups in company mode**

These suites exercise invites, claim links or shared sources, which Task 3 gates behind company mode. Change each file's `bootstrapFirstAdmin(…)` call to pass `{ brainMode: 'company' }` as the fourth argument:

- `test/integration/private-spaces.test.ts`
- `test/integration/routes.test.ts`
- `test/integration/sources-routes.test.ts`
- `test/integration/wizard.test.ts`
- `test/helpers/zoneFixture.ts` (`bootstrapFirstAdmin('z-owner@example.test', PASS, 'ZoneCo', { brainMode: 'company' })`)

Example (`wizard.test.ts:158`):

```ts
  ({ orgId } = await bootstrapFirstAdmin('admin@example.test', 'a-long-enough-password', 'Acme', { brainMode: 'company' }));
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/integration/auth.test.ts` → PASS
Run: `bun test test/integration/zones.test.ts` → PASS

- [ ] **Step 6: Commit**

```bash
git add src/control/bootstrap.ts src/control/routes/auth.ts test/integration/auth.test.ts test/helpers/zoneFixture.ts \
  test/integration/private-spaces.test.ts test/integration/routes.test.ts test/integration/sources-routes.test.ts test/integration/wizard.test.ts
git commit -m "feat(setup): a fresh install is a personal brain on gbrain-base-v2

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The wizard has no schema step

**Files:**
- Modify: `src/control/routes/wizard.ts:126-135` (`POST /search-mode`)
- Modify: `src/console/pages/Bootstrap.tsx`, `src/console/pages/Wizard.tsx` (copy)
- Modify: `test/integration/wizard.test.ts:220-225`

**Interfaces:**
- Produces: `POST /api/wizard/search-mode` responds `{ ok: true, lifecycle: 'schema-selected' | 'mode-selected', mode }` — `schema-selected` whenever `brains.schema_pack` is already stored.

- [ ] **Step 1: Update the failing test** — in `test/integration/wizard.test.ts` replace `'the search-mode step records the choice'`:

```ts
  // Zones spec D6: the pack is stored at bootstrap, so choosing a search mode
  // is the last decision before the private Space — there is no Schema step.
  test('the search-mode step records the choice and passes the stored pack', async () => {
    const res = await call('/api/wizard/search-mode', { mode: 'conservative' });
    expect(res.status).toBe(200);
    expect((await res.json() as { lifecycle: string }).lifecycle).toBe('schema-selected');
    const [brain] = await getDb().select().from(schema.brains);
    expect(brain?.searchMode).toBe('conservative');
    expect(brain?.lifecycle).toBe('schema-selected');
    expect(brain?.schemaPack).toBe('gbrain-base-v2');
  });

  test('a legacy brain with no stored pack still stops at the Schema step', async () => {
    const [brain] = await getDb().select().from(schema.brains);
    await getDb().update(schema.brains).set({ lifecycle: 'provider-configured', schemaPack: null })
      .where(eq(schema.brains.id, brain!.id));
    const res = await call('/api/wizard/search-mode', { mode: 'conservative' });
    expect((await res.json() as { lifecycle: string }).lifecycle).toBe('mode-selected');
    await getDb().update(schema.brains).set({ lifecycle: 'schema-selected', schemaPack: 'gbrain-base-v2' })
      .where(eq(schema.brains.id, brain!.id));
  });
```

The following test (`the private-space step …`) still calls `POST /api/wizard/schema` first; that remains a 200 because `schema-selected → schema-selected` is an idempotent retry (`canAdvance`).

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/integration/wizard.test.ts`
Expected: FAIL — lifecycle is `mode-selected`.

- [ ] **Step 3: Implement** — replace the search-mode route in `src/control/routes/wizard.ts`:

```ts
/**
 * Step 2 — the one mandatory human decision (V4).
 *
 * Zones spec D6: bootstrap stores `gbrain-base-v2`, so when a pack is already
 * stored this step also passes `schema-selected` — the Schema step no longer
 * exists for a fresh install. A legacy brain with no stored pack stops at
 * `mode-selected` and the console still renders the Schema step for it.
 */
wizard.post('/search-mode', guard(async (c, { userId, orgId }) => {
  const { mode } = await c.req.json();
  if (!SEARCH_MODES.some((m) => m.id === mode)) return c.json({ error: `unknown search mode ${mode}` }, 400);

  const brain = await loadBrain(orgId);
  await advance(brain.id, brain.lifecycle as Lifecycle, 'mode-selected', { searchMode: mode });
  let lifecycle: Lifecycle = 'mode-selected';
  if (brain.schemaPack) {
    await advance(brain.id, 'mode-selected', 'schema-selected');
    lifecycle = 'schema-selected';
  }
  await audit(orgId, userId, 'wizard.searchMode', brain.id, { mode, schemaPack: brain.schemaPack ?? null });
  return c.json({ ok: true, lifecycle, mode });
}));
```

Edge: a brain already at `schema-selected` that re-posts the mode would hit `advance(schema-selected → mode-selected)`, which `canAdvance` refuses (409) exactly as before; nothing changes for that retry.

- [ ] **Step 4: Update the console copy**

`src/console/pages/Bootstrap.tsx`:
- Heading: `Create your account`
- Paragraph: `This sets up your own private brain. You can turn it into a company brain later in Settings.`
- Replace the org-name `Input` with an optional one:

```tsx
      <Input placeholder="Name your brain (optional)" value={orgName}
             onChange={(e) => setOrgName(e.target.value)} />
```

- Submit sends the name only when present: `await api.post('/bootstrap', orgName.trim() ? { email, password, orgName } : { email, password });`
- Button label: `{busy ? 'Creating…' : 'Create account'}`

`src/console/pages/Wizard.tsx`: change the `<h1>` to `Set up your brain` → `Set up your personal brain` (the Schema step JSX stays; it renders only when `state.nextStep === 'schema-selected'`, i.e. a legacy brain).

- [ ] **Step 5: Run the tests**

Run: `bun test test/integration/wizard.test.ts` → PASS
Run: `bun test test/unit/wizard-space-step.test.ts test/unit/lifecycle.test.ts` → PASS

- [ ] **Step 6: Commit**

```bash
git add src/control/routes/wizard.ts src/console/pages/Bootstrap.tsx src/console/pages/Wizard.tsx test/integration/wizard.test.ts
git commit -m "feat(setup): the wizard skips the schema step when the default pack is stored

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Capabilities gate the team routes

**Files:**
- Create: `src/control/capabilities.ts`
- Modify: `src/control/routes/members.ts` (`POST /members`, `POST /members/:id/claim-link`)
- Modify: `src/control/routes/sources.ts` (`POST /sources`)
- Modify: `src/control/routes/grants.ts` (`PUT`, `DELETE /grants`)
- Modify: `src/control/routes/wizard.ts` (`POST /space`, the legacy shared-space step)
- Test: `test/unit/capabilities.test.ts`, `test/integration/mode.test.ts` (new)

**Interfaces:**
- Produces:
  - `type BrainMode = 'personal' | 'company'`
  - `type Capability = 'invite' | 'sharedSources' | 'grants'`
  - `capabilitiesFor(mode: BrainMode): Record<Capability, boolean>`
  - `asBrainMode(value: string): BrainMode` (unknown → `'personal'`, the safer surface)
  - `orgMode(orgId: string): Promise<BrainMode>`
  - `requireCapability(orgId: string, cap: Capability): Promise<void>` — throws `Object.assign(new Error('company_mode_required'), { status: 403 })`

- [ ] **Step 1: Write the failing unit test**

```ts
// test/unit/capabilities.test.ts
import { test, expect } from 'bun:test';
import { capabilitiesFor, asBrainMode } from '../../src/control/capabilities.ts';

test('personal mode has no team capabilities', () => {
  expect(capabilitiesFor('personal')).toEqual({ invite: false, sharedSources: false, grants: false });
});

test('company mode has every team capability', () => {
  expect(capabilitiesFor('company')).toEqual({ invite: true, sharedSources: true, grants: true });
});

test('an unknown stored mode reads as personal — the smaller surface', () => {
  expect(asBrainMode('company')).toBe('company');
  expect(asBrainMode('personal')).toBe('personal');
  expect(asBrainMode('enterprise')).toBe('personal');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/unit/capabilities.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/control/capabilities.ts
/**
 * Zones spec D5 — `organizations.brain_mode` is the ONE flag, and this module is
 * the one place it becomes behaviour. Routes ask for a named capability, never
 * for the mode, so a future capability (say, SSO) is one line here.
 */
import { eq } from 'drizzle-orm';
import { getDb, schema } from './db/client.ts';

export type BrainMode = 'personal' | 'company';
export type Capability = 'invite' | 'sharedSources' | 'grants';

export function capabilitiesFor(mode: BrainMode): Record<Capability, boolean> {
  const company = mode === 'company';
  return { invite: company, sharedSources: company, grants: company };
}

export function asBrainMode(value: string): BrainMode {
  return value === 'company' ? 'company' : 'personal';
}

export async function orgMode(orgId: string): Promise<BrainMode> {
  const [org] = await getDb().select({ brainMode: schema.organizations.brainMode })
    .from(schema.organizations).where(eq(schema.organizations.id, orgId));
  return asBrainMode(org?.brainMode ?? 'personal');
}

export async function requireCapability(orgId: string, cap: Capability): Promise<void> {
  if (!capabilitiesFor(await orgMode(orgId))[cap]) {
    throw Object.assign(new Error('company_mode_required'), { status: 403 });
  }
}
```

- [ ] **Step 4: Run the unit test** → `bun test test/unit/capabilities.test.ts` → PASS

- [ ] **Step 5: Write the failing integration test**

```ts
// test/integration/mode.test.ts
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { installOpsMock } from '../helpers/opsMock.ts';

installOpsMock();

const { getDb, schema, closeDb, pinDb, runMigrations } = await import('../../src/control/db/client.ts');
const { bootstrapFirstAdmin } = await import('../../src/control/bootstrap.ts');
const { hit, PASS } = await import('../helpers/zoneFixture.ts');
const { sql, eq } = await import('drizzle-orm');

pinDb();
let orgId = '';
let ownerCookie = '';

beforeAll(async () => {
  await runMigrations();
  await getDb().execute(sql`TRUNCATE users, organizations, runner_presence RESTART IDENTITY CASCADE`);
  ({ orgId } = await bootstrapFirstAdmin('mode-owner@example.test', PASS, 'Solo')); // personal
  const res = await hit('POST', '/api/auth/sign-in/email', undefined, { email: 'mode-owner@example.test', password: PASS });
  ownerCookie = res.headers.get('set-cookie') ?? '';
}, 90_000);

afterAll(async () => { await closeDb(); });

describe('personal mode refuses team routes', () => {
  test('invite, shared source and grants answer company_mode_required', async () => {
    for (const [method, path, body] of [
      ['POST', '/api/members', { email: 'x@example.test', role: 'member' }],
      ['POST', '/api/sources', { sourceId: 'shared-kb', name: 'Shared' }],
      ['PUT', '/api/grants', { membershipId: 'm', spaceId: 's', access: 'read' }],
    ] as const) {
      const res = await hit(method, path, ownerCookie, body);
      expect(res.status).toBe(403);
      expect((await res.json() as { error: string }).error).toBe('company_mode_required');
    }
  });

  test('the same routes open once the org is in company mode', async () => {
    await getDb().update(schema.organizations).set({ brainMode: 'company' }).where(eq(schema.organizations.id, orgId));
    const res = await hit('POST', '/api/members', ownerCookie, { email: 'y@example.test', role: 'member' });
    expect(res.status).toBe(200);
    await getDb().update(schema.organizations).set({ brainMode: 'personal' }).where(eq(schema.organizations.id, orgId));
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `bun test test/integration/mode.test.ts` → FAIL (invite returns 200 in personal mode).

- [ ] **Step 7: Enforce**

In each handler below, add `import { requireCapability } from '../capabilities.ts';` to the file and make the call the handler's **first** statement (every one of these guards already catches a thrown error with a `status` and returns it as JSON):

- `members.ts` `POST /members` and `POST /members/:id/claim-link`: `await requireCapability(orgId, 'invite');`
- `sources.ts` `POST /sources`: `await requireCapability(orgId, 'sharedSources');`
- `grants.ts` `PUT /grants` and `DELETE /grants`: `await requireCapability(orgId, 'grants');`
- `wizard.ts` `POST /space` (the legacy shared-space step at line ~338): `await requireCapability(orgId, 'sharedSources');`

All four route files' `guard` wrappers answer a thrown error as `c.json({ error: e.message }, e.status ?? 400)`, so the 403 passes through unchanged (e.g. `src/control/routes/sources.ts:39-45`).

- [ ] **Step 8: Run the tests**

Run: `bun test test/integration/mode.test.ts` → PASS
Run: `bun test test/integration/private-spaces.test.ts`, `test/integration/sources-routes.test.ts`, `test/integration/zones.test.ts` → PASS (all bootstrap in company mode since Task 1)

- [ ] **Step 9: Commit**

```bash
git add src/control/capabilities.ts src/control/routes/members.ts src/control/routes/sources.ts src/control/routes/grants.ts \
  src/control/routes/wizard.ts test/unit/capabilities.test.ts test/integration/mode.test.ts
git commit -m "feat(zones): personal mode refuses invites, shared sources and grants

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `/api/org` — read the mode, rename, switch

**Files:**
- Create: `src/control/routes/org.ts`
- Modify: `src/control/app.ts` (mount)
- Test: `test/integration/mode.test.ts` (append)

**Interfaces:**
- Consumes: `orgMode`, `capabilitiesFor`, `asBrainMode` (Task 3).
- Produces:
  - `GET /api/org` (viewer) → `{ id, name, brainMode, capabilities: Record<Capability, boolean>, memberCount: number, role: Role }`
  - `PATCH /api/org` (admin) body `{ name }` → `{ ok: true, name }`; 400 `name is required`
  - `PATCH /api/org/mode` (owner) body `{ mode: 'personal'|'company', name?: string }` → `{ ok: true, brainMode }`; 400 `invalid_mode`; 409 `team_exists`
  - `export const orgRoutes: Hono`

- [ ] **Step 1: Write the failing tests** — append to `test/integration/mode.test.ts`:

```ts
describe('/api/org', () => {
  test('GET reports personal mode and its capabilities', async () => {
    const body = await (await hit('GET', '/api/org', ownerCookie)).json() as {
      brainMode: string; capabilities: Record<string, boolean>; memberCount: number; role: string;
    };
    expect(body.brainMode).toBe('personal');
    expect(body.capabilities.invite).toBe(false);
    expect(body.role).toBe('owner');
  });

  test('the owner switches to company and renames in one step', async () => {
    const res = await hit('PATCH', '/api/org/mode', ownerCookie, { mode: 'company', name: 'Acme Inc' });
    expect(res.status).toBe(200);
    const body = await (await hit('GET', '/api/org', ownerCookie)).json() as { brainMode: string; name: string };
    expect(body.brainMode).toBe('company');
    expect(body.name).toBe('Acme Inc');
  });

  test('switching back is refused once anyone else is a member', async () => {
    // `y@example.test` was invited in the previous describe → 2+ memberships.
    const res = await hit('PATCH', '/api/org/mode', ownerCookie, { mode: 'personal' });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe('team_exists');
  });

  test('switching back is allowed while solo with no open invite', async () => {
    const [owner] = await getDb().select().from(schema.users).where(eq(schema.users.email, 'mode-owner@example.test'));
    await getDb().execute(sql`DELETE FROM claim_links WHERE organization_id = ${orgId}`);
    await getDb().execute(sql`DELETE FROM memberships WHERE organization_id = ${orgId} AND user_id <> ${owner!.id}`);
    const res = await hit('PATCH', '/api/org/mode', ownerCookie, { mode: 'personal' });
    expect(res.status).toBe(200);
  });

  test('an unknown mode is rejected', async () => {
    expect((await hit('PATCH', '/api/org/mode', ownerCookie, { mode: 'enterprise' })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/integration/mode.test.ts` → FAIL (404, route missing).

- [ ] **Step 3: Implement**

```ts
// src/control/routes/org.ts
/**
 * The organization's own settings: its name and its mode (zones spec §5.2).
 *
 * Company → personal is D3: allowed only while the owner is the org's ONLY
 * membership and no invite is still claimable. Once someone else could be
 * inside, switching back would strand them, so it is a 409, never a warning.
 * Company Spaces created meanwhile are left as they are — ordinary sources.
 */
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { requireRole, type Role } from '../rbac.ts';
import { asBrainMode, capabilitiesFor } from '../capabilities.ts';

export const orgRoutes = new Hono();

const guard = (min: Role, handler: (c: any, ctx: { userId: string; orgId: string; role: Role }) => Promise<Response>) =>
  async (c: any) => {
    let ctx;
    try { ctx = await requireRole(c, min); } catch (r) { return r as Response; }
    try { return await handler(c, ctx); }
    catch (e: any) { return c.json({ error: e?.message ?? 'org_error' }, e?.status ?? 400); }
  };

async function audit(orgId: string, actor: string, action: string, after: unknown) {
  await getDb().insert(schema.auditLog)
    .values({ id: randomUUID(), organizationId: orgId, actor, action, target: orgId, before: null, after: after as object });
}

async function memberCount(orgId: string): Promise<number> {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.memberships)
    .where(eq(schema.memberships.organizationId, orgId));
  return row?.n ?? 0;
}

async function openInvites(orgId: string): Promise<number> {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.claimLinks)
    .where(and(
      eq(schema.claimLinks.organizationId, orgId),
      isNull(schema.claimLinks.claimedAt),
      gt(schema.claimLinks.expiresAt, new Date()),
    ));
  return row?.n ?? 0;
}

orgRoutes.get('/org', guard('viewer', async (c, { orgId, role }) => {
  const [org] = await getDb().select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
  if (!org) return c.json({ error: 'organization_not_found' }, 404);
  const brainMode = asBrainMode(org.brainMode);
  return c.json({
    id: org.id, name: org.name, brainMode,
    capabilities: capabilitiesFor(brainMode),
    memberCount: await memberCount(orgId),
    role,
  });
}));

orgRoutes.patch('/org', guard('admin', async (c, { userId, orgId }) => {
  const body = await c.req.json().catch(() => ({}));
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return c.json({ error: 'name is required' }, 400);
  await getDb().update(schema.organizations).set({ name }).where(eq(schema.organizations.id, orgId));
  await audit(orgId, userId, 'org.rename', { name });
  return c.json({ ok: true, name });
}));

orgRoutes.patch('/org/mode', guard('owner', async (c, { userId, orgId }) => {
  const body = await c.req.json().catch(() => ({}));
  const mode = body?.mode;
  if (mode !== 'personal' && mode !== 'company') return c.json({ error: 'invalid_mode' }, 400);

  if (mode === 'personal' && ((await memberCount(orgId)) > 1 || (await openInvites(orgId)) > 0)) {
    return c.json({ error: 'team_exists' }, 409);
  }

  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  await getDb().update(schema.organizations)
    .set(name ? { brainMode: mode, name } : { brainMode: mode })
    .where(eq(schema.organizations.id, orgId));
  await audit(orgId, userId, 'org.mode', { mode, renamed: Boolean(name) });
  return c.json({ ok: true, brainMode: mode });
}));
```

Mount in `src/control/app.ts`: `import { orgRoutes } from './routes/org.ts';` and `app.route('/api', orgRoutes);` after the `members` mount.

- [ ] **Step 4: Run the tests**

Run: `bun test test/integration/mode.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/control/routes/org.ts src/control/app.ts test/integration/mode.test.ts
git commit -m "feat(zones): /api/org — owner switches personal <-> company under the solo rule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Console — mode-aware settings and the General tab

**Files:**
- Create: `src/console/OrgContext.tsx`
- Create: `src/console/pages/General.tsx`
- Modify: `src/console/settings/tabs.ts`, `src/console/settings/SettingsPanel.tsx`, `src/console/AppShell.tsx`, `src/console/App.tsx`, `src/console/pages/Sources.tsx`, `src/console/api.ts`
- Modify: `test/unit/console-settings-tabs.test.ts`

**Interfaces:**
- Consumes: `GET /api/org`, `PATCH /api/org`, `PATCH /api/org/mode`.
- Produces:
  - `type OrgInfo = { id: string; name: string; brainMode: 'personal'|'company'; capabilities: { invite: boolean; sharedSources: boolean; grants: boolean }; memberCount: number; role: string }` and `orgApi` (in `api.ts`)
  - `OrgProvider({ children })`, `useOrg(): { org: OrgInfo | null; reload(): Promise<void> }`
  - `visibleTabs(isAdmin: boolean, mode: 'personal'|'company' = 'company')`, `resolveTab(requested, isAdmin, mode = 'company')`
  - `SettingsTab` gains `'general'`; `SettingsTabEntry` gains `companyOnly?: true`

- [ ] **Step 1: Update the failing tabs tests** — in `test/unit/console-settings-tabs.test.ts`:
  - The registry test: expect `['general', 'sources', 'schema', 'members', 'access', 'schedules', 'health', 'spend', 'runs', 'upgrades', 'appearance']` and rename it to `eleven tabs`.
  - The minRole table: add `general: 'admin'`.
  - `an admin sees all ten tabs` → `all eleven` (the assertion compares against `SETTINGS_TABS`, unchanged).
  - Append:

```ts
describe('personal mode hides the team tabs', () => {
  test('an admin in personal mode sees no Members or Access', () => {
    const ids = visibleTabs(true, 'personal').map((t) => t.id);
    expect(ids).not.toContain('members');
    expect(ids).not.toContain('access');
    expect(ids[0]).toBe('general');
  });

  test('company mode is the default and shows them', () => {
    expect(visibleTabs(true).map((t) => t.id)).toContain('members');
    expect(visibleTabs(true, 'company').map((t) => t.id)).toContain('access');
  });

  test('a pasted members URL in personal mode lands on General', () => {
    expect(resolveTab('members', true, 'personal')).toBe('general');
  });

  test('admins open settings on General', () => {
    expect(resolveTab(null, true)).toBe('general');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/unit/console-settings-tabs.test.ts` → FAIL.

- [ ] **Step 3: Implement the registry** — in `src/console/settings/tabs.ts`:

```ts
export type SettingsTab =
  | 'general' | 'sources' | 'schema' | 'members' | 'access' | 'schedules'
  | 'health' | 'spend' | 'runs' | 'upgrades' | 'appearance';

export interface SettingsTabEntry {
  readonly id: SettingsTab;
  readonly label: string;
  readonly minRole: SettingsTabRole;
  /** Zones spec D5: hidden in a personal brain, where the API refuses it anyway. */
  readonly companyOnly?: true;
}
```

Registry (General first — it is where an admin lands, and where the company switch lives):

```ts
export const SETTINGS_TABS: readonly SettingsTabEntry[] = [
  { id: 'general', label: 'General', minRole: 'admin' },
  { id: 'sources', label: 'Sources', minRole: 'admin' },
  { id: 'schema', label: 'Schema', minRole: 'admin' },
  { id: 'members', label: 'Members', minRole: 'admin', companyOnly: true },
  { id: 'access', label: 'Access', minRole: 'admin', companyOnly: true },
  { id: 'schedules', label: 'Schedules', minRole: 'viewer' },
  { id: 'health', label: 'Health', minRole: 'viewer' },
  { id: 'spend', label: 'Spend', minRole: 'admin' },
  { id: 'runs', label: 'Runs', minRole: 'viewer' },
  { id: 'upgrades', label: 'Upgrades', minRole: 'viewer' },
  { id: 'appearance', label: 'Appearance', minRole: 'viewer' },
];
```

```ts
export function visibleTabs(isAdmin: boolean, mode: 'personal' | 'company' = 'company'): SettingsTabEntry[] {
  return SETTINGS_TABS.filter((t) =>
    (isAdmin || t.minRole === 'viewer') && !(mode === 'personal' && t.companyOnly));
}

export function resolveTab(
  requested: string | null, isAdmin: boolean, mode: 'personal' | 'company' = 'company',
): SettingsTab {
  const visible = visibleTabs(isAdmin, mode);
  if (requested !== null && isSettingsTab(requested) && visible.some((t) => t.id === requested)) {
    return requested;
  }
  return visible[0]!.id;
}
```

Update the registry's doc comment sentence "`sources` for an admin" to "`general` for an admin".

- [ ] **Step 4: Run** `bun test test/unit/console-settings-tabs.test.ts` → PASS

- [ ] **Step 5: Org context and API**

Append to `src/console/api.ts`:

```ts
export type OrgInfo = {
  id: string; name: string; brainMode: 'personal' | 'company';
  capabilities: { invite: boolean; sharedSources: boolean; grants: boolean };
  memberCount: number; role: string;
};

export const orgApi = {
  get: () => api.get<OrgInfo>('/org'),
  rename: (name: string) => api.patch<{ ok: true; name: string }>('/org', { name }),
  setMode: (mode: 'personal' | 'company', name?: string) =>
    api.patch<{ ok: true; brainMode: string }>('/org/mode', name ? { mode, name } : { mode }),
};
```

```tsx
// src/console/OrgContext.tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { orgApi, type OrgInfo } from './api.ts';

type OrgState = { org: OrgInfo | null; reload: () => Promise<void> };

const OrgContext = createContext<OrgState>({ org: null, reload: async () => {} });

/**
 * The org's mode, read once per shell and re-read after a switch. `null` while
 * loading or on failure; consumers treat `null` as company mode, which only
 * ever shows MORE — the API still refuses what the mode does not allow.
 */
export function OrgProvider({ children }: { children: ReactNode }) {
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const reload = async () => {
    try { setOrg(await orgApi.get()); } catch { setOrg(null); }
  };
  useEffect(() => { void reload(); }, []);
  return <OrgContext.Provider value={{ org, reload }}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgState {
  return useContext(OrgContext);
}
```

- [ ] **Step 6: Thread the mode through the shell**

`src/console/App.tsx`: import `OrgProvider` and change the last line to `return <OrgProvider><AppShell isAdmin={isAdmin} /></OrgProvider>;`.

`src/console/AppShell.tsx`: in `ShellBody`, add `const { org } = useOrg(); const mode = org?.brainMode ?? 'company';` (import `useOrg` from `./OrgContext.tsx`) and change both `resolveTab(null, isAdmin)` and `resolveTab(route.tab, isAdmin)` to pass `mode` as the third argument; pass `mode={mode}` to `<SettingsPanel …/>`.

`src/console/settings/SettingsPanel.tsx`:
- Add `general: lazy(() => import('../pages/General.tsx').then((m) => ({ default: m.General }))),` as the first `PAGES` entry and `general: 'General',` as the first `LABEL` entry.
- Add `mode` to the props: `tab, isAdmin, mode, onTab, onClose` with type `mode: 'personal' | 'company';`.
- Change `visibleTabs(isAdmin)` to `visibleTabs(isAdmin, mode)`.

`src/console/pages/Sources.tsx`: add `import { useOrg } from '../OrgContext.tsx';`, `const { org } = useOrg();` at the top of `Sources()`, and wrap the `<section>` that begins with `<h2 className="font-medium">Add source</h2>` in `{(org?.capabilities.sharedSources ?? true) && ( … )}`.

- [ ] **Step 7: The General page**

```tsx
// src/console/pages/General.tsx
import { useEffect, useState } from 'react';
import { ApiError, orgApi } from '../api.ts';
import { useOrg } from '../OrgContext.tsx';
import { Button, Card, Input, Notice } from '../ui/index.tsx';

/** What the switch says, from where the brain is now. Exported for tests. */
export function switchCopy(mode: 'personal' | 'company'): { title: string; body: string; action: string } {
  return mode === 'personal'
    ? {
      title: 'Personal brain',
      body: 'Only you use this brain. Turn it into a company brain to add shared Spaces, invite teammates and grant them access. Your own Space stays private either way.',
      action: 'Turn into a company brain',
    }
    : {
      title: 'Company brain',
      body: 'Teammates can be invited and granted company Spaces. Each person keeps a private Space nobody else can see. You can switch back only while you are the only member.',
      action: 'Switch back to a personal brain',
    };
}

export function General() {
  const { org, reload } = useOrg();
  const [name, setName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (org) setName(org.name); }, [org?.name]);
  if (!org) return <p className="text-sm text-muted">Loading…</p>;
  const copy = switchCopy(org.brainMode);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); await reload(); setMsg({ ok: true, text: ok }); setConfirming(false); }
    catch (e) {
      const code = e instanceof ApiError ? e.body.error : null;
      setMsg({
        ok: false,
        text: code === 'team_exists'
          ? 'Other people are members or have an open invite. Remove them first to switch back.'
          : e instanceof Error ? e.message : 'That did not work',
      });
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-6 max-w-xl">
      <Card>
        <h2 className="font-medium">Name</h2>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
        <Button disabled={busy || !name.trim() || name.trim() === org.name}
                onClick={() => run(() => orgApi.rename(name.trim()), 'Renamed.')}>
          Save name
        </Button>
      </Card>

      {org.role === 'owner' && (
        <Card>
          <h2 className="font-medium">{copy.title}</h2>
          <p className="text-sm text-muted">{copy.body}</p>
          {!confirming ? (
            <Button onClick={() => setConfirming(true)} disabled={busy}>{copy.action}</Button>
          ) : org.brainMode === 'personal' ? (
            <div className="space-y-2">
              <Input placeholder="Company name (optional)" value={companyName}
                     onChange={(e) => setCompanyName(e.target.value)} />
              <Button variant="primary" disabled={busy}
                      onClick={() => run(() => orgApi.setMode('company', companyName.trim() || undefined),
                        'This is now a company brain. Members and Access are in Settings.')}>
                Confirm
              </Button>
            </div>
          ) : (
            <Button variant="primary" disabled={busy}
                    onClick={() => run(() => orgApi.setMode('personal'), 'This is a personal brain again.')}>
              Confirm
            </Button>
          )}
        </Card>
      )}

      {msg && <Notice tone={msg.ok ? 'ok' : 'danger'}>{msg.text}</Notice>}
    </div>
  );
}
```

(`Tone` is `'ok' | 'warning' | 'danger' | 'muted' | 'neutral'`, `src/console/ui/classes.ts:52`.)

Add `test/unit/console-general.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { switchCopy } from '../../src/console/pages/General.tsx';

test('the switch offers the other mode', () => {
  expect(switchCopy('personal').action).toBe('Turn into a company brain');
  expect(switchCopy('company').action).toBe('Switch back to a personal brain');
});
```

- [ ] **Step 8: Run tests and typecheck**

Run: `bun run test:unit` → PASS
Run: `bunx tsc --noEmit -p tsconfig.json` → no new errors.

- [ ] **Step 9: See it working**

Use the `redeploy` skill (console-only fast path), sign in as the owner of a fresh install, and confirm: Settings opens on General; Members/Access are absent; "Turn into a company brain" → confirm → Members and Access appear without a reload of the page.

- [ ] **Step 10: Commit**

```bash
git add src/console/OrgContext.tsx src/console/pages/General.tsx src/console/settings/tabs.ts src/console/settings/SettingsPanel.tsx \
  src/console/AppShell.tsx src/console/App.tsx src/console/pages/Sources.tsx src/console/api.ts \
  test/unit/console-settings-tabs.test.ts test/unit/console-general.test.ts
git commit -m "feat(console): Settings > General with the company switch; team tabs hidden in personal mode

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Full verification

- [ ] **Step 1:** `bun run test:unit` → all pass.
- [ ] **Step 2:** `bun run test:integration:isolated` → `0 failed`. A failure with `company_mode_required` means that suite bootstraps and then uses a team route: pass `{ brainMode: 'company' }` to its `bootstrapFirstAdmin` call.
- [ ] **Step 3:** `bun run lint:forbidden` → pass.
- [ ] **Step 4:** Commit any fixes:

```bash
git add -A test src
git commit -m "test(setup): team-route suites bootstrap in company mode

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
