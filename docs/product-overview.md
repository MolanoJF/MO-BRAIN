# Mobrain — product overview

A plain-language walkthrough of what Mobrain is, how it's put together, and everything it
does today (as of the 1.0.0 / `v1.0.0` release). This is an explainer, not a runbook — for
operational detail, follow the links out to `docs/runbooks/`.

---

## 1. What it is, in one paragraph

**Mobrain is a self-hosted "company brain."** A team runs one install command on a single
host, and gets back a private, permissioned knowledge base that both people and AI agents
can query — plus a web console to manage who has access, what's connected, what's scheduled,
what it's spending, and how it gets upgraded. The knowledge engine itself is **gbrain**, an
open-source CLI/MCP tool Mobrain does not fork or modify — it drives it entirely through
gbrain's own published interfaces (CLI argv, HTTP MCP, and a small file-based config surface).
Mobrain's job is everything gbrain *doesn't* do: multi-user auth and roles, a managed
deployment, backup/restore, scheduled jobs, spend visibility, safe upgrades, and — optionally —
letting an AI agent act against the brain unattended on a schedule.

Think of it as: **gbrain is the engine; Mobrain is the car** — the dashboard, the ignition key,
the seatbelts, and the maintenance schedule.

---

## 2. The mental model

```
                         ┌─────────────────────────────┐
   Browser (you) ───────▶│   Console (React SPA)        │
                         │   /api/* only — no /admin     │
                         └───────────────┬───────────────┘
                                          │
                         ┌────────────────▼───────────────┐
                         │        control-plane            │
                         │  auth · RBAC · Connections ·     │
                         │  schedules · spend · upgrades ·  │
                         │  backup/restore · model gateway  │
                         └───┬──────────────┬───────────┬───┘
                              │              │           │
              ┌───────────────▼──┐   ┌───────▼─────┐ ┌───▼────────────┐
              │  gbrain-ops (RPC) │   │  scheduler  │ │   agent-runner  │
              │  the ONLY path    │   │  cron-ish   │ │   (optional)    │
              │  to gbrain's CLI  │   │  job runner │ │  runs Claude    │
              └───────────────┬───┘   └───────┬─────┘ │  Code against   │
                               │                │       │  the brain      │
                   ┌───────────▼────────────────▼───┐   └───────┬─────────┘
                   │   gbrain-serve / gbrain-worker   │           │
                   │   the actual brain: Postgres +   │◀──────────┘
                   │   embeddings + git-backed Spaces │   (via the gateway,
                   └───────────────────────────────────┘    never directly)

   Everything above sits behind Caddy, the only service that publishes
   host ports (80/443), which terminates real TLS for your DOMAIN.
```

Two databases: a `control` Postgres (Mobrain's own state — users, orgs, connections,
schedules, spend, audit log) and a `gbrain` Postgres (the actual knowledge store — pages,
embeddings, Spaces). Mobrain never reads gbrain's tables directly; it only talks to gbrain
through the ops RPC or the CLI.

---

## 3. Core concepts

| Term | What it means here |
|---|---|
| **Organization** | One org per deployment — Mobrain is **not multi-tenant**. One brain, one org, one host. |
| **Member** | A person with an email/password account and a role: `owner`, `admin`, `member`, or `viewer`. |
| **Space** | A boundary inside the brain, backed by a git repo (`source_id`). Read access can *federate* across Spaces; write access is per-Space. This is the only isolation axis gbrain offers. |
| **Connection** | The credential that lets *one member's agent* (Claude, or any MCP client) talk to the brain — a compiled, scoped MCP profile: which Space it can write to, which Spaces it can read, which tools it gets. |
| **Schedule** | A recurring job (sync, dream, doctor, a git push, or — if the runner is on — an unattended agent prompt), run by the `scheduler` service. |
| **Agent runner** | An optional, off-by-default container that actually executes a scheduled AI agent prompt against the brain, using the org's own API key. |
| **Spend** | Metered token/dollar usage, attributed per member and per org, read from gbrain's own usage ledger. |
| **Upgrade** | A deterministic, host-driven, snapshot-first version bump of the pinned gbrain binary — never automatic, never agent-driven. |

---

## 4. How someone actually uses it

### 4.1 Install (one command, on one host)

```bash
bash scripts/install.sh
```

The command asks for a domain: a blank answer installs against the machine's own LAN address with a private certificate, and a domain answer takes the public-certificate path.

Before touching anything, `preflight.sh` checks Docker (24+/Compose v2.20+), 4 GB RAM, 20 GB
disk, ports 80/443 free, and that `DOMAIN` actually resolves to this host — refusing with a
specific exit code and a one-line fix if not. Once preflight passes, the installer:

1. asks, in plain language, whether to turn on the agent runner (default: **no**);
2. generates four secrets (`POSTGRES_PASSWORD`, `OPS_RPC_TOKEN`, `ENCRYPTION_KEY`,
   `BETTER_AUTH_SECRET`) into a `.env` file, mode `600`;
3. pulls three pinned, exact-version images from `ghcr.io/molanojf` (gbrain, control-plane,
   and — if enabled — agent-runner);
4. brings the whole stack up with `docker compose up -d --wait`.

You then open `https://<your-domain>` and create the **first admin** — a bootstrap form that
only appears once, before any org exists.

### 4.2 Sign in and land on the console

Everyone else after that first admin sees a normal sign-in page. There is **no `/admin`
route** — gbrain ships its own embedded admin SPA with god-mode rights over the brain, and
Mobrain deliberately answers `404` for it rather than exposing a second, unaudited control
plane. (Recovery when the console itself is down goes through SSH + the `gbrain-ops`
sidecar instead — see §6.6.)

### 4.3 The console's pages, 1:1 with the API

| Page | Route | What it's for |
|---|---|---|
| Sign in / Bootstrap | `/` | Auth, and first-admin creation |
| Members | `/members` | Invite/offboard people, assign roles |
| Connection | `/connect` | Each member wires up their own agent to the brain |
| Schedules | `/schedules` | Create/pause/inspect recurring jobs, read alerts |
| Runs | `/runs` | The agent-runner's run history, cost, and revert button |
| Spend | `/spend` | Metered usage by member/org, with coverage caveats stated up front |
| Upgrades | `/upgrades` | Check for a new gbrain version, plan/run/roll back |
| Health | `/health` | Live component health, pin match, runner state |
| Claim | `/claim` | Accepting an invite / pairing link |
| Wizard | (post-bootstrap) | First-run setup: pick search mode, see isolation notice, add sources |

---

## 5. Feature walkthrough

### 5.1 Auth, members, and roles

Standard email/password auth (`better-auth`), sessions cookie-based. Four roles, ranked
`owner > admin > member > viewer`, enforced by a single `requireRole` guard on every route.
Owners/admins manage members and Connections; members and viewers use their own Connection to
query the brain. Offboarding a member cascades: it revokes their Connections and, if nothing
blocks it (see F22 below), removes them cleanly. All admin actions land in an append-only
`audit_log` table (actor, action, target, before/after — request bodies are never logged raw).

### 5.2 Connections — how an agent actually reaches the brain

A **Connection** is the compiled, per-member MCP profile that lets *your* Claude (or any MCP
client) read and write the brain safely:

- **One write Space, many read Spaces.** You write to exactly one Space; you can read across
  several via `federated_read`.
- **Compiled, previewable, diffable.** Before you commit a Connection, the console shows you
  the *compiled* profile (`sourceId`, `federatedRead`, bound tool-name slug prefixes,
  warnings) and a diff (`removals`/`additions`/`requiresNewToken`) against what you had.
- **Auto-install snippets.** For supported harnesses, the console can hand you a ready-to-run
  wiring snippet rather than a page of manual config.
- **Revocable, not deletable (by design, for now).** `POST /api/connections/:id/revoke` exists;
  outright deletion doesn't yet — a revoked Connection survives, inert, until its member is
  offboarded. Tracked as a known gap (F22 / task #2 in the backlog), not an oversight.

### 5.3 Spaces and search

Spaces are gbrain's isolation primitive — each is a git-backed repo of pages. The setup wizard
lets an org pick a **search mode** (`conservative | balanced | tokenmax` — the pinned binary's
real vocabulary, not upstream's older `fast`/`thorough` naming) and shows each mode's relative
cost. Whether the *measured* cost multiplier is shown depends on whether it's actually been
measured on that deployment — Mobrain refuses to print an unmeasured number as if it were real
(see §7).

### 5.4 Scheduler — recurring jobs

A background `scheduler` service (leader/worker split via a Postgres advisory lock, so multiple
replicas are safe) runs jobs every 15 seconds of tick time. Presets:

| Preset | Cadence | What it does |
|---|---|---|
| `live-sync` | every 15 min | Import new commits, embed stale pages |
| `nightly-dream` | daily 02:05 | Model-assisted synthesis (costs money, capped at $10) |
| `weekly-health` | Mondays 06:10 | Full-brain `doctor --remediate` (needs an admin Connection) |
| `push-reconcile` | daily 04:15 | Push local changes back to the Space's git remote |
| `morning-briefing` | daily 08:05 | Releases anything held over quiet hours |
| `nightly-agent-briefing` | daily 03:05 | Runs a Claude Code prompt against the brain — **only if the agent runner is on** |

Rules worth knowing: at most one enabled sub-hourly interval schedule per org (a second is
refused, not silently collided); calendar jobs are staggered onto 5-minute slots; interval
jobs are computed in UTC (so DST-proof), calendar jobs are wall-clock with an explicit quiet-hours
window that *holds* rather than drops a run.

Every run lands in `schedule_runs` with a state (`pending / running / succeeded / failed /
lease_expired / …`) and, where relevant, an alert (`overlap_killed_previous`,
`connection_revoked`, and others) that the console surfaces and lets an admin acknowledge.

### 5.5 The agent runner — optional, off by default, deliberately boxed in

This is the feature that needs the most trust, so it gets the most fencing. When enabled, a
dedicated `agent-runner` container claims scheduled `agent_prompt` jobs and runs a **pinned,
exact-version** Claude Code harness (`2.1.274`) against the brain, spending the org's own API
key, unattended.

What it can **never** do, by design:
- No database URL (brain or control), no `GBRAIN_HOME`, no `OPS_RPC_TOKEN`, no provider key
  directly — its only credentials are a scoped `RUNNER_TOKEN` and a per-run gbrain token.
- No Docker socket, no persistent volume — its workspace is a fresh tmpfs directory per run,
  destroyed on every exit path.
- No host port, ever — Caddy is the only thing that publishes ports.
- No outbound route — `runner-net` is an internal Docker network with no default route; tool
  allow/deny-lists are defense in depth on top of that, not the primary fence.
- **No Bash**, as a job class — Slice 4 deliberately never implemented it; a prompt asking for
  Bash produces no tool call at all.

Every run is inspectable ("what did the 3am agent do?" — `/runs`), every run is costed against
the org's meter, and every run can be **reverted with one button** (`POST /api/runs/:id/revert`)
— which undoes the pages it touched, though the runbook is explicit about the honest limits of
that diff (it undoes writes, not side effects outside the brain). Killing an in-flight run is
also one button, and the run's own ledger records exactly what happened either way.

### 5.6 Spend

`GET /api/spend` (admin-only) reports metered usage per member and per org, sourced from
gbrain's own usage ledger. Two honesty rules bake into the surface:

- **It states its own coverage before its totals.** If gbrain's usage ledger can't be reached,
  the report says so explicitly (`coverage.brainReachable: false`) rather than silently
  reporting zero.
- **It never sums meters it can't reconcile.** gbrain's own `notCovered` list is carried
  verbatim rather than folded into a total that would misstate what's actually measured.

### 5.7 Backup and restore

A **host** operation (never in-container — the control-plane image has no Docker CLI), driven
by `scripts/backup.ts` / `scripts/restore.ts`. One backup = one archive with:

- `brain-<stamp>.sql` — full dump of the knowledge database
- `control-<stamp>.sql` — full dump of Mobrain's own state
- `secrets-<stamp>.sql` — just the encrypted `secrets` table (so restore can rehydrate
  credentials without a full control-DB restore)
- `brain-repos-<stamp>.tar` — the Spaces' actual git repositories
- `manifest.json` — checksums, a `quiesced` state (`verified / unverified / failed`), and a
  warning

Two things it **deliberately never contains**: `ENCRYPTION_KEY` (the key that unlocks every
encrypted secret — keep it separately, or the archive is a brick; together, it's a credential
dump) and the gbrain file-plane config (which holds a provider key in the clear — restore
re-materializes it from the encrypted dump instead).

Restoring to a **new domain** works, but invalidates every OAuth grant and Connection (a new
domain is a new redirect URI), which raises visible `connection_revoked` alerts rather than
leaving a console that looks connected but isn't.

### 5.8 Upgrades

One host-driven, deterministic operation, never automatic, never triggered by the agent
runner:

```bash
bun run scripts/upgrade.ts plan --to <exact-version>     # dry run, nothing touched
bun run scripts/upgrade.ts run  --to <exact-version> --yes
bun run scripts/upgrade.ts rollback --run <runId>         # one command back
```

Every upgrade: snapshots both databases and both volumes with zero writers first, swaps
images, applies migrations plus a hand-written per-version playbook, then gates on `doctor`
parity before declaring success. Rollback is a snapshot restore, because upstream gbrain ships
no reverse migrations. A console banner offers an available version (never auto-selects one);
a nightly CI job runs the contract suite against both the current pin and the *next* upstream
version as an early-warning tripwire for drift.

### 5.9 Health and observability (what exists today)

`GET /api/health` reports component status (`controlDb`, `ops`), the declared-vs-observed
version pin (and whether they match), the agent-runner's connection state, per-repo git
status, and open schedule alerts. There's no time-series/metrics dashboard yet (Prometheus,
queue-age percentiles, etc.) — that's an explicit, deferred backlog item, not a bug.

---

## 6. Trust boundaries and things it deliberately refuses to do

- **Never forks or patches gbrain.** Everything goes through gbrain's published CLI (argv
  arrays, never shell strings), its HTTP MCP, or a narrow file-config surface for the few
  things `config set` won't do.
- **`/admin` is not exposed.** gbrain's own admin SPA is a second, unaudited control plane;
  Mobrain 404s it and documents an SSH break-glass path instead
  (`docker compose exec gbrain-ops gbrain <command>`).
- **Not multi-tenant.** One brain, one org, one host. A shared deployment serving several
  organizations is explicitly not a supported shape.
- **Not a managed service** in this release — no signup flow, no billing, no provisioner.
  (Managed cloud is a deferred future slice: the decided shape is one VM per tenant,
  provisioned via a cloud API and installed by running this same `install.sh` over SSH —
  not a shared fleet, not Kubernetes.)
- **The agent runner never drives an upgrade**, and upgrades are never automatic.
- **Docker socket is never mounted into anything that touches agent output.**

---

## 7. What's honestly unfinished (as of 1.0.0)

The product is explicit about its own gaps rather than hiding them:

- **Search-mode cost isn't measured yet** on a real corpus, so the wizard says "not measured
  on this deployment" instead of guessing — this blocks pricing the (not-yet-built) managed
  cloud tier.
- **No `DELETE` for a revoked Connection** yet — it survives until its member is fully
  offboarded.
- **No retry path** for an agent run whose lease expired (its runner died mid-run).
- **No historical/trended observability** (metrics dashboard, queue-age percentiles) — out of
  scope for GA on purpose, revisited alongside managed cloud.

Full detail: `docs/pending-tasks.md`.

---

## 8. Where to go next

| Need | Doc |
|---|---|
| Install it | `docs/runbooks/install.md` |
| Back it up / restore it | `docs/runbooks/backup-restore.md` |
| Turn on / operate the agent runner | `docs/runbooks/agent-runner.md` |
| Schedules and alerts | `docs/runbooks/scheduler.md` |
| Upgrade it | `docs/runbooks/upgrade.md` |
| Recover when the console is down | `docs/runbooks/break-glass.md` |
| What's supported, for how long | `docs/support-policy.md` |
| Everything still open | `docs/pending-tasks.md` |
| Full architectural history / decisions | `HANDOFF.md`, `docs/superpowers/plans/` |
