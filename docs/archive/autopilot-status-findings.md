# `gbrain autopilot --status` — findings (2026-09-22)

Observed against the pinned gbrain **0.50.5.0** in the dev stack's `gbrain-ops`
(`gbrain --version`), plus the pinned source at
`~/.bun/install/cache/@GH@garrytan-gbrain-668b9ba@@@1/src/commands/autopilot.ts`.
Status: `confirmed` (upstream's claim held) | `falsified` | `changed`.

## Upstream claim vs. observed

| # | Upstream claim (docs/guides/cron-schedule.md) | Status | Evidence |
|---|---|---|---|
| A1 | `autopilot --status` exists | `confirmed` | exit 0, prose verdict; `autopilot status` subcommand form is equivalent (autopilot.ts:494, #1525) |
| A2 | `--json` is supported | `confirmed` | one-line AutopilotStatusReport: `installed, install_target, state, disabled_reason, paused_reason, heartbeat_age_seconds, stale_after_seconds, last_log` |
| A3 | exit 0 fresh/not installed, 1 needs attention, 2 took itself out of rotation | `confirmed`, with a caveat | `autopilotStatusExitCode` (autopilot.ts:2489). **Caveat:** 1 is also the unknown-flag exit and 2 the unknown-positional exit, and neither prints JSON — so the exit code alone is ambiguous |
| A4 | filesystem-only, works during a DB outage | `confirmed` | `runAutopilotStatus` is dispatched before `connectEngine` (autopilot.ts:2318-2324) |
| A5 | (implicit) a useful daily health gate | `changed` for Mobrain | Mobrain never installs autopilot, so the steady state is `not_installed`/exit 0 forever: a literal gate would never fire |
| A6 | (brief's question) source scope? | none | `--source` silently ignored; `--source <id>` is a usage error (exit 2) |

## Where it can see an install from

`detectInstalledTarget` checks a macOS plist, a systemd unit, `$GBRAIN_HOME/start-autopilot.sh`, and
`crontab -l`. The gbrain-ops container has no `crontab` binary and no systemd, so the only detectable target is
`ephemeral-container`, via the `gbrain-home` volume shared by gbrain-serve, gbrain-worker and gbrain-ops.
An install on the **host** crontab is invisible to this probe. That is a known blind spot, not a false pass.

## Decisions

1. **Tripwire, not health gate** (user decision, 2026-09-22). Healthy = `not_installed`. Any install, in any
   state and including `fresh`/exit 0, is a second scheduler on the brain.
2. **Verdict from the JSON, not the exit code.** It follows from A3's caveat and from `fresh` exiting 0.
3. **Classification `conflict`**: two schedulers, one brain, the same shape as a push conflict, and already in
   `run_classification_valid`. Unreadable output is `failed`, never `ok` (Slice 0 V6: a gate must not pass
   vacuously).
4. **Alert `autopilot_installed`, pinned, danger**: doubled work is as invisible in run history as stopped work.
5. **Brain-wide, admin Connection**: it reads the shared GBRAIN_HOME, which no Space fences. The console
   banner's "reads the whole brain" overstates the reach (it reads no brain content) but errs safe.
6. **`reportPolicy: on_change_or_failure`**: `changeCount` is 1 for an install, 0 for none, null for
   unreadable. A healthy day writes no report; a trip or an unreadable probe always does.
7. **okExitCodes `[0, 1, 2]`**: all three are verdicts. Only the status verb is allowlisted; the install verb
   stays lint-forbidden and is asserted refused at the RPC (contract A3b).
