# Slice 0 findings — gbrain v0.50.0.0 control lane

Every risk this slice priced today instead of in month three.
Status: `confirmed` (the spec's claim held) | `falsified` | `changed`.

All evidence below was re-verified directly against the repo and the live pinned stack
(`GBRAIN_VERSION=0.50.0.0`) on 2026-09-15, in addition to the contract-test citations left
by Tasks 1–13. Where a live command was re-run for this pass, the exact output is quoted.

## Wrong-pin tripwire — Work Item 1

The Slice 0 exit gate requires the contract suite to pass on the pinned version **and be
red on a deliberately wrong pin.** The build-time half was already proven
(`bun run test:build`). The contract-suite half had never actually been executed. It has
been now, both ways:

**Wrong pin (`GBRAIN_VERSION=0.99.0.0`):**

```
$ GBRAIN_VERSION=0.99.0.0 bun test test/contract/version.contract.test.ts
error: compose up failed (1):  Image brainstand/gbrain-base:0.99.0.0 Pulling
 Image brainstand/gbrain-base:0.99.0.0 pull access denied for brainstand/gbrain-base, repository does not exist or may require 'docker login'
 Image brainstand/gbrain-base:0.99.0.0 Building
failed to solve: process "/bin/sh -c bun install -g \"github:garrytan/gbrain#v${GBRAIN_VERSION}\"" did not complete successfully: exit code: 1
      at composeUp (src/docker/host.ts:24:35)
(fail) (unnamed) [20206.56ms]
 0 pass
 1 fail
```

**Correct pin (`.env`'s `GBRAIN_VERSION=0.50.0.0`):**

```
$ bun test test/contract/version.contract.test.ts
 2 pass
 0 fail
 3 expect() calls
Ran 2 tests across 1 file. [9.36s]
```

**Verdict: the tripwire is real, not decorative — the suite goes red on a wrong pin.**
But the *mechanism* is worth recording precisely, because it is not the one the test file's
own comments describe. `version.contract.test.ts`'s intended tripwire is the in-test
assertion `expect(parseGbrainVersion(r.stdout)).toBe(PIN)` — a runtime comparison of the
*running binary's* reported version against the expected pin. That assertion never ran.
The suite went red earlier, inside `beforeAll`'s `composeUp()`, because
`compose/docker-compose.slice0.yml` ties both the image tag **and** the Dockerfile's
`GBRAIN_VERSION` build-arg to the same env var — so a wrong pin makes Docker Compose try to
*build a fresh image* at `github:garrytan/gbrain#v0.99.0.0`, and that git ref does not
exist upstream, so `bun install -g` fails and the whole build fails. This is Task 1's
build-time gate firing a second time, not `version.contract.test.ts`'s own runtime
assertion.

This distinction matters for what the tripwire actually covers: it reliably catches "the
pin names a version that was never built or does not exist," which is the realistic
failure mode of a fat-fingered `GBRAIN_VERSION` in `.env`/CI. It does **not** get
independent exercise of the narrower scenario the in-test assertion was written for — a
*stale local image* already tagged `brainstand/gbrain-base:<PIN>` (so Compose reuses it
without rebuilding) whose actual installed gbrain version has drifted from `<PIN>` (e.g. an
upstream force-push to a tag, or a locally cached image from an earlier, different build of
the same tag). That scenario was not constructed or tested here. In practice the two gates
are not independent: because the compose file always attempts a fresh build when the tag
doesn't already exist locally, Task 1's Dockerfile-level version gate (`awk -v v=... '$NF
== v'`) fires before `version.contract.test.ts`'s own assertion ever gets a chance to be
the thing that catches drift. Recorded here rather than glossed over, per the instruction
to report loudly if the tripwire were decorative — it is not decorative, but it is blunter
and less independent than its own source comments imply.

The stack was torn down by both runs' `afterAll` (`compose down -v`) and was restored with
`bun run stack:up` immediately after.

## Verified constraints

| # | Claim | Status | Evidence | Consequence for Slice 1+ |
|---|---|---|---|---|
| V1 | Control surface is CLI-only, not in the op registry | `confirmed` | `src/commands/` (reference checkout) holds ~155 command files (`init.ts`, `auth.ts`, `mcp.ts`, `config.ts`, `doctor.ts`, `jobs.ts`, `apply-migrations.ts`, `upgrade.ts`, `autopilot.ts`, …); none are MCP tools. `src/core/ops/admin.ts` matches `localOnly` twice — both `localOnly: false` (a comment and the one op's own field) — zero ops there are flagged `localOnly: true`. | MCP is the data lane, CLI is the control lane, confirmed by construction. Of the registry's 27 operations only `init.mcpOnly`/`search`/`whoami` (`privilege: 'read-only'`) touch both worlds, and only because they are identity/query ops dispatched through gbrain's generic shared-op table — not because the administrative surface leaked into MCP. |
| V2 | `--json` / `--dry-run` on the control lane | `changed` | Real and working on `mcp.grant` (`--json`+`--dry-run`), `auth.clients`, `doctor`, `jobs.supervisor{,Status}`, `schema.{lint,sync}`, `sources.{list,status}`, `sync`, `embed`, `search`, `whoami`, `init.mcpOnly`, `mcp.verify`. Two confirmed, non-obvious exceptions: `sources add` rejects `--json` outright (exit 2, "Unknown flag: --json" — Work Item N); `schema list` accepts `--json` on the command line but silently **ignores** it and always prints prose (`runList(_args)` never reads its argument — Work Item K). A third gap: `auth rescope-client --dry-run` is rejected **pre-dispatch** for every `gbrain auth *` subcommand at this pin — a confirmed upstream bug in the per-command flag allowlist (`cli-flag-registry.generated.ts`'s `'auth'` entry omits `--dry-run` even though `rescopeClient`'s own handler implements it) — Work Item E. | The "machine-readable receipt" premise holds for most of the surface but not universally. Slice 2's rescope confirm screen (roadmap line 147) cannot be built on a CLI dry-run preview the way the `mcp grant` one can — there is no rescope preview at this pin, only a real (mutating) `--json` call. See the dedicated no-`--json` table below and the Decisions section for the concrete Slice 1 code this breaks. |
| V3 | `init --non-interactive` works headlessly on Postgres | `confirmed` | `test/contract/init.contract.test.ts`: fails cleanly without `--url`/`GBRAIN_DATABASE_URL` (documented message), succeeds headlessly with `--url`+`--embedding-model` (no TTY-prompt pattern in stderr), creates 20+ tables. Reproduced again today via `bun run tutorial`'s `init` step on a fully fresh brain: exit 0, ~4–6s (see Timing). | Confirmed, but it required a real fix to reach: the plan's original compose file gave `gbrain-ops` no way to resolve an embedding provider non-interactively. Fixed by adding `OPENAI_API_KEY: ${OPENAI_API_KEY:-}` passthrough to `compose/docker-compose.slice0.yml` (Work Item A), explicitly marked Slice-0-only since Slice 1 moves provider keys to the file plane (V11). Slice 1's wizard must actively sequence "write key to file plane" **before** "run init" rather than relying on any env-var passthrough — see Decisions. |
| V4 | `search.mode` is post-init | `confirmed` | `test/contract/init.contract.test.ts`'s `search.mode is settable after init, not during it`; tutorial's `config:search-mode` step runs immediately after `init` and succeeds every time (~2.4–2.6s). | Confirmed as-is. The one mandatory human decision in this flow is fully renderable by Slice 1's own UI, post-init, with no race against init's own prompts. |
| V5 | Supervisor drains on SIGTERM; stop within 40s | `changed` | Real clean drain measured directly today against the live pin: **`jobs supervisor stop` = 1150ms**, ~35x under the 40s/60s-test budget. Exit codes 0/1/2/3 confirmed (`src/core/minions/supervisor.ts`: `ExitCodes = { CLEAN:0, MAX_CRASHES:1, LOCK_HELD:2, PID_UNWRITABLE:3 }`) — plus a **fifth, undocumented-in-Slice-0 code, `LOCK_LOST: 4`** ("#1849: the queue-scoped DB lock was lost mid-run"), present upstream but absent from the roadmap's V5 claim, Slice 0's registry doc-comments, and every contract test. Separately (Work Item H): `jobs supervisor start --detach` **always exits 0** to the calling process regardless of lock state — the parent forks a detached child and calls `process.exit(0)` before a `MinionSupervisor` is even constructed; `acquirePidLock()`/`tryAcquireDbLock()` (where LOCK_HELD is actually decided) run only inside that child. Manually confirmed 3-for-3: a second `--detach` start while the first runs exits 0 every time; only a **foreground** second start observes `LOCK_HELD` synchronously. | Slice 3.5's quiesce-before-snapshot budget is safe with enormous margin (~1s observed vs. 40s budgeted). But any later code that starts a supervisor with `--detach` must poll `jobs supervisor status` afterward to confirm it actually holds the lock — the start command's own exit code is not evidence of anything. Any later code that watches supervisor exit codes should treat `4` (`LOCK_LOST`) as a distinct "someone else now owns this" signal, not an undifferentiated crash. |
| V6 | `doctor` exits non-zero on blockers | `changed` | Exit-code behavior confirmed: a live `doctor --json` call against a freshly-tutorialed brain returned `exitCode: 0` with `status: "warnings"`, `health_score: 70` — WARN-level findings don't fail the gate, only FAIL-level ones do (reference `src/commands/doctor.ts` process.exit(1)/(2) call sites at the cited lines). But **the JSON has no top-level `blockers` key at all.** Confirmed two ways: (1) the reference `DoctorReport` interface (`schema_version 2`, the documented stable `--json` shape) declares exactly `schema_version, status, health_score, brain_checks_score, category_scores, checks[], top_issues?, engine?, db_url_source?` — no `blockers` field anywhere; (2) a live call today printed the real key set — `["schema_version","status","health_score","brain_checks_score","category_scores","checks","top_issues","engine","db_url_source"]` — `blockers` absent. (The string "blockers" does exist in `doctor.ts`, but only inside the unrelated, Postgres-only `doctor --locks` idle-transaction check — a different report entirely.) Slice 0's own `lifecycle.contract.test.ts` test (`doctor exit code 0 means no blockers`) was written defensively enough to survive this (`if (Array.isArray(body?.blockers))`) and passes **vacuously** — it has never actually checked anything. | The upgrade gate is real (exit code), but nothing downstream may look for `report.blockers`. Any "why is this unhealthy" UI must walk `checks[]` (filter `status !== 'ok'`) and/or `top_issues`. This is the headline finding for Slice 3.5's upgrade gate — see Decisions. |
| V7 | `--token-ttl` bounds 60s..90d | `confirmed` | `test/contract/auth.contract.test.ts`: 30s rejected with the documented floor message; 300s accepted. Registry cites `TOKEN_TTL_MIN_SECONDS=60`, server default 3600s. Exercised for real in the tutorial (`tokenTtl: '3600'` on all three grants, all succeeded). | Confirmed as-is; per-run tokens for Slice 4 are native. |
| V8 | `mcp grant` fails without brain DB access | `changed` | Confirmed core claim: a bogus `GBRAIN_DATABASE_URL` makes `mcp grant` fail with `GBRAIN_DB_ACCESS`/`Cannot connect to database`. But two upstream requirements the original plan missed would have made that test pass **for the wrong reason**: (1) Work Item F — `mcp grant` requires a positional `NAME` unconditionally, or it fails at arg-parsing before ever reaching DB-access logic; (2) Work Item G — **`--url` is unconditionally required, even for `--dry-run`.** `provisionHarnessGrant` validates the URL's scheme/shape (never contacts it) before any dry-run branch runs; an absent `--url` always fails with `reason: "mcp_setup_failed"`, dry-run or not. Both are now `required: true` on the registry entry, and the V8 test itself now carries a real `NAME` so its failure is provably the DB-access path. | The S2 privilege-boundary premise holds. But Slice 2's dry-run preview screen needs a syntactically valid MCP endpoint URL as a **hard precondition** of asking for a preview at all — this is not optional plumbing that can be deferred to the real-grant step. |
| V10 | 13 adapters, 4 connection classes, no Hermes | `changed` | Adapter **count and id set** confirmed exactly: 13 (`chatgpt, claude-code, claude-desktop, codex, cursor, generic, grok-bot, grok-build, muse, muse-code, openclaw, opencode, perplexity`) — matches `HARNESS_ADAPTERS` (reference source), the live `.well-known/gbrain` payload, and the committed `capability.json` (13 `label` entries under `adapters`). But the "4 connection classes" half is **unobservable from any public surface**: `publicHarnessMetadata()` (`src/core/harness/registry.ts:63-65`) destructures only `{ id, label, modes, documentation, evidence }` off each adapter — `connection` is deliberately internal-only. Confirmed twice: every live adapter's `.connection` is `undefined`, and `grep -c '"connection"' capability.json` returns `0`. (The plan's own original test draft was internally inconsistent before this was caught: it asserted "four" classes while its own assertion array listed five.) | This is the headline forward-looking finding for Slice 2. The harness picker **cannot** group adapters by connection mechanism from live `.well-known` data as the roadmap assumed — that needs either a hardcoded table on brainstand's side (contradicting the "renders FROM THIS, never hard-coded" design premise) or an upstream change. Slice 2 needs a real decision here, not an inherited assumption. |
| V11 | `config set *_api_key` avoids the DB plane | `confirmed` | `test/contract/config.contract.test.ts`: after `gbrain config set openai_api_key sk-contract-test-not-a-real-key`, the brain's own Postgres `config` table has zero rows for that key. Matches `src/commands/config.ts:22-57,118-128`. | The wizard can accept a provider key and hand it to gbrain via `config set` without it touching the multi-tenant brain-db plane. **Scope caveat:** Slice 0 validated gbrain's own `config set` CLI path only. It did not validate Slice 1's actual mechanism — `patchFilePlaneConfig`/`patchConfig`/`mergeConfigJson` write gbrain's config file **directly**, bypassing the CLI. That equivalence (same file, same format, actually read by `gbrain init`) needs its own empirical check in Slice 1 — see Decisions. |
| V12 | `sources add <id> --path` | `changed` | Confirmed signature (`gbrain sources add <id> --path <path> [--name] [--federated\|--no-federated] [--force]`), exercised successfully in three contract-test files and three real tutorial calls. Two real exceptions found on top of it: (Work Item D) `sources add --path` unconditionally refuses any path that is not a git repo with at least one **committed, tracked** file — an empty commit or untracked file is not enough, and this is not documented; (Work Item N) `sources add` does not support `--json` at all, unlike its `list`/`status`/`archived` siblings. | Confirms the Space-creation call, but Slice 1's `/api/wizard/space` handler must seed and **commit** real content into the target path before calling `sources.add`, and must read the plain-text confirmation instead of requesting `{ json: true }`. Checked directly against the current Slice 1 plan draft: its `/space` handler does **not** do this yet — see Decisions. |
| V13 | `.well-known/gbrain` payload keys | `confirmed` | `GET /.well-known/gbrain` returns exactly `{ version, protocol, endpoint, profiles: GRANT_PROFILES, adapters: publicHarnessMetadata(), documentation }` — confirmed in `src/commands/serve-http.ts`'s handler and live via `discovery.contract.test.ts` (`version` = pin, `protocol: 'mcp'`, 13 `adapters`, `profiles` populated). `profiles` is an array of exactly 6 names at this pin: `memory-reader, memory-writer, coding-agent, operator, delegating-agent, full` (committed `capability.json`). | Confirmed as-is; the harness picker and profile list can render from this payload with no hardcoding, except for the connection-class grouping V10 already forecloses. |
| V14 | `--tools-json` shape and entry count | `confirmed` | `gbrain --tools-json` emits a top-level JSON array of exactly **136** tool entries at this pin — confirmed in the committed `contracts/v0.50.0.0/capability.json` and independently by `discovery.contract.test.ts`'s `>50` sanity check and Task 1's own Dockerfile build-time smoke gate (which checks this before any container ever runs). | Confirmed as-is; the data-plane half of the capability snapshot is solid and checked in. |

## Commands with no `--json`

| Command | Why we need it | Workaround | Upstream contribution? |
|---|---|---|---|
| `init` | wizard progress | exit code + stderr prose | maybe — init is inherently a long multi-phase operation; a `--json` progress stream would be a bigger ask than a flag |
| `sources add` | Space-creation receipt for the wizard's `/space` step | read the plain-text "Source ... added" confirmation; the caller already knows `id`/`path`/`name` from its own request, so nothing is actually lost | **yes** — trivial. Its own `list`/`status`/`archived` siblings already support `--json`; `add` omitting it looks like an oversight, not a deliberate design choice |
| `schema list` | wizard's `/schema-packs` step needs a machine-readable pack list | parse the stable `Bundled packs:` prose block — Slice 0 already wrote `parseSchemaPacksProse()` in `src/contracts/capability.ts` for exactly this; Slice 1 should reuse the same approach rather than re-deriving it | **yes** — `runList()`'s own parameter is named `_args` (leading underscore = "unused"), which reads as a bug, not intent |
| `auth register-client` | credential/receipt capture | scrape `Client ID:` (space, not underscore) out of stdout via regex, as Slice 0's own contract test does | maybe |
| `config get` / `config set` / `config show` | wizard config read/write | plain-text line parsing (`key: value` lines for `show`) | no — these are simple, low-volume text commands; not worth a contribution |
| `jobs supervisor stop`, `apply-migrations` | lifecycle confirmation | exit code alone (both are boolean-outcome operations; there is nothing structured to parse) | no |

## Commands that required a TTY or prompted

**None.** This is itself the key V3/V4 result, stated explicitly rather than left as an
empty table: across all 13 task areas, ~45 contract tests, and two independent full runs of
`bun run tutorial` today (one fresh, one against already-populated state — see Timing),
**not one command hung waiting for input or produced an interactive prompt.** Every
invocation either completed within its timeout or failed immediately with a clear exit code
and a machine-readable or at least grep-able stderr/stdout message.

This did not happen by accident — three things make it true, and a later slice depending on
it should not assume it is automatic: (1) every exec goes through `docker compose exec -T`,
which never allocates a TTY, so a command that *would* prompt on a real terminal instead
sees a closed stdin and (per gbrain's own behavior at this pin) fails fast rather than
blocking forever; (2) `--non-interactive`/`--yes`/`--force` are passed everywhere gbrain
defines them; (3) gbrain's own flag-parsing rejects unrecognized or unsupported flags
immediately (e.g. `schema sync --dry-run` exits 1 with a structured `invalid_flag` error in
under a second) rather than falling through to a prompt. A command outside the 27 registered
here has not been proven to share this property.

## Timing

Real numbers, measured directly against the live pinned stack on 2026-09-15 (not
estimates). `bun run tutorial`'s own JSON report carries per-step `ms`, but its script
(`scripts/tutorial.ts`) hardcodes `ms: 0` for the `doctor`, `seed:*`, `isolation:*` and
`whoami-scope:*` steps rather than measuring them — an instrumentation gap in the script
itself, confirmed by inspecting its source and observing the literal `"ms": 0` in two
independent real run reports. `doctor` and the supervisor-drain figure below were measured
with a standalone timed call for that reason.

| Step | Wall time | Note |
|---|---|---|
| `init` | **4.0–6.0s** (4035ms and 5999ms across two independent fresh-brain runs) | non-interactive, real Postgres, embedding provider resolved from the container's `OPENAI_API_KEY` (Work Item A passthrough) |
| `sync --all` | **~1.7–1.8s** (1694ms, 1798ms) | 3 sources, 3 seeded files, first sync |
| `embed --stale` | **~1.9–2.4s** (1934ms, 2383ms) | same 3 pages |
| `doctor` | **~3.4s** (3435ms, measured directly — not from the tutorial's own report, see above) | `status: "warnings"`, `health_score: 70`, exit 0 |
| Whole tutorial | **39.0s** (`time`-measured, one full clean run: fresh brain → 3 sources seeded+synced+embedded → 3 real OAuth grants → 3 thin-client provisions → 3 scoped whoami/search isolation proofs → final doctor; 0 failed steps, `doctorExitCode: 0`, `isolationOk: true`) | vs. ~90 minutes (5400s) by hand → **≈138x faster** |

Two more real numbers worth recording alongside these, both measured directly and both
already folded into V5 above: `jobs supervisor stop` drains in **1150ms** on a clean run
(vs. the 40s/60s budget), and a **second, unmodified run of `bun run tutorial`** against a
brain the first run had already populated (no `compose down -v` in between) **failed** —
`sources add` refused already-registered ids, and `mcp grant` failed with
`client_already_exists` for a client name it had already minted (gbrain even suggests the
fix in its own error text: `--resume --client <id>`). This is not a falsification of
anything claimed above — the tutorial and its contract test are correctly scoped to a fresh
brain (`resetBrain()` runs first in the contract-test harness) — but it is worth recording
plainly: **`bun run tutorial` is not idempotent when invoked directly against
already-populated state**, and nothing in Slice 0 makes it so. A retry-safe orchestration
layer (if one is ever needed) would have to pass `--resume` explicitly; the registry already
carries a `resume` param on `mcp.grant` for this, but the tutorial script never sets it.

## Decisions this changes

- **Doctor has no `blockers` key (V6).** Slice 3.5's upgrade gate cannot check a top-level
  `blockers` array — it does not exist in this pin's `DoctorReport`. It must gate on the
  exit code (0 vs. non-zero) and/or `status`/`health_score`, and if it needs to explain
  *why* a brain is unhealthy, it must walk `checks[]` (filtering `status !== 'ok'`) and
  `top_issues`, not a `blockers` field.
- **Adapter `.connection` is unobservable (V10).** Slice 2's harness picker cannot group
  adapters by connection class (`claude-json`/`codex-toml`/`opencode-json`/`thin-cli`/
  `manual`) from the live `.well-known` payload — the field is deliberately stripped by
  `publicHarnessMetadata()`. Slice 2 needs to decide between a hardcoded class table
  (contradicts "never hard-coded") or requesting an upstream field, before it can build the
  picker as the roadmap currently describes it.
- **`schema list` has no `--json` (V2/V10 Work Item K).** Slice 1 Task 9's
  `/api/wizard/schema-packs` handler currently calls
  `callOps('schema.list', {}, { json: true })` and does `r.json ?? []`. Since
  `schema.list`'s registered contract is `supportsJson: false`, this request either throws
  inside the exec layer's `buildArgv` (`"schema.list does not support --json"`) or, if the
  not-yet-built `gbrain-ops` RPC server swallows that into a non-throwing response, silently
  returns `json: null` → an empty pack list shown to the user with no visible error. Neither
  outcome is acceptable for a step the wizard depends on. **A clearly-marked note has been
  added at this exact handler in `docs/superpowers/plans/2026-09-14-slice-1-deploy-one-brain.md`**
  (Task 9) pointing at the fix: drop `json: true` and parse the real `Bundled packs:` prose,
  reusing the same shape as Slice 0's own `parseSchemaPacksProse()`.
- **Provider key routing (V3/V11).** Slice 0's compose needed a raw `OPENAI_API_KEY`
  env-var passthrough as a shortcut to make headless `init` resolvable at all — explicitly
  marked Slice-0-only. Checked directly against the current Slice 1 plan draft: it already
  does the right thing architecturally (`/api/wizard/provider` writes the key via
  `patchFilePlaneConfig` **before** `/api/wizard/finish` invokes `init`; neither of Slice 1's
  own compose files carry an `OPENAI_API_KEY` passthrough). The one residual, unverified
  assumption is that `patchFilePlaneConfig`'s direct file write lands in the exact file,
  in the exact format, that `gbrain init`/`gbrain config show` actually read — Slice 0 only
  ever validated gbrain's *own* `config set` CLI path, never a direct external file patch.
  **A clearly-marked note has been added** at that handler recommending an explicit
  round-trip check (patch via the file plane, then run `gbrain config show` inside
  `gbrain-ops` and confirm the key appears) before relying on it.
- **`sources add` needs a seeded git commit first (V12 Work Item D).** Checked directly
  against the current Slice 1 plan draft: `wizard.post('/space', ...)` calls
  `callOps('sources.add', { id, path: localPath, name }, ...)` on a `localPath` that is
  never created, `git init`'d, or committed anywhere in the shown handler. Per V12, `sources
  add --path` unconditionally rejects a path that is not a git repo with at least one
  committed, tracked file. As drafted, every real call to this handler would fail. **A
  clearly-marked note has been added** at the `/space` handler describing the seed-then-add
  sequence Slice 0's own `tutorial.ts` and `test/helpers/stack.ts` (`seedGitSource`) already
  use.
- **`--url` is a hard precondition for `mcp grant`, dry-run included (V8 Work Item G).**
  Slice 2's before/after confirm screen (roadmap line 147) cannot call `mcp grant
  --dry-run --json` with an empty or absent URL — it always fails validation before the
  preview branch runs. The control plane must already know or construct a real MCP endpoint
  URL before it can render a preview at all.
- **Supervisor `--detach` exit code is not evidence of lock state (V5 Work Item H).** Any
  later code (Slice 3.5's snapshot quiesce, or any restart/orchestration wrapper) that starts
  a supervisor with `--detach` must poll `jobs supervisor status` afterward — the start
  command itself always exits 0. Also track exit code `4` (`LOCK_LOST`, undocumented in the
  roadmap and in Slice 0's own registry comments) as a distinct "lock was stolen mid-run"
  signal, separate from `1` (crashed) — gbrain 0.50.0.0 actually runs two lock mechanisms
  (a pidfile mutex and a newer DB-scoped lock, issue #1849), and only the pidfile one was
  ever exercised here.
- **Git multi-writer.** serve + worker + ops commit to one working tree on one
  shared volume. We serialize the writes we drive and surface `index.lock`
  staleness plus uncommitted drift on the health page, but full serialization
  needs either per-process worktrees or a commit lock inside gbrain. File it
  as an upstream contribution alongside the production Dockerfile.
- **Push is not inline.** `sources push` runs from backup today and becomes a
  scheduled reconcile job in Slice 3. A rejected non-fast-forward must surface
  as an alert, never a silent swallow.
- **Growth.** Every write is a commit; a year of agent writes makes clone and
  backup slow. Plan `gc` / rotation before Slice 4 turns on nightly agents.
