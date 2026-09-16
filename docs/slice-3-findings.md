# Slice 3 findings — the scheduler lane (`gbrain_command` only)

> **Historical record.** Slice 3 is complete on `main` (gates A, B and C green). This is the status of
> every claim the Slice 3 plan made about upstream, plus the material findings execution surfaced. Do not
> re-open these as current work; the carried items live in `PROGRESS.md` and belong to Slice 3.5.

Status vocabulary: `confirmed` (the claim held as written) | `contradicted` (reality differed, and the
correction is named here) | `inference` (no artifact carries the observation; stated as such, never dressed
up as a measurement).

Every command and output below is quoted from the executing task's own artifact, the live pinned container
(`GBRAIN_VERSION=0.50.0.0`), the live product stack (`brainstand`, `localhost:3140`), or the read-only
gbrain reference checkout. Where a claim rests on source rather than a run, the file and line are cited
instead of a command. Nothing here is reconstructed from memory.

**Row count: 35 — 12 required by Task 19 Step 1, 23 material findings.**

| # | Claim | Status |
|---|---|---|
| R1 | `gbrain dream --dry-run --json` previews without writes | `confirmed` |
| R2 | `dream --json`'s real `CycleReport` key set | `confirmed` |
| R3 | `embed --json`'s real key set (`embedded` / `skipped` / `would_embed` / `total_chunks`) | `contradicted` |
| R4 | `sync --source --json` envelope (`added` / `modified` / `deleted` / `chunks_created` / `embedded`) | `confirmed` |
| R5 | `sources push` exit codes 0 / 1 / 2 / 4 / 5 and the `status` values behind them | `confirmed` |
| R6 | `sources push` prints its JSON receipt **before** a non-zero exit | `confirmed` |
| R7 | `doctor --json` still has no top-level `blockers` | `confirmed` |
| R8 | `.for('update', { skipLocked: true })` worked, or the raw-SQL fallback was used | `confirmed` |
| R9 | `onConflictDoNothing({ target })` narrowed correctly, or the bare form was used | `confirmed` |
| R10 | `Intl` rejected `Not/AZone`, or a stricter check was needed | `confirmed` |
| R11 | The report-write/commit ordering caveat produced a real collision, or did not | `confirmed` (it did not) |
| R12 | Whether any preset's default slot collided on a real org | `confirmed` (none did) |
| F1 | `/rpc` parsed the **first** `{` on stdout, so `sync --json` returned `json: null` | `contradicted` |
| F2 | `expect(drizzleThenable).rejects.toThrow()` HANGS under bun 1.3.14 | `contradicted` |
| F3 | A JS array bound through a drizzle `sql` template arrives as one scalar (22P02) | `contradicted` |
| F4 | postgres.js refuses a `bigint` query parameter at the TypeScript level | `contradicted` |
| F5 | `operations:emit` prints 31 operations, not the plan's 30 | `contradicted` |
| F6 | The Task 5 container fixture needs a real `gbrain init` plus `gbrain sources add` | `contradicted` |
| F7 | `applyCatchup`'s `run_all` cap had to budget across the whole run set | `contradicted` |
| F8 | `composeExec` in `src/docker/host.ts` targets the slice0 compose project, not the product | `contradicted` |
| F9 | `docker compose up -d --build control-plane` is a no-op | `contradicted` |
| F10 | The plan's integration URL `...@127.0.0.1:5433/control` does not exist here | `contradicted` |
| F11 | Browser sign-in at `https://localhost:8443` returns 403 `INVALID_ORIGIN` | `contradicted` |
| F12 | The 409 `slot_taken` body carries no `holder`; `GET /api/org/schedule-settings` had to be added | `contradicted` |
| F13 | Every Connection in the stack had membership role `member` | `confirmed` |
| F14 | A run row carries no reason for `skipped_catchup` / `skipped_overlap` / `held` | `confirmed` |
| F15 | `blocked` is a valid `schedule_runs.state` but no code path writes it | `confirmed` |
| F16 | Slice 3 left live state on the dev stack | `confirmed` |
| F17 | The Task 6 caveat's real shape: same job + same stamp overwrites silently | `confirmed` |
| F18 | A stale 5-minute schedule exceeds `MAX_OCCURRENCES_PER_TICK` instead of clamping | `contradicted` |
| F19 | `materializeDue` sweeps every enabled schedule with no org scope | `confirmed` |
| F20 | The plan's Task 12 Step 1 test does not typecheck | `contradicted` |
| F21 | The plan's Task 14 docstring trips the repo's own lint rule | `contradicted` |
| F22 | `stop_grace_period: 20s` is a compose-CLI-only value | `confirmed` |
| F23 | The plan's "all six CHECK constraints" is stale; the generated migration emits twelve | `contradicted` |
| F24 | A unit test that needs the control DB must install the env default in the file itself | `contradicted` |
| F25 | Adding tables requires extending the auth allowlist in `test/integration/auth.test.ts` | `contradicted` |
| F26 | A restore lost gbrain's file plane — and it is NOT a Slice 3 regression | `contradicted` |
| F27 | The failing restore e2e needed a WARM stack (harness property, not a defect) | `confirmed` |

The final round appended F24–F27 (the hand-off's F1–F4, in that order) after the first pass; they
supersede the `Row count:` line above, whose totals the first pass wrote. This doc's earlier findings keep
their F1–F23 numbering — the hand-off numbering for the new rows would have collided with it.

---

## R1 — `gbrain dream --dry-run --json` previews without writes

**Status: `confirmed`.** Where the plan relies on it: Task 5, Task 12.

Command (Task 5's container-backed contract test, pinned 0.50.0.0 container):

```
gbrain dream --source slice3-probe --dry-run --json
```

Observed: `exit 0`, **one prose line before the JSON** —

```
Full-sync dry run (strategy=markdown): 0 file(s) would be imported from /srv/brain-repos/slice3-probe @ 3abaaa7d.
```

— then the JSON object (8489 bytes of stdout in total). Raw stdout is therefore **not** `jq`-parseable; the
exec layer's "last balanced JSON value" rule handles it (see F1).

The same operation through the RPC boundary (Gate A, `A2. gbrain-ops dispatches dream through the RPC, not
just the module`): `opsRpc('dream', { source: PROBE_SOURCE }, { json: true, dryRun: true })` →
`exitCode: 0`, `error: undefined` — not `unknown operation`.

Corroboration that nothing ran: 23 phases, `4 ok / 18 skipped / 1 warn`, e.g.
`{"phase":"synthesize","status":"skipped","duration_ms":0,"summary":"excluded from implicit non-default
source cycle (mixed scope)","details":{"reason":"excluded_from_implicit_source_cycle","source_id":"slice3-probe","phase_scope":"mixed"}}`.

**Limitation stated plainly:** no task in this slice inspected the tree (or gbrain's tables) before and
after a dry run to prove zero writes. "Previews without writes" is `confirmed` for the flag and the payload
shape; the *zero-writes* half is `inference` from gbrain's dry-run semantics plus the zeroed tally, and is
not measured here.

## R2 — `dream --json`'s real `CycleReport` key set

**Status: `confirmed`** (the payload was captured, then the extractor was tightened to it). Where the plan
relies on it: Task 10's `changeCount`.

Command: `gbrain dream --source slice3-probe --dry-run --json` against the pinned container, exit 0.
Observed envelope, verbatim:

- top-level keys, exactly seven: `schema_version`, `timestamp`, `duration_ms`, `status`, `brain_dir`,
  `phases`, `totals`
- `status: "partial"` **with exit code 0** — a dry run reports `partial` because phases are
  excluded/skipped, not because anything failed
- `phases[]` item keys: `phase`, `status`, `duration_ms`, `summary`, `details`; distribution `ok 4 /
  skipped 18 / warn 1` (23 items); the `warn` phase is `lint`
- `totals`, 19 keys: `lint_fixes`, `backlinks_added`, `pages_synced`, `pages_extracted`, `pages_embedded`,
  `orphans_found`, `transcripts_processed`, `synth_pages_written`, `patterns_written`,
  `pages_emotional_weight_recomputed`, `edges_resolved`, `edges_ambiguous`, `purged_sources_count`,
  `purged_pages_count`, `facts_consolidated`, `consolidate_takes_written`, `phantoms_redirected`,
  `phantoms_ambiguous`, `phantoms_skipped_drift`

The extractor (Task 10) now requires that exact 19-key set, every value a finite number, and returns their
sum; any drift returns `null`, which forces the report to be written — drift fails in the safe direction,
because an incomplete sum can read 0 while pages were written, and a present-but-non-numeric counter
treated as 0 can hide a real write.

Why the plan's draft was wrong rather than merely unverified — the artifact's own regression probe:

```
bun -e "<draft dream extractor (phases.length) against the observed envelope literal>"
draft(observed envelope) = 23 (new test asserts 0)
```

`phases.length` is not a change count: the observed envelope carries 23 phases on a dry run of a single
source, and a real cycle carries a full phase list too, so it returned >0 on **every** run and never
returned `null` for a readable payload. `report_policy: on_change_or_failure` would have degenerated into
`always` (288 reports/day at a 5-minute cadence — exactly the commit flood the policy exists to prevent),
and the fail-safe property the plan relied on ("null forces the report") would never have engaged.

Tests after the tightening: `bun test test/unit/scheduler-commands.test.ts` → `21 pass, 0 fail, 76 expect()
calls, Ran 21 tests across 1 file. [45.00ms]` (the 19 plan tests verbatim plus 2 observed-payload tests).

## R3 — `embed --json`'s real key set

**Status: `contradicted`.** Where the plan relies on it: Task 10.

Command (pinned container):

```
gbrain embed --stale --source slice3-probe --json
```

Observed: `exit 0`, stdout exactly

```
Embedded 0 chunks (0 stale found)
```

41 bytes. **There is no JSON in the stdout, ever.** `embed.ts` contains no `--json` handling at all (no
`JSON.stringify`, no `args.includes('--json')`); `src/cli.ts:3062-3072`'s `case 'embed'` only inspects
`embedResult.failures` for the exit verdict (`failures > 0` → exit 1) and never serializes. The flag is
accepted by the pre-dispatch flag allowlist and then ignored — while `OPERATIONS.embed.supportsJson` is
`true` (a pre-existing registry entry the plan preserved verbatim).

The four keys the plan names are real, but they are internal. `src/commands/embed.ts:244-252` declares

```ts
export interface EmbedResult {
  embedded: number; skipped: number; would_embed: number; total_chunks: number;
  pages_processed: number; failures: number; failure_samples: string[];
  dryRun: boolean; chunkless_pages_healed: number;
}
```

and `src/commands/embed.ts:207-210` documents that the human stdout summaries are suppressed only for
"structured-output callers — the cycle's embed phase (`dream --json` must keep stdout JSON-clean per
`docs/progress-events.md`) reports counts via its own `PhaseResult` instead." So the counts reach the
`dream` cycle and never reach the CLI's own stdout.

Consequences for the report lane: a change-count extractor for `embed` must parse the prose
(`Embedded N chunks across M pages` / `Embedded 0 chunks (0 stale found)`), not a receipt. With the shipped
extractor it receives prose, returns `null`, and `on_change_or_failure` degenerates to `always` for embed
schedules — the fail-safe direction (a report is always written, never swallowed). Gate B observed the same
shape on a real run: the live-sync run row carried `summary | {"status": "synced", "changed": null}` because
the second step's payload is prose.

## R4 — `sync --source --json` envelope

**Status: `confirmed`** (with one plan omission, F1). Where the plan relies on it: Task 10.

Command (Gate A, through the RPC boundary):

```
curl POST /rpc {"op":"sync","params":{"source":"slice3-probe"},"json":true}
```

Observed stdout, two objects:

```
{"status":"below_floor","mode":"inline","gate":"below_floor","newTokens":3,"estimateKind":"delta","staleChars":0,"costUsd":6.000000000000001e-8,"floorUsd":0.5,"model":"text-embedding-3-small"}
{"schema_version":1,"source_id":"slice3-probe","sync_status":"synced","added":1,"modified":0,"deleted":0,"chunks_created":1,"embedded":1}
```

All five plan-named keys are present, plus `schema_version`, `source_id`, `sync_status`. The **first** object
is the embed cost gate, and its presence is what made the RPC response's own `json` field `null` before
F1's fix; after the fix the same call parses the receipt (A7 asserts
`receipt.added + receipt.modified > 0`, which the second object satisfies).

## R5 — `sources push` exit codes and the `status` values behind them

**Status: `confirmed`.** Where the plan relies on it: Task 5, Task 11.

Live observation (pinned container, probe source with no remote):

```
gbrain sources push slice3-probe --json
```

→ `exit 1` with a complete JSON receipt (body in R6). And for an unregistered source:

```
gbrain sources push <unregistered-id> --json
```

→ `exit 4`, with **no** JSON receipt at all.

The full code map, read from the pinned reference checkout — `src/commands/sources.ts:594-598` states it in a
comment, and each exit site is cited:

| Exit | `status` values | Site |
|---|---|---|
| 0 | `pushed`, `skipped_in_flight` (clean single-flight skip; the second concurrent caller exits 0) | `:652` |
| 1 | `error`, `push_failed`, `pull_conflict`; also "source has no `local_path`" | `:704`, `:634` |
| 2 | usage / unknown flag — **no JSON** | `:622` |
| 4 | source not found — **no JSON** | `:630` |
| 5 | `blocked_secrets`, `blocked_tracked_deny`, `blocked_unscannable`, `refused_visibility` | `:675`, `:683`, `:694`, `:700` |

Caveat stated rather than glossed: exit 5 was **not** produced live in this slice — it is source-cited at
the pin, and the executor's classification of it is what Gate B exercised indirectly. Exit 1 and exit 4 were
both observed live.

## R6 — `sources push` prints its JSON receipt before a non-zero exit

**Status: `confirmed`.** Where the plan relies on it: Task 11's classifier reads it.

Command (the same call as R5): `gbrain sources push slice3-probe --json`. Observed (exit 1, stdout
verbatim):

```json
{
  "ok": false,
  "status": "error",
  "repoRoot": "/srv/brain-repos/slice3-probe",
  "branch": "master",
  "committed": false,
  "reason": "no origin remote configured — nothing to push to"
}
```

Keys: `ok`, `status`, `repoRoot`, `branch`, `committed`, `reason`. The receipt is clean, complete JSON with
no prose prefix, written before the non-zero exit, so a caller can still read `status`/`reason` from a
failed push. stderr on this path was empty; the reason lives in the JSON only. That is why the classifier
can work at all — but Task 11 must not assume a receipt exists on exit 2 or 4.

## R7 — `doctor --json` still has no top-level `blockers`

**Status: `confirmed`** (Gate A9; Slice 0's V6 re-confirmed at this pin through the RPC lane). Where the plan
relies on it: Gate A9, Task 10.

Command: Gate A's `A9. doctor --json still has no top-level blockers key at this pin` →
`opsRpc('doctor', {}, { json: true })`. Observed top-level keys, exactly nine:

```
brain_checks_score, category_scores, checks, db_url_source, engine,
health_score, schema_version, status, top_issues
```

`blockers_present: false`; `status: "warnings"`; `checks` is an array. So the count is driven by
`checks[]`/`status`, exactly as Slice 0's V6 said — the weekly-health renderer's `changeCount`
(`status !== 'ok'`) walks `checks[]` and never reads a `blockers` key that does not exist.

## R8 — `.for('update', { skipLocked: true })` worked (no raw-SQL fallback needed)

**Status: `confirmed`.** Where the plan relies on it: Task 9.

Support, from the installed dependency:
`node_modules/drizzle-orm/pg-core/query-builders/select.types.d.ts:61` (`LockConfig { skipLocked: true }`)
and `pg-core/dialect.js:301-302` (emits `" skip locked"`).

Runtime proof, from a throwaway probe (deleted afterwards): the target row was held in another transaction
with `SELECT ... FOR UPDATE`, then

```
claimNextRun('worker-a', now) -> 'none' in 8 ms        (skipped the locked row, did not block)
plain FOR UPDATE on the same row, second connection -> BLOCKED for the full 2000 ms
```

So the lock is real and the skip is what makes the claim non-blocking. The plan's raw-SQL fallback was not
used. Suite: `CONTROL_DATABASE_URL=postgres://gbrain:ci-not-a-real-secret@localhost:5432/control bun test
test/integration/scheduler-claim.test.ts` → `9 pass / 0 fail / 27 expect() calls, Ran 9 tests across 1 file.
[519.00ms]`, green on four consecutive runs.

## R9 — `onConflictDoNothing({ target })` narrowed correctly

**Status: `confirmed`** (the bare form was **not** needed). Where the plan relies on it: Task 8.

Form used: `.onConflictDoNothing({ target: [schema.scheduleRuns.scheduleId, schema.scheduleRuns.slot] })`.
`query.toSQL()` emits:

```sql
insert into "schedule_runs" (...) values (...) on conflict ("schedule_id","slot") do nothing
```

Behavioural proof: the idempotency test (`is idempotent — a repeated tick over the same window creates
nothing`) reports `created 0` with 3 rows surviving; without the clause the replay would raise `23505` on
`schedule_runs_schedule_slot_uq`. Suite: `bun test test/integration/scheduler-materialize.test.ts` → `12
pass / 0 fail / 67 expect() calls, Ran 12 tests across 1 file. [740.00ms]` (reproduced three times).

## R10 — `Intl` rejected `Not/AZone`

**Status: `confirmed`.** Where the plan relies on it: Task 1.

Probe results on this runtime (Bun 1.3.14, Windows ICU):

| Time zone | Result |
|---|---|
| `Not/AZone` | `RangeError` (rejected) |
| `PST8PDT` | `RangeError` (rejected) |
| `EST` | accepted by ICU, refused by the region/city guard (`!tz.includes('/')`) |
| `Africa/Cairo` | accepted |
| `Mars/Phobos` | `RangeError` (rejected) |

`Intl.supportedValuesOf('timeZone').includes('Not/AZone')` is also `false`. No
`Intl.supportedValuesOf` membership check was needed and the three assertions were kept exactly as supplied;
all three hold without tightening.

The plan's own doc comment in `src/scheduler/time.ts` claims Intl "happily accepts `PST8PDT`" — that is
**inaccurate on this runtime** (it throws), but harmless: `PST8PDT` is refused by ICU and `EST` by the
region/city guard, so the assertions pass either way. One nuance for the grid: the comment says ":51-:59
clamp back to :50, never :00" — true, and true for any minute > 50 generally; `snapToSlot` never returns 0
or 55 by construction.

Tests: `bun test test/unit/scheduler-time.test.ts test/unit/scheduler-occurrences.test.ts` → `33 pass, 0
fail, 109 expect() calls, Ran 33 tests across 2 files. [169.00ms]`.

## R11 — The report-write/commit ordering caveat (Task 6) did **not** produce a real collision

**Status: `confirmed` — it did not materialize in the specified test.** Where the plan relies on it: Task 6.

Observed from the concurrent `writeReport` integration test, with `git status --porcelain` after it:

```
a -> {"relPath":"reports/job-a/2026-09-15-0300.md","committed":false,"sha":null}
b -> {"relPath":"reports/job-b/2026-09-15-0300.md","committed":true,"sha":"a5b6ff391ca08a8d9321546cf6947cd2eae7ff78"}
git status --porcelain -> "" (CLEAN)
git log --oneline     -> a5b6ff3 reports: job-b 2026-09-15-0300 | 85f52f5 seed
git show --stat HEAD  -> 2 files changed, 2 insertions(+)   (both reports swept into the one commit)
```

Reading: the two writers use different job names, so they resolve different paths, and the caveat's exposure
(which needs an identical resolved path) is not reachable here. The first writer to take the repo lock runs
`git add -A` and absorbs the other's already-written file, so it returns `committed:false` while the tree
still ends clean — `a.committed || b.committed` is the correct assertion, and the clean tree confirms no
report is left invisible to `sync`. Suite: `9 pass / 0 fail / 26 expect() calls, Ran 9 tests across 2 files.
[1.75s]` (stable across four runs).

**The same investigation found that the hazard is real in the shape the caveat describes** — see F17.

## R12 — No preset's default slot collided on a real org

**Status: `confirmed` — none did.** Where the plan relies on it: Task 12.

The catalog's footprints, printed from the shipped `PRESETS` table:

| Preset | Kind | Operation | Footprint | Params |
|---|---|---|---|---|
| `live-sync` | interval | `sync` | `intervalSeconds=900`, tunable `[300,600,900,1200,1800]`, `subHourly=true`, `reportPolicy=on_change_or_failure` | `{}` |
| `nightly-dream` | calendar | `dream` | 02:05 daily | `{ maxUsd: 10, yes: true }` |
| `weekly-health` | calendar | `doctor` | Mondays 06:10, `requiresRole: 'admin'`, brain-wide scope | `{ remediate: true, yes: true, maxUsd: 5 }` |
| `push-reconcile` | calendar | `sources-push` | 04:15 daily | `{}` |
| `morning-briefing` | calendar | `null` | 08:05 daily | `{}` |

No two calendar presets share an `hour:slotMinute` footprint (2:05, 6:10, 4:15, 8:05 — all distinct), and
every `slotMinute` (5, 10, 15) is a member of `ASSIGNABLE_SLOTS`, never `:00`. `nightly-dream` and
`morning-briefing` share `slotMinute=5` at different hours, so `footprintsCollide()` returns false —
footprints are keyed on `${hour}:${slotMinute}`.

On a real org the grid did its job at the one point it was exercised: a second 02:05 calendar schedule was
refused with `409 {"error":"slot_taken","nextFree":10}` (Gate B, B6). Caveat: no org in this stack has all
five presets installed (presets are installed on demand, not automatically), so "no collision" is a property
of the catalog plus one live collision test, not of a fully-populated org.

Test: `bun test test/unit/scheduler-presets.test.ts` → `11 pass, 0 fail, 31 expect() calls, Ran 11 tests
across 1 file. [119.00ms]`.

---

## Material findings execution surfaced

### F1 — `/rpc` parsed the **first** `{` on stdout, so `sync --json` returned `json: null`

**Status: `contradicted`** — found by Gate B's B8, not by a unit test, and fixed.

Claim (Task 16's A7): `sync.json` is the sync envelope read through the RPC. Reality:

```
curl POST /rpc {"op":"sync","params":{"source":"slice3-probe"},"json":true}
stdout: <embed cost-gate object>\n<sync receipt>
jq -c '.json' -> null
```

`gbrain sync --json` prints two JSON objects (the embed cost gate first, then the receipt).
`src/ops/server.ts` parsed stdout as `JSON.parse(t.slice(t.indexOf('{')))`, which throws on that input; the
throw was swallowed by `catch {}`, so the RPC response carried `json: null` for the scheduler's primary
command. Observed impact on a real run before the fix: `summary = {"changed": null, "status": null}` — no
summary status was ever available for the lane the whole slice is about — and
`SCHEDULER_COMMANDS.sync.changeCount(null)` returns `null`, so `on_change_or_failure` silently degraded to
`always` for every interval sync run.

The same defect was latent in `src/contracts/exec.ts`: its docstring says "Parse the LAST balanced JSON value
on stdout" while the code took the first `{`. Fixed in the ops server with a `balancedEnd` helper and one
line — `if (wantJson) parsed = lastJsonValue(r.stdout);` (`src/ops/server.ts:215`), now matching
`execOperation`. Gate B re-ran green against the fixed tree and B8's report carries the parsed receipt
(`added 2, modified 0, deleted 0, chunks_created 2`).

### F2 — `expect(drizzleThenable).rejects.toThrow()` HANGS under bun 1.3.14

**Status: `contradicted`** — the plan's control-DB assertion idiom does not work here.

Against a drizzle result, `getDb().execute()` returns a non-Promise `PgRaw` thenable: bun aborts with
`error: Expected promise / Received: PgRaw {...}`, the result is never consumed, the pooled connection
wedges, `closeDb()`/`client.end()` never returns, and the test process never exits (the first run had to be
killed at 300s; the `afterAll` hook timed out at 5009ms). With a temporary instrumented copy of the same
file, a plain `await` of the duplicate insert rejected correctly in ~2 ms and
`await expect(asyncFnPromise).rejects.toThrow()` also passed, yet the same rejection through `.rejects` hung
for the full 15s test timeout — i.e. the matcher's interaction with drizzle query promises is the hang, not
the constraint.

The six constraint assertions were rewritten as a try/catch helper pinning SQLSTATE plus constraint name
(`23505` / `23514`), following the pre-existing repo precedent at `test/integration/schema.test.ts:98`
("Bun SQL Query objects hang under expect(...).rejects; assert via try/catch and require the lifecycle_valid
CHECK (errno 23514)"). Same contract, strictly stronger (each probe asserts its named CHECK). After the
switch the file is green and exits cleanly 4/4 runs: `5 pass / 0 fail / 19 expect() calls, Ran 5 tests across
1 file. [238.00ms]`.

Related trap for the integration-suite owner: `closeDb()` blocks forever if any drizzle query promise was
left unconsumed, which is what makes a single bad `.rejects` assertion look like a whole-file hang plus a 5s
hook timeout rather than a normal assertion failure.

### F3 — A JS array bound through a drizzle `sql` template arrives as one scalar

**Status: `contradicted`** — the plan's `id = any(${ids})` idiom is rejected. Affected `claim.ts`.

Exact error:

```
PostgresError 22P02 'malformed array literal: "620fa855-..."'
Array value must start with "{" or dimension information
```

The driver binds the JS array as one scalar param, and Postgres refuses it as an array literal. Both
bulk-update call sites in `src/scheduler/claim.ts` now use `inArray(schema.scheduleRuns.id, ids)` —
semantically identical here (both lists are non-empty by construction) and the idiom `materialize.ts`
already uses. `SKIP LOCKED` semantics are untouched; the suite is 9 pass / 0 fail.

### F4 — postgres.js refuses a `bigint` query parameter at the TypeScript level

**Status: `contradicted`** — the plan's `pg_try_advisory_lock(${lockId}::bigint)` with a `bigint` local
cannot pass `bunx tsc --noEmit` under this repo's strict config.

Observed: `TS2769: Argument of type '[bigint]' is not assignable to parameter of type 'never'  ... not
assignable to type 'ParameterOrFragment<never>'` at `src/scheduler/leader.ts(25,60)`,
`leader.ts(43,48)`, `test/integration/scheduler-leader.test.ts(46,62)` and `(48,46)`. Cause:
`node_modules/postgres/types/index.d.ts` deliberately excludes `bigint` from `JSONValue` ("using a dedicated
type to detect symbols, bigints, and other non serializable types") even though the runtime serializer
handles it (`node_modules/postgres/src/types.js:220-228`; `inferType` maps `typeof x === 'bigint'` to
OID 20).

Fix: `lockKeyToBigint(key).toString()`, keeping the SQL text and its `::bigint` cast untouched — one token
per call site, no assertion or semantics changed. Binding the exact decimal text is numerically identical
across the full signed-64 range; a JS `number` would not be, which is why that route was not taken. Suite:
`7 pass / 0 fail / 11 expect() calls, Ran 7 tests across 1 file. [420.00ms]`, no flake over three runs.
Contrast worth knowing: `src/ops/lock.ts` is typed against Bun's `SQL` and binds the same bigint key without
complaint.

### F5 — `operations:emit` prints 31 operations, not the plan's 30

**Status: `contradicted`** (count only).

```
bun run operations:emit
wrote contracts/v0.50.0.0/operations.json — 31 operations
```

The registry already held 29 operations (earlier slices added several beyond the 27 the plan assumed);
`embed` gained a **param** (`--source`), not an entry, and `dream` plus `sources.push` added two. No
assertion depends on the count, and every previous id survives. `bun test test/unit/registry.test.ts` →
`9 pass, 0 fail, 219 expect() calls, Ran 9 tests across 1 file. [48.00ms]` (includes the
contract-coverage and `operations.json` drift tests).

### F6 — The Task 5 container fixture needs a real `gbrain init` plus `gbrain sources add`

**Status: `contradicted`** — the plan's fixture cannot pass as written.

Two observed reasons:

1. `resetBrain()` drops the schema, and the brain auto-created from that state carries the **default**
   embedding model `zeroentropyai:zembed-1` (dimensions 1280), so
   `gbrain embed --stale --source slice3-probe --json` **exits 1** in the embedding-credential preflight
   (`src/core/embed-preflight.ts:112` — requires `ZEROENTROPY_API_KEY`).
2. `seedGitSource(id)` only creates the git repo on disk; it does **not** register the source. Unregistered,
   `gbrain dream --source slice3-probe --dry-run --json` exits 1 with
   `Source "slice3-probe" not found or is archived.`, and `sources push` exits 4 with no JSON receipt.

The nested `beforeAll` now runs `resetBrain()` → `init` (nonInteractive, force, `url: BRAIN_DB_URL`,
`embeddingModel 'openai:text-embedding-3-small'`) → `seedGitSource(PROBE_SOURCE)` →
`sources add slice3-probe --path /srv/brain-repos/slice3-probe`, which is the repo-wide convention (the
auth/lifecycle/config/init contract tests all re-initialize in `beforeAll`). No assertion was deleted,
weakened or moved; the three container assertions are byte-identical to the plan's.
`bun test test/contract/scheduler.contract.test.ts` → `8 pass, 0 fail, 12 expect() calls, Ran 8 tests across
1 file. [11.37s]`.

### F7 — `applyCatchup`'s `run_all` cap had to budget across the whole run set

**Status: `contradicted`** — the plan's implementation contradicted the plan's own test.

The plan's code capped only the **missed** set and then appended all on-time occurrences
(`const keep = missed.length > maxRunAll ? missed.slice(-maxRunAll) : missed`). Its own fixture uses 80
occurrences, 2 of them inside the 120s grace window, so the plan's code yields `run.length = 52` while the
test asserts `run.length === 50` and `skipped.length === 30` ("the cap drops the OLDEST, keeping the most
recent 50"). Observed failure: `run_all cap test: Expected 50, Received 52` (`18 pass, 1 fail`). The test's
contract is self-consistent and total-preserving (50 + 30 = 80), so the test was kept verbatim and the
implementation reworked to budget the cap across the whole run set — on-time entries always run, the backlog
absorbs the cap — giving exactly the most recent `maxRunAll` runs. Anyone reading the plan's code block for
`applyCatchup` should not copy its `keep`/`drop` pair. Tests after the fix: `19 pass, 0 fail, 76 expect()
calls, Ran 19 tests across 1 file. [109.00ms]`.

### F8 — `composeExec` in `src/docker/host.ts` targets the slice0 compose project, not the product

**Status: `contradicted`** — the plan's gates assumed one stack; there are two.

`composeExec` is hard-wired to `compose/docker-compose.slice0.yml`, whose `gbrain-ops` runs the pinned
`brainstand/gbrain-base:0.50.0.0` image. That image is never rebuilt from the working tree, so
`/fileplane/report`, `/rpc/cancel` and the regenerated `operations.json` do not exist there — the seam Gate
A exists to test would be untestable — and the slice0 stack publishes no host port.

Gate A therefore talks to the **main product stack** (`brainstand`, `gbrain-ops` published on
`localhost:3140` by the dev override) through a local `mainExec(argv)` helper; the probe source is seeded
and registered in the main stack's brain on every run (idempotently, touching nothing else), because Task 5
registers `slice3-probe` in the *slice0* brain — its own project, Postgres and `brain-repos` volume — and
`writeReport` never overwrites, so A5's fixed `relPath` is only reproducible against a virgin Space. Gate B
made the same switch for every on-disk/repo probe, on the same reasoning. No `ports:` entry was added
anywhere. Evidence: `bun test test/contract/scheduler.contract.test.ts` → `18 pass / 0 fail / 32 expect()
calls, Ran 18 tests across 1 file. [22.10s]`, three consecutive runs, junit `grep -c '<failure'` → 0.

### F9 — `docker compose up -d --build control-plane` is a no-op

**Status: `contradicted`** — the console agent's given rebuild command builds nothing.

```
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml \
  up -d --build control-plane
-> "Container brainstand-control-plane-1 Running"
```

`control-plane` has no `build:` block (`compose/docker-compose.yml:100` — only `image:`); the shared image
`brainstand/control-plane:dev` is built by the **`gbrain-ops` service's** `build:` block (~line 80). The
correct serialization is `... build gbrain-ops` then `... up -d --no-deps control-plane`. Proved empirically
by grepping the SPA bundle inside the container for a string only the new build contains: `0` before,
`1` after (`docker exec brainstand-control-plane-1 sh -c "grep -c 'reads the whole brain, not just'
/app/dist/console/assets/*.js"`). This matters beyond one agent: the SPA is baked at image-build time, so
"rebuild the console" always means "rebuild `gbrain-ops`'s image".

### F10 — The plan's integration URL `...@127.0.0.1:5433/control` does not exist here

**Status: `contradicted`.**

The dev override publishes no host Postgres port in this environment (`BRAINSTAND_DEV_EXPOSE_PG=0`), so
host-side integration suites cannot reach `127.0.0.1:5433`. Every scheduler integration suite ran against
the scratch Postgres at `postgres://gbrain:ci-not-a-real-secret@localhost:5432/control` (container
`bs-fp-pg`), exactly as `test/integration/schema.test.ts:5-6` does; without `CONTROL_DATABASE_URL`
exported, `bun test` fails loudly with `error: CONTROL_DATABASE_URL is required`
(`src/control/db/client.ts:14`) — observed as `25 pass / 4 fail` on one Gate B attempt.

Two consequences worth carrying: the **stack's own** control DB is reached only through a tunnel (Gate C
used `docker run -d --rm --name bs-slice3-pg-tunnel --network <derived> -p 127.0.0.1:5433:5432
alpine/socat tcp-listen:5432,fork,reuseaddr tcp-connect:postgres:5432`, credentials read from the running
container: user `gbrain`, database `control`), and the slice0 scratch URL would have silently proven nothing
about the stack. Host port 5433 must be free.

### F11 — Browser sign-in at `https://localhost:8443` returns 403 `INVALID_ORIGIN`

**Status: `contradicted`** — a Slice 1 environment defect the console agent worked around.

```
POST https://localhost:8443/api/auth/sign-in/email   (browser Origin header)
-> 403 {"message":"Invalid origin","code":"INVALID_ORIGIN"}

same call from Bun (no Origin header)
-> 200 + __Secure-better-auth.session_token
```

`PUBLIC_URL=https://localhost` carries no port while the dev override publishes 8443, so the origin check
refuses the browser. A human at `https://localhost:8443` can bootstrap (our own route, no origin check) but
then cannot sign in, so the console looks broken at `/schedules` and falls back to the Bootstrap form. The
console evidence was gathered by harvesting the session cookie with Bun `fetch` and injecting it via CDP.
Not a console defect: the dev-stack `PUBLIC_URL`/port pair is what has to change.

### F12 — The 409 `slot_taken` body carries no `holder`; `GET /api/org/schedule-settings` had to be added

**Status: `contradicted`.** Where the plan relies on it: Task 13, Task 15 requirement 8.

Observed 409 body: `{"error":"slot_taken","nextFree":10}` — `src/control/routes/schedules.ts:517` returns
exactly `{ error, nextFree }`. The plan's own console test literal (`'02:05 is taken by nightly-dream. Next
free: 02:10'`) cannot be produced from that body, so the console resolves the holder **client-side** from
the schedules list and the requested wall time is carried on the refusal object. Either the route should add
`holder` or the console keeps doing the client-side lookup (what shipped) — recorded because a UI that
assumes a `holder` field will render nothing.

Second half: the plan's route list omitted `GET /api/org/schedule-settings`, but Task 15 requirement 8 must
display the org's IANA zone and quiet-hours window and only a PATCH existed. Added, viewer-visible:
`GET /api/org/schedule-settings -> 200 {"settings":{"timezone":"UTC","quietHoursStart":23,"quietHoursEnd":8}}`
— the same projection as PATCH, so the two cannot drift. The plan also omitted `GET /api/schedules/:id`
(Task 17 C1 and Task 18 read it). Routes suite: `38 pass / 0 fail / 205 expect() calls, Ran 38 tests across 1
file. [3.29s]`.

### F13 — Every Connection in the stack had membership role `member`

**Status: `confirmed`** — and it blocks a preset by design.

Observed from the live stack:

```
select c.id, s.source_id, m.role from connections ... -> all 53 rows 'member'
```

So a brain-wide schedule was uncreatable by default: `weekly-health` (`doctor`, brain-wide scope) needs a
Connection whose **member** is admin-or-better, and Gate B confirmed the refusal with
`400 {"error":"brain-wide command requires an admin Connection","scope":"brain-wide"}`. The console agent
had to create an admin-role member and Connection to observe the enabled path. This is a property of the
shipped fixtures, not of the code: `weekly-health` needing an admin Connection is the preset's design
(honesty rule 2), and any deployment that ships without an admin Connection simply cannot use it.

### F14 — A run row carries no reason for `skipped_catchup` / `skipped_overlap` / `held`

**Status: `confirmed`** — a spec gap the console absorbed.

`claim.ts` writes state only (`:47`, `:62`, `:78`), `materialize.ts` writes state only (`:85`), and
`execute.ts` writes `summary {changed,status}` even for a held run (`:301-308`). So nothing on the row says
*why* a run was skipped or held; the console reconstructs the reason from `(state, classification, schedule
policy, org quiet hours)` — verified live against all three skip states produced by the real scheduler
(`held` with the quiet-hours window and zone named, `skipped_overlap`, `skipped_catchup` with grace and
policy named). If a later slice wants the reason to be authoritative, it belongs on the row (e.g.
`summary.reason`). Related: a briefing run has `exit_code = null` and `summary {released}` — a third summary
shape next to `{changed,status}` and `{error}` — so anything rendering exit codes must treat `null` as "no
process ran".

### F15 — `blocked` is a valid `schedule_runs.state` but no code path writes it

**Status: `confirmed`.** Where the plan relies on it: Task 15's run-state legend, the runbook.

`blocked` exists in the DB CHECK constraint (`src/control/db/schema.ts:309-311`) and the console has a
`runReason` case for it (`src/console/pages/Schedules.tsx:253`), but the executor maps every non-ok,
non-cancelled classification to `failed` (`src/scheduler/execute.ts:302-303`). The **classification**
`blocked` *is* produced, for a refused/blocked push: `classifyExit` returns `'blocked'` when
`sources push` exits 5 with a status other than `refused_visibility` (`execute.ts:42`), which is why
`alertKind` maps `blocked`/`refused` to `push_blocked` (`execute.ts:388-389`). So the state is unreachable
while the classification is real — the runbook states only what the console claims for `blocked`, without
asserting the executor produces it.

### F16 — Slice 3 left live state on the dev stack

**Status: `confirmed`** (observation, not a claim about upstream).

- Six `console-*` demo schedules (`console-live-sync`, `console-live-sync-2`, `console-nightly-dream`,
  `console-nightly-dream-2`, `console-push-reconcile`, `console-weekly-health`) were left **disabled** so
  nothing fires and no calendar slot stays occupied; their run rows are the console evidence.
- **One live-sync schedule is ENABLED** — the 5-minute one on the `shared` Space created by Gate B's B4
  (`interval 300`, `report_policy on_change_or_failure`, Connection `bs-27428808-shared`). It is firing for
  real: Gate C's close-out observed it materialize slot `2026-09-15T23:50` and the worker execute it
  (`state succeeded, classification ok`).
- Two **Gate C fixtures are also ENABLED**: `gate-c-nightly` (02:30) and `gate-c-ambiguous` (01:30), both
  preset `nightly-dream`, `reportPolicy always`, `maxUsd 5`, with watermarks at `2026-11-01T23:00Z`. They
  are frozen until then and then resume as real (paid) `dream` jobs; an operator should retire them.
- `organizations.timezone = America/New_York` (changed from `UTC` through the console; quiet hours still
  23..8), one admin-role member plus one revoked Connection on Space `shared`, one acknowledged
  `connection_revoked` alert.
- Inert residue: a fixture clock advanced other schedules' watermarks, so B6's `nightly-dream` holds pending
  runs at slot `2026-11-01T02:05` (`fireAt 2026-11-01T07:05:00Z`, two rows counting the retired `-old` row).
  Inert until 2026-11-01 — worth a runbook sentence: "a fixture clock can leave future-dated pending rows;
  they are inert until their fire time".

### F17 — The Task 6 caveat's real shape: same job + same stamp overwrites silently

**Status: `confirmed`** by probe — the same investigation that answered R11.

Two concurrent `writeReport` calls on one Space with the **same** job and the **same** stamp
(`live-sync` / `2026-09-15-0300`) — the shape the caveat actually describes:

```
c -> {"relPath":"reports/live-sync/2026-09-15-0300.md","committed":true,"sha":"648c86ab9a5e83c313eb4aee52b91bb53f9e3348"}
d -> {"relPath":"reports/live-sync/2026-09-15-0300.md","committed":false,"sha":null}
git status --porcelain          -> "" (CLEAN)
content on disk                 -> "D-WRITER\n"
content committed at HEAD       -> "D-WRITER"
```

Both writers resolved the **same** free path (each checked existence before either wrote, and the whole
resolve plus write happens outside `withRepoLock`), so writer C's body was overwritten before C's
`git add -A` — silently lost, last-writer-wins. The `-2`/`-3` suffix only narrows *sequential* repeats; it
cannot narrow truly simultaneous writers of the same job and stamp. Note the failure mode is **not** a dirty
tree: the tree is clean and both calls report the same `relPath`, one of them `committed:true`. The plan's
prescribed fix — thread an optional pre-held lock handle into `commitAs` so resolve + `atomicWrite` + commit
share one critical section — is the right one if a future slice needs that guarantee, and it is not needed
to satisfy the assertion as written (`a.committed || b.committed`).

### F18 — A stale 5-minute schedule exceeds `MAX_OCCURRENCES_PER_TICK` instead of clamping

**Status: `contradicted`** — two plan constants conflict at 300s granularity.

`MAX_LOOKBACK_MS` (7 days) at a 300s interval yields 2016 occurrences, above `MAX_OCCURRENCES_PER_TICK`
(2000, `occurrences.ts`), so `occurrencesIn` throws and the plan's implementation records an error —
directly contradicting the plan's own assertions for the stale-watermark test
(`expect(result!.error).toBeUndefined()`, `created + skipped <= 2000`). Observed verbatim on the plan's
fixture: `error = 'too many occurrences in window (cap 2000)'` (`9 pass / 3 fail`, 57 expect() calls).

Resolution used: neither constant was changed (`occurrences.ts` is frozen, `MAX_LOOKBACK_MS` is
plan-verbatim); the fixture moved to a 600s interval, where the 7-day clamp yields 1008 ≤ 2000 and the test
still discriminates (unclamped, a 2025-01-01 watermark blows the cap and errors). At 60s granularity the
conflict is 10080 vs 2000. Either the lookback must stay under ~6.94 days at 300s granularity or the cap
must be at least 2016 — a decision for whoever next touches either constant.

### F19 — `materializeDue` sweeps every enabled schedule with no org scope

**Status: `confirmed`** — load-bearing for future test authors and for fixtures.

`materializeDue` takes no org or schedule filter: on any shared database, one tick materializes and advances
the watermark of **every** enabled schedule present, including other suites' fixtures. Consequences observed
pre- and post-landing:

- Task 8's suite had to select its result rows by id rather than by array position, and Task 9's suite had to
  pin a fixed injected clock strictly earlier than every sibling suite's fixtures (`Date.UTC(2025,5,1,12,0)`)
  because `claimNextRun`/`reclaimExpiredLeases` scan `schedule_runs` **globally** and a sibling's rows would
  otherwise win the "oldest due pending run" race.
- Gate C's injected 2026-03-08/2026-11-01 clocks advanced other schedules' watermarks and manufactured rows
  (see F16's future-dated pending runs), and its C8/C9/C10 probes needed a
  `requireSoleClaimablePending(now, mine)` precondition so a stray due run could not be claimed and restated
  by the probe — a guard, not an assertion change. Any probe clock after `2026-11-01T07:05Z` would hijack
  B6's `nightly-dream` row.

Fine for one leader and one control DB in production — an optional `opts.organizationId` (or test-only
`scheduleIds`) filter would remove the coupling, and a scoped claim/reclaim API is the fix if a future suite
leaves a `running` row with an expired lease.

### F20 — The plan's Task 12 Step 1 test does not typecheck

**Status: `contradicted`** — despite the plan's acceptance criteria implying clean types.

`bunx tsc --noEmit` reported 3 errors, all in the test file the plan prints verbatim:

- `TS2538: Type 'null' cannot be used as an index type` — the plan's `if (!p.operation) continue;
  expect(() => validateParams(SCHEDULER_COMMANDS[p.operation]!, p.params))` loses the property-access
  narrowing inside the arrow closure; fixed with a `const op = p.operation;` local before the guard.
- `TS2769` on `expect(ASSIGNABLE_SLOTS).toContain(...)` — `ASSIGNABLE_SLOTS` is `as const`, so its type is
  the literal union tuple `readonly [5,10,15,...,50]` and bun's `toContain` overload demands that union, not
  `number`; fixed by widening at the call site (`as readonly number[]`). The root fix would mean editing
  `src/scheduler/stagger.ts`'s `as const`, outside that task's file list.

Neither change weakened an assertion. The broader friction to remember: because `ASSIGNABLE_SLOTS` is an
`as const` literal tuple, **any** caller comparing a runtime `number` against it (routes validation,
materializer, briefing, API layer) must widen it or use a Set/Record.

### F21 — The plan's Task 14 docstring trips the repo's own lint rule

**Status: `contradicted`.**

The plan's `src/scheduler/main.ts` docstring literally contains `gbrain autopilot --install`, which
`scripts/lint-forbidden.ts` matches as raw text (rule `autopilot-install`, regex `/autopilot\s+--install/`)
in any `.ts` file — so copying the plan verbatim would **fail** `bun run lint:forbidden`, contradicting the
plan's own Step 6 acceptance criteria. Reworded to keep the intent ("gbrain's own `autopilot` crontab
install path ... the literal `gbrain autopilot` plus install flag is what `scripts/lint-forbidden.ts`
forbids, and that guard matches raw text, so this comment must not spell it out"). The guard skips `docs/`,
`.superpowers/` and `HANDOFF.md` only, so any code comment quoting a forbidden pattern must be reworded.

### F22 — `stop_grace_period: 20s` is a compose-CLI-only value

**Status: `confirmed`** — the graceful drain is real, but only through `docker compose`.

The scheduler drains cleanly on SIGTERM: `docker compose ... stop scheduler` → logs
`[scheduler] SIGTERM: draining` then `[scheduler] stopped in 10.6s (grace 20s)` (mid-sleep tick; worst case
about 15s), and `start scheduler` comes back with a new worker id
(`[scheduler] e243a4f1d200-6ec44bf9 up, tick 15000ms`). But `HostConfig.StopTimeout` is **unset** on the
container — `stop_grace_period` is a Compose CLI-level value — so a plain `docker stop`/`docker restart`
uses Docker's 10s default and can SIGKILL the scheduler mid-sleep (the tick sleep is up to 15s), losing the
operator-visible drain message. Consequence: in that path the reclaimer, not the scheduler, ends an
in-flight run (honesty rule 6 still holds), but the drain log never prints. Runbook the drain as
`docker compose stop scheduler`.

### F23 — The plan's "all six CHECK constraints" is stale; the generated migration emits twelve

**Status: `contradicted`** (count only).

Plan Step 4 says to confirm "all six CHECK constraints appear". `bunx drizzle-kit generate` (the migration
is 100% generator output; `grep -niE "drop |truncate|rename"` over it returns no matches) emitted 4
`CREATE TABLE`, 2 `ALTER TABLE ... ADD COLUMN` on `organizations`, 7 FK constraints, 15 indexes and
**twelve** CHECK constraints: 1 on `organizations` (`quiet_hours_range`) and 9 on `schedules`
(`schedule_kind_valid`, `gap_policy_valid`, `ambiguous_policy_valid`, `catchup_policy_valid`,
`overlap_policy_valid`, `report_policy_valid`, `shape_matches_kind`, `slot_minute_assignable`,
`timeout_bounded`) plus 2 on `schedule_runs` (`run_state_valid`, `run_classification_valid`). Nothing is
missing; the extra ones are the schedule policy/shape checks. Evidence that each fires:
`update schedules set catchup_policy='run_everything'` → `23514 catchup_policy_valid`; duplicate
`(schedule_id, slot)` insert → `23505 schedule_runs_schedule_slot_uq`; `state='kinda-running'` →
`23514 run_state_valid`. Suite: `5 pass / 0 fail / 19 expect() calls` (stable across four runs).

---

## Where the plan copy carries the corrections

The 17 corrections above that touch the plan's own text were inserted into
[`2026-09-15-slice-3-scheduler.md`](superpowers/plans/2026-09-15-slice-3-scheduler.md) and its source-of-truth
twin (`C:/Users/juanp/.claude/plans/plan-slice-3-purring-kahan.md`) as `> **Corrected 2026-09-15 ...**`
blockquotes: 41 inserted lines, 0 deletions, both files byte-identical afterwards (`cmp` → `IDENTICAL`;
5625 lines each). The line map is owned by that task's artifact. The corrections cover, in order: the
scratch-DB URL (F10), the ICU note (R10), the `run_all` cap (F7), the `.rejects` hang (F2), the Task 5
fixture (F6), `operations:emit`'s count (F5), the Task 6 ordering caveat (R11), the bigint binding (F4),
Task 8's three fixture fixes, Task 9's global scan, `= any(...)` → `inArray` (F3), the `dream` extractor
(R2), Task 11's four executor fixes, the briefing context check, the two omitted routes (F12), Task 14's
exported constant, and Gate A's stack target (F8).

## Gates, in numbers

| Gate | File | Result |
|---|---|---|
| A (contract seam) | `test/contract/scheduler.contract.test.ts` | `18 pass / 0 fail / 32 expect() calls` — three consecutive runs; tripwire `BRAINSTAND_ALLOW_SKIP_SLICE3_CONTRACT` unset, junit `<failure>` count 0 |
| B (integration seam) | `test/e2e/slice3.e2e.test.ts` (B1–B12) | `13 pass / 0 fail / 63 expect() calls [15.39s]` on the final tree |
| C (exit gate: DST + catch-up + overlap) | `test/e2e/slice3.e2e.test.ts` (C1–C12) | `25 pass / 0 fail / 146 expect() calls [39.08s]` — two consecutive runs, 1 tripwire + B1–B12 + C1–C12, nothing skipped |

Both gate files ran against the real stack and real DB; Gate C stopped the live scheduler for its DB block
and restarted it in `afterAll`, asserting all seven services `running` afterwards.

## Consequences for later slices

- **Verify the report payload, never assume a receipt.** `embed` has no `--json` (R3) and `sync` prints two
  objects (R4). Any consumer of a command's structured output must read the *last* balanced JSON value and
  must tolerate prose; the fail-safe default is "unknown change count ⇒ write the report".
- **The RPC seam is now consistent** (`src/ops/server.ts` and `src/contracts/exec.ts` both take the last
  balanced JSON value), so the `json: null` class of defect is closed for every command — but it was found
  by a gate, not a unit test, which is the argument for keeping the gates.
- **Report writes are not safe for two simultaneous writers of the same job and stamp** (F17). Sequential
  repeats are fine; a future slice that can run the same job twice at one stamp needs the pre-held lock
  handle in `commitAs`.
- **Run-row reasons are reconstructed, not stored** (F14), and `blocked` is a state nothing writes (F15).
  If Slice 4's agent runner needs either to be authoritative, they belong on the row/constraint, not in a
  renderer.
- **The dev stack is live** (F16): an enabled 5-minute `live-sync` on `shared`, two enabled Gate C calendar
  fixtures frozen until 2026-11-01, and `organizations.timezone = America/New_York`. Do not be surprised by
  a firing schedule; retire the gate fixtures before they resume.
- **Assertion idioms to reuse** (F2, R9, F23): control-DB refusals are asserted with try/catch plus
  SQLSTATE and constraint name, never `expect(...).rejects`; constraint names survive only on
  `error.cause` (`DrizzleQueryError.message` swallows them).

---

## Final round — the last four findings (F24–F27)

### F24 — A unit test that needs the control DB must install the env default in the file itself

**Status: `contradicted`** — the plan treats the unit suite as container-free; one of its own files is not.

Where the plan relies on it: Task 14 Step 4. `test/unit/scheduler-main.test.ts` failed when `bun test
test/unit` was run bare (`287 pass / 2 fail`): its `beforeAll` calls `pinDb()`/`getDb()`, and
`src/control/db/client.ts:13-14` throws

```
CONTROL_DATABASE_URL is required
```

Fix, in the test file itself: a module-load `process.env.CONTROL_DATABASE_URL ??= <dev control URL>`
default, plus the existing reachability probe, plus a loud error that names the variable and the
`docker run` command instead of skipping silently. `BRAINSTAND_ALLOW_SKIP_SCHEDULER_MAIN=1` is the explicit
opt-out.

Evidence after the fix: bare `bun test test/unit` → `292 pass / 0 fail`; with an unreachable port it fails
loudly, naming `CONTROL_DATABASE_URL` and the `docker run` command.

### F25 — Adding tables requires extending the auth allowlist

**Status: `contradicted`** — a stale allowlist, not a schema leak.

Where the plan relies on it: Task 19 Step 5's final `bun test test/integration`. One test failed:

```
bun test test/integration
roles > the organization plugin invitation surface is not mounted
  test/integration/auth.test.ts:206
extras = ["schedules","schedule_alerts","schedule_runs","held_notifications"]
```

Those four names are exactly the Slice 3 tables, so the failure is the test's DECLARED_TABLES allowlist
being stale — it was not a table escaping into the schema unnoticed. The four names were added to the
allowlist; the assertion itself was left untouched, and the file is now `14 pass / 0 fail`.

Carry-forward: any later slice that creates tables must extend that allowlist, and the omission surfaces as
`extras` on an assertion about the organization plugin's invitation surface.

### F26 — A restore lost gbrain's file plane, and it is NOT a Slice 3 regression

**Status: `contradicted`** — the archive's component list and gbrain's config precedence caused this, not
the scheduler.

Root cause, with evidence:

- The archive is four components — `brainDb`, `controlDb`, `brainRepos`, `secrets` — and deliberately
  excludes `GBRAIN_HOME/.gbrain/config.json`, because that file holds the provider key and the Postgres URL
  in the clear (V9/S3c).
- gbrain resolves `embedding_model` / `embedding_dimensions` from the **file plane only**
  (`core/config-db-merge.ts`: these keys are never merged from the DB plane).
- A restored brain with surviving 1536-d vectors therefore fell back to the shipped default
  `zeroentropyai:zembed-1` (sunset 2026-09-04), `gbrain doctor` failed with `provider_sunset` (exit 1),
  and `report.ok` — the doctor exit code, `scripts/restore.ts:170` — went false.

Isolation proof, on a live stack with no backup, no restore and no scheduler involved:

```
rm -f /srv/gbrain-home/.gbrain/config.json
  doctor exit=1 status=unhealthy fails=['provider_sunset']      (was exit=0 status=warnings health=60)
patch the pin back
  doctor exit=0
```

The scheduler hypothesis was **disproven**: the same failure reproduced with the scheduler container absent
entirely, and that service holds no brain credential and no `GBRAIN_HOME` mount.

Fix, in `scripts/restore.ts`: re-materialize the file plane — model and schema width from the restored
schema, provider key decrypted via the app's own `ENCRYPTION_KEY` — patched through the gbrain-ops
`/fileplane/config` route on stdin, **before** the services boot; plus un-swallowing the doctor verdict
(bounded, `scrubOutput`-ed).

Evidence after the fix: the failing slice2+slice3+restore sequence went `45 pass / 1 fail` →
`46 pass / 0 fail`, and retrieval was proven functional rather than merely exit-0 — a page synced after the
restore embedded for real.

Known limitation, stated plainly: a brain whose pin was never recorded in the control DB has nothing to
re-derive, so the restore stays a no-op there and doctor still fails loudly — now naming the failing check.

### F27 — The failing restore e2e needed a WARM stack

**Status: `confirmed`** — a harness property, recorded so it is not misread as a defect or as flakiness.

`test/e2e/restore.e2e.test.ts` run alone on a cold stack passes even pre-fix: there are no vectors yet to
contradict the shipped default. It goes red only once the suite has provisioned a brain with real
embeddings through the console/wizard path. So the restore e2e exercises the file-plane path on a **warm**
stack only, and a cold run is not evidence that the path works.

---

## Final-round plan corrections

The final round inserted two more `> **Corrected 2026-09-15 ...**` blockquotes, one in each plan copy, at
the point of the claim — insertions only, no deletions, both files still byte-identical (`cmp` →
`IDENTICAL`):

- Under `## Task 14` Step 4 (`- [ ] **Step 4: Unit-test the loop's decisions without a container**`), line
  4827 of both files: the unit test must install the control-DB env default in the file itself
  (`process.env.CONTROL_DATABASE_URL ??=`), otherwise bare `bun test test/unit` throws in `beforeAll`
  (`287 pass / 2 fail` → `292 pass / 0 fail`) — F24.
- Under `## Task 19` Step 5 (`- [ ] **Step 5: Final verification, then commit**`), line 5559 of both files:
  the two Slice 3 fallout fixes in files the plan never names — the `test/integration/auth.test.ts`
  DECLARED_TABLES allowlist gaining the four new tables (F25) and `scripts/restore.ts` re-materializing the
  gbrain file plane (model + width + provider key) before the services boot, because a Slice 1-era archive
  excludes the file plane and a restored brain otherwise resolves the sunset default and fails
  `provider_sunset` (F26) — plus the warm-stack harness property from F27.

Running total: 19 correction blockquotes in each plan copy (the 17 described in the section above, plus
these two).

---

### F28 — No Space was federated, so an unqualified `gbrain search` could not see ANY Space on a multi-Space brain

**Status: `contradicted`** — a product gap in the wizard's `sources.add` calls, plus a harness readiness race.
Surfaced by the two red assertions left in the plan's final verification (`test/e2e/slice1.e2e.test.ts:105`,
`test/e2e/slice1.e2e.test.ts:174` / `test/e2e/restore.e2e.test.ts:167`).

The claim under test, from the previous round: *"unqualified reads span federated sources only; no Space is
federated"* — true, but the conclusion drawn from it ("the wizard Spaces were never findable") understated
what was actually wrong. gbrain's rule has two halves, and the decisive experiment separated them
(`.brainstand-tmp/probe-multispace.ts`, pinned image `brainstand/gbrain-base:0.50.0.0`, fresh stack, wizard
driven exactly as `slice2.e2e.test.ts` drives it with three Spaces, one page per Space, `sync --all` +
`embed --stale`, both exit 0):

```
== sources rows (after wizard)          # config JSONB straight out of postgres
 customers | {}                  | /srv/brain-repos/customers
 default   | {"federated": true} |
 internal  | {}                  | /srv/brain-repos/internal
 shared    | {}                  | /srv/brain-repos/shared

== search unqualified "performance review" exit=0 -> []
== search "performance review" --source-id __all__ exit=0 -> ["performance-review","e2e-probe","acme-notes"]
== search "performance review" --source-id internal exit=0 -> ["performance-review"]
== search unqualified "end to end probe" exit=0 -> []
== search unqualified "acme customer account" exit=0 -> []
```

then, with the SAME brain and only `config.federated` changed (`gbrain sources federate shared customers
internal`):

```
 customers | {"federated": true} | /srv/brain-repos/customers
 default   | {"federated": true} |
 internal  | {"federated": true} | /srv/brain-repos/internal
 shared    | {"federated": true} | /srv/brain-repos/shared

== search unqualified "performance review" exit=0 -> ["performance-review","e2e-probe","acme-notes"]
== search unqualified "end to end probe" exit=0 -> ["e2e-probe","performance-review","acme-notes"]
== search unqualified "acme customer account" exit=0 -> ["acme-notes","e2e-probe","performance-review"]
```

Which of (i)/(ii)/(iii) held:

- **(i) is false.** An unset `federated` is *not* widened into another anchor's unqualified read set.
  `localFederatedSourceIds` (`src/core/source-resolver.ts`) widens only to sources for which
  `isSourceFederated(config)` is true — a literal `true` (`src/core/sources-load.ts:199-201`), documented
  there as *"correctly strict — 'unset' behaves like 'isolated' there"*. The #2928 paragraph about "UNSET
  federated keeps the pre-#2928 widening behaviour" is about the **anchor**: an unset source still widens
  its OWN unqualified read to include the federated set (visible above: `--source-id internal` hits, and the
  pre-fix single-Space brain finds its page). Unset ≠ included, and the probe shows both halves.
- **(ii) is true.** Wizard-created Spaces have never been in the federated set, so on a brain where the
  resolver does not land ON the Space, no unqualified read can see them. The reason a single-Space brain
  (Slice 1's world) still works is the `sole_non_default` tier (`pickSoleNonDefaultSource`): exactly one
  non-default source with a `local_path` and an empty `default` routes the anchor straight into that Space.
  At **two or more** Spaces that tier returns `null` and the anchor falls back to `'default'` — which is
  not federated-with the Spaces, so unqualified search returns `[]`. `test/e2e/slice1.e2e.test.ts:174`
  therefore passed by *resolver heuristic*, not by the documented `--federated` contract, and it passes
  alone on a fresh stack (8 pass / 0 fail, observed twice).
- **(iii) names the trigger, not the cause.** The state `restore.e2e` inherits is the warm three-Space stack
  `slice2.e2e` leaves behind (F27); `runBackup` archives it, `down -v` + `runRestore` puts it back, and the
  restored brain then answers the unqualified query in the test with `[]` — because of (ii).

The fix (assertions untouched):

- `src/control/routes/wizard.ts:194` (`POST /api/wizard/space`) and `:242` (`/finish`'s post-`init`
  re-registration) now pass `federated: true` to `sources.add`. Both call sites matter: `resetBrainSchema`
  wipes gbrain's `sources` table, so the `/finish` row is the one that actually survives. `sources.add`
  already accepts the flag (`--federated`, `contracts/v0.50.0.0/operations.json`), and `sources-ops.ts`
  writes `config.federated` for a local-path source when it is passed explicitly — which is exactly why the
  wizard had to say it.
- `test/e2e/slice1.e2e.test.ts:74-83` — `beforeAll` now waits (bounded, the same 240s budget) for
  `/.well-known/gbrain` to answer 200 *and* console `/api/health` < 500. The two URLs are two containers;
  the old wait only covered the console, so the reserved-path assertions could read a Caddy 502 while
  `gbrain-serve` was still booting (observed after `restore.e2e`'s own `down -v`). No assertion weakened.

Evidence after the fix — same probe, fresh stack, wizard only (no manual `sources federate`):

```
 customers | {"federated": true} | /srv/brain-repos/customers
 default   | {"federated": true} |
 internal  | {"federated": true} | /srv/brain-repos/internal
 shared    | {"federated": true} | /srv/brain-repos/shared

== search unqualified "performance review" exit=0 -> ["performance-review","e2e-probe","acme-notes"]
== search unqualified "end to end probe" exit=0 -> ["e2e-probe","performance-review","acme-notes"]
== search unqualified "acme customer account" exit=0 -> ["acme-notes","e2e-probe","performance-review"]
```

and the restore path itself, replicated on that warm three-Space stack (`runBackup` → `down -v` →
`up -d --wait` → `runRestore` → the exact query `restore.e2e.test.ts:165` issues):

```
restore report ok=true doctorExitCode=0
== sources rows (after restore)
 customers | {"federated": true} | /srv/brain-repos/customers
 default   | {"federated": true} |
 internal  | {"federated": true} | /srv/brain-repos/internal
 shared    | {"federated": true} | /srv/brain-repos/shared

== search unqualified "restore probe" (post-restore) exit=0 -> ["restore-probe","e2e-probe","performance-review","acme-notes"]
== search unqualified "performance review" (post-restore) exit=0 -> ["performance-review","e2e-probe","acme-notes","restore-probe"]
```

No read-set regression for clients, verified rather than assumed. Federation widens a read **only** on the
two local/legacy paths: gbrain's `makeContext` (`remote: false`, CLI/MCP stdio) and
`noGrantFederatedScope`, which returns the federated set only when `hasSourceGrant === false` — the
serve-http comment is explicit that this is *"set ONLY for legacy bearer tokens with no operator source
grant; granted tokens and OAuth clients never widen"*. Every compiled Connection carries a grant
(`--source` + `--federated-read`, `src/control/connections.ts:305-309`), so `federatedSearchScope`
(`src/core/ops/context.ts:638`) never widens it; federation additionally does not touch
`CompiledConnection.federatedRead`. The empirical check is the suite itself: Slice 2's per-Connection
read-scope probes and Slice 3's gates stayed green — `bun test --parallel=1 test/e2e/slice2.e2e.test.ts
test/e2e/slice3.e2e.test.ts test/e2e/restore.e2e.test.ts` → `46 pass / 0 fail`, `372 expect() calls`, twice;
full `bun test --parallel=1 test/e2e` → `54 pass / 0 fail`, `394 expect() calls`; `bunx tsc --noEmit` and
`bun run lint:forbidden` clean.

Known limitation, stated plainly: the fix applies to brains provisioned afterwards. A stack whose volumes
still hold Spaces registered before it (an e2e `beforeAll` that reuses a warm stack instead of wiping —
`restore.e2e` does exactly that) keeps `config.federated` unset for them, and `gbrain sources federate <id>`
is the operator remedy; re-provisioning, or a restore from a post-fix archive, is the other.

> **Corrected 2026-09-16 — the wizard registered Spaces without `--federated`, which made every
> unqualified read miss them on any brain with 2+ Spaces.** `src/control/routes/wizard.ts` passed only
> `{id, path, name}` to `sources.add` at both call sites (`/space`, and `/finish`'s re-registration after
> `resetBrainSchema`), so `sources.config` stayed `{}`; gbrain's inclusion check requires a literal
> `federated: true` (`src/core/sources-load.ts:199-201`), and only the `sole_non_default` resolver tier
> rescued a single-Space brain. Observed on a fresh 3-Space stack: unqualified `gbrain search
> 'performance review' --json` → `[]` while `--source-id __all__` returned all three pages; with the flag,
> the same unqualified query returns all three, and the restored-brain query at `restore.e2e.test.ts:167`
> passes. Both call sites now pass `federated: true`. Separately, `test/e2e/slice1.e2e.test.ts`'s
> `beforeAll` waited only on the console's `/api/health`, which says nothing about `gbrain-serve` (a
> different container behind the same proxy), so the reserved-path assertions could read a 502 mid-boot; it
> now polls `/.well-known/gbrain` for a 200 within the same bounded deadline. No assertion was weakened or
> removed.
