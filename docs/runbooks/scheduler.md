# Scheduler: what runs, how to pause it, and what the alerts mean

Scheduling is a service, not a crontab and not a CLI. Every "why didn't my job
run last night" question ends in the console at `/schedules`.

Compose commands below use the form this repo uses locally, with the dev
override appended:

```bash
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml <verb>
```

On the VM drop `-f compose/docker-compose.dev.yml`. That override only
publishes host ports (Caddy on 8443/8080, `gbrain-ops` on 3140) and
deliberately has no `scheduler` entry — the scheduler has no HTTP surface.

## The service

`scheduler` runs `bun run /app/src/scheduler/main.ts` from the same image as
the control plane (`molanojf/control-plane:<BRAINSTAND_VERSION>`). It is
**strictly less privileged than the control plane**:

- `CONTROL_DATABASE_URL` (control DB), `OPS_RPC_URL=http://gbrain-ops:3140`,
  `OPS_RPC_TOKEN`, `PUBLIC_URL`, `SCHEDULER_TICK_MS` (default `15000`).
- No `GBRAIN_DATABASE_URL`, no `GBRAIN_HOME`, no `brain-repos` volume. It
  reaches gbrain only through the allowlisted ops RPC.

Two loops in one process:

- **leader** — one Postgres advisory lock (`scheduler:leader`, in the control
  database, held for the whole term on a reserved connection). The leader
  materializes due occurrences into `schedule_runs` and reclaims dead leases.
- **worker** — claims pending runs with `FOR UPDATE SKIP LOCKED` and executes
  them through the ops RPC; at most 4 runs per pass.

Replicas are safe: exactly one replica holds the lock and the rest are
workers. A SIGTERM drains the loop and exits; `stop_grace_period` is 20s.

## What is scheduled

Presets, from the catalogue the console offers:

| Preset | Cadence | Operation | Notes |
|---|---|---|---|
| `live-sync` | interval, 900s | `sync` | Imports new commits and embeds stale pages. Catch-up `skip`, overlap `skip`. |
| `nightly-dream` | daily 02:05 | `dream` | Makes model calls and costs money (`maxUsd` 10). Timeout 7200s. |
| `weekly-health` | Mondays 06:10 | `doctor --remediate` | Reads the WHOLE brain (`maxUsd` 5), so it needs an admin Connection. |
| `push-reconcile` | daily 04:15 | `sources push` | System preset. Installs only when the org has a Space with a git remote. |
| `morning-briefing` | daily 08:05 | none | System preset. Releases everything quiet hours held. Installs only when some schedule sets `notifies`. |
| `nightly-agent-briefing` | daily 03:05 | none — `agent_prompt` | Slice 4. The runner runs the pinned harness on this prompt; the run spends the org's API budget, capped at USD 2 per run, on `claude-haiku-4-5`. Needs a connected runner. |

Rules that bite:

- Calendar schedules are staggered onto one slot per 5 minutes (`:05`–`:50`).
  At most **one enabled sub-hourly interval schedule per org**; a second is
  refused with 409 rather than silently colliding.
- A schedule name is slug-shaped (`^[a-z0-9][a-z0-9-]{0,62}$`): it becomes
  `reports/<job-name>/` in the Space repo.
- Interval schedules are computed in UTC, so they fire every real N seconds
  across a DST change. Calendar schedules are wall-clock, with explicit
  gap/ambiguous policies (`shift`, `first`) rather than runtime defaults.

## Where to look

Console: `/schedules` — schedule list, run history, alerts, quiet hours. It is
the **only place to acknowledge an alert**.

Routes (all under `/api`, all authenticated):

- `GET /api/schedules`, `GET /api/schedules/:id`
- `POST /api/schedules`, `PATCH /api/schedules/:id`, `DELETE /api/schedules/:id`
- `GET /api/schedules/:id/runs` — history. `summary` is counts and status
  only; stdout and argv are never selected.
- `POST /api/schedules/:id/run-now` — 409 `schedule_disabled` when the
  schedule is off.
- `GET /api/schedule-presets`
- `GET /api/schedule-alerts`, `POST /api/schedule-alerts/:id/ack`
- `GET /api/org/schedule-settings`, `PATCH /api/org/schedule-settings` (admin)
  — timezone and quiet hours
- `GET /api/health` — carries `scheduleAlerts`, but **kinds only**, never
  `detail`: it is reachable without a session, and a `push_blocked` detail can
  name a path that matched a secret scan. Unacknowledged alerts, newest first,
  limit 20.

There is no CLI for the scheduler.

## Pause and resume safely

```bash
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml stop scheduler
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml ps scheduler
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml logs --tail 50 scheduler
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml start scheduler
```

`stop` sends SIGTERM, the loop drains and exits, and the leader lock goes with
the connection. **Nothing is lost.** Materialization resumes from each
schedule's watermark (`last_materialized_at`), and every missed slot is
recorded rather than erased.

On resume, each schedule's `catchup_policy` decides what actually runs:

- `skip` (default) — missed slots are written as `skipped_catchup` rows and
  never run.
- `run_latest` — the newest missed occurrence runs once.
- `run_all` — every missed occurrence runs, capped at 50 per tick.

Catch-up is bounded even so: the lookback is clamped to 7 days and one tick
materializes at most 2000 occurrences. A schedule more than
`misfire_grace_seconds` (default 120) past due is a misfire, which is the
condition the catch-up policy answers.

To pause one schedule instead of the service, disable it in the console (or
`PATCH /api/schedules/:id` with `{"enabled": false}`). Disabling by hand
records `disabledReason = "operator"`, and a disabled schedule occupies no
stagger slot. Re-enabling clears the reason.

Do **not** pause by revoking a Connection — that disables the schedules and
raises an alert for each one (see below).

## Run states and what they mean

| State | Meaning |
|---|---|
| `pending` | Materialized and waiting for a worker to claim it. |
| `running` | A worker holds the lease and the command is executing. |
| `succeeded` | The command finished clean (`ok`). |
| `failed` | Non-`ok` classification. The `classification` column says which: `failed`, `blocked`, `conflict`, `lock_lost`, `timeout`, `refused`. |
| `blocked` | gbrain refused the command; the alert on the page carries the reason. |
| `cancelled` | Cancelled on request or by overlap policy `kill_previous`. |
| `lease_expired` | The worker died mid-run, so the outcome is **unknown**. Reclaimed, alerted, never retried automatically. |
| `skipped_overlap` | Another run of the same schedule was in flight, or the schedule was disabled before this run could start (`classification = refused`). |
| `skipped_catchup` | Missed while the scheduler was down and recorded, not run. |
| `held` | The run succeeded, but quiet hours hold its notification. The report was still written. |

## "Why didn't my job run last night?"

In order:

1. **Is the schedule enabled?** `GET /api/schedules` — check `enabled` and
   `disabledReason`. `connection_revoked` means the Connection was revoked;
   `operator` means someone turned it off.
2. **Does the history have a row for that slot?** `GET /api/schedules/:id/runs`
   (console, same schedule card). A `skipped_catchup` row means the scheduler
   was down at that slot and the catch-up policy recorded it. A
   `skipped_overlap` row means another run of the same schedule was in flight,
   or the schedule was disabled before the run started. Both rows carry the
   reason the console renders.
3. **Was the scheduler even up?** `docker compose ... ps scheduler` and
   `logs --tail 50 scheduler`. A stopped container with no `skipped_*` rows
   means the scheduler was down for longer than the 7-day lookback clamp.
4. **Was it a `held` run?** Then it did run; only the notification waited.
   Compare `GET /api/org/schedule-settings` against the run's `finishedAt`.
5. **Did a lease expire?** A `lease_expired` run means the outcome is unknown
   and it was deliberately not retried. The next occurrence runs normally.
6. **Is it an overlap question?** Check the schedule's `overlapPolicy`. Under
   `skip` (default) an occurrence that collides with an in-flight run is
   recorded as `skipped_overlap` and never queued.
7. **Was it a stagger or lane refusal?** A refused create is a 409: `slot_taken`
   (with a `nextFree` slot to retry) when the 5-minute slot is occupied, or
   `sub_hourly_limit` when the org already has an enabled sub-hourly schedule.
   Either way the schedule never existed to run, and the refusal names the
   holder.

If you want the work done now: `POST /api/schedules/:id/run-now` — it 409s
with `schedule_disabled` if the schedule is off.

## Alerts: what each one means

| Kind | Meaning | What to do |
|---|---|---|
| `push_rejected` | `sources push` hit a non-fast-forward or the remote refused the update (`conflict`: exit 1 with `push_failed` or `pull_conflict`). | Resolve by hand — see the next section. |
| `push_blocked` | The push was refused before it left: secrets scan, tracked deny-glob, or an unverifiable remote (exit 5, `blocked`; `refused` for `refused_visibility`). | Remove or untrack the offending file, or fix the Space's remote, then let the next `push-reconcile` run. |
| `lease_expired` | A worker died mid-run; the run is reclaimed and not retried. | Read the run and decide whether to re-run manually. |
| `connection_revoked` | Every enabled schedule on that Connection was disabled. | Re-grant the Connection, then re-enable each schedule. |
| `overlap_queue_full` | A `queue`-policy schedule was at its cap (5 waiters) and the oldest waiter was dropped. | The schedule is running longer than its cadence allows. Raise the interval, or switch the policy. |
| `overlap_killed_previous` | A `kill_previous` run SIGTERMed the in-flight child through the ops cancel lane. | Expected for that policy. Investigate only if it repeats every occurrence. |
| `report_write_failed` | The run finished but its report did not get committed into the Space repo. | Check `gbrain-ops` reachability and the Space repo's status; the run row survives, the report does not. |
| `run_<classification>` | Any other non-`ok` outcome: `run_failed`, `run_timeout`, `run_lock_lost`, `run_refused`. | Read `GET /api/schedules/:id/runs` for the classification and exit code. |

A clean cancellation raises no alert. Acknowledge with
`POST /api/schedule-alerts/:id/ack` on the console. `GET /api/health` shows only
unacknowledged **kinds**, so use `/schedules` (or `GET /api/schedule-alerts`)
when you need the detail.

## Resolve a rejected push by hand

A rejected push is never swallowed and never retried inside the run: it
becomes a `push_rejected` alert so a human sees the divergence.

1. **Find the Space.** `GET /api/schedule-alerts` carries the detail
   (`classification`, `exitCode`, `status`); `scheduleId` leads to the
   schedule, and the schedule to its Connection's write Space. `/api/health`
   will not tell you this — it has kinds only.
2. **Inspect the repo.** Space repos live at `/srv/brain-repos/<source-id>` on
   the `brain-repos` volume, which only `gbrain-ops` and gbrain's own services
   mount:

   ```bash
   docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml exec gbrain-ops gbrain sources status --json
   docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml exec gbrain-ops sh -c 'cd /srv/brain-repos/<source-id> && git status --porcelain && git log --oneline -5'
   ```

   The console Health page renders the same read-only picture
   (`POST /git/inspect` on the ops lane returns `sourceId`, `staleLock`,
   `lockAgeSeconds`, `uncommittedFiles`, `unpushedCommits`, `branch`).
3. **Resolve the divergence.** In the Space repo, rebase the local commits
   onto the remote rather than discarding either side:

   ```bash
   docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml exec gbrain-ops sh -c 'cd /srv/brain-repos/<source-id> && git fetch origin && git pull --rebase'
   ```

   A confident `git push --force` is the wrong move: it destroys the commits
   that made this a non-fast-forward in the first place.
4. **Let the scheduler push.** The next `push-reconcile` occurrence (04:15 by
   default) scans, commits, pulls and pushes through gbrain-ops. To avoid
   waiting, `POST /api/schedules/:id/run-now` on that schedule.
5. **Acknowledge** the alert once the next push succeeds.

If the repo shows `staleLock: true` with `lockAgeSeconds` over 120, the writer
crashed rather than racing you — clear that `index.lock` explicitly and say so
in the incident notes.

## Reading a `lease_expired`

What you are looking at:

- the run row is `state = lease_expired`, `classification = failed`,
  `finishedAt` set, `leaseExpiresAt` null;
- an alert of kind `lease_expired` on that run, with `claimedBy` naming the
  dead worker.

The lease is the schedule's own timeout plus 60s of margin, so a slow run is
not stolen from a healthy worker. Reclamation happens on the next leader tick;
the run is marked, alerted, and **never retried automatically** — a
half-finished `dream` has already spent real money, and re-running it silently
is worse than leaving the next occurrence to do the work.

What to do:

1. Read the run (`GET /api/schedules/:id/runs`) and any report it managed to
   write before dying. On a `dream`, a missing report means the run's spend is
   not documented anywhere — treat the cost as unknown rather than zero.
2. Decide, as a human, whether the work needs `POST /api/schedules/:id/run-now`.
   Otherwise the next occurrence runs normally.
3. If several `lease_expired` rows appear at once, the scheduler container is
   being killed mid-run (OOM, a host restart shorter than the drain window, or
   the control database dropping out). Check `logs --tail 200 scheduler` and
   `ps scheduler` before assuming a single bad run.
4. Never "fix" it by lowering `timeoutSeconds` below the job's real duration;
   that converts a long run into a stream of `run_timeout` alerts.

## Revoking a Connection

`POST /api/connections/:id/revoke` (admin) is a security action, and the
scheduler obeys it immediately: every enabled schedule that runs as that
Connection is disabled with `disabledReason = 'connection_revoked'`, and each
one raises a `connection_revoked` alert.

The configuration is **not deleted**. Names, cadence, policies, quiet hours and
history all survive. Recovery is:

1. Re-grant the Connection so it is active again.
2. Re-enable each affected schedule in the console (or
   `PATCH /api/schedules/:id` with `{"enabled": true}`, which clears
   `disabledReason`).
3. Acknowledge the alerts.

In-flight work is not silently kept: a run whose schedule is disabled before
it is claimed is recorded as `skipped_overlap` with `classification = refused`
— nothing executes.

Revoking is not a pause button. To pause, disable the schedule.

## When two runs collide (overlap policy)

Overlap is decided at claim time, not when the occurrence is materialized,
because "is another run of this schedule in flight" is only knowable then.

- `skip` (default) — the new occurrence is recorded as `skipped_overlap`.
- `queue` — the occurrence waits, up to 5 waiters. Past the cap the oldest
  waiter is dropped as `skipped_overlap` and an `overlap_queue_full` alert
  names the cap and the count dropped.
- `kill_previous` — the in-flight child is SIGTERMed through the ops
  `/rpc/cancel` lane, and an `overlap_killed_previous` alert is raised. The
  cancelled run finishes as `cancelled`.

Choose deliberately. A `dream` under `queue` piles up spend behind a slow
model call; under `kill_previous` it never gets to finish.

## Quiet hours and `held`

Quiet hours are an org window in org-local time (`GET
/api/org/schedule-settings`; default 23:00–08:00, whole hours 0–23, changeable
by an admin with `PATCH /api/org/schedule-settings`).

They hold **notifications, never work**:

- Only a schedule with `notifies = true` is affected.
- The run executes, the report is written and committed, and the run is
  recorded as `held` — not `succeeded`.
- The held item is drained by `morning-briefing` (08:05 default), which
  releases everything unreleased into one report and stamps each row. The
  stamp is the idempotency: nothing is released twice.
- If the briefing refuses (for example its Connection is gone), the rows stay
  held and the next briefing picks them up.

So a `held` run is not a failure, and it is not green either. If a member
expected a notification overnight, compare their schedule's `notifies` flag
and the org quiet-hours window before touching anything.

## What NOT to do

- **Never run `gbrain autopilot --install`** in a container to "fix" a
  scheduling problem. It writes a crontab line, which in a container is a
  silent no-op or a duplicate-scheduler bug. It is exactly the crontab hack
  this service replaces, and `scripts/lint-forbidden.ts` fails the build on the
  literal text.
- **Never publish a host port for `scheduler`.** It has no HTTP surface and no
  entry in the dev override. It talks to postgres over `control-net` and to
  `gbrain-ops` over `ops-net`.
- **Never hand the scheduler brain credentials, `GBRAIN_HOME` or the
  `brain-repos` volume "just to debug".** It reaches gbrain only through the
  allowlisted ops RPC; widening it breaks the privilege boundary the whole
  stack rests on.
- **Never run the scheduler from the host.** Postgres publishes no host port
  and the container wiring (control DB URL, ops token) is not reproduced on
  the host.
- **Never pause everything by revoking a Connection** (unless the Connection
  really is compromised). Use `stop scheduler` or disable the schedule.
- **Never delete `schedule_runs` rows to clear an alert.** The
  `skipped_catchup` and `lease_expired` rows are the answer to "why didn't it
  run"; ack the alert instead.
- **Never force-push over a `push_rejected`.** Rebase, then let the scheduler
  push.

## After the incident

1. `GET /api/health` → `ok: true`, with an empty or fully understood
   `scheduleAlerts` list.
2. Console `/schedules`: every schedule you expect is enabled, and the next
   due occurrence shows a `pending` row shortly after its fire time (the
   leader ticks every 15s).
3. Acknowledge every alert you resolved, on the Schedules page — nothing else
   can, and `/api/health` will keep showing the kind until you do.
4. Note anything you changed by hand: quiet hours, a schedule you disabled,
   the Space repo you rebased.
