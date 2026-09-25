# Handoff — read this first

**Mobrain 1.0.0 is the tagged release.** `main` has moved since that tag. Tip `578bbaa` (2026-09-23) is personal-and-company zones plus optional Google sign-in, on top of the console, schema, skills, and autopilot work that landed after the tag. Nothing since `v1.0.0` has been tagged or published. The published digests below are still the 1.0.0 artifacts.

**Next product slice:** hosted sandboxes, §5.4 of [`docs/superpowers/specs/2026-09-22-personal-and-company-zones-design.md`](docs/superpowers/specs/2026-09-22-personal-and-company-zones-design.md). It needs its own brainstorm before a plan. The open questions there are who pays for model calls, isolation on one host, web-terminal auth through Caddy, and whether today's shared runner stays for company jobs. Managed cloud (Slice 6) stays deferred; pricing still waits on a search-mode cost measurement on a real corpus.

[`PROGRESS.md`](docs/superpowers/plans/PROGRESS.md) and [`docs/pending-tasks.md`](docs/pending-tasks.md) still describe the 1.0.0 close. Where they say the next stage is Slice 6, this file wins.

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
  a registry namespace). Publishing is **tag/release-triggered**: the [`release` workflow](.github/workflows/release.yml)
  runs on a `v*` tag or a manual dispatch and is the only publisher — an ordinary push to `main` does not
  move the artifacts. The local `gh` OAuth token lacks `write:packages`, so CI owns every push — never
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
| `gbrain-base` | `0.50.5.0` | `ghcr.io/molanojf/gbrain-base@sha256:3a96e62b64e1a007a07d5bf42e0d778786c7af6fb762b8bf118626db102dead1` |
| `control-plane` | `1.0.0` | `ghcr.io/molanojf/control-plane@sha256:a327595c357026322cbe7021771db99ad6be04a0589c60d554433e9043dc33e9` |
| `agent-runner` | `2.1.274` | `ghcr.io/molanojf/agent-runner@sha256:1727ee16b9f5d97f567d75a6893fa63e30d1301a8c126b2332b06837aa9b016b` |

Source of record: the `publish` job of the [`release` workflow](.github/workflows/release.yml), written
into the [v1.0.0 GitHub Release](https://github.com/MolanoJF/mobrain/releases/tag/v1.0.0). Publishing is
tag/release-triggered — an ordinary push to `main` does not rebuild or move these artifacts. They are
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

## What landed on main after 1.0.0

Not a release. All of this is on `main` at `578bbaa` and is not in the published `1.0.0` images.

- Local-first install: no domain, LAN address, internal TLS.
- Console shell and design system, and editing a Space's markdown in the console.
- Schema-pack management and custom packs, including folder scaffolding from the pack.
- Private member Spaces, the autopilot tripwire, member agent skills over MCP, and Space git-bundle export.
- **Zones 5.1–5.3.** Spec: [`docs/superpowers/specs/2026-09-22-personal-and-company-zones-design.md`](docs/superpowers/specs/2026-09-22-personal-and-company-zones-design.md). Plans: [`zones-1-privacy`](docs/superpowers/plans/2026-09-22-zones-1-privacy.md), [`zones-2-personal-first`](docs/superpowers/plans/2026-09-22-zones-2-personal-first.md), [`zones-3-invite-login`](docs/superpowers/plans/2026-09-22-zones-3-invite-login.md).
- **Optional Google sign-in.** Plan: [`docs/superpowers/plans/2026-09-22-google-exclusive-auth.md`](docs/superpowers/plans/2026-09-22-google-exclusive-auth.md). Email and password stay. The button exists only when both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.

Zones behavior a caller can rely on:

- A fresh install is a personal brain on schema pack `gbrain-base-v2`. The wizard has no mode step and skips the schema step when that pack is already stored.
- Company mode is the owner's switch in Settings → General. Switching back to personal is allowed only while that owner is the only member and no invite is open.
- Company Space access is an explicit `space_grants` row. Personal mode refuses invites, shared sources, and grants with `403 { error: "company_mode_required" }`.
- An invite creates a placeholder account. The claim page is "Create your account" and sets a password only on that placeholder.
- Another person's personal Space, schedules, runs, alerts, connections, and sources are not listed. The admin Spend page still collapses that member's personal automations to one row.
- The Space picker groups My Brain and Company. A member chooses which granted company Spaces their agent reads from the My Brain settings tab.

**Not built:** hosted sandboxes (§5.4). Per-member budget caps were deferred with them.

---

## Live state on the dev stack (measured 2026-09-19)

**Historical.** These measurements are from 2026-09-19, before zones and optional Google. This handoff pass did not re-measure the dev stack.

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

### The console design system (branch `feat/console-shell-redesign`, HEAD `ffd64ca`; the branch is gone and `ffd64ca` is an ancestor of `main`)

- **The console has a design system now**, ported from qm's admin kit (`C:\Users\juanp\Desktop\qm\plugins\admin`,
  read-only). Tokens: `src/console/styles/tokens.css` — two tiers, and `@theme inline` (not `@theme`) is the
  whole mechanism; plain `@theme` bakes literals into utilities and is why the console could never theme.
  Primitives: `src/console/ui/classes.ts` (pure, tested) + `src/console/ui/index.tsx` (thin wrappers, 18
  components). Theme runtime: `src/console/theme.ts`, light/dark/system, plus a pre-paint script in
  `src/console/index.html`. The five composite classes (`.card`, `.field`, `.btn-primary`, `.nav-item`,
  `.border-warning`) are gone; `styles.css` names zero colours.
- **`/design-system` is the review surface** — every primitive, every tone, both themes, built from the real
  exported components. This repo has no DOM harness, so it is the only way to eyeball the system.
- **Verified in a browser** (dev stack, after `scripts/redeploy.sh`, via computed styles): the theme switch end
  to end including `localStorage.theme` persistence, `Button` secondary/primary against qm's spec, `Badge`,
  `th`/`td`, the control tokens, `--scrim` in both blocks, and `/design-system` in both themes.
- **Still unverified in a browser:** the settings-modal mechanics (Esc, drag-select released past the card edge,
  focus restore), the editor save / stale-save path, `ConfirmButton`'s controlled "Keep it" restoration, and the
  nine settings tabs in light mode. Each has unit coverage for its decision and none for its rendering.
- `test/unit/scheduler-main.test.ts` and `test/unit/seed-space.test.ts` fail here and are **environmental**:
  `brainstand-postgres-1` publishes no host port (Caddy is the only service that does), so host-side
  `localhost:5432` cannot connect by design. Neither touches the console.

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
| [`docs/superpowers/specs/2026-09-22-console-design-system-design.md`](docs/superpowers/specs/2026-09-22-console-design-system-design.md) | The console design system — tokens, primitives, theming, what is and is not verified |
| [`docs/slice-5-findings.md`](docs/slice-5-findings.md) | U1–U3, P1–P9, F20–F32 — every status and every deferral |
| [`docs/pending-tasks.md`](docs/pending-tasks.md) | The open backlog after 1.0.0, by owner slice and priority |
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
- Don't attempt a host-side `docker push` to GHCR; the local token lacks `write:packages`. CI publishes, and
  only the [`release` workflow](.github/workflows/release.yml) does (on a `v*` tag or a manual dispatch).
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
| Branch | `main` at `578bbaa`, tracking `origin/main`. Slices 0–5 are merged. The post-1.0.0 work in the section above is on this same branch. |
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

- **The next product slice is hosted sandboxes (zones spec §5.4).** It has no plan yet; brainstorm it before writing one. Slice 6 (managed cloud) stays deferred behind the search-mode cost measurement. `PROGRESS.md` still names Slice 6 as next; this file wins.
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
