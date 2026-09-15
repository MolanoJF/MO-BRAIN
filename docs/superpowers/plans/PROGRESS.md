# Execution Progress

**New session? Start with [HANDOFF.md](../../../HANDOFF.md).**

**Plans:** [roadmap](./2026-09-14-brainstand-roadmap.md) · [Slice 0](./2026-09-14-slice-0-cli-lane-proof.md) (historical) · [Slice 1](./2026-09-14-slice-1-deploy-one-brain.md) (historical)
**Findings:** [docs/slice-0-findings.md](../../slice-0-findings.md) — the risk register Slice 0 existed to produce.
**Branch:** `main` (Slice 0 and Slice 1 merged). Next executable stage is Slice 2 — plan not yet written.

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

**Verification state (at Slice 0 close):** `lint:forbidden` clean · `bun test test/unit` 41 pass · `bun test test/contract` 45 pass across 9 files · `tsc --noEmit` clean.

### Environment (at Slice 0 close)

Docker 29.8.0 / Compose v5.5.1, daemon linux/x86_64, 12 CPU, 8.25 GB. Slice 0 stack was left **running** at that session's close (`postgres` + `gbrain-ops`, gbrain 0.50.0.0) — not a claim about the current machine.

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

## Slice 1 — COMPLETE ✅

Merged to `main` 2026-09-15 (fast-forward, HEAD at merge `77a18d1`). The feature branch was deleted. Do **not** re-execute the Slice 1 plan.

15 tasks executed with subagent-driven-development. Plan defects found during execution were patched into the plan file with evidence blockquotes.

**Exit gate (implementer + independent unit/integration/lint/tsc):** compose up → `/api/health` → wizard to `ready` → put_page/search → restart preserves data; restore e2e 4/4; `/admin` 404 via live fetch and compiled Caddy route order.

Carried into Slice 2 (not blockers for Slice 1):

- Health `repos` unwraps `sources.status` envelope; `inspectRepos` (index.lock / uncommitted drift) is not yet on the health page or console UI.
- Wizard `/finish` compensates for a worker cold-start 1280-d schema clash (`resetBrainSchema` + `init --force` + re-`sources.add`); worker is not stopped around the wipe.
- `POST /api/backup` is a host operation (503 in-container without Docker). Restore doctor/clients go through `compose exec`, not host RPC.
- Console schema-step labels treat pack ids as `{id,name}` objects; `POST /schema` does not call `schema.apply`.
- Restore does not rematerialize sealed secrets onto the file plane after `down -v`.

---

## Session log

- 2026-09-14 — Plans written (roadmap + Slice 0 + Slice 1). Self-review found 3 gaps before execution.
- 2026-09-14 — Docker absent; executed the Docker-independent subset (Tasks 1 partial, 3, 11 pure, 14). 3 plan defects found.
- 2026-09-14 — Docker installed. Pin gate repaired and green. Tasks 2, 4, 5 done — **V3 confirmed**.
- 2026-09-14 — Tasks 6–10 done (one agent hit a usage limit mid-Task-8; resumed from repo state, not from its report).
- 2026-09-14 — Tasks 11–13 done. Isolation check rebuilt from theatre into a real per-member OAuth proof.
- 2026-09-14 — Findings doc filled, wrong-pin tripwire verified, consequences propagated. **SLICE 0 COMPLETE.**
- 2026-09-15 — Slice 1 started on `slice-1-deploy-one-brain`. Tasks 1–2 complete. Ten plan defects found and patched back, including a decorative `/admin` seal whose own test would have certified it. A pre-existing `lint:forbidden` break (introduced by HANDOFF.md quoting the pattern it forbids) repaired by narrowing scope, never rules. Docker-gated suites can no longer skip silently.
- 2026-09-15 — Slice 1 Tasks 3–15 complete, whole-branch review, merge-blocking install `--env-file` + restore `compose exec` fixes. Fast-forwarded to `main` (`77a18d1`). Feature branch deleted.
- 2026-09-15 — Retired mid-Slice-1 resume notes (`HANDOFF.md`, plan banners, roadmap environment block) so a new session does not re-execute Slice 0/1.
