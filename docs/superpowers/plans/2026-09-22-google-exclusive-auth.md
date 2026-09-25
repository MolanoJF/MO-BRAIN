# Google Sign-In (Optional, Additive) Implementation Plan

> **Status (2026-09-25):** Implemented and merged on `main` at `578bbaa` (2026-09-23), on top of the personal-and-company zones work. The checkboxes below were not ticked during that execution. The record is the commits from `e5375b1` through `578bbaa`. This file was committed after the fact.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Continue with Google" as a second way to sign in, alongside the existing email/password flow — not instead of it. A self-hosted deployment that never sets up Google OAuth behaves exactly as it does today; one that does gets the button too.

**Architecture:** `src/control/auth.ts` gains `socialProviders.google`, registered only when both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set — otherwise Better Auth's config is byte-for-byte what it is today. `emailAndPassword` is untouched. Bootstrap and invites keep their existing password-based code paths completely unchanged and gain a parallel Google-based path. Because nothing existing is removed, the entire current test suite (19 files that sign in with a password) needs zero changes — this supersedes the previous version of this plan, which proposed a hard cutover to Google-only auth.

**Tech Stack:** better-auth 1.7.5 (installed), Hono, Drizzle/Postgres, Bun test, React (console).

**Spec:** This document. Written after reviewing Better Auth's docs and its installed source (`node_modules/better-auth/dist/**`) directly, and after the user redirected from an initial "Google-only" direction to "keep current auth, add Google as an option, so it's not so restrictive for self-hosters."

## Global Constraints

- `emailAndPassword` stays enabled, unchanged, with no behavior difference for a deployment that never configures Google.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are **optional**. Unset means: no Google provider is registered in Better Auth, no button renders in the console, `scripts/install.sh` does not require them.
- No existing route, response shape, or test file changes unless a task below says so explicitly. New behavior only appears in new code paths.
- No new tables/columns — `users`/`sessions`/`accounts`/`verifications` already support OAuth (`src/control/db/schema.ts:7-56`).

## Decisions (read once, referenced by later tasks)

**D1 — Conditional provider registration.** `src/control/auth.ts` builds `socialProviders` as `{}` unless both env vars are present, then spreads it into the `betterAuth(...)` call only if non-empty. This is the whole mechanism for "optional": Better Auth simply never knows Google exists on a deployment that hasn't configured it.

**D2 — Bootstrap gets a second path, not a replacement.** `bootstrapFirstAdmin(email, password, orgName)` (`src/control/bootstrap.ts`) keeps its exact current name, signature, and behavior — every one of the 7 test files that call it directly stays green with no edits. A new function, `bootstrapFirstAdminForSession(userId, orgName)`, covers the Google path (the browser already completed OAuth and has a session; there's no password to collect). Both share one extracted private helper for the org/membership/brain/audit-row creation, so the two paths can't drift apart. `POST /api/bootstrap` picks between them based on whether the request body has `email`+`password` (old path, unchanged) or the caller already has a session (new path).

**D3 — Invite rows get `emailVerified: true`.** Verified by reading `node_modules/better-auth/dist/oauth2/link-account.mjs:76-85`: when a Google sign-in matches an existing user by email, Better Auth's account-linking refuses to attach the Google account unless (among other conditions) the **existing local user's** `emailVerified` column is already `true` — regardless of what Google itself reports. Today's invite flow (`src/control/routes/members.ts:56-105`) creates that row via `auth.api.signUpEmail` with a random unusable password, leaving `emailVerified` at the schema default of `false`. One extra line after that call sets it `true`, so an invited member who'd rather click "Continue with Google" than use a password reset flow (which doesn't exist yet) is able to. This is a strict improvement with no downside: the admin already vouched for that exact address by typing it into the invite form.

**D4 — The console needs to know whether Google is configured.** A new `GET /api/auth-config` route (deliberately outside the `/auth/*` wildcard Better Auth owns) returns `{ google: boolean }`. `SignIn.tsx` and `Bootstrap.tsx` fetch it once and only render the Google button when true — never a button that's guaranteed to error.

**D5 — An uninvited Google sign-in can still get a session with no org.** Once Google is configured at all, anyone with a Google account can complete `sign-in/social` on a bootstrapped deployment and get a real session with zero memberships (Better Auth doesn't know to refuse this — it's a normal new-user sign-up). `requireRole` (`src/control/rbac.ts:45-47`) already 403s such a session on every gated route, but the console's `phaseFor` (`src/console/App.tsx:36-44`) maps any 403 from `/api/wizard/state` to `phase: 'ready'`, which today only ever meant "signed in, wrong role" — never "no org at all." A `GET /api/me` route and a `noAccess` phase give this an honest screen. This only matters on deployments that turn Google on, but costs nothing on ones that don't (the code path is simply never reached).

**D6 — Testing the new paths without a real OAuth round trip.** Better Auth ships a first-party `testUtils` plugin (`node_modules/better-auth/dist/plugins/test-utils/index.mjs`), whose own doc comment recommends a **separate test-only auth instance** rather than adding it to production config. A small `src/control/auth.test.ts` plus a couple of new, narrowly-scoped tests cover `bootstrapFirstAdminForSession`, the invite auto-link precondition, and the new `noAccess` phase — nothing about the existing 19 password-based test files changes.

---

### Task 1: Conditional Google provider + `/api/auth-config`

**Files:**
- Modify: `src/control/auth.ts`
- Modify: `src/control/routes/auth.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `GET /api/auth-config` → `200 { google: boolean }`, always mounted, never errors.
- `auth` export: unchanged shape; `socialProviders` key present only when configured.

- [ ] **Step 1: Update `src/control/auth.ts`**

```ts
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { getDb, schema } from './db/client.ts';

type Db = ReturnType<typeof getDb>;

const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = getDb() as object;
    const value = Reflect.get(real, prop, real);
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
});

/** D1: present only when both env vars are set — an unconfigured deployment
 *  registers no social provider at all, not a Google button that 500s. */
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
export const googleConfigured = !!googleClientId && !!googleClientSecret;

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
    },
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.PUBLIC_URL ?? 'http://localhost:3150',
  basePath: '/api/auth',
  emailAndPassword: { enabled: true, minPasswordLength: 12 },
  ...(googleConfigured
    ? { socialProviders: { google: { clientId: googleClientId!, clientSecret: googleClientSecret! } } }
    : {}),
  // Organization plugin dropped (plan ruling / Group 1): it always mounts
  // invitation endpoints and wants an unmapped `invitation` table. We own
  // claim links (A3). RBAC is hand-rolled in rbac.ts.
});
```

- [ ] **Step 2: Add `/api/auth-config` to `src/control/routes/auth.ts`**

```ts
import { Hono } from 'hono';
import type { Context } from 'hono';
import { auth, googleConfigured } from '../auth.ts';
import { isBootstrapped, bootstrapFirstAdmin, bootstrapFirstAdminForSession } from '../bootstrap.ts';
import { requireRole } from '../rbac.ts';

export const authRoutes = new Hono();

authRoutes.on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw));

// D4: registered OUTSIDE the /auth/* wildcard on purpose — Better Auth owns
// everything under /auth, and this is ours, not a route it should ever see.
authRoutes.get('/auth-config', (c) => c.json({ google: googleConfigured }));

authRoutes.get('/bootstrap', async (c) => c.json({ bootstrapped: await isBootstrapped() }));
// (POST /bootstrap body changes in Task 2.)
```

(`bootstrapFirstAdminForSession` import here is unused until Task 2 — added now so Task 2's diff is a pure route-body change, not an import churn.)

- [ ] **Step 3: Document the two vars as optional in `.env.example`**, near `BETTER_AUTH_SECRET`:

```
# Optional. Leave both blank to use email/password only (the default). Set
# both to also offer "Continue with Google": create an OAuth 2.0 Client ID
# (type: Web application) in Google Cloud Console, with this exact
# Authorized redirect URI: https://${DOMAIN}/api/auth/callback/google
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit -p tsconfig.json`
Expected: no new errors (the `bootstrapFirstAdminForSession` import will error until Task 2 adds the export — do Task 2 in the same sitting before running this, or ignore that one expected error until then).

- [ ] **Step 5: Commit**

```bash
git add src/control/auth.ts src/control/routes/auth.ts .env.example
git commit -m "auth: register Google as an optional second sign-in provider"
```

---

### Task 2: Bootstrap gets a session-based path alongside the password path

**Files:**
- Modify: `src/control/bootstrap.ts`
- Modify: `src/control/routes/auth.ts`

**Interfaces:**
- Keeps: `bootstrapFirstAdmin(email: string, password: string, orgName: string): Promise<{userId, orgId, brainId}>` — unchanged.
- Produces: `bootstrapFirstAdminForSession(userId: string, orgName: string): Promise<{userId, orgId, brainId}>`.

- [ ] **Step 1: Extract the shared org-creation logic in `src/control/bootstrap.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, schema } from './db/client.ts';
import { auth } from './auth.ts';

export async function isBootstrapped(): Promise<boolean> {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.organizations);
  return (row?.n ?? 0) > 0;
}

/** Shared by both bootstrap paths (D2): creates the org, owner membership,
 *  uninitialized brain row, and audit entry for an ALREADY-EXISTING user. */
async function createOrgForNewAdmin(userId: string, orgName: string) {
  const orgId = randomUUID();
  const brainId = randomUUID();
  const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'org';

  const db = getDb();
  await db.insert(schema.organizations).values({ id: orgId, name: orgName, slug, brainMode: 'company' });
  await db.insert(schema.memberships).values({ id: randomUUID(), userId, organizationId: orgId, role: 'owner' });
  await db.insert(schema.brains).values({
    id: brainId, organizationId: orgId,
    gbrainHome: process.env.GBRAIN_HOME ?? '/srv/gbrain-home',
    engine: 'postgres', gbrainVersion: process.env.GBRAIN_VERSION ?? null,
    lifecycle: 'uninitialized',
  });
  await db.insert(schema.auditLog).values({
    id: randomUUID(), organizationId: orgId, actor: userId,
    action: 'bootstrap', target: orgId, before: null, after: { orgName, slug },
  });

  return { userId, orgId, brainId };
}

/**
 * Password path (unchanged): creates the user, then the org. Every existing
 * caller of this exact name/signature (7 test files) keeps working with no
 * edits — D2.
 */
export async function bootstrapFirstAdmin(email: string, password: string, orgName: string) {
  if (await isBootstrapped()) throw new Error('already_bootstrapped');

  const signed = await auth.api.signUpEmail({ body: { email, password, name: email } });
  const userId = (signed as { user?: { id?: string } }).user?.id;
  if (!userId) throw new Error('sign_up_failed');

  return createOrgForNewAdmin(userId, orgName);
}

/**
 * Google path (D2): the caller already has a session (they completed
 * sign-in/social in the browser before POSTing here) — nothing left to do
 * but create the org for that existing user.
 */
export async function bootstrapFirstAdminForSession(userId: string, orgName: string) {
  if (await isBootstrapped()) throw new Error('already_bootstrapped');
  return createOrgForNewAdmin(userId, orgName);
}
```

- [ ] **Step 2: Update `POST /api/bootstrap` in `src/control/routes/auth.ts`** to pick a path:

```ts
authRoutes.post('/bootstrap', async (c) => {
  if (await isBootstrapped()) return c.json({ error: 'already_bootstrapped' }, 409);
  const body = await c.req.json();
  const orgName = body?.orgName;
  if (!orgName) return c.json({ error: 'orgName is required' }, 400);
  try {
    // Unchanged path: email+password in the body, exactly as before.
    if (typeof body.email === 'string' && typeof body.password === 'string') {
      return c.json(await bootstrapFirstAdmin(body.email, body.password, orgName));
    }
    // New path: no password given, so the caller must already be signed in
    // (they clicked "Continue with Google" first).
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user?.id) return c.json({ error: 'sign_in_required' }, 401);
    return c.json(await bootstrapFirstAdminForSession(session.user.id, orgName));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'bootstrap_failed' }, 400);
  }
});
```

- [ ] **Step 3: Write a failing test for the new path**

Add to a new file `test/integration/bootstrap-google.test.ts` (kept separate from `auth.test.ts` so the existing file, and its `DECLARED_TABLES` invariant check, stays untouched):

```ts
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import app from '../../src/control/app.ts';
import { runMigrations, getDb, schema, closeDb, pinDb } from '../../src/control/db/client.ts';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(48);
process.env.BETTER_AUTH_SECRET ??= 'b'.repeat(48);
process.env.CONTROL_DATABASE_URL ??=
  'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';
pinDb();

beforeAll(async () => {
  await runMigrations();
  await getDb().delete(schema.sessions);
  await getDb().delete(schema.accounts);
  await getDb().delete(schema.memberships);
  await getDb().delete(schema.brains);
  await getDb().delete(schema.organizations);
  await getDb().delete(schema.users);
}, 60_000);

afterAll(async () => { await closeDb(); });

describe('bootstrap via an existing session (the Google path)', () => {
  test('bootstrap refuses orgName-only with no session', async () => {
    const res = await app.request('/api/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'NoSessionCo' }),
    });
    expect(res.status).toBe(401);
  });

  test('bootstrap succeeds for orgName-only once a session exists', async () => {
    // Simulates "the browser already completed Google sign-in": a user row
    // and a session row, created directly — no password, no OAuth round trip.
    const userId = randomUUID();
    await getDb().insert(schema.users).values({
      id: userId, email: 'google-admin@example.test', name: 'Google Admin', emailVerified: true,
    });
    const token = randomUUID();
    await getDb().insert(schema.sessions).values({
      id: randomUUID(), userId, token,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await app.request('/api/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `better-auth.session_token=${token}` },
      body: JSON.stringify({ orgName: 'GoogleCo' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { orgId?: string; userId?: string };
    expect(body.orgId).toBeTruthy();
    expect(body.userId).toBe(userId);

    const [m] = await getDb().select().from(schema.memberships).where(eq(schema.memberships.userId, userId));
    expect(m?.role).toBe('owner');
  });
});
```

Note: this test hand-inserts a `sessions` row with a **raw, unsigned** token as the cookie value. Whether Better Auth's `getSession` accepts that (versus requiring the `token.signature` format from `node_modules/better-auth/dist/plugins/test-utils/cookie-builder.mjs`) must be checked empirically in Step 4 below — if it fails signature verification, replace the manual session insert with the `testUtils`-based helper from Task 6 instead of hand-rolling the cookie (Task 6 exists specifically so this test doesn't have to guess).

- [ ] **Step 4: Run it and see it fail for the right reason (session/cookie construction), then fix**

Run: `bun test test/integration/bootstrap-google.test.ts`
Expected first pass: the 401 test passes immediately; the second test may fail on cookie verification. If it fails there (not on the bootstrap logic itself), swap in Task 6's `testAuth`-based session-minting instead of the manual insert, then re-run.

Expected after any needed fix: both tests pass.

- [ ] **Step 5: Confirm nothing else broke**

Run: `bun test test/integration/auth.test.ts test/integration/wizard.test.ts`
Expected: unchanged, all passing (these still use the password path exclusively).

- [ ] **Step 6: Commit**

```bash
git add src/control/bootstrap.ts src/control/routes/auth.ts test/integration/bootstrap-google.test.ts
git commit -m "auth: bootstrap accepts an existing Google session as an alternative to email/password"
```

---

### Task 3: Invite rows are created with `emailVerified: true`

**Files:**
- Modify: `src/control/routes/members.ts`

- [ ] **Step 1: Add one line after the existing `signUpEmail` call**

In `POST /members` (`src/control/routes/members.ts:56-105`), the placeholder-creation block currently reads:

```ts
  let targetUserId: string;
  const [existing] = await getDb().select().from(schema.users).where(eq(schema.users.email, email));
  if (existing) {
    targetUserId = existing.id;
  } else {
    const password = randomBytes(32).toString('base64url');
    const signed = await auth.api.signUpEmail({ body: { email, password, name: email } });
    const id = (signed as { user?: { id?: string } }).user?.id;
    if (!id) throw new Error('sign_up_failed');
    targetUserId = id;
  }
```

Change the `else` branch to:

```ts
  } else {
    const password = randomBytes(32).toString('base64url');
    const signed = await auth.api.signUpEmail({ body: { email, password, name: email } });
    const id = (signed as { user?: { id?: string } }).user?.id;
    if (!id) throw new Error('sign_up_failed');
    // D3: the admin is vouching for this exact address. Without this, an
    // invitee who later chooses "Continue with Google" would be refused —
    // Better Auth's account-linking (node_modules/better-auth/dist/oauth2/
    // link-account.mjs:76-85) requires the LOCAL row's emailVerified to
    // already be true, no matter what Google itself reports.
    await getDb().update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, id));
    targetUserId = id;
  }
```

- [ ] **Step 2: Add a regression test**

Find the existing invite test in `test/integration/routes.test.ts` (the one that POSTs to `/api/members` and asserts on the response) — read it first to match its exact setup pattern, then add, in the same `describe` block:

```ts
test('an invited user is pre-verified so a later Google sign-in can link', async () => {
  const res = await app.request('/api/members', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: ownerCookie },
    body: JSON.stringify({ email: 'future-google-user@example.test', role: 'member' }),
  });
  expect(res.status).toBe(200);
  const [u] = await getDb().select().from(schema.users)
    .where(eq(schema.users.email, 'future-google-user@example.test'));
  expect(u?.emailVerified).toBe(true);
});
```

(`ownerCookie` and the `describe` block's existing setup are read from the file as it stands — match its actual variable names rather than assuming; if the file's admin cookie variable is named differently, use that name instead.)

- [ ] **Step 3: Run it**

Run: `bun test test/integration/routes.test.ts`
Expected: all pass, including the new case.

- [ ] **Step 4: Commit**

```bash
git add src/control/routes/members.ts test/integration/routes.test.ts
git commit -m "auth: invited members are pre-verified so Google sign-in can link later"
```

---

### Task 4: Console UI — Google as an additional button, not a replacement

**Files:**
- Modify: `src/console/pages/SignIn.tsx`
- Modify: `src/console/pages/Bootstrap.tsx`

**Interfaces:**
- Consumes: `GET /api/auth-config` (Task 1).

- [ ] **Step 1: Add the Google option to `src/console/pages/SignIn.tsx`**, without touching the existing form

Add near the top of the component:

```tsx
const [googleAvailable, setGoogleAvailable] = useState(false);
useEffect(() => {
  void api.get<{ google: boolean }>('/auth-config').then((c) => setGoogleAvailable(c.google)).catch(() => {});
}, []);

const continueWithGoogle = async () => {
  setBusy(true); setError(null);
  try {
    const { url } = await api.post<{ url: string }>('/auth/sign-in/social', {
      provider: 'google',
      callbackURL: window.location.origin,
    });
    window.location.href = url;
  } catch (err) {
    setError(signInError(err));
    setBusy(false);
  }
};
```

(add `useEffect` to the existing `import { useState } from 'react';` line → `import { useEffect, useState } from 'react';`)

Then, inside the returned JSX, immediately below the closing `</form>` (keep the password form exactly as it is — this is additive, placed after it):

```tsx
      {googleAvailable && (
        <>
          <div className="text-center text-xs text-muted">or</div>
          <Button variant="secondary" onClick={() => void continueWithGoogle()} disabled={busy}>
            Continue with Google
          </Button>
        </>
      )}
```

Since this new block sits outside the `<form>`, wrap the existing return value's outermost element so both the form and this block are siblings inside it (the current file returns `<form>...</form>` directly as the top-level element — change the top-level return to a `<div className="mx-auto mt-16 max-w-md space-y-4 p-6">` wrapping both the `<form className="space-y-4">` (drop the now-duplicated outer margin classes from the form since the wrapper carries them) and the new Google block).

- [ ] **Step 2: Add the same option to `src/console/pages/Bootstrap.tsx`**

This one is slightly more involved because bootstrap's Google path needs a session *before* the org-name can be submitted, while the password path submits everything in one form as today. Add:

```tsx
const [googleAvailable, setGoogleAvailable] = useState(false);
const [googleSession, setGoogleSession] = useState<{ email: string } | null>(null);

useEffect(() => {
  void api.get<{ google: boolean }>('/auth-config').then((c) => setGoogleAvailable(c.google)).catch(() => {});
  void api.get<{ user?: { email?: string } } | null>('/auth/get-session')
    .then((s) => setGoogleSession(s?.user?.email ? { email: s.user.email } : null))
    .catch(() => {});
}, []);

const continueWithGoogle = async () => {
  setBusy(true); setError(null);
  try {
    const { url } = await api.post<{ url: string }>('/auth/sign-in/social', {
      provider: 'google',
      callbackURL: window.location.origin,
    });
    window.location.href = url;
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Sign-in failed');
    setBusy(false);
  }
};

// A session already exists (the operator just came back from Google) — the
// org-name-only submit, distinct from the full email/password form below.
const submitForSession = async (e: React.FormEvent) => {
  e.preventDefault();
  setBusy(true); setError(null);
  try {
    await api.post('/bootstrap', { orgName });
    onDone();
  } catch (err) {
    if (err instanceof ApiError && err.body.error === 'already_bootstrapped') return onSignIn();
    setError(err instanceof Error ? err.message : 'Bootstrap failed');
  }
  finally { setBusy(false); }
};
```

Then, right after the opening of the returned JSX (before the existing `<form onSubmit={submit} ...>`), add the Google-session branch as an early return so the two paths never render at once:

```tsx
  if (googleSession) {
    return (
      <form onSubmit={submitForSession} className="mx-auto mt-16 max-w-md space-y-4 p-6">
        <h1 className="text-xl font-semibold">Name this brain&apos;s organization</h1>
        <p className="text-sm text-muted">
          Signed in as {googleSession.email}. This name is shown to everyone you invite later.
        </p>
        <Input placeholder="Organization name" value={orgName}
               onChange={(e) => setOrgName(e.target.value)} required />
        {error && (
          <Notice tone="danger">
            <Icon glyph={CircleAlert} size={16} />
            <span>{error}</span>
          </Notice>
        )}
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create organization'}
        </Button>
      </form>
    );
  }
```

And add the Google button below the existing password form's closing `</form>` (same pattern as Task 4 Step 1 — wrap both in a shared outer `<div>`, add `{googleAvailable && (...)}`).

- [ ] **Step 3: Manual check in a browser** (per this repo's UI-change convention)

Run the dev server, confirm: with no `GOOGLE_CLIENT_ID`/`SECRET` set, neither page shows a Google button and both behave exactly as before; with both set (a real or placeholder Google OAuth client for local testing), the button appears and — for `SignIn.tsx` on a bootstrapped instance — clicking it redirects to `accounts.google.com`.

- [ ] **Step 4: Commit**

```bash
git add src/console/pages/SignIn.tsx src/console/pages/Bootstrap.tsx
git commit -m "console: offer Continue with Google alongside the existing sign-in form"
```

---

### Task 5: `/api/me` and a `noAccess` phase for an uninvited Google sign-in

**Files:**
- Modify: `src/control/routes/auth.ts`
- Modify: `src/console/App.tsx`
- Create: `src/console/pages/NoAccess.tsx`
- Modify: `test/unit/console-app.test.ts`

**Interfaces:**
- Produces: `GET /api/me` → `200 { email: string, hasMembership: boolean }` for any session; `401` for none.
- `Phase` gains `'noAccess'`; `phaseFor` gains a required `hasMembership: boolean` third argument.

- [ ] **Step 1: Add `GET /api/me`** to `src/control/routes/auth.ts`, after `/auth-config`:

```ts
authRoutes.get('/me', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const userId = session?.user?.id;
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const [row] = await getDb().select({ id: schema.memberships.id }).from(schema.memberships)
    .where(eq(schema.memberships.userId, userId));
  return c.json({ email: session.user.email, hasMembership: !!row });
});
```

(add `import { getDb, schema } from '../db/client.ts';` and `import { eq } from 'drizzle-orm';` to this file's imports if not already present — check first, since Task 1/2 did not add them.)

- [ ] **Step 2: Create `src/console/pages/NoAccess.tsx`**

```tsx
import { sessionApi } from '../api.ts';
import { Button, Notice } from '../ui/index.tsx';

/** D5: reachable only once Google is configured — a Google account with no
 *  invitation can still complete sign-in, and this is the honest landing
 *  spot for that session instead of a silently broken app shell. */
export function NoAccess({ email }: { email: string }) {
  const signOut = async () => {
    await sessionApi.signOut();
    window.location.reload();
  };

  return (
    <div className="mx-auto mt-16 max-w-md space-y-4 p-6">
      <h1 className="text-xl font-semibold">No access yet</h1>
      <Notice tone="warning">
        <span>
          Signed in as <strong>{email}</strong>, but this account isn&apos;t a member of this
          brain. Ask an admin to invite this address, or sign in with a different account.
        </span>
      </Notice>
      <Button variant="primary" onClick={() => void signOut()}>Sign out</Button>
    </div>
  );
}
```

- [ ] **Step 3: Wire it into `src/console/App.tsx`**

```ts
type Phase = 'loading' | 'bootstrap' | 'signin' | 'noAccess' | 'wizard' | 'ready';
```

```ts
/** ... existing doc comment, plus:
 *   403 from /wizard/state + no membership at all -> 'noAccess' (D5): a
 *     real session (Google or otherwise) that isn't a member of any org.
 *     A 403 WITH a membership (wrong role for the admin-only wizard) still
 *     reads as 'ready', exactly as before.
 */
export function phaseFor(bootstrapped: boolean, probe: WizardProbe, hasMembership: boolean): Phase {
  if (!bootstrapped) return 'bootstrap';
  if (probe.status === 'unreachable' || probe.status === 401) return 'signin';
  if (probe.status === 403) return hasMembership ? 'ready' : 'noAccess';
  if (probe.status >= 200 && probe.status < 300) {
    return probe.lifecycle === 'ready' ? 'ready' : 'wizard';
  }
  return 'signin';
}
```

Update `refresh()`:

```ts
  const [noAccessEmail, setNoAccessEmail] = useState('');

  const refresh = async () => {
    const { bootstrapped } = await api.get<{ bootstrapped: boolean }>('/bootstrap');
    if (!bootstrapped) return setPhase('bootstrap');
    let probe: WizardProbe;
    try {
      const state = await api.get<{ lifecycle: string }>('/wizard/state');
      probe = { status: 200, lifecycle: state.lifecycle };
    } catch (err) {
      probe = err instanceof ApiError ? { status: err.status } : { status: 'unreachable' };
    }
    let hasMembership = false;
    if (probe.status === 403) {
      const me = await api.get<{ email: string; hasMembership: boolean }>('/me').catch(() => null);
      hasMembership = me?.hasMembership ?? false;
      setNoAccessEmail(me?.email ?? '');
    }
    setPhase(phaseFor(bootstrapped, probe, hasMembership));
    setIsAdmin(isAdminFrom(probe));
  };
```

Add the render branch (next to the existing `if (phase === 'signin') ...` line) and the import:

```ts
import { NoAccess } from './pages/NoAccess.tsx';
```
```tsx
  if (phase === 'noAccess') return <NoAccess email={noAccessEmail} />;
```

- [ ] **Step 4: Update `test/unit/console-app.test.ts`**

Read the file first to find its existing `phaseFor` call sites and add the new third argument to each (pass `false` for every existing case — none of them were testing the membership dimension), then add:

```ts
test('a 403 with no membership at all is noAccess, not ready', () => {
  expect(phaseFor(true, { status: 403 }, false)).toBe('noAccess');
});

test('a 403 with a membership stays ready (wrong role, not no access)', () => {
  expect(phaseFor(true, { status: 403 }, true)).toBe('ready');
});
```

- [ ] **Step 5: Run it**

Run: `bun test test/unit/console-app.test.ts`
Expected: all pass, including the two new cases.

- [ ] **Step 6: Commit**

```bash
git add src/control/routes/auth.ts src/console/App.tsx src/console/pages/NoAccess.tsx test/unit/console-app.test.ts
git commit -m "console: give a Google sign-in with no org an honest no-access screen"
```

---

### Task 6: A test-only session helper, for the two Google-specific tests only

**Files:**
- Create: `src/control/auth.test.ts`

**Interfaces:**
- Produces: `testAuth` (a second Better Auth instance, same DB, plus `testUtils()`), used only by test files that need to simulate an authenticated-via-Google session without a real OAuth round trip.

This task exists only to de-risk Task 2 Step 3's manual session row (which may or may not satisfy Better Auth's cookie signature check — untested assumption flagged there). It is **not** a general-purpose replacement for the password-based test helpers already in the other 19 files; those are untouched by this plan.

- [ ] **Step 1: Create `src/control/auth.test.ts`**

```ts
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { getDb, schema } from './db/client.ts';

type Db = ReturnType<typeof getDb>;

const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = getDb() as object;
    const value = Reflect.get(real, prop, real);
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
});

/**
 * D6: used ONLY by tests that need a session for a Google-style sign-in
 * without a real OAuth round trip (bootstrap-google.test.ts). Never
 * imported by production code. Better Auth's own testUtils plugin doc
 * comment (node_modules/better-auth/dist/plugins/test-utils/index.mjs)
 * recommends exactly this: a separate instance, not a flag on the real one.
 */
export const testAuth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
    },
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.PUBLIC_URL ?? 'http://localhost:3150',
  basePath: '/api/auth',
  plugins: [testUtils()],
});
```

- [ ] **Step 2: If Task 2 Step 4 found the manual session insert failing signature verification, replace it**

In `test/integration/bootstrap-google.test.ts`, swap the manual `schema.users` + `schema.sessions` inserts for:

```ts
import { testAuth } from '../../src/control/auth.test.ts';
// ...
const ctx = await testAuth.$context;
const created = await ctx.internalAdapter.createUser({
  email: 'google-admin@example.test', name: 'Google Admin', emailVerified: true,
});
const { headers } = await ctx.test.login({ userId: created.id });
const cookie = headers.get('cookie') ?? '';
// use `cookie` directly as the request's `cookie` header — it is already
// the exact "name=signedvalue" pair a real sign-in would send back.
```

- [ ] **Step 3: Run the bootstrap-google test again**

Run: `bun test test/integration/bootstrap-google.test.ts`
Expected: both tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/control/auth.test.ts test/integration/bootstrap-google.test.ts
git commit -m "test: add a Google-session test helper for the new bootstrap path"
```

---

### Task 7: Deployment docs — Google stays opt-in

**Files:**
- Modify: `scripts/install.sh`
- Modify: `docs/runbooks/install.md`

- [ ] **Step 1: Offer, don't require, in `scripts/install.sh`**

Near where `DOMAIN` is resolved (`scripts/install.sh:70-75`), add an optional prompt that's easy to skip:

```bash
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"
GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-}"
if [ -z "$INSTALL_MODE" ] && [ -z "$GOOGLE_CLIENT_ID" ]; then
  echo "" >&2
  echo "Optional: 'Continue with Google' sign-in, alongside email/password." >&2
  echo "Leave blank to skip — email/password keeps working either way." >&2
  read -r -p "Google OAuth Client ID (leave blank to skip): " GOOGLE_CLIENT_ID || true
  if [ -n "$GOOGLE_CLIENT_ID" ]; then
    read -r -p "Google OAuth Client Secret: " GOOGLE_CLIENT_SECRET || true
  fi
fi
export GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
```

Then, where the generated `.env` is written (`scripts/install.sh:157` area, alongside `DOMAIN=${DOMAIN}`):

```bash
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
```

No `:?required` anywhere — an empty value is a valid, supported configuration.

- [ ] **Step 2: Update `docs/runbooks/install.md`**

Read the file first, then add a short, clearly-optional "Google sign-in (optional)" subsection near the existing "create your first admin" step: what it adds (a second way in, not a replacement), how to get a Client ID/Secret, and the exact redirect URI to register. Leave every existing password-based instruction exactly as it is.

- [ ] **Step 3: Commit**

```bash
git add scripts/install.sh docs/runbooks/install.md
git commit -m "install: offer optional Google OAuth setup, default to skip"
```

---

## Self-Review Notes

- **Spec coverage:** D1 (Task 1), D2 (Task 2), D3 (Task 3), D4 (Task 1+4), D5 (Task 5), D6 (Task 6) each map to a task; Task 7 covers deployment ergonomics.
- **Placeholder scan:** every step carries real code; Task 2 Step 3 explicitly flags one genuine unknown (whether a hand-built session cookie passes Better Auth's signature check) and gives the exact fallback (Task 6) rather than asserting an unverified claim as fact.
- **Type consistency:** `bootstrapFirstAdmin`'s existing signature and return shape are untouched; `bootstrapFirstAdminForSession` returns the identical `{userId, orgId, brainId}` shape so both routes' response bodies stay consistent. `phaseFor`'s new third parameter is required, so TypeScript catches any call site Task 5 missed.
- **What changed from the previous version of this plan:** that version made Google the *only* sign-in method, removed `emailAndPassword` entirely, and required rewriting all 19 password-based test files onto a gated test-session route. This version keeps password auth fully intact and adds Google as an option, which is why Task 8 ("migrate every test file") from the previous version no longer exists — nothing about existing tests needs to change.
