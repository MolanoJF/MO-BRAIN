# Slice 5 — Self-Host GA: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Read [HANDOFF.md](../../../HANDOFF.md) first.** Slices 0, 1, 2, 3, 3.5 and 4 are complete and merged on `main`; do not re-execute any of their plans.

**Goal:** Turn a stack that only its authors can install into a product a stranger can install on a clean VM, operate for a quarter, upgrade, back up, restore, and reason about the cost of — then cut a versioned release of it.

**Architecture:** No new subsystem. Slice 5 closes the distance between "every test is green on the authors' machine" and "a stranger's machine runs this." It does five things: (1) it closes the two hazards Slice 4 knowingly carried forward; (2) it makes the advertised one-command install real by publishing pinned image artifacts and proving the install on a host that has never seen this repository; (3) it replaces the product's remaining *declared* numbers with *measured* ones, and surfaces the spend our own meter cannot see; (4) it makes the drift tripwire reach a human; and (5) it renames, documents, licenses and releases.

**Tech Stack:** Bun 1.3.14, TypeScript, Hono, Drizzle + Postgres 16 (pgvector), React 19 + Vite + Tailwind 4, Docker Compose v2, Caddy 2, GitHub Actions. Upstream `gbrain` pinned at `v0.50.5.0`; harness pinned at `@anthropic-ai/claude-code@2.1.274`.

**Spec:** `C:\Users\juanp\.claude\plans\we-want-to-do-snug-wolf.md` · **Roadmap:** [`2026-09-14-brainstand-roadmap.md`](./2026-09-14-brainstand-roadmap.md) · **Progress:** [`PROGRESS.md`](./PROGRESS.md)

**Scope decision taken at this gate (2026-09-18, by the user):** Slice 5 is **self-host GA**. Managed cloud is **deferred to a later slice**, and **billing is not in this slice** — no Stripe, no pricing page, no signup flow. The substrate question the roadmap left open was nonetheless answered and is recorded here as D12 so the deferred slice does not re-litigate it: **one VM per tenant, provisioned through a cloud provider API, installed with this slice's own `install.sh` over SSH.** That decision is why Tasks 5, 6 and 7 matter more than they look — the cloud provisioner's only job will be to run the installer this slice makes real.

---

## Global Constraints

Copied verbatim from the spec and the roadmap. Every task's requirements implicitly include this section. A task that cannot be done without breaking one of these is a task to be re-planned, not a rule to be bent.

- **G1 — Never fork. Pin exact semver.** Images install `github:garrytan/gbrain#v0.50.5.0` via build `ARG GBRAIN_VERSION`. **Never the moving `latest-stable` tag.** The same rule binds the harness: `@anthropic-ai/claude-code@2.1.274`, exact, never a dist-tag or a range.
- **G2 — Drive gbrain only through its published contracts.** Three lanes and no fourth: the **CLI** (argv arrays, never shell strings), the **HTTP MCP** data lane, and a small **file plane** for what `config set` refuses. Never import past gbrain's `exports` map, never read its tables directly, never screen-scrape human-readable CLI output.
- **G3 — `C:\Users\juanp\Desktop\gbrain` is a read-only reference checkout.** Read it freely. Never edit it.
- **G4 — Contract tests per candidate version.** Every operation we depend on has a contract test that runs against the pinned version and against pinned-next.
- **S1 — `/admin` is never routed publicly.** gbrain's embedded admin SPA is a second control plane with god rights over the same brain. Break-glass instead.
- **S2 — The control plane holds no brain database credentials.** Everything privileged crosses the `gbrain-ops` RPC boundary. The Docker socket is never mounted into the control plane.
- **S3b — Secrets are envelope-encrypted** in one `secrets` table; a plaintext column would make a `pg_dump` a credential dump.
- **S3c — Never log a request body.** Not "add source", not a model request, not a grant credential.
- **Honesty rules (the project's own, inherited from Slices 3.5 and 4):**
  - **A cost we could not price is `null`, never `0`.**
  - **A number we did not measure is labelled as declared, or it is not shown.**
  - **A probe that could not run did not succeed.** Unknown is not green.
  - **A run we cannot show is not auditable.**
  - **Never weaken a test or a gate to make it pass.**
- **The runner lane's fences are unchanged and untouchable this slice:** no database URL, no `GBRAIN_HOME`, no `OPS_RPC_TOKEN`, no `ENCRYPTION_KEY`, no provider key in the runner; `volumes: []`, ever; no host port; `runner-net` stays `internal: true`; `/api/runs/*` and `/api/gateway/*` are never routed through Caddy. **Bash stays a job class this product does not implement.**
- **An agent runner is never a path to an upgrade.** Upgrades run only through the host `scripts/upgrade.ts` lane.
- **Don't `git add .env`.** It holds a real `OPENAI_API_KEY` plus `RUNNER_TOKEN`, `OPS_RPC_TOKEN`, `ENCRYPTION_KEY`, `BETTER_AUTH_SECRET` and the Postgres password.

---

## Context — why this slice exists

Slice 4 closed with all six verification commands green and a merged `main`. That is not the same claim as "ready for production," and the gap is specific rather than vague. This slice exists because of five findings, each measured rather than assumed while this plan was being written (2026-09-18, against the live dev stack at `830ca4c`):

**1. The advertised install has never been executed.** `scripts/install.sh` ends in `docker compose --env-file "$ENV_PATH" -f compose/docker-compose.yml up -d --wait`. In that file, `gbrain-ops` and `gbrain-worker` are `image: brainstand/gbrain-base:${GBRAIN_VERSION}` **with no `build:` stanza**, and `control-plane` is `image: brainstand/control-plane:${BRAINSTAND_VERSION:-dev}` — a tag that exists in exactly one place in the world, the authors' Docker daemon. Nothing publishes either image. Every installer test (`test/unit/install.test.sh:9,25,30`) sets `BRAINSTAND_SKIP_UP=1`, so the `up` leg has never run from the installer in any suite. **On a clean VM the install fails at image pull, after the installer has already generated and written `ENCRYPTION_KEY`.** This is the largest gap between the product and the claim, and Tasks 5–7 exist for it.

**2. Two hazards were carried forward by name.** HANDOFF.md states them: (a) `mock.module` containment — a sibling test file's process-wide mock of `src/control/opsClient.ts` can still answer a *new* file that needs the real client, and the cure is to route runtime ops access through an injectable caller, the shape `src/upgrade/quiesce.ts`'s `OpsCaller` already uses; (b) `scripts/backup.ts:104-108` sets `let quiesced = true`, probes `jobs.supervisorStatus` through a client whose default URL is the container name `http://gbrain-ops:3140` (`src/control/opsClient.ts:6`), and its `catch` turns the connection failure into `quiesced = true`. **On a production host no ops port is published (S2), so that probe always throws, and every production backup manifest claims a quiesce it never verified.** That is an honesty-rule violation shipped in the backup lane — the one lane whose whole value is that you can trust it later.

**3. The product's cost story ends where our meter ends.** The gateway meters the agent runner's model calls precisely, and `src/gateway/pricing.ts` is a pinned table with a `pricedAt` date — good. But `SEARCH_MODES` in `src/control/lifecycle.ts:30-49` ships `relativeCost: 1 / 6 / 25` and the console renders "costs roughly 25× the cheapest" (`src/console/pages/Wizard.tsx:45`) as if those were our numbers. **They are upstream's claim, never measured on this stack.** Separately, gbrain's *own* spend — embeddings, sync, search synthesis, chat — is invisible to our meter entirely, because those calls never traverse our gateway. Upstream publishes exactly the surface that fixes this: the MCP operation **`get_usage`** (`gbrain/src/core/ops/usage.ts`, scope `admin`), confirmed present in the pinned binary's own `--tools-json` on this stack, returning per-model and per-phase spend **plus a `coverage` block naming what the ledger does not capture.** Shipping a cost page without it is a lie by omission; shipping it without its coverage block is a subtler one.

**4. The drift tripwire does not reach a human.** `.github/workflows/contract.yml` already builds the pinned-next matrix arm (`0.51.0.0`) on a nightly cron and marks it `continue-on-error`. Nothing opens an issue, nothing notifies. A tripwire nobody hears is decoration, and it is the single mechanism that makes G1's never-fork bet survivable.

**5. The repository has no front door.** No `README.md`, no `LICENSE`, no `SECURITY.md`, no support-and-version policy. The product still carries the codename `brainstand`, which the roadmap's Open Question 3 says blocks any public artifact — and a GA release is the most public artifact there is.

None of these is a feature. All five are the difference between a build and a product.

---

## Prior-slice learnings folded in — do not rediscover these

- **The dev override is not optional on this machine.** `compose/docker-compose.dev.yml` publishes `gbrain-ops` on `3140:3140`, which every host-run suite reaches over `OPS_RPC_URL=http://127.0.0.1:3140`. A stack from the base file alone leaves `test/contract` and `test/e2e` failing on `ConnectionRefused`.
- **Run `test/integration` before `test/contract` / `test/e2e`, or re-up the dev stack in between.** `test/integration/quiesce.test.ts` resumes through the base compose file alone and recreates `gbrain-ops` without the dev override's port publication. Check `docker port brainstand-gbrain-ops-1` says `3140/tcp -> 0.0.0.0:3140` before every host-run suite.
- **`bash` on PATH is a broken WSL relay** (`C:\Windows\system32\bash.exe`). Both build gates must run through Git bash: `"C:/Program Files/Git/bin/bash.exe" test/build/pin.test.sh`. Export `GBRAIN_VERSION` / `HARNESS_VERSION` from `.env` first, or they fall back to their `0.50.0.0` / `2.1.274` defaults.
- **The stored `anthropic_api_key` is a rotating host secret.** It is the machine's Claude Code OAuth access token, so the CLI's next refresh revokes it and every model call answers `401 authentication_error` with nothing changed in this repository. `restore.e2e.test.ts`'s control-DB reload and the upgrade gate's rollback can restore a `secrets` generation predating a rotation. **Re-provision after a cycle, not before it.** Procedure: `docs/runbooks/agent-runner.md`, "Rotating the Anthropic key".
- **A restore or a quiesce leaves the runner DOWN by design** (Slice 4's D12/D13). Bring it back with the CA export first: `docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml --profile runner up -d caddy-ca-export agent-runner`.
- **`test/integration/agent-runs.test.ts` leaves one `capability_snapshots` row behind per run.** Known, carried, not this slice's to fix unless it starts colliding.
- **`bs-fp-pg` on `localhost:5432` is the scratch Postgres** host-run integration tests default to (`postgres://gbrain:ci-not-a-real-secret@localhost:5432/control`). It is defaulted inside the test files, not exported.

---

## Evidence requirements

Every task that claims a fact must produce the fact. This is not ceremony; three of the five findings above are cases where a declared value was carried for weeks because nobody printed the measured one.

1. **A `MEASURED` line per empirical claim.** Follow the existing convention in `test/contract/*.test.ts`: `console.log('MEASURED <what> at <version>: <values>')`. Gate output is evidence; a step that says "verify X" without printing X is not done.
2. **Verbatim command tails in `PROGRESS.md`.** Not summaries. The Slice 4 section is the model.
3. **A findings document, `docs/slice-5-findings.md`,** numbered in the established scheme: `U*` for upstream facts measured against the pinned version, `P*` for probe results, `F*` for defects this slice found and what happened to them.
4. **No claim of completion without the command that proves it.** `superpowers:verification-before-completion` applies to every task, not just the last.

---

## Design decisions locked before Task 1

### D1 — GA is proven by a stranger's machine, not by our test suite

The exit gate is not "the six commands are green" — they already are. It is **a clean host, with no copy of this repository and no Docker images, reaching a working console.** Task 7 builds that gate and runs it in CI on a fresh GitHub Actions runner, which is the closest thing to a stranger's machine that can be automated. Everything in Tasks 5 and 6 exists to make that gate passable honestly rather than by pre-seeding the runner with our images.

### D2 — Production compose pulls; it never builds

A `build:` stanza in a production compose file is a promise that the operator has the source tree, a toolchain, and twenty minutes. `compose/docker-compose.yml` keeps `image:` for every service and gains **no** build stanzas — the two it has (`control-plane`, `agent-runner`) move to `compose/docker-compose.build.yml`, which CI and the build gates use. Images are published to GHCR under exact, immutable tags, and the installer's job is to pull them. The one documented fallback — an air-gapped or registry-less host — is `docker compose -f compose/docker-compose.yml -f compose/docker-compose.build.yml build`, and it is a documented fallback, not the default path.

### D3 — The rename moves names humans read. It never moves a cryptographic domain-separation string.

Three strings are **frozen forever**, regardless of what the product is called:

| String | Where | What changing it does |
|---|---|---|
| `brainstand-kek-v1` | `src/control/secrets.ts:15` (HKDF info) | Every row in `secrets` becomes permanently undecryptable. Both provider keys are gone. There is no recovery. |
| `brainstand-gateway-token-salt` | `src/gateway/token.ts:29` (HKDF salt) | Every live gateway token stops verifying mid-run. |
| `brainstand-gateway-token-v1` | `src/gateway/token.ts:30` (HKDF info) | Same. |

These are not names; they are key-derivation domain separators, and their only job is to be stable. They get a comment saying so and a `lint:forbidden` rule that fails the build if anyone edits them. Everything else — image namespaces, the console title, the docs, the git identity in `src/ops/fileplane.ts:214-215`, the installer banner — moves.

### D4 — The compose project name is data, so it is a variable with a frozen default

`compose/docker-compose.yml:3` says `name: brainstand`, and Docker derives volume names from it: `src/upgrade/snapshot.ts:15` hardcodes `brainstand_brain-repos` and `brainstand_gbrain-home`. **Renaming the project orphans every existing deployment's data.** So the project name becomes `${COMPOSE_PROJECT_NAME:-brainstand}` with the legacy value as default, and `SNAPSHOT_VOLUMES` is derived from that variable instead of hardcoded. Existing deployments are untouched because the default is the old value. This also, for free, makes several stacks co-resident on one host — which the deferred cloud slice will want the day it stops wanting one VM per tenant.

### D5 — Runtime ops access goes through an injectable caller

`src/upgrade/quiesce.ts:188-206` already defines and consumes `OpsCaller` — a two-method interface with an HTTP implementation and a `compose exec` relay implementation — and its tests inject it. That shape is promoted to `src/control/opsCaller.ts` as the project's one way for a *host-side script* to reach ops, with both implementations exported and a `defaultOpsCaller()` that picks the relay when no ops port is reachable. Host-side scripts take a caller; they no longer reach for `callOps` directly. This is the cure for hazard (a): a file that receives its caller cannot be answered by a sibling's `mock.module`, because there is nothing module-level to mock.

**The in-container control plane keeps using `src/control/opsClient.ts` directly** — inside compose, `gbrain-ops:3140` resolves and the relay would be absurd. The change is scoped to the host-side scripts (`scripts/backup.ts`, `scripts/restore.ts`, `scripts/upgrade.ts`), which is exactly where the bug was.

### D6 — A probe that could not run did not succeed

`quiesced` in `BackupManifest` stops being `boolean` and becomes `'verified' | 'unverified' | 'failed'`. The `catch` that produced `true` produces `'unverified'`, and **a backup with `quiesced: 'unverified'` refuses to complete unless the operator passes `--allow-unquiesced`**, which stamps the manifest and prints why. With D5's relay caller in place the common case becomes `'verified'` on a production host for the first time; the refusal exists for the case where even the relay cannot speak, which is a stack in trouble and not a moment to write a confident manifest.

### D7 — A number we did not measure is labelled as declared, or it is not shown

`SEARCH_MODES[].relativeCost` gains siblings and the two are rendered differently. Task 9 runs an identical query workload against the live brain in each of the three modes, reads the spend for each window through `get_usage` (D8), and writes the measured ratio into `src/control/lifecycle.ts` with the date and corpus it was measured on. If a mode cannot be measured — the brain is too thin, the ledger empty, a mode errors on this corpus — the field stays `null` and the console says "not measured on this deployment" rather than printing upstream's 25×. **The wizard must never present a number as ours that we did not produce.**

### D8 — Our meter is not the whole bill, and the product says so

`get_usage` (upstream scope `admin`, 30-day default window, 365 max) is reached through the **HTTP MCP data lane** with a short-TTL admin-profile client minted ops-side via `mcp.grant` — never by reading `chat_usage_log` directly, which G2 forbids and which would break the moment upstream changes the table. Its `coverage` block is rendered **verbatim** in the console next to the totals. Upstream's own list of what it does not cover — failed chat calls, subagent raw-SDK calls, embeddings, and anything before migration v140 — is the honest frame for every number on the page, and we do not get to paraphrase it into optimism.

### D9 — Spend rolls up per org and per member, and names what it cannot attribute

The observability track's standing requirement is spend **per member and per org**, not per client — gbrain's `budget_usd_per_day` is per OAuth client and a member has several after Slice 2, so it does not aggregate on its own. `agent_runs` carries `organization_id` and `connection_id` but no member id; the member is reached by joining `connections` → `memberships`. A run whose `connection_id` is `NULL` (the Connection was deleted; `on delete set null`, deliberately, so the audit survives) rolls up under **`unattributed`**, shown as its own row and never silently folded into a member's total.

### D10 — The drift tripwire opens an issue, or it is not a tripwire

The nightly pinned-next arm gets a step that, on failure, opens — or updates, never duplicates — a GitHub issue titled `drift: gbrain <version> breaks the contract suite`, with the failing test names and the workflow run URL in the body. It uses `gh issue list --search` to find an open issue with the same title before creating one. The pinned-current arm stays blocking; the pinned-next arm stays `continue-on-error` — a drift finding is news, not a broken build.

### D11 — Live-stack debt is cleared through product paths, never through SQL

The dev stack carries a pending `awaiting_admin_decision` upgrade with 8 `pending` checklist items, two open alerts (`overlap_killed_previous`, `connection_revoked`), 10 gate-residue memberships and 3 revoked Connections. Clearing them with `UPDATE` statements would prove nothing and hide whether the product's own acknowledge paths work. **Task 14 clears each one by driving the product** — `POST /api/upgrades/checklist/:itemId/ack` for the eight items, `/schedules` for the two alerts, the members surface for the residue — and records any path that turns out not to exist as an `F` finding rather than reaching for the database.

### D12 — The deferred cloud slice's substrate is decided, and recorded here so it is not re-argued

**One VM per tenant**, created through a cloud provider API, installed by running **this slice's `install.sh` over SSH**, with the stack's own backup/restore and upgrade lanes operated per tenant. Rejected: a shared fleet with several compose projects per host (cheaper, but we would own port allocation, shared-Caddy routing, noisy-neighbour limits, and a blast radius spanning tenants), and Kubernetes (better fleet ergonomics, but it forks the deployment artifact — self-host stays compose while cloud becomes manifests, and every slice's compose-based gate stops covering the cloud path). **Nothing in this slice builds a provisioner.** The decision is recorded because Tasks 5, 6 and 7 are its foundation: a provisioner is a script that runs an installer, so the installer has to be real first.

### D13 — Nothing in this slice changes the runner's fences, the upgrade lane's semantics, or the contract registry's shape

Slice 5 hardens, measures, documents and releases. Where it adds a surface (`/api/spend`, an ops route for `get_usage`), that surface is additive, read-only, and admin-gated. If a task finds itself widening a fence, it is the wrong task.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `src/control/opsCaller.ts` | The injectable host-side ops caller (D5). Exports `OpsCaller`, `httpOpsCaller()`, `relayOpsCaller(compose)`, `defaultOpsCaller(compose)`. One responsibility: *how* a host-side process reaches ops. |
| `src/control/spend.ts` | Spend rollups (D9). Pure query functions over `agent_runs` / `agent_run_usage` / `connections` / `memberships`; no HTTP, no rendering. |
| `src/control/routes/spend.ts` | `GET /api/spend` — admin-gated; assembles our metered spend (D9) and gbrain's own ledger (D8) into one payload that states both coverages. |
| `src/ops/usage.ts` | The ops-side reach into the MCP data lane for `get_usage` (D8): mint a short-TTL admin client, call, revoke. Never touches `chat_usage_log`. |
| `src/console/pages/Spend.tsx` | The cost page. Totals, per-member, per-schedule, per-model, and both coverage statements verbatim. |
| `compose/docker-compose.build.yml` | The build stanzas D2 removes from the production file. CI and the build gates only. |
| `scripts/publish-images.sh` | Build and push the three images at their exact tags; print the digests. |
| `scripts/preflight.sh` | Installer preflight (Task 6): Docker/Compose version floors, RAM, disk, ports 80/443, DNS for `$DOMAIN`. Sourced by `install.sh`, runnable alone. |
| `test/e2e/install.e2e.test.ts` | Gate A of this slice: the clean-host install proof (D1). |
| `test/e2e/slice5.e2e.test.ts` | Gate C: the GA operator walk. |
| `test/contract/usage.contract.test.ts` | Gate B for D8: `get_usage` against the pinned version and pinned-next. |
| `test/unit/spend.test.ts` | Rollup arithmetic, including the `unattributed` bucket and the `null`-is-not-zero rule. |
| `test/unit/opsCaller.test.ts` | Caller selection and the relay's argv shape. |
| `test/unit/preflight.test.sh` | Preflight's refusals, each asserted by exit code. |
| `README.md`, `LICENSE`, `SECURITY.md`, `docs/support-policy.md` | The front door (Task 15). |
| `docs/runbooks/install.md`, `docs/runbooks/backup-restore.md` | The two runbooks GA needs and does not have. |
| `docs/slice-5-findings.md` | `U*` / `P*` / `F*`, per the evidence requirements. |
| `.github/workflows/nightly.yml` | The drift tripwire with teeth (D10). |

**Modified:**

| Path | Change |
|---|---|
| `scripts/backup.ts:8-16,96-158` | `quiesced` becomes three-state (D6); takes an injected `OpsCaller` (D5); refuses without `--allow-unquiesced` when unverified. |
| `scripts/restore.ts`, `scripts/upgrade.ts` | Take the injected caller; drop direct `callOps` reaches from host-side paths. |
| `src/upgrade/quiesce.ts:188-240` | `OpsCaller`, `httpOpsCaller`, `relayOpsCaller` move to `src/control/opsCaller.ts`; this file re-exports them. No behaviour change. |
| `src/upgrade/snapshot.ts:15-20` | Volume names derived from `COMPOSE_PROJECT_NAME` (D4). |
| `compose/docker-compose.yml:1,3,57,75,91-94,113,159,184-187` | `name:` becomes a variable; build stanzas move out; image namespace renamed. |
| `scripts/install.sh` | Preflight, pull path, new product name, registry variables. |
| `scripts/lint-forbidden.ts:7-57` | Two new rules: `frozen-crypto-domain` (D3) and `production-compose-build` (D2). |
| `src/control/lifecycle.ts:30-49` | `SEARCH_MODES` gains `measuredCost`, `measuredAt`, `measuredOn` (D7). |
| `src/console/pages/Wizard.tsx:42-52` | Renders measured vs declared differently (D7). |
| `src/console/App.tsx:111`, `src/console/index.html:6` | Product name. |
| `src/control/app.ts` | Mounts `/api/spend`. |
| `src/contracts/registry.ts` | **Nothing.** Listed so an executor does not wonder: `get_usage` is an MCP operation, not a CLI one, and does not belong in the argv registry (G2). |
| `.github/workflows/contract.yml` | Adds `tsc --noEmit`, the build gates and `test/integration`; hands the nightly matrix to `nightly.yml`. |
| `HANDOFF.md`, `PROGRESS.md`, roadmap | Closed out at Task 18. |

**Deliberately not created:** any provisioner, any Stripe integration, any pricing page, any signup flow, any Kubernetes manifest, any Prometheus/Grafana profile. The first four are the deferred cloud slice; the fifth is the observability track's optional profile and is not load-bearing for GA.

**Deliberately not built from the observability track, and why.** That track lists five things; this slice builds one. **Spend per member and per org is in** (Tasks 10–12) because the spec calls cost attribution a headline feature and because a product that cannot answer "who spent this" is one finance kills. **Alerting before the hard cap fires, queue-age p95, and `doctor --json` trended over time are out** — each needs a time series, the product has no metrics store, and adding one for GA would be a subsystem, not a slice. The existing hard cap already stops a run and alerts (Slice 4's C9), which is the load-bearing half. **The Prometheus/Grafana compose profile is out** for the same reason and because Task 8 is about to make `/metrics` less public, not more. All four go on the deferred slice's list, named here so a later reader knows they were decided rather than forgotten.

---

## Task index and interface map

| # | Task | Produces (the names later tasks use) |
|---|---|---|
| 1 | Injectable ops caller | `src/control/opsCaller.ts`: `OpsCaller`, `httpOpsCaller()`, `relayOpsCaller(compose)`, `defaultOpsCaller(compose)` |
| 2 | Backup quiesce honesty | `BackupManifest.quiesced: QuiesceState`, `runBackup(outDir, opts)` |
| 3 | Project name becomes a variable | `projectName()`, `snapshotVolumes()` in `src/upgrade/snapshot.ts` |
| 4 | Frozen-string guard, then the rename | `lint:forbidden` rules `frozen-crypto-domain`, `production-compose-build` |
| 5 | Publish the image artifacts | `scripts/publish-images.sh`, `compose/docker-compose.build.yml`, `IMAGE_REGISTRY` / `IMAGE_NAMESPACE` env contract |
| 6 | Installer preflight and pull path | `scripts/preflight.sh` exit codes 10–16 |
| 7 | **Gate A** — clean-host install proof | `test/e2e/install.e2e.test.ts` (A1–A8) |
| 8 | `/metrics` exposure audit | a finding, and a Caddyfile change if it is what it looks like |
| 9 | Measure the search-mode spread | `SEARCH_MODES[].measuredCost / measuredAt / measuredOn` |
| 10 | `get_usage` through the data lane | `src/ops/usage.ts`: `readBrainUsage(days)`; `test/contract/usage.contract.test.ts` |
| 11 | Spend rollups | `src/control/spend.ts`: `spendByMember`, `spendBySchedule`, `spendByModel`, `SpendReport` |
| 12 | The Spend page | `src/console/pages/Spend.tsx` |
| 13 | The drift tripwire | `.github/workflows/nightly.yml` |
| 14 | Clear the live-stack debt | a clean `/api/health`, and `F` findings for any path that does not exist |
| 15 | README, LICENSE, SECURITY, support policy | the front door |
| 16 | Backup/restore runbook and DR drill | `docs/runbooks/backup-restore.md` |
| 17 | **Gate C** — the GA operator walk | `test/e2e/slice5.e2e.test.ts` (C1–C10) |
| 18 | Release, findings, handoff | a tag, published digests, `docs/slice-5-findings.md` |

**Ordering constraints that matter:** Task 1 precedes 2. Task 3 precedes 4 (rename the variable before renaming around it) and precedes 5 (the image namespace and the project name move together). Tasks 5 and 6 precede 7. Task 10 precedes 9, 11 and 12 — the measurement in 9 reads its numbers through the surface 10 builds. Task 14 precedes 17, because the operator walk should start from a clean `/api/health`. Task 18 is last and depends on everything.

**Tasks 8, 13, 15 and 16 are independent of the rest** and of each other; if this plan is executed with `superpowers:dispatching-parallel-agents`, those four are the safe fan-out.

---

## The tasks

### Task 1 — The injectable ops caller

**Files:**
- Create: `src/control/opsCaller.ts`
- Create: `test/unit/opsCaller.test.ts`
- Modify: `src/upgrade/quiesce.ts:188-240` (move the three definitions out, re-export them)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export type OpsCaller = { auditTail(lines: number): Promise<string[]>; supervisorStatus(): Promise<{ running: boolean; workers: unknown[] } | null> }`; `export function httpOpsCaller(): OpsCaller`; `export function relayOpsCaller(compose: readonly string[]): OpsCaller`; `export async function defaultOpsCaller(compose: readonly string[]): Promise<OpsCaller>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/opsCaller.test.ts
import { describe, expect, test } from 'bun:test';
import { relayArgv, defaultOpsCaller, httpOpsCaller } from '../../src/control/opsCaller.ts';

const COMPOSE = ['docker', 'compose', '-f', 'compose/docker-compose.yml'] as const;

describe('relayArgv', () => {
  test('reaches ops through compose exec, never a host fetch', () => {
    const argv = relayArgv(COMPOSE);
    expect(argv.slice(0, 4)).toEqual([...COMPOSE]);
    expect(argv).toContain('exec');
    expect(argv).toContain('-T');
    expect(argv).toContain('gbrain-ops');
    // G2: argv array, never a shell string.
    expect(argv).not.toContain('-c');
    expect(argv.some((a) => a === 'sh' || a === 'bash')).toBe(false);
  });
});

describe('defaultOpsCaller', () => {
  test('falls back to the relay when no ops port answers', async () => {
    const caller = await defaultOpsCaller(COMPOSE, { probe: async () => false });
    expect(caller.kind).toBe('relay');
  });

  test('prefers HTTP when an ops port answers', async () => {
    const caller = await defaultOpsCaller(COMPOSE, { probe: async () => true });
    expect(caller.kind).toBe('http');
  });
});

describe('httpOpsCaller', () => {
  test('is tagged so a manifest can record which lane proved the quiesce', () => {
    expect(httpOpsCaller().kind).toBe('http');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test test/unit/opsCaller.test.ts`
Expected: FAIL — `Cannot find module '../../src/control/opsCaller.ts'`.

- [ ] **Step 3: Create `src/control/opsCaller.ts`**

Move the three definitions out of `src/upgrade/quiesce.ts:188-240` unchanged in behaviour, add a `kind` discriminant and the probe-driven selector.

```ts
/**
 * How a HOST-SIDE process reaches gbrain-ops.
 *
 * The control plane inside compose does NOT use this — it uses opsClient.ts
 * directly, because `gbrain-ops:3140` resolves in that network and a
 * `compose exec` relay from inside a container would be absurd. This module
 * exists for scripts/backup.ts, scripts/restore.ts and scripts/upgrade.ts,
 * which run on the host, where S2 means no ops port is published in
 * production and a bare fetch to OPS_RPC_URL cannot work.
 *
 * It is an INTERFACE that callers receive, not a module they import for its
 * side effects (Slice 4 hazard (a)): a file handed its caller cannot be
 * answered by a sibling test's process-wide `mock.module`.
 */
import { callOps } from './opsClient.ts';

export type OpsCaller = {
  readonly kind: 'http' | 'relay' | 'stub';
  auditTail(lines: number): Promise<string[]>;
  supervisorStatus(): Promise<{ running: boolean; workers: unknown[] } | null>;
};

/** The relay's argv, exported so a unit test can assert its shape without a daemon. */
export function relayArgv(compose: readonly string[]): string[] {
  return [...compose, 'exec', '-T', 'gbrain-ops', 'bun', '-e', RELAY_PROGRAM];
}

const RELAY_PROGRAM = `
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const req = JSON.parse(input);
  const base = process.env.OPS_RPC_URL ?? 'http://127.0.0.1:3140';
  const res = await fetch(base + req.path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.OPS_RPC_TOKEN },
    body: JSON.stringify(req.body),
  });
  process.stdout.write(await res.text());
`;

/** Moved verbatim from quiesce.ts:196-206 — `httpAuditTail` plus a
 *  `callOps('jobs.supervisorStatus', {}, { json: true, timeoutMs: 30_000 })`
 *  mapped to `{ running: !!json.running, workers: json.workers ?? [] }` —
 *  with `kind: 'http'` added. Works only where ops publishes a reachable
 *  port: the dev override, Gate A, and test/e2e. Never production (S2). */
export function httpOpsCaller(): OpsCaller { /* … */ }

/** Moved verbatim from quiesce.ts:214-240, with `kind: 'relay'` added and the
 *  inline program replaced by RELAY_PROGRAM above so `relayArgv` and the
 *  caller cannot drift apart. Production-safe: it reaches ops through
 *  `compose exec -T gbrain-ops bun -e`, the same relay scripts/restore.ts
 *  already uses, so it needs no published port. */
export function relayOpsCaller(compose: readonly string[]): OpsCaller { /* … */ }

export type SelectOptions = { probe?: () => Promise<boolean> };

/**
 * D6's other half: choosing the lane is a MEASUREMENT, not an assumption.
 * The probe is a 2s GET of ops' own /healthz over OPS_RPC_URL. It answers
 * "is there a published port here", which is true in dev and false in
 * production — and a caller that guesses wrong silently is exactly the bug
 * scripts/backup.ts shipped.
 */
export async function defaultOpsCaller(
  compose: readonly string[], opts: SelectOptions = {},
): Promise<OpsCaller> {
  const probe = opts.probe ?? (async () => {
    const url = process.env.OPS_RPC_URL ?? 'http://gbrain-ops:3140';
    try { return (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2_000) })).ok; }
    catch { return false; }
  });
  return (await probe()) ? httpOpsCaller() : relayOpsCaller(compose);
}
```

- [ ] **Step 4: Re-point `src/upgrade/quiesce.ts`**

Delete lines 188–240's definitions; add `export { type OpsCaller, httpOpsCaller, relayOpsCaller } from '../control/opsCaller.ts';` so the existing importers in `test/contract/upgrade.contract.test.ts:16` and `test/unit/quiesce.test.ts:2` keep working unchanged. Add `kind: 'stub'` to the two hand-rolled callers in those test files if TypeScript asks for it.

- [ ] **Step 5: Run the unit and quiesce suites**

Run: `bun test test/unit/opsCaller.test.ts test/unit/quiesce.test.ts`
Expected: PASS, both files, with the existing quiesce tests unchanged in count.

- [ ] **Step 6: Run `tsc` and the full unit suite**

Run: `bunx tsc --noEmit && bun test test/unit`
Expected: clean; `628 pass / 0 fail` plus this file's 4.

- [ ] **Step 7: Commit**

```bash
git add src/control/opsCaller.ts src/upgrade/quiesce.ts test/unit/opsCaller.test.ts
git commit -m "refactor(ops): host-side ops access is an injected caller, not a module import

Closes half of the mock.module hazard Slice 4 carried: a file handed its
caller cannot be answered by a sibling test's process-wide mock."
```

---

### Task 2 — The backup manifest stops claiming a quiesce it did not verify

**Files:**
- Modify: `scripts/backup.ts:6-16` (type), `:96-158` (`runBackup`)
- Modify: `test/integration/backup.test.ts`
- Test: `test/unit/backup-manifest.test.ts` (create)

**Interfaces:**
- Consumes: `OpsCaller`, `defaultOpsCaller` from Task 1.
- Produces: `export type QuiesceState = 'verified' | 'unverified' | 'failed'`; `BackupManifest.quiesced: QuiesceState`; `BackupManifest.quiesceLane: 'http' | 'relay' | null`; `runBackup(outDir: string, opts?: { ops?: OpsCaller; allowUnquiesced?: boolean }): Promise<BackupManifest>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/backup-manifest.test.ts
import { describe, expect, test } from 'bun:test';
import { classifyQuiesce } from '../../scripts/backup.ts';

const stub = (kind: 'http' | 'relay') => ({ kind } as const);

describe('classifyQuiesce', () => {
  test('a supervisor that is not running is a VERIFIED quiesce', () => {
    expect(classifyQuiesce({ running: false, workers: [] }, null, stub('relay')))
      .toEqual({ quiesced: 'verified', quiesceLane: 'relay' });
  });

  test('a supervisor still running is a FAILED quiesce, not a warning', () => {
    expect(classifyQuiesce({ running: true, workers: [{}] }, null, stub('relay')).quiesced)
      .toBe('failed');
  });

  // The bug, pinned by name: scripts/backup.ts:108 `catch { quiesced = true }`.
  test('a probe that threw is UNVERIFIED — never verified', () => {
    const err = new Error('fetch failed: getaddrinfo ENOTFOUND gbrain-ops');
    expect(classifyQuiesce(null, err, stub('http')))
      .toEqual({ quiesced: 'unverified', quiesceLane: null });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test test/unit/backup-manifest.test.ts`
Expected: FAIL — `classifyQuiesce is not exported`.

- [ ] **Step 3: Implement `classifyQuiesce` and rewire `runBackup`**

```ts
export type QuiesceState = 'verified' | 'unverified' | 'failed';

/**
 * Honesty rule: a probe that could not run did not succeed.
 *
 * The previous shape was `let quiesced = true` with `catch { quiesced = true }`
 * (scripts/backup.ts:104-108) reached through a client whose default URL is the
 * CONTAINER NAME `http://gbrain-ops:3140`. On a production host that name does
 * not resolve and no ops port is published (S2), so the probe ALWAYS threw and
 * every production manifest claimed a quiesce nobody checked.
 */
export function classifyQuiesce(
  status: { running: boolean; workers: unknown[] } | null,
  error: unknown,
  caller: { kind: 'http' | 'relay' | 'stub' },
): { quiesced: QuiesceState; quiesceLane: 'http' | 'relay' | null } {
  if (error !== null && error !== undefined) return { quiesced: 'unverified', quiesceLane: null };
  if (status === null) return { quiesced: 'unverified', quiesceLane: null };
  const lane = caller.kind === 'http' || caller.kind === 'relay' ? caller.kind : null;
  return { quiesced: status.running ? 'failed' : 'verified', quiesceLane: lane };
}
```

In `runBackup`, replace lines 104–108 with:

```ts
  const ops = opts.ops ?? (await defaultOpsCaller(COMPOSE));
  let status: { running: boolean; workers: unknown[] } | null = null;
  let probeError: unknown = null;
  try { status = await ops.supervisorStatus(); } catch (e) { probeError = e; }
  const { quiesced, quiesceLane } = classifyQuiesce(status, probeError, ops);

  if (quiesced === 'failed') {
    throw new Error(
      'Refusing to back up: the job supervisor is still running after `compose stop`. ' +
      'A dump taken now can disagree with the repos. Investigate before retrying.',
    );
  }
  if (quiesced === 'unverified' && !opts.allowUnquiesced) {
    throw new Error(
      'Refusing to back up: could not verify the stack is quiesced ' +
      `(lane=${ops.kind}${probeError ? `, error=${(probeError as Error).message}` : ''}). ` +
      'An unverified quiesce can produce a dump that disagrees with the repos. ' +
      'Re-run with --allow-unquiesced to take it anyway; the manifest will say so.',
    );
  }
```

and carry `quiesced` and `quiesceLane` into the manifest, extending the existing `warning` text with one sentence when `quiesced === 'unverified'`.

- [ ] **Step 4: Run the unit test**

Run: `bun test test/unit/backup-manifest.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Update the integration test to assert the new contract**

In `test/integration/backup.test.ts`, assert `manifest.quiesced === 'verified'` and `manifest.quiesceLane` is `'http'` or `'relay'` — **not** merely truthy. Add one case that injects a throwing caller and expects `runBackup` to reject, and one that passes `allowUnquiesced: true` and expects `quiesced: 'unverified'` in the written manifest. Note in a comment that this file runs the real script in its own process (the cross-process stack-exclusion lock in `test/helpers/stack.ts`), which is why it can now inject a caller instead of mocking a module.

- [ ] **Step 6: Run the integration suite**

Run: `bun test test/integration/backup.test.ts`
Expected: PASS. Print the manifest's `quiesced` and `quiesceLane` with a `MEASURED` line.

- [ ] **Step 7: Prove the production lane by hand, and record it**

Bring the stack up from the **base file only** (no dev override, so no published ops port — this is the production shape):

```bash
docker compose --env-file .env -f compose/docker-compose.yml up -d --wait
OPS_RPC_URL=http://gbrain-ops:3140 bun run scripts/backup.ts /tmp/bs-backup-probe
cat /tmp/bs-backup-probe/manifest.json | grep -E 'quiesced|quiesceLane'
```

Expected: `"quiesced": "verified"`, `"quiesceLane": "relay"`. **Record the output as `P1` in `docs/slice-5-findings.md`** — this is the first time the backup lane has ever verified a quiesce on a production-shaped stack. Then re-up with the dev override.

- [ ] **Step 8: Commit**

```bash
git add scripts/backup.ts test/unit/backup-manifest.test.ts test/integration/backup.test.ts docs/slice-5-findings.md
git commit -m "fix(backup): an unverifiable quiesce is unverified, never true

scripts/backup.ts:108 turned a connection failure into quiesced:true, and on
a production host the probe always failed — so every production manifest
claimed a quiesce nobody checked. Closes the second hazard Slice 4 carried."
```

---

### Task 3 — The compose project name becomes a variable with a frozen default

**Files:**
- Modify: `src/upgrade/snapshot.ts:15-20`
- Modify: `compose/docker-compose.yml:3`
- Modify: `compose/docker-compose.slice0.yml:3`
- Test: `test/unit/snapshot.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function projectName(): string`; `export function snapshotVolumes(): readonly string[]`; `export function volumeLabel(volume: string): string`. `SNAPSHOT_VOLUMES` is **removed** — every caller moves to `snapshotVolumes()`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/snapshot.test.ts`:

```ts
describe('projectName / snapshotVolumes (D4)', () => {
  test('defaults to the legacy project name so existing deployments keep their volumes', () => {
    delete process.env.COMPOSE_PROJECT_NAME;
    expect(projectName()).toBe('brainstand');
    expect(snapshotVolumes()).toEqual(['brainstand_brain-repos', 'brainstand_gbrain-home']);
  });

  test('follows COMPOSE_PROJECT_NAME when the operator sets one', () => {
    process.env.COMPOSE_PROJECT_NAME = 'acme-brain';
    expect(snapshotVolumes()).toEqual(['acme-brain_brain-repos', 'acme-brain_gbrain-home']);
    delete process.env.COMPOSE_PROJECT_NAME;
  });

  test('the label a snapshot is filed under is project-independent', () => {
    process.env.COMPOSE_PROJECT_NAME = 'acme-brain';
    expect(volumeLabel('acme-brain_brain-repos')).toBe('brain-repos');
    delete process.env.COMPOSE_PROJECT_NAME;
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test test/unit/snapshot.test.ts`
Expected: FAIL — `projectName is not exported`.

- [ ] **Step 3: Implement**

```ts
/**
 * D4 — the compose project name is DATA, not branding.
 *
 * Docker derives volume names from it (`<project>_<volume>`), so changing it
 * orphans an existing deployment's data. The default is therefore FROZEN at
 * the legacy value forever, whatever the product ends up being called, and the
 * variable exists so that (a) the rename in Task 4 cannot silently strand
 * anyone's brain, and (b) two stacks can be co-resident on one host.
 */
export const LEGACY_PROJECT_NAME = 'brainstand';

export function projectName(): string {
  const raw = process.env.COMPOSE_PROJECT_NAME?.trim();
  return raw && raw.length > 0 ? raw : LEGACY_PROJECT_NAME;
}

const VOLUME_SUFFIXES = ['brain-repos', 'gbrain-home'] as const;

export function snapshotVolumes(): readonly string[] {
  return VOLUME_SUFFIXES.map((s) => `${projectName()}_${s}`);
}

export function volumeLabel(volume: string): string {
  const prefix = `${projectName()}_`;
  return volume.startsWith(prefix) ? volume.slice(prefix.length) : volume;
}
```

- [ ] **Step 4: Move every `SNAPSHOT_VOLUMES` caller**

Run `grep -rn "SNAPSHOT_VOLUMES" --include=*.ts src scripts test` and convert each to `snapshotVolumes()`. The compose files get `name: ${COMPOSE_PROJECT_NAME:-brainstand}`.

- [ ] **Step 5: Run the affected suites**

Run: `bun test test/unit && bunx tsc --noEmit`
Expected: clean, and `grep -rn "SNAPSHOT_VOLUMES" src scripts test` returns nothing.

- [ ] **Step 6: Prove the default really is inert on the live stack**

Run: `docker volume ls | grep -E 'brain-repos|gbrain-home'`
Expected: `brainstand_brain-repos` and `brainstand_gbrain-home`, unchanged. Record as `P2`.

- [ ] **Step 7: Commit**

```bash
git add src/upgrade/snapshot.ts compose/docker-compose.yml compose/docker-compose.slice0.yml test/unit/snapshot.test.ts
git commit -m "refactor(compose): project name is a variable with a frozen legacy default

Volume names derive from it, so renaming the product must not rename the
project. Also makes two stacks co-resident on one host."
```

---

### Task 4 — Freeze the crypto strings, then rename

**Files:**
- Modify: `scripts/lint-forbidden.ts:7-57`
- Modify: `src/control/secrets.ts:15`, `src/gateway/token.ts:29-30` (comments only)
- Modify: the human-facing surfaces listed below
- Test: `test/unit/lint-forbidden.test.ts`

**Interfaces:**
- Consumes: `projectName()` from Task 3.
- Produces: `lint:forbidden` rules `frozen-crypto-domain` and `production-compose-build`; the product name as one constant, `PRODUCT_NAME`, in `src/control/lifecycle.ts`.

**Before starting:** the product name is Open Question 3 and is **the user's to decide**, not the executor's. If no name has been given, stop and ask; do not invent one. Everything else in this task is independent of which name is chosen, so build the guard rails first and let the name land into them.

- [ ] **Step 1: Write the failing lint test**

```ts
// test/unit/lint-forbidden.test.ts — append
describe('frozen-crypto-domain (D3)', () => {
  test('flags any edit to the KEK domain separator', () => {
    const v = scanText('src/control/secrets.ts',
      `Buffer.from('acmebrain-kek-v1', 'utf8')`);
    expect(v.map((x) => x.rule)).toContain('frozen-crypto-domain');
  });

  test('flags any edit to the gateway token salt or info', () => {
    expect(scanText('src/gateway/token.ts', `Buffer.from('acmebrain-gateway-token-salt')`)
      .map((x) => x.rule)).toContain('frozen-crypto-domain');
    expect(scanText('src/gateway/token.ts', `Buffer.from('acmebrain-gateway-token-v1')`)
      .map((x) => x.rule)).toContain('frozen-crypto-domain');
  });

  test('leaves the frozen values themselves alone', () => {
    expect(scanText('src/control/secrets.ts', `Buffer.from('brainstand-kek-v1')`)).toEqual([]);
  });
});

describe('production-compose-build (D2)', () => {
  test('flags a build stanza in the production compose file', () => {
    const v = scanText('compose/docker-compose.yml', '    build:\n      context: ..');
    expect(v.map((x) => x.rule)).toContain('production-compose-build');
  });

  test('allows one in the build overlay', () => {
    expect(scanText('compose/docker-compose.build.yml', '    build:\n      context: ..')).toEqual([]);
  });
});
```

This needs `scanText(path, text)` exported from `scripts/lint-forbidden.ts` — the per-file scanning half of the existing walker, split out so it is testable without a filesystem. Do that split as part of Step 3.

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test test/unit/lint-forbidden.test.ts`
Expected: FAIL — `scanText is not exported`.

- [ ] **Step 3: Add the rules**

```ts
  {
    rule: 'frozen-crypto-domain',
    // D3: these three strings are HKDF domain separators, not names. Changing
    // 'brainstand-kek-v1' makes every row in `secrets` permanently
    // undecryptable — both provider keys, with no recovery. Changing either
    // gateway-token string breaks every live token mid-run. They are frozen
    // forever, including through the product rename.
    re: /Buffer\.from\(\s*['"`](?!brainstand-(?:kek-v1|gateway-token-salt|gateway-token-v1)['"`])[\w-]*-(?:kek|gateway-token)-(?:v\d+|salt)['"`]/,
    why: 'D3: HKDF domain separators are frozen forever; renaming one destroys every stored secret or every live token',
  },
  {
    rule: 'production-compose-build',
    re: /^\s{2,}build:\s*$/m,
    why: 'D2: the production compose file pulls published images; build stanzas live in docker-compose.build.yml',
    only: /compose\/docker-compose\.yml$/,
  },
```

`only` is a new optional field on the rule shape: a path regex a rule is restricted to. Rules without it apply everywhere, exactly as today.

- [ ] **Step 4: Add the freeze comments at the three sites**

At `src/control/secrets.ts:15` and `src/gateway/token.ts:29-30`, above each literal:

```ts
// FROZEN FOREVER (D3). This is an HKDF domain separator, not a product name.
// Changing it makes every existing sealed secret permanently undecryptable.
// `lint:forbidden`'s frozen-crypto-domain rule fails the build if you try.
```

- [ ] **Step 5: Run the lint and its test**

Run: `bun test test/unit/lint-forbidden.test.ts && bun run lint:forbidden`
Expected: the tests pass; `lint:forbidden clean`.

- [ ] **Step 6: Commit the guard rails before the rename**

```bash
git add scripts/lint-forbidden.ts src/control/secrets.ts src/gateway/token.ts test/unit/lint-forbidden.test.ts
git commit -m "feat(lint): freeze the three HKDF domain separators before the rename"
```

- [ ] **Step 7: Do the rename, in this order**

With `<NAME>` the user's chosen product name and `<ns>` its lowercase image namespace:

1. `src/control/lifecycle.ts` — add `export const PRODUCT_NAME = '<NAME>';`
2. `src/console/App.tsx:111`, `src/console/index.html:6` — render `PRODUCT_NAME`, not a literal.
3. `docker/*.Dockerfile`, `compose/*.yml`, `.github/workflows/*.yml`, `test/build/pin.test.sh:12,21`, `test/build/harness-pin.test.sh:20,30` — image namespace `brainstand/` → `<ns>/`, moved through the `IMAGE_NAMESPACE` variable Task 5 introduces rather than hardcoded a second time.
4. `src/ops/fileplane.ts:214-215`, `scripts/tutorial.ts:171`, `scripts/connection-e2e.ts:278`, `scripts/scale-probe.ts:242-243` — the git identity.
5. `scripts/install.sh`, `.env.example`, `docs/**`, `HANDOFF.md`, `README.md` — prose. `BRAINSTAND_*` environment variables keep their names for one release and gain `<NAME>_*` aliases; **`.env` files in the wild already contain the old names.**
6. **Do not touch:** `COMPOSE_PROJECT_NAME`'s default (Task 3), the three frozen strings (Step 3), or `.brainstand-tmp/` in `.gitignore` and `scripts/lint-forbidden.ts:67` — a scratch directory name is not a public artifact and renaming it strands nobody's tree.

- [ ] **Step 8: Verify the rename did not touch what it must not**

```bash
grep -rn "brainstand-kek-v1\|brainstand-gateway-token" src/control/secrets.ts src/gateway/token.ts
grep -n "name:" compose/docker-compose.yml
bun run lint:forbidden && bunx tsc --noEmit && bun test test/unit
```

Expected: all three frozen strings still present and unchanged; `name: ${COMPOSE_PROJECT_NAME:-brainstand}`; lint clean; tsc clean; unit green.

- [ ] **Step 9: Prove the live stack still decrypts its secrets**

Run: `curl -sk https://localhost:8443/api/health | grep -o '"components":[^}]*}'`
Expected: `controlDb":"ok"` and `ops":"ok"`. Then confirm both secret rows are still readable **by name and length only, never by value** — the existing helper in `test/integration/secrets.test.ts` does this. Record as `P3`.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: rename <NAME>, leaving the crypto domain separators and the compose project name frozen"
```

---

### Task 5 — Publish the image artifacts

**Files:**
- Create: `compose/docker-compose.build.yml`
- Create: `scripts/publish-images.sh`
- Modify: `compose/docker-compose.yml` (remove both build stanzas; parameterise the registry)
- Modify: `.github/workflows/contract.yml` (build through the overlay)
- Test: `test/unit/publish-images.test.sh` (create)

**Interfaces:**
- Consumes: `projectName()` (Task 3), `IMAGE_NAMESPACE` (Task 4).
- Produces: the env contract `IMAGE_REGISTRY` (default `ghcr.io`), `IMAGE_NAMESPACE` (default the renamed org), and three image references: `${IMAGE_REGISTRY}/${IMAGE_NAMESPACE}/gbrain-base:${GBRAIN_VERSION}`, `.../control-plane:${APP_VERSION}`, `.../agent-runner:${HARNESS_VERSION}`.

- [ ] **Step 1: Write the failing test**

```bash
# test/unit/publish-images.test.sh
set -euo pipefail
fail() { echo "FAIL: $1" >&2; exit 1; }

# The production compose file must not be able to build anything.
grep -qE '^\s+build:' compose/docker-compose.yml && fail "D2: production compose still has a build stanza"

# Every service image must be registry-qualified and exactly pinned.
grep -E '^\s+image:' compose/docker-compose.yml | grep -v 'caddy:2' | grep -v 'pgvector/pgvector:pg16' | while read -r line; do
  case "$line" in
    *'${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE'*) : ;;
    *) fail "unqualified image reference: $line" ;;
  esac
  case "$line" in
    *:latest | *:latest-stable | *:main) fail "G1: moving tag in $line" ;;
  esac
done

# The publisher must refuse to push a tag it did not build from an exact pin.
if GBRAIN_VERSION=latest-stable bash scripts/publish-images.sh --dry-run >/dev/null 2>&1; then
  fail "publisher accepted a moving pin"
fi

# A dry run must print all three digests-to-be and push nothing.
out=$(GBRAIN_VERSION=0.50.5.0 HARNESS_VERSION=2.1.274 APP_VERSION=1.0.0 \
      bash scripts/publish-images.sh --dry-run)
for img in gbrain-base control-plane agent-runner; do
  echo "$out" | grep -q "$img" || fail "dry run did not mention $img"
done
echo "$out" | grep -q 'docker push' && fail "dry run would have pushed"
echo PASS
```

- [ ] **Step 2: Run it and watch it fail**

Run: `"C:/Program Files/Git/bin/bash.exe" test/unit/publish-images.test.sh`
Expected: FAIL at the first assertion — the production compose file still has build stanzas.

- [ ] **Step 3: Split the compose files**

`compose/docker-compose.build.yml` carries only:

```yaml
# D2: build stanzas live here, never in the production file. CI and the two
# build gates use `-f compose/docker-compose.yml -f compose/docker-compose.build.yml`.
services:
  control-plane:
    build: { context: .., dockerfile: docker/control-plane.Dockerfile }
  scheduler:
    build: { context: .., dockerfile: docker/control-plane.Dockerfile }
  agent-runner:
    build: { context: .., dockerfile: docker/agent-runner.Dockerfile }
```

and `compose/docker-compose.yml` loses lines 92–94 and 185–187 and gains the registry-qualified references.

- [ ] **Step 4: Write `scripts/publish-images.sh`**

```bash
#!/usr/bin/env bash
# G1: three images, three exact pins, no moving tags, ever.
set -euo pipefail
REGISTRY="${IMAGE_REGISTRY:-ghcr.io}"
NS="${IMAGE_NAMESPACE:?IMAGE_NAMESPACE is required}"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1

exact() {  # refuse anything that is not x.y.z[.w]
  case "$1" in
    [0-9]*.[0-9]*.[0-9]*) : ;;
    *) echo "G1: '$1' is not an exact version" >&2; exit 2 ;;
  esac
}
exact "${GBRAIN_VERSION:?}"; exact "${HARNESS_VERSION:?}"; exact "${APP_VERSION:?}"

build_and_push() {  # $1 image  $2 tag  $3 dockerfile  $4.. build args
  local ref="${REGISTRY}/${NS}/$1:$2"
  echo "--- $ref"
  if [ "$DRY" = 1 ]; then echo "would build $3 -> $ref"; return; fi
  docker build -f "$3" "${@:4}" -t "$ref" .
  docker push "$ref"
  docker image inspect "$ref" --format '{{index .RepoDigests 0}}'
}

build_and_push gbrain-base   "$GBRAIN_VERSION"  docker/gbrain-base.Dockerfile   --build-arg "GBRAIN_VERSION=${GBRAIN_VERSION}"
build_and_push control-plane "$APP_VERSION"     docker/control-plane.Dockerfile --build-arg "GBRAIN_VERSION=${GBRAIN_VERSION}"
build_and_push agent-runner  "$HARNESS_VERSION" docker/agent-runner.Dockerfile  --build-arg "HARNESS_VERSION=${HARNESS_VERSION}"
```

- [ ] **Step 5: Re-point CI and the build gates at the overlay**

Every `docker build -f docker/gbrain-base.Dockerfile …` in `.github/workflows/contract.yml` and both `test/build/*.test.sh` scripts keeps working (they build directly, which is correct for a gate), but their `-t` tags move to the registry-qualified form so the gate proves the same reference production pulls.

- [ ] **Step 6: Run the test and both build gates**

```bash
"C:/Program Files/Git/bin/bash.exe" test/unit/publish-images.test.sh
export GBRAIN_VERSION=$(grep '^GBRAIN_VERSION=' .env | cut -d= -f2)
export HARNESS_VERSION=$(grep '^HARNESS_VERSION=' .env | cut -d= -f2)
"C:/Program Files/Git/bin/bash.exe" test/build/pin.test.sh
"C:/Program Files/Git/bin/bash.exe" test/build/harness-pin.test.sh
```

Expected: PASS; both gates PASS **both arms** (pinned build succeeds, bogus pin rejected).

- [ ] **Step 7: Publish for real, once, and record the digests**

This needs a GHCR token with `write:packages`. Run `scripts/publish-images.sh` without `--dry-run` and **paste all three `RepoDigests` into `docs/slice-5-findings.md` as `P4`.** A digest is the artifact's identity; a tag is a label someone can move.

- [ ] **Step 8: Commit**

```bash
git add compose/ scripts/publish-images.sh test/unit/publish-images.test.sh .github/workflows/contract.yml test/build/ docs/slice-5-findings.md
git commit -m "feat(release): publish the three pinned images; production compose pulls, never builds"
```

---

### Task 6 — Installer preflight and the pull path

**Files:**
- Create: `scripts/preflight.sh`
- Create: `test/unit/preflight.test.sh`
- Modify: `scripts/install.sh`
- Modify: `test/unit/install.test.sh`

**Interfaces:**
- Consumes: the image reference contract from Task 5.
- Produces: `scripts/preflight.sh` with exit codes **10** Docker missing, **11** Compose too old, **12** RAM below floor, **13** disk below floor, **14** port 80 or 443 in use, **15** `$DOMAIN` does not resolve to this host, **16** the images cannot be pulled. `0` means every check passed; each failure prints one line saying what to do about it.

- [ ] **Step 1: Write the failing test**

```bash
# test/unit/preflight.test.sh
set -euo pipefail
fail() { echo "FAIL: $1" >&2; exit 1; }
expect_code() {  # $1 expected  $2.. env assignments + command
  local want="$1"; shift
  set +e; ( eval "$@" ) >/dev/null 2>&1; local got=$?; set -e
  [ "$got" = "$want" ] || fail "expected exit $want, got $got from: $*"
}

# Each refusal is a DISTINCT exit code, so the installer can say which one fired.
expect_code 10 "PREFLIGHT_FAKE_DOCKER=missing bash scripts/preflight.sh"
expect_code 11 "PREFLIGHT_FAKE_COMPOSE_VERSION=1.29.2 bash scripts/preflight.sh"
expect_code 12 "PREFLIGHT_FAKE_RAM_MB=1024 bash scripts/preflight.sh"
expect_code 13 "PREFLIGHT_FAKE_DISK_GB=5 bash scripts/preflight.sh"
expect_code 14 "PREFLIGHT_FAKE_PORT_443=busy bash scripts/preflight.sh"
expect_code 15 "DOMAIN=nx.invalid PREFLIGHT_FAKE_DNS=nxdomain bash scripts/preflight.sh"

# And every refusal must say what to DO, not just that it failed.
out=$(PREFLIGHT_FAKE_RAM_MB=1024 bash scripts/preflight.sh 2>&1 || true)
echo "$out" | grep -qi "memory" || fail "the RAM refusal does not name memory"
echo "$out" | grep -qE "[0-9]+ ?(MB|GB)" || fail "the RAM refusal does not state the floor"

# A clean host passes and says nothing alarming.
expect_code 0 "PREFLIGHT_SKIP_DNS=1 bash scripts/preflight.sh"
echo PASS
```

- [ ] **Step 2: Run it and watch it fail**

Run: `"C:/Program Files/Git/bin/bash.exe" test/unit/preflight.test.sh`
Expected: FAIL — `scripts/preflight.sh: No such file`.

- [ ] **Step 3: Write `scripts/preflight.sh`**

Each check reads its real value unless the matching `PREFLIGHT_FAKE_*` variable is set — the variables exist so the refusals are testable without breaking the host, and they are documented as test-only in the file's header. Floors: **Compose v2.20**, **4096 MB RAM**, **20 GB free on the Docker data root**, ports **80** and **443** unbound, `$DOMAIN` resolving to one of this host's addresses (skippable with `PREFLIGHT_SKIP_DNS=1` for a private-network install, which prints a warning rather than passing silently).

- [ ] **Step 4: Wire it into `scripts/install.sh` — before the secrets are generated**

Insert immediately after the `ENV_PATH` existence check and **before** `gen()` is ever called. The ordering is the point: the current installer writes `ENCRYPTION_KEY` and *then* discovers the host cannot run the stack, which leaves a half-installed box holding a key nobody has a use for.

```bash
# Preflight BEFORE any secret is generated: a host that cannot run the stack
# must not end up holding an ENCRYPTION_KEY it will never use.
if [ "${SKIP_PREFLIGHT:-0}" != "1" ]; then
  bash "$(dirname "$0")/preflight.sh" || exit $?
fi
```

- [ ] **Step 5: Add the pull leg**

Before `up -d --wait`:

```bash
echo "Pulling pinned images (${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE})…"
docker compose --env-file "$ENV_PATH" -f compose/docker-compose.yml pull
```

with a failure message that names the air-gapped fallback (`-f compose/docker-compose.build.yml build`) rather than leaving the operator at a bare `manifest unknown`.

- [ ] **Step 6: Extend `test/unit/install.test.sh`**

Add a case asserting preflight runs **before** the first `gen()` call — parse the script source the way line 38 already parses for the `up` line, so `BRAINSTAND_SKIP_UP=1` cannot hide it — and one asserting the pull leg exists and precedes `up`.

- [ ] **Step 7: Run both installer suites**

Run: `"C:/Program Files/Git/bin/bash.exe" test/unit/preflight.test.sh && "C:/Program Files/Git/bin/bash.exe" test/unit/install.test.sh`
Expected: PASS, both.

- [ ] **Step 8: Commit**

```bash
git add scripts/preflight.sh scripts/install.sh test/unit/preflight.test.sh test/unit/install.test.sh
git commit -m "feat(install): preflight before secrets, pull before up

A host that cannot run the stack must not end up holding an ENCRYPTION_KEY."
```

---

### Task 7 — Gate A: the clean-host install proof

**Files:**
- Create: `test/e2e/install.e2e.test.ts`
- Modify: `.github/workflows/contract.yml` (a `clean-install` job)

**Interfaces:**
- Consumes: Tasks 5 and 6 in full.
- Produces: A1–A8, the exit gate's first half.

**What makes this a real proof:** the job runs on a **fresh GitHub Actions runner** that has never seen this repository's images, pulls only from the registry, and the test asserts at the end that **no image was built locally** during the run. Pre-seeding the runner would make the gate a tautology, which is exactly the failure mode that let this gap survive five slices.

- [ ] **Step 1: Write the failing gate**

```ts
// test/e2e/install.e2e.test.ts
/**
 * Gate A (D1) — the clean-host install proof.
 *
 * This is the only test in the repository that runs `scripts/install.sh` to
 * completion. Every other installer test sets BRAINSTAND_SKIP_UP=1, which is
 * why the `up` leg was broken for five slices without a red suite.
 *
 * It must run where NO image of ours is present. A8 asserts that.
 */
import { afterAll, expect, test } from 'bun:test';

const RUN = process.env.CLEAN_INSTALL_E2E === '1';
const maybe = RUN ? test : test.skip;
const WORK = process.env.CLEAN_INSTALL_DIR ?? '/tmp/clean-install';

maybe('A1: preflight passes on this host and says so', async () => {
  const r = Bun.spawnSync(['bash', 'scripts/preflight.sh'], {
    env: { ...process.env, PREFLIGHT_SKIP_DNS: '1' },
  });
  console.log(`MEASURED preflight on a clean runner: exit=${r.exitCode}`);
  expect(r.exitCode).toBe(0);
});

maybe('A2: the installer runs to completion and the stack reports healthy', async () => {
  const r = Bun.spawnSync(['bash', 'scripts/install.sh'], {
    env: {
      ...process.env,
      DOMAIN: 'localhost', BRAINSTAND_ENV_PATH: `${WORK}/.env`,
      SKIP_PREFLIGHT: '0', PREFLIGHT_SKIP_DNS: '1',
    },
    stdin: new Blob(['n\n']),   // D12: the runner question, answered no.
  });
  console.log(`MEASURED install.sh: exit=${r.exitCode}\n${r.stderr.toString().slice(-2000)}`);
  expect(r.exitCode).toBe(0);
});

maybe('A3: /api/health is 200 with pin.matches true and both components ok', async () => {
  const res = await fetch('https://localhost/api/health', { tls: { rejectUnauthorized: false } });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  console.log(`MEASURED health on a clean install: ${JSON.stringify(body.pin)} ${JSON.stringify(body.components)}`);
  expect(body.pin.matches).toBe(true);
  expect(body.components.controlDb).toBe('ok');
  expect(body.components.ops).toBe('ok');
});

maybe('A4: the runner lane is DISABLED, because the question was answered no', async () => {
  const body = await (await fetch('https://localhost/api/health', { tls: { rejectUnauthorized: false } })).json() as any;
  expect(body.runner.state).toBe('disabled');
  const env = await Bun.file(`${WORK}/.env`).text();
  expect(env).toMatch(/^RUNNER_TOKEN=\s*$/m);
  expect(env).not.toContain('COMPOSE_PROFILES=runner');
});

maybe('A5: the console door is the bootstrap form on a box with no admin', async () => {
  const html = await (await fetch('https://localhost/', { tls: { rejectUnauthorized: false } })).text();
  expect(html).toContain('<div id="root">');
  const state = await (await fetch('https://localhost/api/wizard/state', { tls: { rejectUnauthorized: false } })).json() as any;
  expect(state.lifecycle).toBe('uninitialized');
});

maybe('A6: /admin is NOT routed (S1)', async () => {
  for (const p of ['/admin', '/admin/api/agents', '/admin/events']) {
    const res = await fetch(`https://localhost${p}`, { tls: { rejectUnauthorized: false } });
    expect(res.status).toBe(404);
  }
});

maybe('A7: .env is mode 600 and holds four distinct generated secrets', async () => {
  const { statSync } = await import('node:fs');
  expect((statSync(`${WORK}/.env`).mode & 0o777).toString(8)).toBe('600');
  const env = await Bun.file(`${WORK}/.env`).text();
  const vals = ['POSTGRES_PASSWORD', 'OPS_RPC_TOKEN', 'ENCRYPTION_KEY', 'BETTER_AUTH_SECRET']
    .map((k) => env.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1] ?? '');
  expect(vals.every((v) => v.length >= 32)).toBe(true);
  expect(new Set(vals).size).toBe(4);   // four secrets, not one reused four times
});

maybe('A8: nothing was BUILT — every image came from the registry', async () => {
  const r = Bun.spawnSync(['docker', 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}}\t{{.CreatedSince}}']);
  const lines = r.stdout.toString().trim().split('\n').filter((l) => l.includes(process.env.IMAGE_NAMESPACE!));
  console.log(`MEASURED images present after a clean install:\n${lines.join('\n')}`);
  expect(lines.length).toBeGreaterThanOrEqual(2);
  // A locally built image has no RepoDigest; a pulled one does.
  for (const line of lines) {
    const ref = line.split('\t')[0];
    const d = Bun.spawnSync(['docker', 'image', 'inspect', ref, '--format', '{{len .RepoDigests}}']);
    expect(Number(d.stdout.toString().trim())).toBeGreaterThan(0);
  }
});

afterAll(() => {
  if (!RUN) return;
  Bun.spawnSync(['docker', 'compose', '--env-file', `${WORK}/.env`, '-f', 'compose/docker-compose.yml', 'down', '-v']);
});
```

- [ ] **Step 2: Run it locally and watch it skip**

Run: `bun test test/e2e/install.e2e.test.ts`
Expected: 8 skipped — `CLEAN_INSTALL_E2E` is unset. This guard is why the gate cannot accidentally `down -v` a developer's stack.

- [ ] **Step 3: Add the CI job**

```yaml
  clean-install:
    runs-on: ubuntu-latest
    needs: contract
    env:
      CLEAN_INSTALL_E2E: '1'
      CLEAN_INSTALL_DIR: /tmp/clean-install
      IMAGE_REGISTRY: ghcr.io
      IMAGE_NAMESPACE: ${{ vars.IMAGE_NAMESPACE }}
      GBRAIN_VERSION: '0.50.5.0'
      HARNESS_VERSION: '2.1.274'
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.14 }
      - run: bun install --frozen-lockfile
      # D1: the runner must be as clean as a stranger's box. Prove it first.
      - name: Assert no image of ours is present
        run: |
          if docker image ls --format '{{.Repository}}' | grep -q "${IMAGE_NAMESPACE}"; then
            echo "runner is pre-seeded; this gate would be a tautology" >&2; exit 1
          fi
      - run: mkdir -p /tmp/clean-install
      - run: bun test test/e2e/install.e2e.test.ts
        timeout-minutes: 45
```

- [ ] **Step 4: Push and watch the job**

Expected first outcome: **it fails.** That is the finding, not a setback — it is the first honest measurement of the install path. Record whatever it fails on as `F1` in `docs/slice-5-findings.md`, fix it, and re-run until A1–A8 are green. Paste the failing output verbatim before the fix and the passing output after.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/install.e2e.test.ts .github/workflows/contract.yml docs/slice-5-findings.md
git commit -m "test(gate-a): prove the install on a host that has never seen our images"
```

---

### Task 8 — The `/metrics` exposure audit

**Files:**
- Modify: `compose/Caddyfile:30-40,100-110` (only if the audit says so)
- Test: `test/e2e/slice5.e2e.test.ts` (the C1 leg, written here, run in Task 17)

**Interfaces:**
- Consumes: a running stack.
- Produces: a `U` finding, and a Caddyfile change if the finding is what it looks like.

`compose/Caddyfile:34` routes `/metrics` to `gbrain-serve:3131` on the **public** site, alongside `/health`. The roadmap describes upstream's `/metrics` as "Prometheus, admin-gated", but that is a claim about upstream's intent, not a measurement of the pinned binary behind our Caddy. S1's whole argument is that a second control-plane surface must not be publicly routed; a Prometheus endpoint that answers unauthenticated is a smaller version of the same mistake.

- [ ] **Step 1: Measure it**

```bash
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost:8443/metrics
curl -sk https://localhost:8443/metrics | head -20
```

- [ ] **Step 2: Record the measurement as `U1`**

Write into `docs/slice-5-findings.md`: the status code, whether a body came back, and whether that body names brains, Spaces, models or spend. **Record it whatever it says** — a 401 is as much a finding as a 200.

- [ ] **Step 3: If it answered 200 with a body, close it**

Move `/metrics` out of the `@gbrain` matcher and into the same `handle` block that 404s `/admin`, with this comment:

```
# S1's argument applies to /metrics too: an unauthenticated Prometheus endpoint
# on the public site publishes brain, Space and model cardinality to anyone who
# asks. Measured at <version> on <date>: <status>, <what the body contained>.
# Scrape it from inside the compose network, or through break-glass.
```

Leave `/health` where it is — it is deliberately public and carries no cardinality.

- [ ] **Step 4: Write the C1 leg into the Gate C file**

```ts
test('C1: /metrics does not answer an unauthenticated public request', async () => {
  const res = await fetch(`${BASE}/metrics`, { tls: { rejectUnauthorized: false } });
  console.log(`MEASURED public /metrics: ${res.status}`);
  expect([401, 403, 404]).toContain(res.status);
});
```

- [ ] **Step 5: Verify and commit**

Run: `curl -sk -o /dev/null -w '%{http_code}\n' https://localhost:8443/metrics` → expect 404 (or the measured-and-justified status).

```bash
git add compose/Caddyfile test/e2e/slice5.e2e.test.ts docs/slice-5-findings.md
git commit -m "fix(caddy): /metrics is not a public surface"
```

---

### Task 9 — Measure the search-mode cost spread

**Files:**
- Create: `scripts/measure-search-modes.ts`
- Modify: `src/control/lifecycle.ts:30-49`
- Modify: `src/console/pages/Wizard.tsx:42-52`
- Test: `test/unit/lifecycle.test.ts`

**Interfaces:**
- Consumes: `readBrainUsage(days)` from Task 10. **Do Task 10 first.**
- Produces: `SEARCH_MODES[].measuredCost: number | null`, `.measuredAt: string | null`, `.measuredOn: string | null`, and `MEASURED_COST_DISCLAIMER`.

**This is a probe that writes a constant, not a feature.** Its output is three numbers and a date, and it is allowed to produce `null`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/lifecycle.test.ts — append
import { SEARCH_MODES } from '../../src/control/lifecycle.ts';

describe('SEARCH_MODES honesty (D7)', () => {
  test('every mode declares whether its cost was measured, and where', () => {
    for (const m of SEARCH_MODES) {
      expect(typeof m.relativeCost).toBe('number');           // upstream's claim
      expect('measuredCost' in m).toBe(true);                  // ours, or null
      if (m.measuredCost !== null) {
        expect(m.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(typeof m.measuredOn).toBe('string');            // the corpus
        expect(m.measuredOn!.length).toBeGreaterThan(0);
      } else {
        expect(m.measuredAt).toBeNull();
        expect(m.measuredOn).toBeNull();
      }
    }
  });

  test('the cheapest measured mode is the baseline, exactly 1', () => {
    const measured = SEARCH_MODES.filter((m) => m.measuredCost !== null);
    if (measured.length === 0) return;                         // nothing measured yet is legal
    expect(Math.min(...measured.map((m) => m.measuredCost!))).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test test/unit/lifecycle.test.ts`
Expected: FAIL — `measuredCost` is not a property of the mode objects.

- [ ] **Step 3: Write the probe**

`scripts/measure-search-modes.ts`: for each of `fast`, `balanced`, `thorough` — set the mode through the existing `config.set` operation, read `readBrainUsage(1)` as a baseline, run **the same 20 queries** against the brain through the `search` operation, read usage again, and take the delta. Print a `MEASURED` line per mode with the delta cost, the call count, the model mix and the corpus size (`pages` and `chunks` from `sources.status`). Restore the original mode in a `finally`. It costs real money; print the total at the end.

- [ ] **Step 4: Run the probe on the live stack**

```bash
bun run scripts/measure-search-modes.ts 2>&1 | tee /tmp/search-modes.txt
```

**The current brain is thin** — 3 Spaces, 6 pages, 6 chunks (HANDOFF.md). If the deltas are at or near zero, or the ratios are dominated by fixed per-call overhead, that is the honest answer: **record it as `P5` and leave `measuredCost: null`.** A 25× claim cannot be validated on a 6-page corpus, and Slice 2's own findings warn in exactly these words that a flat ratio on a tiny corpus is not a scale proof (`docs/slice-2-findings.md:93`).

- [ ] **Step 5: Write the numbers — or the nulls — into `lifecycle.ts`**

```ts
export const MEASURED_COST_DISCLAIMER =
  'Measured on this deployment\u2019s own corpus. Your ratio depends on page count, ' +
  'chunk size and query shape; re-measure before committing a team to a mode.';

export const SEARCH_MODES = [
  {
    id: 'fast',
    label: 'Fast',
    /** Upstream's published claim. NOT ours — see measuredCost. */
    relativeCost: 1,
    /** Ours, or null. D7: a number we did not produce is never shown as ours. */
    measuredCost: null as number | null,
    measuredAt: null as string | null,
    measuredOn: null as string | null,
    description: 'Lexical + vector retrieval only. Cheapest and lowest latency; no LLM reranking or synthesis on the read path.',
  },
  // … balanced, thorough, same shape
] as const;
```

- [ ] **Step 6: Split the two numbers in the wizard**

`src/console/pages/Wizard.tsx:42-52` currently prints `Math.max(...relativeCost)` as fact. Replace with:

```tsx
{measured.length === modes.length ? (
  <p className="text-sm text-neutral-600">
    On this deployment, the most expensive mode costs about{' '}
    {Math.max(...measured.map((m) => m.measuredCost!))}× the cheapest.{' '}
    <span className="text-neutral-500">{MEASURED_COST_DISCLAIMER}</span>
  </p>
) : (
  <p className="text-sm text-neutral-600">
    Not measured on this deployment. Upstream reports roughly{' '}
    {Math.max(...modes.map((m) => m.relativeCost))}× between the cheapest and most
    expensive mode; your own spread will differ. The Spend page shows what you
    actually pay once the brain has run for a few days.
  </p>
)}
```

- [ ] **Step 7: Run the tests**

Run: `bun test test/unit/lifecycle.test.ts && bun test test/integration/wizard.test.ts && bunx tsc --noEmit`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add scripts/measure-search-modes.ts src/control/lifecycle.ts src/console/pages/Wizard.tsx test/unit/lifecycle.test.ts docs/slice-5-findings.md
git commit -m "feat(cost): the wizard stops presenting upstream's 25x as our measurement"
```

---

### Task 10 — `get_usage` through the data lane

**Files:**
- Create: `src/ops/usage.ts`
- Create: `test/contract/usage.contract.test.ts`
- Modify: `src/ops/server.ts` (one route)
- Modify: `src/control/opsClient.ts` (one client function)

**Interfaces:**
- Consumes: `mcp.grant` from the contract registry.
- Produces: `readBrainUsage(days: number): Promise<BrainUsage>` where

```ts
export type BrainUsage = {
  windowDays: number;
  totals: { calls: number; inputTokens: number; outputTokens: number;
            cacheReadTokens: number; cacheWriteTokens: number; costUsd: number };
  byModel: { model: string; calls: number; costUsd: number | null; unpricedCalls: number }[];
  byPhase: { phase: string; calls: number; costUsd: number }[];
  /** Upstream's own words, carried VERBATIM. Never paraphrased (D8). */
  coverage: { source: string; loggedSince: string | null; tablePresent: boolean;
              pricedCalls: number; unpricedCalls: number; notCovered: string[] };
};
```

**The hard rule for this task:** `chat_usage_log` is gbrain's table. We never read it (G2). We call the published `get_usage` operation over the HTTP MCP lane with a short-TTL admin client minted ops-side, and we revoke that client when the call returns.

- [ ] **Step 1: Write the failing contract test**

```ts
// test/contract/usage.contract.test.ts
import { expect, test, describe } from 'bun:test';
import { readBrainUsage } from '../../src/ops/usage.ts';

describe('get_usage at the pinned version (D8, G4)', () => {
  test('the operation exists in the pinned binary\u2019s published tool surface', async () => {
    const r = Bun.spawnSync(['docker', 'exec', `${process.env.COMPOSE_PROJECT_NAME ?? 'brainstand'}-gbrain-ops-1`,
                             'gbrain', '--tools-json']);
    const names = [...r.stdout.toString().matchAll(/"name":\s*"([^"]+)"/g)].map((m) => m[1]);
    console.log(`MEASURED tool surface at ${process.env.GBRAIN_VERSION}: ${names.length} tools, get_usage present=${names.includes('get_usage')}`);
    expect(names).toContain('get_usage');
  });

  test('it answers with totals AND a coverage block', async () => {
    const usage = await readBrainUsage(30);
    console.log(`MEASURED get_usage(30): calls=${usage.totals.calls} cost=$${usage.totals.costUsd} ` +
                `models=${usage.byModel.length} phases=${usage.byPhase.length} ` +
                `coverage.loggedSince=${usage.coverage.loggedSince} tablePresent=${usage.coverage.tablePresent}`);
    expect(usage.windowDays).toBe(30);
    expect(typeof usage.totals.calls).toBe('number');
    expect(usage.coverage.source).toBe('gateway.chat');
    // The four exclusions upstream names. If this array shrinks, our page lies.
    expect(usage.coverage.notCovered.length).toBeGreaterThanOrEqual(4);
    expect(usage.coverage.notCovered.join(' ')).toMatch(/embeddings/i);
  });

  test('an unpriced call is counted, never priced at zero (honesty rule 3)', async () => {
    const usage = await readBrainUsage(365);
    for (const m of usage.byModel) {
      if (m.unpricedCalls > 0 && m.costUsd !== null) {
        // Legal: some calls priced, some not. What is illegal is claiming a
        // total is complete when unpricedCalls > 0 — the page must say so.
        expect(usage.coverage.unpricedCalls).toBeGreaterThan(0);
      }
    }
  });

  test('the admin client minted for the call is revoked afterwards', async () => {
    const before = await listClients();
    await readBrainUsage(1);
    const after = await listClients();
    console.log(`MEASURED clients before=${before.length} after=${after.length}`);
    expect(after.length).toBe(before.length);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test test/contract/usage.contract.test.ts`
Expected: FAIL — `Cannot find module '../../src/ops/usage.ts'`.

- [ ] **Step 3: Implement `src/ops/usage.ts`**

Mint through the registry's `mcp.grant` with the `operator` profile (confirmed present on the pinned version: `memory-reader`, `memory-writer`, `coding-agent`, `operator`, `delegating-agent`, `full`) and a minutes-scale `--token-ttl`, exactly as Slice 4's D8 mints a per-run client. **If `operator` turns out not to carry the `admin` scope `get_usage` requires, measure which profile does and record it as `U2`** — do not reach for `full` reflexively, and do not read the table instead. Call `get_usage` over the MCP endpoint, map snake_case to camelCase without altering any value, and revoke the client in a `finally` via `auth.revokeClient`. Never log the token (S3c).

- [ ] **Step 4: Add the ops route and the client function**

`src/ops/server.ts` gains `POST /usage` (bearer `OPS_RPC_TOKEN`, like every other ops route), and `src/control/opsClient.ts` gains `export async function brainUsage(days: number): Promise<BrainUsage>`. This is the only new ops surface in the slice and it is read-only.

- [ ] **Step 5: Run the contract test**

Run: `bun test test/contract/usage.contract.test.ts`
Expected: PASS, 4 tests, with all four `MEASURED` lines printed. Copy them into `docs/slice-5-findings.md` as `U2`–`U3`.

- [ ] **Step 6: Commit**

```bash
git add src/ops/usage.ts src/ops/server.ts src/control/opsClient.ts test/contract/usage.contract.test.ts docs/slice-5-findings.md
git commit -m "feat(cost): read gbrain's own spend through the published get_usage operation"
```

---

### Task 11 — Spend rollups

**Files:**
- Create: `src/control/spend.ts`
- Create: `src/control/routes/spend.ts`
- Create: `test/unit/spend.test.ts`
- Modify: `src/control/app.ts`
- Test: `test/integration/spend.test.ts` (create)

**Interfaces:**
- Consumes: `brainUsage(days)` from Task 10.
- Produces:

```ts
export type SpendRow = { key: string; label: string; runs: number; costUsd: number | null; unpricedRuns: number };
export type SpendReport = {
  windowDays: number;
  ours: { totalUsd: number | null; unpricedRuns: number;
          byMember: SpendRow[]; bySchedule: SpendRow[]; byModel: SpendRow[] };
  brain: BrainUsage | null;
  coverage: { ours: string[]; brainReachable: boolean };
};
export function spendByMember(orgId: string, days: number): Promise<SpendRow[]>;
export function spendBySchedule(orgId: string, days: number): Promise<SpendRow[]>;
export function spendByModel(orgId: string, days: number): Promise<SpendRow[]>;
export function spendReport(orgId: string, days: number): Promise<SpendReport>;
```

- [ ] **Step 1: Write the failing unit test**

```ts
// test/unit/spend.test.ts
import { describe, expect, test } from 'bun:test';
import { rollup } from '../../src/control/spend.ts';

const run = (over: Partial<any> = {}) => ({
  runId: 'r1', memberId: 'm1', memberLabel: 'alice@example.test',
  costUsd: '0.25', ...over,
});

describe('rollup (D9)', () => {
  test('sums per key and counts runs', () => {
    const rows = rollup([run(), run({ runId: 'r2', costUsd: '0.75' })], 'memberId', 'memberLabel');
    expect(rows).toEqual([{ key: 'm1', label: 'alice@example.test', runs: 2, costUsd: 1, unpricedRuns: 0 }]);
  });

  // Honesty rule 3, at the aggregate level.
  test('an unpriced run is counted, and does not read as zero', () => {
    const rows = rollup([run({ costUsd: '1.00' }), run({ runId: 'r2', costUsd: null })], 'memberId', 'memberLabel');
    expect(rows[0].costUsd).toBe(1);        // the priced part
    expect(rows[0].runs).toBe(2);
    expect(rows[0].unpricedRuns).toBe(1);   // and the part we could not price
  });

  test('every run being unpriced gives a NULL total, never 0', () => {
    const rows = rollup([run({ costUsd: null })], 'memberId', 'memberLabel');
    expect(rows[0].costUsd).toBeNull();
  });

  // D9: connection_id is `on delete set null` so the audit survives.
  test('a run whose Connection is gone rolls up as unattributed, on its own row', () => {
    const rows = rollup([run(), run({ runId: 'r2', memberId: null, memberLabel: null })],
                        'memberId', 'memberLabel');
    expect(rows.map((r) => r.key).sort()).toEqual(['m1', 'unattributed']);
    expect(rows.find((r) => r.key === 'unattributed')!.label).toBe('Unattributed (Connection deleted)');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test test/unit/spend.test.ts`
Expected: FAIL — `Cannot find module '../../src/control/spend.ts'`.

- [ ] **Step 3: Implement `rollup` and the three query functions**

`rollup` is pure and takes already-joined rows. The queries join `agent_runs` → `connections` → `memberships` → `user` for the member label, `schedule_runs` → `schedules` for the schedule label, and group `agent_run_usage` by `model`. Filter by `organization_id` and `started_at >= now() - make_interval(days => $1)`.

- [ ] **Step 4: Write the route**

`GET /api/spend?days=30`, admin-only through the existing `rbac.ts` guard, `days` clamped to 1–365 to mirror upstream's own clamp. It calls `spendReport`, and when `brainUsage` throws it sets `brain: null` and `coverage.brainReachable: false` — **it does not fail the page and does not report zero.**

- [ ] **Step 5: Run the unit test, then write and run the integration test**

The integration test seeds two runs on one Connection, one on a deleted Connection, and one unpriced, then asserts the report's three sections and the `unattributed` row.

Run: `bun test test/unit/spend.test.ts && bun test test/integration/spend.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/control/spend.ts src/control/routes/spend.ts src/control/app.ts test/unit/spend.test.ts test/integration/spend.test.ts
git commit -m "feat(spend): roll up agent spend per member, schedule and model

gbrain's budget_usd_per_day is per OAuth client and a member has several after
Slice 2, so it does not aggregate on its own."
```

---

### Task 12 — The Spend page

**Files:**
- Create: `src/console/pages/Spend.tsx`
- Modify: `src/console/App.tsx` (nav entry and route)
- Modify: `src/console/api.ts` (the typed fetch)

**Interfaces:**
- Consumes: `GET /api/spend` from Task 11.
- Produces: the console's cost surface.

- [ ] **Step 1: Write the page**

Four sections, in this order, because the order is the argument:

1. **What this page can and cannot see** — first, not last. Two sentences: ours covers agent-runner model calls through our gateway; gbrain's ledger covers `gateway.chat` and excludes what upstream's `coverage.notCovered` lists, **rendered as a bulleted list of upstream's own strings, verbatim.** When `coverage.brainReachable` is false, this section says the brain ledger could not be read and the totals below are ours alone.
2. **Totals** — our metered total and the brain ledger total as **two separate figures that are never added together.** They meter different things; summing them would invent a number.
3. **Per member / per schedule / per model** — three tables, the `unattributed` row styled as its own thing rather than as a member.
4. **Unpriced calls** — a count with an explanation, shown even when it is zero, because a page that only mentions unpriced calls when they exist teaches the reader that their absence is never worth stating.

Follow `src/console/pages/Runs.tsx`'s existing money formatting and its `null`-handling comments (`:159-219`) — that file already got this right once and its conventions are the house style.

- [ ] **Step 2: Verify against the live stack**

```bash
curl -sk "https://localhost:8443/api/spend?days=30" -H "cookie: <admin session>" | head -60
```

Then open `/spend` in the console and check the three things that are easy to get wrong: the two totals are not summed; the `unattributed` row is present when a run's Connection is gone; the coverage list matches upstream's strings character for character.

- [ ] **Step 3: Run the console's own checks and commit**

Run: `bunx tsc --noEmit && bun test test/unit`

```bash
git add src/console/pages/Spend.tsx src/console/App.tsx src/console/api.ts
git commit -m "feat(console): a spend page that states its own coverage first"
```

---

### Task 13 — The drift tripwire opens an issue

**Files:**
- Create: `.github/workflows/nightly.yml`
- Modify: `.github/workflows/contract.yml` (drop the nightly cron and the pinned-next matrix arm; add `tsc`, the build gates and `test/integration`)

**Interfaces:**
- Consumes: nothing.
- Produces: a nightly workflow that opens or updates one issue per drifting version.

- [ ] **Step 1: Split the workflows**

`contract.yml` becomes the **PR and push** workflow: `lint:forbidden`, `tsc --noEmit`, `test:unit`, `test:integration`, both build gates, `test:contract` at pinned-current only, plus the `restore`, `slice2` and `clean-install` jobs. No cron, no matrix.

`nightly.yml` is the tripwire: cron `17 5 * * *` plus `workflow_dispatch`, a matrix over pinned-current and pinned-next, `continue-on-error` on pinned-next only.

- [ ] **Step 2: Write the issue step**

```yaml
      - name: Open or update a drift issue
        if: failure() && matrix.gbrain != env.PINNED_CURRENT
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TITLE: "drift: gbrain ${{ matrix.gbrain }} breaks the contract suite"
        run: |
          set -euo pipefail
          # Never duplicate: one open issue per drifting version, updated nightly.
          existing=$(gh issue list --state open --search "\"$TITLE\" in:title" \
                     --json number --jq '.[0].number // empty')
          body=$(printf '%s\n' \
            "Nightly pinned-next run failed against gbrain \`${{ matrix.gbrain }}\`." \
            "" \
            "Run: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}" \
            "Pinned-current (\`$PINNED_CURRENT\`) is unaffected; this is a tripwire, not an outage." \
            "" \
            "Failing tests:" \
            "\`\`\`" \
            "$(grep -E '^\(fail\)' contract-output.txt | head -50 || echo 'see the run log')" \
            "\`\`\`" \
            "" \
            "G1 holds: do not move the pin to make this pass. Fix the seam or widen the contract test.")
          if [ -n "$existing" ]; then
            gh issue comment "$existing" --body "$body"
          else
            gh issue create --title "$TITLE" --body "$body" --label drift
          fi
```

with `bun run test:contract 2>&1 | tee contract-output.txt` in the step above it so the failing test names are available, and `permissions: { issues: write, contents: read }` on the job.

- [ ] **Step 3: Prove it fires — deliberately**

Run the workflow with `workflow_dispatch` against a version that does not exist (`0.99.0.0`) so the build fails, and **confirm an issue is opened.** Then re-run and confirm a second issue is **not** opened and a comment is added instead. Close the test issue by hand. Record both as `P6`.

A tripwire nobody has ever seen fire is a tripwire nobody knows is connected.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/
git commit -m "feat(ci): the nightly drift tripwire opens an issue instead of a grey checkmark"
```

---

### Task 14 — Clear the live-stack debt through product paths

**Files:** none necessarily. This task's deliverable is a clean stack and a set of findings.

**Interfaces:**
- Consumes: the running dev stack.
- Produces: `/api/health` with no unacknowledged alert kinds and no pending upgrade decision, and an `F` finding for any acknowledge path that turns out not to exist.

- [ ] **Step 1: Record the starting state**

```bash
curl -sk https://localhost:8443/api/health | python -m json.tool | tee /tmp/health-before.json
```

Copy it into `docs/slice-5-findings.md` as the "before" half of `P7`.

- [ ] **Step 2: Clear the eight pending checklist items through the API**

Sign in as the admin, open `/upgrades`, read each of the 8 `pending` `upgrade_checklist_items` for `0.50.2.0`, and acknowledge each with `POST /api/upgrades/checklist/:itemId/ack`. **Read what each item says before acknowledging it** — an acknowledgement is a human saying they did the thing, and eight rubber stamps would make the surface theatre.

- [ ] **Step 3: Resolve the `awaiting_admin_decision` ledger row**

`playbook_ledger` holds `0.50.2.0` as `awaiting_admin_decision`. Drive the decision through `/upgrades`, not SQL. Confirm afterwards that preflight no longer refuses a new upgrade run.

- [ ] **Step 4: Acknowledge the two open alerts**

`overlap_killed_previous` and `connection_revoked`, through `/schedules` — the only place the product exposes acknowledgement. Confirm `/api/health` stops carrying their kinds.

- [ ] **Step 5: Remove the gate residue through the members surface**

10 memberships (1 owner, 8 members, 1 viewer) and 7 active / 3 revoked Connections, all left by repeated gate runs. Remove the members that are gate artifacts, keeping the owner and any that a gate still needs. **If the console has no path to delete a membership or purge a revoked Connection, that is finding `F2` and it is a GA gap** — a product whose only path to clean up is `psql` is not one an operator can run.

- [ ] **Step 6: Record the ending state and the findings**

```bash
curl -sk https://localhost:8443/api/health | python -m json.tool | tee /tmp/health-after.json
diff /tmp/health-before.json /tmp/health-after.json
```

Write the diff into `P7`. Every `F` this task raised goes into the findings doc with a decision: fixed in this slice, or deliberately deferred with a reason.

- [ ] **Step 7: Commit**

```bash
git add docs/slice-5-findings.md
git commit -m "docs(slice5): clear the live-stack debt through product paths, and record what had no path"
```

---

### Task 15 — The front door

**Files:**
- Create: `README.md`, `LICENSE`, `SECURITY.md`, `docs/support-policy.md`, `docs/runbooks/install.md`

**Interfaces:**
- Consumes: the product name (Task 4), the image references (Task 5), the preflight floors (Task 6).
- Produces: the documents a stranger reads before they trust this.

- [ ] **Step 1: `README.md`**

What it is; the one-command install with the real registry-qualified command; the system floors preflight enforces; what the runner is and that it is off by default, **in the installer's own plain words**; the pinned gbrain and harness versions; the "built on gbrain" attribution with a link to upstream and its MIT licence; and a short "what this is not" — not a fork, not a replacement for gbrain's `/admin`, not multi-tenant.

- [ ] **Step 2: `LICENSE`**

**This is the user's decision, not the executor's.** Upstream is MIT (© 2026 Garry Tan) and we neither fork nor vendor it, so our licence is genuinely our choice. If no licence has been chosen, stop and ask. Whatever is chosen, add a `NOTICE` or a README section recording upstream's MIT text and copyright, because "built on gbrain" is a claim about someone else's active project and the roadmap already flags getting a lawyer's eye on the naming and positioning before launch.

- [ ] **Step 3: `SECURITY.md`**

Where to report a vulnerability and the response window. The trust boundaries in one paragraph each: Caddy is the only ingress; `/admin` is not routed (S1); the control plane holds no brain database credentials (S2); secrets are envelope-encrypted under `ENCRYPTION_KEY`, which is **not** in the backup archive; the agent runner reaches one internal network with no default route and its tool surface is MCP-only; `/api/runs/*` and `/api/gateway/*` are internal-only. State the known residual risks plainly — an operator who enables the runner is running model-written code against their brain with their own key, and that is a choice the product asks them to make in words rather than hiding.

- [ ] **Step 4: `docs/support-policy.md`**

The roadmap's own commitment, made concrete: *we support gbrain version X; upgrades land N days after upstream tags; the nightly drift job is the tripwire.* Fill in X from the pin and N from what the upgrade lane can actually deliver — **do not promise a window the upgrade runbook cannot meet.**

- [ ] **Step 5: `docs/runbooks/install.md`**

First install, the preflight failures and what each means (one section per exit code 10–16), the air-gapped build fallback, the first-admin bootstrap, where the secrets live, and the first thing to do after install (back up `ENCRYPTION_KEY` somewhere that is not the backup archive).

- [ ] **Step 6: Check every command in every document actually runs**

Copy each fenced command out and run it. A README whose install command has a typo is worse than no README, because it burns the one moment of trust a stranger extends.

- [ ] **Step 7: Commit**

```bash
git add README.md LICENSE SECURITY.md docs/support-policy.md docs/runbooks/install.md
git commit -m "docs: the front door — README, LICENSE, SECURITY, support policy, install runbook"
```

---

### Task 16 — The backup/restore runbook and the DR drill

**Files:**
- Create: `docs/runbooks/backup-restore.md`
- Modify: `test/e2e/slice5.e2e.test.ts` (the C7–C8 legs)

**Interfaces:**
- Consumes: Task 2's three-state `quiesced`.
- Produces: the runbook, and a measured restore-to-a-new-domain drill.

The spec is explicit that **restoring to a new domain invalidates every grant** — OAuth redirect URIs and issuer URLs are domain-bound — and that the bulk re-provisioning flow doubles as the DR drill. `restore.e2e.test.ts` exercises restore; nothing has ever exercised restore *to a different domain*, which is the case a real disaster produces.

- [ ] **Step 1: Take a backup on a production-shaped stack and read its manifest**

Reuse Task 2 Step 7's procedure. Confirm `quiesced: "verified"`, `quiesceLane: "relay"`.

- [ ] **Step 2: Run the drill**

Restore that archive into a stack whose `DOMAIN` differs. Measure and record: how many Connections are invalidated, what the console shows for each, whether the member-facing message explains what happened, and how long the whole path takes. Record as `P8`.

- [ ] **Step 3: Write the runbook from what you measured**

Sections: what a backup contains and what it deliberately does not (`ENCRYPTION_KEY`); the three `quiesced` states and what each means for trusting the archive; restore to the same domain; restore to a new domain **with the grant-invalidation consequence stated first, before the steps**; the bulk re-provisioning flow; and how often to drill. Every number in it is one Step 2 measured.

- [ ] **Step 4: Write the C7–C8 legs**

C7 backs up and asserts `quiesced === 'verified'`; C8 restores to a different domain and asserts the Connections are invalidated **and** that the console says so rather than showing a working Connection that is not.

- [ ] **Step 5: Commit**

```bash
git add docs/runbooks/backup-restore.md test/e2e/slice5.e2e.test.ts docs/slice-5-findings.md
git commit -m "docs(runbook): backup and restore, with a measured restore-to-a-new-domain drill"
```

---

### Task 17 — Gate C: the GA operator walk

**Files:**
- Modify: `test/e2e/slice5.e2e.test.ts` (C1–C10, assembling the legs written in Tasks 8 and 16)

**Interfaces:**
- Consumes: every prior task.
- Produces: the exit gate's second half.

**This is one continuous walk by one operator on one stack, not ten independent tests.** It starts from the clean stack Task 14 left and it does what a new customer does in their first week.

- [ ] **Step 1: Write the legs**

- **C1** — `/metrics` does not answer an unauthenticated public request (from Task 8).
- **C2** — a fresh operator bootstraps: create the first admin, complete the wizard, pick a search mode, and **assert the mode screen shows a measured number or says it was not measured** (D7) — never upstream's 25× presented as ours.
- **C3** — invite a member, have them claim their Connection, and assert the Space-as-source fence holds.
- **C4** — create a `gbrain_command` schedule, let it materialize and run, and read its report.
- **C5** — enable the runner lane, create an `agent_prompt` schedule, let one run complete, and assert `GET /api/runs/:id` carries the prompt, the tool calls, the tokens, the cost and the brain diff.
- **C6** — open `/spend` and assert: the two totals are separate, the coverage list matches upstream's `notCovered` strings verbatim, the member whose run C5 produced appears with a non-null cost, and the unpriced count is shown.
- **C7** — back up; assert `quiesced === 'verified'` and `quiesceLane` is set (from Task 16).
- **C8** — restore to a different domain; assert the Connections are invalidated and the console says so (from Task 16).
- **C9** — run one upgrade through `scripts/upgrade.ts`, assert `playbook_ledger` records it and doctor parity holds, then deliberately fail a migration and assert one-click rollback restores the pre-upgrade state exactly. **This re-proves Slice 3.5's exit gate on the renamed, re-published stack** — the rename touched volume names and image references, which is precisely what a rollback depends on.
- **C10** — print the walk's total model spend from the gate's own teardown, the way Slice 4's Gate C does.

- [ ] **Step 2: Run the gate**

```bash
docker port ${COMPOSE_PROJECT_NAME:-brainstand}-gbrain-ops-1   # must show 3140 -> 0.0.0.0:3140
bun test --parallel=1 test/e2e/slice5.e2e.test.ts
```

- [ ] **Step 3: Expect it to find something, and record what**

Slice 4's Gate C found a real product defect (F15/F16, the revert that did not revert). A gate that finds nothing on its first run is more likely under-written than lucky. Whatever C1–C10 turn up goes into `docs/slice-5-findings.md` as `F*` with the fix, and the leg's assertions do **not** move to accommodate it.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/slice5.e2e.test.ts docs/slice-5-findings.md
git commit -m "test(gate-c): the GA operator walk, and what it found"
```

---

### Task 18 — Release, findings, handoff

**Files:**
- Modify: `HANDOFF.md`, `docs/superpowers/plans/PROGRESS.md`, `docs/superpowers/plans/2026-09-14-brainstand-roadmap.md`
- Create: `docs/slice-5-findings.md` (finalise), `CHANGELOG.md`

- [ ] **Step 1: Run all eight verification commands on the frozen tree**

The six, plus the two build gates. Paste every tail verbatim into `PROGRESS.md`. The commands are in the Verification section below.

- [ ] **Step 2: Finalise `docs/slice-5-findings.md`**

`U1`–`U*` (upstream facts measured at the pin), `P1`–`P8` (probe results, including the search-mode measurement or its honest null), `F1`–`F*` (defects found and what happened to each). Every `F` has a resolution: fixed here, or deferred with a reason and a named owner slice.

- [ ] **Step 3: Tag and publish**

```bash
git tag -a v1.0.0 -m "<NAME> 1.0.0 — self-host GA"
APP_VERSION=1.0.0 bash scripts/publish-images.sh
```

Paste the three `RepoDigests` into `CHANGELOG.md` under `1.0.0`. **A release is its digests; a tag is a label someone can move.**

- [ ] **Step 4: Verify the published artifacts from outside**

On a machine that is not this one (or a fresh runner), `docker pull` all three by digest and confirm they start. This is Gate A's assertion made once more against the actual release, not the CI build of it.

- [ ] **Step 5: Rewrite `HANDOFF.md`**

It is the cold-start entry point, so it must describe a **released product**, not a build in progress: what shipped, the three published digests, where the runbooks are, the live-stack state after Task 14, the support policy, and the one remaining open question (managed cloud, with D12's substrate decision recorded and nothing else about it presumed).

- [ ] **Step 6: Close the roadmap**

Mark Slice 5 complete with its measured exit-gate table, in the form Slice 4's section uses — roadmap promise on the left, measured outcome on the right. Add the deferred cloud slice as the next stage with D12's decision recorded and Open Question 2 still open, since pricing was deliberately not settled here.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "docs(slice5): GA — the measured exit gate, the published digests, the handoff"
```

---

## Verification

The eight commands, in this order, on the frozen tree. **Check `docker port ${COMPOSE_PROJECT_NAME:-brainstand}-gbrain-ops-1` says `3140/tcp -> 0.0.0.0:3140` before each host-run suite,** and re-up the dev stack between `test/integration` and `test/contract`.

```bash
# 1-2: static
bun run lint:forbidden
bunx tsc --noEmit

# 3: unit
bun test test/unit

# 4: integration (re-up the dev stack afterwards — quiesce.test.ts drops the port publication)
bun test test/integration
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml up -d --wait

# 5: contract
bun test test/contract

# 6: e2e, twice consecutively
bun test --parallel=1 test/e2e
bun test --parallel=1 test/e2e

# 7-8: the build gates, through Git bash, with the pins exported
export GBRAIN_VERSION=$(grep '^GBRAIN_VERSION=' .env | cut -d= -f2)
export HARNESS_VERSION=$(grep '^HARNESS_VERSION=' .env | cut -d= -f2)
"C:/Program Files/Git/bin/bash.exe" test/build/pin.test.sh
"C:/Program Files/Git/bin/bash.exe" test/build/harness-pin.test.sh
```

**Baseline to beat (measured 2026-09-18 on `830ca4c`, before any Slice 5 work):** `lint:forbidden` clean · `tsc --noEmit` clean · unit **628 pass / 0 fail** (2267 `expect()`, 46 files, 2.01s) · integration **434 pass / 1 skip / 0 fail of 435** (1804 `expect()`, 30 files, 62.49s) · both build gates **PASS both arms**. Contract and e2e baselines are in `PROGRESS.md`'s Slice 5 verification section.

**Plus, for this slice only:**

```bash
# Gate A runs in CI, on a runner with none of our images present.
# Locally it skips by design; forcing it here would down -v your stack.
CLEAN_INSTALL_E2E=1 bun test test/e2e/install.e2e.test.ts   # CI only
```

**Nothing is weakened to reach green.** If a number goes down, the reason is in `PROGRESS.md` before the commit that lowered it.

---

## Exit gate

Slice 5 is complete when all of the following are measured, not asserted:

1. **A host that has never seen this repository installs the product from the registry and reaches a healthy console** — Gate A, A1–A8, green in CI on a runner proven un-seeded.
2. **A production-shaped backup verifies its own quiesce** and says which lane proved it; an unverifiable quiesce refuses rather than claiming `true`.
3. **The wizard shows a measured cost ratio or says it was not measured** — never upstream's number presented as ours.
4. **`/spend` states its own coverage before its totals,** carries gbrain's `notCovered` list verbatim, and never sums the two meters.
5. **The nightly drift job has been seen to open an issue,** and seen not to open a second one.
6. **Restore to a new domain has been drilled,** with the grant-invalidation consequence measured and documented.
7. **Slice 3.5's rollback gate still passes on the renamed, re-published stack** (C9).
8. **The eight verification commands are green,** e2e twice consecutively, with verbatim tails in `PROGRESS.md`.
9. **The three frozen crypto strings are unchanged,** and `lint:forbidden` fails the build if anyone changes them.
10. **A release is tagged, published, and pulled by digest from a machine that did not build it.**

---

## Live-state warnings this slice inherits

- **The stored `anthropic_api_key` rotates out from under the stack.** Re-provision **after** a cycle, never before. Tasks 9, 12 and 17 all spend real money and all fail with `401 authentication_error` on a stale token, which looks like a code defect and is not one.
- **The brain is thin** — 3 Spaces, 6 pages, 6 chunks. Task 9's measurement may honestly produce `null`, and Task 17's C3–C5 legs start from very little content.
- **A restore or a quiesce leaves the runner DOWN by design.** Tasks 16 and 17 both trigger this. Bring it back with the CA export first.
- **`test/integration/quiesce.test.ts` drops the dev override's port publication.** Re-up before `test/contract` or `test/e2e`, every time.
- **`test/integration/agent-runs.test.ts` leaves a `capability_snapshots` row per run.** Carried, not fixed here.
- **The five schedules are DISABLED** and four carry `disabled_reason = "gate C upgrade window"`. Task 17's C9 will disable and restore writers again; confirm the state afterwards rather than assuming.

---

## Self-review — run this against the roadmap before Task 1

- [ ] Does any task fork gbrain, import past its `exports` map, read its tables, or screen-scrape CLI output? (Task 10 is the one that comes closest: it must go through `get_usage`, never `chat_usage_log`.)
- [ ] Does any task move a pin to make something pass? (Task 13's issue body says in words not to.)
- [ ] Does any task change one of the three frozen crypto strings? (Task 4 Step 3 makes that impossible to do silently.)
- [ ] Does any task weaken an existing assertion? Check Task 2's edit to `test/integration/backup.test.ts` especially — it **tightens** `quiesced` from truthy to a specific state, which is the right direction.
- [ ] Does any task give the runner a credential, a volume, a port, or a second network? (None should. D13.)
- [ ] Does any task present a number we did not measure as one we did? (D7 is the rule; Tasks 9 and 12 are where it binds.)
- [ ] Is every "verify X" step followed by the command that prints X?
- [ ] Is there a task for each of the five findings in the Context section? (1 → Tasks 5–7; 2 → Tasks 1–2; 3 → Tasks 9–12; 4 → Task 13; 5 → Tasks 4, 15.)
- [ ] Does anything here build a provisioner, a billing surface, or a pricing page? (It must not. That is the deferred slice.)
