# Handoff — read this first

Written 2026-09-15; updated 2026-09-18. **Slices 0, 1, 2, 3 and 3.5 are complete on `main`; Slice 4 is complete on branch `slice-4-agent-runner` and is NOT yet merged to `main`** (Slice 3.5 merged at `202a658`). **All six verification commands are green on that branch** — the last two were re-measured on 2026-09-18 after commit `9efc992` closed the six failures the close-out pass left red, and nothing was weakened to get there (numbers below). **Next action: write the Slice 5 plan** — it is not written, and it is additionally blocked on Open Question 2 (the search-mode cost spread must be measured before pricing). No Slice 4 work is on `main`.

This file is the cold-start entry point. Historical mid-task resume notes (including “resume at Task 3 re-review” and branch `slice-1-deploy-one-brain`) are obsolete and were removed.

---

## What this project is

**brainstand** (codename — rename before any public artifact) wraps [gbrain](https://github.com/garrytan/gbrain) into a product a team deploys with one `docker compose up` and operates from a web console.

The strategy rests on one bet: **gbrain is a pinned upstream dependency driven only through its published contracts. Never forked.** Its CLI is the control lane, its HTTP MCP is the data lane, and a small file plane covers what `config set` refuses. If you find yourself editing gbrain's source or reading its tables directly, stop.

`C:\Users\juanp\Desktop\gbrain` is a **read-only reference checkout**. Read it freely. Never edit it.

---

## Where things stand

| Slice | State |
|---|---|
| 0 — prove the CLI lane | **complete** on `main` |
| 1 — deploy + one brain + one admin | **complete** on `main` (merged 2026-09-15, HEAD `77a18d1` at merge) |
| 2 — members + connections | **complete** on `main` (Gates A/B/C green) |
| 3 — scheduler, `gbrain_command` only | **complete** on `main` (Gates A/B/C green) |
| 3.5 — deterministic upgrades | **complete** on `main` (Gates A/B/C green; merged 2026-09-17, HEAD `202a658` at merge) |
| 4 — agent runner | **complete** on `slice-4-agent-runner` (Gates A/B/C green; all six verification commands green) — **not yet merged to `main`** |

Do **not** re-execute the Slice 0, 1, 2, 3, 3.5 or 4 plan/gate work. Those are historical records. Slice 4's plan is [`docs/superpowers/plans/2026-09-17-slice-4-agent-runner.md`](docs/superpowers/plans/2026-09-17-slice-4-agent-runner.md); its findings and measured spend are [`docs/slice-4-findings.md`](docs/slice-4-findings.md); its runbook is [`docs/runbooks/agent-runner.md`](docs/runbooks/agent-runner.md).

### Live state on the dev stack (measured 2026-09-18, by the agent that closed Slice 4)

- **All six verification commands are green on this branch, and the two that were red at close were re-measured alone on 2026-09-18** by the follow-up pass after `9efc992`: `lint:forbidden` clean · `tsc --noEmit` clean · `test/unit` **602 / 0** · `test/integration` **428 pass / 1 skip / 0 fail of 429** (1782 `expect()` calls, 53.60s) · `test/contract` **142 pass / 0 fail of 142** (594 `expect()` calls, 381.64s) · `bun test --parallel=1 test/e2e` **104 / 0 twice consecutively**; both build gates pass both arms. Verbatim tails are in `PROGRESS.md`'s Slice 4 section, and no test or gate was weakened to reach them. **Check `docker port brainstand-gbrain-ops-1` says `3140/tcp -> 0.0.0.0:3140` before the host-run suites** — after `test/integration` it will not, because `quiesce.test.ts` resumes through the base compose file alone; re-up the dev stack in between.

- The dev stack runs **`0.50.5.0`** (`.env` `GBRAIN_VERSION=0.50.5.0`; `gbrain-ops`'s binary reports `gbrain 0.50.5.0`; `gbrain-serve` and `gbrain-worker` run `brainstand/gbrain-base:0.50.5.0`; `GET /api/health` is 200 with `pin: {declared:"0.50.5.0", observed:"0.50.5.0", matches:true}` and `components: {controlDb:"ok", ops:"ok"}`).
- **The Spaces are `customers`, `internal` and `shared`** — 6 pages and 6 chunks in total (1 / 3 / 2). This is **thin, not the populated post-F4 brain** the stack held at Slice 3.5's close: the e2e family cycles the volumes with its own `down -v` (`restore.e2e.test.ts`) and the wizard re-provisions from scratch, so the deep fixture is gone and the next session starts from what the last e2e run left. A `slice3-probe` Space appears and disappears with `test/contract`'s Gate A fixture (`sources list` → `sources remove` → re-seed → `sources add`); seeing it is not a defect.
- **The runner lane is ENABLED.** `RUNNER_TOKEN` is non-empty in `.env`; `agent-runner` is up on `brainstand/agent-runner:2.1.274`; it is polling: the control-plane log carries `POST /api/runs/claim 204 25s` continuously, and the container's own log reads `[runner] <id> up, harness 2.1.274, tools 7 on the closed list`. Left up and polling by the 2026-09-18 verification pass — it was down when that pass began, having been drained by a suite's own quiesce leg and not resumed by it, which is the documented behaviour (D12/D13), not a fault.
- **`/api/health` carries the three-state `runner` block**: `{"state":"disabled" | "never_claimed" | "connected", "lastSeenAt": …, "version": …}`. `disabled` means `RUNNER_TOKEN` is unset or whitespace; `connected` is the **only** green state and it needs a `schedule_runs` row with `claimed_by` and a live lease; `never_claimed` is what a healthy, long-polling lane reads when **no run is leased**. Right now it reads `{"state":"never_claimed","lastSeenAt":null,"version":null}` — that is not “the runner is missing”.
- **Both secrets are present** in the control DB's `secrets` table, envelope-encrypted: `anthropic_api_key` and `openai_api_key`. Verified by name and length only; never print the values.
- **The harness is pinned at `2.1.274`** — `.env` `HARNESS_VERSION`, the image tag `brainstand/agent-runner:2.1.274`, `docker/agent-runner.Dockerfile`'s build-time gate, and the runner's own announcement all agree.
- **All five schedules are DISABLED**: the 5-minute `live-sync` on `shared`, `nightly-dream`, `gate-c-nightly`, `gate-c-ambiguous` and `gate-b-throwaway`. Four carry `disabled_reason = "gate C upgrade window"` (the upgrade gate disables the writers for the window and restores them afterwards) and `gate-b-throwaway` carries `connection_revoked`. **The Slice-3-era warnings that `live-sync` was firing every 5 minutes and that `gate-c-nightly` / `gate-c-ambiguous` were still enabled and would resume as real paid `dream` runs after 2026-11-01 are no longer true; they were verified gone on this stack and removed from this file.**
- **A pending `awaiting_admin_decision` item is still live and still blocks nothing else.** `playbook_ledger` holds `0.50.1.0`, `0.50.4.0` and `0.50.5.0` as `applied`, and `0.50.2.0` as `awaiting_admin_decision` with **8 `upgrade_checklist_items` still `pending`** — so the upgrade banner is up. Clear it at `/upgrades` or `POST /api/upgrades/checklist/:itemId/ack` (admin only); preflight refuses a new upgrade run while one is pending. **Verified still true on this stack — the warning stays.**
- **Gate residue you should expect, and not mistake for product state:** 1 organization, 10 `memberships` (1 owner, 8 members, 1 viewer), and **7 active / 3 revoked Connections**, all left by repeated gate runs. Two alerts are open (`overlap_killed_previous`, `connection_revoked`); `/api/health` carries unacknowledged **kinds only**, and `/schedules` is the only place to acknowledge one.
- **A restore or a quiesce leaves the runner DOWN by design** (D12/D13): `restoreLane` deliberately does not resume a service whose profile is inactive, and `agent-runner` drains on SIGTERM and exits 0. Bring it back with `docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml --profile runner up -d caddy-ca-export agent-runner` — the CA export first, it is a declared dependency.
- The `bs-fp-pg` scratch Postgres is still up on `localhost:5432` for host-run tests (see `docs/slice-3-findings.md` F10); `test/integration` needs `CONTROL_DATABASE_URL` exported.
- Pausing the scheduler is `docker compose stop scheduler` (see the scheduler runbook).

**Progress tracker:** [`docs/superpowers/plans/PROGRESS.md`](docs/superpowers/plans/PROGRESS.md)

---

## How to run

Local stack (needs `.env` with `DOMAIN=localhost` and the secrets from `.env.example`):

```bash
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml up -d --wait
```

The dev override is **not optional on this machine**: it publishes `gbrain-ops` on `3140:3140`, which every host-run suite reaches over `OPS_RPC_URL=http://127.0.0.1:3140`. A stack brought up from the base file alone leaves `test/contract` and `test/e2e` failing on `ConnectionRefused`.

The runner lane is additionally switched on with:

```bash
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml --profile runner up -d caddy-ca-export agent-runner
```

Clean-VM / production path is `scripts/install.sh` (passes `--env-file` so Compose interpolates the root `.env` it writes). Backup and restore are **host** operations (`scripts/backup.ts`, `scripts/restore.ts`); in-container `POST /api/backup` returns 503 when Docker is unavailable.

Slice 0 contract stack: `bun run stack:up` / `stack:down`.

Host-run test suites need the dev stack up and `CONTROL_DATABASE_URL` exported (several integration files default it locally and some do not). Run `test/integration` **before** `test/contract` / `test/e2e`, or re-up the dev stack in between: `test/integration/quiesce.test.ts` resumes through `compose/docker-compose.yml` alone and recreates `gbrain-ops` without the dev override's port publication.

---

## What not to do

- Don't fork gbrain, import past its `exports` map, read its tables directly, or screen-scrape human-readable CLI output.
- Don't run `gbrain autopilot --install` in a container — `lint:forbidden` catches it.
- Don't invoke `gbrain` through a shell string. Argv arrays only.
- Don't weaken a test or gate to make it pass.
- Don't mount the Docker socket into the control plane.
- Don't `git add .env`. It holds a real `OPENAI_API_KEY` plus `RUNNER_TOKEN`, `OPS_RPC_TOKEN`, `ENCRYPTION_KEY`, `BETTER_AUTH_SECRET` and the Postgres password. `sk-`-shaped strings in tests are deliberate fakes.
- **The runner lane:**
  - **Never give `agent-runner` a database URL** (brain or control), `GBRAIN_HOME`, `OPS_RPC_TOKEN`, `ENCRYPTION_KEY` or a provider key. Its only credentials are `RUNNER_TOKEN` and the per-run gbrain token, and the container is a client of the control plane, never of the database.
  - **Never mount the Docker socket into anything that touches agent output**, and never mount a volume into the runner at all (`volumes: []`, ever). Its workspace is a fresh directory under the `/tmp` tmpfs, created at claim and destroyed on every exit path.
  - **Never add a host port to the runner.** Caddy is the only service publishing host ports.
  - **The network is the fence, and the tool flags are only defence in depth.** `runner-net` is `internal: true` with no default route; `--allowedTools` / `--disallowedTools` narrow further. Never attach the runner to a second network and never route `/api/runs/*` or `/api/gateway/*` through Caddy — those surfaces are internal-only.
  - **Bash is a distinct, higher-trust job class that Slice 4 deliberately does not implement.** `schedules` has no column, field or pass-through for a tool allowlist, permission mode or shell, so a payload carrying one dies as an unknown field. A prompt that asks for Bash produces no `tool_use` at all and `permission_denials: []` — `--tools ""` removes the built-in surface at the source.
  - Never `--no-deps` the runner up (the dev CA export must run first), never edit a schedule's harness version to make a claim succeed, and never read the agent's closing message as the run's status or a `costUsd` of `null` as zero.
  - Never revoke a Connection as a way to pause agent runs, and never `docker compose down -v` to “clean up” a run — revert is the way back, and it is a new commit, not a wipe.

---

## Quick reference

| | |
|---|---|
| Branch | `slice-4-agent-runner` — **Slice 4's work, not yet merged**; Slices 0–3.5 are on `main` (Slice 3.5 at `202a658`) |
| Roadmap | [`docs/superpowers/plans/2026-09-14-brainstand-roadmap.md`](docs/superpowers/plans/2026-09-14-brainstand-roadmap.md) |
| Slice 0 plan (historical) | [`docs/superpowers/plans/2026-09-14-slice-0-cli-lane-proof.md`](docs/superpowers/plans/2026-09-14-slice-0-cli-lane-proof.md) |
| Slice 1 plan (historical) | [`docs/superpowers/plans/2026-09-14-slice-1-deploy-one-brain.md`](docs/superpowers/plans/2026-09-14-slice-1-deploy-one-brain.md) |
| Slice 3 plan (historical) | [`docs/superpowers/plans/2026-09-15-slice-3-scheduler.md`](docs/superpowers/plans/2026-09-15-slice-3-scheduler.md) — carries the execution corrections inline |
| Slice 3.5 plan (historical) | [`docs/superpowers/plans/2026-09-16-slice-3.5-deterministic-upgrades.md`](docs/superpowers/plans/2026-09-16-slice-3.5-deterministic-upgrades.md) — carries the execution corrections inline |
| Slice 4 plan | [`docs/superpowers/plans/2026-09-17-slice-4-agent-runner.md`](docs/superpowers/plans/2026-09-17-slice-4-agent-runner.md) — D1–D13, Tasks 1–18, the execution corrections inline |
| Slice 0 risk register | [`docs/slice-0-findings.md`](docs/slice-0-findings.md) |
| Slice 2 scale probe | [`docs/slice-2-findings.md`](docs/slice-2-findings.md) |
| Slice 3 findings | [`docs/slice-3-findings.md`](docs/slice-3-findings.md) |
| Slice 3.5 findings | [`docs/slice-3.5-findings.md`](docs/slice-3.5-findings.md) — U1–U12, P1–P8, F1–F9, Gate C's measured numbers |
| Slice 4 findings | [`docs/slice-4-findings.md`](docs/slice-4-findings.md) — U1–U8, P1–P9, F1–F17, Gate C's measured numbers and real spend |
| Scheduler runbook | [`docs/runbooks/scheduler.md`](docs/runbooks/scheduler.md) |
| Upgrade runbook | [`docs/runbooks/upgrade.md`](docs/runbooks/upgrade.md) |
| **Agent runner runbook** | [`docs/runbooks/agent-runner.md`](docs/runbooks/agent-runner.md) — enable/disable, the three health states, “what did the 3am agent do”, revert, killing a run, rotating the Anthropic key |
| Break-glass | [`docs/runbooks/break-glass.md`](docs/runbooks/break-glass.md) |
| Spec | `C:\Users\juanp\.claude\plans\we-want-to-do-snug-wolf.md` |
| gbrain pin | `v0.50.5.0` (exact, never a moving tag) |
| Harness pin | `@anthropic-ai/claude-code@2.1.274` (exact; `HARNESS_VERSION` in `.env`) |
| gbrain reference | `C:\Users\juanp\Desktop\gbrain` (read-only) |

---

## Process facts the next session needs

- **Agent spend limit.** Slice 3.5 was executed with two agents. The `claude` agent's monthly spend limit
  exhausted during Task 1's phase 2, and **every task after Task 1 phase 2 was executed by the `opencode`
  agent**. The plan's own text still assumes a single agent; treat that branch as mixed-authored, not as a
  single run. Slice 4 was likewise authored by more than one agent (the findings doc and the gate files
  name their authors where it matters).
- **`bash` on PATH is a broken WSL relay** (`C:\Windows\system32\bash.exe`). The two build gates
  (`test/build/pin.test.sh`, `test/build/harness-pin.test.sh`) must be run through **Git bash**:
  `"C:/Program Files/Git/bin/bash.exe" test/build/pin.test.sh`. Export `GBRAIN_VERSION` / `HARNESS_VERSION`
  from `.env` first, or the scripts fall back to their `0.50.0.0` / `2.1.274` defaults.
- **Machine-level opencode config (not a repo change).** The coordinator added a `permission` block to
  `~/.config/opencode/opencode.jsonc` — `read`/`glob`/`grep`/`list`/`lsp` set to `allow`, plus
  `external_directory` allow — because the `opencode` agent otherwise stalls on approval prompts mid-task.
  This lives outside the repository, so a fresh VM or a different user needs it re-added before dispatching
  `opencode` workers. It is not committed here and is not a product change.
- **The six verification failures Slice 4 closed with are fixed, not open.** Commit `9efc992` closed them
  the same day: three `test/integration/claim.test.ts` counts were stale against Task 5's deliberate
  **second, server-side gbrain client per Connection** (the assertions now pin the contract by name), the
  `capability_snapshots` fixture was shared with this slice's new `agent-runs.test.ts` (now scoped by a
  per-run version suffix), `backup.test.ts` was answered by a sibling file's **process-wide
  `mock.module` of `src/control/opsClient.ts`** (now: `test/helpers/stack.ts`'s cross-process
  stack-exclusion lock plus running the real script in its own process), and
  `test/contract/upgrade.contract.test.ts:295`'s operation-count pin moved **33 → 34** with its reason in
  the comment. `PROGRESS.md`'s Slice 4 section carries the full account, the verbatim tails and the
  hazard write-up. Nothing was weakened to hide any of them.
- **Two hazards that fix does not remove, carried into Slice 5.** (a) The `mock.module` hazard is
  contained, not cured: routing the runtime's ops access through an injectable caller — the shape
  `src/upgrade/quiesce.ts`'s `OpsCaller` already uses — is Slice 5's work, so a **new** file that needs
  the real ops client can still be answered by a sibling's mock. (b) `scripts/backup.ts`'s probe reads
  `quiesced` through a client whose default URL is a container name
  (`src/control/opsClient.ts:6`, `http://gbrain-ops:3140`), which cannot resolve on a production host
  (no `:3140` published), and its `catch` turns that connection failure into `quiesced: true`. Also
  carried: `test/integration/agent-runs.test.ts` leaves one `capability_snapshots` row behind per run.
