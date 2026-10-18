# Collectors

A collector is a **page** the agent owns, in the source it writes to, plus a **run
history** Mo-brain keeps. Collectors run on the host, in the person's own harness, from a
timer: nothing server-side reaches a source.

## The collector page

Slug `system/collectors/<id>`, type `collector` (defined in `mobrain-core`), in the source
the collector writes to — `p-<slug>` for a personal space, `c-<slug>` for a company source.
The agent creates and edits it through gbrain's MCP, so a cadence change is a brain write
like any other. Spec §8.1 block:

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

`watermark` is the skill's own cursor: it moves only after a batch is fully written, and
never past an item that failed. Validation (shared by the API and the skill) rejects an
unknown `kind`, a cadence under 15 minutes, an empty `allowed_tools`, and a
`target_source` the person's agent client cannot write.

The page frontmatter is what the run reads. `mobrain collector add|set` is the same write
through `/api/collectors`, for when the agent is not driving MCP itself.

## Adding, changing, listing

```bash
bin/mobrain collector add --title "Work email" --kind email --cadence 2h \
  --tools 'mcp__claude_ai_Gmail__*' --notes "skip newsletters"      # prints the new slug
bin/mobrain collector add --title "Old brain" --kind notes-import --cadence once
bin/mobrain collector set system/collectors/<slug> --enabled false   # pause
bin/mobrain collector set system/collectors/<slug> --cadence 1d      # reschedule
bin/mobrain collector list                                           # the first personal source
bin/mobrain collector list --source c-company
```

`add` takes `--title`, `--kind`, `--cadence`, and optionally `--tools` (comma-separated),
`--model`, `--backfill-days`, `--source` and `--notes`. `set` changes only
`--enabled` and `--cadence`; to change the tools a collector may call, re-add it (same title; `add` overwrites the page) with
`collector add` and the same title.

Cadences: `<n>m` (with `n >= 15`), `<n>h`, `<n>d`, `daily@HH:MM` (local time, `TZ` from
`.env`), and `once` (runs until it has finished once).

## Running

```bash
bin/mobrain collect --due              # what the timer runs: every due collector
bin/mobrain collect system/collectors/<slug>              # one collector, incremental
bin/mobrain collect system/collectors/<slug> --backfill   # one collector, full window
```

A collector is **due** when it is enabled, its cadence has elapsed since its last finished
run (`daily@HH:MM` has passed today, or `once` has never run), and no `running` run is
newer than its timeout. `--due` first rotates the agent token if it expires within 14 days
(the same rotation is available as `bin/mobrain client rotate-if-expiring [--days n]`); if
the harness was not registered by `mobrain`, it warns and collects anyway. Then the due
collectors run **one at a time**, each with a lock in `~/.local/state/mobrain/locks/`; a
second run of the same slug prints `<slug>: already running here` and exits without
starting.

Each run wakes the harness headless with a prompt naming this skill and the collector:

> Use the mobrain-collect skill to run collector `<slug>` in source `<source>` (mode:
> incremental|backfill). Write through the `gbrain` (or `gbrain-company-<source>`) MCP
> server. Finish with the MOBRAIN_STATUS and MOBRAIN_SUMMARY lines the skill specifies.

Incremental runs get 20 minutes; a backfill gets at least 2 hours. The run's output is
recorded with `/api/runner/start` and `/api/runner/finish`, so a crash or a timeout is
visible in the UI as well.

## Logs and history

Each run writes a log to:

```
~/.local/state/mobrain/collect/<slug>/<UTC timestamp>.log
```

The newest 50 are kept per collector; older ones are deleted as new ones land. The last
4 KB of each log is stored with the run, and the UI's collectors view merges the page
(configured cadence, next due) with the last runs (status, summary, log tail).

## Timers

```bash
bin/mobrain timers install
bin/mobrain timers status
bin/mobrain timers remove
```

Where a systemd user manager is usable, `install` writes `mobrain-collect.timer`
(`OnCalendar=*:0/15`, `Persistent=true`) running `bin/mobrain collect --due`; on the stack
host it also writes `mobrain-backup.timer` at `03:30` running `bin/mobrain backup --prune`.
Otherwise it falls back to the person's crontab, with both lines tagged `# mobrain` and
their output in `~/.local/state/mobrain/cron.log`.

Either way the timer's environment matters: the systemd user manager's `PATH` does not
include `~/.local/bin`, and neither does cron's, so the units and crontab lines set `PATH`
to include `~/.local/bin` and the directory holding `claude`. If the harness is not on that
path, every run fails with exit 127. A member's machine gets the collector timer only; the
backup timer is written on the stack host.

Mo-brain's timer is the only scheduler here. Never run `gbrain autopilot --install`: it
writes its own crontab line, which in a container is a silent no-op or a duplicate
scheduler. The `autopilot` container runs gbrain's own maintenance as the spec §8.5 loop
(`gbrain sweep --once`, then `gbrain embed --stale`), not `gbrain autopilot`.

## Run statuses

| Status | Means | What to do |
|---|---|---|
| `ok` | the run finished a complete batch | nothing |
| `partial` | the per-run cap was reached (200 incremental, 500 backfill), or some items failed and stayed behind the watermark | nothing urgent; the next run continues. A persistent `partial` means the cadence is too slow for the volume |
| `error` | the harness exited non-zero, or never printed its closing lines | read the newest log; usually a tool missing from `allowed_tools` (re-add the collector with the same title) or a source the harness cannot reach |
| `timeout` | the harness was killed at the timeout (incremental 20 min, backfill 2 h; exit 124) | a backfill that times out is normal on a big source; a *scheduled* run that times out is not — narrow the source, or raise the cadence window |
| `running` | a run started and has not finished | if it is older than its timeout, `collect --due` starts the next one |

Statuses are the two closing lines the skill prints:

```
MOBRAIN_STATUS: ok|partial|error
MOBRAIN_SUMMARY: <one line: read N, created N, updated N, skipped N, errors N>
```

A run whose exit code is 0 but which prints no `MOBRAIN_STATUS` line is recorded as
`error`: the runner never infers success from a clean exit.

## Gateway tools and trust

A collector may call exactly what its `allowed_tools` lists, and nothing gates what that tool reaches. `Bash(executor *)` reaches every integration the executor holds (CRM, Notion, Drive and more), not only Gmail. The collector's notes tell the agent to stay on one integration; that is an instruction, not a boundary. Prefer a narrow tool (`mcp__claude_ai_Gmail__*`) when the harness has one, and accept the gateway pattern only on a machine and executor account you trust with that breadth.

The server name the headless run may write through defaults to `gbrain`; set `MOBRAIN_MCP_NAME` in `~/.config/mobrain/runner.env` to use another (a dev stack registered as `gbrain-dev`).
