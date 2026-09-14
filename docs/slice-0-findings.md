# Slice 0 findings — gbrain v0.50.0.0 control lane

Every risk this slice priced today instead of in month three.
Status: `confirmed` (the spec's claim held) | `falsified` | `changed`.

## Verified constraints

| # | Claim | Status | Evidence | Consequence for Slice 1+ |
|---|---|---|---|---|
| V1 | Control surface is CLI-only, not in the op registry | | | |
| V2 | `--json` / `--dry-run` on the control lane | | | |
| V3 | `init --non-interactive` works headlessly on Postgres | | | |
| V4 | `search.mode` is post-init | | | |
| V5 | Supervisor drains on SIGTERM; stop within 40s | | | Quiesce budget for Slice 3.5 snapshots |
| V6 | `doctor` exits non-zero on blockers | | | The upgrade gate is real |
| V7 | `--token-ttl` bounded 60s–90d | | | Per-run tokens for Slice 4 |
| V8 | `mcp grant` needs brain DB or `--admin-token-file` | | | The S2 privilege boundary |
| V10 | 13 adapters, 4 connection classes, no Hermes | | | The Slice 2 harness picker |
| V11 | `config set *_api_key` avoids the DB plane | | | Where the Slice 1 wizard writes the key |
| V12 | `sources add <id> --path` | | | Space creation |
| V13 | `.well-known/gbrain` payload shape | | | Live-rendered UI |
| V14 | `--tools-json` catalog | | | The snapshot's data half |

## Commands with no `--json`

| Command | Why we need it | Workaround | Upstream contribution? |
|---|---|---|---|
| `init` | wizard progress | exit code + stderr | maybe |

## Commands that required a TTY or prompted

| Command | Observed | Workaround |
|---|---|---|

## Timing

| Step | Wall time | Note |
|---|---|---|
| `init` | | |
| `sync --all` | | |
| `embed --stale` | | |
| `doctor` | | |
| Whole tutorial | | vs ~90 minutes by hand |

## Decisions this changes

-
