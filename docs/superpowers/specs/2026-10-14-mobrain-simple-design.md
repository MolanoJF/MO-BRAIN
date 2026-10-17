# Mo-brain, simplified: design

Date: 2026-10-14. Status: approved in conversation, pending written-spec review.
Supersedes the product shape described in `HANDOFF.md` (1.0.0 and everything on `main` after it). The current `main` is tagged `v1-final` before any of this lands.

## 1. Goal

A person tells their coding agent "install mobrain", gives one API key, and says which of their sources to connect. The agent does the rest in the background and reports back with a populated brain, running collectors, and a link to a review UI. After that, every change to the brain goes through the agent and gbrain's own MCP.

Mo-brain is gbrain, packaged: a small Docker stack, an install skill, collector skills that the person's own agent runs on a timer, a read-mostly review UI, and a thin people layer for company mode. Anything gbrain already does, Mo-brain does not reimplement.

### Success criteria

1. On a fresh host, "install mobrain" to a populated brain with at least one scheduled collector takes at most three human touchpoints: the request, one answer batch (key and sources), and connecting any source tool the agent does not already have.
2. `mobrain status` reports `ok: true`, and the pinned gbrain version matches the running one.
3. Every chosen source is backfilled. Its collector page shows `last_status: ok`, and the next run happens with nobody present.
4. The UI shows pages, sources and collectors, the schema, activity and health.
5. Company mode works end to end: switch, invite, join, grant. A member cannot read another member's private source or an ungranted company source. `mobrain selftest` proves this.
6. Hand-written code in `src/` and `bin/` is under 10,000 lines (target 6,000 to 8,000; today it is about 55,000).
7. The old suites are deleted. The new unit tests and `mobrain selftest` pass locally.

## 2. Settled decisions

| # | Decision | Source |
|---|---|---|
| D1 | Collectors run in the person's own agent harness, headless, from a host timer. No runner container. | User, 2026-10-14 |
| D2 | Fresh minimal core in this repo. Tag `v1-final` first; delete what is not ported. | User, 2026-10-14 |
| D3 | The UI is read-only, except one People & access page for company mode. | User, 2026-10-14 |
| D4 | Keep company brain and multiple members, minimal, on gbrain-native clients and sources. | User, 2026-10-14 |
| D5 | Schema authoring goes through gbrain's tools and gbrain's `schema-author` procedure. The UI shows the schema read-only. | User, 2026-10-14 |
| D6 | No separate Mo-brain MCP. The agent uses gbrain's MCP for brain work and the `mobrain` CLI for people and stack work. | User, 2026-10-14 |
| D7 | One OpenAI key is the default provider. It is the one key that covers embeddings and extraction. | Default, accepted |
| D8 | Postgres engine in Docker; gbrain pin moves to `0.60.230.0`. | Default, accepted |
| D9 | `mobrain-core` stays the locked base schema. Search mode defaults to `balanced`. | Default, accepted |
| D10 | Source auth belongs to the person: their harness's MCP connections, claude.ai connectors, or a gateway such as Composio or executor. Mo-brain builds no OAuth connector. | User, 2026-10-14 |

Unchanged rules: gbrain is never forked, and is driven only through its CLI (argv arrays, never a shell string), its HTTP MCP, and its owner admin HTTP API. The CI budget rules in `CLAUDE.md` stand.

## 3. Non-goals for this version

- A public domain, Caddy, or TLS termination. Access is `127.0.0.1` plus `tailscale serve`.
- SSO, Google sign-in, folder-level permissions, or privacy that hides data from the host operator. gbrain supports none of these, and the operator can read everything on the host.
- gbrain's native Google connector, chat-history cookie connectors, and webhooks. These can be added later as collector kinds.
- Briefings and other outbound jobs.
- Editing pages in the browser.
- Per-source schema packs. One schema per brain.
- Hosted sandboxes, managed cloud, a release and publish lane (images are built locally), and spend metering.
- Email delivery of invites. The invite link is shown to the inviter to send.

## 4. Architecture

```
                 person's harness (Claude Code, ...)
                   │  MCP over HTTP (bearer = agent client)
                   │  mobrain CLI (people, stack, collectors)
                   ▼
 127.0.0.1:${MOBRAIN_PORT} ── tailscale serve (optional)
                   │
            ┌──────┴───────┐
            │   mobrain    │  Bun + Hono: UI, /api, install assets,
            │  (UI + API)  │  reverse proxy for /mcp + OAuth paths
            └──┬───────┬───┘
     /mcp etc. │       │ owner admin API, CLI reads (schema show, autopilot status)
            ┌──▼───────▼──┐        ┌────────────┐
            │   gbrain    │        │ autopilot  │ §8.5 sweep loop (foreground)
            │ serve --http│        │            │ sweep --once, embed --stale
            └──────┬──────┘        └─────┬──────┘
                   └──────────┬──────────┘
                        ┌─────▼─────┐
                        │ postgres  │  DBs: gbrain, mobrain
                        └───────────┘
```

### 4.1 Containers

| Service | Image | Process | Mounts | Network |
|---|---|---|---|---|
| `postgres` | `pgvector/pgvector:pg16` | postgres | `pg-data`, `compose/initdb` | `internal` |
| `gbrain` | `mobrain-gbrain:${GBRAIN_VERSION}` | `gbrain serve --http --bind 0.0.0.0 --port 3131 --public-url ${MOBRAIN_PUBLIC_URL}` | `gbrain-home` (rw) | `internal` |
| `autopilot` | same | `compose/autopilot-loop.sh` mounted read-only: `gbrain sweep --once` then `gbrain embed --stale`, sleep `${AUTOPILOT_INTERVAL:-300}` (never `gbrain autopilot`, never `--install`, never an `sh -c` string) | `gbrain-home` (rw), script (ro) | `internal` |
| `mobrain` | `mobrain-app:local` (FROM the gbrain image) | `bun src/server/main.ts` on 3000 | `gbrain-home` (rw, shared writer lock; not the Docker socket) | `internal`; the only published port, `127.0.0.1:${MOBRAIN_PORT:-8787}:3000` |

- The `mobrain` image is built from the gbrain image so the server can run gbrain's read-only CLI (`schema show --json`, `autopilot --status --json`) and `gbrain mcp grant` against the owner admin API.
- `mobrain` proxies `/mcp`, `/authorize`, `/token`, `/register`, `/revoke`, `/.well-known/*`, and `/health` to `gbrain:3131`. gbrain's `/admin` dashboard is not proxied. `mobrain` calls the owner admin API on the internal network.
- Compose sets `GBRAIN_HTTP_TRUST_PROXY=1` on `gbrain`, because the proxy is a peer container.
- Stop grace is 60 seconds for `autopilot` and `gbrain`. Memory limits: `autopilot` 1.5 GB, `gbrain` 1 GB, `mobrain` 512 MB.
- Removed: Caddy, `control-plane`, `gbrain-ops`, `scheduler`, `gbrain-worker`, and `agent-runner`. The `autopilot` container runs the §8.5 sweep loop, not `gbrain autopilot` (probe P6). Four networks become one.

### 4.2 Configuration (`.env`, never regenerated once written)

| Key | Meaning |
|---|---|
| `COMPOSE_PROJECT_NAME` | `mobrain` by default; `mobrain-dev` for development |
| `GBRAIN_VERSION` | exact pin, `0.60.230.0` |
| `MOBRAIN_PORT` | published loopback port, default `8787` |
| `MOBRAIN_PUBLIC_URL` | URL clients use, such as `https://host.tailnet.ts.net:8443`; default `http://127.0.0.1:8787` |
| `POSTGRES_PASSWORD` | generated |
| `ENCRYPTION_KEY` | generated, 32 bytes base64. Seals stored gbrain client tokens. Losing it means re-issuing every UI client, nothing worse. |
| `GBRAIN_ADMIN_BOOTSTRAP_TOKEN` | generated. gbrain's owner credential, used only by `mobrain` and the CLI. |
| `OPENAI_API_KEY` | the person's key. Optional for `--keyless` installs. |

`bin/mobrain install` writes `.env` with mode `0600` and refuses to overwrite an existing one.

### 4.3 gbrain contract used

| Need | Lane | Caller |
|---|---|---|
| Init brain, set config, install packs, `apply-migrations` | CLI in `gbrain` container (`docker compose exec -T gbrain gbrain ...`) | `bin/mobrain` |
| Create, archive sources | CLI `gbrain sources add\|archive`, run in the `mobrain` container (4.4) | `mobrain` server |
| Issue, rescope, revoke clients | owner admin HTTP API (`gbrain mcp grant\|admin ...` with `--admin-token-file`). `--url` is the gbrain listen address the caller can reach: `http://gbrain:3131/mcp` from the `mobrain` container, `http://127.0.0.1:3131/mcp` from inside the `gbrain` container. `MOBRAIN_PUBLIC_URL` (port 8788 in dev) is admin-unreachable from inside a container (probe P2). Live in-container bootstrap is blocked on that addressing: `http://gbrain:3131` fails gbrain's HTTP loopback check, and `http://127.0.0.1:3000/mcp` is the mobrain proxy, not the admin grant endpoint. Do not substitute another URL. | `mobrain` server |
| Read pages, search, schema read ops, sources list and status | MCP over HTTP with the reader's own `ui` client | `mobrain` server |
| Jobs, health, stats, doctor | MCP with the instance client (admin scope) | `mobrain` server, owner and admin views only |
| Full schema manifest, autopilot status | CLI read in the `mobrain` container | `mobrain` server |
| All brain writes, schema mutations, source queries | MCP with the person's `agent` client | the person's harness |

### 4.4 Running gbrain CLI from the `mobrain` server

The `mobrain` container holds `GBRAIN_HOME` read-write (shared with `gbrain`, one writer lock; not the Docker socket) and the gbrain `DATABASE_URL`, so it runs gbrain CLI commands itself. It cannot reach Docker (no socket is ever mounted), so nothing it does may need another container's filesystem:

- Source creation and archive: the server runs `gbrain sources add|archive` itself. Probe P5: DB-only sources exist with no path and no checkout (`local_path: null`). `sources add` must not pass `--json` (unknown flag). A `:ro` mount fails the writer lock with `EROFS`.
- Pack file installs and edits happen only from `bin/mobrain` on the host (`docker compose cp` plus `exec`), never from the server.

Every CLI call is an argv array through one helper with a timeout, captured stdout and stderr, and secrets scrubbed from errors (ported from `src/contracts/exec.ts` and `src/docker/host.ts`).

## 5. People, sources and company mode

gbrain has no people, only an owner credential and OAuth clients. A client has one write source, a read set (`--federated-read`), scopes, and an optional write fence. Mo-brain owns the people, and pushes every change down by re-granting or revoking their gbrain clients. Mo-brain never makes its own access decision about brain data; gbrain does.

Isolation is enforced in gbrain's application layer, not by Postgres row-level policies (gbrain's tutorial says "database-enforced"; the code has no policies). The host operator can read everything.

### 5.1 Data model (`mobrain` database, plain SQL migrations)

```sql
settings      (key text primary key, value jsonb not null)
              -- 'mode' = '"personal"' | '"company"', default personal

users         (id uuid pk, email citext unique not null, name text,
               role text not null check (role in ('owner','admin','member','viewer')),
               status text not null check (status in ('invited','active','offboarding','disabled')),
               password_hash text, created_at timestamptz not null default now())

sessions      (id_hash text pk, user_id uuid not null references users,
               expires_at timestamptz not null)

invites       (token_hash text pk, user_id uuid not null references users,
               expires_at timestamptz not null, used_at timestamptz)

sources       (id text pk,                     -- the gbrain source id
               kind text not null check (kind in ('private','company')),
               owner_user_id uuid references users,   -- set iff kind = private
               name text not null,
               status text not null check (status in ('active','archived')),
               created_at timestamptz not null default now())

grants        (user_id uuid references users, source_id text references sources,
               agent_reads boolean not null default true,
               primary key (user_id, source_id))   -- company sources only

gbrain_clients(id uuid pk, user_id uuid references users,   -- null for instance
               purpose text not null check (purpose in ('agent','ui','company_writer','instance')),
               write_source text references sources,
               gbrain_client_id text not null,
               token_enc text,                  -- stored for 'ui' and 'instance' only
               expires_at timestamptz,          -- token rotation
               created_at timestamptz not null default now(), revoked_at timestamptz)

api_keys      (key_hash text pk, user_id uuid not null references users,
               created_at timestamptz not null default now(), revoked_at timestamptz)

collector_runs(id uuid pk, user_id uuid not null references users,
               source_id text not null, collector text not null,   -- page slug
               started_at timestamptz not null, finished_at timestamptz,
               status text not null check (status in ('running','ok','partial','error','timeout')),
               exit_code int, timeout_s int not null default 1200,
               summary text, log_tail text)

audit_log     (id bigserial pk, at timestamptz not null default now(),
               actor_user_id uuid, action text not null, target text, detail jsonb)
```

Passwords use `Bun.password` (argon2id). Session and invite tokens are 32 random bytes; only their SHA-256 is stored. Client tokens are sealed with AES-256-GCM under `ENCRYPTION_KEY` (ported from `src/control/secrets.ts`).

### 5.2 Roles and the gbrain clients they get

| Role | Private source | `agent` client | `ui` client |
|---|---|---|---|
| owner | yes, `p-<slug>` | profile `operator` (scopes `admin`, `skills_member_self`); writes own private; reads own private + every active company source | `read`; same read set as agent |
| admin | yes | same as owner | same |
| member | yes | scopes `read,write`; writes own private; reads own private + granted company sources where `agent_reads` | `read`; own private + all granted company sources |
| viewer | no | scopes `read`; reads granted company sources where `agent_reads` | `read`; granted company sources |

- Private source ids are `p-<slug>`, where the slug is the email's local part lowercased to `[a-z0-9-]`, with `-2`, `-3` and so on appended on a collision. Company source ids are `c-<slug>` from the name; the first is `c-company`.
- gbrain requires every client to name a write source. A viewer's read-only clients name their first granted source; the `read` scope keeps them from writing.
- `company_writer` clients: one per (owner or admin, company source), on request, scopes `read,write`, writing that company source. Company-level collectors use it, under a second MCP registration named `gbrain-company-<source>`.
- No profile's scope list is `read,write,admin`. Owner and admin agents use `operator`. Probe P3 passed: an `operator` client did not see another source's pages. A client cannot read its own write unless that write source is included in `--federated-read` (probe P7). Empty `--federated-read ''` fails with `read_source_inactive` (probe P2).
- The `instance` client (naming the owner's private source) serves the owner and admin views: jobs, health, stats, doctor. Those operations were present on `operator`, not on `coding-agent` (`coding-agent` is `read`,`write` and requires `--bound-slug-prefixes`). The plan still names `coding-agent` for the instance client; see the probes file.
- `ui` and `instance` tokens are stored sealed. `agent` and `company_writer` tokens are shown once and never stored. Re-issuing rotates them.
- "Compile" is one pure function: `(user, role, sources, grants, mode) -> ClientSpec[]`. A change to any input recompiles the person's specs and applies the difference through `mcp grant` (rescope when the client exists, create otherwise). This replaces `src/contracts/compile.ts` and the grant logic in `src/control/connections.ts`.

### 5.3 Rules (kept from v1, each with a test)

1. A fresh install is personal. The settings default is `personal`, not set by bootstrap code.
2. Only the owner switches to company mode.
3. The owner switches back to personal only while they are the only user who is not `disabled`. Invited users count, because invites are user rows.
4. Inviting, granting, and creating company sources are refused in personal mode with `403 { error: "company_mode_required" }`. The check lives in one guard used by every such route.
5. A private source belongs to its owner. No role's clients read another person's private source, including the owner and admins.
6. Company access is an explicit grant. Owners and admins read every company source by role.
7. Removing a grant, changing a role, or turning `agent_reads` off recompiles and rescopes that person's clients before the request returns.
8. An invite creates a user with status `invited` and no password, plus a 24-hour single-use link. Claiming it sets a password only on an `invited` user, marks the invite used, and activates the user.
9. Offboarding is idempotent and resumable. The user moves to `offboarding`, then: revoke every client; archive the private source (gbrain `sources archive`); delete grants; mark sessions expired; set status `disabled`. Each step checks whether it is already done, so a failed run can be repeated.
10. The owner cannot be offboarded or demoted. There is exactly one owner.
11. A source is the isolation unit. Folders inside a source are never access boundaries.
12. Every people and access change writes an `audit_log` row.

### 5.4 Operations

All are API routes on `mobrain` (section 9.2), used by the People & access page and by `bin/mobrain` with an API key:

- `mode set company|personal`
- `member invite <email> --role member|admin|viewer` returns the claim link
- `member list`, `member role <email> <role>` (owner only for promoting to admin), `member offboard <email>`
- `source add <name>` (company), `source list`, `source archive <id>`
- `grant <email> <source> [--no-agent-reads]`, `revoke <email> <source>`
- `client issue agent|company_writer [--source <id>]` for the caller, returning the MCP registration once

## 6. Schema

### 6.1 Packs and activation

One schema per brain, as a three-layer chain:

```
mobrain-core      (shipped, locked)          extends: null
mobrain-personal  (shipped, locked)          extends: mobrain-core
mobrain-brain     (this brain's own layer)   extends: mobrain-personal   <- active
```

- Pack files live at `$GBRAIN_HOME/.gbrain/schema-packs/<name>/pack.json`. gbrain only resolves non-bundled packs from there.
- `bin/mobrain install` and `bin/mobrain upgrade` copy `packs/mobrain-core.json` and `packs/mobrain-personal.json` into the `gbrain` container and record their SHA-256 in `packs/SHA256SUMS`. `mobrain-brain` is created once at install (empty `page_types`, `extends: mobrain-personal`) and is never overwritten.
- Activation is brain-wide and DB-tier: `gbrain config set schema_pack mobrain-brain`. `gbrain schema use` is not used, because it writes only the file tier, which the DB tier overrides.
- Fixes ported with the packs: `mobrain-core` gains a `collector` page type with prefix `system/collectors/` (core version 1.1.0); `mobrain-personal`'s `founded`, `works_at` and `advises` regexes gain `ner_only: true`; both packs' `gbrain_min_version` becomes `0.60.230`.

### 6.2 Evolving the schema

The `mobrain-schema` skill mirrors gbrain's `schema-author` skill (phases in the same order, deferring to the installed copy as the authority). Its Mo-brain deltas:

- It only ever edits `mobrain-brain`.
- Before any batch, it runs the core lock check (6.3) on the proposed result and stops on a violation.
- Types, aliases, prefixes and link types change through MCP `schema_apply_mutations` with the agent client (admin scope). Owners and admins only.
- Settings gbrain accepts only as file edits (frontmatter links, enrichable types, filing rules, subtypes, mapping rules, cardinality, temporal) go through the two-step `bin/mobrain schema edit --out <file>` / `bin/mobrain schema apply <file>`. `edit` copies `mobrain-brain` out of the container for the agent to edit; `apply` copies it back, runs `gbrain schema validate` and `gbrain schema lint`, the core lock check, and calls `reload_schema_pack`. Host only.
- Backfills after a change use gbrain's own `schema sync`, `review-orphans` and `unify-types` flows, through `bin/mobrain schema exec -- <gbrain schema args>` (host only, argv passthrough with an allowlist of `schema` subcommands).

### 6.3 Core lock

gbrain has no locked base pack, and child packs win on conflicts. The lock is a Mo-brain convention, checked in three places by one function, `checkCoreLock(resolvedManifest, coreManifest, personalManifest)`:

- It fails if the installed core or personal pack file's hash differs from `SHA256SUMS`.
- It fails if `mobrain-brain` defines a page type, link type, alias or prefix whose name is already defined by core or personal.
- It fails if the active pack is not `mobrain-brain`, or if its chain does not reach `mobrain-core`.

The skill runs it before every change (prevention). `mobrain status` and the UI Health page run it on every load (detection). Direct calls that bypass the skill are caught by detection, not prevented.

### 6.4 Schema in the UI

Built from `gbrain schema show --json` (full resolved manifest, run in the `mobrain` container), `schema_stats`, and `schema_review_orphans` (MCP, with the viewer's `ui` client). Cached by pack identity (`name@version+sha8`). It shows every type with its primitive, prefixes, aliases and link types, the layer that defines it (core, personal or brain), page counts per type, untyped and orphaned pages, the active pack identity, and the core lock result.

## 7. Install and join

### 7.1 What the person does

1. Says "install mobrain" (or pastes the repo's `INSTALL_FOR_AGENTS.md` link).
2. Answers one batch: their OpenAI key (or "keyless"), their email for the owner login, and which sources to connect.
3. If a source has no tool in their harness, connects one (the agent says exactly which, e.g. "add the Notion connector in claude.ai" or "add your Composio MCP"), then says "done".

### 7.2 What the agent does (`mobrain-install` skill)

1. Preflight: Docker Compose 2.20 or newer, at least 2 vCPUs and 4 GB RAM, the port free, no existing compose project of that name (refuse rather than reuse).
2. Asks the one batch (7.1 step 2). For each chosen source, maps it to a tool it can already call (6 kinds, see 8.4) and lists what is missing.
3. `bin/mobrain install --owner-email <e> --openai-key-file <f>|--keyless`. This writes `.env`, builds both images, starts Postgres, creates the `gbrain` and `mobrain` databases, runs `gbrain init` on Postgres with `--search-mode balanced` (and the OpenAI embedding model when a key is given), installs the packs and activates `mobrain-brain`, starts the stack, creates the owner (generated password unless given), the owner's private source, the instance client, the owner's `ui` and `agent` clients and an API key. It prints one JSON receipt: UI URL, owner password, MCP URL and bearer, runner config path. Init flags are accepted. `--search-mode balanced` is not stored (`search_mode` config key not found); do not invent a flag that stores it. A fresh role cannot finish init unless `compose/initdb/01-dbs.sh` has granted `BYPASSRLS` and pre-created the v35 `auto_enable_rls` function (owned by `gbrain`) and `auto_rls_on_create_table` event trigger as the superuser.
4. Writes `~/.config/mobrain/runner.env` (`MOBRAIN_URL`, `MOBRAIN_API_KEY`; mode `0600`).
5. Registers gbrain in the harness under the name `gbrain`, so gbrain skills' tool names resolve (Claude Code: `claude mcp add --scope user --transport http gbrain <url>/mcp --header "Authorization: Bearer <token>"`).
6. `bin/mobrain skills install --dir <harness skills dir>` (section 10).
7. Creates one collector page per chosen source (8.1) with `cadence`, `allowed_tools` and the backfill window.
8. Backfills each source headless: `bin/mobrain collect <collector> --backfill`. The run follows gbrain's `bulk-ingestion` discipline inside itself: a 5 to 10 item trial, a quality check against `mobrain-core` filing, then the rest of the window.
9. `bin/mobrain timers install`: the collector timer every 15 minutes, and on the stack host a daily backup at 03:30 local.
10. Verifies: `mobrain status` ok; every collector `last_status: ok`; a search for a term from each source returns a page; `checkCoreLock` passes.
11. Reports: UI link and owner password, what was ingested per source, the collector schedule, how to change things ("ask me"), and that the harness must restart once to load the gbrain MCP and skills in interactive sessions.

Headless runs load the new MCP registration and skills on their own, which is why the backfill does not wait for the restart.

### 7.3 Join (a member, on their own machine)

1. The owner or an admin invites them; the link goes to the member out of band.
2. The member claims it in the browser and sets a password.
3. The UI's "Connect your agent" panel shows one line to paste to their agent: "join mobrain at <url> with key <one-time join key>". The join key is an `api_keys` row created at claim, shown once.
4. Their agent follows the `mobrain-join` skill: downloads `bin/mobrain` from `<url>/install/mobrain`, writes `runner.env`, issues its `agent` client (`mobrain client issue agent`), registers MCP, installs skills, then runs install steps 7.2 #2 and #7 to #11 for the member's own sources, writing to their private source. On a member's machine, `timers install` adds only the collector timer, and the report gives the UI link without any password.

A member needs no Docker; only the stack host does.

## 8. Collectors

### 8.1 The collector page (configuration, owned by the agent)

Slug `system/collectors/<id>` in the source the collector writes to. Type `collector` (in `mobrain-core`). The agent creates and edits it through gbrain MCP, so pausing a source or changing its cadence is a brain write like any other.

```yaml
---
type: collector
title: Work email
kind: email            # email | calendar | meetings | docs | notes-import | fixture
enabled: true
cadence: 2h            # <n>m | <n>h | <n>d | daily@HH:MM | once
harness: claude-code
model: sonnet          # optional, passed to the harness
allowed_tools:         # what the headless run may call besides gbrain
  - mcp__claude_ai_Gmail__*
tool_hint: claude.ai Gmail connector
target_source: p-felipe
backfill_days: 90
watermark: "2026-10-14T10:00:00Z"   # opaque to the runner, owned by the skill
---
What this collector covers and anything the person asked to skip.
```

Validation (shared by the API and the skill): `kind` known; `cadence` parses and is at least 15 minutes; `allowed_tools` is a non-empty list of tool patterns; `target_source` exists and is writable by the person's agent client.

### 8.2 Runs (history, owned by the runner)

`collector_runs` rows in the `mobrain` database, written through `/api/runner/*` with the person's API key. The page holds configuration and the watermark; the database holds run history. The UI merges both.

### 8.3 The runner (`bin/mobrain collect`)

- `mobrain collect --due` (the timer): `GET /api/runner/due` returns the caller's due collectors as TSV (`slug, source, kind, allowed_tools, model, timeout_s`). Due means enabled, cadence elapsed since the last finished run (or `daily@HH:MM` passed today, or `once` never run), and no run in `running` state newer than its timeout.
- For each due collector, one at a time on the host: take `flock ~/.cache/mobrain/locks/<slug>.lock`, `POST /api/runner/start`, run the harness adapter with a timeout (default 20 minutes; backfill 2 hours), `POST /api/runner/finish` with status, exit code and the last 4 KB of output. A timeout or crash still records a finish, so the UI shows it.
- `mobrain collect <slug> [--backfill]` runs one collector now.
- Harness adapter `claude-code`: `claude -p "<prompt>" --allowedTools "mcp__gbrain__*,<allowed_tools...>" [--model <m>] --output-format json`, run with the person's environment from the timer. The prompt names the skill and the collector: "Use the mobrain-collect skill to run collector <slug> in source <source> (mode: incremental|backfill)." Exact flags are fixed by probe P4: `--allowedTools` is honored. The systemd user PATH does not include `~/.local/bin`; bare `claude` exits 127. The timer must set PATH or invoke claude by absolute path. Other harnesses (`codex exec`) are adapters added later behind the same interface.
- Logs go to `~/.local/state/mobrain/collect/<slug>/<timestamp>.log`, keeping the last 50.

### 8.4 The `mobrain-collect` skill

One run, any kind:

1. Read the collector page through gbrain MCP. Stop if disabled.
2. Fetch items newer than the watermark (or within `backfill_days`) with the tools named in the page. Cap one incremental run at 200 items, and record `partial` if more remain.
3. For each item, follow gbrain's own skill for that content, as the authority, through gbrain MCP: `brain-ingest-gate` before any new page, `meeting-ingestion` for transcripts, `idea-ingest` or `media-ingest` for documents, `enrich` for every person and company touched, and `mobrain-core` filing (`brain-taxonomist`). Every page carries a stable `source_ref` (e.g. `gmail:<threadId>`) so re-runs update instead of duplicating.
4. Update the page's `watermark` only after every item in the batch is written. The watermark never moves past an item that failed.
5. Print a one-line summary (items read, pages created and updated, skipped, errors) as the last line, which the runner stores.

Kind references inside the skill, each short:

| Kind | Fetch | Write |
|---|---|---|
| `email` | threads changed since the watermark, newest first; skip newsletters, notifications and no-reply senders by rule | one `conversation` page per meaningful thread under `emails/`; people and companies enriched; loops noted in the body |
| `calendar` | events from 7 days back to 14 days ahead on each run; full window on backfill | `event` pages under `calendar/YYYY/`; cancelled events marked, not deleted; attendees enriched |
| `meetings` | transcripts and recorder notes since the watermark (Granola, Fireflies, Circleback, Otter, Meet notes) | gbrain `meeting-ingestion` end to end, including its verification checklist |
| `docs` | documents changed since the watermark in Drive, Notion or another knowledge base | one `source` page per document with summary and link (not a raw copy), plus the concepts, projects and people it establishes |
| `notes-import` | a folder, an old brain, or an export (Obsidian, Notion export, Markdown) | the existing `mobrain-onboard-import` procedure (mirrors gbrain `migrate`), cadence `once` |
| `fixture` | a local folder of Markdown files | `note` pages; used only by `mobrain selftest` |

### 8.5 What gbrain schedules itself

Probe P6: `gbrain autopilot` exits `No repo path` on a DB-only brain and does not tick. Remote-mention backlinks can still appear via `get_backlinks` (not a field on `get_page`) from the queued effect, not from an autopilot cycle. The `autopilot` container therefore does not run `gbrain autopilot`. Its command is `compose/autopilot-loop.sh`, mounted read-only because the script is not in the image. The script is a foreground loop (never `--install`, and never an `sh -c` or `bash -c` string containing `gbrain`): it runs `gbrain sweep --once`, then `gbrain embed --stale`, then sleeps `${AUTOPILOT_INTERVAL:-300}`.

Mo-brain adds no other gbrain schedules.

## 9. The `mobrain` service

### 9.1 UI pages

| Page | Who | Content |
|---|---|---|
| Pages | everyone | source picker (only readable sources), folder tree by `mobrain-core` prefixes, search, rendered Markdown with wiki links resolved, frontmatter and timeline |
| Sources | everyone | readable sources; per source its collectors (page config merged with last runs, next due, last error) and gbrain `sources_status` |
| Schema | everyone | section 6.4 |
| Activity | owner, admin | gbrain jobs (`list_jobs`), recent collector runs across people, audit log |
| Health | owner, admin | `mobrain status`: container health, pin match, `run_doctor` summary, `get_stats`, autopilot status, core lock |
| People & access | owner, admin (company mode); owner sees only the mode switch in personal mode | mode switch; people with role and status; invite; grants matrix (company sources by people, with `agent_reads`); company sources; offboard |
| Connect your agent | everyone | the join line or MCP registration; re-issue the agent client |

Login is email and password. Sessions last 30 days in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` when the public URL is HTTPS). Markdown is rendered with `marked` and sanitized with DOMPurify. The theme tokens and fonts are ported from `src/console/styles`.

### 9.2 API

```
POST /api/auth/login | /api/auth/logout        GET /api/me
POST /api/claim/:token                          (set password on an invited user)
GET  /api/pages?source&prefix&q                 GET /api/pages/:source/*slug
GET  /api/sources                               GET /api/sources/:id/collectors
POST /api/collectors                            PATCH /api/collectors/:source/*slug
GET  /api/schema                                GET /api/activity      GET /api/health
GET|POST|PATCH|DELETE /api/people/*             (section 5.4)
POST /api/clients/issue
GET  /api/runner/due   POST /api/runner/start   POST /api/runner/finish
GET  /install/mobrain  GET /install/skills.tar.gz
ALL  /mcp /authorize /token /register /revoke /.well-known/* /health -> gbrain
```

Authentication is a session cookie or `Authorization: Bearer <api key>`. Authorization is one table of route to allowed roles plus the company-mode guard, tested route by route. Page reads always use the caller's own `ui` client; the server never passes a source id it chose to gbrain on a person's behalf.

### 9.3 Code layout

```
bin/mobrain                    host CLI (bash, curl, docker compose; no jq)
compose/docker-compose.yml     the four services
compose/docker-compose.dev.yml dev overrides (project mobrain-dev, port 8788)
compose/initdb/01-dbs.sql      gbrain and mobrain databases
docker/gbrain.Dockerfile       pinned gbrain (from gbrain-base.Dockerfile, build gates kept)
docker/mobrain.Dockerfile      FROM the gbrain image; app + built UI
packs/                         mobrain-core.json, mobrain-personal.json, SHA256SUMS
src/server/                    main, auth, people (compile, rules), sources, collectors,
                               runner api, schema (show, coreLock), gbrain (mcp client,
                               cli exec, admin api), health, install assets, db (sql, migrations)
src/ui/                        React SPA, one file per page, theme
skills/                        mobrain-install, mobrain-join, mobrain-collect (+ kinds/),
                               mobrain-schema, mobrain-import, RESOLVER.mobrain.md
test/unit/                     server and CLI unit tests
test/selftest/                 the stack self-test driver
```

## 10. Skills

- `GET /install/skills.tar.gz` bundles gbrain's `skills/` from the pinned image (version-matched, no GitHub clone) plus Mo-brain's skills. `bin/mobrain skills install --dir <d>` unpacks it.
- gbrain's `RESOLVER.md` is installed as is. Mo-brain's routes are inserted into it between `<!-- mobrain:begin -->` and `<!-- mobrain:end -->` markers. This fixes the v1 bug where `cp -n` installed Mo-brain's resolver in place of gbrain's.
- A manifest (`.mobrain-skills.json`, file to SHA-256) records what was installed. A re-install updates files that are unchanged since the last install and skips files the person edited, listing them.
- Shipped Mo-brain skills: `mobrain-install`, `mobrain-join`, `mobrain-collect`, `mobrain-schema`, `mobrain-import` (the in-progress `mobrain-onboard-import`, renamed). Removed: `mobrain-operator`, `mobrain-onboard-setup`, `mobrain-schema-designer`, `query`.
- Each Mo-brain skill that wraps a gbrain procedure mirrors that skill's phases, defers to the installed copy as the authority, and marks its own changes in `**Mo-brain:**` blocks.

## 11. Host CLI (`bin/mobrain`)

| Command | Where | Does |
|---|---|---|
| `install` | stack host | section 7.2 step 3 |
| `up`, `down`, `ps`, `logs <svc>` | stack host | compose verbs with the right files and env; `down -v` is allowed only for `mobrain-dev` and `mobrain-selftest`, and only when the flag's project matches `.env` |
| `status [--json]` | any | `GET /api/health`; exit 0 ok, 1 degraded, 2 down |
| `join --url <u> --key <k>` | a member's machine | section 7.3 |
| `member ...`, `source ...`, `grant`, `revoke`, `mode`, `client issue` | any | section 5.4 through the API |
| `collector add\|set\|list` | any | create and edit collector pages (8.1) and list a source's collectors (9.2), through the API |
| `search <q> [--source <s>]` | any | `GET /api/pages?source&q` (9.2) |
| `schema show\|check` | any | section 6 |
| `schema edit --out <file>`, `schema apply <file>`, `schema exec -- <args>` | stack host | section 6 |
| `brain exec -- <extract\|embed\|doctor\|stats\|sync ...>` | stack host | gbrain passes in the container; argv passthrough with an allowlist |
| `skills install --dir` | any | section 10 |
| `collect --due\|<slug> [--backfill]` | any | section 8.3 |
| `timers install\|remove\|status` | any | systemd user timers when `systemctl --user` works and lingering is on; otherwise crontab entries marked `# mobrain`. The unit sets `PATH` to include `~/.local/bin` (and the directory of `claude`); the systemd user PATH does not (probe P4). |
| `backup`, `restore <dir> --yes` | stack host | section 12 |
| `upgrade --gbrain <version>` | stack host | section 12 |
| `selftest [--keep]` | stack host | section 13; its own compose project `mobrain-selftest`, env file `.env.selftest` and port 8790 |

It reads `MOBRAIN_URL` and `MOBRAIN_API_KEY` from `~/.config/mobrain/runner.env`, and the compose files from the repo checkout it lives in. `--project` overrides the compose project, and stack commands refuse a project name other than the one in `.env`.

## 12. Backup, restore, upgrade

- `backup`: into `~/backups/mobrain/<project>/<UTC timestamp>/`: `pg_dump -Fc` of `gbrain` and `mobrain`, a tar of the `gbrain-home` volume, `GBRAIN_VERSION`, the repo commit, and a manifest with sizes and SHA-256. `.env` is not copied (it holds `ENCRYPTION_KEY`); the manifest records its SHA-256 so a restore can warn on a mismatch. The daily timer keeps 7 backups.
- `restore <dir> --yes`: stops `autopilot`, `gbrain` and `mobrain`, restores both databases and the volume, starts the stack, runs `status`. Refuses without `--yes`, and refuses when the backup's gbrain version differs from `.env` unless `--allow-version-change`. Probe P8: `pg_restore` exits 1 and these errors are not a failed restore: `must be owner of extension vector` (`COMMENT ON EXTENSION vector`), `permission denied to create event trigger "auto_rls_on_create_table"`, and `must be owner of extension citext` (`COMMENT ON EXTENSION citext`). Any other `pg_restore: error:` fails the restore.
- `upgrade --gbrain <v>`: backup; set `GBRAIN_VERSION`; build; stop `autopilot`; start `gbrain`; `gbrain apply-migrations --yes --non-interactive`; reinstall packs (hash checked); start everything; `status`. On failure it prints the restore command for the backup it just took. The install skill tells the agent to read gbrain's `skills/migrations/v<version>.md` for every crossed version and re-run `skills install`.
- Mo-brain's own updates: `git pull` (or `git merge --ff-only` on the live worktree), then `mobrain up --build`. Mo-brain migrations are numbered SQL files applied at server start inside one transaction each.

## 13. Testing

- **Unit (`bun run test:unit`)**: compile (role and grants to client specs), each rule in 5.3, the route authorization table, cadence parsing and due computation, collector frontmatter validation, `checkCoreLock` (pass, tampered core, shadowed type, wrong chain), resolver merge and the skills manifest, password and session handling, token sealing. gbrain is replaced by a fake adapter behind the same interface the server uses.
- **CLI tests**: run `bin/mobrain` with stub `docker`, `curl` and `claude` on `PATH`, asserting the exact argv each command produces and its exit codes.
- **`mobrain selftest`** (local only, its own compose project `mobrain-selftest`, env file `.env.selftest`, port 8790, keyless): install fresh; `status` ok; `checkCoreLock` ok; agent client `put_page` and `get_page`; switch to company; invite and claim a member; grant one company source; prove the member reads it and cannot read the owner's private source or an ungranted company source (search, `get_page`, `list_pages`); run a `fixture` collector through the runner with a stub harness that writes through MCP with curl, and check the run row and the pages; check every UI API route as each role; backup; tear down with `down -v` (allowed only for `mobrain-dev` and `mobrain-selftest`, refused for any other project). `--real-harness` runs the fixture collector through `claude -p` instead.
- **CI**: `ci.yml` keeps running `lint:forbidden` and `test:unit` on push and pull request. `stack.yml` stays manual dispatch only and runs `selftest`. The release workflows are deleted; `test/unit/workflows.test.ts` is updated to match. No new push or PR workflows, no `schedule:`.

## 14. What is kept, ported and deleted

**Kept as is:** `.github/workflows/ci.yml`, `scripts/lint-forbidden.ts` (rules for the runner, gateway and harness pins removed), `scripts/test-isolated.sh`, `LICENSE`, `SECURITY.md`, `docs/superpowers/`.

**Ported (moved and trimmed):** `src/ops/packs/*.json` to `packs/`; `docker/gbrain-base.Dockerfile` to `docker/gbrain.Dockerfile`; the argv exec helper and output scrubbing; token sealing; theme tokens and fonts; the stage-4 import skill to `skills/mobrain-import`; useful preflight checks; the backup and restore logic (rewritten for two databases plus one volume).

**Deleted:** `src/control`, `src/ops` (except packs), `src/scheduler`, `src/runner`, `src/agent`, `src/gateway`, `src/upgrade`, `src/contracts`, `src/docker`, `src/console`; `contracts/`; `compose/` files other than the two above; `compose/Caddyfile`; `docker/agent-runner.Dockerfile`, `docker/control-plane.Dockerfile`, `docker/quiesce-gbrain-procs.sh`, `docker/gbrain-gated-entrypoint.sh` (replaced by compose `depends_on` health checks unless P1 shows the gate is still needed); `scripts/` other than those kept; `test/integration`, `test/contract`, `test/e2e`, `test/build`, `test/helpers` and every unit test of deleted code; `drizzle.config.ts`; `docs/runbooks/*` and `docs/specs/*` (replaced by section 15); `release.yml`, `release-verify.yml`. All of it stays reachable at tag `v1-final`.

## 15. Documentation after the change

- `README.md`: what Mo-brain is, the one-line install, the four containers.
- `INSTALL_FOR_AGENTS.md`: the entry point an agent reads for "install mobrain"; points at the `mobrain-install` skill and lists the traps.
- `HANDOFF.md`: rewritten for the new shape, pins, and the next slice.
- `CLAUDE.md`: CI rules unchanged; dev instructions use `bin/mobrain` with `mobrain-dev`.
- `docs/runbooks/`: `operate.md` (status, logs, restart), `collectors.md`, `company.md`, `backup-restore.md`, `upgrade.md`, `ci.md`.

## 16. Probes before building

Each runs against a scratch `mobrain-dev` stack on gbrain `0.60.230.0`, and the plan's first task records the results in `docs/superpowers/specs/2026-10-14-mobrain-simple-probes.md`. A failed probe takes its fallback, and the spec is amended before the dependent task starts.

| # | Question | Pass | Fallback |
|---|---|---|---|
| P1 | `gbrain init` on Postgres in the container with `--search-mode balanced` and an OpenAI embedding model; packs installed; `schema_pack mobrain-brain` active | `gbrain schema active --json` shows the three-layer chain; `doctor` has no errors | adjust init flags; keep the gated entrypoint if the first start races migrations |
| P2 | `gbrain mcp grant` against the owner admin API from the `mobrain` container: create with `--source` and `--federated-read`, rescope, revoke; the bearer works with `claude mcp add --transport http` | all four work; a revoked bearer gets 401 | use host CLI `gbrain auth` commands through the `gbrain` container from `bin/mobrain`, and move client changes out of the server |
| P3 | Isolation: a `read,write` client and a `read,write,admin` client bound to source A cannot read pages in source B through search, `get_page`, `list_pages` or admin read ops | no page content or slug from B returned | owners and admins get no admin scope on `agent`; admin work uses the `instance` client through the CLI only |
| P4 | `claude -p` from a systemd user timer: calls `mcp__gbrain__*` over HTTP and a claude.ai connector tool; `--allowedTools` honored; exit codes and timeout behave | a fixture collector completes from the timer with nobody logged in | crontab with an explicit `PATH`; if connectors are unavailable headless, document gateway MCPs as the headless path |
| P5 | `gbrain sources add <id>` without a path on Postgres; `put_page` into it with a client bound to it; `sources archive` | page written and readable; archive hides it | sources get a path under `gbrain-home/content/<id>`; `mobrain` mounts `gbrain-home` read-write |
| P6 | `gbrain autopilot --interval 300` in the foreground in a container: worker runs; a remote `put_page` gets its links and embedding within two ticks | links and embedding present | run `compose/autopilot-loop.sh` (`gbrain sweep --once` then `gbrain embed --stale`; not an `sh -c` string) |
| P7 | The `ui` client: `list_pages` filtered to `system/collectors/` returns frontmatter; `get_page` returns content and frontmatter; `schema show --json` runs in the `mobrain` container | all three | read collector pages one by one with `get_page` |
| P8 | Backup and restore round trip on dev: both databases and the volume | a page and a person survive restore | adjust the dump and restore commands |

Results: docs/superpowers/specs/2026-10-14-mobrain-simple-probes.md (2026-10-15). Fallbacks taken: P1 `ALTER ROLE gbrain BYPASSRLS` and pre-created v35 `auto_enable_rls` plus `auto_rls_on_create_table` as the superuser, function owned by `gbrain` (`search_mode balanced` was not stored; no flag invented); P2 in-container grant URL `http://127.0.0.1:3131/mcp` (8788 is admin-unreachable) and `ADMIN_AGENT_PROFILE=operator` (no `read,write,admin` profile; empty `--federated-read` is `read_source_inactive`); P4 timers invoke claude by absolute path or set PATH (`~/.local/bin` is not on the systemd user PATH); P5 omit `--json` on `sources add`; P6 autopilot runs `compose/autopilot-loop.sh` (`gbrain sweep --once` / `gbrain embed --stale`; not an `sh -c` string); P7 `list_pages` filters on `source_id` not `prefix`, `gbrain put --source`, and federated read must include the write source; P8 ignore `pg_restore` errors for the vector extension comment, the `auto_rls_on_create_table` event trigger, and the citext extension comment. P3 passed.

## 17. Cutover on this host

1. Commit the in-progress onboarding work (`docs/runbooks/onboarding.md`, `skills/RESOLVER.md`, `skills/mobrain-onboard-setup/SKILL.md`, `skills/mobrain-onboard-import/`) on `main`, then tag `v1-final`.
2. Build on a feature branch merged to `main` in steps; develop and test only on `mobrain-dev`.
3. When `selftest` passes and the person's own `--real-harness` run passes: back up `mobrain-molior` with the old `molior.sh backup`, and keep that backup.
4. Ask before tearing it down: stop `mobrain-molior` (no `-v` until the new install is verified), then remove it.
5. Fast-forward `molior` to `main` in `~/mobrain-molior`, write a new `.env` through `bin/mobrain install` (the old `.env` stays as `.env.v1` beside it; the new stack does not read it), and install as project `mobrain-molior`.
6. Ask before changing `tailscale serve`, then point it at `127.0.0.1:${MOBRAIN_PORT}`.
7. The person's agent runs the install skill from step 7.2 #4 onward against the live stack.
8. Update `CLAUDE.local.md`: the live path, `bin/mobrain` in place of `molior.sh`, and the same never-edit and never-`down -v` rules.

The live brain holds no ingested pages since the 2026-10-10 rollback, so nothing is migrated from v1. The v1 backup is kept in case that is wrong.
