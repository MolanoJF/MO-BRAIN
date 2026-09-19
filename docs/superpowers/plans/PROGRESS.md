# Execution Progress

**New session? Start with [HANDOFF.md](../../../HANDOFF.md).**

**Plans:** [roadmap](./2026-09-14-brainstand-roadmap.md) · [Slice 4](./2026-09-17-slice-4-agent-runner.md) (historical) · [Slice 5 — self-host GA](./2026-09-18-slice-5-self-host-ga.md) · Slice 0 / 1 (historical)
**Findings:** [docs/slice-0-findings.md](../../slice-0-findings.md) — Slice 0 risk register. [docs/slice-2-findings.md](../../slice-2-findings.md) — Open Q1 25-Space scale probe. [docs/slice-3-findings.md](../../slice-3-findings.md) — upstream-claim statuses for Slice 3. [docs/slice-3.5-findings.md](../../slice-3.5-findings.md) — U1–U12, P1–P8, F1–F9. [docs/slice-4-findings.md](../../slice-4-findings.md) — U1–U8 and P1–P9 statuses, F1–F19. [docs/slice-5-findings.md](../../slice-5-findings.md) — U1–U3, P1–P9, F20–F32, and the deferrals with named owner slices.
**Branch:** `main` — the only branch. Slices 0–3.5, **Slice 4** and **Slice 5 (self-host GA)** are all merged into it (Slice 3.5 at `202a658`, Slice 4 at `6ba1754`, Slice 5 at the `v1.0.0` tag). **Mobrain 1.0.0 shipped 2026-09-19**; its three published `RepoDigest`s are in [`CHANGELOG.md`](../../../CHANGELOG.md), and the eight verification commands and two build gates are green with verbatim tails in the Slice 5 section below. **The next stage is the deferred managed-cloud slice (Slice 6) — no plan exists yet, and it still carries Open Question 2 (managed-cloud pricing vs the search-mode cost spread).**

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

## Slice 2 — COMPLETE ✅

Members + Connections. **Merged to `main`** (the `slice-2-members-connections` branch no longer exists; its code and tests are in `main`).

| Gate | Result |
|---|---|
| A — compiler pairing, scoped search, revoke, audit, doctor (headless) | **PASS** — `test/contract/connection.contract.test.ts` |
| B — HTTP e2e: wizard, members, claim, thin-client whoami/search, revoke, `/admin` 404 | **PASS** — 8 steps in `test/e2e/slice2.e2e.test.ts` |
| C — Slice 2 exit: disjoint three-member grants, two-Connection per-token scope, revoke-one-other-survives, audit-before-delete, doctor | **PASS** — `bun test test/e2e/slice2.e2e.test.ts` 17 pass / 0 fail (46.69s) |

**Exit gate (roadmap, verbatim):** three Spaces, three Members with disjoint grants; as each Connection, thin-client `whoami` + `search` with every hit's `source_id` in that Connection's read set; a member with two write Spaces proving the two-Connection flow.

Carried into Slice 3 (not blockers for Slice 2):

- gbrain search with a non-empty `--federated-read` uses that list as the **full** scope, not write ∪ extras. Compile still stores extras only; write-source hits are guaranteed when `federated_read` is empty (disjoint internal member) or when the unique source is in extras (two-Connection case).
- Claim `POST /api/claim/:token` is 20 hits / 15 min in-process; OAuth `/token` is 50 / 15 min on gbrain-serve. Repeated e2e runs need a control-plane + serve restart, not `down -v`.
- Open Q1 25-Space probe held C5 thresholds; do not treat it as a scale-out proof.

**Next:** Slice 3 — Scheduler, `gbrain_command` only. Entry gate is this Slice 2 exit.

---

## Slice 3 — COMPLETE ✅

Scheduler, `gbrain_command` only, running on `main` (implementation committed; `test/e2e/slice3.e2e.test.ts` and the Slice 3 docs still untracked). Gates A/B/C are green and **Task 19 Step 5 is green in full — all six commands pass**, including `bun test --parallel=1 test/e2e` at **54 pass / 0 fail** across 4 files, run twice, the second time from a genuinely cold stack. Five fixes landed across the two verification rounds: F1–F3 in the gate files and the restore path, F4 a Slice 1/2 product gap the exit gate found, F5 the harness readiness race. The two red Step 5 passes that preceded this state are kept below, marked superseded, with their raw output.

| Gate | Result |
|---|---|
| A — allowlist, params, report path, cron/interval, DST, catch-up, overlap, cancel, doctor | **PASS** — `test/contract/scheduler.contract.test.ts` **18 pass / 0 fail** (26.38s alone); the whole `bun test test/contract` directory **69 pass / 0 fail** across 12 files, this gate's file being 18 of those 69 |
| B — HTTP seam: sign in, adopt a Connection, org zone + quiet hours, presets, 5-minute `live-sync` schedule, stagger/collision/fenced-param refusals, run-now with a real report + git record, brain-wide refusal, revoke → alert, `/admin` 404 | **PASS** — `test/e2e/slice3.e2e.test.ts`, B1–B12 plus the anti-silent-skip guard (13 tests) |
| C — exit gate: DST spring-forward and fall-back on an injected clock, catch-up skip / run_latest / run_all, overlap skip / queue / kill_previous, exactly one leader, schedule left healthy | **PASS** — `test/e2e/slice3.e2e.test.ts`, C1–C12 (12 tests) |

Gate B + Gate C, that file alone: `bun test --parallel=1 test/e2e/slice3.e2e.test.ts` → **25 pass / 0 fail** (tripwire + B1–B12 + C1–C12). All 25 were green in both final full-`test/e2e` runs too; the two `(fail)` lines those runs used to carry were Slice 1's, not this file's, and they are green now (F4 and F5 below).

**Exit gate (roadmap, verbatim):** a 5-minute `sync + embed --stale` schedule runs on time **across a DST boundary**; downtime longer than one interval honors the catch-up policy; an overlapping run honors the overlap policy.

### Task 19 Step 5 — the six commands, final run (all six green)

Environment: `OPS_RPC_URL=http://127.0.0.1:3140` and `E2E_BASE_URL=https://localhost:8443` for host runs; `CONTROL_DATABASE_URL` is defaulted inside the test files themselves (`test/unit/scheduler-main.test.ts:9-17`, `test/integration/auth.test.ts:10-12`), so it is no longer exported — the default is the same `bs-fp-pg` scratch Postgres, `postgres://gbrain:ci-not-a-real-secret@localhost:5432/control`, and that container is left up; `DOMAIN`, `OPS_RPC_TOKEN`, `ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, `OPENAI_API_KEY` come from the repo `.env`, which Bun loads itself. Main stack (`compose/docker-compose.yml` + `compose/docker-compose.dev.yml`) up. No `docker compose down -v` was run by hand — every volume teardown is a suite's own, inside its test body or its `afterAll`.

Trimmed to the summary lines:

```
$ bun run lint:forbidden
lint:forbidden clean

$ bunx tsc --noEmit
(exit 0, no output)

$ bun test test/unit
 292 pass
 0 fail

$ bun test test/integration
 255 pass
 1 skip
 0 fail

$ bun test test/contract
 69 pass
 0 fail

$ bun test --parallel=1 test/e2e
 54 pass
 0 fail
```

`bun test --parallel=1 test/e2e` was run twice end to end; the second run began from a **cold stack**, which is what exercises F5's readiness gate — `restore.e2e.test.ts` runs first in the directory and cycles the volumes itself (`compose down -v` inside its body and in its `afterAll`), so `slice1.e2e.test.ts` re-ups them from cold. The integration `1 skip` is the platform opt-out, not a silent gap: `[fileplane.test.ts] Skipping "config.json is written 0600" on win32: NTFS has no POSIX permission bits`. The unit run also echoes two Postgres `NOTICE`s (`schema "drizzle" already exists, skipping`), which are notices from its own probe, not failures.

### The earlier Step 5 passes — SUPERSEDED (kept as history)

Two earlier passes of the same six commands were red, and both are kept verbatim here: nothing was deleted, trimmed to the convenient line, or reworded to look better than it was. The **first** pass failed 3 of 6 (F1, F2, F3). The **re-run** against those three fixes still failed 2 of 54, identically, and both remaining reds turned out to be F4 (the wizard's missing `federated: true`) and F5 (the cold-stack readiness race) rather than anything Slice 3 shipped — the restore leg had by then cleared the `doctor` gate it used to die on and failed one assertion later, at its unqualified `gbrain search`.

`git status --short` at the start and after that pass (read-only git; the orchestrator commits):

```
$ git status --short            # before, at 23:53 local
 M HANDOFF.md
 M docs/superpowers/plans/2026-09-14-brainstand-roadmap.md
 M docs/superpowers/plans/PROGRESS.md
 M scripts/restore.ts
 M test/integration/auth.test.ts
 M test/unit/scheduler-main.test.ts
?? docs/slice-3-findings.md
?? docs/superpowers/plans/slice-2-decision-sheet.md
?? test/e2e/slice3.e2e.test.ts

$ git status --short            # after the whole pass + this PROGRESS.md edit
 M HANDOFF.md                                        # Slice 3 docs (not this task)
 M docs/superpowers/plans/2026-09-14-brainstand-roadmap.md
 M docs/superpowers/plans/2026-09-15-slice-3-scheduler.md   # the plan copy, edited concurrently by another agent
 M docs/superpowers/plans/PROGRESS.md                # this task
 M scripts/restore.ts                                # the F3 fix (not this task)
 M test/integration/auth.test.ts                     # the F2 fix (not this task)
 M test/unit/scheduler-main.test.ts                  # the F1 fix (not this task)
?? docs/slice-3-findings.md                          # Slice 3 docs (not this task)
?? docs/superpowers/plans/slice-2-decision-sheet.md  # pre-existing, untouched
?? test/e2e/slice3.e2e.test.ts                       # Slice 3's gate file
```

Nothing outside `docs/superpowers/plans/PROGRESS.md` was written by that pass; the other modified files above were other agents' work.

`bun test test/contract` failed once, on that pass's first run:

```
$ bun test test/contract
test\contract\scheduler.contract.test.ts:
329 |     }
330 |   });
331 |
332 |   test('A7. the committed report is importable — sync sees it as a page', async () => {
333 |     const sync = await opsRpc('sync', { source: PROBE_SOURCE }, { json: true });
334 |     expect(sync.exitCode).toBe(0);
                                ^
error: expect(received).toBe(expected)

Expected: 0
Received: 1

      at <anonymous> (C:\Users\juanp\Desktop\Company Brain\test\contract\scheduler.contract.test.ts:334:27)
(fail) Slice 3 seam gate A > A7. the committed report is importable — sync sees it as a page [573.97ms]

 68 pass
 1 fail
 137 expect() calls
Ran 69 tests across 12 files. [298.38s]
```

A7 is not a missing-source problem: Gate A re-registers its own fixture — `ensureProbeSource()` (`test/contract/scheduler.contract.test.ts:238-266`) runs `sources list` → `sources remove slice3-probe` → re-seeds `/srv/brain-repos/slice3-probe` as a git repo with one commit → `sources add slice3-probe --path …` — in the `describe`'s `beforeAll`, and A1–A6 passed in the failing pass. The `sync` it then drives is the only assertion in the file that reaches the main stack's brain through `gbrain-ops`' HTTP RPC, and its `exitCode` 1 arrived with no captured stderr (`opsRpc` returns `{exitCode, json}` only), so the raw output above is the whole evidence there is. It is recorded as **suspect state, green on both re-runs**, not as a product defect — the first pass began ~1 minute after the main stack had been recreated (`docker ps`: every `brainstand-*` container "Up About a minute", `bs-fp-pg` up 14 hours), and by whom, from which volumes, and whether that is what A7 tripped on is not established. No later run has been red there.

`bun test --parallel=1 test/e2e` was red in both runs of that pass, identically, 52 of 54. First run:

$ bun test --parallel=1 test/e2e
bun test v1.3.14 (0d9b296a) 1x PARALLEL
test\e2e\restore.e2e.test.ts:
162 |     expect(search.ok).toBe(true);
163 |
164 |     const probe = await composeExec('gbrain-ops', [
165 |       'gbrain', 'search', 'restore probe', '--json',
166 |     ], 120_000);
167 |     expect(probe.stdout).toContain(KNOWN_SLUG);
                               ^
error: expect(received).toContain(expected)

Expected to contain: "restore-probe"
Received: "[]\n"

      at <anonymous> (C:\Users\juanp\Desktop\Company Brain\test\e2e\restore.e2e.test.ts:167:26)
(fail) restore > an empty stack restored from a backup reproduces a known page [46310.39ms]
test\e2e\slice1.e2e.test.ts:
103 |   test.skipIf(!dockerAvailable)('gbrain reserved paths route to gbrain-serve, not the console', async () => {
104 |     const wk = await fetchInsecure('/.well-known/gbrain');
105 |     expect(wk.status).toBe(200);
                            ^
error: expect(received).toBe(expected)

Expected: 200
Received: 502

      at <anonymous> (C:\Users\juanp\Desktop\Company Brain\test\e2e\slice1.e2e.test.ts:105:23)
(fail) Slice 1 exit gate > gbrain reserved paths route to gbrain-serve, not the console [3.71ms]

 52 pass
 2 fail
 392 expect() calls
Ran 54 tests across 4 files. [275.54s]
```

Re-run, whole directory again: same two failures, same lines, same assertions — `(fail) restore … [58584.05ms]`, `(fail) Slice 1 exit gate > gbrain reserved paths … [6.40ms]`, `52 pass / 2 fail / 392 expect() calls / Ran 54 tests across 4 files. [287.08s]`. All 25 `slice3.e2e.test.ts` Gate B+C tests passed in both runs; every `slice2` test passed in both. The restore leg printed its fix working, then died one assertion later:

```
test\e2e\restore.e2e.test.ts:
[restore] re-materialized the gbrain file plane: embedding_model, embedding_dimensions, openai_api_key

=== Applying migration v0.11.0: GBrain Minions — durable background agents ===
…
=== v0.12.0 — Knowledge Graph auto-wire ===

  Brain wire-up:
    Pages:    9
    Links:    0
    Timeline: 0
```

`test/e2e/slice1.e2e.test.ts` run alone (warm, already-provisioned stack, `6 pass / 2 fail`): the 502 does **not** reproduce — `/.well-known/gbrain` answers 200 — but the wizard step returns 409 (nothing left to provision) and its own search assertion fails exactly like the restore one:

```
test\e2e\slice1.e2e.test.ts:
139 |     expect((await post('/api/wizard/provider', {
142 |     })).status).toBe(200);
error: expect(received).toBe(expected)
Expected: 200
Received: 409
(fail) Slice 1 exit gate > the wizard reaches ready [136.99ms]
171 |     const search = await composeExec('gbrain-ops', [
172 |       'gbrain', 'search', 'end to end probe', '--json',
173 |     ], 120_000);
174 |     expect(search.stdout).toContain('e2e-probe');
                               ^
error: expect(received).toContain(expected)
Expected to contain: "e2e-probe"
Received: "[]\n"
(fail) Slice 1 exit gate > a put_page then search round trip works [5903.66ms]

 6 pass
 2 fail
Ran 8 tests across 1 file. [50.51s]
```

What line 167 fails on is **search scope, not restored data**. The page is in the restored database. Directly against the restored stack, before any later e2e file touched it:

```
$ docker compose … exec -T postgres psql -U gbrain -d gbrain -tAc \
    "select slug, source_id from pages where slug like '%probe%'"
restore-probe|shared
$ docker compose … exec -T postgres psql -U gbrain -d gbrain -tAc "select count(*) from pages"
9
```

and the migration log on the same stack prints `Brain wire-up: Pages: 9`. The assertion is `expect(probe.stdout).toContain(KNOWN_SLUG)` on an **unqualified** `gbrain search` — and an unqualified search spans federated sources only, per gbrain's own `search --help`: *"Defaults to OperationContext.sourceId … when unset, an unqualified read spans every federated source."* No Space in this stack is federated (`sources.config`: only `default` carries `{"federated": true}`, and `default` holds no pages; the wizard adds Spaces with `{id, path, name}` only — `src/control/routes/wizard.ts:188-190` — and `sources.add` takes an unwitnessed `--federated` flag, `src/contracts/registry.ts:210`). Reproduced on a **healthy, non-restored** stack, mirroring the test's own seed, with no restore anywhere in the loop:

```
$ docker compose … exec -T gbrain-ops sh -c "printf '# Restore probe…' > /srv/brain-repos/shared/restore-probe.md && cd … && git … commit -qm 'restore probe'"
seed_exit=0
$ docker compose … exec -T gbrain-ops gbrain sync --all --no-embed --json
  ✓ Shared: synced (added=2, modified=0, deleted=0)
{"schema_version":1,"sources":[… {"source_id":"shared","status":"ok","sync_status":"synced","added":2,"modified":0,"deleted":0,"chunks_created":2,"embedded":0} …]}
sync_exit=0
$ docker compose … exec -T gbrain-ops gbrain search 'restore probe' --json      # the test's exact command
[]
exit=0
$ docker compose … exec -T gbrain-ops gbrain search 'restore probe' --json --source-id __all__
[ { "slug": "restore-probe", "page_id": 5, "chunk_text": "# Restore probe\n\nThe restore probe page proves a known page survives.",
    "source_id": "shared", "keyword_hit": true, "evidence": "exact_title_match", … }, … ]
```

Same story for a page that predates the restore: unqualified `gbrain search 'performance review' --json` → `[]`, `--source-id internal` → the page. So the restored brain is intact and searchable; the assertion asks for a scope in which nothing can be found. It is the **same root cause as the other red**, `test/e2e/slice1.e2e.test.ts:174` (`put_page then search`, `[]`), which fails identically in the full-directory run and in a slice1-only run. Neither failure is in `scripts/restore.ts`. **Flagged, not explained:** the Slice 3 close pass recorded that same slice1 search assertion as green in a full-`test/e2e` run, and it is red in both of this pass's runs with the same command and the same code — what differs is the stack's source set, which this pass rebuilt from scratch (the suites' `down -v`, then a fresh wizard provisioning), and it is the scope rule that decides the result, not the page.

### F1–F5: what was fixed

No test was weakened and no assertion was relaxed in any round: F1 and F2 were fixed in their own test files, F3 in the restore path, F4 in the wizard, F5 in the harness. Every red was re-run before being recorded, and every fix was re-verified by the full six-command pass above.

**F1 — FIXED.** Cause: Slice 3's own unit file could not run without an exported `CONTROL_DATABASE_URL`, because `pinDb()` → `getDb()` (`src/control/db/client.ts:13-14`) throws when it is unset and the file's `beforeAll`/`beforeEach` hooks called it first. Fixed in `test/unit/scheduler-main.test.ts:9-17`, which now defaults the variable (`process.env.CONTROL_DATABASE_URL ??= …`) before the pool is built — the same shape its sibling DB-backed files use. `bun test test/unit` is 292 pass / 0 fail / 292 ran, up from 287/2/289; no export needed.

**F2 — FIXED.** Cause: Slice 3 added four tables and `test/integration/auth.test.ts`'s `DECLARED_TABLES` allowlist was never extended, so the "no undeclared BASE TABLE exists" assertion saw `schedules`, `schedule_runs`, `schedule_alerts`, `held_notifications` as undeclared. A stale allowlist, never a schema leak. Fixed in `test/integration/auth.test.ts:18-27`. `bun test test/integration` is 255 pass / 1 skip / 0 fail / 256 ran.

**F3 — FIXED.** Cause as diagnosed: a restore loses gbrain's file plane, so the restored brain boots with no provider pin — `provider_sunset` — and `gbrain doctor` exits 1, which is `report.ok` (`scripts/restore.ts:170`). Fixed in `scripts/restore.ts` by re-materializing the file plane **before the services boot** (`reMaterializeFilePlane()`, called at the top of `runRestore`): it reads the pin from the restored control DB (`brains.embedding_model`) and the width from the restored `content_chunks.embedding` column, writes both, and re-opens the vendor key from the sealed `secrets` row. This defect predates Slice 3 — the file plane is Slice 1's, and Slice 3 only changed *which* failure a restore surfaces. That fix works: the run prints `[restore] re-materialized the gbrain file plane: embedding_model, embedding_dimensions, openai_api_key`, `expect(report.ok).toBe(true)` and `expect(report.doctorExitCode).toBe(0)` now pass, and the failure has moved from line 158 to line 167. The assertion the restore leg still failed after this fix was F4's unqualified-search scope, not a restore regression: with F4 fixed, `restore.e2e.test.ts`'s known-page assertion passes and the file is green.

**F4 — FIXED (a Slice 1/2 product gap, found by Slice 3's exit gate — not a Slice 3 defect).** One-line cause: gbrain makes a source visible to an **unqualified** read anchored elsewhere only when its `config.federated` is a literal `true`, and the wizard registered Spaces without it — so once a brain had 2+ Spaces, an unqualified `gbrain search` could not find any Space page. Fixed in **`src/control/routes/wizard.ts`**, by passing `federated: true` at **both** `sources.add` call sites (`/space`, and `/finish`'s post-reset re-registration — the row that survives a reset). A single-Space brain was masked by gbrain's sole-non-default resolver tier (with exactly one non-default source the anchor falls back to it), which is why two slices went by without probing it. The evidence that pinned it: on a fresh stack with three wizard-created Spaces, `sources.config` was `{}` for every Space and `gbrain search 'performance review' --json` returned `[]` while `--source-id __all__` returned all three pages; after `gbrain sources federate` on all three, the unqualified search returned them. The unqualified-vs-`__all__` reproduction in the superseded record above shows the same split on a healthy, non-restored stack. **No read-set regression:** a compiled Connection always carries a grant, so gbrain's no-grant widening never applies to an OAuth client, and Slice 2's read-scope probes plus Slice 3's gates stayed green. **Known limitation:** a stack whose volumes still hold Spaces registered *before* this fix keeps the flag unset for them — see the F28 bullet below.

**F5 — FIXED.** One-line cause: `test/e2e/slice1.e2e.test.ts`'s `beforeAll` waited only on the console's `/api/health`, so on a cold stack it raced `gbrain-serve`'s boot and the reserved-path assertion read a **502** — Caddy answering for an upstream that was not up yet. The measured window in which console health answered `200` while `/.well-known/gbrain` answered `502` was **3073 ms**; on the same stack minutes later the identical URL answers `200`, and running `slice1.e2e.test.ts` alone never produced a 502. A routing defect would answer 404 — which is exactly what `/admin` does, and that assertion passes. Fixed in **`test/e2e/slice1.e2e.test.ts`**: the `beforeAll` now polls **both** surfaces and returns only when console health is `< 500` **and** the reserved path is exactly `200`, bounded at 120×2s so a genuinely dead `gbrain-serve` still fails the assertion instead of hanging the suite. `restore.e2e.test.ts` runs first in the directory and cycles the volumes, which is why only a cold run ever hit it.

### Carried into Slice 3.5

- `check-update` is deliberately not schedulable — Slice 3.5 owns the detect step.
- A `lease_expired` run is never auto-retried (honesty rule 6), and there is no retry-policy UI.
- Quiet hours have no user-awake override, and upstream's travel-aware timezone inference is not built.
- `live-sync` is the only multi-step command; there is no general pipeline.
- Spend is not yet rolled up per member/org (the roadmap's observability track, Slice 3–4).
- The report-write/commit ordering caveat from Task 6 is documented but unexercised.
- The `blocked` run state is declared in the `schedule_runs.state` CHECK (`src/control/db/schema.ts:310`) but never written.
- The restore path's file-plane re-materialization (`scripts/restore.ts` → `reMaterializeFilePlane()`) is a **Slice 1-era gap closed here**: a restore used to come back with no provider pin and fail `doctor` with `provider_sunset`. It is new code on a Slice 1 path and has been exercised only by `restore.e2e.test.ts`.
- A restore of a brain whose pin was never recorded in the control DB stays a **deliberate no-op that fails loudly** — `reMaterializeFilePlane()` returns without writing when `brains.embedding_model` or the restored column width is absent, and the `doctor` exit code then decides `report.ok` rather than being papered over.
- Observed while verifying, not fixed: neither `scripts/backup.ts` nor `scripts/restore.ts` names the `scheduler` service in its stop/start lists, so it stays up across a restore (`runRestore` stops and restarts exactly `gbrain-worker gbrain-serve control-plane`; `runBackup` stops only `gbrain-worker`). No failure in this pass was attributed to it — the observation is recorded, the consequence is not.
- **F28 — a known limitation, stated plainly:** a stack whose volumes still hold Spaces registered *before* F4 keeps `config.federated` unset for them, so `restore.e2e`'s unqualified search assertion would still fail on such a warm stack. The remedy is `gbrain sources federate <id>` per Space, or re-provisioning / restoring from a post-fix archive. Recorded as F28 in [docs/slice-3-findings.md](../../slice-3-findings.md).

Docs landed with the slice: `docs/slice-3-findings.md` (a status on every upstream claim the plan made) and `docs/runbooks/scheduler.md` (break-glass companion to `docs/runbooks/break-glass.md`), plus the `HANDOFF.md` and roadmap updates.

Environment recorded at the earlier pass's close (the final e2e runs then cycled the volumes again with their own `down -v` cycles, so treat this as history, not as current state). The `bs-fp-pg` scratch Postgres and the main stack (`brainstand-postgres/caddy/gbrain-ops/gbrain-serve/gbrain-worker/scheduler`) are **up**, but on **fresh volumes** — the e2e suites' own `down -v` cycles (inside their test bodies and `afterAll`s, never run by hand here) wiped them, and the last one to run was `slice1.e2e.test.ts`, whose `afterAll` leaves the stack down; this pass then brought it back up. So the brain now has the `default` source and 0 pages and no Spaces (the `restore-probe` page this pass seeded by hand into `shared` to reproduce the search-scope finding died with that volume), the `gbrain-home` volume has no `config.json` yet, and the Slice 0 stack is down (the contract suite's own `afterAll`). A `test/contract` run needs the brain provisioned first (the wizard/e2e path) — a bare brain is the state the plan's own note calls out as the keyless-default trap.

---

## Slice 3.5 — COMPLETE ✅ (merged to `main`)

Deterministic upgrades, **merged to `main`** (fast-forward from `slice-3.5-upgrades`, tip `202a658`;
feature branch deleted). All three gates are green, the upgrade lane is live on the dev stack at
**0.50.5.0**, and **all six verification commands are green** — the family e2e is **77 pass / 0 fail**,
proven twice consecutively from the 0.50.5.0 state the gate itself leaves behind.

The first six-command run was red (68 pass / 9 fail) and the red was real. Three findings came out of it
and were closed in the same slice, all recorded in
[`docs/slice-3.5-findings.md`](../../slice-3.5-findings.md):

- **F7** — `capability_snapshots` had no product writer, so the drift panel would 400 on any fresh
  deployment; and the fixture's own residue made preflight refuse `NO_BASELINE` on the real leg. The run
  now captures both pins into the run directory and the reconciler imports them; C6 repairs the residue
  its fixture caused. `captureDoctorBaseline`'s refusal is untouched.
- **F8** — the digest's `filePlane` part hashed gbrain's own runtime state, so a correct rollback could
  never compare equal.
- **F9** — the gate was not re-runnable: starting from 0.50.5.0 twelve tests cascaded off `SAME_VERSION`,
  and an abort between the fixture and its undo left the live brain fixtured. `normalizeToFromPin()`
  now establishes the entry state, and the fixture is paired with its undo in a `try/finally` plus an
  `afterAll` backstop.

| Gate | Result |
|---|---|
| A — the ops RPC seam (Task 15) | **PASS** — `test/contract/upgrade.contract.test.ts` **14 pass / 0 fail** (tripwire + A1–A9 + Task 7's 4); the whole `bun test test/contract` directory **83 pass / 0 fail across 13 files** |
| B — the upgrade surfaces over HTTP (Task 16) | **PASS** — `test/e2e/slice35.e2e.test.ts` B1–B10 + the anti-silent-skip tripwire |
| C — the exit gate (Task 17) | **PASS** — `test/e2e/slice35.e2e.test.ts` C1–C12 (23 pass / 0 fail total for the file, run on a state where both `capability_snapshots` rows exist — see F7) |

**Exit gate (roadmap, verbatim):** upgrade a populated deployment to the next release; assert doctor
parity; the `playbook_ledger` records the version; then **deliberately fail a migration and assert
one-click rollback restores the pre-upgrade state exactly**.

### The four measured numbers (Gate C, real)

| Measurement | Value | Span |
|---|---|---|
| Quiesce window | 764 ms (drain), 3316 ms (whole loop) | drain: stop request → verdict; loop: scheduler stop → gbrain-ops stop |
| Snapshot | 2716 ms, 3 840 081 bytes | four artifacts, `docker-volume` |
| Image build | 40 310 ms | journal `snapshot_taken` → `swapped` |
| Total downtime | 56 274 ms | journal `run_completed.downtimeMs`: quiesce start → gate done (dominated by the build, not the 1.2 s drain) |

### Task 18 Step 5 — the six commands, final run

Environment: `CONTROL_DATABASE_URL` defaulted inside each test file; `OPS_RPC_URL`/`E2E_BASE_URL` from
`host-ops-env.ts`; secrets from the repo `.env`. Main stack up. No `docker compose down -v` was run by
hand — every volume teardown is a suite's own.

```
$ bun run lint:forbidden
lint:forbidden clean

$ bunx tsc --noEmit
(exit 0, no output)

$ bun test test/unit
 421 pass
 0 fail
 1583 expect() calls
Ran 421 tests across 39 files.

$ bun test test/integration
 314 pass
 1 skip
 0 fail
 1131 expect() calls
Ran 315 tests across 28 files.

$ bun test test/contract
 83 pass
 0 fail
 235 expect() calls
Ran 83 tests across 13 files.

$ bun test --parallel=1 test/e2e
 68 pass
 9 fail
 484 expect() calls
Ran 77 tests across 5 files.
```

**The nine e2e failures are all in `test/e2e/slice35.e2e.test.ts`** (`restore`, `slice1`, `slice2`,
`slice3` were green): `B9` plus `C4` and the `C6`–`C12` cascade. Two independent root causes, both
recorded as **F7**:

1. **`B9` and `C10` need `capability_snapshots` rows the product never writes.** `recordCapabilitySnapshot`
   (`src/upgrade/capability.ts:18`) has **no caller in `src/` or `scripts/`** — the only writer is
   `test/integration/capability.test.ts`. The upgrade run does not record snapshots, so
   `/api/upgrades/drift` returns **400** once `restore.e2e`'s own `down -v` has cycled the control
   database, and `C10`'s two-version assertion cannot hold. In an isolated `slice35` run on a DB where
   the integration test (or a prior run) had seeded both rows, `B9`/`C10` pass — which is why Gate C's
   own run reported 23/0.
2. **`C6`'s preflight requires `doctor` exit 0**, and the failure leg can leave `doctor` **unhealthy**
   (`minions_migration` partial: "MINIONS HALF-INSTALLED (partial migration: 0.11.0)"), which makes
   `captureDoctorBaseline` throw `NO_BASELINE` → the real run exits `3` → no `runId` → `C7`–`C12`
   cascade. Running `gbrain apply-migrations --yes` repaired it.

Neither is a Task 18 change (this task touched only docs). Both belong to the exit-gate wiring: the
capability-snapshot half of Task 8 is unexercised by the product, and the family's file ordering
(`restore.e2e` first) means `slice35` must not depend on state a prior run seeded.

### Carried into Slice 4

- **Capability snapshots ARE now recorded by the upgrade lane** (F7, closed). `runUpgrade` captures the
  from-pin before the digest and the to-pin after resume into the run directory, and `reconcileJournals`
  imports both into `capability_snapshots`; proven from an empty table. What remains for Slice 4 is the
  multi-tenant story, not the writer.
- **No schema-version surface exists in any published contract** (U6), so the ledger records the binary
  version plus doctor's `schema_version` check **status** — less than it should. Filed as an upstream
  contribution, never scraped.
- `playbook_ledger`'s CHECK has no `not_required` state, so a no-playbook version is `applied` with the
  evidence in `notes`.
- `check-update` reads master's `VERSION` (U2), so "latest" is not a vetted release; there is no
  release-channel concept and nothing auto-upgrades.
- The snapshot driver has exactly one implementation (`docker-volume`); the `SnapshotDriver` seam
  exists for Slice 5's ZFS/cloud-disk driver and is unexercised by a second driver.
- The Schema step is proven against a fixtured failure (D9) because the real delta has none.
- `check-update` is still not schedulable, deliberately (D7) — the two scheduler tests that assert it
  stay green.
- Multi-version jumps are untested: this slice proves one hop (`0.50.0.0 → 0.50.5.0`).
- Everything Slice 3 carried that Slice 3.5 did not consume, re-stated rather than dropped.

---

## Slice 4 — COMPLETE ✅ (merged to `main` at `6ba1754`)

Agent runner — the optional container that hands a prompt to the pinned Claude Code harness against the
brain, on a schedule, with nobody watching. **Complete on `slice-4-agent-runner`; that branch is not yet
merged to `main`.** All three gates are green, the six verification commands and the two build gates are
pasted below, and the one promise this slice's exit gate disproved was **fixed**, not smoothed over.

The first exit-gate run was red and the red was real: C6's third clause — "a subsequent `search` no
longer returns the reverted page" — failed on the shipped product. Everything that came out of it was
closed inside the slice, and all of it is recorded in
[`docs/slice-4-findings.md`](../../slice-4-findings.md):

- **F15** — the revert's re-index cannot remove the page an agent run writes. A page created brain-first
  (`put_page`; the file is only write-through) survives the revert: the file's ADDITION and its REMOVAL
  both land inside the `anchor..HEAD` window a delta `sync` reconciles, so they net to nothing,
  `filtered.deleted` never holds the path, and the route reports success while the reverted page keeps
  answering searches. F15's own repro is model-free, in gbrain's own verbs.
- **F16** — the fix. A new operation, **`page.delete`** (`delete <slug> --source-id <id> --purge
  [--json]`), and `revertRun`'s step 3 is now *the pages the revert removed, by name → `sync` →
  `embed --stale`*, with `RevertSuccess.index` carrying all three. The purge refuses to touch a slug the
  tree still holds (`POST /git/path-exists`), refuses a remote caller's `--purge`, and reports
  `purged` / `absent` / `skipped_file_present` / `skipped_not_a_page` / `refused_unreadable` / `failed`.
  C6's three clauses were **unchanged**.
- **F17** — C9 raced the harness's next call, structurally: `agent_run_usage` only holds a call once it
  has ENDED, so the leg's cap write could never land before the harness began call N+1. The leg now
  writes the cap in the window the runner's own claim sequence opens (detection and write are one
  statement). Nothing in `src/` changed for it.

| Gate | Result |
|---|---|
| A — the seam, headless | **PASS** — `test/contract/runner.contract.test.ts`, **57 pass / 0 fail** alone (347 `expect()` calls, 55.67s) |
| B — HTTP end to end (B1–B12 + the anti-silent-skip tripwire) | **PASS** — `test/e2e/slice4.e2e.test.ts` |
| C — the exit gate (C1–C12) | **PASS** — the same file, **27 pass / 0 fail** in F17's acceptance run on the real runner container, the real pinned harness and the real brain; both of this pass's family runs are **104 pass / 0 fail** |

**Exit gate (roadmap, verbatim):** a nightly `agent_prompt` produces a run record with cost, token
counts and a brain diff; **killing the runner mid-run reclaims the lease without double-writing**;
exceeding the budget cap stops the run and alerts rather than silently truncating.

### The exit gate's three promises, measured

| Promise | Measured outcome |
|---|---|
| A run record with cost, token counts and a brain diff | **GREEN** — C1–C5. The row materializes at its org-local slot through Slice 3's own materializer (`2026-09-17T03:00` org time, `fire_at …T07:00:00+00:00`); the runner claims it; `cost_usd` = `SUM(agent_run_usage.cost_usd)` computed in SQL on both sides; C4 shows the write Space's range naming the page and **every read Space's range empty**; C5 carries prompt, tool call, 2 usage rows, `costUsd` and the diff file list in **one** `GET /api/runs/:id`. |
| Killing the runner mid-run reclaims the lease without double-writing | **GREEN** — C7 kills the container mid-run: `lease_expired` / `infra_failed`, an alert, and the run's gbrain bearer going **200 → 401** across the reclaim. C8 is the double-write proof: `schedule_runs` holds attempts 1 and 2, each page exists exactly once in the run's own directory, one commit added it, the agent's text appears exactly once. **Stated, not smoothed:** the retry occurrence is written by the **gate** (`createRetryRow`'s shape), because `reclaimExpiredLeases` deliberately never re-runs a dead runner's agent run — F15 records that as a finding, not a pass. |
| Exceeding the budget cap stops the run and alerts rather than silently truncating | **GREEN** — C9, made deterministic by F17: the gateway's own log line is `402` with `tokens: 0` / `costUsd: null` and **zero 2xx lines** (refusal before forwarding), `schedule_runs.state failed` / `classification budget_exceeded`, `agent_runs.failure_class budget_exceeded`, exactly one `agent_budget_exceeded` alert with no `midStream`, and `agent_run_usage` **zero rows** — not a truncated one. |
| *(the earlier red, and the fix it forced: the revert's re-index)* | **GREEN after F16** — C6's measured before/after, from a real `gbrain search`: `before=[gate-c/mu6jhb9j/nightly, …]` → `after=[…] (slug gone)`, with the reverted page absent and the other pages untouched. The route's `sync` still reports `up_to_date` / `deleted: 0`, which is the point: the deletion is what moved the index, and the receipt now says so. |

### Money — measured, not estimated

Every leg runs the REAL harness against the REAL brain. Gate C's own teardown logged, per run:
`gate-c-nightly` 2 calls `$0.0263061` · `gate-c-kill` attempt 1 `lease_expired` 1 call `$0.0123261` ·
attempt 2 2 calls `$0.0156738` · **`gate-c-budget` (C9) `failed` / `budget_exceeded`, 0 calls,
`cost: null`** · `gate-c-bash` 1 call `$0.0109512` — **`$0.0652572` over 5 runs for this pass's first
directory run**; the second run's five rows are `$0.0265811` · `$0.0099937` · `$0.0158596` · `null` ·
`$0.0106424` = **`$0.0630768`**, and Gate B's metered leg costs `$0.00004` per run. The slice's whole
measured spend, over all of Task 17's acceptance runs, is **≈ `$0.52` against the `$5.00` ceiling**; C9's
own leg is `$0.0000000` because the refusal happens before any upstream connection.

### Verification — the six commands and the two build gates

Environment: the dev stack up on `0.50.5.0` (`compose/docker-compose.yml` + `compose/docker-compose.dev.yml`),
`CONTROL_DATABASE_URL=postgres://gbrain:ci-not-a-real-secret@localhost:5432/control` (the `bs-fp-pg`
scratch Postgres) exported for the integration run, secrets from the repo `.env`. Every command was run
alone, one at a time, with nothing else touching the stack. No `docker compose down -v` was run by hand —
every volume teardown is a suite's own, inside its test body.

**Two of these numbers are re-measured; the rest are the close-out pass's.** The close-out pass left
`test/integration` red (423 / 1 skip / 5 fail) and `test/contract` red (141 / 1 fail); both were fixed in
commit **`9efc992`**, and a follow-up pass **re-ran those two commands alone** on 2026-09-18, in the
documented order, with `git status --porcelain` holding no test edits. Their tails below are that pass's,
verbatim. The other four commands and the two build gates were **not** re-run by it — their numbers are
unchanged from the close-out pass and are marked as such. The port publication was checked before each
of the two runs (`docker port brainstand-gbrain-ops-1` → `3140/tcp -> 0.0.0.0:3140`); after
`test/integration` it had been dropped, as the ordering note below predicts, and the documented dev
stack was re-upped before `test/contract`.

```
$ bun run lint:forbidden
lint:forbidden clean

$ bunx tsc --noEmit
(exit 0, no output)

$ bun test test/unit                        # close-out pass, not re-run by the follow-up pass
 602 pass
 0 fail
 2171 expect() calls
Ran 602 tests across 45 files. [2.45s]

$ CONTROL_DATABASE_URL=postgres://gbrain:ci-not-a-real-secret@localhost:5432/control bun test test/integration
 428 pass
 1 skip
 0 fail
 1782 expect() calls
Ran 429 tests across 30 files. [53.60s]

$ bun test test/contract
 142 pass
 0 fail
 594 expect() calls
Ran 142 tests across 14 files. [381.64s]

$ bun test --parallel=1 test/e2e           # first of the two consecutive runs (close-out pass, not re-run)
 104 pass
 0 fail
 1006 expect() calls
Ran 104 tests across 6 files. [1236.81s]

$ bun test --parallel=1 test/e2e           # the second, from the state the first left (close-out pass)
 104 pass
 0 fail
 1006 expect() calls
Ran 104 tests across 6 files. [1277.94s]

$ bash test/build/pin.test.sh              # via Git bash
--- expecting SUCCESS at pin 0.50.5.0
PASS: pinned build succeeded
--- expecting FAILURE at a deliberately wrong pin
PASS: bogus pin was rejected

$ bash test/build/harness-pin.test.sh      # via Git bash
--- expecting SUCCESS at pin 2.1.274
PASS: pinned build succeeded
--- expecting FAILURE at a deliberately wrong pin
PASS: bogus pin was rejected at the harness install
```

**Against the plan's baselines** (≥ 421 unit · ≥ 314+1 skip integration · ≥ 83 contract · ≥ 77 e2e, each
with 0 fail):

| Command | Baseline | Measured | Verdict |
|---|---|---|---|
| `lint:forbidden` | clean | clean | — |
| `tsc --noEmit` | clean | clean | — |
| `test/unit` | ≥ 421 / 0 | **602 / 0** | **+181** |
| `test/integration` | ≥ 314+1 skip / 0 | **428 / 1 skip / 0 of 429** | **+114 pass on the baseline; green** |
| `test/contract` | ≥ 83 / 0 | **142 / 0 of 142** | **+59 pass on the baseline; green** |
| `test/e2e` | ≥ 77 / 0, twice | **104 / 0** twice consecutively | **+27** |
| `pin.test.sh` / `harness-pin.test.sh` | both arms PASS | both arms PASS | — |

### The final-verification pass (2026-09-18, after the sign-in page and the runner-presence gate landed)

Re-measured on the frozen tree, one command at a time, nothing else against the stack, after the two
uncommitted product changes of that day (`src/console/pages/SignIn.tsx` + the console's `phaseFor`, and
`src/agent/runners.ts` + `0007_runner_presence.sql` + the runs/health/schedules routes). Verbatim tails:

```
$ bun run lint:forbidden
lint:forbidden clean                          # exit 0

$ bunx tsc --noEmit
(exit 0, no output)

$ bun test test/unit
 628 pass
 0 fail
 2267 expect() calls
Ran 628 tests across 46 files. [2.05s]

$ CONTROL_DATABASE_URL=postgres://gbrain:ci-not-a-real-secret@localhost:5432/control bun test test/integration
 434 pass
 1 skip
 0 fail
 1804 expect() calls
Ran 435 tests across 30 files. [50.80s]

$ bun test test/contract                     # after the dev stack was re-upped (docker port -> 3140/tcp -> 0.0.0.0:3140)
 142 pass
 0 fail
 594 expect() calls
Ran 142 tests across 14 files. [384.82s]

$ bash test/build/pin.test.sh                # via Git bash, GBRAIN_VERSION=0.50.5.0
--- expecting SUCCESS at pin 0.50.5.0
PASS: pinned build succeeded
--- expecting FAILURE at a deliberately wrong pin
PASS: bogus pin was rejected

$ bash test/build/harness-pin.test.sh        # via Git bash, HARNESS_VERSION=2.1.274
--- expecting SUCCESS at pin 2.1.274
PASS: pinned build succeeded
--- expecting FAILURE at a deliberately wrong pin
PASS: bogus pin was rejected at the harness install
```

`test/unit` is **628 / 0** (+26 on the close-out pass's 602: the new `test/unit/console-app.test.ts` and
the console-polish unit tests) and `test/integration` **434 pass / 1 skip / 0 fail of 435** (+6 on 428).
`test/contract` is unchanged at **142 / 0 of 142**. Both build gates pass both arms.

**`bun test --parallel=1 test/e2e` first came back red twice, and the cause was the credential, not the
tree.** Both of those runs measured **93 pass / 11 fail** (B5–B8 and C3–C8, C11) with
`[gate-c] Gate C total model spend = $0.0000000 over 4 run(s)`: every money leg failed because the
gateway's upstream answered, verbatim, `{"type":"error","error":{"type":"authentication_error","message":
"OAuth access token has been revoked."}}` — the org's stored `anthropic_api_key` is this machine's Claude
Code OAuth access token (the runbook's own measured fact) and the CLI's morning refresh revoked it. The
credential was re-provisioned host-side from `~/.claude/.credentials.json` (value never printed; the
token authenticated upstream directly with the gateway's own auth shape, `200`), and the two consecutive
directory runs then measured:

```
$ bun test --parallel=1 test/e2e           # first, after the credential was re-provisioned
 104 pass
 0 fail
 1011 expect() calls
Ran 104 tests across 6 files. [1336.39s]
[gate-c] Gate C total model spend = $0.0656777 over 5 run(s)

$ bun test --parallel=1 test/e2e           # the second, from the state the first left
 104 pass
 0 fail
 1011 expect() calls
Ran 104 tests across 6 files. [1327.58s]
[gate-c] Gate C total model spend = $0.0660306 over 5 run(s)
```

Both are far above the plan's `≥ 77 pass / 0 fail` baseline, and the second started from exactly the
state the first left (its teardown deletes every fixture and leaves the write Space clean and the lane
enabled). **The two green runs cost `$0.0656777` + `$0.0660306` = `$0.1317083` of real model spend**;
the two red passes cost `$0.0000000` (the refusal happens before any upstream connection). One further
note the next session needs: the e2e family's own cycles (`restore.e2e.test.ts`'s control-DB reload, the
upgrade gate's rollback) **undo a credential rotation** — measured: a version stored at 11:41:55 was gone
after the next pass's cycle, four separate re-provisions were needed across these runs, and the gate's
`beforeAll` requires **exactly one** `anthropic_api_key` row for the org, so a repair must replace that
row rather than add a version (adding one produced `PRECONDITION FAILED: … (found 2 rows)`). Full
account: `docs/runbooks/agent-runner.md`, "Rotating the Anthropic key"; `HANDOFF.md`'s live-state block.

The integration `1 skip` is the platform opt-out, not a silent gap: `[fileplane.test.ts] Skipping
"config.json is written 0600" on win32: NTFS has no POSIX permission bits`. The unit run also echoes two
Postgres `NOTICE`s (`schema "drizzle" already exists, skipping`) from its own probe — notices, not
failures.

### The five integration failures and the contract failure — found by the close-out pass, fixed in `9efc992`

The close-out pass measured 5 integration failures and 1 contract failure, reproduced them, and named
their causes; `test/` and `src/` were outside its scope, so it recorded them open. Commit **`9efc992`**
("test(slice4): close the last six verification failures") then fixed all of them **without weakening a
test or a gate**, and the follow-up pass re-ran both suites alone: **428 pass / 1 skip / 0 fail of 429**
and **142 pass / 0 fail of 142**. Below is the recorded history with its fix, and the systemic gap the
fix does not close.

**1 — three contract-drift legs in `test/integration/claim.test.ts` (fixed).** `src/control/connections.ts`
(commit `9bd33de`, Slice 4 Task 5) now provisions **two** gbrain clients per Connection — the member's and
a **server-side** one whose credentials handoff is taken **first** — so a winning claim grants twice and
hands off two credential files. `test/integration/connections.test.ts` was updated in that commit while
**`claim.test.ts` was not**, so its three assertions still pinned one grant / one receipt per Connection:
`concurrent claims — exactly one wins` (expected 1, got 2), `membership with two pending Connections
provisions both` (expected 2, got 4) and `credentials from takeGrantCredentials …` (an extra
`/srv/gbrain-home/.creds-<id>-server.json`). The assertions now name the contract they pin — the grant
pair (`clientName(membershipId, sourceId)` then `serverClientName(clientName(...))`) and the take pair
(`serverCredentialsOutPath(id)` before `grantCredentialsOutPath(id)`) — instead of the count they
happened to see.

**2 — `capability snapshots and drift > with only one version recorded, driftBetween refuses` (fixed).**
`capability_snapshots` is keyed by version text with **no owner column**, and this slice's new
`test/integration/agent-runs.test.ts:181` legitimately seeds the **running pin's** catalog (`0.50.5.0`)
so D5 has a tool surface to read. Under `bun test test/integration` the files run concurrently, so that
row landed between `capability.test.ts`'s `recordCapabilitySnapshot(FROM)` and its
`driftBetween(FROM, TO)`: the "only one version recorded" premise stopped being true, and `driftBetween`
correctly did not refuse. Worse, `capability.test.ts`'s own `afterAll` deleted precisely the bare
`0.50.0.0` / `0.50.5.0` rows a sibling had written. Its fixture is now scoped by a **per-run suffix**
(`0.50.0.0-<run>` / `0.50.5.0-<run>`), so the premise is a property of its own rows; the delta under test
is unchanged, because `driftBetween` compares version **strings** and reads every other field off the
rows.

**3 — `backup > the manifest records that the worker was quiesced` (fixed — and this one was NOT the race
it appeared to be).** The manifest read `quiesced: false` from a provably quiesced stack. The cause is not
timing: **six files in `test/integration` mock `src/control/opsClient.ts` process-wide** (`agent-runs`,
`claim`, `connections`, `routes`, `scheduler-routes`, `wizard`), and **Bun applies a module mock to
whichever file links the module next** — so `scripts/backup.ts`'s real `jobs.supervisorStatus` call was
answered by a sibling's fake. Measured with the fix reverted: the reply came back
`{ok:true, exitCode:0, argv:["gbrain"], stdout:"{}"}` while `docker compose ps` showed scheduler and
`gbrain-worker` **stopped**, and the reply's shape named `agent-runs.test.ts`'s `ok({})` fake as the
respondent. **Recorded as a hazard, not as a flake: any file that needs the real ops client is a race
victim of whichever sibling file links `opsClient.ts` first.** Two mitigations landed, neither of them a
weakening:

- **`test/helpers/stack.ts`'s cross-process exclusion lock** (`withStackExclusion`) — an atomic `mkdir`
  lock under the OS temp dir, pid-stamped and stale-broken — held by the only two files that mutate which
  services run (`backup.test.ts`, `quiesce.test.ts`). It serializes **service state**, so one file's
  stop/start can no longer decide another file's verdict. `--parallel=1` is not an available substitute:
  in one process the suite's own partial `mock.module` calls poison each other (measured below).
- **`backup.test.ts` runs the real `scripts/backup.ts` in its own process** (`Bun.spawn(['bun','-e',…])`),
  which has no registered mocks — the only isolation Bun offers here, and how an operator runs that host
  script anyway. Its `quiesced` read is therefore real again.

**The systemic fix is NOT done, and it belongs to Slice 5.** The right shape is to route the runtime's ops
access through an **injectable caller**, exactly as `src/upgrade/quiesce.ts` already does with its
`OpsCaller` type (`httpOpsCaller()` by default, `relayOpsCaller(compose)` for the in-container lane,
`opts.ops` to inject). With that seam a test injects a fake **deliberately** instead of a process-wide
`mock.module` answering a real call; until it exists, the lock and the fresh process are containment, not
the cure.

**4 — `test/contract`: one stale count pin (fixed).** `test/contract/upgrade.contract.test.ts:295`
asserted `expect(doc.operations.length).toBe(33); // 31 at Slice 3 close + 2`; the pinned
`contracts/v0.50.5.0/operations.json` holds **34**, because F16 added `page.delete` to the registry. The
pin now reads **34 with the reason written next to it** (33 at Slice 3.5 close + `page.delete`), and the
two operations the test is actually about (`checkUpdate`, `postUpgrade`) still assert as before.

**The ordering hazard is real, unchanged, and was hit again by the follow-up pass.** The close-out pass's
first `test/contract` run came back **130 pass / 12 fail**, every failure `ConnectionRefused` against
`http://127.0.0.1:3140/rpc`: `test/integration/quiesce.test.ts` runs its real quiesce/resume round trip
through `docker compose -f compose/docker-compose.yml` **only** — no dev override — and `resume()`'s
`up -d --no-deps` therefore **recreates `gbrain-ops` without the dev override's `3140:3140` publication**
(measured: `HostConfig.PortBindings = {}`). After the follow-up pass's `test/integration` run,
`docker port brainstand-gbrain-ops-1` printed **nothing**; the documented dev stack was brought back up
(`docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml up -d
--wait`, after which the binding is `3140:3140` and `/rpc` answers `401` without the bearer) before
`test/contract`, which then ran green. **Run `test/integration` before, not after, the host-run suites, or
re-up the dev stack in between.**

**A `--parallel=1` diagnostic is not an apples-to-apples control.** Run by the close-out pass on the red
state it gave **318 pass / 1 skip / 8 fail / 4 errors**: with one process for all files, the suite's own
partial `mock.module` calls poison each other (`SyntaxError: Export named 'deleteCredentialJournal' not
found in module 'src/control/opsClient.ts'` ×2, `gitPathExists` ×1, `SingleSnapshotError` ×1), so 4 files
never load and 102 tests never run. The plan's baseline command is the default-parallel one for exactly
this reason.

### Carried into Slice 5

- **`scripts/backup.ts`'s quiesce probe reads `quiesced` through the ops client whose default URL is a
  container name** — `src/control/opsClient.ts:6`, `process.env.OPS_RPC_URL ?? 'http://gbrain-ops:3140'`.
  Correct inside the compose network, unresolvable on a **production host**, where the dev override's
  `3140:3140` publication does not exist; the host-run `scripts/backup.ts` therefore only works if the
  operator exports `OPS_RPC_URL`, and its probe's `catch { quiesced = true; }` turns a connection failure
  into a **pass** rather than a refusal. Pre-existing (not this slice's) and **unmeasured on a production
  host** — a Slice 5 row: either the host script learns the deployment's own ops URL, or the probe fails
  loudly instead of guessing.
- **`test/integration/agent-runs.test.ts` leaves one `capability_snapshots` row behind per run**:
  `seedCapabilitySnapshot()` (line 179) inserts the running pin's catalog so D5 has a tool surface, and
  nothing deletes it. The table is keyed by version text with no owner column, so rows accumulate
  (`0.50.5.0`, one per run) — and after `9efc992` `capability.test.ts` no longer deletes the bare rows
  either (it is scoped to its own suffixed pair). Give the table an owner, or give the fixture a teardown.
- **The `mock.module` hazard above has no systemic cure yet.** Routing the runtime's ops access through an
  injectable caller — the shape `src/upgrade/quiesce.ts`'s `OpsCaller` already uses — is Slice 5's work;
  today's containment is `test/helpers/stack.ts`'s service-state lock plus `backup.test.ts`'s fresh
  process, and a new file that needs the **real** ops client can still be answered by a sibling's mock.
- **`test/contract/upgrade.contract.test.ts:295`'s pin now reads `34`** (with the reason in the comment) —
  nothing outstanding; Slice 5 must keep it true if it adds an operation.
- **`test/integration/quiesce.test.ts` resumes through the base compose file**, so it silently drops the
  dev override's port publications. Slice 5's provisioner work should decide whether the quiesce lane
  takes the deployment's own compose invocation rather than a hard-coded one.
- **No product path retries a `lease_expired` agent run** (F15). C8's second attempt is written by the
  gate. The retry policy exists and is classified; nothing calls it for that class.
- **The runner is not restored by a quiesce/resume cycle** (D12/D13): `restoreLane` deliberately does not
  bring back a service whose profile is inactive, so `agent-runner` exits 0 on the quiesce and stays
  down. A restore or an upgrade therefore **leaves the lane off** until an operator starts it.
- **`page.delete --purge` is local-CLI-only** by design (a remote caller gets `permission_denied`), and an
  ABSENT slug exits **1** with `page_not_found` on stderr and no JSON receipt — a caller reading only the
  exit code cannot tell "there was no page" from "the delete failed".
- **C11 cannot discriminate a denied-tool event at this pin**: `--tools ""` removes the built-in surface
  at the source, so `permission_denials` is `[]` and there is no `tool_use` at all. The runbook was
  corrected to say so rather than to keep the "produces a denied-tool event" claim.
- **The `runner_never_seen` alert kind has no product writer**; the claim refusal code of the same name is
  a different surface, and the runbook says so.
- **`capability_snapshots`' multi-tenant story** (carried from Slice 3.5) is still open — the writer
  exists now, the per-tenant rendering does not.
- **The remaining Slice 3/3.5 carry-overs that this slice did not consume**, restated rather than dropped:
  no schema-version surface in any published contract (U6); `check-update` reads master's `VERSION` and is
  deliberately not schedulable; one snapshot driver (`docker-volume`); multi-version upgrade jumps
  untested; the `blocked` run state declared but never written; spend not rolled up per member/org.

---

## Slice 5 — Task 18 verification

**Steps 1–7.** Step 1 ran the eight commands on the frozen tree at `703fea2`, one at a time (verbatim tails
below). Steps 2–7 finalised `docs/slice-5-findings.md`, created `CHANGELOG.md` with the three full
`RepoDigest`s, tagged and pushed the release, verified the published artifacts from **outside this machine**
(the `release-verify` run below), rewrote `HANDOFF.md`, and closed the roadmap.

**Environment.** On entry the dev stack held only `caddy` and `postgres`: compose now defaults its image
namespace to `${IMAGE_NAMESPACE:-molanojf}` (Task 5 / P4), the host's local tags were the pre-rename
`ghcr.io/mobrain/*`, and a GHCR pull is denied on this host (P4 — the token lacks `write:packages`), so
the three images were rebuilt from HEAD under the production namespace with the build overlay and the
stack was brought up with the base + dev files. `docker port brainstand-gbrain-ops-1` read
`3140/tcp -> 0.0.0.0:3140` before each host-run suite. Commands 1–3 ran from the same shell; nothing else
touched the stack.

Verbatim tails (host local time, `-05:00`):

```
$ bun run lint:forbidden
lint:forbidden clean                                      # exit 0

$ bunx tsc --noEmit
(exit 0, no output)

$ bun test test/unit
 649 pass
 0 fail
 2308 expect() calls
Ran 649 tests across 49 files. [2.24s]

$ CONTROL_DATABASE_URL=postgres://gbrain:ci-not-a-real-secret@localhost:5432/control bun test test/integration
 441 pass
 1 skip
 0 fail
 1840 expect() calls
Ran 442 tests across 31 files. [96.48s]
# START=2026-09-18T22:12:59-05:00  END=2026-09-18T22:14:36-05:00

$ bun test test/contract
 146 pass
 0 fail
 601 expect() calls
Ran 146 tests across 15 files. [389.33s]
# after the dev stack was re-upped (quiesce.test.ts dropped the :3140 publication)
# START=2026-09-18T22:24:35-05:00  END=2026-09-18T22:31:05-05:00

$ bun test --parallel=1 test/e2e           # first of the two consecutive runs
 114 pass
 8 skip
 0 fail
 1112 expect() calls
Ran 122 tests across 8 files. [1933.66s]
[gate-c] Gate C total model spend = $0.0649797 over 5 run(s)
# START=2026-09-19T00:06:30-05:00  END=2026-09-19T00:38:43-05:00

$ bun test --parallel=1 test/e2e           # the second, from the state the first left
 114 pass
 8 skip
 0 fail
 1113 expect() calls
Ran 122 tests across 8 files. [1830.75s]
[gate-c] Gate C total model spend = $0.0655791 over 5 run(s)
# START=2026-09-19T00:54:00-05:00  END=2026-09-19T01:24:31-05:00

$ bash test/build/pin.test.sh              # via Git bash, GBRAIN_VERSION=0.50.5.0
--- expecting SUCCESS at pin 0.50.5.0
PASS: pinned build succeeded
--- expecting FAILURE at a deliberately wrong pin
PASS: bogus pin was rejected

$ bash test/build/harness-pin.test.sh      # via Git bash, HARNESS_VERSION=2.1.274
--- expecting SUCCESS at pin 2.1.274
PASS: pinned build succeeded
--- expecting FAILURE at a deliberately wrong pin
PASS: bogus pin was rejected at the harness install
```

**Against the baseline** (unit 628 · integration 434 + 1 skip · contract 142/0 · e2e 104/0 twice; every
count with 0 fail):

| Command | Baseline | Measured | Verdict |
|---|---|---|---|
| `lint:forbidden` | clean | clean | — |
| `tsc --noEmit` | clean | clean | — |
| `test/unit` | 628 / 0 | **649 / 0** | **+21** |
| `test/integration` | 434+1 skip / 0 | **441 / 1 skip / 0** of 442 | **+7 pass** |
| `test/contract` | 142 / 0 | **146 / 0** of 146 | **+4 pass** (after F32) |
| `test/e2e` | 104 / 0, twice | **114 / 8 skip / 0** twice of 122 | **+10 pass**; the 8 skips are `install.e2e`'s CI-only Gate A |
| `pin.test.sh` / `harness-pin.test.sh` | both arms PASS | both arms PASS | — |

The integration `1 skip` is the platform opt-out
(`[fileplane.test.ts] … on win32: NTFS has no POSIX permission bits`), not a silent gap. The unit run's
two Postgres `NOTICE`s are from its own probe, not failures.

**The one defect this run found — F32.** The first `test/contract` run came back **143 pass / 3 fail**:
every failure the new `test/contract/usage.contract.test.ts` answering `ConnectionRefused` to
`http://127.0.0.1:1/rpc`. `test/contract/connection.contract.test.ts` runs `scripts/connection-e2e.ts`,
which sets `process.env.OPS_RPC_URL='http://127.0.0.1:1'` and did not restore it, while
`src/control/opsClient.ts` bound that variable at module load; Bun runs the directory in one process, so
the sibling file inherited the dead URL. Fixed by resolving the ops endpoint/bearer at call time and
restoring the env in a `finally` — no test or gate weakened. Full account in
[`docs/slice-5-findings.md`](../../slice-5-findings.md), F32. After the fix, contract re-measured
**146/0** and `test/unit` re-measured **649/0**, both above baseline.

**The e2e runs and the rotating Anthropic credential.** e2e was **red twice before it was green**, and
both reds were environmental, not a tree defect:

1. **Attempt A** (`2026-09-18T22:36:02` → `23:17:22`): **101 pass / 8 skip / 13 fail**, Gate C spend
   `$0.0000000 over 4 run(s)`. Every money leg (slice4 B5–B8 and C3–C8/C11; slice5 C5/C6) answered
   `401 authentication_error` / `OAuth access token has been revoked.` `slice35.e2e`'s `normalizeToFromPin`
   rolls back the latest completed upgrade run to reach `0.50.0.0`, and the latest on entry was the
   previous session's `run-5219d9eb`, whose snapshot's control DB carried a `secrets` generation from
   `17:27:25Z` — revoked when the machine's Claude Code refreshed the token at `21:52:25Z`. The rollback
   put that dead credential back and the real leg then snapshotted it.
2. **Attempt B** (`2026-09-18T23:25:50` → `2026-09-19T00:06:04`): the same 13, still `$0.0000000`. A new
   completed-run snapshot was built with a fresh `pg_dump` of the control DB, but the manifest rewrite
   carried a UTF-8 BOM, so `latestCompletedRunFromPin`'s `JSON.parse` skipped it and the precondition
   rolled back the stale run again.

**Attempt C** (`00:06:30` → `00:38:43`) and **Attempt D** (`00:54:00` → `01:24:31`) are the two consecutive
green runs above. Between them the host's Claude Code auto-refreshed the OAuth token at expiry
(`~/.claude/.credentials.json` mtime moved to `05:52:49Z`, new `expiresAt` `13:52:49Z`); the live `secrets`
row and the newest completed-run snapshot's `control-db.sql` were re-provisioned with the refreshed host
token (value never printed), per `docs/runbooks/agent-runner.md`, "Rotating the Anthropic key". The two
green runs cost **`$0.0649797` + `$0.0655791` = `$0.1305588`** of real model spend; the two red attempts
cost `$0.0000000` (every refusal happens before any upstream connection). No test or gate was weakened to
reach any of these numbers.

Recorded 2026-09-19 by the agent executing Task 18 Step 1.

### Task 18 Step 4 — the release pulled by digest from a machine that did not build it

The `publish` job of the `contract` workflow produced the three `RepoDigest`s below (run
[35443874477](https://github.com/MolanoJF/mobrain/actions/runs/35443874477) at `a74e324`); they are the
entries in `CHANGELOG.md`. `release-verify.yml` was then dispatched on a **fresh GitHub runner** — one that
has never held this repository's images — and pulled each artifact **by digest** and started it. Run
[35445223097](https://github.com/MolanoJF/mobrain/actions/runs/35445223097): **`verify` success in 44s**,
every step green. Verbatim output:

```
verify  Pull and start gbrain-base by digest
  Digest: sha256:9cd9ba37fe4feb78116ca70cfa91c2b8007d5a28ef934fb44261bd0858e4c7e4
  Status: Downloaded newer image for ghcr.io/molanojf/gbrain-base@sha256:9cd9ba37fe4feb78116ca70cfa91c2b8007d5a28ef934fb44261bd0858e4c7e4
  pulled ghcr.io/molanojf/gbrain-base@sha256:9cd9ba37fe4feb78116ca70cfa91c2b8007d5a28ef934fb44261bd0858e4c7e4
  gbrain 0.50.5.0
verify  Pull and start control-plane by digest
  Digest: sha256:67dbd8f492a5420e345e9e81879085e3c6b3a99cd811387e668068886bd8570c
  Status: Downloaded newer image for ghcr.io/molanojf/control-plane@sha256:67dbd8f492a5420e345e9e81879085e3c6b3a99cd811387e668068886bd8570c
  pulled ghcr.io/molanojf/control-plane@sha256:67dbd8f492a5420e345e9e81879085e3c6b3a99cd811387e668068886bd8570c
  1.3.13
verify  Pull and start agent-runner by digest
  Digest: sha256:d02d1e8452d73a2de95e39df4841e55896b123caaae5f45807acdba31ed14b6f
  Status: Downloaded newer image for ghcr.io/molanojf/agent-runner@sha256:d02d1e8452d73a2de95e39df4841e55896b123caaae5f45807acdba31ed14b6f
  pulled ghcr.io/molanojf/agent-runner@sha256:d02d1e8452d73a2de95e39df4841e55896b123caaae5f45807acdba31ed14b6f
  2.1.274 (Claude Code)
```

All three pulled by digest and started: `gbrain 0.50.5.0` (the pinned base), the control-plane image's
`bun 1.3.13`, and the agent-runner harness `2.1.274 (Claude Code)`. Gate A's assertion — *a host that did not
build it can run it* — holds against the actual release, not the CI build of it.

---

- 2026-09-14 — Plans written (roadmap + Slice 0 + Slice 1). Self-review found 3 gaps before execution.
- 2026-09-14 — Docker absent; executed the Docker-independent subset (Tasks 1 partial, 3, 11 pure, 14). 3 plan defects found.
- 2026-09-14 — Docker installed. Pin gate repaired and green. Tasks 2, 4, 5 done — **V3 confirmed**.
- 2026-09-14 — Tasks 6–10 done (one agent hit a usage limit mid-Task-8; resumed from repo state, not from its report).
- 2026-09-14 — Tasks 11–13 done. Isolation check rebuilt from theatre into a real per-member OAuth proof.
- 2026-09-14 — Findings doc filled, wrong-pin tripwire verified, consequences propagated. **SLICE 0 COMPLETE.**
- 2026-09-15 — Slice 1 started on `slice-1-deploy-one-brain`. Tasks 1–2 complete. Ten plan defects found and patched back, including a decorative `/admin` seal whose own test would have certified it. A pre-existing `lint:forbidden` break (introduced by HANDOFF.md quoting the pattern it forbids) repaired by narrowing scope, never rules. Docker-gated suites can no longer skip silently.
- 2026-09-15 — Slice 1 Tasks 3–15 complete, whole-branch review, merge-blocking install `--env-file` + restore `compose exec` fixes. Fast-forwarded to `main` (`77a18d1`). Feature branch deleted.
- 2026-09-15 — Retired mid-Slice-1 resume notes (`HANDOFF.md`, plan banners, roadmap environment block) so a new session does not re-execute Slice 0/1.
- 2026-09-15 — Slice 2 executed on `slice-2-members-connections`. Gates A/B/C green. **SLICE 2 COMPLETE.** Next: Slice 3.
- 2026-09-15 — Slice 3 implemented on `main`. Gates A (18 pass) and B+C (25 pass, twice) green. **Task 19 Step 5 RED — 3 of 6 commands fail:** `bun test test/unit` without an exported `CONTROL_DATABASE_URL` (F1), `test/integration/auth.test.ts` stale table allowlist (F2), `test/e2e/restore.e2e.test.ts` post-restore `doctor` exit code (F3, cause open). Recorded with raw output; no code changed, nothing marked complete.
- 2026-09-16 — Task 19 Step 5 re-run against the three fixes. **F1 and F2 are fixed; the file-plane half of F3 is fixed** (`scripts/restore.ts` re-materializes the pin before the services boot — the restore e2e now clears `report.ok` and `doctorExitCode` and fails one assertion later, at its unqualified `gbrain search`, which is a search-scope artifact and not restored-data loss; raw evidence in the Slice 3 section). `lint:forbidden`, `tsc --noEmit`, `test/unit` (292/0), `test/integration` (255+1 skip/0) green; `test/contract` failed once (A7 `sync` exit 1, suspect stack state) and green on two re-runs (69/0); `bun test --parallel=1 test/e2e` red in both runs (52/2 of 54) — the Slice 1 restore search assertion and one Slice 1 routing 502, the latter a readiness race after the restore file's `down -v`. **Slice 3 is not marked complete**; the Slice 3.5 entry gate is unresolved. **Superseded by the final green run in the entry below.**
- 2026-09-16 — Task 19 Step 5 final run, **all six commands green**: `lint:forbidden` + `tsc --noEmit` clean, `test/unit` 292/0, `test/integration` 255 pass + 1 skip (win32 0600 opt-out) / 0, `test/contract` 69/0 (18 in the slice-3 file), `bun test --parallel=1 test/e2e` 54/0 across 4 files — twice, the second from a cold stack. The two remaining reds were closed by **F4** (the wizard now passes `federated: true` at both `sources.add` call sites — a Slice 1/2 product gap the exit gate exposed, `src/control/routes/wizard.ts`) and **F5** (`slice1.e2e`'s `beforeAll` now waits for `/.well-known/gbrain` 200 as well as the console health — `test/e2e/slice1.e2e.test.ts`). Both plan copies carry matching `Corrected 2026-09-16` blockquotes and are byte-identical. **SLICE 3 COMPLETE.** Next: Slice 3.5.
- 2026-09-16 — Slice 3.5 executed on `slice-3.5-upgrades`. Gate A `test/contract/upgrade.contract.test.ts` 14/0, Gate B+C `test/e2e/slice35.e2e.test.ts` 23/0, and the six-command verification run: `lint:forbidden` + `tsc --noEmit` clean, `test/unit` 421/0, `test/integration` 314+1 skip/0, `test/contract` 83/0, `test/e2e` **68 pass / 9 fail** (B9 + C4 + the C6–C12 cascade; root-caused to F7 — `capability_snapshots` has no product writer, and C6's preflight needs a healthy `doctor` after the failure leg). The dev stack is left healthy on **0.50.5.0** (`/api/health` 200, `pin.matches: true`, `gbrain-ops` binary `gbrain 0.50.5.0`). Three defects fixed during the slice: the nested journal path the reconciler could never read, the rollback busy loop (a circular dynamic import re-entering the CLI entry), and Bun's start-time environment snapshot shadowing the pin the swap had just rewritten. Findings: [`docs/slice-3.5-findings.md`](../../slice-3.5-findings.md); runbook: [`docs/runbooks/upgrade.md`](../../runbooks/upgrade.md). Next: Slice 4.
- 2026-09-17 — Slice 3.5 closed. The 68/9 red was real and is fixed: **F7** (the run now captures both pins' capability and the reconciler imports them; C6 repairs the residue its own fixture caused), **F8** (the digest's `filePlane` no longer hashes gbrain's runtime state, so a correct rollback compares equal again), **F9** (the gate normalizes its entry state and pairs the fixture with its undo in `try/finally` + `afterAll`). **All six commands green**, and `bun test --parallel=1 test/e2e` is **77 pass / 0 fail twice consecutively** from the 0.50.5.0 state the gate itself leaves. Fast-forwarded to `main` (`202a658`); feature branch deleted. **SLICE 3.5 COMPLETE.** Next: Slice 4.
- 2026-09-18 — Slice 4 closed and **merged to `main` at `6ba1754`** (`main` is the only branch again). Gates A/B/C green (Gate A **57/0** alone; Gate C's file **27/0** in F17's acceptance run; the family `bun test --parallel=1 test/e2e` **104/0 twice consecutively** — 1236.81s then 1277.94s — with `$0.0652572` + `$0.0630768` of real model spend, Gate C's 5-run teardown logging each figure). The six commands and the two build gates: `lint:forbidden` clean · `tsc --noEmit` clean · `test/unit` **602/0** (+181 on the 421 baseline) · `test/integration` **423 pass / 1 skip / 5 fail of 429** and `test/contract` **141 pass / 1 fail of 142** — red, reported not smoothed, and **both closed the same day in `9efc992`**: three stale `claim.test.ts` counts against Task 5's deliberate second, server-side client per Connection; one `capability_snapshots` fixture shared with this slice's new `agent-runs.test.ts`; `backup.test.ts` answered by a sibling file's process-wide `mock.module` of the ops client (**a hazard, not the race it looked like**); and the `doc.operations.length` pin, now 34 with its reason in the comment · both build gates' two arms PASS. A first `test/contract` run came back **130/12** with every failure `ConnectionRefused` to `http://127.0.0.1:3140/rpc`: `test/integration/quiesce.test.ts` resumes through `compose/docker-compose.yml` **alone**, and `up -d --no-deps` recreates `gbrain-ops` without the dev override's `3140:3140` publication. **The exit gate's third promise (the budget cap) is green; the revert promise was RED and needed a real product fix the gate found** — F15 named it, F16 added the `page.delete` operation and made the revert name the pages it removed, F17 removed C9's structural race; C6's three clauses were never softened. Docs landed with the slice: `docs/slice-4-findings.md` (U1–U8 and P1–P9 statuses, F1–F17, Gate C's numbers and spend), `docs/runbooks/agent-runner.md`, this file, `HANDOFF.md` and the roadmap. **SLICE 4 COMPLETE.** Next: Slice 5.
- 2026-09-18 — **Slice 4 verification closed green** (same day). `9efc992` fixed the last six failures without weakening a test or a gate: `claim.test.ts` pins the two-clients-per-Connection contract by name, `capability.test.ts` scopes its fixture with a per-run version suffix, `backup.test.ts` holds `test/helpers/stack.ts`'s new cross-process stack-exclusion lock and runs the real `scripts/backup.ts` in its own process (the only isolation Bun offers against a sibling's process-wide `mock.module` of the ops client), and `upgrade.contract.test.ts:295` moved 33 → 34 with the reason in the comment. Re-measured alone, in the documented order, by a follow-up pass: `test/integration` **428 pass / 1 skip / 0 fail of 429** (1782 `expect()` calls, 53.60s) and `test/contract` **142 pass / 0 fail of 142** (594 `expect()` calls, 381.64s) — verbatim tails in the Slice 4 section above. The dev override's `3140:3140` publication had to be restored between the two runs (the documented ordering hazard). The runner lane was brought back up afterwards — a quiesce or a restore leaves it down by design (D12/D13) — and `/api/health` reports its `runner` block. **All six commands green; Slice 4 then merged to `main` at `6ba1754`.** Next: Slice 5, unstarted and blocked on Open Question 2.
