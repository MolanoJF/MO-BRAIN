# Execution Progress

**Resume here.** Single source of truth for what is done, blocked, and next.

**New session? Start with [HANDOFF.md](../../../HANDOFF.md).**

**Plans:** [roadmap](./2026-09-14-brainstand-roadmap.md) · [Slice 0](./2026-09-14-slice-0-cli-lane-proof.md) · [Slice 1](./2026-09-14-slice-1-deploy-one-brain.md)
**Findings:** [docs/slice-0-findings.md](../../slice-0-findings.md) — the risk register Slice 0 existed to produce.
**Branch:** Slice 0 landed on `main`; Slice 1 is on `slice-1-deploy-one-brain` (base `fbd0e95`). · **Executor:** Sonnet subagents, one task per dispatch, every result verified independently by the orchestrator.

---

## SLICE 0 — COMPLETE ✅

All four exit-gate items met.

| Gate | Result |
|---|---|
| `bun run tutorial` unattended, `doctorExitCode: 0`, `isolationOk: true` | **PASS** — whole tutorial runs in **39s** vs ~90 min by hand |
| Contract suite green at the pin, **red** on a wrong pin | **PASS** (see nuance below) |
| `contracts/v0.50.0.0/operations.json` + `capability.json` committed | **PASS** — 27 operations; 136 tools, 13 adapters, 6 profiles, 7 schema packs |
| `docs/slice-0-findings.md` has a status on every V-row | **PASS** — 13/13 filled, zero empty cells |

**Wrong-pin nuance:** the suite does go red at a wrong pin, but the failure fires in `composeUp()`'s Docker build (Task 1's build-time version gate re-triggering), not through `version.contract.test.ts`'s own runtime assertion, which never gets to run. That runtime assertion only becomes the operative gate when a stale image is already tagged with the wrong pin — a case not yet exercised. Recorded in the findings doc rather than glossed.

**Verification state:** `lint:forbidden` clean · `bun test test/unit` 41 pass · `bun test test/contract` 45 pass across 9 files · `tsc --noEmit` clean.

### Environment

Docker 29.8.0 / Compose v5.5.1, daemon linux/x86_64, 12 CPU, 8.25 GB. Stack left **running** (`postgres` + `gbrain-ops`, gbrain 0.50.0.0).

**PATH gotcha:** Docker Desktop installed to `%LOCALAPPDATA%\Programs\DockerDesktop\`. Sessions started before the install have a stale PATH and must prefix docker work with:

```bash
export PATH="/c/Users/juanp/AppData/Local/Programs/DockerDesktop/resources/bin:$PATH"
```

A freshly started session won't need this.

**Secrets:** `.env` holds a real `OPENAI_API_KEY`, is gitignored, was never staged, and no key value appears in any commit. The compose passes it into `gbrain-ops`; gbrain reads it ambiently so it never reaches a command line.

---

## The headline results

- **V3 CONFIRMED** — `gbrain init --non-interactive` genuinely works headlessly against Postgres. This was the make-or-break proof; Slice 1's wizard design stands.
- **Isolation is real, and proven early.** The plan's original isolation check was theatre (it searched as the local admin, identically for every member). It was rebuilt to mint real OAuth credentials per member, install them into separate `GBRAIN_HOME`s via `init --mcp-only`, and assert over MCP that each member sees exactly their read set and nothing more — plus a positive-access assertion so it can't pass by everyone seeing nothing. That is Slice 2's exit-gate mechanism, working now.
- **~20 defects in the plan were found by executing it.** All fixed in both repo and plan, so a fresh run from scratch hits none of them.

### Findings that change later slices

| Finding | Consequence |
|---|---|
| `doctor --json` has **no top-level `blockers` key** in this version | Slice 3.5's upgrade gate cannot check a blockers array — must use exit code + `status`/`health_score` |
| Adapter `.connection` is **not exposed** on any public surface (`publicHarnessMetadata()` strips it) | Slice 2's harness picker cannot group by connection class from the live payload |
| `schema list` **silently ignores `--json`** | Slice 1 Task 9's `/api/wizard/schema-packs` must parse prose, not JSON — **already fixed in the Slice 1 plan** |
| Compose passed **no provider key** to `gbrain-ops` | Slice 1's wizard must route the key deliberately |
| Slice 1's `/space` handler **never seeds/commits a git repo** before `sources.add` | Will always fail as written — flagged as an open gap in the Slice 1 plan, needs a new file-plane primitive |
| `jobs supervisor start --detach` **always exits 0** regardless of lock state | Lock contention is undetectable via `--detach`; use foreground start |
| Supervisor clean drain measured at **1150ms**, not the 40s budget | Slice 3.5 snapshot quiesce window can be far tighter |
| Supervisor has an **undocumented exit code 4** (LOCK_LOST) | Handle it in any supervisor wrapper |
| Re-running the tutorial against populated state **fails** (`sources add` refuses re-registration, `mcp grant` → `client_already_exists`) | Not a falsification; a real operational property to design around |

---

## Slice 1 — IN PROGRESS

**Entry gate: MET.** Slice 0 exit gate green, `contracts/v0.50.0.0/operations.json` committed.

15 tasks, executed with `superpowers:subagent-driven-development`. Working ledger (rulings, per-task state, deferred minors): `.superpowers/sdd/2026-09-14-slice-1-deploy-one-brain/progress.md` — git-ignored scratch, so **read it before resuming, and treat it as authoritative over memory**.

| Task | State |
|---|---|
| 1 — two-database Postgres + production compose | **complete** (`2c1a7ac..37fbe14`, review clean) |
| 2 — Caddyfile, `/admin` sealed | **complete** (`4fff74a..b58faf9`, review clean) |
| 3 — advisory lock + file-plane writer | in progress |
| 4–15 | not started |

**Executing the plan is again finding defects in the plan — ten so far**, all patched back into the plan file with evidence blockquotes (commits `4fff74a`, `de648f6`, `1841f50`).

The two that matter most:

- **Task 2's `/admin` seal was decorative.** A bare top-level `respond @admin_denied 404` compiles *behind* the catch-all, because Caddy sorts `respond` after `handle`. Verified with real `caddy adapt`: the 404 landed at route 4, behind a catch-all at route 3 that matches everything, making it unreachable dead config. S1 and a Slice 1 exit-gate item were both unmet. Now a `handle` block, which recompiles to route 1. **And the drafted test would have passed against the broken config** — it parsed Caddyfile *text*, so it found the `respond` line present and went green. The routing test now asserts compiled route *order*.
- **Task 1's `01-databases.sh` broke the Slice 0 stack.** `compose/initdb/` is shared by both compose files, and slice0's `POSTGRES_DB=gbrain` pre-creates that database, so a bare `CREATE DATABASE gbrain` aborted init under `ON_ERROR_STOP=1`. Now `\gexec`-guarded — re-proved on a fresh volume.

**Known open gap, still unresolved (Task 9):** the `/space` handler calls `sources.add` against a path that was never `git init`'d or committed. V12 proves that fails. **Controller ruling:** add a `seedSpaceRepo` primitive to `src/ops/fileplane.ts`, expose it as `POST /fileplane/seed-space`, call it from `/space` before `sources.add`. Lands in Task 9, not Task 4, so it is test-driven at its point of use.

**Also carried forward:** Task 3's advisory lock now reserves its connection (`sql.reserve()`). The pooled version was correct only incidentally — Bun's pool happens to reuse the most-recently-idle connection — and `pg_advisory_lock` is session-scoped and re-entrant, so a pooled handle can leak the lock or hand it to two callers at once.

---

## Session log

- 2026-09-14 — Plans written (roadmap + Slice 0 + Slice 1). Self-review found 3 gaps before execution.
- 2026-09-14 — Docker absent; executed the Docker-independent subset (Tasks 1 partial, 3, 11 pure, 14). 3 plan defects found.
- 2026-09-14 — Docker installed. Pin gate repaired and green. Tasks 2, 4, 5 done — **V3 confirmed**.
- 2026-09-14 — Tasks 6–10 done (one agent hit a usage limit mid-Task-8; resumed from repo state, not from its report).
- 2026-09-14 — Tasks 11–13 done. Isolation check rebuilt from theatre into a real per-member OAuth proof.
- 2026-09-14 — Findings doc filled, wrong-pin tripwire verified, consequences propagated. **SLICE 0 COMPLETE.**
- 2026-09-15 — Slice 1 started on `slice-1-deploy-one-brain`. Tasks 1–2 complete. Ten plan defects found and patched back, including a decorative `/admin` seal whose own test would have certified it. A pre-existing `lint:forbidden` break (introduced by HANDOFF.md quoting the pattern it forbids) repaired by narrowing scope, never rules. Docker-gated suites can no longer skip silently.
