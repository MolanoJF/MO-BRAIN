# Zones 3 — Invite Login and the Member Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An invited person opens their link, creates a real console login, and lands in their own brain — their private My Space first, plus the company Spaces they have been granted — as a `member`.

**Architecture:** An invite creates a placeholder account (`users.invite_placeholder = true`, random unusable password — today's behaviour, now marked). The existing claim endpoint gains an optional `password`: on a placeholder account it sets the credential password with Better Auth's own `hashPassword`, clears the flag and verifies the email; an account the person already owned is never touched. The claim page becomes "Create your account" and signs them in. In the console, the Space picker groups My Brain / Company, and a new "My Brain" settings tab lets a member choose which granted company Spaces their own agent reads (plan 1's `/api/my/connection`).

**Tech Stack:** Bun 1.3, Hono, Drizzle ORM (Postgres), Better Auth 1.7 (`better-auth/crypto`), React 19 console, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-09-22-personal-and-company-zones-design.md` (§1, D1, D2, §5.3)

**Depends on:** plan 1 (`/api/my/connection`, `test/helpers/*`) and plan 2 (`bootstrapFirstAdmin` `brainMode` option, settings `mode` parameter).

## Global Constraints

- A claim may set a password **only** on an account created by an invite (`invite_placeholder = true`). An existing account's password is never changed by a claim.
- Password rules match bootstrap: at least 12 characters (`emailAndPassword.minPasswordLength` in `src/control/auth.ts`).
- The password is validated **before** the claim link is burned — a too-short password must not consume the link.
- Never log or audit the password or the request body (S3c).
- Google sign-in is out of scope here; `docs/superpowers/plans/2026-09-22-google-exclusive-auth.md` D3 (invited users get `emailVerified: true`) composes with this plan because a successful password claim also sets `emailVerified`.
- Integration tests: `bun test test/integration/<file>.test.ts`; see plan 1.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `src/control/db/migrations/0012_invite_placeholder.sql` (new), `meta/_journal.json`, `db/schema.ts` | `users.invite_placeholder` |
| `src/control/inviteAccount.ts` (new) | `setInvitePassword` — the one place a claim touches credentials |
| `src/control/routes/members.ts` | Mark placeholder accounts on invite |
| `src/control/claim.ts`, `src/control/routes/claim.ts` | Optional password; `account` outcome |
| `src/console/pages/Claim.tsx` | "Create your account" |
| `src/control/routes/files.ts`, `src/console/api.ts`, `src/console/shell/SourceSwitcher.tsx`, `src/console/shell/zones.ts` (new) | `zone` on Spaces; grouped picker |
| `src/console/settings/tabs.ts`, `SettingsPanel.tsx`, `src/console/pages/MyBrain.tsx` (new) | "My Brain" tab |
| `src/console/pages/Members.tsx` | Invite copy |

---

### Task 1: Invites create a marked placeholder account

**Files:**
- Create: `src/control/db/migrations/0012_invite_placeholder.sql`
- Modify: `src/control/db/migrations/meta/_journal.json`
- Modify: `src/control/db/schema.ts` (`users`)
- Modify: `src/control/routes/members.ts` (`POST /members`)
- Test: `test/integration/invite-login.test.ts` (new)

**Interfaces:**
- Produces: `schema.users.invitePlaceholder: boolean` (default `false`).

- [ ] **Step 1: Write the failing test**

```ts
// test/integration/invite-login.test.ts
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { installOpsMock } from '../helpers/opsMock.ts';

installOpsMock();

const { getDb, schema, closeDb, pinDb, runMigrations } = await import('../../src/control/db/client.ts');
const { bootstrapFirstAdmin } = await import('../../src/control/bootstrap.ts');
const { hit, PASS } = await import('../helpers/zoneFixture.ts');
const { sql, eq } = await import('drizzle-orm');

pinDb();
let ownerCookie = '';

beforeAll(async () => {
  await runMigrations();
  await getDb().execute(sql`TRUNCATE users, organizations, runner_presence RESTART IDENTITY CASCADE`);
  await bootstrapFirstAdmin('il-owner@example.test', PASS, 'InviteCo', { brainMode: 'company' });
  const res = await hit('POST', '/api/auth/sign-in/email', undefined, { email: 'il-owner@example.test', password: PASS });
  ownerCookie = res.headers.get('set-cookie') ?? '';
}, 90_000);

afterAll(async () => { await closeDb(); });

async function invite(email: string): Promise<{ membershipId: string; token: string }> {
  const created = await hit('POST', '/api/members', ownerCookie, { email, role: 'member' });
  expect(created.status).toBe(200);
  const { id } = await created.json() as { id: string };
  const link = await hit('POST', `/api/members/${id}/claim-link`, ownerCookie, { email });
  expect(link.status).toBe(200);
  const { token } = await link.json() as { token: string };
  return { membershipId: id, token };
}

describe('invite accounts', () => {
  test('a brand-new invitee gets a placeholder account', async () => {
    await invite('il-new@example.test');
    const [u] = await getDb().select().from(schema.users).where(eq(schema.users.email, 'il-new@example.test'));
    expect(u?.invitePlaceholder).toBe(true);
  });

  test('inviting someone who already has an account does not mark it', async () => {
    const [owner] = await getDb().select().from(schema.users).where(eq(schema.users.email, 'il-owner@example.test'));
    expect(owner?.invitePlaceholder).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/integration/invite-login.test.ts`
Expected: FAIL — `invitePlaceholder` is `undefined`.

- [ ] **Step 3: Implement**

`src/control/db/schema.ts`, in `users`, after `emailVerified`:

```ts
  /** Zones plan 3: true only for an account an INVITE created, whose password
   *  is random and unusable. A claim may set a real password on such an
   *  account, and on no other. Cleared the moment one is set. */
  invitePlaceholder: boolean('invite_placeholder').notNull().default(false),
```

`src/control/db/migrations/0012_invite_placeholder.sql`:

```sql
ALTER TABLE "users" ADD COLUMN "invite_placeholder" boolean DEFAULT false NOT NULL;
```

Append to `meta/_journal.json` `entries` (comma after the 0011 entry):

```json
    {
      "idx": 12,
      "version": "7",
      "when": 1793000000000,
      "tag": "0012_invite_placeholder",
      "breakpoints": true
    }
```

`src/control/routes/members.ts`, in `POST /members`, replace the `else` branch that signs the user up:

```ts
  } else {
    const password = randomBytes(32).toString('base64url');
    const signed = await auth.api.signUpEmail({ body: { email, password, name: email } });
    const id = (signed as { user?: { id?: string } }).user?.id;
    if (!id) throw new Error('sign_up_failed');
    // The claim link is where this person sets a real password (zones plan 3).
    await getDb().update(schema.users).set({ invitePlaceholder: true }).where(eq(schema.users.id, id));
    targetUserId = id;
  }
```

- [ ] **Step 4: Run the test** → `bun test test/integration/invite-login.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/control/db/schema.ts src/control/db/migrations/0012_invite_placeholder.sql src/control/db/migrations/meta/_journal.json \
  src/control/routes/members.ts test/integration/invite-login.test.ts
git commit -m "feat(invite): mark accounts an invite created as placeholders

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Claiming an invite sets the password

**Files:**
- Create: `src/control/inviteAccount.ts`
- Modify: `src/control/claim.ts` (`ClaimResult`, `claim`)
- Modify: `src/control/routes/claim.ts`
- Test: `test/integration/invite-login.test.ts` (append)

**Interfaces:**
- Produces:
  - `setInvitePassword(userId: string, password: string): Promise<'created' | 'existing'>`
  - `claim(token: string, email: string, password?: string): Promise<ClaimResult>`
  - `ClaimResult` gains `account: 'created' | 'existing' | 'unchanged'` (`unchanged` when no password was sent)
  - `POST /api/claim/:token` body `{ email, password? }`; 400 `password_too_short` before anything is consumed

- [ ] **Step 1: Write the failing tests** — append:

```ts
describe('claiming sets a real login', () => {
  test('a too-short password is refused and does NOT burn the link', async () => {
    const { token } = await invite('il-short@example.test');
    const bad = await hit('POST', `/api/claim/${token}`, undefined, { email: 'il-short@example.test', password: 'short' });
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toBe('password_too_short');

    const good = await hit('POST', `/api/claim/${token}`, undefined, { email: 'il-short@example.test', password: PASS });
    expect(good.status).toBe(200);
  });

  test('a new invitee claims with a password, then signs in with it', async () => {
    const { token } = await invite('il-claim@example.test');
    const res = await hit('POST', `/api/claim/${token}`, undefined, { email: 'il-claim@example.test', password: 'my-own-password-123' });
    expect(res.status).toBe(200);
    expect((await res.json() as { account: string }).account).toBe('created');

    const signIn = await hit('POST', '/api/auth/sign-in/email', undefined, { email: 'il-claim@example.test', password: 'my-own-password-123' });
    expect(signIn.status).toBe(200);

    const [u] = await getDb().select().from(schema.users).where(eq(schema.users.email, 'il-claim@example.test'));
    expect(u?.invitePlaceholder).toBe(false);
    expect(u?.emailVerified).toBe(true);
  });

  test("a claim never changes the password of an account the person already had", async () => {
    // Create a real account first, then invite that same email.
    const signUp = await hit('POST', '/api/auth/sign-up/email', undefined, { email: 'il-existing@example.test', password: PASS, name: 'x' });
    expect(signUp.status).toBe(200);
    const { token } = await invite('il-existing@example.test');

    const res = await hit('POST', `/api/claim/${token}`, undefined, { email: 'il-existing@example.test', password: 'attacker-chosen-pass' });
    expect(res.status).toBe(200);
    expect((await res.json() as { account: string }).account).toBe('existing');

    const oldStillWorks = await hit('POST', '/api/auth/sign-in/email', undefined, { email: 'il-existing@example.test', password: PASS });
    expect(oldStillWorks.status).toBe(200);
    const newDoesNot = await hit('POST', '/api/auth/sign-in/email', undefined, { email: 'il-existing@example.test', password: 'attacker-chosen-pass' });
    expect(newDoesNot.status).not.toBe(200);
  });

  test('a claim without a password behaves as before', async () => {
    const { token } = await invite('il-nopass@example.test');
    const res = await hit('POST', `/api/claim/${token}`, undefined, { email: 'il-nopass@example.test' });
    expect(res.status).toBe(200);
    expect((await res.json() as { account: string }).account).toBe('unchanged');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/integration/invite-login.test.ts`
Expected: FAIL — sign-in with the new password is refused; `account` is undefined.

- [ ] **Step 3: Implement `inviteAccount.ts`**

```ts
// src/control/inviteAccount.ts
/**
 * Zones plan 3 — the ONE place a claim touches credentials.
 *
 * Only an account an invite created (`invite_placeholder`) may have its
 * password set here: its password is random and nobody knows it. Any other
 * account belongs to a person who already chose a password, and a claim link
 * (which an admin can mint for any email) must never be a way to replace it.
 *
 * The hash is Better Auth's own `hashPassword`, the same function its
 * email/password sign-in verifies against, written to the `credential` account
 * row sign-up created.
 */
import { and, eq } from 'drizzle-orm';
import { hashPassword } from 'better-auth/crypto';
import { getDb, schema } from './db/client.ts';

export async function setInvitePassword(userId: string, password: string): Promise<'created' | 'existing'> {
  const [user] = await getDb().select({ placeholder: schema.users.invitePlaceholder })
    .from(schema.users).where(eq(schema.users.id, userId));
  if (!user?.placeholder) return 'existing';

  const hash = await hashPassword(password);
  const updated = await getDb().update(schema.accounts)
    .set({ password: hash, updatedAt: new Date() })
    .where(and(eq(schema.accounts.userId, userId), eq(schema.accounts.providerId, 'credential')))
    .returning({ id: schema.accounts.id });
  if (updated.length === 0) throw new Error('credential_account_missing');

  await getDb().update(schema.users)
    .set({ invitePlaceholder: false, emailVerified: true, updatedAt: new Date() })
    .where(eq(schema.users.id, userId));
  return 'created';
}
```

- [ ] **Step 4: Wire it into `claim`**

In `src/control/claim.ts`:
- Add `import { setInvitePassword } from './inviteAccount.ts';`.
- Extend `ClaimResult` with `account: 'created' | 'existing' | 'unchanged';`.
- Change the signature to `export async function claim(token: string, email: string, password?: string): Promise<ClaimResult>`.
- Inside the `try`, directly before `return { membershipId, connections, skillsPublished: … }`, add:

```ts
    // After provisioning succeeded: a failure above has already compensated,
    // and the password must not be set for a claim that is being unwound.
    const account = password === undefined
      ? 'unchanged' as const
      : await setInvitePassword(membership.userId, password);
```

- and return `{ membershipId, connections, skillsPublished: await skillsPublished(), account }`.

In `src/control/routes/claim.ts`, replace the body parsing and call:

```ts
  const token = c.req.param('token');
  let email = '';
  let password: string | undefined;
  try {
    const body = await c.req.json();
    if (body && typeof body.email === 'string') email = body.email;
    if (body && typeof body.password === 'string') password = body.password;
  } catch { /* missing/invalid JSON */ }
  if (!email) return c.json({ error: 'email is required' }, 400);
  // Checked BEFORE `claim` burns the link: a typo must not cost the invite.
  if (password !== undefined && password.length < 12) return c.json({ error: 'password_too_short' }, 400);

  try {
    return c.json(await claim(token, email, password));
```

(the `catch` below it is unchanged).

- [ ] **Step 5: Run the tests**

Run: `bun test test/integration/invite-login.test.ts` → PASS
Run: `bun test test/integration/claim.test.ts` → PASS (callers that omit `password` get `account: 'unchanged'`; if that suite asserts the exact response object with `toEqual`, add `account: 'unchanged'` to the expected object)

- [ ] **Step 6: Commit**

```bash
git add src/control/inviteAccount.ts src/control/claim.ts src/control/routes/claim.ts test/integration/invite-login.test.ts test/integration/claim.test.ts
git commit -m "feat(invite): claiming an invite creates the person's login

Only on accounts the invite created; an existing account is never touched.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The claim page is "Create your account"

**Files:**
- Modify: `src/console/pages/Claim.tsx`
- Test: `test/unit/console-claim.test.ts` (new)

**Interfaces:**
- Consumes: `POST /api/claim/:token` with `{ email, password }` → `{ account, connections, … }`.
- Produces: `claimFormError(password: string, confirm: string): string | null`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/console-claim.test.ts
import { test, expect } from 'bun:test';
import { claimFormError } from '../../src/console/pages/Claim.tsx';

test('the password must be 12+ characters and confirmed', () => {
  expect(claimFormError('', '')).toBe('Use at least 12 characters.');
  expect(claimFormError('short', 'short')).toBe('Use at least 12 characters.');
  expect(claimFormError('long-enough-pass', 'long-enough-pasS')).toBe('Passwords do not match.');
  expect(claimFormError('long-enough-pass', 'long-enough-pass')).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/unit/console-claim.test.ts` → FAIL (not exported).

- [ ] **Step 3: Implement** — in `src/console/pages/Claim.tsx`:

Add the helper above `Claim`:

```ts
/** Client-side mirror of the server's rule; the server re-checks before burning the link. */
export function claimFormError(password: string, confirm: string): string | null {
  if (password.length < 12) return 'Use at least 12 characters.';
  if (password !== confirm) return 'Passwords do not match.';
  return null;
}
```

Extend the result type everywhere it appears: `{ membershipId: string; connections: ClaimConnection[]; skillsPublished: boolean; account: 'created' | 'existing' | 'unchanged' }`.

Add state: `const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState('');` and a `formError = claimFormError(password, confirm)`.

`submit` posts `{ email, password }`.

Add the continue action (signs in only when the account was just created):

```ts
  const enter = async () => {
    if (result?.account === 'created') await api.post('/auth/sign-in/email', { email, password });
    window.location.assign('/');
  };
```

In the `if (result)` branch, change the heading to `You're in` and add, above the credential notice:

```tsx
        {result.account === 'existing' && (
          <Notice>You already had an account with this email. Sign in with your existing password.</Notice>
        )}
        <Button variant="primary" onClick={() => void enter()}>
          {result.account === 'created' ? 'Open your brain' : 'Go to sign in'}
        </Button>
```

Keep the credential notice and `ClaimedConnection` list only when `result.connections.length > 0` (wrap the `Notice tone="warning"` and the `.map` in `{result.connections.length > 0 && (<>…</>)}`) and delete the `Empty` "No pending connections" line — for a person joining a team that is the normal case, not an empty state.

Replace the pre-claim form's copy and fields:

```tsx
      <h1 className="text-xl font-semibold">Create your account</h1>
      <p className="text-sm text-muted">
        You've been invited to a company brain. You'll get your own private Space that only you can see,
        plus access to the company Spaces your admin shares with you.
      </p>
      <Input type="email" placeholder="The email this invite was sent to" value={email}
             onChange={(e) => setEmail(e.target.value)} />
      <Input type="password" placeholder="Choose a password (12+ characters)" value={password}
             onChange={(e) => setPassword(e.target.value)} />
      <Input type="password" placeholder="Confirm password" value={confirm}
             onChange={(e) => setConfirm(e.target.value)} />
```

and the button: `disabled={busy || !email || formError !== null}` with label `{busy ? 'Creating…' : 'Create account'}`. Show `formError` under the fields as `<p className="text-sm text-muted">{formError}</p>` only once the user has typed into the password field (`password.length > 0 && formError`).

Keep the existing `burned` / `wrongEmail` explanations unchanged.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test test/unit/console-claim.test.ts` → PASS
Run: `bunx tsc --noEmit -p tsconfig.json` → no new errors

- [ ] **Step 5: Commit**

```bash
git add src/console/pages/Claim.tsx test/unit/console-claim.test.ts
git commit -m "feat(console): the invite link creates your account and opens your brain

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The Space picker shows My Brain and Company

**Files:**
- Modify: `src/control/routes/files.ts` (`GET /spaces` adds `zone`)
- Modify: `src/console/api.ts` (`SpaceSummary.zone`)
- Create: `src/console/shell/zones.ts`
- Modify: `src/console/shell/SourceSwitcher.tsx`
- Test: `test/unit/console-zones.test.ts`, `test/integration/zones.test.ts` (append)

**Interfaces:**
- Produces: `SpaceSummary = { id; sourceId; name; access; zone: 'personal' | 'company' }`; `groupByZone(spaces: SpaceSummary[]): Array<{ label: 'My Brain' | 'Company'; spaces: SpaceSummary[] }>` (empty groups omitted, My Brain first).

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/console-zones.test.ts
import { test, expect } from 'bun:test';
import { groupByZone } from '../../src/console/shell/zones.ts';

const s = (sourceId: string, zone: 'personal' | 'company') =>
  ({ id: sourceId, sourceId, name: sourceId, access: 'write' as const, zone });

test('My Brain first, then Company, empty groups omitted', () => {
  expect(groupByZone([s('kb', 'company'), s('mine', 'personal')])).toEqual([
    { label: 'My Brain', spaces: [s('mine', 'personal')] },
    { label: 'Company', spaces: [s('kb', 'company')] },
  ]);
  expect(groupByZone([s('mine', 'personal')])).toEqual([{ label: 'My Brain', spaces: [s('mine', 'personal')] }]);
});
```

Append to `test/integration/zones.test.ts`:

```ts
describe('/api/spaces carries the zone', () => {
  test("a member's own Space is personal, a granted one is company", async () => {
    const body = await (await hit('GET', '/api/spaces', fx.bob.cookie)).json() as { spaces: Array<{ id: string; zone: string }> };
    expect(body.spaces.find((s) => s.id === fx.bob.privateSpaceId)?.zone).toBe('personal');
    const company = body.spaces.find((s) => s.id === fx.companySpaceId);
    if (company) expect(company.zone).toBe('company');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/unit/console-zones.test.ts` → FAIL (module missing)
Run: `bun test test/integration/zones.test.ts` → FAIL (`zone` undefined)

- [ ] **Step 3: Implement**

`src/control/routes/files.ts`, in `GET /spaces`, change the `flatMap` return:

```ts
    return access === null ? [] : [{
      ...space, access, zone: space.ownerMembershipId === null ? 'company' as const : 'personal' as const,
    }];
```

`src/console/api.ts`: `export type SpaceSummary = { id: string; sourceId: string; name: string; access: 'read' | 'write'; zone: 'personal' | 'company' };`

```ts
// src/console/shell/zones.ts
import type { SpaceSummary } from '../api.ts';

export type ZoneGroup = { label: 'My Brain' | 'Company'; spaces: SpaceSummary[] };

/** Zones spec §1: your own Spaces first, then what the company shares with you. */
export function groupByZone(spaces: SpaceSummary[]): ZoneGroup[] {
  const groups: ZoneGroup[] = [
    { label: 'My Brain', spaces: spaces.filter((s) => s.zone === 'personal') },
    { label: 'Company', spaces: spaces.filter((s) => s.zone !== 'personal') },
  ];
  return groups.filter((g) => g.spaces.length > 0);
}
```

`src/console/shell/SourceSwitcher.tsx`: import `groupByZone` and replace the `spaces.map(…)` option list with:

```tsx
        {groupByZone(spaces).map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.spaces.map((space) => (
              <option key={space.sourceId} value={space.sourceId}>
                {spacePickerLabel(space)}
              </option>
            ))}
          </optgroup>
        ))}
```

Any test fixture that builds a `SpaceSummary` literal now needs `zone`; find them with `grep -rn "access: '" test/unit | grep sourceId` and add `zone: 'company'` (or `'personal'` where the fixture is a private Space).

- [ ] **Step 4: Run tests**

Run: `bun run test:unit` → PASS
Run: `bun test test/integration/zones.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/control/routes/files.ts src/console/api.ts src/console/shell/zones.ts src/console/shell/SourceSwitcher.tsx \
  test/unit/console-zones.test.ts test/integration/zones.test.ts test/unit
git commit -m "feat(console): the Space picker groups My Brain and Company

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: "My Brain" settings — what my agent may read

**Files:**
- Create: `src/console/pages/MyBrain.tsx`
- Modify: `src/console/api.ts` (`myConnectionApi`)
- Modify: `src/console/settings/tabs.ts`, `src/console/settings/SettingsPanel.tsx`
- Modify: `src/console/pages/Members.tsx` (invite copy)
- Modify: `test/unit/console-settings-tabs.test.ts`
- Test: `test/unit/console-mybrain.test.ts` (new)

**Interfaces:**
- Consumes: `GET/PUT /api/my/connection` (plan 1 Task 8).
- Produces: `myConnectionApi.get()`, `myConnectionApi.setReads(ids)`; `toggleRead(current: string[], id: string): string[]`; tab id `'mine'` (label `My Brain`, `minRole: 'viewer'`, second in the registry).

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/console-mybrain.test.ts
import { test, expect } from 'bun:test';
import { toggleRead } from '../../src/console/pages/MyBrain.tsx';

test('toggling a company Space adds or removes it, keeping order stable', () => {
  expect(toggleRead([], 'a')).toEqual(['a']);
  expect(toggleRead(['a', 'b'], 'a')).toEqual(['b']);
  expect(toggleRead(['b'], 'a')).toEqual(['b', 'a']);
});
```

In `test/unit/console-settings-tabs.test.ts`, update the registry order to `['general', 'mine', 'sources', 'schema', 'members', 'access', 'schedules', 'health', 'spend', 'runs', 'upgrades', 'appearance']` (twelve), add `mine: 'viewer'` to the minRole table, change `a non-admin sees exactly …` to expect `['mine', 'schedules', 'health', 'runs', 'upgrades', 'appearance']`, and append:

```ts
test('a member opens settings on My Brain', () => {
  expect(resolveTab(null, false)).toBe('mine');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/unit/console-mybrain.test.ts test/unit/console-settings-tabs.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`src/console/settings/tabs.ts`: add `'mine'` to `SettingsTab` and insert `{ id: 'mine', label: 'My Brain', minRole: 'viewer' },` directly after the `general` entry.

`src/console/settings/SettingsPanel.tsx`: add `mine: lazy(() => import('../pages/MyBrain.tsx').then((m) => ({ default: m.MyBrain }))),` to `PAGES` and `mine: 'My Brain',` to `LABEL`.

Append to `src/console/api.ts`:

```ts
export type MyConnection = {
  space: { id: string; sourceId: string; name: string };
  connection: { id: string; state: string; readSpaceIds: string[] } | null;
  readable: Array<{ id: string; sourceId: string; name: string }>;
};

export const myConnectionApi = {
  get: () => api.get<MyConnection>('/my/connection'),
  setReads: (readSpaceIds: string[]) => api.put<{ ok: true; readSpaceIds: string[] }>('/my/connection', { readSpaceIds }),
};
```

```tsx
// src/console/pages/MyBrain.tsx
import { useEffect, useState } from 'react';
import { ApiError, myConnectionApi, type MyConnection } from '../api.ts';
import { Button, Card, Notice } from '../ui/index.tsx';

export function toggleRead(current: string[], id: string): string[] {
  return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
}

/**
 * Zones spec §1 — the member's own zone. Their private Space is theirs alone;
 * here they choose which company Spaces (among those an admin granted) their
 * own agent may READ. It always writes only to their private Space.
 */
export function MyBrain() {
  const [data, setData] = useState<MyConnection | null>(null);
  const [reads, setReads] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const d = await myConnectionApi.get();
      setData(d);
      setReads(d.connection?.readSpaceIds ?? []);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError && e.body.error === 'no_private_space'
        ? 'You do not have a private Space yet. Ask an admin to retry provisioning it.'
        : e instanceof Error ? e.message : 'Could not load' });
    }
  };
  useEffect(() => { void load(); }, []);

  const save = async () => {
    setBusy(true); setMsg(null);
    try { await myConnectionApi.setReads(reads); await load(); setMsg({ ok: true, text: 'Saved.' }); }
    catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError && e.body.error === 'connection_pending'
        ? 'Finish claiming your invite first.'
        : e instanceof Error ? e.message : 'Save failed' });
    } finally { setBusy(false); }
  };

  if (!data) return msg ? <Notice tone="danger">{msg.text}</Notice> : <p className="text-sm text-muted">Loading…</p>;
  const saved = data.connection?.readSpaceIds ?? [];
  const dirty = saved.length !== reads.length || saved.some((id) => !reads.includes(id));

  return (
    <div className="space-y-6 max-w-xl">
      <Card>
        <h2 className="font-medium">{data.space.name}</h2>
        <p className="text-sm text-muted">
          Your private Space (<span className="font-mono">{data.space.sourceId}</span>). Only you can see it —
          admins included.
        </p>
      </Card>
      <Card>
        <h2 className="font-medium">What your agent can read</h2>
        {data.readable.length === 0 ? (
          <p className="text-sm text-muted">No company Spaces have been shared with you yet.</p>
        ) : (
          <ul className="space-y-1">
            {data.readable.map((s) => (
              <li key={s.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={reads.includes(s.id)}
                         onChange={() => setReads(toggleRead(reads, s.id))} />
                  {s.name} <span className="font-mono text-muted">({s.sourceId})</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <Button variant="primary" disabled={busy || !dirty || data.connection === null} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </Card>
      {msg && <Notice tone={msg.ok ? 'ok' : 'danger'}>{msg.text}</Notice>}
    </div>
  );
}
```

`src/console/pages/Members.tsx`: where the claim URL is shown after an invite, set the explanatory line to: `Send this link to them. They'll create their account, get their own private Space, and see the company Spaces you grant on the Access tab. It expires in 24 hours.`

- [ ] **Step 4: Run tests and typecheck**

Run: `bun run test:unit` → PASS
Run: `bunx tsc --noEmit -p tsconfig.json` → no new errors

- [ ] **Step 5: See it end to end**

With the `redeploy` skill (console fast path): as the owner, switch to company mode (General), create a company Space (Sources), invite `member@…` (Members), grant them read on it (Access → Company access). Open the invite link in a private window, create the account, click **Open your brain**. Confirm: the picker shows **My Brain** then **Company**; Settings opens on **My Brain**; ticking the company Space and saving succeeds; there is no Members/Access/Spend tab.

- [ ] **Step 6: Commit**

```bash
git add src/console/pages/MyBrain.tsx src/console/api.ts src/console/settings/tabs.ts src/console/settings/SettingsPanel.tsx \
  src/console/pages/Members.tsx test/unit/console-mybrain.test.ts test/unit/console-settings-tabs.test.ts
git commit -m "feat(console): My Brain settings — a member chooses what their agent reads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Full verification

- [ ] **Step 1:** `bun run test:unit` → all pass.
- [ ] **Step 2:** `bun run test:integration:isolated` → `0 failed`.
- [ ] **Step 3:** `bun run lint:forbidden` → pass.
- [ ] **Step 4:** Commit any fixes:

```bash
git add -A test src
git commit -m "test(invite): align suites with password claims and zoned Spaces

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
