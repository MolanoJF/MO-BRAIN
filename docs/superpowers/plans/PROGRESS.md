# Execution Progress

**New session? Start with [HANDOFF.md](../../../HANDOFF.md).**

**Plans:** [roadmap](./2026-09-14-brainstand-roadmap.md) · [Slice 0](./2026-09-14-slice-0-cli-lane-proof.md) (historical) · [Slice 1](./2026-09-14-slice-1-deploy-one-brain.md) (historical)
**Findings:** [docs/slice-0-findings.md](../../slice-0-findings.md) — Slice 0 risk register. [docs/slice-2-findings.md](../../slice-2-findings.md) — Open Q1 25-Space scale probe. [docs/slice-3-findings.md](../../slice-3-findings.md) — upstream-claim statuses for Slice 3.
**Branch:** `main` — Slice 3's implementation is committed there; `test/e2e/slice3.e2e.test.ts` and the Slice 3 docs were still untracked at close. Slice 2 remains complete on `slice-2-members-connections`, not yet merged. **Slice 3 is complete — all six Task 19 Step 5 commands green** (`test/unit` 292/0, `test/integration` 255+1 skip/0, `test/contract` 69/0, `test/e2e` 54/0 run twice including from a cold stack, `lint:forbidden` and `tsc --noEmit` clean).

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

Members + Connections on `slice-2-members-connections`. Not yet merged to `main`.

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
- 2026-09-15 — Slice 2 executed on `slice-2-members-connections`. Gates A/B/C green. **SLICE 2 COMPLETE.** Next: Slice 3.
- 2026-09-15 — Slice 3 implemented on `main`. Gates A (18 pass) and B+C (25 pass, twice) green. **Task 19 Step 5 RED — 3 of 6 commands fail:** `bun test test/unit` without an exported `CONTROL_DATABASE_URL` (F1), `test/integration/auth.test.ts` stale table allowlist (F2), `test/e2e/restore.e2e.test.ts` post-restore `doctor` exit code (F3, cause open). Recorded with raw output; no code changed, nothing marked complete.
- 2026-09-16 — Task 19 Step 5 re-run against the three fixes. **F1 and F2 are fixed; the file-plane half of F3 is fixed** (`scripts/restore.ts` re-materializes the pin before the services boot — the restore e2e now clears `report.ok` and `doctorExitCode` and fails one assertion later, at its unqualified `gbrain search`, which is a search-scope artifact and not restored-data loss; raw evidence in the Slice 3 section). `lint:forbidden`, `tsc --noEmit`, `test/unit` (292/0), `test/integration` (255+1 skip/0) green; `test/contract` failed once (A7 `sync` exit 1, suspect stack state) and green on two re-runs (69/0); `bun test --parallel=1 test/e2e` red in both runs (52/2 of 54) — the Slice 1 restore search assertion and one Slice 1 routing 502, the latter a readiness race after the restore file's `down -v`. **Slice 3 is not marked complete**; the Slice 3.5 entry gate is unresolved. **Superseded by the final green run in the entry below.**
- 2026-09-16 — Task 19 Step 5 final run, **all six commands green**: `lint:forbidden` + `tsc --noEmit` clean, `test/unit` 292/0, `test/integration` 255 pass + 1 skip (win32 0600 opt-out) / 0, `test/contract` 69/0 (18 in the slice-3 file), `bun test --parallel=1 test/e2e` 54/0 across 4 files — twice, the second from a cold stack. The two remaining reds were closed by **F4** (the wizard now passes `federated: true` at both `sources.add` call sites — a Slice 1/2 product gap the exit gate exposed, `src/control/routes/wizard.ts`) and **F5** (`slice1.e2e`'s `beforeAll` now waits for `/.well-known/gbrain` 200 as well as the console health — `test/e2e/slice1.e2e.test.ts`). Both plan copies carry matching `Corrected 2026-09-16` blockquotes and are byte-identical. **SLICE 3 COMPLETE.** Next: Slice 3.5.
