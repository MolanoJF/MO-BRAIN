# Handoff — read this first

Written 2026-09-15. **Slice 0, Slice 1 and Slice 3 are complete on `main`.** **Slice 2 is complete on `slice-2-members-connections` (not yet merged).** Next is Slice 3.5.

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
| 2 — members + connections | **complete** on `slice-2-members-connections` (Gates A/B/C green; not yet merged) |
| 3 — scheduler, `gbrain_command` only | **complete** on `main` (Gates A/B/C green) |

Do **not** re-execute the Slice 0, Slice 1, Slice 2, or Slice 3 plan/gate work. Those are historical records.

### Live state on the dev stack (left by Slice 3 — expect it)

- **One ENABLED 5-minute `live-sync` schedule on the `shared` Space** is firing for real (created by Gate B, `report_policy: on_change_or_failure`). It writes `reports/live-sync/<stamp>.md` and commits as its Connection.
- Six `console-*` demo schedules are left **disabled** (their run rows are the console evidence).
- Two Gate C calendar fixtures (`gate-c-nightly` 02:30, `gate-c-ambiguous` 01:30, both `nightly-dream`) are **enabled but frozen until 2026-11-01**, then resume as real (paid) `dream` runs. Retire them before then.
- `organizations.timezone = America/New_York` (quiet hours still 23–08), plus one admin-role member and one revoked Connection on Space `shared`. Pausing everything is `docker compose stop scheduler` (see the runbook).

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
| Branch | `main` (Slice 3 complete; Slice 2 still unmerged on `slice-2-members-connections`) |
| Roadmap | [`docs/superpowers/plans/2026-09-14-brainstand-roadmap.md`](docs/superpowers/plans/2026-09-14-brainstand-roadmap.md) |
| Slice 0 plan (historical) | [`docs/superpowers/plans/2026-09-14-slice-0-cli-lane-proof.md`](docs/superpowers/plans/2026-09-14-slice-0-cli-lane-proof.md) |
| Slice 1 plan (historical) | [`docs/superpowers/plans/2026-09-14-slice-1-deploy-one-brain.md`](docs/superpowers/plans/2026-09-14-slice-1-deploy-one-brain.md) |
| Slice 3 plan (historical) | [`docs/superpowers/plans/2026-09-15-slice-3-scheduler.md`](docs/superpowers/plans/2026-09-15-slice-3-scheduler.md) — carries the execution corrections inline |
| Slice 0 risk register | [`docs/slice-0-findings.md`](docs/slice-0-findings.md) |
| Slice 2 scale probe | [`docs/slice-2-findings.md`](docs/slice-2-findings.md) |
| Slice 3 findings | [`docs/slice-3-findings.md`](docs/slice-3-findings.md) |
| Scheduler runbook | [`docs/runbooks/scheduler.md`](docs/runbooks/scheduler.md) |
| Break-glass | [`docs/runbooks/break-glass.md`](docs/runbooks/break-glass.md) |
| Spec | `C:\Users\juanp\.claude\plans\we-want-to-do-snug-wolf.md` |
| gbrain pin | `v0.50.0.0` (exact, never a moving tag) |
| gbrain reference | `C:\Users\juanp\Desktop\gbrain` (read-only) |
