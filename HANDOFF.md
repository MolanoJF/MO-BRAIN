# Handoff — read this first

**Mo-brain 1.0.0 is the tagged release.** `main` has moved since that tag. Nothing since `v1.0.0` has been tagged or published. Published digests are in [`CHANGELOG.md`](CHANGELOG.md).

**Next product slice:** hosted sandboxes (zones §5.4). Brainstorm before a plan. Open questions: who pays for model calls, isolation on one host, web-terminal auth through Caddy, and whether today's shared runner stays for company jobs. Managed cloud stays deferred. Pricing waits on a search-mode cost measurement on a real corpus. This file wins over any older note that names Slice 6 as next.

## What this project is

**Mo-brain** wraps [gbrain](https://github.com/garrytan/gbrain) into a product a team deploys with `scripts/install.sh` and operates from a web console. Human-facing name: **Mo-brain**. Technical ids: `mobrain` / `MOBRAIN_*`. (Earlier internal codename `brainstand` is fully retired — no live installs carried it forward.) HKDF domain separators are `mobrain-kek-v1` and `mobrain-gateway-token-*`; those bytes are frozen once secrets exist (D3).

**gbrain is a pinned upstream dependency, driven only through its published contracts. Never forked.** Its CLI is the control lane, its HTTP MCP is the data lane, and a small file plane covers what `config set` refuses. If you are editing gbrain's source or reading its tables directly, stop.

## Pins

| | |
|---|---|
| Source pin | gbrain `0.60.115.0` (exact). `scripts/install.sh` defaults to this and builds it locally when the pull misses. |
| Published GHCR `gbrain-base` | `0.50.5.0` until the next release |
| Harness | `@anthropic-ai/claude-code@2.1.274` |
| App release | `1.0.0` tagged; `main` is ahead and unpublished |
| Policy | [`docs/support-policy.md`](docs/support-policy.md) |

## What landed on main after 1.0.0

Not a release. Not in the published `1.0.0` images.

- Local-first install (no domain, LAN address, internal TLS) and Tailscale install mode.
- Console shell, design system, and Space markdown editing.
- Schema-pack management and custom packs.
- Private member Spaces, the autopilot tripwire, member agent skills over MCP, and Space git-bundle export.
- Zones 5.1–5.3: personal-and-company zones, privacy, personal-first, invite login.
- Optional Google sign-in when both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set. Email and password stay.

Zones a caller can rely on:

- A fresh install is a personal brain on schema pack `gbrain-base-v2`. The wizard has no mode step and skips the schema step when that pack is already stored.
- Company mode is the owner's switch in Settings → Admin. Switching back to personal is allowed only while that owner is the only member and no invite is open.
- Company Space access is an explicit `space_grants` row. Personal mode refuses invites, shared sources, and grants with `403 { error: "company_mode_required" }`.
- An invite creates a placeholder account. The claim page sets a password only on that placeholder.
- Another person's personal Space, schedules, runs, alerts, connections, and sources are not listed. Admin Spend collapses that member's personal automations to one row.
- The Space picker groups My Brain and Company. A member chooses which granted company Spaces their agent reads from the My Brain settings tab.

**Not built:** hosted sandboxes (§5.4). Per-member budget caps were deferred with them.

## Settled, do not re-argue

Managed cloud, when it is built: one VM per tenant, created through a cloud provider API, installed by running this release's `install.sh` over SSH. Rejected: a shared fleet with several compose projects per host, and Kubernetes. Nothing here builds a provisioner. Pricing is unsettled until search-mode cost is measured on a populated corpus.

## What not to do

- Don't fork gbrain, import past its `exports` map, read its tables directly, or screen-scrape human-readable CLI output.
- Don't run `gbrain autopilot --install` in a container — `lint:forbidden` catches it.
- Don't invoke `gbrain` through a shell string. Argv arrays only.
- Don't weaken a test or gate to make it pass.
- Don't mount the Docker socket into the control plane.
- Don't `git add .env`.
- Don't `docker push` to GHCR from a host. Only the release workflow publishes, on a `v*` tag or a manual dispatch.
- Never give `agent-runner` a database URL, `GBRAIN_HOME`, `OPS_RPC_TOKEN`, `ENCRYPTION_KEY`, or a provider key. Its credentials are `RUNNER_TOKEN` and the per-run gbrain token. It is a client of the control plane, never of the database.
- Never mount the Docker socket into anything that touches agent output, and never mount a volume into the runner (`volumes: []`). Never publish a host port on the runner. Caddy is the only service that publishes host ports.
- `runner-net` is `internal: true` with no default route. Never attach the runner to a second network, and never route `/api/runs/*` or `/api/gateway/*` through Caddy.
- Bash is not a job class this product implements. Never `--no-deps` the runner up. Never edit a schedule's harness version to make a claim succeed. Never read the agent's closing message as the run's status, or a `costUsd` of `null` as zero.
- Never revoke a Connection to pause agent runs, and never `docker compose down -v` to clean up a run. Revert is a new commit, not a wipe.

## Known gaps

- `POST /api/connections/:id/revoke` exists. `DELETE /api/connections/:id` does not, so a revoked Connection survives until the member is offboarded.
- A new contract file can still be answered by a sibling's process-global `mock.module`.
- The host-side spend read still reaches `src/control/opsClient.ts` directly rather than through an injected `OpsCaller`.
- `test/integration/agent-runs.test.ts` leaves one `capability_snapshots` row behind per run.
- Rotating the Anthropic key: [`docs/runbooks/agent-runner.md`](docs/runbooks/agent-runner.md). Re-provision after a destructive cycle, never before.

## How to run

Dev stack (`.env` with `DOMAIN=localhost`). The dev override is required for host-run suites: it publishes `gbrain-ops` on `3140`.

```bash
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml up -d --wait
```

Runner profile:

```bash
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml --profile runner up -d caddy-ca-export agent-runner
```

Clean-VM / production path is `scripts/install.sh`. Backup and restore are host operations (`scripts/backup.ts`, `scripts/restore.ts`). Procedures: [`docs/runbooks/`](docs/runbooks/).

CI budget: [`CLAUDE.md`](CLAUDE.md) and [`docs/runbooks/ci.md`](docs/runbooks/ci.md). Do not add `schedule:` triggers or new push/PR workflows.

## Where the docs live

| Document | What it is |
|---|---|
| [`README.md`](README.md) | Front door |
| [`docs/runbooks/`](docs/runbooks/) | Operator procedures |
| [`docs/support-policy.md`](docs/support-policy.md) | The supported pin, and what is not promised |
| [`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md) | Install traps for an agent doing the install |
| [`CHANGELOG.md`](CHANGELOG.md) | Release entries and published digests |
| [`docs/archive/`](docs/archive/) | Findings, plans, and probe logs. Do not read unless a comment cites a measurement or someone asks. |
