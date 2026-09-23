# Personal and Company Zones — Design

**Date:** 2026-09-22
**Status:** Approved concept; sub-projects 1–3 planned, sub-project 4 needs its own spec.

## 1. The concept

A Mobrain deployment is **one brain**: one control database, one gbrain, one
provider key, one search mode, one schema. Inside it there are two kinds of
**zone**, each with the same four parts:

| | **My Brain** (every user) | **Company Brain** (company mode only) |
|---|---|---|
| Space | "My Space" — private notes and knowledge | Shared Spaces (Sales, Engineering, …) |
| Sandbox | *My sandbox*: my Claude Code / Codex, logged in as me, with my MCP connectors (my email, calendar, meetings) | *Company sandbox*: the company's agent login and connectors |
| Schedules | Automations that run in my sandbox, write to My Space, and may read company Spaces I am granted | Automations that run in the company sandbox and write to company Spaces |
| Runs | My history and spend | Company history and spend |
| Managed by | Only me | Admins |
| Visible to | Only me. An admin sees my **spend total** and nothing else | Members, through admin-issued grants (read or write) |

Rules that define the product:

- **Private means private, enforced server-side.** No role — owner and admin
  included — can list, read, or act on another member's personal zone: not its
  Space, files, connections, schedules, runs, run events, or alerts. The only
  cross-zone disclosure is the per-member spend total on the admin Spend page.
- **Personal agents can read company knowledge.** A connection a member creates
  writes to their own Space and may read company Spaces they hold a grant on.
  Company automations never read a personal Space.
- **Personal mode** is the same product with the Company zone switched off. The
  console shows only My Brain; team surfaces are hidden and their APIs refuse.
- **Company mode** is switched on in Settings → General. It unlocks shared
  Spaces, invites, and grants. It can be switched back only while the owner is
  still the only member and no invite is outstanding.
- **Invitees** join the same deployment as `member` (default), get their own
  private My Space automatically, create a real console login from the invite
  link, and land in My Brain with the Company zone showing their grants.

## 2. Decisions (from brainstorming, 2026-09-22)

| # | Decision |
|---|---|
| D1 | An invitee's "own workspace" is a private Space inside the company deployment — not a separate brain. Provider, search mode and schema are the deployment's. |
| D2 | Invite login: the claim page sets a password (≥ 12 chars). Google sign-in, when `docs/superpowers/plans/2026-09-22-google-exclusive-auth.md` ships, is an additional option on the same page. |
| D3 | Company → personal is allowed only while the owner is the sole membership and no unclaimed, unexpired claim link exists. |
| D4 | Admin visibility into personal zones: spend totals and run counts per member only. |
| D5 | Mode gating is one real flag (`organizations.brain_mode`) turned into named capabilities, enforced on the API and mirrored in the console. |
| D6 | First-run setup always creates a personal brain on schema pack `gbrain-base-v2`; the wizard has no schema step and no mode step. |
| D7 | Access to company Spaces is an explicit `space_grants` table, no longer derived from connection rows. |
| D8 | Sandboxes are hosted, one per zone, on the deployment's server (sub-project 4). |

## 3. What exists today (grounding)

- `organizations.brain_mode` exists (`personal | company`, CHECK) and nothing
  reads it; bootstrap hardcodes `'company'` (`src/control/bootstrap.ts:29`).
- `gbrain init` already defaults to `gbrain-base-v2`; `brains.schema_pack` is
  null unless the wizard stored a pick.
- Private member Spaces exist (`spaces.owner_membership_id`,
  `src/control/privateSpaces.ts`) and are already opaque in the Files routes and
  `/access-overview` (`src/control/spaceAccess.ts`).
- **Leaks to fix:** `GET /schedules`, `GET /schedules/:id`, `/schedules/:id/runs`,
  `GET /runs`, `GET /runs/:id`, `/schedule-alerts` are open to any `viewer` in
  the org with no zone filter; `ownsConnection` lets an admin act on a member's
  private connection; `GET /connections` and `GET /sources` list other members'
  private rows; Spend's by-schedule section names personal schedules.
- Invitees cannot sign in to the console: `POST /members` gives them a random
  unusable password and claim only returns MCP credentials.
- Schedules already hang off a connection, and every connection has exactly one
  write Space — so a schedule's zone is its connection's write Space's zone.
- The agent runner is one shared container, ephemeral workspace per run, org
  key through the gateway, egress fenced to gateway + `/mcp`.

## 4. The zone rule (one derivation)

A Space's zone is its owner: `owner_membership_id` set → personal (owned by
that membership); null → company. Every other object inherits the zone of the
Space it writes to:

```
connection.zone = zone(connection.write_space)
schedule.zone   = zone(schedule.connection)          -- null connection → company, admin-only
run.zone        = zone(agent_run.connection)         -- null connection → company, admin-only
alert.zone      = zone(alert.schedule)               -- null schedule   → company, admin-only
```

Visibility, for a caller with membership `m` and role `r`:

- personal zone owned by `m` → visible and actionable by `m` only.
- personal zone owned by anyone else → invisible (404, never 403, so existence
  does not leak), for every role.
- company zone → today's role rules (viewer reads, member acts on own
  connection, admin acts org-wide), with Space content filtered by grants.

This lives in one module (`src/control/zone.ts`) and every route calls it.

## 5. Sub-projects

Each has its own plan. Build in order; 2 and 3 depend on 1.

### 5.1 Zones and privacy — `plans/2026-09-22-zones-1-privacy.md`
- `src/control/zone.ts`: zone derivation + SQL visibility predicate.
- Apply to schedules, runs, alerts, connections list, sources list, spend.
- `space_grants (organization_id, membership_id, space_id, access)`, backfilled
  from existing connections; `spaceAccess` reads grants, not connections.
- Admin grant API (`GET/PUT/DELETE /api/grants`); removing a grant revokes
  the member's connections that touch that Space, except their own private
  connection, which is rescoped to drop it so their personal agent keeps working.
- Self-service connection scope: `GET/PUT /api/my/connection`. There is
  exactly one connection per (member, write Space) — client names are
  `bs-<member8>-<spaceSlug>` and unique — so "my agent" is the private
  connection `provisionPrivateSpace` creates. Its write Space is always the
  caller's own; the member chooses its read Spaces from within their grants.
- Per-member budget caps are deferred to 5.4, because who pays for personal
  model calls is open there.
- Spend: personal schedules collapse to one row per member.

### 5.2 Personal-first setup and the company switch — `plans/2026-09-22-zones-2-personal-first.md`
- Bootstrap writes `brain_mode = 'personal'` and `schema_pack = 'gbrain-base-v2'`.
- Wizard: search-mode step also passes `schema-selected` when a pack is stored;
  the Schema step renders only for legacy brains without one.
- `src/control/capabilities.ts`: `invite`, `sharedSources`, `grants` from mode;
  enforced on `POST /members`, `POST /members/:id/claim-link`, `POST /sources`,
  `PUT/DELETE /api/grants`.
- `GET /api/org`, `PATCH /api/org/mode` (owner only, D3 rule).
- Console: Settings → General (mode switch + brain name); Members/Access tabs
  hidden in personal mode.

### 5.3 Invite login and the member experience — `plans/2026-09-22-zones-3-invite-login.md`
- `users.invite_placeholder` marks accounts created by an invite.
- `POST /api/claim/:token` accepts `password`; sets it only on a placeholder
  account, clears the flag, verifies the email.
- Claim page: "Create your account" (password + confirm) → signs in → app.
- Space picker groups My Brain / Company (`/api/spaces` returns `zone`).
- Settings → "My Brain" tab (every role): the member's private Space and the
  granted company Spaces their agent may read.

### 5.4 Hosted sandboxes — needs its own brainstorm and spec
Scope: per-zone container + persistent volume managed by the control plane;
web terminal for one-time agent login and connector setup; runner claim
filtered by zone; per-sandbox egress policy (open to the owner's connectors,
closed to control-plane internals and other sandboxes); Claude Code or Codex.

Open questions that block a plan:
1. **Who pays for model calls.** An agent logged in with the member's own
   Claude/ChatGPT account bypasses the org gateway, so D4's spend totals would
   cover only org-key runs. Decide whether personal sandboxes may use the org
   key, their own account, or either — and whether a per-member budget cap
   (deferred from 5.1 for this reason) is enforceable.
2. **Isolation on one host.** No Docker socket in sandboxes, CPU/memory/disk
   limits, a network per sandbox, and what an admin can do to a member's
   sandbox (stop it? delete it on offboarding?) without seeing inside.
3. **Web terminal transport and auth** through the existing Caddy front door.
4. **Relationship to today's shared runner** — replace, or keep it for company
   jobs only.

## 6. Out of scope

- Multiple organizations per user, or a user belonging to two companies.
- Moving a personal Space into the company zone (or vice versa).
- A richer member role model than `admin` vs not-admin in the console.
- Google sign-in itself (its own plan; this design leaves the hook).
