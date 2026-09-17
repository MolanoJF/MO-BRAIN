# Slice 4 — Agent Runner: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.
>
> **Deliverable note.** This document IS the artifact. Commit it to the repo as
> `docs/superpowers/plans/2026-09-17-slice-4-agent-runner.md` as the first act of execution, then
> execute it on branch **`slice-4-agent-runner`**, cut from `main` at `641fbd8`.
>
> **Per-task test source is written at execution time**, following the Slice 3.5 pattern
> (`Step 1: write the failing test` with the source inline, `Step 2: implement`, `Step 3: run and
> paste real output`). This plan locks the interfaces, the decisions and the gates; it does not
> pre-write every assertion. Where an assertion is load-bearing it is stated here in full.
>
> **Predecessors — do not re-execute:** Slices 0, 1, 2, 3 and 3.5 are complete on `main`. Their
> plans are historical records. Start from [HANDOFF.md](../../../HANDOFF.md).

---

## Context — why this slice exists

Everything shipped so far makes the brain good at being written to by a human's own agent. Nothing
makes it work while nobody is watching. Slice 3 gave us a scheduler that can fire `gbrain_command`
jobs on time across a DST boundary; the second job type in the spec's scheduler table —
`agent_prompt` — has no executor. This slice builds it.

It is also the single largest security surface the product adds: a container that executes
model-driven code with the organization's keys, against the organization's knowledge base, at 3am,
unattended. The roadmap's risk register calls it out by name (risk 6), and every non-negotiable in
the roadmap's Slice 4 section is a mitigation for one specific way that goes wrong. The intended
outcome is not "an agent runs" — it is **"an agent ran, and here is exactly what it cost, exactly
what it changed, and the one button that undoes it."**

**Goal:** a scheduled `agent_prompt` runs in a sandboxed container that holds no credentials and can
reach exactly one host; every model call is metered and capped before the money is spent; the run
produces a record with cost, token counts, the tool calls it made and a diff of what moved in the
brain; and killing the runner mid-run loses nothing and double-writes nothing.

**Scope:** one job type (`agent_prompt`), one server-side harness (Claude Code headless, exactly
pinned), one model gateway, one diff mechanism (git), one revert. No multi-harness, no user-facing
prompt IDE, no managed cloud.

**Spec:** `C:\Users\juanp\.claude\plans\we-want-to-do-snug-wolf.md` § *Agent runner*, § *Scheduler*.
**Roadmap:** [`2026-09-14-brainstand-roadmap.md`](./2026-09-14-brainstand-roadmap.md) § *Slice 4*
(lines 221–241 are the canonical brief).

---

## Global Constraints

The roadmap's global constraints, cut to the ones that bite *this* slice. Every task's requirements
implicitly include this section.

- **G1 — Never fork. Pin exact semver.** This slice adds a **second** pinned dependency, the
  harness. It gets the same treatment gbrain gets: an exact version, a build ARG, a build-time smoke
  gate, and a `lint:forbidden` rule that makes a moving reference a CI failure.
- **G2 — Drive gbrain only through its published contracts.** The runner's data lane is HTTP MCP.
  Its control lane is our control plane, never gbrain's CLI. **Argv arrays, never shell strings** —
  that rule now covers `claude` as well as `gbrain`, and `lint:forbidden`'s `shell-string-gbrain`
  rule gains a sibling.
- **G3 — No reaching past the contracts.** Load-bearing here: we cannot make gbrain stamp its own
  git commits with our run id, and we will not patch it to. D9 is built around that limit, not
  around wishing it away.
- **G4 — Every registry entry is backed by a contract test at the pin.**
  `test/unit/registry.test.ts` enforces it mechanically. This slice adds at least one operation
  (`auth.revokeToken`, pending Task 1's probe).
- **G5 — An LLM may PROPOSE; it never executes privileged work.** Slice 3.5 applied this to
  migration playbooks. Slice 4 applies it to the runner: **an agent run is never a path to an
  upgrade, a schema change, a grant, a secret, or a compose operation.** The tool allowlist is
  closed and the network is the fence.
- **S2 — Privilege separation holds, and tightens.** The runner holds **no** brain DB URL, **no**
  control DB URL, **no** `GBRAIN_HOME`, **no** `OPS_RPC_TOKEN`, and **no** provider API key. It
  holds one bearer token for the control plane and, per run, one short-lived gbrain token.
- **S3b — Secrets stay envelope-encrypted.** The org's Anthropic key lives in `secrets` and is read
  only by the gateway, in-process, never logged, never written to the file plane (gbrain does not
  need it), never handed to the runner.
- **S3c — Never log a request body that can carry credentials.** The gateway proxies message bodies
  containing brain content and possibly secrets. It logs `{model, status, tokens, cost}` and
  nothing else. `lint:forbidden`'s `log-request-body` rule already exists; the gateway must not be
  the thing that trips it.
- **Never mount the Docker socket** into anything touching agent output. The runner is dispatched by
  long-poll. There is no code path in this slice that shells out to `docker`.
- **Caddy is the only service publishing host ports.** Do not add a `ports:` entry to anything.
- **Never weaken a test or a gate to make it pass.** If a gate is wrong, fix the gate in this plan
  with evidence and record it in `docs/slice-4-findings.md`.

**Entry gate (verify before Task 1):** Slice 3.5 exit gate green on `main` — all six commands, with
the baselines in the Verification section below.

---

## Prior-slice learnings folded in — do not rediscover these

| # | Learning | Source | How this slice uses it |
|---|---|---|---|
| L1 | `pg_advisory_lock` on a pooled handle leaks and fails to exclude — **reserve a connection** | Slice 1 / 3 | Any new lock use reserves, exactly like `src/ops/lock.ts:31` and `src/scheduler/leader.ts:27` |
| L2 | `CONTROL_DATABASE_URL` must be **defaulted inside each test file**, never required as an export | Slice 3 F1 | Every new DB-backed test file defaults it in its own header |
| L3 | `DECLARED_TABLES` is duplicated in **two** files | Slice 3 F2 | Task 4 updates `test/integration/auth.test.ts` **and** `test/integration/schema.test.ts` |
| L4 | An e2e `beforeAll` must wait on `/.well-known/gbrain` **200** as well as console health | Slice 3 F5 | Gates B and C inherit that readiness wait verbatim, plus a new runner-ready wait |
| L5 | `restore.e2e` runs first and cycles volumes with `down -v`; later files must tolerate a cold stack | Slice 3 / 3.5 | `slice4.e2e.test.ts` provisions its own fixture and never depends on state a prior file seeded |
| L6 | **An accepted flag is not an implemented flag** (`schema list` ignores `--json`; `embed --json` emits nothing) | Slice 0 / 3 R3 | Every new operation's `--json` support is proven by a contract test. Every `claude` flag this plan names is proven in Task 1, not assumed |
| L7 | gbrain prints prose before its receipt — read the **last balanced JSON value** | Slice 3 R4 | Any new ops parsing reuses `lastJsonValue`, never a first-brace slice |
| L8 | Exit **4** = `LOCK_LOST`, **143** = `128+SIGTERM` = timeout; `--detach` always exits 0 | Slice 0 | `classifyAgentExit` starts from `classifyExit`'s table rather than inventing a second vocabulary |
| L9 | A new control table must join `UNCOUNTED_TABLES` or the rollback digest-parity gate breaks | Slice 3.5 F3 | Task 14. Three new tables, three additions |
| L10 | **A table nothing writes passes its unit test and fails the exit gate** (`capability_snapshots` had no product writer for a whole slice) | Slice 3.5 F7 | Every table this slice adds has a named product writer, and Gate C proves the writer from an empty table |
| L11 | Claim is 20 hits / 15 min in-process; gbrain-serve's OAuth `/token` is 50 / 15 min | Slice 2 carried | A per-run token mint is a `/token` hit. Gate C budgets its mints and restarts services rather than `down -v` |
| L12 | `gbrain search` with a non-empty `--federated-read` treats that list as the **full** scope | Slice 2 carried | Gate C's read-isolation assertions qualify scope explicitly |
| L13 | A Space is visible to an unqualified read only when `config.federated` is literally `true` | Slice 3 F4 | Gate C's fixture is provisioned through the wizard path that sets it |
| L14 | **Run-row reasons are reconstructed, not stored**, and `blocked` is a state nothing writes | Slice 3 F14/F15 | Slice 4 needs failure reasons to be authoritative, so they go **on the row** (`agent_runs.failure_class` + `failure_detail`), never in a renderer |
| L15 | Report writes are **not** safe for two simultaneous writers of the same job + stamp | Slice 3 F17 | An agent run that writes a report holds the pre-held lock handle in `commitAs`; single-flight per write Space (D9) makes the collision unreachable anyway |
| L16 | **gbrain commits its own writes inside upstream code**; our repo lock narrows the window, it does not close it | `src/ops/git.ts:79-83` | This is the whole reason D9 reports attribution honestly instead of claiming precision |
| L17 | Bun snapshots `process.env` at start — a value rewritten under a running process is not seen | Slice 3.5 | The runner re-reads its pin and token from disk/args at claim time, never from a cached env read |

---

## Upstream reality this plan is built on

Two kinds of row. **Known** rows were read out of this repo or the read-only gbrain checkout during
planning and are cited. **Probe** rows are the ones this plan refuses to assume — Task 1 establishes
each one against the real binary before any product code is written, and records the answer in
`docs/slice-4-findings.md` using the `confirmed` / `contradicted` / `inference` vocabulary Slice 3
established.

| # | Claim | Kind | Consequence |
|---|---|---|---|
| U1 | The Claude Code headless CLI installs cleanly on `oven/bun:1.3.13` at an exact version, and `claude --version` reports it | **probe** | If it does not, the runner image needs a different base and Task 2's smoke gate changes shape |
| U2 | `--output-format stream-json` emits a line-delimited frame vocabulary that carries per-turn `usage` and tool-use blocks | **probe** | The event stream is the audit receipt and the token counts. If usage is absent from the stream, the gateway's meter becomes the **only** source and `agent_runs` tokens come from there |
| U3 | `ANTHROPIC_BASE_URL` routes **all** model traffic, and with the auto-updater and telemetry off the process makes no other outbound connection | **probe** | D6's egress fence makes a violation fail loudly rather than silently, but a harness that needs a second host changes the allowlist |
| U4 | `--mcp-config` accepts an HTTP MCP server with a static `Authorization` header (no interactive OAuth dance) | **probe** | This is how the per-run token reaches gbrain. If it requires the OAuth flow, the runner needs the client credentials instead of a bearer, which is a materially weaker posture — record it and re-decide |
| U5 | A CLI-minted gbrain token has a **revocable id** exposed on the grant receipt, and a CLI verb revokes it | **probe** | Decides D8's kill switch: revoke-token (preferred) vs. per-run ephemeral client + `auth revoke-client` (fallback) |
| U6 | An MCP `put_page` produces one or more git commits in the Space repo, with an author gbrain chooses | **probe** | Decides how much attribution D9 can honestly claim. `src/ops/git.ts:79-83` already says we do not control it |
| U7 | `claude` runs under a read-only rootfs given tmpfs at `$HOME` and the workspace | **probe** | Determines the exact tmpfs set in Task 3. A harness that needs a writable rootfs is a stop-the-line finding |
| U8 | gbrain-serve's `/mcp` accepts a bearer access token directly | **probe** | Slice 2 proved the thin-client-over-MCP path; this proves the raw-bearer path the harness needs |
| U9 | gbrain's `budget_usd_per_day` is metered **per OAuth client** in its own `mcp_spend_reservations` / `mcp_spend_log`, for *gbrain's* model calls | known (`gbrain/src/core/minions/budget-meter.ts`) | **Two different budgets.** Ours caps the harness's calls through our gateway; gbrain's caps gbrain's own. The UI must never conflate them |
| U10 | gbrain's `chat_usage_log` and `/admin/api/agents/spend` exist but sit behind `/admin`, which S1 does not route | known (`gbrain/src/schema.sql:867`, `serve-http.ts:1473`) | We do not read them. We meter our own gateway, which is the only place our harness's spend exists |
| U11 | `revokeLegacyTokenById` is **not** in our operations allowlist; only `auth.revokeClient` is | known (`src/contracts/registry.ts`) | Task 5 adds the operation with a contract test (G4), or takes the fallback |
| U12 | `readSecret` has **zero callers** in `src/` today — the wizard only ever writes | known (`src/control/secrets.ts`) | The gateway is its first reader. That path has never run in production; Task 7 proves it |
| U13 | There is **no MCP client** anywhere in our code — no JSON-RPC, no `tools/call` | known | The harness is our MCP client. We do not build one |
| U14 | There is **no container hardening and no internal network** anywhere in compose today | known (grep: zero matches for `read_only`, `cap_drop`, `internal:`) | `agent-runner` is the first. Every hardening directive is new, and `compose-invariants.test.ts` is where it gets pinned |

---

## Honesty rules the runner lane must encode

Each is a trust bug if violated, not a UX bug.

1. **A harness that reported success is not a successful run.** The receipt is the event stream plus
   the git range. A run with error frames or a non-zero exit is failed regardless of what its final
   assistant message says. We never render the agent's own self-assessment as the run's status.
2. **A tool flag is not a fence.** `--allowedTools` / `--disallowedTools` are defence in depth; the
   `internal: true` network is the fence. Both are asserted, and Gate C proves the network one from
   *inside the running container* — not from reading the compose file.
3. **A cost we could not price is not a cost of zero.** An unpriced model yields
   `cost_usd = null`, exactly as gbrain's own `chat_usage_log` does. And a null-cost call is
   budget-**unknowable**: the gateway refuses it rather than forwarding a call it cannot meter.
4. **A cap that stops the run after the money is spent is not a cap.** The meter checks before
   forwarding *and* mid-stream. "Exceeded" ends the run and alerts; it never silently truncates the
   agent's context and carries on.
5. **A dead runner's run is not a finished run.** `lease_expired` classifies as `infra_failed`, and
   the run's gbrain token is revoked by the **reclaimer**, not by the process that died.
6. **A diff we cannot attribute is reported as unattributed.** Commits in the range whose author is
   not the run's member are surfaced as `concurrent_writers`, never hidden, and the revert refuses
   without a second explicit confirmation.
7. **A revert that does not re-index is not a revert.** The git tree and the brain's index must both
   move back, or the page is gone from disk and still answering searches.
8. **"The runner is enabled" is not "the runner is connected."** Health distinguishes *disabled*,
   *enabled but never claimed*, and *claimed within the lease window*. Only the third is green.
9. **A per-run token that outlives its run is a leak.** Revocation happens on every exit path,
   including the one where the runner process no longer exists.
10. **A read Space that changed during a run is a finding, not a diff row.** Read isolation is the
    Slice 2 promise; a read Space moving under an agent run is an alert.
11. **A run we cannot show is not auditable.** Prompt, tool calls, token counts, cost and diff
    render in one page load or the feature is not done.

---

## Evidence requirements

- **Run the command; paste the real output.** `superpowers:verification-before-completion` applies to
  every "Run … Expected …" step. A step that was not run is not done.
- **A new registry entry needs a contract test at the pin** before `bun run operations:emit`.
  `test/unit/registry.test.ts` fails otherwise — that is the seam, not a convention.
- **Any deviation from this plan gets patched back into this file** as a
  `> **Corrected <date> — <what broke>.**` blockquote, the way Slice 1, 3 and 3.5 record theirs.
- **Every probe row (U1–U8) gets a status in `docs/slice-4-findings.md`** with the exact command and
  its verbatim output. A probe that could not discriminate is not a pass — Slice 3.5's P2 correction
  is the precedent.
- **Timings and costs are measured, not estimated.** Image build time, claim-to-first-token latency,
  the real dollar cost of Gate C's runs, and the lease-reclaim window all get recorded as real
  numbers. Gate C spends real money; budget it and say how much.

---

## File Structure

| File | Responsibility |
|---|---|
| `docker/agent-runner.Dockerfile` | **New.** Minimal harness image. `ARG HARNESS_VERSION` required; build-time `claude --version` smoke gate; non-root user; no gbrain, no bun app code beyond `src/runner` |
| `src/runner/main.ts` | **New.** Claim loop, lease heartbeat, SIGTERM drain. The runner's only entrypoint |
| `src/runner/client.ts` | **New.** Control-plane HTTP client: `claim`, `heartbeat`, `events`, `finish`. Bearer `RUNNER_TOKEN` |
| `src/runner/harness.ts` | **New.** `buildHarnessArgv`, `parseStreamJson`, `normalizeEvent`. Argv arrays only |
| `src/runner/workspace.ts` | **New.** `createWorkspace(runId)` / `destroyWorkspace` — per-run tmpfs dir, never reused |
| `src/runner/pin.ts` | **New.** `HARNESS_PIN`, `verifyHarnessPin()` — the runtime cross-check, mirroring `verifyRuntimePin` |
| `src/agent/types.ts` | **New.** `AgentRunSpec`, `AgentRunClaim`, `AgentRunEvent`, `FailureClass`, `DiffSummary` |
| `src/agent/claim.ts` | **New.** Control-plane side: `claimAgentRun`, `heartbeatAgentRun`, `finishAgentRun`, `recordEvents` |
| `src/agent/token.ts` | **New.** `serverClientFor(connection)`, `mintRunToken`, `revokeRunToken` |
| `src/agent/tools.ts` | **New.** `allowedToolsFor(connection, snapshot)` — the closed allowlist, intersected with `capability_snapshots.tools_json` |
| `src/agent/diff.ts` | **New.** `captureHeads`, `diffForRun`, `attributeCommits` |
| `src/agent/revert.ts` | **New.** `revertRun` — revert commit + re-index |
| `src/agent/classify.ts` | **New.** `classifyAgentExit`, `retryPolicyFor` |
| `src/gateway/pricing.ts` | **New.** `MODEL_PRICING` (pinned, per-MTok, incl. cache read/write), `priceUsage` returning `number \| null` |
| `src/gateway/meter.ts` | **New.** `accruedCost`, `assertBudget`, `recordUsage` |
| `src/gateway/proxy.ts` | **New.** Streaming passthrough + the mid-stream meter |
| `src/control/routes/runs.ts` | **New.** `POST /api/runs/claim`, `/:id/heartbeat`, `/:id/events`, `/:id/finish`; `GET /api/runs`, `/api/runs/:id`; `POST /api/runs/:id/revert` |
| `src/control/routes/gateway.ts` | **New.** `POST /api/gateway/v1/messages` |
| `src/console/pages/Runs.tsx` | **New.** Run list, run detail (prompt, tool calls, tokens, cost, diff), revert |
| `src/control/db/migrations/0005_*.sql` | **New.** Generated by drizzle-kit |
| `docs/runbooks/agent-runner.md` | **New.** The operator runbook |
| `docs/slice-4-findings.md` | **New.** A status on every probe row and everything execution surfaces |
| `test/contract/runner.contract.test.ts` | **New.** Gate A. Also the G4 coverage file for the new operation |
| `test/e2e/slice4.e2e.test.ts` | **New.** Gates B and C |
| `test/build/harness-pin.test.sh` | **New.** The image builds at the pin and **fails** at a bogus one |
| `src/control/db/schema.ts` | **Modify.** `schedules.jobType` + agent payload columns; `scheduleRuns` classification CHECK; `connections.serverClientId`; `agentRuns`, `agentRunEvents`, `agentRunUsage` |
| `src/scheduler/claim.ts` | **Modify.** `claimNextRun(workerId, nowMs, opts)` gains a `jobTypes` filter. Everything else unchanged |
| `src/scheduler/main.ts` | **Modify.** Claims `['gbrain_command']` only |
| `src/control/routes/schedules.ts` | **Modify.** `agent_prompt` create/validate; `409 runner_not_enabled` |
| `src/control/routes/health.ts` | **Modify.** The three-state runner block (honesty rule 8) |
| `src/control/app.ts` | **Modify.** Mount `runs` and `gateway` routes |
| `src/control/connections.ts` | **Modify.** Provision and revoke the server-side client alongside the member's |
| `src/contracts/registry.ts` | **Modify.** `auth.revokeToken` (pending U5) |
| `contracts/v0.50.5.0/operations.json` | **Regenerate.** `bun run operations:emit` |
| `src/ops/git.ts`, `src/ops/server.ts` | **Modify.** `/git/range` (read-only) and `/git/revert-range` |
| `src/upgrade/quiesce.ts` | **Modify.** `QUIESCE_ORDER` + `STOP_GRACE_S` gain `agent-runner`, first |
| `src/upgrade/digest.ts` | **Modify.** `UNCOUNTED_TABLES` gains the three new tables (L9) |
| `scripts/upgrade.ts` | **Modify.** Preflight refuses while an agent run is in flight — the check `quiesce.ts:19-23` already claims exists and does not |
| `compose/docker-compose.yml`, `.dev.yml` | **Modify.** `runner-net`, the hardened `agent-runner` service under a profile |
| `scripts/install.sh` | **Modify.** The runner question in plain words; fix the stale `0.50.0.0` default |
| `scripts/lint-forbidden.ts` | **Modify.** `moving-harness-pin` and `shell-string-harness` rules |
| `test/integration/compose-invariants.test.ts` | **Modify.** Every hardening directive gets pinned here |
| `test/integration/auth.test.ts`, `test/integration/schema.test.ts` | **Modify.** `DECLARED_TABLES` × 2 (L3) |
| `src/console/App.tsx`, `src/console/api.ts`, `src/console/pages/Access.tsx` | **Modify.** Nav, typed client, the plain-words warning |
| `.env.example`, `.github/workflows/contract.yml` | **Modify.** New vars; the stale `0.50.0.0` matrix entry |

---

## Design decisions locked before Task 1

Do not re-litigate these mid-execution. If execution proves one wrong, patch it here with a
`Corrected` blockquote and say why.

### D1 — The runner is a client of the control plane, never of the database

The runner holds `RUNNER_TOKEN` (constant-time compared, exactly like `OPS_RPC_TOKEN` in
`src/ops/server.ts`) and speaks HTTP. It has no `CONTROL_DATABASE_URL`, no brain DB URL, no
`GBRAIN_HOME`, no `OPS_RPC_TOKEN`, no provider key. Its identity is
`RUNNER_ID = ${HOSTNAME}-${uuid8}`, written to `schedule_runs.claimed_by` exactly as
`src/scheduler/main.ts:WORKER_ID` does. Scale is replicas.

This is not a stylistic choice: the runner is the one container in the stack that executes code an
LLM chose. Everything it can reach, it can be talked into reaching.

### D2 — One queue, two consumers

`agent_prompt` is a **`job_type` on `schedules`**, not a second queue. `schedule_runs` stays the
single run ledger. Materialization, IANA timezones, DST gap/ambiguity, catch-up policy, stagger
slots, quiet hours, overlap policy, the `(schedule_id, slot)` idempotency key, `lease_expires_at`,
`heartbeat()` and `reclaimExpiredLeases()` are **reused verbatim**.

`claimNextRun` gains one parameter:

```ts
export async function claimNextRun(
  workerId: string,
  nowMs: number,
  opts: { jobTypes: readonly JobType[] },
): Promise<ClaimedRun | 'none'>
```

The scheduler passes `['gbrain_command']`; `POST /api/runs/claim` passes `['agent_prompt']`. The
filter is applied inside the `FOR UPDATE SKIP LOCKED` select so a row of the wrong type is never
locked, never counted against the queue cap, and never starves the other consumer.

The payoff is direct: **the exit gate's "killing the runner mid-run reclaims the lease without
double-writing" is already implemented and already tested by Slice 3.** Slice 4 proves it for a new
consumer instead of rebuilding it. A run row that neither consumer can claim is a bug — Gate A
asserts the job-type set is total.

### D3 — Long-poll, not busy-poll, and not a socket

`POST /api/runs/claim` holds the request up to `RUN_CLAIM_WAIT_MS` (default **25000**, deliberately
under the common 30s proxy idle timeout), polling `claimAgentRun` on a short interval, and returns
`204 No Content` on timeout. The runner loops immediately. No websockets, no SSE, no Redis, no
Docker socket. A claim response carries everything the run needs and nothing it does not:

```ts
type AgentRunClaim = {
  runId: string; scheduleId: string; attempt: number;
  prompt: string; model: string; maxTokens: number;
  harnessVersion: string;              // must equal the runner's own pin or it refuses
  allowedTools: string[];              // closed list, already intersected (D5)
  mcp: { url: string; token: string }; // short-TTL gbrain token, minted at claim (D8)
  gateway: { url: string; token: string };
  budgetUsd: number;
  timeoutSeconds: number; leaseExpiresAt: string;
};
```

The claim response is the **only** place a secret crosses to the runner, it crosses over an internal
network, and both tokens die with the run.

### D4 — The harness is a pinned CLI, executed as argv, and its event stream is the receipt

`@anthropic-ai/claude-code` at an **exact** version (Task 1 establishes the package identity and a
version that installs). The image build gates on `claude --version` matching the ARG, exactly as
`docker/gbrain-base.Dockerfile:29-30` gates on `gbrain --version`. `lint:forbidden` gains
`moving-harness-pin`, the sibling of `moving-pin`.

The runner spawns it with an **argv array**, never a shell string —
`lint:forbidden`'s `shell-string-gbrain` rule gains `shell-string-harness`. `--output-format
stream-json` NDJSON is read line by line; each frame is normalized and inserted as an
`agent_run_events` row **after redaction** (`scrubOutput` from `src/docker/host.ts` is the existing
redactor; reuse it rather than writing a second one). `DISABLE_AUTOUPDATER=1` and telemetry off are
set in the image and asserted at build — a harness that updates itself at 3am is a moving pin with
extra steps.

`verifyHarnessPin()` is the runtime cross-check, mirroring Slice 3.5's `verifyRuntimePin` and
honesty rule 9 from that slice: the pin in the compose file is not evidence the binary moved. The
runner refuses a claim whose `harnessVersion` does not equal what `claude --version` reports.

### D5 — The tool surface is a closed allowlist; the network is the fence

`--mcp-config` names **exactly one** server: gbrain's `/mcp` over HTTP with the run's bearer.
`--allowedTools` is an explicit list of `mcp__gbrain__<tool>` names, computed by
`allowedToolsFor(connection, snapshot)` as the intersection of a hand-written product allowlist with
`capability_snapshots.tools_json` at the running pin — so an upstream tool addition does not silently
widen the surface, and an upstream removal does not produce a dangling grant.
`--disallowedTools` names Bash, Write, Edit and the rest of the built-in filesystem surface
explicitly, because deny-lists fail loudly when the vocabulary changes and allow-lists fail silently.
The permission mode is the non-interactive deny-by-default one (Task 1 confirms the flag's name and
behavior).

**None of that is the security boundary.** Honesty rule 2. The boundary is D6.

Enabling Bash is a distinct, higher-trust job class with its own approval — **it is out of scope for
this slice**, and `schedules` refuses to store it. Say so in the runbook rather than leaving a
half-built door.

### D6 — The runner reaches exactly one network, and that network has no route out

```yaml
networks:
  runner-net:
    driver: bridge
    internal: true        # no gateway, no NAT, no egress. The fence.
```

Members: `agent-runner`, `caddy` (with a network alias of `${DOMAIN}`), and `control-plane`.
`agent-runner` is on **no other network**, so it has no default route to the internet at all.

- `https://${DOMAIN}/mcp` → Caddy → `gbrain-serve`. Going through Caddy keeps `X-Forwarded-For`
  Caddy's job, which is the whole point of the `GBRAIN_HTTP_TRUST_PROXY=1` invariant — letting the
  least-trusted container speak to `gbrain-serve` directly would let it spoof its own client IP past
  the pre-auth rate limiter.
- `http://control-plane:3150/api/runs/*` and `/api/gateway/*` → direct, on the internal network.
  **These two surfaces are never routed publicly.** Caddy gains no new route, and the dispatch and
  gateway APIs have no internet-facing attack surface at all — the same posture S1 gives `/admin`.

Dev (`DOMAIN=localhost`) needs Caddy's local root CA in the runner via `NODE_EXTRA_CA_CERTS`;
production validates normally. Task 3 wires it; Gate B proves the MCP call works over TLS.

**Residual, stated rather than hidden:** putting `control-plane` on `runner-net` means the runner can
*address* every control-plane route, not just its two. Every other route is gated by `requireRole`,
which resolves a Better Auth session the runner has no way to obtain, and the runner's bearer is
accepted only by the two token-gated routes. Gate C asserts the runner gets `401` on `/api/members`.

### D7 — Model calls are proxied, and the meter is the enforcement point

`POST /api/gateway/v1/messages` on the control plane, Anthropic-shaped, streaming passthrough. The
runner sets `ANTHROPIC_BASE_URL` to it and `ANTHROPIC_AUTH_TOKEN` to the per-run gateway token
(stored hashed, burned at run end — the same shape `claim_links` already uses).

Order of operations, and the order is the decision:

1. **Before forwarding:** `assertBudget(runId)` — if `accruedCost(runId) >= agentRuns.budgetUsd`,
   refuse with a 402-shaped body, mark the run `budget_exceeded`, raise an alert, and do not open
   an upstream connection. Honesty rule 4.
2. **Resolve the key:** `readSecret(orgId, 'anthropic_api_key')`. In-process, never logged, never
   handed to the runner, never written to the file plane (gbrain has no use for it — this is the one
   provider key that lives *only* in `secrets`). U12: this is `readSecret`'s first caller.
3. **Forward and stream.** Parse the usage frames as they pass; price them with
   `MODEL_PRICING`; insert `agent_run_usage`.
4. **Mid-stream:** if accrued cost crosses the cap during the stream, close the upstream connection
   and terminate the run. A cap that only fires between requests is not a cap for a single expensive
   request.
5. **Unpriced model → `cost_usd = null` and a refusal.** Honesty rule 3. gbrain's own
   `chat_usage_log` writes `NULL` rather than a fake `0`; we do the same, and we go further: a call
   we cannot price is a call we cannot cap, so we do not make it.

Model ID, `max_tokens` and effort are pinned **per schedule** (reproducibility — the spec's "pin
harness version and model ID per schedule"). Default `claude-opus-5`. `MODEL_PRICING` is a pinned
table in our source with a `pricedAt` date, not a live lookup; a model absent from it is unpriced by
definition, which is the honest failure mode.

**U9 is the trap to avoid:** gbrain's `budget_usd_per_day` is a per-OAuth-client cap on *gbrain's
own* model calls, metered by gbrain in its own tables. Ours caps *the harness's* calls through our
gateway. They are different budgets on different money. The UI labels both and conflates neither.

### D8 — Two gbrain clients per Connection; the server-side one is per-run and revoked

`connections` gains `server_client_id`. The server client is provisioned alongside the member's, with
**identical compiled scoping** (`compileConnection` is reused unchanged — same write Space, same
`federatedRead`, same `boundSlugPrefixes`, same profile) and a minutes-long `tokenTtl`. Its secret
lives in `secrets` under `connection:<id>:server_client`. `revokeConnection` revokes both, in the
same audit-before-delete order it already uses.

Per run: mint at claim, revoke at finish — on **every** exit path, including `reclaimExpiredLeases`
reclaiming a run whose runner is gone (honesty rule 5, 9). TTL is defence in depth, not the
mechanism.

**Which mechanism mints and revokes is U5's probe.** Preferred: the grant receipt carries a token id
and `gbrain auth revoke --id <uuid>` kills it (Task 5 adds `auth.revokeToken` to the registry with a
contract test, per G4 — U11 says it is not there today). Fallback, taken only on probe evidence: a
per-run ephemeral client (`mcp grant` a throwaway name, `auth revoke-client` at the end) — more
`/token` traffic, watch L11's rate limit, same guarantee.

### D9 — The brain diff is the git range, attributed as honestly as the contracts allow

Before the run, record `git rev-parse HEAD` for the write Space **and every read Space**. After,
record them again. The diff is `git log` + `git diff --name-status <before>..<after>` through a new
read-only ops endpoint `/git/range` (`SOURCE_ID_RE`-validated, under `withRepoLock`).

**We cannot stamp a commit with our run id.** gbrain commits its own writes inside upstream code and
we do not patch upstream — `src/ops/git.ts:79-83` says exactly this, and G3 forbids the fix. So:

- **Single-flight per write Space.** `claimAgentRun` refuses to claim an `agent_prompt` run while
  another agent run holds the same write Space. That removes *our* concurrency from the range.
- **Other writers are reported, not assumed away.** A commit in the range whose author is not the
  run's member sets `diffSummary.concurrentWriters = true` and is listed. The console says
  *"2 of 5 commits in this range were not written by this run"* rather than presenting all five as
  the agent's work. Honesty rule 6.
- **A read Space whose range is non-empty is an alert**, not a diff row. Honesty rule 10.

### D10 — Revert is a new commit plus a re-index, never a history rewrite

`POST /api/runs/:id/revert` (admin only):

1. ops `git revert --no-commit <before>..<after>` in the write Space, under the repo lock;
2. `commitAs(sourceId, actor = the acting admin, "revert: agent run <runId>")` — the audit story is
   that a named human reverted it, not that "the system" did;
3. `sync` + `embed --stale` through the normal scheduler command path, so the brain's index moves
   back with the tree. Honesty rule 7: a reverted file that still answers searches is not reverted.

Refusals, all of them explicit `{ error: ... }` codes the console renders as choices:
`revert_conflict` (the range does not revert cleanly — surface it, never force),
`revert_concurrent_writers` (the range contains commits this run did not write — requires a second
confirmation with `?confirm=concurrent`), `already_reverted`. Record `agent_runs.reverted_at` and
`revert_commit`. Nothing auto-reverts, ever.

### D11 — Retries are classified, and the default is not to retry

Agent runs are not idempotent. `schedule_runs.attempt` already exists; use it.

| Failure class | Cause | Policy |
|---|---|---|
| `infra_failed` | lease lost, runner OOM/killed, gateway network error, harness spawn failure | **Retry**, cap **2** |
| `budget_exceeded` | D7's meter refused | **Never retry.** Alert |
| `timeout` | exceeded `timeoutSeconds` (exit 143, L8) | **Never retry.** Alert |
| `agent_failed` | harness exited non-zero, or the stream carried error frames | **Never retry.** Surface |
| `refused` | no active Connection, no runner, harness pin mismatch | **Never retry.** Surface |

A retry is a **new `schedule_runs` row** with `attempt = n+1` and slot `<slot>#r<n+1>`, so the
UNIQUE `(schedule_id, slot)` idempotency key still holds and the failed attempt stays in history
rather than being overwritten. Prefer upsert-by-slug writes in the prompt contract so a retry that
redoes work converges instead of duplicating.

**L14 applies:** the failure class lives on the row (`agent_runs.failure_class` +
`failure_detail`), never reconstructed by a renderer. Slice 3 got that wrong and said so.

### D12 — The runner is optional, and the product says what it is in plain words

`agent-runner` ships under a compose **profile** (`profiles: ["runner"]`), off by default. A
deployment that only connects members' own agents omits it and loses nothing else.
`scripts/install.sh` asks in plain words — *"This container runs model-written code against your
brain, using your organization's API key, on a schedule, with nobody watching. Enable it?"* — and
writes `COMPOSE_PROFILES` accordingly. The Access page carries the same sentence.

`/api/health` reports three states, not two (honesty rule 8):
`runner: { state: 'disabled' | 'never_claimed' | 'connected', lastSeenAt, version }`.
Enabling an `agent_prompt` schedule with no runner ever seen returns `409 runner_not_enabled`.

### D13 — The runner is quiesced first, and is never a path to an upgrade

```ts
export const QUIESCE_ORDER = [
  'agent-runner', 'scheduler', 'gbrain-worker', 'control-plane', 'gbrain-serve', 'gbrain-ops',
] as const;
```

The runner stops **before** the scheduler, because it is the one consumer that keeps writing to the
brain after the scheduler stops materializing. `STOP_GRACE_S` gains its entry (a drain long enough
for one in-flight harness to be SIGTERMed and its token revoked). `SWAP_SERVICES` does **not** gain
it — the runner image carries no gbrain binary, so a gbrain pin move does not rebuild it.

`UNCOUNTED_TABLES` in `src/upgrade/digest.ts` gains `agent_runs`, `agent_run_events` and
`agent_run_usage`, or the rollback digest-parity gate breaks exactly the way `schedule_runs` did
(L9 / Slice 3.5 F3).

And a real pre-existing gap gets closed: `src/upgrade/quiesce.ts:19-23` claims *"Task 11 preflight's
job (refuse the upgrade while a `schedule_runs` row is `running`)"*, and **no such check exists** —
`PreflightDeps` in `scripts/upgrade.ts` has no in-flight-run dependency. It was survivable while the
only runs were short gbrain commands. It is not survivable when a run can be a 20-minute agent
writing pages, because that is precisely the inconsistency the snapshot exists to prevent. Task 14
adds it, and records it in the findings doc as a Slice 3.5 defect Slice 4 found.

**G5, restated for this lane:** an agent run is never a path to an upgrade, a schema mutation, a
grant, a secret read, or a compose operation. The allowlist in D5 excludes every one of them, and
the network in D6 makes the exclusion structural.

---

## Task index and interface map

Tasks are executed in order. Dependencies are expressed only through `Consumes:` / `Produces:`.

| # | Task | Produces (symbols other tasks consume) |
|---|---|---|
| 1 | Probe the harness and the token lane — throwaway, no product code | findings P1–P9; the go/no-go on U1–U8; the D8 mechanism decision |
| 2 | Runner image + harness pin plumbing | `docker/agent-runner.Dockerfile`, `HARNESS_PIN`, `verifyHarnessPin`, `moving-harness-pin`, `shell-string-harness`, `test/build/harness-pin.test.sh` |
| 3 | Compose: `runner-net`, the hardened service, the profile | the `agent-runner` service; `runner-net`; compose-invariant assertions |
| 4 | Control DB: job type, agent tables, classification, server client | `jobType`, `agentRuns`, `agentRunEvents`, `agentRunUsage`, `connections.serverClientId`, migration `0005_*` |
| 5 | Two clients per Connection + the per-run token lane | `serverClientFor`, `mintRunToken`, `revokeRunToken`, `auth.revokeToken` registry entry |
| 6 | Dispatch: job-type filter + `/api/runs/*` | `claimNextRun(…, {jobTypes})`, `claimAgentRun`, `heartbeatAgentRun`, `recordEvents`, `finishAgentRun`, the routes |
| 7 | The model gateway + the meter | `MODEL_PRICING`, `priceUsage`, `accruedCost`, `assertBudget`, `recordUsage`, `/api/gateway/v1/messages` |
| 8 | The runner process | `src/runner/*`, `buildHarnessArgv`, `parseStreamJson`, `createWorkspace`, `allowedToolsFor` |
| 9 | The brain diff | `/git/range`, `captureHeads`, `diffForRun`, `attributeCommits`, `DiffSummary` |
| 10 | Revert | `/git/revert-range`, `revertRun`, the refusal codes |
| 11 | Retry classification + alerts | `classifyAgentExit`, `retryPolicyFor`, the new alert kinds |
| 12 | Schedules: the `agent_prompt` shape | schedule create/validate, presets, `409 runner_not_enabled` |
| 13 | Console: Runs page, Schedules extension, the Access warning | `Runs.tsx`, `runApi` |
| 14 | Upgrade-lane integration | `QUIESCE_ORDER`, `STOP_GRACE_S`, `UNCOUNTED_TABLES`, the preflight in-flight refusal |
| 15 | **Gate A** — the seam, headless | `test/contract/runner.contract.test.ts` A1–A10 |
| 16 | **Gate B** — HTTP end to end | `test/e2e/slice4.e2e.test.ts` B1–B12 |
| 17 | **Gate C** — the Slice 4 exit gate | C1–C12 |
| 18 | Findings, runbook, progress, handoff, six commands | `docs/slice-4-findings.md`, `docs/runbooks/agent-runner.md` |

---

## The tasks

Each task follows the repo's established rhythm: **Files** (Create / Modify / Test) → **Interfaces**
(Consumes / Produces) → `Step 1: write the failing test` → `Step 2: implement` → `Step 3: run it and
paste the real output` → commit. Only the substance specific to each task is given below.

### Task 1 — Probe the harness and the token lane (throwaway; no product code)

Creates `docs/slice-4-findings.md` with rows P1–P9 and nothing else. This task builds nothing. It
exists because U1–U8 are assumptions and Slice 3.5's P2 correction is the cautionary tale: a probe
that cannot discriminate between the two outcomes is not evidence.

- **P1** — Build a throwaway image from `oven/bun:1.3.13` installing the harness at an exact
  version. Record the package identity, the version that installs, the wall-clock build time, and
  that `claude --version` reports the pinned value. **If it does not install, stop** and report.
- **P2** — Run `claude -p "say hi" --output-format stream-json` against a scratch key. Record the
  **complete frame vocabulary** verbatim: every `type`, whether `usage` appears per turn, whether a
  cumulative cost field exists, and what a tool-use block looks like. This is the audit receipt's
  schema; guessing it is how Task 8 fails.
- **P3** — Re-run with `ANTHROPIC_BASE_URL` pointed at a local recorder and no real key.
  **Discriminating check:** the recorder must see the request *and* the process must make no other
  outbound connection. Prove the second half by running it in a container whose only route is the
  recorder and asserting the run still completes. Record the auto-updater and telemetry env vars
  that silence the rest.
- **P4** — `--mcp-config` with an HTTP server and a static `Authorization` header against a stub MCP
  server. Record whether the header is sent as given or whether an OAuth negotiation is attempted.
- **P5** — Read-only rootfs: run the harness with `--read-only` and incrementally add tmpfs mounts
  until it succeeds. Record the **minimal** writable set. A harness that needs a writable rootfs is
  a stop-the-line finding.
- **P6** — Against the live dev stack: `gbrain mcp grant … --token-ttl 900 --json`, and record the
  receipt's full key set. **Does it carry a revocable token id?** Then try
  `gbrain auth revoke --id <that id> --json` and record the exit code and output. This decides D8.
- **P7** — Mint a token by whatever P6 established and call gbrain-serve's `/mcp` with it as a
  bearer, from inside `gbrain-ops`. Record whether a raw bearer is accepted (U8).
- **P8** — Write one page over `/mcp` as a granted client, then `git log -1 --format=%an|%ae|%s` in
  that Space repo. Record the **author, committer and message gbrain chooses** (U6). This is the
  ceiling on D9's attribution, and the number that decides how loudly the console hedges.
- **P9** — Record `MODEL_PRICING`'s source and `pricedAt` date for every model this slice will
  permit, and confirm the usage field names in P2's frames map onto it (input, output, cache read,
  cache write).

Record every row with the exact command and verbatim output. Any contradiction becomes a
`contradicted` status and a note about which downstream task changes shape.

### Task 2 — Runner image and harness pin plumbing

Mirror `docker/gbrain-base.Dockerfile` in structure, not in content. `ARG HARNESS_VERSION` is
required (`RUN test -n "$HARNESS_VERSION" || exit 1`); the build ends with a smoke gate that fails
the build on a version mismatch; `USER` is non-root; `ENV DISABLE_AUTOUPDATER=1` plus whatever P3
established; `ENTRYPOINT ["/usr/bin/tini","--"]`.

`src/runner/pin.ts` exports `HARNESS_PIN` and `verifyHarnessPin()`, mirroring `src/contracts/pin.ts`.
`scripts/lint-forbidden.ts` gains two rules with the same shape as the existing five —
`moving-harness-pin` (a harness reference resolving to a tag rather than an exact version) and
`shell-string-harness` (a `sh -c` invocation of `claude`). `test/build/harness-pin.test.sh` builds
at the pin and **fails** at a bogus version, exactly as `test/build/pin.test.sh` does.

### Task 3 — Compose: `runner-net`, the hardened service, the profile

The first hardened service in this stack (U14). All of it is new, and all of it gets pinned in
`test/integration/compose-invariants.test.ts`:

```yaml
agent-runner:
  profiles: ["runner"]
  image: brainstand/agent-runner:${HARNESS_VERSION:?required}
  command: ["bun","run","/app/src/runner/main.ts"]
  networks: [runner-net]
  read_only: true
  user: "10001:10001"
  security_opt: ["no-new-privileges:true"]
  cap_drop: ["ALL"]
  pids_limit: 256
  mem_limit: 2g
  cpus: 1.0
  tmpfs: [/home/runner, /workspace, /tmp]
  stop_grace_period: 60s
  environment:
    RUNNER_TOKEN: ${RUNNER_TOKEN:?required}
    CONTROL_URL: http://control-plane:3150
    HARNESS_VERSION: ${HARNESS_VERSION:?required}
    NODE_EXTRA_CA_CERTS: /etc/ssl/caddy-root.crt   # dev only; see D6
  volumes: []     # none. Ever.
```

Assertions the invariant test must carry, each one a live bug if violated: `runner-net.internal` is
`true`; `agent-runner.networks` is exactly `['runner-net']`; it mounts no volumes; it has no
`ports:`; its environment contains no `*DATABASE_URL`, no `GBRAIN_HOME`, no `OPS_RPC_TOKEN`, no
`ENCRYPTION_KEY`, no `*_API_KEY`; `caddy` and `control-plane` are also on `runner-net`; `caddy` has a
`${DOMAIN}` alias there; the profile is `runner` so a default `up` omits it; and `read_only`,
`cap_drop: [ALL]`, `no-new-privileges`, `pids_limit`, `mem_limit` and a non-root `user` are all
present. Also assert **no other service** gained a `ports:` entry.

### Task 4 — Control DB: job type, the agent tables, the classification vocabulary

`schedules` gains `jobType` (`'gbrain_command' | 'agent_prompt'`, default `gbrain_command`, CHECK)
and the agent payload: `agentPrompt` (text, thin — a pointer at a skill, not an inlined essay, per
the spec), `agentModel`, `agentMaxTokens`, `agentBudgetUsd`, `agentHarnessVersion`. A CHECK enforces
`shape_matches_job_type`: `agent_prompt` rows require the agent columns and forbid `operation`;
`gbrain_command` rows require `operation` and forbid the agent columns. The existing
`shape_matches_kind` CHECK is untouched — `kind` is the *timing* shape and stays orthogonal.

`scheduleRuns.classification`'s CHECK gains `budget_exceeded`, `agent_failed`, `infra_failed`.

`connections` gains `serverClientId`.

Three new tables, each with a **named product writer** (L10) and a `UNIQUE (runId, seq)` where the
reconciler pattern applies (`upgrade_events` is the shape to copy):

- `agent_runs` — PK `runId` → `schedule_runs.id` (cascade), `organizationId`, `connectionId`,
  `model`, `harnessVersion`, `budgetUsd`, `costUsd` (nullable — honesty rule 3), `inputTokens`,
  `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `numTurns`, `failureClass`,
  `failureDetail` jsonb, `diffSummary` jsonb, `revertedAt`, `revertCommit`, `tokenRevokedAt`.
- `agent_run_events` — `runId` (cascade), `seq`, `at`, `kind`, `data` jsonb (**redacted**),
  UNIQUE `(runId, seq)`.
- `agent_run_usage` — `runId` (cascade), `seq`, `at`, `model`, the four token counts,
  `costUsd` (nullable), `stopReason`, `httpStatus`, UNIQUE `(runId, seq)`. This table is the
  budget's authority; `agent_runs.costUsd` is its rollup and must equal `SUM` at finish (Gate C
  asserts the equality, which is what makes the rollup trustworthy).

Migration `0005_*.sql` via drizzle-kit. **L3: update `DECLARED_TABLES` in both**
`test/integration/auth.test.ts` and `test/integration/schema.test.ts`.

### Task 5 — Two clients per Connection, and the per-run token lane

Extend `provisionConnection` to mint the server-side client with the same `compileConnection` output
and a minutes-long TTL, storing its secret via `storeSecret(orgId, 'connection:<id>:server_client',…)`.
Extend `revokeConnection` to revoke both, preserving its deliberate audit-before-delete ordering.
Add `auth.revokeToken` to `src/contracts/registry.ts` with a contract test at the pin (G4), then
`bun run operations:emit`. Take D8's fallback **only** if Task 1's P6 says so, and record why.

`mintRunToken(connectionId, ttlSeconds)` and `revokeRunToken(runId)` are idempotent — `revokeRunToken`
on an already-revoked run is a no-op that still stamps `tokenRevokedAt`, because it is called from
both the finish path and the reclaim path and they can race (honesty rule 9).

### Task 6 — Dispatch

`claimNextRun` gains the `jobTypes` filter **inside** the `FOR UPDATE SKIP LOCKED` select. Everything
else in `src/scheduler/claim.ts` — the overlap policies, the queue cap, the kill-previous path, the
disabled-schedule refusal — is untouched and must stay untouched; its existing integration tests are
the regression proof.

`claimAgentRun` wraps it with the agent-specific preconditions, each a distinct refusal:
the Connection is `active`; no other agent run holds this write Space (D9's single-flight); a runner
has been seen; the claim's `harnessVersion` matches. On success it mints the run token (Task 5),
captures the pre-run heads (Task 9), inserts the `agent_runs` row and returns an `AgentRunClaim`.

Routes in `src/control/routes/runs.ts`, all gated by the constant-time `RUNNER_TOKEN` bearer except
the two human ones, which use the existing `guard()` idiom from `src/control/routes/upgrades.ts`:

| Route | Auth | Notes |
|---|---|---|
| `POST /api/runs/claim` | runner bearer | Long-polls to `RUN_CLAIM_WAIT_MS`; `204` on timeout |
| `POST /api/runs/:id/heartbeat` | runner bearer | Wraps `heartbeat()`; `409` when the lease was stolen or cancel was requested |
| `POST /api/runs/:id/events` | runner bearer | Batched, idempotent on `(runId, seq)` |
| `POST /api/runs/:id/finish` | runner bearer | Classifies, revokes the token, captures post-run heads, computes the diff |
| `GET /api/runs`, `GET /api/runs/:id` | `viewer` | **The projection IS the contract** — the run detail returns prompt, events, usage and diff; it never returns the run token, the gateway token, or a raw model request body |
| `POST /api/runs/:id/revert` | `admin` | Task 10 |

### Task 7 — The model gateway and the meter

`src/gateway/pricing.ts` is a pinned table with a `pricedAt` date and per-MTok input / output /
cache-read / cache-write rates. `priceUsage(model, usage): number | null` — `null` for an unknown
model, never `0`.

`src/gateway/proxy.ts` implements D7's five-step order exactly. The streaming half is the part to
get right: parse usage frames as they pass through rather than buffering the response, so a single
runaway request is capped mid-flight rather than after. On a mid-stream cap crossing, close the
upstream, emit a terminal event, and mark the run `budget_exceeded`.

**S3c is load-bearing here.** This proxy carries message bodies containing brain content. It logs
`{runId, model, status, tokens, costUsd}` and nothing else; `lint:forbidden`'s `log-request-body`
rule must stay clean with the gateway in the tree.

### Task 8 — The runner process

`src/runner/main.ts`: claim → create workspace → build argv → spawn → stream → finish → destroy
workspace → loop. SIGTERM sets a drain flag: finish the in-flight run, do not claim another, exit 0.

`createWorkspace(runId)` makes a fresh directory under the `/workspace` tmpfs and
`destroyWorkspace` removes it on **every** path including throw. Never reused, never a bind mount of
`GBRAIN_HOME` or the brain repos.

`buildHarnessArgv` is a pure function taking `AgentRunClaim` and returning `string[]` — pure so it is
unit-testable without a container, which is how every other argv builder in this repo is tested
(`src/contracts/argv.ts` is the precedent). It refuses any claim whose `allowedTools` is empty, and
any claim asking for a tool outside the closed list.

`parseStreamJson` is a line-oriented NDJSON parser tolerant of partial final lines. Each frame is
normalized, redacted with `scrubOutput`, sequenced, and batched to `/api/runs/:id/events`.

### Task 9 — The brain diff

`/git/range` on `src/ops/server.ts`: read-only, `SOURCE_ID_RE`-validated, returns
`{ commits: [{sha, author, email, subject, at}], files: [{status, path}] }` for
`<before>..<after>`. `captureHeads(spaces)` runs at claim; the pair is stored on `agent_runs`.
`diffForRun` builds `DiffSummary`, and `attributeCommits` sets `concurrentWriters` from P8's
established author shape. A non-empty range on a **read** Space raises an alert rather than
appearing in the diff (honesty rule 10).

### Task 10 — Revert

`/git/revert-range` on ops, under the repo lock; `revertRun` orchestrates revert → `commitAs(admin)`
→ `sync` + `embed --stale`. The three refusal codes from D10 are explicit and rendered as choices by
the console, in the established `{ error, …context }` style (`{error:'slot_taken', nextFree}` is the
precedent).

### Task 11 — Retry classification and alerts

`classifyAgentExit` starts from `src/scheduler/execute.ts`'s `classifyExit` table (L8) rather than
inventing a second vocabulary. `retryPolicyFor` implements D11's table. New alert kinds join the
existing set in `schedule_alerts`: `agent_budget_exceeded`, `agent_run_failed`,
`agent_read_space_moved`, `runner_never_seen`, `harness_pin_mismatch`.

### Task 12 — Schedules: the `agent_prompt` shape

`POST /api/schedules` accepts `jobType: 'agent_prompt'` with its payload, validated the way
`validateParams` validates command params — refuse unknown fields, refuse out-of-range budgets,
refuse a model absent from `MODEL_PRICING` (honesty rule 3, enforced at creation rather than at 3am),
refuse Bash-enabling options outright (D5). `409 runner_not_enabled` when no runner has ever been
seen. Quiet hours, stagger and the one-sub-hourly-lane rule apply unchanged. Add one preset —
a nightly briefing-style `agent_prompt` — and encode the cron guide's own advice: don't over-cron.

### Task 13 — Console

`Runs.tsx` follows `Upgrades.tsx` exactly: **pure exported functions first, component last**, because
that is what the unit tests import (there is no DOM harness in this repo). List view, then a detail
view that renders prompt, the tool-call timeline, token counts, cost, the diff, and the revert
button with its confirmation. `runApi` in `src/console/api.ts` is the adapter layer, the same way
`upgradeApi` normalizes `endedAt` → `finishedAt`. Nav entry and `pageFromPath` branch in `App.tsx`.
The Access page gains D12's plain-words sentence.

### Task 14 — Upgrade-lane integration

`QUIESCE_ORDER`, `STOP_GRACE_S`, `UNCOUNTED_TABLES`, and the preflight in-flight-run refusal from
D13. Record the preflight gap in the findings doc as a Slice 3.5 defect this slice found — do not
fix it silently.

### Task 15 — Gate A: the seam, headless (`test/contract/runner.contract.test.ts`)

A1 `buildHarnessArgv` produces the exact expected argv for a representative claim, and refuses an
empty allowlist. A2 `allowedToolsFor` is the intersection, and is empty-safe when the snapshot is
missing. A3 `parseStreamJson` handles the real P2 frames, including a partial final line. A4
`priceUsage` returns `null` for an unknown model and the right number for a known one. A5
`assertBudget` refuses at exactly the cap, not after. A6 `classifyAgentExit` covers every exit path
including 143 and 4. A7 `retryPolicyFor` retries only `infra_failed`, cap 2. A8 the new registry
entry's `--json` support is proven against the real binary at the pin (G4, L6). A9 `claimNextRun`'s
`jobTypes` filter is total — the union of the two consumers' sets covers every value the CHECK
permits. A10 `verifyHarnessPin` fails on a mismatch.

### Task 16 — Gate B: HTTP end to end (`test/e2e/slice4.e2e.test.ts`, B1–B12)

Same skeleton as `slice35.e2e.test.ts`: the `host-ops-env.ts` prelude first, `CONTROL_DATABASE_URL`
defaulted in-file (L2), the readiness wait on console health **and** `/.well-known/gbrain` (L4), the
anti-silent-skip tripwire, and no `down -v` anywhere. Adds a runner-ready wait.

B1 the runner claims and `claimed_by` is the runner id, not the scheduler's. B2 `204` on an empty
long-poll within the window. B3 heartbeat extends the lease; a stolen lease returns `409`. B4 events
are idempotent on `(runId, seq)`. B5 the gateway refuses without a valid run token. B6 the gateway
meters a real call and `agent_run_usage` gains a row. B7 finish revokes the run token and stamps
`tokenRevokedAt`. B8 the run detail projection excludes both tokens and any raw request body. B9 the
scheduler does **not** claim an `agent_prompt` row and the runner does **not** claim a
`gbrain_command` row. B10 `409 runner_not_enabled` on a fresh stack with no runner. B11 an unpriced
model is refused at schedule creation. B12 `/api/health` reports all three runner states correctly.

### Task 17 — Gate C: the Slice 4 exit gate

**The exit gate, roadmap verbatim:**

> a nightly `agent_prompt` produces a run record with cost, token counts and a brain diff;
> **killing the runner mid-run reclaims the lease without double-writing**; exceeding the budget cap
> stops the run and alerts rather than silently truncating.

| # | Leg |
|---|---|
| C1 | A nightly `agent_prompt` materializes at its slot in org-local time, through the unmodified Slice 3 materializer |
| C2 | The runner claims it; `claimed_by` is the runner, and the scheduler never touched the row |
| C3 | The run completes. `agent_runs.costUsd` is non-null, the four token counts are non-zero, and **`costUsd` equals `SUM(agent_run_usage.costUsd)`** — the rollup is proven, not asserted |
| C4 | The write Space's git range is non-empty and names the files; **every read Space's range is empty** |
| C5 | `GET /api/runs/:id` returns prompt, tool calls, tokens, cost and diff in **one** response (honesty rule 11) |
| C6 | Revert: the file returns to its pre-run content, a revert commit exists authored by the admin, and a subsequent `search` no longer returns the reverted page (honesty rule 7) |
| C7 | `docker compose kill agent-runner` mid-run → the lease expires → `reclaimExpiredLeases` marks `lease_expired` / `infra_failed`, **the run token is revoked by the reclaimer**, and an alert exists |
| C8 | **The double-write proof.** After C7's reclaim and one retry, the write Space contains exactly **one** copy of the page, and `schedule_runs` holds two rows with `attempt` 1 and 2 and distinct slots |
| C9 | A schedule with a cap below the first call's cost → the gateway refuses **before forwarding**, the run ends `budget_exceeded`, an alert exists, and `agent_run_usage` shows zero completed calls — not a truncated one |
| C10 | **The fence, proven from inside.** From within the running container, a connection to any host other than Caddy and `control-plane` fails. Asserted by execution, never by reading the compose file (honesty rule 2) |
| C11 | A prompt that explicitly asks for Bash yields a denied-tool event, not an execution |
| C12 | The runner is optional: a default `up` (no `runner` profile) leaves the stack healthy, `/api/health` reports `disabled`, and enabling an `agent_prompt` schedule returns `409` |

**C10 is the leg that makes D6 real rather than declared**, and C8 is the one the roadmap calls out
by name. Neither may be softened.

**Gate C spends real money.** Budget it before running, record the actual dollar figure in the
findings doc, and prefer the cheapest model that still exercises tool use for the legs that do not
specifically test model choice.

### Task 18 — Findings, runbook, progress, handoff

`docs/slice-4-findings.md` (every probe row's status, every defect execution surfaced, Gate C's
measured numbers and real cost), `docs/runbooks/agent-runner.md` (enable/disable, "what did the 3am
agent do", how to revert, how to kill a run, how to rotate the Anthropic key, what a
`runner_never_seen` health state means, and what **not** to do), `PROGRESS.md`, `HANDOFF.md` (the
state table, the live-state block, the quick reference), and the roadmap (mark Slice 4's plan link
and status; update Slice 5's entry gate).

---

## Verification

**The six commands**, with the Slice 3.5 closing baselines every count must meet or exceed with
**0 fail**:

```bash
bun run lint:forbidden      # clean
bunx tsc --noEmit           # clean
bun test test/unit          # ≥ 421 pass / 0 fail
bun test test/integration   # ≥ 314 pass + 1 skip (win32 0600 opt-out) / 0 fail
bun test test/contract      # ≥ 83 pass / 0 fail
bun test --parallel=1 test/e2e   # ≥ 77 pass / 0 fail, twice consecutively
```

Plus the two build gates: `bash test/build/pin.test.sh` and `bash test/build/harness-pin.test.sh`.

**Paste each real result into `PROGRESS.md`.** A claim of completion without the pasted output is not
evidence. A count that drops is a finding, never a rounding.

Run `bun test --parallel=1 test/e2e` **twice consecutively from the state the gate itself leaves** —
Slice 3.5 closed on exactly that condition, and it is what catches a gate that only passes from a
hand-prepared stack.

**End to end, by hand, once:** enable the runner profile, create a nightly `agent_prompt` on a
populated Space, wait for it to fire, open `/runs`, read the cost and the diff, click revert, and
confirm the page is gone from both the repo and a `search`. If that sequence is not pleasant, the
slice is not done.

---

## Live-state warnings this slice inherits

From `HANDOFF.md` — expect these on the dev stack, and do not mistake them for Slice 4 defects:

- The stack runs `0.50.5.0` with a populated post-F4 brain (the Slice 3.5 Gate C fixture).
- An **ENABLED 5-minute `live-sync` schedule on `shared`** is firing. It will appear in the git
  ranges of any Space it touches — which is exactly the `concurrentWriters` case D9 exists to report
  honestly, and a free real-world test of it.
- Two **frozen** `gate-c-nightly` / `gate-c-ambiguous` calendar fixtures resume as real paid `dream`
  runs after **2026-11-01**. **Retire them during this slice** rather than leaving them for the next
  one.
- A pending `awaiting_admin_decision` checklist item keeps the upgrade banner up and blocks nothing.

---

## Self-review — run this against the roadmap before Task 1

Check each roadmap non-negotiable has a home in this plan: pull/long-poll dispatch (D3, Task 6) ·
never the Docker socket (Global Constraints, Task 6) · one harness, not configurable (D4, Task 2) ·
MCP-only tools (D5, Task 8) · egress allowlisted at the network layer (D6, Task 3, C10) · ephemeral
workspace (Task 8) · two clients per Connection with a minutes-long TTL (D8, Task 5) · gateway-proxied
model calls (D7, Task 7) · retry classification (D11, Task 11) · the runner is optional (D12, Task 3)
· one-click "what did the 3am agent do" with a revert (D9, D10, Tasks 9/10/13) · the pin it must not
break and `verifyRuntimePin` (Global Constraints, Task 14) · an agent runner is never a path to an
upgrade (G5, D13).
