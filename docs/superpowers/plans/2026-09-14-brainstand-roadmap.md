# brainstand — Staged Delivery Roadmap

> **For agentic workers:** This is the **stage map**, not an executable plan. **Slice 0 and Slice 1 are COMPLETE on `main` — do not re-execute those plans.** Each later stage has its own plan document. Execute stages in order; do not start a stage until its entry gate passes. Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` against the *per-stage* plan documents. Start at [HANDOFF.md](../../../HANDOFF.md).

**Goal:** Turn gbrain (a 415K-LOC CLI/MCP knowledge system) into a product a team deploys with one `docker compose up` and operates from a web console — with gbrain pinned and upgraded, never forked.

**Spec:** `C:\Users\juanp\.claude\plans\we-want-to-do-snug-wolf.md`

**Upstream:** `C:\Users\juanp\Desktop\gbrain` — `gbrain` v0.50.0.0, MIT, © 2026 Garry Tan.

**Working codename:** `brainstand`. Rename before any public artifact.

---

## Global Constraints

These apply to **every task in every stage**. Copied verbatim from the spec; every task's requirements implicitly include this section.

### Pinning and integration

- **G1 — Never fork. Pin exact semver.** Images install `github:garrytan/gbrain#v0.50.0.0` via build `ARG GBRAIN_VERSION`. **Never the moving `latest-stable` tag.**
- **G2 — Drive gbrain only through its published contracts.** Three lanes:
  - **CLI exec** — primary for *all control-plane work* (`init`, `mcp grant`, `auth rescope-client`, `config set`, `sources add --path`, `sync`, `embed`, `doctor`, `apply-migrations`, `dream`, `schema`). Allowlisted **argv arrays, never shell strings**. Always `--json` where available.
  - **HTTP MCP `/mcp`** — primary for *all data-plane work* (search, pages, `sources_list`/`sources_status`, `schema_apply_mutations`, jobs, takes).
  - **File plane** — *only* what gbrain refuses via `config set`: provider API keys, schema pack YAML.
- **G3 — Forbidden, no exceptions:** importing gbrain internals beyond its published `exports` map (see `package.json` `exports`); reading gbrain's tables directly; patching gbrain source; screen-scraping human-readable CLI output.
- **G4 — Two contract mechanisms, both required.** A *capability snapshot* for the data plane (renders UI, absorbs upstream additions without a release on our side) and a *contract test suite* for the control plane (flag acceptance, `--json` shape, exit codes, per candidate `GBRAIN_VERSION`).
- **G5 — Upgrades are deterministic and hand-authored.** An LLM may **propose** a migration checklist. It **never executes** one.

### Platform and versions

- Base image `oven/bun:1.3.13`. Postgres `pgvector/pgvector:pg16`. Caddy `caddy:2`.
- Required Postgres extensions: `vector`, `pg_trgm`, `pgcrypto`.
- `GBRAIN_VERSION=0.50.0.0` (build ARG, exact).
- Control plane: Bun + Hono + Drizzle ORM + Better Auth (organization + RBAC plugins) + React 19 + Vite + Tailwind.
- Node/Bun processes run under `tini` as PID 1.

### Compose invariants — each one is a live bug if violated

- **`GBRAIN_HTTP_TRUST_PROXY=1` is required behind Caddy** (default is `loopback`; in compose the proxy is a peer container, so without it every client IP collapses to Caddy's and the pre-auth rate limiter mis-buckets).
- **`gbrain-serve` must not publish a host port.** Widening `trust_proxy` while the server is also directly reachable lets clients spoof `X-Forwarded-For`.
- **`postgres` must not publish a host port.**
- **`/admin` is never routed publicly** (S1). Break-glass is `docker compose exec gbrain-ops gbrain …` over SSH.
- **Reserved paths owned by `gbrain-serve`:** `/mcp`, `/authorize`, `/token`, `/register`, `/revoke`, `/.well-known/*`, `/admin`, `/admin/api/*`, `/admin/events`, `/ingest`, `/webhooks/*`, `/health`, `/metrics`. **The console mounts under `/api/*` with health at `/api/health`** — `/health` and `/metrics` are live collisions.
- **Never run `gbrain autopilot --install` inside a container.** It writes a crontab line; in a container that is either a silent no-op or a duplicate-scheduler bug. **Lint for it.**
- **Set `self_upgrade.mode off` inside our containers.** The product owns the upgrade lane.
- Use **`GBRAIN_DATABASE_URL`**, never a bare `DATABASE_URL`, for gbrain — upstream refuses to adopt a `DATABASE_URL` that leaked in from a working-directory `.env`, while `GBRAIN_DATABASE_URL` is always treated as stated intent.
- **If a pooler is ever introduced** it must set `IGNORE_STARTUP_PARAMETERS=extra_float_digits,statement_timeout,idle_in_transaction_session_timeout,search_path` — gbrain sends those as startup parameters and every connection is refused otherwise.

### Security invariants

- **S2 — The control plane holds no brain `DATABASE_URL`** and mounts `GBRAIN_HOME` **read-only**. Only `gbrain-ops` holds brain DB creds + RW `GBRAIN_HOME`.
- **S3 — All file-plane writes are serialized through `gbrain-ops`** behind a **Postgres advisory lock in the control DB** (not a file lock — multiple containers), using atomic-write semantics.
- **S3b — Secrets are envelope-encrypted**: per-secret DEK, KEK derived from `ENCRYPTION_KEY`, versioned rows, documented rotation. A Postgres dump must not be a credential dump.
- **S3c — Mirror upstream's `check:source-config-leak` guard in our CI**, for our tables and our logs. Never log request bodies that can carry credentials.
- **S4 — Connections, not Members, are the unit of access.** A gbrain identity has exactly one write source. A Member *has* N Connections; each Connection has one write Space and N read Spaces.
- **S4b — Space = source is a hard rule.** There is no "folders within a Space have different access." Needs isolation → create a Space. This is a **blocking choice in onboarding**, not a tooltip.
- The `agent-runner` holds **no DB creds and no `GBRAIN_HOME`**, runs read-only rootfs, non-root, `no-new-privileges`, dropped caps, with pid/mem/CPU limits, and is **egress-allowlisted at the network layer** to `https://${DOMAIN}/mcp` + the model gateway only.
- **Never mount the Docker socket** into anything touching agent output.

### Licensing

The image must carry gbrain's `LICENSE` (MIT, © 2026 Garry Tan) and our docs must attribute it. Bundling, modifying and selling are permitted; shipping the copyright notice and license text is the obligation.

---

## Verified constraints (re-checked against the v0.50.0.0 source on 2026-09-14)

Do not re-litigate these. Each was read out of the source, not inferred.

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| V1 | The privileged surface is **not** in the operation registry. `auth rescope-client`, `mcp grant`, `config`, `init`, `apply-migrations`, `doctor`, `upgrade`, `autopilot` live in `src/commands/*.ts`. `src/core/ops/admin.ts` has zero `localOnly` ops. | `src/commands/` listing | MCP is the **data** lane; the CLI is the **control** lane. Most of this product lives on the CLI. |
| V2 | The CLI lane is machine-readable. | `--json` on `mcp grant`, `auth rescope-client`, `auth clients`, `doctor`; `--dry-run` on `mcp grant` + `auth rescope-client` | No screen-scraping. The control lane is a real API. |
| V3 | `gbrain init --non-interactive` exists and requires `--url` or `GBRAIN_DATABASE_URL`. | `src/commands/init.ts:38,42,190,207,220,224` | Headless init works; we do not reimplement init's semantics. |
| V4 | The search-mode cost matrix is a **post-init** `config set search.mode`, not part of init. Init's only interactive fork is embedding-provider selection, resolved by `--non-interactive` + explicit `--embedding-model`. | `src/commands/init.ts:96-97`, `init-provider-picker.ts` | The mandatory human decision is fully ours to render. |
| V5 | `gbrain jobs supervisor` drains on SIGTERM. Exit codes (start): **0** clean shutdown, **1** max crashes exceeded, **2** another supervisor holds the PID lock, **3** PID file unwritable. `stop` waits **up to 40s** for graceful drain. | `src/commands/jobs.ts:414-422` | Quiesce-before-snapshot is achievable. **Note: 40s, not the 35s in the spec prose — use 40s + margin.** **Slice 0 (2026-09-15):** confirmed — real clean drain measured at 1150ms, ~35x under budget. But upstream also defines an undocumented **exit 4** (`LOCK_LOST`, #1849, DB lock stolen mid-run) this row omits, and `--detach`'s own exit code is ALWAYS 0 regardless of lock state — only a foreground second start observes `LOCK_HELD` synchronously. See `docs/slice-0-findings.md` V5. |
| V6 | `gbrain doctor` exits non-zero on blockers (1, and 2 on the unreachable-target path). | `src/commands/doctor.ts:4316,4334,4492,4502,4506,4562` | The upgrade gate can be a real gate. **Slice 0 (2026-09-15):** confirmed on exit code, but the real `--json` report has NO top-level `blockers` array — `DoctorReport` is `{schema_version, status, health_score, brain_checks_score, category_scores, checks[], top_issues?, engine?, db_url_source?}`. Any gate must read `status`/`health_score`/`checks[]`, never `report.blockers`. See `docs/slice-0-findings.md` V6. |
| V7 | `--token-ttl` is bounded **60s – 90d**; the server default for CLI-minted access tokens is **3600s** (not 30 days). | `src/commands/auth.ts:439-455`, `TOKEN_TTL_MIN_SECONDS=60` | Short-lived per-run tokens are native. |
| V8 | `gbrain mcp grant` needs a local engine **or** `--admin-token-file`. | `src/commands/mcp.ts:118` — *"Run on the brain host or supply --admin-token-file"* | Whatever mints grants must hold `DATABASE_URL`. **That container is a privilege boundary.** |
| V9 | gbrain's backup deliberately excludes every credential (`credential-deliveries`, `.env*`, `credentials.json`, `auth.json`, `.ssh`, `.aws`); restore quarantines unfinished jobs and starts no automation. | `src/core/backup/snapshot.ts` | A naive restore yields intact knowledge and **zero working agent connections**. |
| V10 | Hermes is not a harness adapter. 13 adapters in 4 connection classes: `claude-json` (claude-code), `codex-toml` (codex), `opencode-json` (opencode), `thin-cli` (openclaw, grok-bot, muse), `manual` (claude-desktop, grok-build, muse-code, cursor, perplexity, chatgpt, generic). Every adapter carries `evidence.runtimeTestedAt: null`. | `src/core/harness/registry.ts:22-46` | **Do not promise auto-install** for Hermes, Claude Desktop, Cursor, ChatGPT or Perplexity. **Slice 0 (2026-09-15):** adapter count and id-set confirmed exactly (13), but the "4 connection classes" claim is UNVERIFIABLE from any public surface — `publicHarnessMetadata()` strips `.connection` entirely; every live adapter's `.connection` is `undefined`. The harness picker cannot group by connection class from `.well-known` data as this row assumes; Slice 2 needs a real decision (hardcode vs. upstream change). See `docs/slice-0-findings.md` V10. |
| **V11** | **Spec correction.** Upstream **already guards** `config set <vendor>_api_key` against the DB plane — `src/commands/config.ts:29` reads *"never the DB plane, so `config set <vendor>_api_key` must not write the DB"*, with an explicit key list at lines 118-128 and a DUAL-PLANE ambient-writeback carve-out at line 57. | `src/commands/config.ts:22-57,118-128` | The spec's "live trap" is **fixed in v0.50.0.0**. Do not design around the old behavior — **assert the current behavior in a contract test** so a regression or a version bump that reintroduces it is caught. **Slice 0 (2026-09-15):** confirmed via a real contract test (`config set openai_api_key` leaves zero rows in the brain's Postgres `config` table). Caveat: this validates gbrain's own CLI path only, not a direct external file-plane patch — see `docs/slice-0-findings.md` V11 before Slice 1 relies on `patchFilePlaneConfig` doing the equivalent thing. |
| **V12** | `gbrain sources add <id> --path <path>` is the real signature, alongside `--url` and `--kind github\|google`. | `src/commands/sources.ts:10,135-142` | Confirms the spec's Space-creation call. |
| **V13** | `GET /.well-known/gbrain` returns `{ version, protocol, endpoint, profiles: GRANT_PROFILES, adapters: publicHarnessMetadata(), documentation }`. | `src/commands/serve-http.ts:1204-1206` | The harness picker and profile list render **from this payload**, never hard-coded. |
| **V14** | `gbrain --tools-json` is the public CLI tool-catalog contract. | `src/cli.ts:485-486`, `src/commands/tools-json.ts:6` | The data-plane half of the capability snapshot. |

---

## Environment prerequisites

**Current (2026-09-16):** Slice 0–3 are complete on `main`; Slice 2 is complete but unmerged on `slice-2-members-connections`; **Slice 3.5 is complete on `slice-3.5-upgrades`** (Gates A/B/C green; not yet merged). Docker Desktop is installed (Compose v5.5.1). This directory is a git repository. **Next executable stage is Slice 4 — its plan is not yet written.**

The gbrain checkout at `C:\Users\juanp\Desktop\gbrain` is a **read-only reference** — never edit it (G3).

**Project root:** `C:\Users\juanp\Desktop\Company Brain`.

Historical: when this roadmap was first written (2026-09-14), Docker was absent and the directory was not yet a git repo. That is no longer true.

---

## Stage map

Six stages. Each produces working, testable software on its own. **Each stage's exit gate is an end-to-end proof, not a test count.**

```
Slice 0 ──▶ Slice 1 ──▶ Slice 2 ──▶ Slice 3 ──▶ Slice 3.5 ──▶ Slice 4 ──▶ Slice 5
 prove       deploy      members     scheduler   deterministic  agent      managed
 the CLI     + 1 brain   +           (gbrain_    upgrades       runner     cloud
 lane        + 1 admin   connections  command)
```

### Slice 0 — Prove the CLI lane

**Plan:** [`2026-09-14-slice-0-cli-lane-proof.md`](./2026-09-14-slice-0-cli-lane-proof.md) — **COMPLETE** on `main`.

**Why first:** Every TTY requirement, missing `--json` and prose-parse is a risk priced today rather than in month three. This validates or kills V1–V8 and the S2 boundary in one pass.

**Entry gate:** Docker Desktop installed; `docker compose version` succeeds.

**Deliverables:** pinned base image; headless Postgres init; the typed exec layer; the contract test suite; the capability snapshot; **`contracts/v0.50.0.0/operations.json` — the `gbrain-ops` operation list that Slice 1 implements.**

**Exit gate:** the scripted tutorial completes unattended in Docker against Postgres and ends with `gbrain doctor --json` green; the contract suite passes on the pinned version **and is red on a deliberately wrong pin**.

---

### Slice 1 — Deploy + one brain + one admin

**Plan:** [`2026-09-14-slice-1-deploy-one-brain.md`](./2026-09-14-slice-1-deploy-one-brain.md) — **COMPLETE** on `main` (merged 2026-09-15).

**Why:** *This is already the entire value proposition and it exercises every hard integration.* Caddy, Postgres, serve, worker, ops sidecar, control plane, single admin, the wizard, health, backup + tested restore, break-glass runbook, and git writer-contention detection. No multi-user, no scheduler, no agents.

**Git-as-system-of-record** — the spec's most under-designed area — starts here because Slice 1's compose already gives serve, worker and ops one shared working tree. Slice 1 serializes the writes *we* drive and surfaces `index.lock` staleness plus uncommitted drift (sync imports **commits**, not the working tree, unless `sync.include_working_tree` is set). The rest is sequenced deliberately: **commit as the member** (`git -c user.name=… -c user.email=…` per invocation — this is what makes the audit story real rather than "agent-runner did everything") lands with Connections in Slice 2; **push as a scheduled reconcile job, not inline** — with a rejected non-fast-forward surfaced as an alert, never silently swallowed — lands with the scheduler in Slice 3; merge-conflict detection and repo `gc`/rotation land before Slice 4 turns on nightly agents. Full commit serialization needs per-process worktrees or a lock inside gbrain, so it is filed as an **upstream contribution**, not a fork.

**Entry gate:** Slice 0 exit gate green. `contracts/v0.50.0.0/operations.json` checked in.

**Exit gate:** on a clean VM, `docker compose up` → `https://$DOMAIN/api/health` ok; the wizard reaches `ready`; a `put_page` → `search` round trip works; stop/start preserves data; **restore into an empty stack reproduces a known page**; `/admin` is not reachable from the internet.

---

### Slice 2 — Members + Connections

**Plan:** to be written at this gate, from the spec's *Permission compiler*, *Connecting agents* and *Sources & connections* sections plus Slice 1's findings.

**Why before the scheduler:** this is the company-brain unlock, and the scheduler needs an identity to run as.

**Entry gate:** Slice 1 exit gate green.

**Scope:** orgs/roles/memberships (Better Auth organization + RBAC plugins); the permission compiler (`compileConnection(member, writeSpace, readSpaces) → profile / sourceId / federatedRead / boundSlugPrefixes / surface / tokenTtl / budgetUsdPerDay / boundMaxConcurrent`); `gbrain mcp grant --dry-run --json` rendered as the before/after confirm screen; the Space-as-source hard rule enforced in the UI; one-time-use, short-TTL claim links that **burn on fetch**; **revoke shipped in the same sprint as grant**; the harness picker rendered live from `GET /.well-known/gbrain` (V13).

**Honesty rules the UI must encode** — each is a security bug if violated:
1. Read isolation is **per-Space only**.
2. A write fence narrows more than it looks: `--bound-slug-prefixes` also makes `extract_entities`, `extract_facts`, `forget_fact`, `ontology_propose`, `sources_add/remove` and `POST /ingest` unavailable, and skips `put_page`'s automatic fact extraction. **Show it in the diff.**
3. Scope removals are immediate; **additions require a new token** — "promote Alice" is a re-provisioning event she must action on her laptop. Badge it.
4. **Rotation is not revocation.** Outstanding tokens survive a secret rotation; revoking the client is what kills them now.
5. **A passing server check is not proof.** `gbrain mcp verify` exit 2 (`partial`) means server stages passed but harness evidence is missing — **never render that green.**

**Exit gate:** three Spaces, three Members with disjoint grants; as each Connection, run `gbrain whoami` and `gbrain search` from a thin client and assert **every result's `source_id` is in that Connection's read set**; plus a member with two write Spaces proving the two-Connection flow.

---

### Slice 3 — Scheduler, `gbrain_command` only

**Plan:** [`2026-09-15-slice-3-scheduler.md`](./2026-09-15-slice-3-scheduler.md) — **COMPLETE** on `main` (2026-09-15; Gates A/B/C green). Findings: [`docs/slice-3-findings.md`](../../slice-3-findings.md). Runbook: [`docs/runbooks/scheduler.md`](../../runbooks/scheduler.md).

**Why:** replaces the crontab hack; it is the gap every operator notices first. No agents yet — low risk.

**Entry gate:** Slice 2 exit gate green.

**Scope:** Postgres-backed queue in the `control` DB (`SKIP LOCKED`), one leader loop on a Postgres advisory lock, **no Redis**. Allowlisted CLI + params (form rendered from the flag registry), timeout, single-flight.

**Get right the first time — each is a class of bug you fix exactly once:**
- Per-org **IANA timezones with explicit DST handling**. 2am-doesn't-exist and 2am-happens-twice are both real.
- **Catch-up policy** after downtime: run-all / run-latest / skip, per job, **default skip**.
- **Overlap policy**: skip / queue / kill-previous.
- **Quiet hours** default 23:00–08:00 org-local; notification jobs hold output and the morning briefing drains it.
- **Stagger**: at most one job per 5-minute slot, slots `:05 :10 … :50` (upstream's own convention). Refuse a colliding schedule and offer the next free slot.
- **Idempotency key** = `schedule_id + slot`.
- **Output convention**: `reports/<job-name>/<YYYY-MM-DD-HHMM>.md` in the Connection's write Space.
- **Presets** from `docs/guides/cron-schedule.md`: sync + `embed --stale` every 15 min; `gbrain dream` nightly; `gbrain doctor --remediate --max-usd 5` weekly; morning briefing; connector syncs; `check-update` daily. **Encode the doc's own advice — don't over-cron; start with three.**

**Exit gate:** a 5-minute `sync + embed --stale` schedule runs on time **across a DST boundary**; downtime longer than one interval honors the catch-up policy; an overlapping run honors the overlap policy.

---

### Slice 3.5 — Deterministic upgrades

**Plan:** [`2026-09-16-slice-3.5-deterministic-upgrades.md`](./2026-09-16-slice-3.5-deterministic-upgrades.md) — **COMPLETE** on `slice-3.5-upgrades` (Gates A/B/C green; not yet merged). Findings: [`docs/slice-3.5-findings.md`](../../slice-3.5-findings.md). Runbook: [`docs/runbooks/upgrade.md`](../../runbooks/upgrade.md).

**Why pulled forward:** with per-tenant stacks, reaching 20 installs on v0.50 while upstream is at v0.56 creates a backlog that cannot be cleared by hand. **This is the actual moat over the 90-minute tutorial.**

**Entry gate:** Slice 3 exit gate green.

**The flow:**
```
1. Detect     gbrain check-update --json → banner with the changelog
2. Quiesce    stop the scheduler (Slice 3 now exists: one leader loop on a Postgres advisory
              lock, a `schedule_runs` ledger, quiet-hours hold — nothing is lost, materialization
              resumes from the watermark), then worker + runner; SIGTERM drains (V5: up to 40s);
              drain in-flight jobs
3. Snapshot   ONE consistent point-in-time set (volume/VM-layer snapshot preferred)
4. Swap       pull the new pinned tag; recreate serve + worker + ops
5. Schema     gbrain apply-migrations --yes --non-interactive; gbrain post-upgrade
6. Playbook   apply our hand-written step for this version. Residue needing
              judgement → a blocking checklist with per-item acknowledgement and
              an `awaiting_admin_decision` state that persists for days, blocks
              nothing else, and survives control-plane restarts.
              An LLM may PROPOSE the checklist. It never executes. (G5)
7. Gate       gbrain doctor --json (V6) vs baseline
8. Rollback   previous tag + snapshot restore, one operation
```

**Why not LLM-executed** (all three reasons are load-bearing): those playbooks assume full local access, so an agent that could run them would need exactly the privileges the runner sandbox exists to deny; a self-reported receipt from the entity being audited is theater; and the same playbook run by an LLM across 50 tenants produces 50 outcomes. **Read each `skills/migrations/vX.Y.Z.md` once per version and hand-write a deterministic migration step** — a few hours per release.

**Snapshot atomicity is the thing to get right.** A `pg_dump` of two databases plus a `tar` of two volumes taken at three moments is three artifacts that disagree. **Assume migrations are not reversible** — "auto-rollback on regression" is only real if rollback is one atomic operation.

**Exit gate:** upgrade a populated deployment to the next release; assert doctor parity; the `playbook_ledger` records the version; then **deliberately fail a migration and assert one-click rollback restores the pre-upgrade state exactly**.

---

### Slice 4 — Agent runner

**Plan:** to be written at this gate, from the spec's *Agent runner* section.

**Why last of the build stages:** highest risk. Depends on Slice 2 (an identity to run as) and Slice 3 (dispatch).

**Entry gate:** Slice 3.5 exit gate green — **it is** (Gate C 23/0; the plan's six family commands all green). Slice 4 inherits three things it must not break: an exact, moved pin (`v0.50.5.0`; `lint:forbidden`'s moving-pin rule), the `verifyRuntimePin` runtime cross-check surfaced as `/api/health` `pin.matches` (honesty rule 9), and the rule that **an agent runner is never a path to an upgrade** — upgrades run only through the host `scripts/upgrade.ts` lane, never an in-container self-upgrade.

**Non-negotiables:**
- **Dispatch is pull / long-poll. Never the Docker socket.** `POST /runs/claim` with SKIP LOCKED + lease + heartbeat + TTL so a dead runner's job is reclaimed. Scale = replicas.
- **One harness server-side: Claude Code headless.** **Do not make the server-side harness configurable in v1** — that multiplies the security review by 13. The 13-adapter registry belongs to the *user-side* connection flow.
- **Tool surface is MCP-only by default.** No Bash, no writes outside the workspace. Egress allowlisted **at the network layer**, not by asking the agent nicely. Enabling Bash creates a distinct higher-trust job class with its own approval.
- **Workspace:** tmpfs or per-run volume, created at claim, destroyed at completion, **never reused**. No bind mount of `GBRAIN_HOME` or the brain repos.
- **Two gbrain clients per Connection.** The member's own agent gets a long-lived client. Server-side runs get a **separate client, identical scoping, minutes-long `--token-ttl`** (V7). Use `revokeLegacyTokenById` as the run-end kill switch; treat TTL as defense in depth.
- **Proxy model calls through the control plane's gateway.** Highest-leverage single decision here — it turns "budget cap" from an honor system into enforcement, gives per-run accounting for free, and means key rotation never touches runners.
- **Retries: agent runs are not idempotent.** Classify: infra failure (lease lost, OOM, network) → retry, cap 2; budget/timeout exceeded → **never retry, alert**; agent-reported failure → **never retry, surface**. Prefer upsert-by-slug writes.
- **The runner is optional.** A deployment that only connects users' own agents omits it, and the wizard must say **in plain words** that this container executes model-driven code with the org's keys.
- **`"What did the 3am agent do to my brain?"` must be one click** — store prompt, tool calls, token counts, cost, and a **diff of what changed in the brain**, with a revert. Pin harness version and model ID per schedule.

**Exit gate:** a nightly `agent_prompt` produces a run record with cost, token counts and a brain diff; **killing the runner mid-run reclaims the lease without double-writing**; exceeding the budget cap stops the run and alerts rather than silently truncating.

---

### Slice 5 — Managed cloud

**Plan:** to be written at this gate.

**Entry gate:** Slice 3.5 exit gate green **and** Slice 4 exit gate green. Upgrades must be deterministic before this stage exists.

**Scope:** our provisioner stands up the same stack per tenant; the user never sees compose. **N stacks, not one stack with tenants** — gbrain is single-brain-per-`GBRAIN_HOME` with no users table, and `source_id`/`federated_read` is the only isolation axis. This makes upgrade automation load-bearing for the business model, not a nicety. Billing.

**Blocked on Open Question 2** (below) — the search-mode cost spread must be measured before pricing.

---

## Cross-cutting tracks

These run alongside the slices rather than as a stage.

### Nightly drift detection — starts at Slice 0, runs forever

Build nightly against **pinned-current and pinned-next**, run the contract suite (G4), auto-open a drift issue on failure. Publish a support policy: *"we support version X; upgrades land N days after upstream tags."* This is the tripwire that makes G1 safe.

### Observability — assembled incrementally, mostly at Slice 3–4

**Already there upstream:** `GET /metrics` (Prometheus, admin-gated), `mcp_request_log` (one row per `/mcp` call with status, latency, agent, operation; params redacted by default), `/admin/events` SSE, `/admin/api/agents/spend`, `chat_usage_log`, `gbrain jobs stats`, and `autopilot --status` (whose **exit code** is the signal: 0 fresh, 1 needs attention, 2 out of rotation).

**What we add:** spend rolled up **per member and per org**, not per client — gbrain's `budget_usd_per_day` is per OAuth client, and after S4 a member has several, so **it will not aggregate on its own**. Plus alerting *before* the hard cap stops an agent mid-run; run history with artifacts and brain diffs; queue-age p95; and `doctor --json` trended over time rather than as a one-shot.

**Cost attribution is a headline feature for a company brain.** Upstream's own estimate is under $100/month of AI spend for 25 people, but the search-mode choice alone spans ~25×.

Ship Prometheus scrape config and a Grafana dashboard as an **optional compose profile** rather than building charts we don't need to own.

### Upstream contributions — opportunistic

Contributing these back shrinks our permanent maintenance surface:
- A **production Dockerfile** and reference compose (we build one in Slice 0/1 anyway).
- **Bearer auth for `/admin/api/*`**, so machine clients don't need a cookie session.
- Routing `config set *_api_key` to the file plane — **already done upstream as of v0.50.0.0 (V11)**; contribute the contract test instead.
- A **schedule table + `gbrain cron` surface**, if they want it — otherwise it stays our differentiator.

Get a lawyer's eye on naming and positioning before launch: *"built on gbrain"* is a claim about someone else's active project.

---

## What we deliberately do NOT build

- Retrieval, embedding, ingestion, synthesis, the knowledge graph, the MCP server.
- A replacement for `/admin`'s operator surfaces — and per S1 we don't expose them either. **Break-glass instead.**
- **Shared-database multi-tenancy for cloud.** See Slice 5.

---

## Risk register

| # | Risk | Mitigation | Owned by |
|---|---|---|---|
| 1 | Upstream velocity (v0.46→v0.50 in weeks) | Exact-semver pin; contract tests per candidate version (G4); nightly build against pinned-next | Slice 0 + nightly track |
| 2 | `/admin` is a parallel god-mode control plane | Not routed publicly (S1); break-glass via ops sidecar | Slice 1 |
| 3 | Control-plane compromise = brain compromise | Split ops sidecar (S2); control plane holds no brain DB creds | Slice 1 |
| 4 | File-plane write races eat an API key | Single serialized writer + Postgres advisory lock + atomic write (S3) | Slice 1 |
| 5 | Permission UI promises what enforcement can't do | Connections as the unit of access; Space = source hard rule (S4) | Slice 2 |
| 6 | Agent runner is arbitrary code execution with org keys | Network isolation, MCP-only tools, egress allowlist, gateway-proxied model calls, ephemeral workspace, optional deployment | Slice 4 |
| 7 | Inconsistent snapshots make rollback a lie | Quiesce (V5) or volume-level snapshot; CI-tested restore | Slice 1 + 3.5 |
| 8 | Agent retries double-write | Failure classification; upsert-by-slug; idempotency keys | Slice 4 |
| 9 | Secrets sprawl across four planes, a vault and connector JSON | One `secrets` table as source of truth; everything else materialized and re-materialized on rotation | Slice 1 |
| 10 | Many sources may degrade search fan-out / `federated_read[]` | **Open question — measure before committing to Space-per-boundary at scale** | Open Q1 |

---

## Open questions to settle early

1. **Does anything degrade with many sources** — search fan-out, `federated_read[]` array length, repo count on disk? Gates how hard we push Space-per-boundary (risk 10). **Measure during Slice 2**, with a synthetic 25-Space brain.
2. **Managed-cloud pricing vs the search-mode cost spread.** We own the cost there and cannot show every tenant the matrix, so mode becomes a plan tier and the arithmetic has to precede pricing. **Blocks Slice 5.**
3. **Product name**, and whether to approach upstream before or after launch. **Blocks any public artifact.**

---

## Two shapes, one product

**Personal and company are the same deployment with a flag.** `organizations.brain_mode` switches the console between:

- **Personal** — one member, one Space, no invites, no grant matrix, no SSO. The wizard collapses from 10 steps to 5.
- **Company** — the full surface.

Under the hood personal is still one org, one membership, one compiled grant, so promoting to a company brain is a **settings change rather than a migration**. Build company-first and derive personal — strictly cheaper than the reverse, which is why company is the v1 focus.
