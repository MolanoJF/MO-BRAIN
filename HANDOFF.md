# Handoff — read this first

Written 2026-09-15; updated 2026-09-17. **Slices 0, 1, 2, 3 and 3.5 are complete on `main`** — one branch, `main`; Slice 3.5 merged at `202a658`. **Next is Slice 4** — its plan is not yet written.

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

Do **not** re-execute the Slice 0, Slice 1, Slice 2, Slice 3, or Slice 3.5 plan/gate work. Those are historical records.

### Live state on the dev stack (left by Slice 3.5 — expect it)

- The dev stack runs **`0.50.5.0`** (`.env` `GBRAIN_VERSION=0.50.5.0`; `gbrain-ops`'s binary reports `gbrain 0.50.5.0`; `gbrain-serve` and `gbrain-worker` run `brainstand/gbrain-base:0.50.5.0`; `GET /api/health` is 200 with `pin: {declared:"0.50.5.0", observed:"0.50.5.0", matches:true}`).
- A **populated post-F4 brain** (the Gate C fixture): ≥3 Spaces with committed pages, one admin member, and `playbook_ledger` now holds the four delta versions (`0.50.1.0`, `0.50.2.0`, `0.50.4.0`, `0.50.5.0`; `0.50.2.0` is `awaiting_admin_decision` because its playbook opens 8 checklist items, the rest `applied` with the no-playbook evidence in `notes`). `capability_snapshots` holds **two** rows (`0.50.0.0` and `0.50.5.0`, recorded by each `run` itself since the F7 fix — the run captures both pins and the reconciler imports them).
- Slice 3's live state is still present: one **ENABLED 5-minute `live-sync` schedule on `shared`**, six disabled `console-*` demos, one revoked Connection, and the two **frozen** `gate-c-nightly` / `gate-c-ambiguous` calendar fixtures (still enabled but frozen until **2026-11-01** — retire them before then, or they resume as real paid `dream` runs).
- **A pending `awaiting_admin_decision` item keeps the banner up and blocks nothing else.** Clear it at `/upgrades` or `POST /api/upgrades/checklist/:itemId/ack` (admin only). Preflight refuses a new run while one is pending.
- Pausing everything is `docker compose stop scheduler` (see the scheduler runbook).

**Progress tracker:** [`docs/superpowers/plans/PROGRESS.md`](docs/superpowers/plans/PROGRESS.md)

---

## How to run

Local stack (needs `.env` with `DOMAIN=localhost` and the secrets from `.env.example`):

```bash
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml up -d --wait
```

Clean-VM / production path is `scripts/install.sh` (passes `--env-file` so Compose interpolates the root `.env` it writes). Backup and restore are **host** operations (`scripts/backup.ts`, `scripts/restore.ts`); in-container `POST /api/backup` returns 503 when Docker is unavailable.

Slice 0 contract stack: `bun run stack:up` / `stack:down`.

---

## What not to do

- Don't fork gbrain, import past its `exports` map, read its tables directly, or screen-scrape human-readable CLI output.
- Don't run `gbrain autopilot --install` in a container — `lint:forbidden` catches it.
- Don't invoke `gbrain` through a shell string. Argv arrays only.
- Don't weaken a test or gate to make it pass.
- Don't mount the Docker socket into the control plane.
- Don't `git add .env`. It holds a real `OPENAI_API_KEY`. `sk-`-shaped strings in tests are deliberate fakes.

---

## Quick reference

| | |
|---|---|
| Branch | `main` only — Slices 0–3.5 all merged (Slice 3.5 at `202a658`) |
| Roadmap | [`docs/superpowers/plans/2026-09-14-brainstand-roadmap.md`](docs/superpowers/plans/2026-09-14-brainstand-roadmap.md) |
| Slice 0 plan (historical) | [`docs/superpowers/plans/2026-09-14-slice-0-cli-lane-proof.md`](docs/superpowers/plans/2026-09-14-slice-0-cli-lane-proof.md) |
| Slice 1 plan (historical) | [`docs/superpowers/plans/2026-09-14-slice-1-deploy-one-brain.md`](docs/superpowers/plans/2026-09-14-slice-1-deploy-one-brain.md) |
| Slice 3 plan (historical) | [`docs/superpowers/plans/2026-09-15-slice-3-scheduler.md`](docs/superpowers/plans/2026-09-15-slice-3-scheduler.md) — carries the execution corrections inline |
| Slice 3.5 plan (historical) | [`docs/superpowers/plans/2026-09-16-slice-3.5-deterministic-upgrades.md`](docs/superpowers/plans/2026-09-16-slice-3.5-deterministic-upgrades.md) — carries the execution corrections inline |
| Slice 0 risk register | [`docs/slice-0-findings.md`](docs/slice-0-findings.md) |
| Slice 2 scale probe | [`docs/slice-2-findings.md`](docs/slice-2-findings.md) |
| Slice 3 findings | [`docs/slice-3-findings.md`](docs/slice-3-findings.md) |
| Slice 3.5 findings | [`docs/slice-3.5-findings.md`](docs/slice-3.5-findings.md) — U1–U12, P1–P8, F1–F9, Gate C's measured numbers |
| Scheduler runbook | [`docs/runbooks/scheduler.md`](docs/runbooks/scheduler.md) |
| Upgrade runbook | [`docs/runbooks/upgrade.md`](docs/runbooks/upgrade.md) |
| Break-glass | [`docs/runbooks/break-glass.md`](docs/runbooks/break-glass.md) |
| Spec | `C:\Users\juanp\.claude\plans\we-want-to-do-snug-wolf.md` |
| gbrain pin | `v0.50.5.0` (exact, never a moving tag) |
| gbrain reference | `C:\Users\juanp\Desktop\gbrain` (read-only) |

---

## Process facts the next session needs

- **Agent spend limit.** Slice 3.5 was executed with two agents. The `claude` agent's monthly spend limit
  exhausted during Task 1's phase 2, and **every task after Task 1 phase 2 was executed by the `opencode`
  agent**. The plan's own text still assumes a single agent; treat the branch as mixed-authored, not as a
  single run.
- **Machine-level opencode config (not a repo change).** The coordinator added a `permission` block to
  `~/.config/opencode/opencode.jsonc` — `read`/`glob`/`grep`/`list`/`lsp` set to `allow`, plus
  `external_directory` allow — because the `opencode` agent otherwise stalls on approval prompts mid-task.
  This lives outside the repository, so a fresh VM or a different user needs it re-added before dispatching
  `opencode` workers. It is not committed here and is not a product change.
