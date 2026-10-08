# gbrain 0.60.104.0 contract findings

Measured 2026-10-08 against scratch project `brainstand-slice0-060`
(`mobrain/gbrain-base:0.60.104.0`, `gbrain 0.60.104.0`, Bun 1.4.2, Postgres 16.15).
No product code was edited. Every row is `MEASURED` or `FALSIFIED`. A `FALSIFIED`
row is not a code change. A `MEASURED` row names a file only when a later task
should edit that file; otherwise it says no product file.

Docker on this host needs `sudo -n`. The test script was not modified. Compose
exec below is:

```bash
sudo -n env GBRAIN_VERSION=0.60.104.0 COMPOSE_PROJECT_NAME=brainstand-slice0-060 \
  docker compose -f compose/docker-compose.slice0.yml exec -T gbrain-ops <argv>
```

The contract suite used the same pin and project, with `OPS_RPC_URL=http://127.0.0.1:1`.
The scratch project publishes no host port (`docker port brainstand-slice0-060-gbrain-ops-1`
empty) and its command is `sleep infinity`, so there is no ops RPC to point at.
`3140` is `mobrain-dev-gbrain-ops-1`. The suite was not pointed there. Tests that
hardcode `http://127.0.0.1:3140` threw `OPS_RPC_TOKEN is empty` before `fetch`
because this worktree has no `.env`. `mobrain-dev`, `mobrain-molior`, and project
`brainstand` were not compose-cycled.

Bring-up (cached image, containers left running):

```bash
sudo -n env GBRAIN_VERSION=0.60.104.0 COMPOSE_PROJECT_NAME=brainstand-slice0-060 \
  docker compose -f compose/docker-compose.slice0.yml up -d --wait --build
```

Exit 0. Postgres healthcheck status `healthy`.

## Contract suite

Command:

```bash
GBRAIN_VERSION=0.60.104.0 COMPOSE_PROJECT_NAME=brainstand-slice0-060 \
  OPS_RPC_URL=http://127.0.0.1:1 bun run test:contract
```

Exit 1. `121 pass`, `26 fail`, `1 error`, 147 tests, 18 files, 384.20s.
The suite's own `afterAll` ran `compose down -v` on `brainstand-slice0-060`.
The project was brought back with the same `up -d --wait --build` and left up.

### MEASURED contract breaks

| Verdict | Test | Assertion | File a later task may edit |
|---|---|---|---|
| MEASURED | `(b) the compiled starter surface hides list_skills and get_skill` | `expect(names).not.toContain('list_skills')` failed. Suite log: `starter tools/list count=35`, and the array contains `list_skills` and `get_skill`. | `test/contract/member-skills.contract.test.ts` |
| MEASURED | `(c) rescoped to full, the member lists and fetches skills` | `expect(JSON.stringify(got.result)).toContain('body')` failed. Received `skill_not_found` / `No authorized published skill matches this key.` for `get_skill` arguments `{ name: 'query' }`. Suite log also printed `full tools/list count=106` and `list_skills bytes=3025` before that expect. | `test/contract/member-skills.contract.test.ts` |
| MEASURED | `.well-known/gbrain exposes live profiles and harness adapters` | `expect(adapters.length).toBe(13)` received `14`. Follow-up, after init, `gbrain serve --http --bind 127.0.0.1 --port 3131` then `GET http://127.0.0.1:3131/.well-known/gbrain`: JSON fields `version=0.60.104.0`, `protocol=mcp`, `adapter_count=14`, names `claude-code`, `claude-desktop`, `codex`, `opencode`, `openclaw`, `grok-build`, `grok-bot`, `muse`, `muse-code`, `hermes`, `cursor`, `perplexity`, `chatgpt`, `generic`. | `test/contract/discovery.contract.test.ts` |
| MEASURED | `auth --dry-run is rejected pre-dispatch at this pinned version (upstream bug)` | `expect(r.stderr + r.stdout).toMatch(/unknown flag --dry-run for 'gbrain auth'/)` failed. Received `Error: Pass a grant field or --profile to rescope` and JSON `error.code=invalid_grant`. The preceding `expect(r.exitCode).not.toBe(0)` did not fail. Command argv: `gbrain auth rescope-client alice-example --dry-run --json`. | `test/contract/auth.contract.test.ts` |
| MEASURED | `sources remove/archive/rename with no argument exit 2 with usage` | Suite: `expect(r.exitCode).toBe(2)` received `1` on the first verb (`sources remove`). Follow-up after init: `gbrain sources remove` exit 1, stderr `Error [invalid_params]: An explicit valid source ID is required.`; `gbrain sources archive` exit 1, same code; `gbrain sources rename` exit 2, stderr `Usage: gbrain sources rename <id> <new-display-name>`. | `test/contract/schema.contract.test.ts` |
| MEASURED | `scheduler operations against the pinned container > sources push on a repo with no origin fails loudly, never silently` | Suite: `expect(body?.status).toBeTruthy()` received `undefined`. Exit was already not 0. Follow-up argv `gbrain sources push probe-no-origin --json` exit 1. Top-level keys: `error`, `code`, `message`, `suggestion`, `docs`, `detail`, `docs_cmd`, `class`, `retryable`, `contract_version`. Fields `status` and `reason` are absent. `code` is `writer_coordinator_required`. | `test/contract/scheduler.contract.test.ts` |
| MEASURED | `Slice 3.5 seam gate A > A7. the drain proof distinguishes a clean exit from a crash` | `expect(proof.decidingEvent?.event).toBe('shutting_down')` received `stopped`. Follow-up `gbrain jobs supervisor stop --json` exit 0, JSON field `reason` = `drained` (not `timeout` and not `timeout_40s`). Audit file `/srv/gbrain-home/.gbrain/audit/supervisor-2026-W41.jsonl` then contained `shutting_down` (`exit_code` 0, `reason` `SIGTERM`) followed by `stopped` (`exit_code` 0, `reason` `SIGTERM`). Do not retune grace periods from this row. | `test/contract/upgrade.contract.test.ts` |
| MEASURED | catalog absent at this pin | `Slice 3.5 seam gate A > A1` threw `ENOENT` opening `contracts/v0.60.104.0/operations.json`. The suite's `1 error` is the same pin: `test/contract/runner.contract.test.ts:276` `ENOENT` opening `contracts/v0.60.104.0/capability.json`. `A8 ... a real grant` failed at the same capability path after the grant expect had not yet failed. Follow-up `bun run src/ops/server.ts` with `GBRAIN_VERSION=0.60.104.0` and `OPS_RPC_PORT=13191` exit 1, same `ENOENT` on `operations.json`, and `/healthz` did not listen. That is why `A8 the ops verb: /fileplane/delete-credential-journal` threw `the ops server did not start`. Emit and capture; do not hand-edit the JSON. | `contracts/v0.60.104.0/operations.json`, `contracts/v0.60.104.0/capability.json` |

### FALSIFIED as pin breaks (no product file)

These failed in the suite. A later probe, or the assertion text itself, shows the
failure is not a 0.60 behavior change to implement.

| Verdict | Test | What established it |
|---|---|---|
| FALSIFIED | `the whole company-brain tutorial runs unattended and ends doctor-green` | Failed steps `sync:all (exit 1)`, `embed:stale (exit 1)`, `isolation:bob-example (exit 0)`, `isolation:carol-example (exit 0)`, `doctor (exit 1)`. Suite stderr: `Embedding model "openai:text-embedding-3-small" requires OPENAI_API_KEY.` This worktree has no `.env` and the container's `OPENAI_API_KEY` was unset. |
| FALSIFIED | `Gate A: compiler pairing, scoped search, revoke, audit, doctor` | Failed steps `sync:all (exit 1)`, `embed:stale (exit 1)`, `isolation:gate-a-reader (exit 0)`, `doctor (exit 1)`. Same `OPENAI_API_KEY` stderr. |
| FALSIFIED | `embed --stale --json exits cleanly with nothing stale` | `embed exited 1`. stderr: `Error [unavailable]: Embedding model "openai:text-embedding-3-small" requires OPENAI_API_KEY.` |
| FALSIFIED | `scheduler operations ... > embed --stale --source scopes to one source and exits clean` | Suite received exit 1 and did not print stderr. Follow-up `gbrain embed --stale --source probe-no-origin --json` exit 1, stderr the same `OPENAI_API_KEY` / `code=unavailable`. |
| FALSIFIED | `jobs supervisor starts detached and reports running` | Suite: `jobs supervisor status --json` exit 1 immediately after detach start (start exit was already 0). Isolated follow-up: `gbrain jobs supervisor start --detach --concurrency 2 --json` exit 0; immediate `gbrain jobs supervisor status --json` exit 0, JSON field `running` = `true`. Not a stable pin break. |
| FALSIFIED | `get_usage ... the operation exists in the pinned binary’s published tool surface` | Suite `JSON.parse` of `docker exec` stdout threw `Unexpected EOF` while compose was cycling the container. Follow-up `gbrain --tools-json` exit 0, JSON array length 160, includes `get_usage`. |
| FALSIFIED | `get_usage` totals, unpriced, and revoke tests | `fetch http://127.0.0.1:1/rpc` `ConnectionRefused`. Scratch project has no ops port. Not a tool-surface result. |
| FALSIFIED | `Slice 3 seam gate A` beforeAll | `sources list failed: couldn't find env file: .../.env`. No `.env` in this worktree. Did not exec into `mobrain-dev`. |
| FALSIFIED | `A2` and `A6` doctor/check-update via RPC; `A4` post-upgrade config read | `OPS_RPC_TOKEN is empty` or `couldn't find env file: .../.env`. Same missing `.env`. |
| FALSIFIED | `the in-flight-run query answers from the live control ledger` | `expect(r.exitCode).toBe(0)` received 1. Argv includes `docker compose --env-file .env`. `.env` is absent. |
| FALSIFIED | `the quiesce lane is derived from this host's compose model` | Threw `the live compose project could not be rendered` from the same `--env-file .env` argv. |
| FALSIFIED | `A10 verifyHarnessPin > the check reads the REAL binary at the pin` | `docker run --rm --entrypoint claude mobrain/agent-runner:2.1.274 --version` exit 125, stderr `pull access denied for mobrain/agent-runner`. Not the gbrain pin. |

## Probe rows

### apply-migrations help — MEASURED

Command: `gbrain apply-migrations --help`. Exit 0.

Help text contains `--no-autopilot-install` and these lines:

- `--yes` — `authorizes the Phase F autopilot install.`
- `--non-interactive` — `authorizes only the Phase F autopilot install.`
- `--no-autopilot-install` — `Skip the Phase F autopilot install (also GBRAIN_NO_AUTOPILOT_INSTALL=1).`

`printenv GBRAIN_NO_AUTOPILOT_INSTALL` in the scratch container printed `1`.
No new product file. Task 2 already passes the skip flag.

### apply-migrations --dry-run --json — MEASURED keys, FALSIFIED virgin exit 0

Virgin database (no `config` relation), command `gbrain apply-migrations --dry-run --json`:
exit **1**, not 0. stderr: `Error [migration_failed]: The v0.53.0 preview could not be computed: relation "persistence_brain" does not exist`.
Stdout parsed as one JSON object. Top-level keys: `status`, `installed`, `database`, `plan`, `previews`, `error`, `code`, `message`, `suggestion`, `docs`, `reason`, `fix`, `docs_cmd`, `class`, `retryable`, `contract_version`.
`status` = `preview_failed`. `database.status` = `unreachable`. `database.reason` = `relation "config" does not exist`.

After `gbrain init --non-interactive --force --embedding-model openai:text-embedding-3-small` (exit 0) on a reset schema, the same argv exited **0**. Top-level keys: `status`, `installed`, `database`, `plan`, `previews`.
`status` = `dry_run`. `database.schemaVer` = 215, `database.latest` = 215.
`plan` keys: `applied`, `partial`, `pending`, `pending_fresh_install`, `skippedFuture`, `wedged`.
`plan.pending` length 0. `plan.pending_fresh_install` = `0.11.0`, `0.14.0`, `0.22.4`, `0.28.0`, `0.53.0`.
`plan.applied` length 14.

No top-level key is named `migrations_applied` or `applied_count`. This finding does not name a journal field. Do not switch the schema-step executor to `--json` from this row.

### config get mcp.publish_skills — FALSIFIED

After the init above, `gbrain config get mcp.publish_skills` exit 0.
stdout bytes are `true\n`. stderr is `[config] source: file mirror (no DB row)\n`.
It does not print `***`. Do not add `--raw`. No product file.

### doctor schema_version on pg16 — FALSIFIED (not ok)

`postgres --version` in the scratch postgres container: `postgres (PostgreSQL) 16.15 (Debian 16.15-1.pgdg12+2)`.
After init, `gbrain doctor --json` exit 0. Top-level `status` = `warnings`. Top-level `schema_version` field = `2` (document version, not the check).
Check object: `{"name":"schema_version","status":"ok","message":"Version 215 (latest: 215)","category":"meta"}`.
`schema_version` is `ok` on pg16. Do not bump Postgres. No product file.

### schema list — FALSIFIED

`gbrain schema list` exit 0. stdout contains the line `Bundled packs:`.
Following lines: `gbrain-base`, `gbrain-recommended`, `gbrain-creator`, `gbrain-investor`, `gbrain-engineer`, `gbrain-everything`, `gbrain-base-v2`, `company-brain`.
Do not change `parseSchemaPacksProse`. No product file.
The suite test `schema list enumerates bundled packs` passed, same fact.

### schema active --source — MEASURED

`gbrain schema active --source` exit 0, stderr empty, no `unknown flag`.
After init, stdout is byte-identical to `gbrain schema active` and to `gbrain schema active --source customers` (266 bytes each). The `Source:` line is `home-config` in all three, which is the resolution tier already printed without the flag. The flag is accepted. It did not return a different pack for `customers`.
Do not change console copy. Do not set per-source packs. No product file.

### serve --http with a bad database URL — MEASURED

Command: `gbrain serve --http` with `GBRAIN_DATABASE_URL=postgres://gbrain:invalid@127.0.0.1:1/gbrain`.
`timeout 8` was not what ended it: the process exited by itself. Exit **1**.
stderr contains `Error [database_error]` and `ECONNREFUSED`. It does not contain `status-only`, `degraded`, or `listening`.
A follow-up `fetch http://127.0.0.1:3131/health` from inside the container returned status 0 (connection refused). The process did not stay up.

Health path, measured, not inferred from the serve result:

- `docker inspect` Healthcheck on `brainstand-slice0-060-gbrain-ops-1`: none.
- `docker inspect` Healthcheck on `brainstand-slice0-060-postgres-1`: `pg_isready -U gbrain -d gbrain`.
- Read-only inspect of `mobrain-dev-gbrain-serve-1`, `mobrain-dev-gbrain-ops-1`, and `mobrain-dev-control-plane-1`: Healthcheck none. `mobrain-dev-postgres-1`: `pg_isready` only.
- `compose/docker-compose.yml` and `compose/docker-compose.slice0.yml` each have one `healthcheck`, and it is that `pg_isready` test. Neither file healthchecks `gbrain-serve` or the ops sidecar.
- `opsHealthy()` fetches `OPS_RPC_URL` `/healthz`, not `gbrain-serve:3131`.

**status-only mode not on the Mobrain health path.** Do not add a serve health probe.

### --tools-json versus contracts/v0.50.5.0/capability.json — MEASURED

`gbrain --tools-json` exit 0. JSON type array, length **160**. First name `remember`. Includes `get_usage`.
`contracts/v0.50.5.0/capability.json` field `gbrainVersion` = `0.50.5.0`, `tools` length **136**.

Name delta: 24 added, 0 removed. Added: `assemble_evidence`, `cancel_write_request`, `delete_skill`, `edit_page`, `get_skill_asset`, `get_skill_policy`, `get_skill_retention`, `get_write_attribution`, `get_write_request`, `import_skill_proposal`, `join_brain`, `leave_brain`, `list_write_requests`, `mute_notice`, `prune_skill_revisions`, `put_pages`, `put_skill`, `rate_answer`, `retain_skill_revision`, `set_skill_policy`, `sources_inspect`, `sync_brain_skills`, `takes_remove`, `wanted_pages`.

Parameter-key delta on the 136 shared names: one removal, `migrate_embeddings` parameter `force_sunset_target`. `rg force_sunset_target skills` found no match. No skill file names a removed tool or that removed parameter. Capture the new catalog; do not hand-edit it; do not reformat skills from this row.

## What later tasks must not do

- Do not add `--raw` to `config get`. The probed key printed `true`.
- Do not change the `Bundled packs:` parser.
- Do not bump Postgres. `schema_version` is `ok` on pg16.
- Do not change console copy for `schema active --source`. The flag is accepted and did not show a per-source pack.
- Do not add a health probe for status-only `serve`. The process exited 1, and no compose healthcheck calls that port.
- Do not switch `apply-migrations` execution to `--json` from this file. No stable top-level "migrations applied" field was named.
- Do not retune supervisor grace periods. `stop --json` field `reason` was `drained`.
- Do not treat missing `.env`, missing `OPENAI_API_KEY`, or `OPS_RPC_URL=http://127.0.0.1:1` failures as pin breaks.
