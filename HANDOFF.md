# Handoff — read this first

**Mobrain 1.0.0 shipped.** This is the cold-start entry point for a released product, not a build in
progress. Slices 0–5 are complete and merged on `main` (Slice 5 at the `v1.0.0` tag); `main` is the only
branch. The eight verification commands are green on the frozen tree, e2e twice consecutively, with
verbatim tails in [`PROGRESS.md`](docs/superpowers/plans/PROGRESS.md). The release artifacts are the three
published digests below — **a release is its digests; a tag is a label someone can move.**

---

## What this project is

**Mobrain** wraps [gbrain](https://github.com/garrytan/gbrain) into a product a team deploys with one
`scripts/install.sh` and operates from a web console. It was codenamed `brainstand` through Slices 0–4 and
renamed in Slice 5's Task 4; the three frozen crypto strings keep their original bytes because they are
key-derivation domain separators, not product names (D3).

The strategy rests on one bet: **gbrain is a pinned upstream dependency driven only through its published
contracts. Never forked.** Its CLI is the control lane, its HTTP MCP is the data lane, and a small file
plane covers what `config set` refuses. If you find yourself editing gbrain's source or reading its tables
directly, stop.

`C:\Users\juanp\Desktop\gbrain` is a **read-only reference checkout**. Read it freely. Never edit it.

---

## What shipped in 1.0.0

- **Install:** `scripts/install.sh` + `scripts/preflight.sh` (Docker/Compose version floors, RAM, disk,
  ports 80/443, DNS for `$DOMAIN`); the console's wizard reaches `ready` on a clean host.
- **Images published from CI to `ghcr.io/molanojf`** (the only GHCR owner available; the product name is not
  a registry namespace). The local `gh` OAuth token lacks `write:packages`, so CI owns every push — never
  attempt a host-side `docker push`.
- **Backup/restore:** the backup manifest's quiesce is three-state (`verified` / `unverified` / `failed`) and
  a production-shaped stack proves it through the `compose exec` relay; restoring to a new `DOMAIN`
  invalidates every grant, disables the affected schedules, and raises member-facing `connection_revoked`
  alerts.
- **Spend:** `GET /api/spend` states its own coverage before its totals, carries gbrain's `notCovered` list
  verbatim, and never sums the two meters. Search-mode `measuredCost` stays `null` on this deployment
  (P5), so no ratio is shown.
- **Drift tripwire:** the nightly pinned-next arm opens exactly one issue per drifting version and comments
  on re-run; the pinned-current arm stays blocking.
- **Upgrades:** the host `scripts/upgrade.ts` lane still passes Slice 3.5's rollback gate on the renamed,
  re-published stack (C9). An agent runner is never a path to an upgrade.
- **Docs/licence:** `README.md`, `LICENSE` (MIT), `SECURITY.md`, `docs/support-policy.md`, plus the
  install/backup-restore runbooks.
- **Deliberately not in 1.0.0:** managed cloud, billing, any provisioner, any pricing page. The one
  remaining open question is managed cloud (below).

### The published digests (v1.0.0)

| Image | Tag | RepoDigest |
|---|---|---|
| `gbrain-base` | `0.50.5.0` | `ghcr.io/molanojf/gbrain-base@sha256:83c6e585681be27a15fa476b7307991ef0fb5334c92175686831008c60bfca0e` |
| `control-plane` | `1.0.0` | `ghcr.io/molanojf/control-plane@sha256:e6d9ecab9ce59f3762364098c12be850a12e743428db33fcdca62e0849e1a2ba` |
| `agent-runner` | `2.1.274` | `ghcr.io/molanojf/agent-runner@sha256:55372d5e8b80277c55004a14d9fe0db2ac35dc1f94ed5c83a2897b935e80e950` |

Source of record: the `publish` job of the [`contract` workflow](.github/workflows/contract.yml). They are
verified from a fresh runner that did not build them by
[`release-verify.yml`](.github/workflows/release-verify.yml) (dispatch it; it pulls all three by digest and
starts them). [`CHANGELOG.md`](CHANGELOG.md) carries the same three digests.

### The one remaining open question — managed cloud

Managed cloud is deferred to a later slice. The substrate decision is recorded as **D12** in the Slice 5
plan and is **not** to be re-argued: **one VM per tenant, created through a cloud provider API, installed by
running this release's `install.sh` over SSH**, with the stack's own backup/restore and upgrade lanes
operated per tenant. Rejected: a shared fleet with several compose projects per host, and Kubernetes.
**Nothing in this repository builds a provisioner yet, and nothing else about the cloud slice is presumed.**
Pricing is still unsettled — **Open Question 2** (the search-mode cost spread) must be measured on a
populated corpus before pricing, and that is the deferred slice's first job.

---

## Live state on the dev stack (measured 2026-09-19)

- **The stack is up** on the base + dev compose files: `caddy`, `postgres` (healthy), `gbrain-ops` and
  `control-plane` and `scheduler` (all `ghcr.io/molanojf/control-plane:dev`), `gbrain-serve`/`gbrain-worker`
  (the pinned `gbrain-base`), and `agent-runner`. `docker port brainstand-gbrain-ops-1` reads
  `3140/tcp -> 0.0.0.0:3140`.
- **`GET /api/health` is 200**: `components: {controlDb:"ok", ops:"ok"}`, `pin: {declared:"0.50.5.0",
  observed:"0.50.5.0", matches:true}`, and `runner: {state:"connected", version:"2.1.274"}`.
- **The brain is thin:** 4 sources and 4 pages (the e2e family cycles the volumes with its own `down -v` and
  the wizard re-provisions from scratch). A `slice3-probe` Space appears and disappears with
  `test/contract`'s Gate A fixture; seeing it is not a defect.
- **The dev stack runs local builds (`control-plane:dev`), not the released `1.0.0` tag.** The installer
  pulls `control-plane:1.0.0`; the dev box deliberately runs `dev`.
- **Both secrets are present** in the control DB's `secrets` table, envelope-encrypted:
  `anthropic_api_key` and `openai_api_key` (verified by name only; never print the values). **The anthropic
  row is a rotating host secret.** The stored value is the machine's Claude Code OAuth access token, so the
  CLI's next refresh revokes it — every model call then answers `401 authentication_error` / `OAuth access
  token has been revoked.` with nothing changed in this repository — and a restore or an upgrade rollback
  can put back a `secrets` generation that predates a rotation. **Re-provision *after* a destructive cycle,
  never before.** Procedure and record: `docs/runbooks/agent-runner.md`, "Rotating the Anthropic key".
- **The D11 debt was cleared through product paths (Task 14, P7) — and a later destructive e2e cycle
  restored it.** The release verification pass's own `test/e2e` runs restore control-DB snapshots from the
  Slice 2/3 era, so the stack currently carries the **pre-Task-14** residue again, measured directly:
  **1 organization, 10 memberships, 10 Connections (7 active / 3 revoked), 2 open alerts
  (`overlap_killed_previous`, `connection_revoked`), 8 pending `upgrade_checklist_items` on `0.50.2.0`
  (`awaiting_admin_decision`), and 5 schedules, all disabled.** This is expected from the destructive e2e
  family, not a regression, and it is clearable through the product exactly as Task 14 proved: ack the
  checklist at `/upgrades` (or `POST /api/upgrades/checklist/:itemId/ack`), ack alerts at `/schedules`, and
  offboard residue members with `DELETE /api/members/:id`. No SQL is used to clear it.
- **One required Connection-purge path does not exist (F22).** `POST /api/connections/:id/revoke` exists;
  `DELETE /api/connections/:id` does not, so a revoked Connection survives until its member is offboarded
  (which cascades) — and cannot be offboarded while a live schedule holds the member. Deferred to the next
  hardening slice; see `docs/slice-5-findings.md`.
- **A restore or a quiesce leaves the runner DOWN by design** (D12/D13): `restoreLane` deliberately does not
  resume a service whose profile is inactive, and `agent-runner` drains on SIGTERM and exits 0. Bring it back
  with the CA export first:
  `docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml --profile runner up -d caddy-ca-export agent-runner`.
- The `bs-fp-pg` scratch Postgres is still up on `localhost:5432` for host-run tests; `test/integration`
  needs `CONTROL_DATABASE_URL` exported. Pausing the scheduler is `docker compose stop scheduler`.

**Progress tracker:** [`docs/superpowers/plans/PROGRESS.md`](docs/superpowers/plans/PROGRESS.md)

---

## How to run

Local stack (needs `.env` with `DOMAIN=localhost` and the secrets from `.env.example`):

```bash
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml up -d --wait
```

The dev override is **not optional on this machine**: it publishes `gbrain-ops` on `3140:3140`, which every
host-run suite reaches over `OPS_RPC_URL=http://127.0.0.1:3140`. A stack brought up from the base file alone
leaves `test/contract` and `test/e2e` failing on `ConnectionRefused`.

The runner lane is additionally switched on with:

```bash
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml --profile runner up -d caddy-ca-export agent-runner
```

Clean-VM / production path is `scripts/install.sh` (passes `--env-file` so Compose interpolates the root
`.env` it writes). Backup and restore are **host** operations (`scripts/backup.ts`, `scripts/restore.ts`);
in-container `POST /api/backup` returns 503 when Docker is unavailable. Slice 0 contract stack:
`bun run stack:up` / `stack:down`.

Host-run test suites need the dev stack up and `CONTROL_DATABASE_URL` exported (several integration files
default it locally and some do not). Run `test/integration` **before** `test/contract` / `test/e2e`, or re-up
the dev stack in between: `test/integration/quiesce.test.ts` resumes through `compose/docker-compose.yml`
alone and recreates `gbrain-ops` without the dev override's port publication.

---

## Runbooks and where the docs live

| Document | What it is |
|---|---|
| [`docs/runbooks/install.md`](docs/runbooks/install.md) | Clean-host install and preflight |
| [`docs/runbooks/backup-restore.md`](docs/runbooks/backup-restore.md) | Backup, quiesce lanes, new-domain restore |
| [`docs/runbooks/upgrade.md`](docs/runbooks/upgrade.md) | The deterministic upgrade and rollback lane |
| [`docs/runbooks/scheduler.md`](docs/runbooks/scheduler.md) | Schedules, quiet hours, catch-up/overlap |
| [`docs/runbooks/agent-runner.md`](docs/runbooks/agent-runner.md) | Enable/disable, the three health states, revert, rotating the Anthropic key |
| [`docs/runbooks/break-glass.md`](docs/runbooks/break-glass.md) | Operator recovery over the ops sidecar |
| [`docs/support-policy.md`](docs/support-policy.md) | The supported pin, upgrade cadence, the drift tripwire, what is not promised |
| [`docs/slice-5-findings.md`](docs/slice-5-findings.md) | U1–U3, P1–P9, F20–F32 — every status and every deferral |
| [`CHANGELOG.md`](CHANGELOG.md) | The release entries and the published digests |
| [`README.md`](README.md), [`LICENSE`](LICENSE), [`SECURITY.md`](SECURITY.md) | The front door |

**Support policy in one line:** we support exactly the pinned gbrain (`0.50.5.0`) and harness (`2.1.274`);
upgrades are host-driven and deterministic; we target a supported upgrade within **30 days** of an upstream
tag; the nightly drift job is the tripwire. See `docs/support-policy.md` for the full promises and
non-promises.

---

## What not to do

- Don't fork gbrain, import past its `exports` map, read its tables directly, or screen-scrape human-readable
  CLI output.
- Don't run `gbrain autopilot --install` in a container — `lint:forbidden` catches it.
- Don't invoke `gbrain` through a shell string. Argv arrays only.
- Don't weaken a test or gate to make it pass.
- Don't mount the Docker socket into the control plane.
- Don't `git add .env`. It holds a real `OPENAI_API_KEY` plus `RUNNER_TOKEN`, `OPS_RPC_TOKEN`,
  `ENCRYPTION_KEY`, `BETTER_AUTH_SECRET` and the Postgres password. `sk-`-shaped strings in tests are
  deliberate fakes.
- Don't attempt a host-side `docker push` to GHCR; the local token lacks `write:packages`. CI publishes.
- **The runner lane:**
  - **Never give `agent-runner` a database URL** (brain or control), `GBRAIN_HOME`, `OPS_RPC_TOKEN`,
    `ENCRYPTION_KEY` or a provider key. Its only credentials are `RUNNER_TOKEN` and the per-run gbrain
    token, and the container is a client of the control plane, never of the database.
  - **Never mount the Docker socket into anything that touches agent output**, and never mount a volume into
    the runner at all (`volumes: []`, ever). Its workspace is a fresh directory under the `/tmp` tmpfs,
    created at claim and destroyed on every exit path.
  - **Never add a host port to the runner.** Caddy is the only service publishing host ports.
  - **The network is the fence, and the tool flags are only defence in depth.** `runner-net` is `internal:
    true` with no default route; `--allowedTools` / `--disallowedTools` narrow further. Never attach the
    runner to a second network and never route `/api/runs/*` or `/api/gateway/*` through Caddy.
  - **Bash is a distinct, higher-trust job class that Slice 4 deliberately does not implement.** A prompt
    that asks for Bash produces no `tool_use` at all and `permission_denials: []` — `--tools ""` removes the
    built-in surface at the source.
  - Never `--no-deps` the runner up (the dev CA export must run first), never edit a schedule's harness
    version to make a claim succeed, and never read the agent's closing message as the run's status or a
    `costUsd` of `null` as zero.
  - Never revoke a Connection as a way to pause agent runs, and never `docker compose down -v` to "clean up" a
    run — revert is the way back, and it is a new commit, not a wipe.

---

## Quick reference

| | |
|---|---|
| Release | **Mobrain 1.0.0**, tagged `v1.0.0`; digests in [`CHANGELOG.md`](CHANGELOG.md) |
| Branch | `main` only — Slices 0–5 all merged (Slice 4 at `6ba1754`, Slice 5 at the `v1.0.0` tag) |
| Roadmap | [`docs/superpowers/plans/2026-09-14-brainstand-roadmap.md`](docs/superpowers/plans/2026-09-14-brainstand-roadmap.md) |
| Slice 5 plan | [`docs/superpowers/plans/2026-09-18-slice-5-self-host-ga.md`](docs/superpowers/plans/2026-09-18-slice-5-self-host-ga.md) — D1–D13, Tasks 1–18 |
| Slice 5 findings | [`docs/slice-5-findings.md`](docs/slice-5-findings.md) — U1–U3, P1–P9, F20–F32, the deferrals |
| Slice 4 plan | [`docs/superpowers/plans/2026-09-17-slice-4-agent-runner.md`](docs/superpowers/plans/2026-09-17-slice-4-agent-runner.md) — historical |
| Earlier findings | [`docs/slice-0-findings.md`](docs/slice-0-findings.md), [`docs/slice-2-findings.md`](docs/slice-2-findings.md), [`docs/slice-3-findings.md`](docs/slice-3-findings.md), [`docs/slice-3.5-findings.md`](docs/slice-3.5-findings.md), [`docs/slice-4-findings.md`](docs/slice-4-findings.md) |
| Spec | `C:\Users\juanp\.claude\plans\we-want-to-do-snug-wolf.md` |
| gbrain pin | `v0.50.5.0` (exact, never a moving tag) |
| Harness pin | `@anthropic-ai/claude-code@2.1.274` (exact; `HARNESS_VERSION` in `.env`) |
| gbrain reference | `C:\Users\juanp\Desktop\gbrain` (read-only) |

---

## Process facts the next session needs

- **The next stage is the deferred cloud slice**, not more self-host GA work. Execute it from a new plan
  written at that gate; D12 records the substrate decision and Open Question 2 keeps pricing open.
- **`bash` on PATH is a broken WSL relay** (`C:\Windows\system32\bash.exe`). The two build gates
  (`test/build/pin.test.sh`, `test/build/harness-pin.test.sh`) must be run through **Git bash**:
  `"C:/Program Files/Git/bin/bash.exe" test/build/pin.test.sh`. Export `GBRAIN_VERSION` / `HARNESS_VERSION`
  from `.env` first, or the scripts fall back to their defaults.
- **Machine-level opencode config (not a repo change).** The coordinator added a `permission` block to
  `~/.config/opencode/opencode.jsonc` — `read`/`glob`/`grep`/`list`/`lsp` set to `allow`, plus
  `external_directory` allow — because the `opencode` agent otherwise stalls on approval prompts mid-task.
  It lives outside the repository, so a fresh VM or a different user needs it re-added before dispatching
  `opencode` workers.
- **Agent spend limit / mixed authorship.** Slice 3.5, 4 and 5 were authored by more than one agent (the
  `claude` agent's monthly limit was exhausted mid-slice); the findings docs and gate files name their
  authors where it matters. Treat the branches as mixed-authored.
- **Workflow-file pushes need a temporary deploy key.** The `gh` OAuth token lacks the `workflow` scope, so a
  push that changes anything under `.github/workflows/` needs a deploy key with write access; add it, push,
  and delete it immediately.
- **Hazards carried, not cured** (all recorded in `docs/slice-5-findings.md`): a new contract file can still
  be answered by a sibling's process-global `mock.module` (F27/F32 containment); the host-side spend read
  still reaches `src/control/opsClient.ts` directly rather than through an injected `OpsCaller`; and
  `test/integration/agent-runs.test.ts` leaves one `capability_snapshots` row behind per run.
- **OpenCode/coordinator note:** when a worker edits only docs, the eight verification commands need not be
  re-run; when a worker edits runtime `src/`, they must.
