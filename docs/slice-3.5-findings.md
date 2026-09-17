# Slice 3.5 findings — the deterministic upgrade lane

> **Complete.** This doc was written as Task 1 of
> `docs/superpowers/plans/2026-09-16-slice-3.5-deterministic-upgrades.md` executed, and completed as
> Task 18. Probes **P1–P8**, the upstream-reality rows **U1–U12**, and every finding execution surfaced
> (**F1–F6**) are recorded below, each with a non-empty status. **The pin move is recorded GO** — see
> [The pin-move decision](#the-pin-move-decision-go). Task 18 also records Gate C's measured numbers and
> the migration-collision fixture verbatim at the end of this file.

Status vocabulary: `confirmed` (the claim held as written) | `contradicted` (reality differed, and the
correction is named here) | `inference` (no artifact carries the observation; stated as such, never dressed
up as a measurement).

Every command and output below was run on this machine against the freshly built
`brainstand/gbrain-base:0.50.5.0` image, and is pasted verbatim from that run's own captured log. Nothing
here is reconstructed from memory, and no row is backed by "expected" text.

| # | Claim | Status |
|---|---|---|
| U1 | `check-update` never sets an exit code — always 0, including on a network failure | `confirmed` |
| U2 | `check-update` reads `VERSION` off master, not a release API; `published_at` is always `''` | `confirmed` |
| U3 | `apply-migrations` has no `--json`; exit codes are 0 / 1 / 2 | `confirmed` |
| U4 | `post-upgrade` does a lock-free read-modify-write on `config.json` (`self_upgrade.*`) | `confirmed` |
| U5 | `GBRAIN_SELF_UPGRADE_MODE` env overrides config | `confirmed` |
| U6 | There is no schema-version surface in any published contract | `confirmed` |
| U7 | An older binary against a newer schema silently succeeds; doctor calls it `warn` and exits 0 | `inference` |
| U8 | No down-migrations exist anywhere upstream; `OrchestratorResult` has no rollback state | `confirmed` |
| U9 | `supervisor stop`'s `reason:'drained'` cannot distinguish a clean exit from `MAX_CRASHES` | `contradicted` |
| U10 | v0.50.0.0 → v0.50.5.0 ships zero schema migrations and zero capability drift | `confirmed` |
| U11 | Exactly one new playbook exists in the delta (`v0.50.2.0`); `v0.50.3.0` does not exist | `confirmed` |
| U12 | v0.50.5.0 is a security-hardening wave; at our pin `serve --http`'s `server.close()` is unbounded | `confirmed` |
| P1 | The `0.50.5.0` pin builds and clears the Dockerfile's own build-time version smoke gate | `confirmed` |
| P2 | v0.50.5.0's `.env` guardrail has **not** quarantined `GBRAIN_SELF_UPGRADE_MODE`, and `off` is still honoured | `confirmed` |
| P2-a | The plan's P2 probe as written discriminates between `off` and non-`off` | `contradicted` |
| P6 | `doctor --json`'s envelope still has **no** top-level `blockers` key (L4) | `confirmed` |
| P6-a | The plan's P6 command as written yields a parseable JSON envelope | `contradicted` |
| P3 | The OAuth self-registration scope ceiling causes no new refusal in the Slice 2 provisioning path at `0.50.5.0` | `confirmed` |
| P4 | The full contract suite is green at `0.50.5.0` | `confirmed` |
| P5 | v0.50.0.0 → v0.50.5.0 ships zero capability drift (U10), `versionChanged` aside | `confirmed` |
| P8 | `/.well-known/gbrain` returns a parseable 200 body under the new release's `bunfig.toml` preload lockdown and transcript redaction | `confirmed` |
| P7 | `apply-migrations` exits 0 on an up-to-date brain and a second `post-upgrade` is idempotent | `confirmed` |
| P7-a | The plan's P7 reads the config at `/srv/gbrain-home/config.json` | `contradicted` |
| P7-b | The first `post-upgrade` writes into `self_upgrade.*` in `config.json` (U4), so the first `diff` is non-empty | `contradicted` |
| F1 | A clean supervisor stop at `0.50.0.0` writes `shutting_down` but **no** `stopped`; only the lock-lost path writes `stopped`, so U9's `stopped`-based drain proof cannot be taken for granted | `contradicted` |
| F2 | At `0.50.0.0`, `gbrain jobs supervisor stop` exits cleanly and writes `shutting_down{reason:'SIGTERM',exit_code:0}` while leaving its worker process alive; `--concurrency 0` still spawns one worker | `confirmed` |
| F3 | A real run's journal landed at `UPGRADE_DIR/<runId>/<runId>/journal.ndjson`, one level too deep for the reconciler | `confirmed` |
| F4 | `rollback()` spun one core forever dynamically importing `scripts/upgrade.ts` back from `src/upgrade/digest.ts` | `confirmed` |
| F5 | Bun's startup `.env` auto-load shadowed the rewritten pin for every compose child; the swap could not move un-version-tagged services | `confirmed` |
| F6 | The content digest counted continuously-churning runtime state (`schedule_runs`/`schedule_alerts`, the worker registry) | `confirmed` |
| F7 | The upgrade lane never records `capability_snapshots` (`recordCapabilitySnapshot` has no product caller), so the drift panel/B9/C10 depend on rows only `test/integration/capability.test.ts` writes; and the failure leg can leave `doctor` unhealthy, refusing C6's preflight — **FIXED 2026-09-17** | `confirmed` |
| F8 | The content digest's `filePlane` part counted gbrain's own runtime state under `.gbrain/` (migration ledger, credential handoffs, run secret, update/model/backup caches), so C4/C11's "restores exactly" could not hold — **FIXED 2026-09-17** | `confirmed` |
| F9 | The Gate C family was NOT re-runnable: a second run starts on `0.50.5.0`, so B2/C1's pin assertions fail, C3's failure leg is refused (`SAME_VERSION`) and C4–C12 cascade (65 pass / 12 fail); worse, an aborted leg left the brain FIXTURED (`config.version` 143, one-column `open_loops`) — **FIXED 2026-09-17** | `confirmed` |

**P2 verdict: CONFIRMED-INTACT.** The kill switch is not quarantined and is demonstrably honoured — see
the discriminating probe in P2/A2, where the same binary running the same command emits the upgrade
marker under `notify` and is silent under `off`.

---

## P1 — the `0.50.5.0` pin builds and clears its own smoke gate

**Status: `confirmed`.** Where the plan relies on it: every task from Task 2 onward; the pin-move go/no-go.

Command:

```bash
time docker build --build-arg GBRAIN_VERSION=0.50.5.0 \
  -t brainstand/gbrain-base:0.50.5.0 -f docker/gbrain-base.Dockerfile .
```

**Wall-clock duration (the plan's timing requirement):**

```
real	1m5.030s
user	0m0.060s
sys	0m0.107s
```

Exit code `0`.

The build reached and passed the smoke gate at `docker/gbrain-base.Dockerfile:29-30`. That step is the
version proof — a green build *is* the assertion, and there is nothing further to check:

```
#12 [7/8] RUN gbrain --version | tee /opt/gbrain-version.txt  && awk -v v="0.50.5.0" '$NF == v { ok = 1 } END { exit !ok }' /opt/gbrain-version.txt
#12 0.715 gbrain 0.50.5.0
#12 DONE 1.0s
```

The pin resolved through an exact semver tag (G1 — no moving ref), and bun recorded the commit it
resolved to:

```
#9 [4/8] RUN bun install -g "github:garrytan/gbrain#v0.50.5.0"
#9 7.617 installed gbrain@github:garrytan/gbrain#668b9ba with binaries:
#9 7.617  - gbrain
```

The second build-time gate (`--tools-json` is real, parseable JSON) also passed:

```
#13 [8/8] RUN gbrain --tools-json > /tmp/gbrain-tools.json  && bytes="$(wc -c < /tmp/gbrain-tools.json)"  && test "$bytes" -gt 20  && bun -e '...'
#13 DONE 1.1s
```

Image published to the local daemon as `docker.io/brainstand/gbrain-base:0.50.5.0`
(config `sha256:03c20dfc2b04dbee81be300d4a077605371a7033b7acec1b05c7e83c7c13beb0`).

---

## P2 — the kill switch under v0.50.5.0's `.env` guardrail

**Status: `confirmed` — CONFIRMED-INTACT.** Where the plan relies on it: the U12 stop-the-line gate;
U5; S2's "never let the binary rewrite itself"; the pin-move go/no-go.

The plan's own P2 probe could not answer this (recorded as **P2-a** below, `contradicted`). What follows
is the replacement probe, which has a real control arm.

### A1 — presence, not absence: the guardrail did not strip the var

Run with **no `-e` override at all**, so only the Dockerfile's baked-in `ENV` is in play:

```bash
docker run --rm brainstand/gbrain-base:0.50.5.0 sh -c '
  env | grep -c "^GBRAIN_SELF_UPGRADE_MODE="
  env | grep "^GBRAIN_SELF_UPGRADE_MODE=" | cat -A
  printf "[%s]\n" "$GBRAIN_SELF_UPGRADE_MODE"
  env | grep "^GBRAIN_" | sort
'
```

```
--- count of GBRAIN_SELF_UPGRADE_MODE in env ---
1
--- the line itself (cat -A shows exact value) ---
GBRAIN_SELF_UPGRADE_MODE=off$
--- resolved value ---
[off]
--- all GBRAIN_* vars present ---
GBRAIN_SELF_UPGRADE_MODE=off
```

The var is **present exactly once**, with the value `off` and no trailing whitespace (`cat -A` shows
`off$`, the `$` being end-of-line). `docker/gbrain-base.Dockerfile:48` survives into the running
container's environment — the guardrail did not strip or rewrite it.

### A2 — a discriminating trigger, with a control arm that behaves differently

The probe seeds a **fresh** cache marking an upgrade to a version strictly newer than the running
binary, then runs one real command (`gbrain doctor --json` — a command that reaches the startup hook)
under two modes. Everything is identical between arms except `GBRAIN_SELF_UPGRADE_MODE`:

```bash
docker run --rm -e GBRAIN_SELF_UPGRADE_MODE=<MODE> brainstand/gbrain-base:0.50.5.0 sh -c '
  mkdir -p ~/.gbrain
  printf "UPGRADE_AVAILABLE 0.50.5.0 0.99.0.0\n" > ~/.gbrain/last-update-check
  chmod 600 ~/.gbrain/last-update-check
  printf "[%s]\n" "$GBRAIN_SELF_UPGRADE_MODE"
  ls -la --full-time ~/.gbrain/last-update-check; cat ~/.gbrain/last-update-check
  timeout 90 gbrain doctor --json >/tmp/out 2>/tmp/err; echo "exit:$?"
  grep -i upgrade /tmp/err || echo "(none)"
  wc -c < /tmp/err
  ls -la --full-time ~/.gbrain/last-update-check; cat ~/.gbrain/last-update-check
'
```

**Arm 1 — `GBRAIN_SELF_UPGRADE_MODE=off`:**

```
--- mode ---
[off]
--- cache BEFORE ---
-rw------- 1 root root 36 2026-09-16 23:40:27.572993424 +0000 /root/.gbrain/last-update-check
UPGRADE_AVAILABLE 0.50.5.0 0.99.0.0
--- trigger: gbrain doctor --json ---
exit:1
--- marker grep on stderr ---
(none)
--- stderr byte count ---
62
--- cache AFTER ---
-rw------- 1 root root 36 2026-09-16 23:40:27.572993424 +0000 /root/.gbrain/last-update-check
UPGRADE_AVAILABLE 0.50.5.0 0.99.0.0
```

**Arm 2 — `GBRAIN_SELF_UPGRADE_MODE=notify` (the control arm):**

```
--- mode ---
[notify]
--- cache BEFORE ---
-rw------- 1 root root 36 2026-09-16 23:40:32.313882119 +0000 /root/.gbrain/last-update-check
UPGRADE_AVAILABLE 0.50.5.0 0.99.0.0
--- trigger: gbrain doctor --json ---
exit:1
--- marker grep on stderr ---
UPGRADE_AVAILABLE 0.50.5.0 0.99.0.0
gbrain 0.50.5.0 -> 0.99.0.0 available. Run: gbrain self-upgrade
--- stderr byte count ---
162
--- stderr verbatim ---
UPGRADE_AVAILABLE 0.50.5.0 0.99.0.0
gbrain 0.50.5.0 -> 0.99.0.0 available. Run: gbrain self-upgrade
GBRAIN_DB_ACCESS no_url
No brain configured. Run: gbrain init
--- cache AFTER ---
-rw------- 1 root root 36 2026-09-16 23:40:32.313882119 +0000 /root/.gbrain/last-update-check
UPGRADE_AVAILABLE 0.50.5.0 0.99.0.0
```

**The observation matrix — the control arm differs, which is what makes this a real test:**

| observation | `off` | `notify` (control) |
|---|---|---|
| marker grep on stderr | `(none)` | `UPGRADE_AVAILABLE 0.50.5.0 0.99.0.0` + the human sentence |
| stderr byte count | **62** | **162** |
| cache mtime | unchanged | unchanged |
| cache content | unchanged | unchanged |
| trigger command exit | 1 | 1 |

The 100-byte delta is exactly the two lines `off` suppressed:
`UPGRADE_AVAILABLE 0.50.5.0 0.99.0.0\n` (36 bytes) + `gbrain 0.50.5.0 -> 0.99.0.0 available. Run:
gbrain self-upgrade\n` (64 bytes) = 100; the 62-byte floor is doctor's own two stderr lines, identical in
both arms. **`off` is not merely "not observed doing anything" — it is actively suppressing output the
same binary emits under `notify`, on the same command, with the same seeded state.**

Probe conditions worth naming: the marker prints only when stderr is **not** a TTY (these runs used
`docker run` without `-t`, which matches how compose captures service stderr), and the seeded cache must
mark a version **strictly newer** than the running binary.

### A2 supplementary — a *stale* cache is not a discriminator either

The dispatch suggested seeding a stale cache. Recorded here because it does **not** work, and knowing
why matters for anyone re-running this:

```
--- cache BEFORE (deliberately STALE mtime) ---
-rw------- 1 root root 36 2020-01-01 00:00:00.000000000 +0000 /root/.gbrain/last-update-check
UPGRADE_AVAILABLE 0.50.5.0 0.99.0.0
--- trigger: gbrain doctor --json (mode=notify, STALE cache) ---
exit:1
--- marker grep on stderr ---
(none)
--- stderr byte count ---
62
--- cache immediately AFTER ---
-rw------- 1 root root 36 2020-01-01 00:00:00.000000000 +0000 /root/.gbrain/last-update-check
UPGRADE_AVAILABLE 0.50.5.0 0.99.0.0
--- cache after 8s (detached refresh child may have landed) ---
-rw------- 1 root root 20 2026-09-16 23:40:41.464359357 +0000 /root/.gbrain/last-update-check
UP_TO_DATE 0.50.5.0
```

Under `notify` with a **stale** cache the synchronous observations are identical to `off` (no marker,
62 bytes). The only difference is asynchronous: a detached refresh child lands seconds later and rewrites
the cache to `UP_TO_DATE 0.50.5.0`. A probe built on a stale cache would therefore have reproduced the
original P2 false negative. **Fresh cache + strictly-newer version is the only condition that
discriminates.**

### A3 — what the `.env` guardrail actually does

**A3-1 — a cwd `.env` cannot override the container's real env var.** `.env` in the working directory
contains `GBRAIN_SELF_UPGRADE_MODE=notify`; the container's baked-in `ENV` is `off`; no `-e` override:

```bash
docker run --rm -v "<scratch>/a3-mode:/probe" -w /probe brainstand/gbrain-base:0.50.5.0 sh -c '
  pwd; cat .env
  printf "[%s]\n" "$GBRAIN_SELF_UPGRADE_MODE"
  mkdir -p ~/.gbrain
  printf "UPGRADE_AVAILABLE 0.50.5.0 0.99.0.0\n" > ~/.gbrain/last-update-check
  timeout 90 gbrain doctor --json >/tmp/out 2>/tmp/err; echo "exit:$?"
  grep -i upgrade /tmp/err || echo "(none)"; wc -c < /tmp/err; cat /tmp/err
'
```

```
--- cwd + .env present ---
/probe
GBRAIN_SELF_UPGRADE_MODE=notify
--- container ENV value (baked-in, NO -e override) ---
[off]
--- trigger: gbrain doctor --json (same discriminating probe as A2) ---
exit:1
--- marker grep on stderr ---
(none)
--- stderr byte count ---
62
--- stderr verbatim ---
GBRAIN_DB_ACCESS no_url
No brain configured. Run: gbrain init
```

`off` held. **This is the result that matters for S2**: nothing a cwd `.env` says can turn our kill
switch back on.

**A3-2 — but the var *is* read from `.env` when the process env does not set it.** Three arms, process
var removed with `env -u` so the `.env` is the only source:

| arm | `.env` in cwd | marker | stderr bytes |
|---|---|---|---|
| `/probe-none` | *(no `.env`)* | `UPGRADE_AVAILABLE 0.50.5.0 0.99.0.0` + sentence | 162 |
| `/probe-off` | `GBRAIN_SELF_UPGRADE_MODE=off` | `(none)` | 62 |
| `/probe-notify` | `GBRAIN_SELF_UPGRADE_MODE=notify` | `UPGRADE_AVAILABLE 0.50.5.0 0.99.0.0` + sentence | 162 |

Two things follow, and both are news:

1. **`GBRAIN_SELF_UPGRADE_MODE` is *not* on the guardrail's quarantine list.** A cwd `.env` sets it
   silently, with no warning. The guardrail exists but does not cover this var.
2. **With the var unset and no `.env`, the default is notify-like, not `off`** (the `/probe-none` arm
   emits the marker). The kill switch **fails open, not safe** — which is precisely why A1's presence
   proof is load-bearing and why Task 2's runtime cross-check should assert the var is set, not merely
   that it is not `notify`.

**A3-3 — the guardrail, caught in the act, on a security-relevant var.** Same shape, with a `.env`
containing `GBRAIN_DATABASE_URL` and the process env not setting it (`env | grep -c` printed `0`):

```bash
docker run --rm -v "<scratch>/a3-dburl:/probe" -w /probe brainstand/gbrain-base:0.50.5.0 sh -c '
  pwd; cat .env
  env | grep -c "^GBRAIN_DATABASE_URL=" || true
  timeout 90 gbrain doctor --json >/tmp/out 2>/tmp/err; echo "exit:$?"
  cat /tmp/err
'
```

```
--- cwd + .env present ---
/probe
GBRAIN_DATABASE_URL=postgres://probe:probe@127.0.0.1:5432/probe_from_dotenv
--- GBRAIN_DATABASE_URL in process env? ---
0
--- trigger: gbrain doctor --json ---
exit:1
--- stderr verbatim ---
[env] Ignoring GBRAIN_DATABASE_URL because a .env file in the current directory assigns it — cwd .env files are untrusted for security settings. Export it from your shell or set it in ~/.gbrain/.env.
GBRAIN_DB_ACCESS no_url
No brain configured. Run: gbrain init
```

**This is U12's `.env` guardrail, verbatim, and it is selective**: it quarantines
`GBRAIN_DATABASE_URL` from a cwd `.env` and says so loudly, while leaving `GBRAIN_SELF_UPGRADE_MODE`
alone (A3-2). U12's description — "quarantine of security-relevant `GBRAIN_*` vars" — is accurate as
written; the operative word is *security-relevant*, and the self-upgrade mode is not on that list.

### What P2 now establishes

- **`confirmed`:** the guardrail has not quarantined `GBRAIN_SELF_UPGRADE_MODE` (A1: present, value
  `off`), and `off` is genuinely honoured at this pin (A2: the control arm emits what `off` suppresses).
  U5 holds and extends — a real process env var beats both the config file and a cwd `.env` (A3-1).
  The U12 blocker is **not** present. S2's "never let the binary rewrite itself" guarantee stands.
- **Carried into Task 2 as a hazard, not a blocker:** the mode fails **open**. If anything ever removes
  `GBRAIN_SELF_UPGRADE_MODE` from a container, the binary reverts to a notify-like default and a cwd
  `.env` can set it, because it is not a guardrail-protected var.

---

## P2-a — the plan's P2 probe as written cannot discriminate

**Status: `contradicted`.** Kept because the evidence is the reason the replacement exists.

The plan's P2 runs `gbrain --version` under `GBRAIN_SELF_UPGRADE_MODE=off` and then under an empty
value, expecting the second to expose the non-`off` path. Both arms produced an identical negative:

| condition | marker grep | `~/.gbrain/last-update-check` | stderr bytes |
|---|---|---|---|
| `GBRAIN_SELF_UPGRADE_MODE=off` | `(none)` | absent | 0 |
| `GBRAIN_SELF_UPGRADE_MODE=` (empty) | `(none)` | absent | 0 |

The empty override really did reach the container (`cat -A` gave `GBRAIN_SELF_UPGRADE_MODE=$`, the mode
resolving to the literal `[]`), and `gbrain --version` created no `~/.gbrain` directory at all. The
signal was reachable — an explicit `gbrain check-update --json` wrote
`-rw------- 1 root root 20 /root/.gbrain/last-update-check` under **both** modes — so the negative was
real, not a dead probe.

**Root cause (hypothesis from the read-only reference checkout, proven by the binary's behaviour):**
`--version` is handled and returns *before* the startup hook that consults the self-upgrade mode is ever
called. The proof that this is the mechanism, not a guess, is A2: swapping `--version` for a real command
(`doctor`) on otherwise identical inputs makes the two modes diverge immediately. Per honesty rule 1, a
probe that returns the same negative under both arms is not a pass, which is why the original P2 row was
recorded as inconclusive rather than confirmed.

---

## P6 — `doctor --json`'s top-level shape at the new pin

**Status: `confirmed`** for the L4 claim; **`contradicted`** for the plan's command as written (P6-a).

### P6-a — the plan's command produces no JSON at all

```bash
docker run --rm brainstand/gbrain-base:0.50.5.0 gbrain doctor --json | tee /tmp/p6-doctor.json
```

```
GBRAIN_DB_ACCESS no_url
No brain configured. Run: gbrain init
```

Docker exit `1`; **stdout was 0 bytes** (those two lines are stderr). The plan's follow-up reader
therefore cannot run:

```
SyntaxError: Unexpected end of JSON input
```

Against an uninitialized container `gbrain doctor --json` emits no envelope whatsoever — not a JSON
document describing failures, which is what the plan anticipated. An accepted `--json` flag is not an
implemented one on this code path (L12's shape, in a new place).

### P6 — the envelope, recovered without a stack

Giving doctor a DB URL it can try (and fail) to reach is enough to make it emit the envelope. The URL is
passed as a **real** env var, not via `.env`, so the A3-3 guardrail does not apply:

```bash
docker run --rm -e GBRAIN_DATABASE_URL="postgres://probe:probe@127.0.0.1:5432/probe_unreachable" \
  brainstand/gbrain-base:0.50.5.0 timeout 120 gbrain doctor --json > p6-doctor-dburl.json
```

stdout: **3617 bytes** of JSON. stderr shows the fallback path, and incidentally shows U12's transcript
secret redaction working — the IP literal is redacted in the error text:

```
[doctor] DB-backed doctor run failed (Cannot connect to database: connect ECONNREFUSED  <REDACTED:ipv4>:5432. Fix: Check your connection URL in ~/.gbrain/config.json) — falling back to filesystem-only checks
GBRAIN_DB_ACCESS conn_refused
```

The plan's reader, run against that file:

```bash
bun -e 'const d = await Bun.file("p6-doctor-dburl.json").json();
  console.log(Object.keys(d).sort()); console.log("blockers" in d);'
```

```
[ "brain_checks_score", "category_scores", "checks", "db_url_source", "health_score", "schema_version",
  "status", "top_issues"
]
false
```

**Sorted top-level keys (8):** `brain_checks_score`, `category_scores`, `checks`, `db_url_source`,
`health_score`, `schema_version`, `status`, `top_issues`.

**`'blockers' in d` → `false`.** L4 holds at the new pin: there is still no top-level `blockers` key, so
D5's per-check parity remains the right gate and `docs/runbooks/break-glass.md`'s instruction to read a
`blockers` array is still wrong (Task 18 fixes it).

Every observed key is inside the plan's declared `DoctorReport` set
(`schema_version, status, health_score, brain_checks_score, category_scores, checks, top_issues?,
engine?, db_url_source?`). The optional `engine` is **absent here**, which is consistent with a run that
fell back to filesystem-only checks after the DB refused the connection.

**Stated limit, not dressed up:** this envelope came from a fallback run against an unreachable database,
not a healthy brain. It establishes that `blockers` is absent and that the key set is a subset of the
declared shape. It does **not** establish the key set of a *healthy* doctor run — in particular whether
`engine` appears. Confirming that needs a live stack, which this phase was not permitted to start.

---

## P3 — the OAuth scope ceiling against Slice 2's provisioning path

**Status: `confirmed`** (no new refusal attributable to the scope ceiling). Where the plan relies on it:
the pin-move go/no-go; `test/contract/connection.contract.test.ts` as the Slice 2 provisioning proof.

Command actually run (the plan's bash form `GBRAIN_VERSION=0.50.5.0 bun test …` expressed as a
PowerShell env assignment — see *Worker deviations*):

```powershell
$env:GBRAIN_VERSION='0.50.5.0'; bun test test/contract/connection.contract.test.ts
```

The stack the suite brought up ran the target image, and the suite's own pairing line records the
target pin's compile shape:

```
bun test v1.3.14 (0d9b296a)
[pairing] status=preview compiled={"profile":"memory-writer","sourceId":"customers","federatedRead":["internal","shared"],"tokenTtl":3600} grant={"profile":"memory-writer","sourceId":"customers","federatedRead":["internal","shared"],"tokenTtlSeconds":3600}
```

Every `runConnectionE2E` step succeeded — `mcp grant`, `auth rescope-client`, scoped search, revoke,
audit and doctor:

```
[whoami] gate-a-reader {"transport":"oauth","source_id":"customers","federated_read":["internal","shared"]}
[search] gate-a-reader query="performance review" sources=["internal","shared"] hits=2
[whoami] gate-a-isolated {"transport":"oauth","source_id":"customers","federated_read":["shared"]}
[search] gate-a-isolated query="performance review" sources=["shared"] hits=1
[audit] before-delete=true connectionId=23de0192-2a49-4483-9bf2-049f3064da09
[revoke] auth.revokeClient exit 0; search-after exit 1
[doctor] exit 0 status=warnings health_score=70
 2 pass
 0 fail
 12 expect() calls
Ran 2 tests across 1 file. [45.62s]
```

Exit code `0`. There is **no refusal anywhere in the run**: the grant/rescope calls that passed at
v0.50.0.0 still pass at v0.50.5.0. The plan notes the ceiling would surface as "a NEW REFUSAL on a call
that passed at v0.50.0.0" — none appeared.

**Stated limit.** This is absence-of-failure evidence, not a positive probe of the scope-ceiling code
path: the suite exercises the calls the product makes, and it cannot prove the ceiling did not change
for inputs the suite never submits. It answers the plan's question ("does it break us?") — no.

---

## P4 — the full contract suite at the new pin

**Status: `confirmed`** (suite green, no failure to record). Where the plan relies on it: G4, the
pin-move go/no-go, and every Task 2+ contract test at the target pin.

Commands actually run:

```powershell
$env:GBRAIN_VERSION='0.50.5.0'; bun run operations:emit
$env:GBRAIN_VERSION='0.50.5.0'; bun test test/contract
```

`operations:emit` ran **first**, as the plan requires (`src/ops/dispatch.ts:18` and
`docker/control-plane.Dockerfile:18-19`), and generated the artifact:

```
wrote contracts/v0.50.5.0/operations.json — 31 operations
```

Exit `0`. `contracts/v0.50.5.0/operations.json` exists (`"gbrainVersion": "0.50.5.0"`, 984 lines,
31 operations). **`contracts/v0.50.0.0/operations.json` was not touched** — `git diff --stat --
contracts/v0.50.0.0/operations.json` is empty, so no `git checkout --` restore was needed. The emit
script only ever writes `contracts/v${GBRAIN_VERSION}/`, so this is expected, not luck.

Then the full suite:

```
bun test v1.3.14 (0d9b296a)
...
 69 pass
 0 fail
 138 expect() calls
Ran 69 tests across 12 files. [313.51s]
```

Exit code `0`. **There are zero failures to paste verbatim.** 313.51 s is consistent with the ~310 s
budget the task named.

---

## P5 / P8 — capability drift, and the well-known probe folded in

**Status: `confirmed`** — the diff matches U10's expected shape exactly, and P8 is proven by the same
run.

Commands actually run:

```powershell
$env:GBRAIN_VERSION='0.50.5.0'; bun run capability:capture
```

Output, verbatim:

```
wrote contracts/v0.50.5.0/capability.json
```

Exit code `0`. `contracts/v0.50.5.0/capability.json` was written — 173,445 bytes,
`"gbrainVersion": "0.50.5.0"`, `wellKnown` present at line 4081 with `profiles` and `adapters`, and
`schemaPacks.bundled` populated. The capture only completes if the in-container
`fetch("/.well-known/gbrain")` returns `r.ok`; `scripts/capture-capability.ts:85-87` throws
`'captured snapshot has wellKnown: null'` otherwise. **This run therefore IS P8's evidence**: the
`/.well-known/gbrain` surface answered 200 under v0.50.5.0's `bunfig.toml` preload lockdown and
transcript redaction, so no second boot is needed.

The plan's `bun -e` diff reader (which on this Windows/PowerShell host could not be passed inline — see
*Worker deviations*) was executed verbatim-in-logic, importing the same `diffCapability`:

```
{
  "versionChanged": true,
  "toolsAdded": [],
  "toolsRemoved": [],
  "adaptersAdded": [],
  "adaptersRemoved": [],
  "profilesChanged": false
}
```

Exit code `0`. This is **exactly** U10's expected shape. Zero tools added, zero removed, zero adapters
added or removed, `profilesChanged: false`. **No finding to record** — there is no non-empty field
other than `versionChanged`.

---

## P7 — `apply-migrations` and `post-upgrade` idempotency at the new pin

**Status: `confirmed`** for the go/no-go criteria (clean `apply-migrations` exit, idempotent second
`post-upgrade`); **`contradicted`** for the plan's P7-a (config path) and P7-b (the first diff is
non-empty).

The stack was brought up at the target pin exactly as the plan's block specifies:

```powershell
$env:GBRAIN_VERSION='0.50.5.0'; docker compose -f compose/docker-compose.slice0.yml --env-file .env up -d --build --wait
```

Exit `0`; every layer CACHED, image re-tagged `docker.io/brainstand/gbrain-base:0.50.5.0`, Postgres and
gbrain-ops `Healthy`. Then `gbrain init`:

```
Connecting to database...
Running schema migration...
  Setting up brain schema (v149)...
  144 migration(s) applied
Config saved to ~/.gbrain/config.json
...
Brain ready. 0 pages. Engine: Postgres (Supabase).
```

Exit `0`.

### P7-a — the plan's config path does not exist (`contradicted`)

The plan reads `/srv/gbrain-home/config.json` at lines 501, 504 and 507. That path does not exist:

```
cat: /srv/gbrain-home/config.json: No such file or directory
```

`GBRAIN_HOME=/srv/gbrain-home`, and gbrain nests its dot-directory underneath it. The real path is
**`/srv/gbrain-home/.gbrain/config.json`** (454 bytes). The probe was re-pointed there. This is a plan
defect, not a product defect; the coordinator should patch the three path occurrences at plan lines
501–507.

### P7 — `apply-migrations`, exit code only

```powershell
docker compose -f compose/docker-compose.slice0.yml --env-file .env exec -T gbrain-ops gbrain apply-migrations --yes --non-interactive
```

Exit code, the gate:

```
exit:0
```

Verbatim excerpt (U3 — the prose is **not** parsed for anything; the exit code alone is the gate):

```
=== Applying migration v0.11.0: GBrain Minions — durable background agents ===
...
Migration v0.11.0 complete.
=== Applying migration v0.12.0: Knowledge Graph wires itself — every page write extracts typed links automatically ===
...
Migration v0.12.0 complete.
...
=== Applying migration v0.46.3: ZeroEntropy is shutting down 2026-09-04 ... ===
Migration v0.46.3 complete.
```

**Observation worth carrying, not a gate:** on this freshly `init`ed brain the command did **not** say
"nothing pending" — it walked the whole version-keyed playbook chain (`v0.11.0` … `v0.46.3`) and
applied it. The brain's schema (`v149`, from `init`) and the migration playbook ledger
(`/srv/gbrain-home/.gbrain/migrations/completed.jsonl`) are separate lanes; `init` does not pre-mark the
playbooks. The plan's parenthetical "its own prose should say nothing pending" is therefore wrong as an
expectation. It changes nothing about the gate: exit `0`. A second `apply-migrations` was not run (the
plan does not ask for one).

### P7 — `post-upgrade` twice, and both diffs

Both `post-upgrade` runs:

```
All migrations up to date.
```

Exit code `0` on both.

Config snapshots were taken at the real path before, between and after the two runs, and diffed with
`git diff --no-index` (this host has no `diff`):

```
--- diff1 (config0 vs config1) ---
DIFF1_EXIT:0
--- diff2 (config1 vs config2) ---
DIFF2_EXIT:0
```

**Both diffs are empty (byte-identical snapshots).**

### P7-b — the first diff is empty, so U4's write was not observed (`contradicted`)

The plan expects the **first** `diff` to show what `post-upgrade` writes into `self_upgrade.*` the first
time (U4). It did not. The snapshot around which `post-upgrade` is supposed to write already contained
the field, written by `init`:

```json
{
  "engine": "postgres",
  "database_url": "postgres://gbrain:change-me-in-a-real-deployment@postgres:5432/gbrain",
  "embedding_model": "openai:text-embedding-3-small",
  "embedding_dimensions": 1536,
  "expansion_model": "openai:gpt-5.6-luna",
  "schema_pack": "gbrain-base-v2",
  "mcp": { "publish_skills": true },
  "self_upgrade": { "mode": "notify", "mode_prompted": true },
  "protocol_installed_at": "2026-09-17T00:12:37.045Z"
}
```

The file's mtime is decisive: `-rw------- 1 root root 454 2026-09-17 00:12:37.041247893 +0000` — i.e.
the instant `init` saved it. Both `post-upgrade` runs happened at ~00:13:30+, and neither rewrote the
file (mtime unchanged, content unchanged). **Under the plan's own P7 sequence, the first `post-upgrade`
did no config.json read-modify-write at all.** U4's mechanism is not disproven — it is simply not
exercised here, because `init` has already populated `self_upgrade.*` and `post-upgrade` finds nothing
to change. The second run's emptiness confirms the idempotency the plan cares about.

**What this means for the go/no-go criterion:** "P7 shows a clean `apply-migrations` exit and an
idempotent second `post-upgrade`" — both hold. The first-diff expectation was not a gate; it is recorded
here as a contradicted plan expectation, with the mtime evidence, so nobody later reads an empty first
diff as "we failed to observe U4" without knowing why.

### P7 — teardown

```powershell
$env:GBRAIN_VERSION='0.50.5.0'; bun run stack:down
```

Exit `0`. Verbatim:

```
 Container brainstand-slice0-gbrain-ops-1 Stopped
 Container brainstand-slice0-gbrain-ops-1 Removed
 Container brainstand-slice0-postgres-1 Stopped
 Container brainstand-slice0-postgres-1 Removed
 Volume brainstand-slice0_pg-data Removed
 Volume brainstand-slice0_brain-repos Removed
 Volume brainstand-slice0_gbrain-home Removed
 Network brainstand-slice0_brain-net Removed
```

Confirmed after: `docker ps -a --filter name=brainstand-slice0` is empty and
`docker volume ls --filter name=brainstand-slice0` is empty. The live DEV stack
(`compose/docker-compose.yml`, project `brainstand`) was left running and untouched — all seven
containers were verified still `Up` after the probe, still on `0.50.0.0`.

---

## Worker deviations from the plan

This task wrote no product code, so none of the canonical-shape defects the dispatch warned about
(`openJournal` / `buildManifest` / `verifyManifest` module split) could bite. The deviations below are
environment and plan-path adaptations made while running the probes. Nothing in the repo was edited
except `docs/slice-3.5-findings.md` and the two generated artifacts under `contracts/v0.50.5.0/`.

1. **Plan lines 501, 504, 507 — wrong config path.** `/srv/gbrain-home/config.json` does not exist;
   the real file is `/srv/gbrain-home/.gbrain/config.json`. Probe re-pointed. Recorded as row P7-a.
   Plan should be patched.
2. **Plan lines 452-457 — the `bun -e` diff reader.** Passing the multi-line program with embedded
   double quotes through PowerShell to a native `bun` strips the quotes (`Expected string but found
   "."`). The identical logic was written to a throwaway file outside the repo
   (`%TEMP%\opencode\slice35\p5diff.ts`) that imports the same `diffCapability` from
   `src/contracts/capability.ts`; the output is the function's own output. No product file changed.
3. **Plan lines 384-510 use bash env syntax and `time`/`diff`/`$?`.** This host is Windows PowerShell
   5.1. `GBRAIN_VERSION=… cmd` became `$env:GBRAIN_VERSION='…'; cmd`; `echo "exit:$?"` became
   `$LASTEXITCODE`; `diff` became `git diff --no-index`. Same commands, same arguments.
4. **Plan line 510 / acceptance "`bun run stack:down`" needs `GBRAIN_VERSION` set on this tree.**
   Because a concurrent Task 2 worker has already removed the `${GBRAIN_VERSION:-0.50.0.0}` fallback
   from `compose/docker-compose.slice0.yml` (D8), every compose invocation — including `down` — now
   fails interpolation unless `GBRAIN_VERSION` is exported. Set to `0.50.5.0` for the probe runs.
5. **Concurrent-writer contamination, named so the evidence is read honestly.** The working tree was
   *not* clean during this dispatch: this is a shared worktree and other Slice 3.5 workers wrote
   `src/contracts/pin.ts`, `src/upgrade/**`, `compose/*.yml`, `src/control/db/**` and their tests
   while these probes ran (first `git status` in this dispatch showed only `docs/slice-3.5-findings.md`
   untracked; minutes later 10 modified files and ~15 new ones were present). The probes were not
   isolated from that. P4's 69/0 green and P5/P7's results were produced on that mixed tree. The pin
   itself is independently pinned (`GBRAIN_VERSION=0.50.5.0`, image
   `brainstand/gbrain-base:0.50.5.0`), and `contracts/v0.50.0.0/operations.json` was verified
   byte-identical to HEAD, but a future re-run should be done on a quiesced worktree.

---

## The pin-move decision: GO

The plan's go/no-go criteria (plan lines 526-535), each with the row that carries it:

| Criterion | Evidence | Verdict |
|---|---|---|
| P1 build passes its own smoke gate | P1: `gbrain 0.50.5.0`, gate `#12 DONE 1.0s`, exit 0 | **GO** |
| P2 confirms `off` still suppresses both signals | P2/A2: `off` = no marker / 62 stderr bytes; `notify` = marker / 162 bytes | **GO** |
| P3, P4 show no failure attributable to the OAuth scope ceiling or self-upgrade paths | P3: 2 pass / 0 fail, exit 0; P4: 69 pass / 0 fail, exit 0 | **GO** |
| P5 diff matches U10's expected shape exactly | `versionChanged:true`; every other field empty | **GO** |
| P6 key set still excludes `blockers` | P6: `'blockers' in d === false` | **GO** |
| P7 clean `apply-migrations` exit and idempotent second `post-upgrade` | exit 0; `diff1` and `diff2` both empty | **GO** |

**The criterion that decided it:** none was a blocker; every criterion is independently green. The
sharpest single piece of evidence is P5/P8 — `capture-capability.ts` completed, which means the
security-hardening wave's `bunfig.toml` preload lockdown did not break `gbrain serve`'s well-known
surface, and the capability diff is byte-for-byte U10's predicted zero-drift shape.

**No-go triggers checked and absent:** P2 did not find the kill switch quarantined; P3/P4 produced no
failure traceable to the security-hardening wave.

### Probes that produced no discriminating evidence

- **P3** is absence-of-failure only. It exercises the calls the product makes and shows no new refusal;
  it cannot distinguish "the ceiling is unchanged" from "the suite never feeds an input the ceiling
  gates." Recorded as `confirmed` for the plan's question, not as a positive measurement of the ceiling.
- **P7's first `diff`** was expected to discriminate U4's write and produced nothing (P7-b). The
  second-diff idempotency is real, discriminating evidence; the first is not, because `init` had already
  populated `self_upgrade.*`.
- Everything else (P1, P2, P4, P5/P8, P6) produced discriminating results.

**Decision: GO — Task 2 may start.** No blocker is recorded. The plan defects found (P2-a, P6-a, P7-a,
P7-b, plus the two environment notes) are corrections to paste back, not reasons to stop.

---

## Correction to patch back into the plan

The plan's Evidence requirements say a deviation is patched back into the plan file itself. This worker
may not edit the plan; the coordinator should paste the following into
`docs/superpowers/plans/2026-09-16-slice-3.5-deterministic-upgrades.md` immediately after the P2 step
(around line 420):

> **Corrected 2026-09-16 — P2's probe had a false antecedent and could not discriminate.** P2 used
> `gbrain --version` as its trigger, but `--version` is handled and returns *before* the startup hook
> that consults `GBRAIN_SELF_UPGRADE_MODE` is ever reached, so the ambient update-check path never runs.
> Both arms therefore returned the same negative (no marker, no cache file), and the rule "if only the
> SECOND run shows the signals, `off` is confirmed intact" has an antecedent that never fires — a
> non-discriminating probe, which honesty rule 1 forbids recording as a pass. Seeding a *stale* cache
> does not fix it either: under `notify` a stale cache produces the same silent 62-byte stderr as `off`
> and only kicks an asynchronous refresh. **The replacement probe** seeds a **fresh**
> `~/.gbrain/last-update-check` containing `UPGRADE_AVAILABLE 0.50.5.0 0.99.0.0` (a version strictly
> newer than the running binary), then runs one real command that reaches the hook — `gbrain doctor
> --json` — under `off` and under `notify`, with stderr non-TTY. `off` yields no marker and 62 stderr
> bytes; `notify` yields `UPGRADE_AVAILABLE 0.50.5.0 0.99.0.0` plus the human sentence and 162 bytes.
> That 100-byte difference is the control arm the original probe lacked. Result: **P2 is
> CONFIRMED-INTACT** — the guardrail has not quarantined the var and `off` is honoured. Two carried
> notes: (a) the guardrail *is* real but selective — it quarantines `GBRAIN_DATABASE_URL` from a cwd
> `.env` with an explicit `[env] Ignoring ...` warning while leaving `GBRAIN_SELF_UPGRADE_MODE`
> unprotected, so a cwd `.env` can set the mode when the process env does not; (b) with the var unset
> entirely the default is notify-like, so the kill switch **fails open** — Task 2's runtime cross-check
> must assert the var is *present and `off`*, not merely that it is not `notify`. See
> `docs/slice-3.5-findings.md` rows P2, P2-a.

A second, smaller correction belongs at P6 (around line 470):

> **Corrected 2026-09-16 — P6's command yields no JSON against an uninitialized container.**
> `docker run --rm brainstand/gbrain-base:0.50.5.0 gbrain doctor --json` exits 1 and writes **0 bytes**
> to stdout (`GBRAIN_DB_ACCESS no_url` / `No brain configured.` go to stderr), so the follow-up `bun -e`
> reader fails with `SyntaxError: Unexpected end of JSON input`. Doctor emits its envelope only once it
> has a DB URL to try; passing an unreachable `GBRAIN_DATABASE_URL` as a **real** env var (not via
> `.env`, which the guardrail quarantines) makes it fall back to filesystem-only checks and print a
> 3617-byte envelope. L4 is confirmed at the new pin on that envelope: 8 top-level keys
> (`brain_checks_score, category_scores, checks, db_url_source, health_score, schema_version, status,
> top_issues`) and `'blockers' in d === false`. The optional `engine` key is absent on a fallback run;
> whether it appears on a healthy brain is still unverified. See `docs/slice-3.5-findings.md` row P6.

A third correction belongs at P7 (plan lines 501, 504, 507 and the P7 expectation at 513-517). Two
separate defects, both proven with output above:

> **Corrected 2026-09-16 — P7's config path does not exist, and the first `post-upgrade` diff is
> empty.** (1) The plan reads `cat /srv/gbrain-home/config.json` three times, but that file does not
> exist (`cat: /srv/gbrain-home/config.json: No such file or directory`). With `GBRAIN_HOME=/srv/gbrain-home`,
> gbrain nests its dot-directory beneath it; the real path is **`/srv/gbrain-home/.gbrain/config.json`**
> (454 bytes). (2) The plan expects the **first** `diff` to show what `post-upgrade` writes into
> `self_upgrade.*` the first time (U4). Both diffs are empty: the config already carried
> `"self_upgrade": {"mode": "notify", "mode_prompted": true}`, written by `gbrain init`, and the file's
> mtime (`2026-09-17 00:12:37.041`) is the init instant — both `post-upgrade` runs (`All migrations up
> to date.`, exit 0) left it untouched. Under the plan's own sequence the first `post-upgrade` performs
> no config read-modify-write, so U4 is not exercised here rather than contradicted as a mechanism. The
> second diff is empty, which is the idempotency the criterion actually asked for. `apply-migrations`
> exits `0` (the gate); note its prose does **not** say "nothing pending" on a freshly `init`ed brain —
> it walks the playbook chain `v0.11.0`…`v0.46.3`, because the brain schema (`v149`) and the playbook
> ledger are separate lanes. See `docs/slice-3.5-findings.md` rows P7, P7-a, P7-b.

P3, P4, P5 and P8 need **no plan correction**: every command ran and every expected result held. P3
(2 pass / 0 fail) and P4 (69 pass / 0 fail) surfaced no failure; P5's diff is exactly
`versionChanged: true` with every other field empty; and the same P5 run wrote
`contracts/v0.50.5.0/capability.json`, which is P8's proof that `/.well-known/gbrain` answered 200 under
the new release's preload lockdown. The pin move is recorded **GO** in
[The pin-move decision](#the-pin-move-decision-go).

---

## F1 — the audit vocabulary at `0.50.0.0`: a clean drain does not emit `stopped`

**Status: `contradicted`.** Where it bites: Task 6's `verifySupervisorDrained` (U9 / honesty rule 3)
and Gate C's C6 assertion (`q.supervisor.auditExitCode === 0`, `q.supervisor.auditReason` in
`SIGTERM`/`SIGINT`).

U9 rests the drain proof on the audit log's own `stopped` event. At this pin a **genuinely clean
stop never writes one**. Two controlled runs on the live `brainstand` stack
(`GBRAIN_AUDIT_DIR=/srv/gbrain-home/.gbrain/audit`, `supervisor-2026-W38.jsonl`); each line below is
exactly what that run appended, read back from the shared `gbrain-home` volume.

### (a) clean stop — `docker compose … stop -t 90 gbrain-worker` (the path a real quiesce takes)

```bash
docker compose --env-file .env -f compose/docker-compose.yml stop -t 90 gbrain-worker
```

Exact lines appended (**1**):

```jsonl
{"event":"shutting_down","ts":"2026-09-17T00:28:20.611Z","reason":"SIGTERM","exit_code":0,"supervisor_pid":7}
```

No `stopped`; no `health_error`. `shutting_down` **does** carry both `reason` and `exit_code` — the
clean signal exists, just not under the event name U9 named. The `gbrain jobs supervisor stop` path
(`jobs.ts:1900-1950`, the one U9 itself cites) behaves identically: two earlier runs each appended a
single `shutting_down {reason:'SIGTERM', exit_code:0}` line and no `stopped`
(`ts` `2026-09-17T00:19:21.570Z` and `2026-09-17T00:23:23.050Z`).

### (b) LOCK_LOST stop — force-clear the queue singleton lock

```bash
docker compose --env-file .env -f compose/docker-compose.yml exec -T postgres \
  psql -U gbrain -d gbrain -c "DELETE FROM gbrain_cycle_locks WHERE id='gbrain-supervisor:default'"
```

Exact lines appended (**3**), detected ~60s later on the next lock refresh:

```jsonl
{"event":"health_error","ts":"2026-09-17T00:29:43.390Z","reason":"supervisor_lock_lost","detail":"fenced refresh matched 0 rows (stolen or force-cleared)","queue":"default","supervisor_pid":7}
{"event":"shutting_down","ts":"2026-09-17T00:29:43.390Z","reason":"supervisor_lock_lost","exit_code":4,"supervisor_pid":7}
{"event":"stopped","ts":"2026-09-17T00:29:43.403Z","reason":"supervisor_lock_lost","exit_code":4,"supervisor_pid":7}
```

`stopped` appears here — on the **failure** path, not the clean one. The container's
`restart: unless-stopped` brought a fresh supervisor up one second later
(`{"event":"started","ts":"2026-09-17T00:29:44.422Z","supervisor_pid":7,…}`) and the lock row was
re-acquired (`last_refreshed_at 2026-09-17 00:29:44.413696+00`), so the stack was left healthy.

### The classifier rule now in force (`src/upgrade/quiesce.ts`)

The verdict is **window-scoped**: only audit events at or after the moment the stop was requested may
decide it (a stale event from an earlier episode cannot). Within the window, the **last**
`shutting_down`/`stopped` row decides:

- **`clean`** — in-window `shutting_down` with `exit_code:0`, or in-window `stopped` with
  `exit_code:0` **and** reason `SIGTERM`/`SIGINT`; **and** `jobs supervisor status --json` agrees
  (`running === false`, `workers === []`).
- **`lock_lost`** — in-window `exit_code:4` (LOCK_LOST, L3) or reason `supervisor_lock_lost`.
- **`crashed`** — any other in-window non-zero `exit_code`.
- **`unproven`** — the window holds no deciding event, or a positive event the status contradicts.
  Absence of evidence is never a pass.

`SupervisorDrainProof` now exposes `windowStart`, `windowEnd` and `decidingEvent` so the reason for a
verdict is inspectable. A real clean quiesce on the live stack produced:

```jsonl
{"event":"shutting_down","ts":"2026-09-17T00:31:36.823Z","reason":"SIGTERM","exit_code":0,"supervisor_pid":7}
```

```json
{"windowStart":"2026-09-17T00:31:36.550Z","windowEnd":"2026-09-17T00:31:37.392Z",
 "decidingEvent":{"event":"shutting_down","ts":"2026-09-17T00:31:36.823Z","reason":"SIGTERM","exit_code":0,"supervisor_pid":7},
 "clean":true,"exitCode":0,"reason":"SIGTERM","classification":"clean"}
```

### Can Gate C's C6 assertion hold at `0.50.0.0`?

**Yes — provided Gate C reads the proof's `exitCode`/`reason`, not the event name.** The evidence:
the clean run above yields `exit_code:0` and `reason:'SIGTERM'` from the deciding `shutting_down`
row, which is exactly what C6 asserts (`auditExitCode === 0`, `auditReason in [SIGTERM, SIGINT]`).
The original `stopped`-only reader could not meet C6 on this pin, because `stopped` is emitted only
on the lock-lost path. C6 holds on the `shutting_down` row; it does **not** require a `stopped` row
to exist.

### What this does not prove

Only pin `0.50.0.0` was exercised. Whether **any** pin emits `stopped` on a clean drain — and in
particular whether `0.50.5.0` does — is **not** established here. Do not assume it. The
`shutting_down` row is the only clean-drain signal observed at either pin so far.

## F2 — `gbrain jobs supervisor stop` orphans its worker at `0.50.0.0`

**Status: `confirmed`.** Found running Task 15's Gate A A7 against the slice0 harness.

`gbrain jobs supervisor stop` exits 0 and the supervisor writes a clean drain event, but the worker
process it spawned keeps running. `jobs supervisor status --json` therefore still lists a live
worker, and `verifySupervisorDrained` (correctly, per honesty rule 3) refuses to call the drain
clean.

Exact commands (slice0 harness; the supervisor is started with
`GBRAIN_AUDIT_DIR=/srv/gbrain-home/.gbrain/audit` so its audit path is deterministic):

```bash
docker compose -f compose/docker-compose.slice0.yml exec -T \
  -e GBRAIN_AUDIT_DIR=/srv/gbrain-home/.gbrain/audit \
  gbrain-ops gbrain jobs supervisor start --detach --concurrency 2 --json
docker compose -f compose/docker-compose.slice0.yml exec -T gbrain-ops \
  gbrain jobs supervisor stop
```

Audit immediately after the stop — a clean supervisor event, and **no** `stopped`:

```jsonl
{"event":"started","ts":"2026-09-17T01:55:35.501Z","supervisor_pid":1572,...}
{"event":"worker_spawned","ts":"2026-09-17T01:55:35.534Z","pid":1601,...}
{"event":"shutting_down","ts":"2026-09-17T01:55:39.xxxZ","reason":"SIGTERM","exit_code":0,"supervisor_pid":1572}
```

The worker registry entry outlives the stop, and its pid is still in `/proc`:

```json
{"pid":1602,"queue":"default","brain_id":"1wejmfs","started_at":1789610136278,"nice_requested":null,"nice_effective":null}
```

```bash
# observed inside the sleeping gbrain-ops container:
test -d /proc/1602   # exit 0 -> ALIVE
```

The pid was still alive **>42 s** later (polled every 3 s): `running` stayed `false` while `workers`
stayed at 1. `jobs supervisor status` reports `workers` from `readWorkers()`
(`src/core/minions/worker-registry.ts:211`), which prunes an entry only when the pid is confirmed
dead — so the orphan keeps the drain classified `unproven`.

`--concurrency 0` still spawns one worker (the registry/audit both show a `worker_spawned` event), so
there is no configuration that makes the supervisor spawn zero workers.

### What it does and does not mean

It is a **supervisor-CLI-usage hazard**, not a quiesce defect. The product's quiesce (Task 6, D3)
stops the `gbrain-worker` **container**, where the supervisor is the container's main process: tini
forwards `SIGTERM` to it, it drains and writes `shutting_down`, and the container stop kills its whole
process tree. F1 above records a real-quiesce run on that path with
`clean:true` / `classification:"clean"`. Stopping the supervisor through the CLI alone is a different
boundary and is not the product's drain.

A related observation, same probe: stopping the slice0 `gbrain-ops` **container** does not stand in
for the real quiesce either. The detached supervisor is a reparented orphan, not tini's direct child,
so it receives no `SIGTERM`; the audit held only `started` and `worker_spawned` — no clean event at
all. No clean event means no proof, which is exactly why Gate A A7 asserts the honest `unproven`
verdict for the CLI path (and keeps the honesty-rule-3 property as a deterministic fixture: a clean
`shutting_down{exit_code:0}` with a live worker must not be recorded clean). The plan's
`clean===true` positive is proven end-to-end by Gate C's C6 against the real quiesce, not here.

---

# The upstream-reality rows (U1–U12)

Task 1's probes answered the `P` rows; the `U` rows are the plan's upstream-reality claims. Each is
recorded here with the artifact that backs it, or as `inference` when no artifact exists.

## U1 — `check-update` never sets an exit code

**Status: `confirmed`.** Where it bites: Task 7's `detectUpdate` (it branches on `.error`, never an exit
code), Task 15 A3, Gate C C8's cross-check.

Command — a throwaway container with no network and its own tmpfs `GBRAIN_HOME`, so the cached
`last-update-check` cannot answer instead of the network:

```bash
docker run --rm --network none --tmpfs /gb -e GBRAIN_HOME=/gb \
  brainstand/gbrain-base:0.50.5.0 gbrain check-update --json
```

Output (exit `0`):

```json
{
  "current_version": "0.50.5.0", "current_source": "package-json", "latest_version": "",
  "update_available": false, "upgrade_command": "bun update gbrain", "release_url": "",
  "changelog_diff": "", "published_at": "", "error": "network_error"
}
```

The network is provably gone (`error: "network_error"`) and the exit code is still `0` — 0 is the only
code this command emits. `test/contract/upgrade.contract.test.ts` asserts the same against the live
stack (`expect(r.exitCode).toBe(0)` on a healthy network).

## U2 — `check-update` reads master's `VERSION`; `published_at` is always `''`

**Status: `confirmed`.** Where it bites: honesty rule 2, D7 (detect offers; a human selects), the banner.

Command — the shipped `checkUpdate` operation through the RPC at the live pin:
`POST http://127.0.0.1:3140/rpc` with `{"op":"checkUpdate","json":true}`.

Output (`exitCode: 0`):

```json
{"current_version":"0.50.5.0","current_source":"package-json","latest_version":"0.50.5.0",
 "update_available":false,"upgrade_command":"bun update gbrain",
 "release_url":"https://github.com/garrytan/gbrain/blob/master/CHANGELOG.md",
 "changelog_diff":"","published_at":""}
```

`release_url` names the `master` branch's CHANGELOG, not a release API, and `published_at` is the empty
string — the field exists not to be rendered. (The running binary is already 0.50.5.0, so
`update_available` is `false`; the *source* is what this row is about.)

## U3 — `apply-migrations` has no `--json`; exit codes are 0 / 1 / 2

**Status: `confirmed`.** Where it bites: Task 7's registry entry (`supportsJson: false`), Task 15 A5,
Gate C C3/C9.

Evidence 1 — the registry refuses to emit `--json`, and `buildArgv` is what enforces it
(`test/contract/upgrade.contract.test.ts` A5):
`buildArgv(OPERATIONS.applyMigrations, {yes:true,nonInteractive:true}, {json:true})` throws
`applyMigrations does not support --json`. There is no JSON to parse, by construction.

Evidence 2 — a real `apply-migrations` on an up-to-date brain exits `0` with no JSON (A5): `exitCode 0`,
`json null`.

Evidence 3 — the fixtured failure (Gate C C3) exits `1`:
`MEASURED APPLY-MIGRATIONS(failure leg): exitCode 1; message "apply-migrations exited 1"`.
The product records only the code (G3); the SQLSTATE is observed on the test-only lane (below).

## U4 — `post-upgrade` read-modify-writes `config.json`'s `self_upgrade.*`

**Status: `confirmed`** for the write; the *first-write* observation was not obtained under the plan's
own sequence, stated rather than dressed up. Where it bites: Task 7's `postUpgrade.requiresLock`,
Task 15 A4, P7-b.

Observed (`/srv/gbrain-home/.gbrain/config.json`, through gbrain-ops, Task 15 A4):
`self_upgrade: { mode: "notify", mode_prompted: true }` before and after two `postUpgrade` RPC runs;
both exit `0` and are idempotent, and `printenv GBRAIN_SELF_UPGRADE_MODE` stays `off`.

Stated limit: `gbrain init` had already written `self_upgrade.*`, so the plan's expected "first diff
shows what `post-upgrade` writes" was **not** observed (P7-b records the byte-identical diffs and the
`init` mtime). Upstream's write being *lock-free* is read from the read-only checkout; what is observed
here is that our lane adds `requiresLock: true` so it serializes behind the ops advisory lock (U4/S3).

## U5 — `GBRAIN_SELF_UPGRADE_MODE` env overrides config

**Status: `confirmed`.** Where it bites: the kill switch, P2/A3-1, Gate C A4.

Evidence — Gate C A4 (live stack): `mainExec(["printenv","GBRAIN_SELF_UPGRADE_MODE"])` returns `off`
while `config.json` says `self_upgrade.mode: "notify"`; the environment wins. P2/A3-1 sharpens it: a cwd
`.env` cannot override the container's process env — `off` held (`cat -A` showed the baked-in `off$`).

## U6 — there is no schema-version surface in any published contract

**Status: `confirmed`**, with the one nuance that makes it true. Where it bites: the ledger records the
binary version plus doctor's `schema_version` check *status*, never the numeric schema version; Gate C C9.

Command — doctor through the shipped RPC at the pin: `POST /rpc {"op":"doctor","json":true}`.
Output: `exitCode 0`, `status warnings`, and:

- top-level `schema_version`: **`2`** — that is the doctor *report format* version, not the brain's.
- the only place the brain's numeric schema version appears is a check's human `message`:

```json
{"name":"schema_version","status":"ok","message":"Version 149 (latest: 149)","category":"meta"}
```

Parsing that message is screen-scraping (G3) — exactly what U6 says we will not do. There is no
structured field carrying `149`. (L4 re-confirmed on the same envelope: no top-level `blockers`.)

## U7 — an older binary against a newer schema silently succeeds; doctor warns and exits 0

**Status: `inference`.** No artifact carries this observation: this slice never ran an older binary
against a newer schema. The adjacent, observable half is real — `doctor` reports `warnings` and exits 0
(Gate C's `[doctor] exit 0 status=warnings`; P3's `[doctor] exit 0 status=warnings health_score=70`), and
the `schema_version` check carries `status: "warn"`/`"ok"` while doctor's exit stays 0. But the
"`applied:0`, no warning" behaviour of an older binary is taken from upstream RECON, not measured here.
Recorded as `inference` rather than dressed up as a measurement.

## U8 — no down-migrations upstream; rollback is snapshot-restore

**Status: `confirmed`.** Where it bites: D4, honesty rule 5, Gate C C11.

Artifact: the shipped `RollbackReport` in `src/upgrade/digest.ts` is
`{ method: 'snapshot-restore', ranUpstreamDownMigrations: false, ... }`, and Gate C C11 asserts both
(`expect(rbJson.method).toBe('snapshot-restore'); expect(rbJson.ranUpstreamDownMigrations).toBe(false);`)
and passes (e2e 23/0). The pin moves back because the *images* move back — never because a binary
rewrote itself.

## U9 — `supervisor stop`'s `reason:'drained'` cannot distinguish a clean exit from `MAX_CRASHES`

**Status: `contradicted`** — the audit vocabulary differs from the plan's assumption, while U9's core
claim ("`drained` is not proof") stands. This is F1; see the F1 section for the exact event shapes and
the classifier rule now in force. Consequence for Gate C: C6 reads the proof's `exitCode`/`reason` from
the deciding `shutting_down` row, not the event name.

## U10 — v0.50.0.0 → v0.50.5.0 ships zero schema migrations and zero capability drift

**Status: `confirmed`.** Where it bites: D9 (the failure half must be fixtured), C9, C10, P5.

Evidence — Gate C C9's own durable journal record for the schema step: `exitCode 0`,
`outcome: "no_migrations_pending"`, `evidence` matching
`migrate.ts is byte-identical at 0.50.0.0 and 0.50.5.0, so apply-migrations exited 0 with nothing to apply`.
Capability drift (C10 and P5):

```json
{"versionChanged":true,"toolsAdded":[],"toolsRemoved":[],"adaptersAdded":[],"adaptersRemoved":[],"profilesChanged":false}
```

## U11 — exactly one new playbook in the delta; `v0.50.3.0` does not exist

**Status: `confirmed`.** Where it bites: Task 9's `RELEASED_VERSIONS` / `playbooksFor`, Gate C C9's ledger.

Command and output (the 0.50.5.0 image):

```bash
docker run --rm --entrypoint sh brainstand/gbrain-base:0.50.5.0 -c \
  "ls -1 /root/.bun/install/global/node_modules/gbrain/skills/migrations/ | wc -l; \
   ls -1 .../skills/migrations/ | grep -E 'v0\.50\.'; \
   grep -nE '^## \[?0\.50\.' .../CHANGELOG.md"
```

```
42
v0.50.0.0.md
v0.50.2.0.md
---CHANGELOG---
5:## [0.50.5.0] - 2026-09-16
33:## [0.50.4.0] - 2026-09-16
58:## [0.50.2.0] - 2026-09-15
110:## [0.50.1.0] - 2026-09-14
256:## [0.50.0.0] - 2026-09-10
```

The delta contains `v0.50.0.0.md` (our start) and exactly one new file, `v0.50.2.0.md`. No
`v0.50.1.0.md`, `v0.50.3.0.md`, `v0.50.4.0.md` or `v0.50.5.0.md`. The CHANGELOG jumps `[0.50.2.0]` to
`[0.50.4.0]`: `0.50.3.0` was never released. Gate C C9's ledger held exactly
`['0.50.1.0','0.50.2.0','0.50.4.0','0.50.5.0']` and `not.toContain('0.50.3.0')`. The one playbook file
has **eight** numbered steps, not two (see the Task 9 Corrected blockquote).

## U12 — v0.50.5.0 is a security-hardening wave; the 5s `server.close()` bound is new

**Status: `confirmed`.** Where it bites: Task 1's probe; P2 (the `.env` guardrail did not quarantine our
mode); P3/P6/P8.

Evidence — the 0.50.5.0 image's own CHANGELOG (line 226):

```
- `gbrain serve --http` shutdown is bounded: if `server.close()` has not returned after 5s (a connection the socket tracker could no longer reach), the daemon logs one line and finishes shutting down instead of hanging, ...
```

and its source `src/commands/serve-http.ts:215` ("How long `server.close()` may hold shutdown before the
lifecycle gives up on it."). The 0.50.0.0 reference checkout's `serve-http.ts:235` instead comments that
Bun ships `closeAllConnections()`/`closeIdleConnections()` as no-op stubs — no bound at our pin. The
wave's other arms (OAuth scope ceiling, transcript redaction, `.env` guardrail, `bunfig.toml` preload
lockdown) are P2/P3/P8's and U6's territory; none broke us.

---

# Findings execution surfaced (F3–F6)

F1 and F2 are above. These four were surfaced completing Task 17 and are recorded in the plan's own
Corrected blockquotes where they contradict the plan.

## F3 — the journal path was nested one level too deep

**Status: `confirmed`.** `scripts/upgrade.ts`'s `buildContext` passed the RUN directory to
`openJournal(upgradeDir, runId)`, and `openJournal` joins `runId` onto the directory it is handed, so a
real run's journal landed at `UPGRADE_DIR/<runId>/<runId>/journal.ndjson`. The reconciler reads
`UPGRADE_DIR/<runId>/journal.ndjson` (`src/upgrade/reconcile.ts:120`), so a real run's journal was
invisible to reconciliation; Gate B only passed because it hand-wrote the correct path.

Observed on disk (the hung run):

```
.../brainstand-upgrade-e2e/run-dea67caa-e28f-48fa-b8b7-96352b1afc44/run-dea67caa-e28f-48fa-b8b7-96352b1afc44/journal.ndjson
```

Fix: `openJournal(UPGRADE_DIR, runId)` and `readJournal(UPGRADE_DIR, id)`. Regression test:
`test/unit/upgrade-journal.test.ts` asserts `openJournal(root, runId).path === join(root, runId, 'journal.ndjson')`
and mechanically that the CLI uses the root.

## F4 — `rollback()` spun forever on a dynamic import of the host CLI

**Status: `confirmed`.** `src/upgrade/digest.ts`'s `rollback()` did
`await import('../../scripts/upgrade.ts')` to borrow `writePin`. Because that module imports `digest.ts`,
Bun re-enters the CLI entry module's evaluation and spins one core forever — observed as 100% CPU with
no child processes, right after `restore`. Fix: `writePin` moved to `src/contracts/pin.ts` and imported
statically, plus a bounded `Promise.race` watchdog on every rollback step. Regression test:
`test/integration/upgrade-rollback.test.ts` (calls `rollback()` with fake deps; it previously hung at
that import) and a cycle-scan test forbidding `src/upgrade/**` from importing `scripts/upgrade`.

## F5 — Bun's startup `.env` auto-load shadowed the rewritten pin for every compose child

**Status: `confirmed`.** Bun snapshots the environment at process start and auto-loads `.env`, so
`scripts/upgrade.ts` starts with `GBRAIN_VERSION` = the OLD pin; every compose child inherits it and
prefers it over the `.env` the swap just rewrote (runtime `process.env` edits are invisible to
`Bun.spawn`). The swap built the images at the new tag but recreated `control-plane`/`gbrain-serve`/
`gbrain-worker` at the old pin, so `/api/health`'s `pin.matches` was false (honesty rule 9). Fix:
`childEnvNoPin()` on every compose spawn, `--build-arg GBRAIN_VERSION=<version>` on the build, and a
`resumeAtCurrentPin` / `RunDeps.resume` that re-issues resume through that env. Test: Gate C C8/C12
(`pin.observed`/`pin.matches`); the final state is 0.50.5.0 with `matches: true`.

## F6 — the content digest counted continuously-churning runtime state

**Status: `confirmed`.** Between two otherwise identical observations the control DB differed only by
`schedule_runs` (+6) and the file plane by one worker-registry file, both written by the resumed
scheduler/supervisor. Strict digest equality would therefore assert "no schedule fired", which rollback
does not promise. Fix: `schedule_runs`/`schedule_alerts` added to `UNCOUNTED_TABLES`, the worker registry
added to `FILE_PLANE_PROGRAM`'s skip set, and Gate C pauses schedules for its window and restores them
after. The digest still gates pin/sources/repos/configKeys/file-plane content/pages and every other
control table, and the snapshot still restores the excluded rows; loss is still caught.

## F7 — the capability-snapshot half of the lane has no product writer; the family e2e is red because of it

**Status: `confirmed`.** Found by Task 18's six-command verification — the first time the full
`bun test --parallel=1 test/e2e` family was run with Gate C included (`test/e2e/slice35.e2e.test.ts`
alone is green, 23/0; the family is **68 pass / 9 fail**, all nine in `slice35`: B9, C4, and the C6–C12
cascade).

Two independent defects, both exit-gate wiring:

1. **`capability_snapshots` has no product writer.** `recordCapabilitySnapshot`
   (`src/upgrade/capability.ts:18`) has **no caller under `src/` or `scripts/`**; the only writer is
   `test/integration/capability.test.ts`. The upgrade run never records a snapshot, so on a real
   deployment `capability_snapshots` is empty and `/api/upgrades/drift` returns **400** once
   `restore.e2e`'s own `docker compose down -v` has cycled the control database. `B9` (Gate B) and
   `C10` (Gate C) then fail. An isolated `slice35` run passes only on a database where the integration
   test — or a prior run — had already seeded both rows.
2. **`C6`'s preflight needs a healthy `doctor`.** `captureDoctorBaseline` throws when `gbrain doctor`
   exits non-zero, so preflight refuses `NO_BASELINE`. After the failure leg, `doctor` can be
   `unhealthy` with `minions_migration: fail` (`"MINIONS HALF-INSTALLED (partial migration: 0.11.0).
   Run: gbrain apply-migrations --yes"`), the real run exits `3` with no `runId`, and `C7`–`C12`
   cascade. Running `gbrain apply-migrations --yes` repairs it (verified).

Neither is a Task 18 change (this task touched docs only). Both are carried into Slice 4: wire
`recordCapabilitySnapshot` into the upgrade lane (or state that the drift panel is test-fed only), and
make the exit gate robust to a `doctor` that the failure leg itself unsettled.

### F7 fix (2026-09-17) — the writer is wired, the route is honest, the gate repairs its own fixture

Closed in three parts, no assertion weakened:

1. **Capability capture is part of the run.** `scripts/upgrade.ts`'s `runUpgrade` now calls
   `captureCapabilityForRun` twice — the FROM pin before the pre-upgrade digest (while its stack is up),
   the TO pin after the resume. It writes `capability-from.json` / `capability-to.json` into the run
   directory and journals a `capability` event with `{version, file}`. `captureCapability`
   (`src/contracts/capability.ts`) gained an injectable `exec`, so the SAME capturer serves the slice0
   harness and the main stack — no second implementation. `reconcileJournals`
   (`src/upgrade/reconcile.ts`) imports the files into `capability_snapshots`, exactly once per
   `(runId, seq)` event, on the same journal-first path as the ledger and the checklist.
2. **The drift route is honest when nothing has been captured.** `GET /api/upgrades/drift` catches
   `SingleSnapshotError` and returns `200 { single_snapshot: true, available }` instead of a 400. B9 now
   asserts that branch — the normal first answer on a fresh deployment, and what the plan's self-review
   #6 asked for — and still asserts the real diff when both pins exist.
3. **The gate repairs its own fixture.** C6 calls `repairFixtureResidue()` first — `gbrain
   apply-migrations --yes` through the gbrain-ops lane, then a `doctor` exit check — and prints
   `MEASURED REPAIR: ...`. `captureDoctorBaseline`'s refusal is untouched.

**Proof (empty table → two rows → drift 200).** `delete from capability_snapshots` left **0** rows; one
real `bun run scripts/upgrade.ts run --to 0.50.5.0 --yes` (runId `run-5718807b-8d5b-42f4-afac-f9306df99531`,
state `completed`) journaled:

```jsonl
{"seq":2,"step":"capability","level":"info","message":"capability captured for 0.50.0.0","data":{"version":"0.50.0.0","file":"capability-from.json"}}
{"seq":11,"step":"capability","level":"info","message":"capability captured for 0.50.5.0","data":{"version":"0.50.5.0","file":"capability-to.json"}}
```

and after the reconciler tick the table held **two** versions:

```
0.50.0.0|2026-09-17 06:26:05.2+00
0.50.5.0|2026-09-17 06:27:03.795+00
```

`GET /api/upgrades/drift?from=0.50.0.0&to=0.50.5.0` (authenticated) returned **200**:

```json
{"versionChanged":true,"toolsAdded":[],"toolsRemoved":[],"adaptersAdded":[],"adaptersRemoved":[],"profilesChanged":false}
```

The full family then ran green: `bun test --parallel=1 test/e2e` = **77 pass / 0 fail**, with
`MEASURED REPAIR: apply-migrations --yes repaired the fixture's partial playbook migration; doctor exit 0, status warnings`.

## F8 — the digest's `filePlane` counted gbrain's own runtime state

**Status: `confirmed`; fixed 2026-09-17.** C4 and C11 failed in the family run (rollback exit 4,
`[rollback] state differs after restore: filePlane`; C11's diff was `filePlane` 30 → 34 items) but passed
in isolation. The fixture was NOT the cause: the digest's `filePlane` part hashes the relative path and
size of every regular file under `GBRAIN_HOME`, and gbrain writes its OWN runtime state there on every
run — `migrations/completed.jsonl` + `pending-host-work.jsonl`, `credential-deliveries/*`,
`run/secret-*`, `last-update-check`, `model-cache.json`, `preferences.json`,
`backup-status.json` / `backup-nag-state.json`. No rollback can hold those constant, so "restores
exactly" was comparing churn. This is the same class as F6.

Fix: `FILE_PLANE_PROGRAM` (`src/upgrade/digest.ts`) skips that runtime set (and, as before, the worker
registry), so the part is CONTENT and gbrain's bookkeeping — `configKeys` still carries the config's key
names. The snapshot still restores those files, and loss of real content is still caught. After the fix
the family is 77/0.

---

## F9 — the Gate C family was not re-runnable, and an abort left the brain fixtured

**Status: `confirmed`; fixed 2026-09-17.** The gate left the stack on `0.50.5.0` on purpose (C12: that is
what Slice 4 inherits), but the family's own entry state does not re-establish `0.50.0.0`. A second
`bun test --parallel=1 test/e2e` therefore started on `0.50.5.0` and failed: Gate B's B2 and Gate C's C1
assert the FROM pin (`0.50.5.0` observed instead of `0.50.0.0`), then C3's failure leg
`run --to 0.50.5.0` is refused by the shipped preflight (`SAME_VERSION`), so C4–C12 cascade — the
coordinator measured **65 pass / 12 fail**, and quoted C1's assertion as the `0.50.0.0` vs `0.50.5.0`
mismatch. The same run left the brain FIXTURED (its abort skipped the un-fixture: `config.version` 143
and `open_loops` replaced by a one-column table; the coordinator repaired it to 149 / 21 columns by hand).
So F9 is two defects: the family could not be re-run, and its failure mode poisoned the next run.

Fix 1 — precondition normalization (`test/e2e/slice35.e2e.test.ts`, file-level `beforeAll`, so it runs
before Gate B's pin-sensitive B2 as well as Gate C): `normalizeToFromPin()` first checks the declared
pin; if it is already `0.50.0.0` it prints
`MEASURED PRECONDITION: declared pin already 0.50.0.0; nothing to normalize` and returns. Otherwise it
picks the newest run whose `manifest.json` `fromVersion === FROM_PIN` **and** whose journal contains
`"step":"completed"` (`latestCompletedRunFromPin` — a FIXTURED failure-leg snapshot is never chosen,
which is what poisoned the brain), runs the product's `rollback --run <id>`, then verifies
`declaredPin() === 0.50.0.0` and `healthPin().observed === 0.50.0.0 && matches === true`, with a
host-side `writePin` + `compose build --build-arg GBRAIN_VERSION=FROM_PIN gbrain-ops` + recreate
fallback. The rollback is accepted on exit `0` **or** `4`: exit 4 is a parity verdict against that run's
recorded digest, raised after restore and the pin move already completed (F8's stale-digest residue), and
the verification immediately below is the real gate. A green run printed, verbatim:

```
MEASURED PRECONDITION: stack was on 0.50.5.0; the product's rollback of completed run run-53f09b47-eb16-42ab-936e-8433de5d5112 returned it to 0.50.0.0 (rollback exit 4, a parity verdict against that run's recorded digest — restore and pin move completed)
```

Fix 2 — an abort backstop (Gate C `afterAll`): a module-level `fixtureApplied` flag is set `true` right
after `applyMigrationCollisionFixture` (C2) and `false` right after `undoMigrationCollisionFixture` (C5).
Gate C's `afterAll` un-fixtures if the flag is still `true`, inside `try/finally`, so a leg that aborts
with the fixture applied (a failed assertion, a timeout, a Ctrl-C) cannot leave the brain fixtured. The
abort path is proven, not assumed: with a fault injected at the top of C5 (before its un-fixture), the
file aborted and the backstop restored the brain —

```
MEASURED UN-FIXTURE (afterAll backstop): UN-FIXTURE: open_loops restored to the real schema; config.version -> 149
```

…and the post-run probe read `config.version` **149** with `open_loops` back to **21** columns (the
induced fault was reverted after the probe; no fault hook ships). On an ordinary green run the backstop is
a no-op because C5 has already un-fixtured.

Fix 3 — re-run proof. Two consecutive `bun test --parallel=1 test/e2e` invocations, each starting from
`0.50.5.0`, were **77 pass / 0 fail** (`Ran 77 tests across 5 files`). Invocation 1 proves the
normalization half (it printed the `MEASURED PRECONDITION: stack was on 0.50.5.0 …` line above);
invocation 2 proves the re-run half (a second consecutive family run, again `77 pass / 0 fail`). Both
ended on `0.50.5.0`, the state Slice 4 inherits.

---

# Gate C — measured numbers (real, per leg)

Every number below is a `MEASURED` line the green Gate C run
(`bun test --parallel=1 test/e2e/slice35.e2e.test.ts`, **23 pass / 0 fail**) printed; the span each
covers is named.

| Measurement | Value | Span / definition |
|---|---|---|
| Failure-leg run wall time | 114053 ms, exit 1 | `scripts/upgrade.ts run --to 0.50.5.0 --yes`, wall clock |
| `apply-migrations` exit code (failure leg) | 1 | U3: the only code-bearing signal; no `--json` |
| Failure-leg rollback | 32513 ms, exit 0 | `rollback --run <failed>`, wall clock |
| Real-leg run wall time | 65569 ms, exit 0 | the clean `run --to 0.50.5.0 --yes` |
| Quiesce loop | 3316 ms | scheduler stop → gbrain-ops stop (`q.data.drainMs`) |
| Supervisor-drain window | 764 ms | stop request → verdict (`windowEnd − windowStart`); decidingEvent `shutting_down{reason:SIGTERM,exit_code:0}` |
| Snapshot | 2716 ms, 3840081 bytes | the four artifacts, `docker-volume` driver |
| Build + swap | 40310 ms | journal `snapshot_taken` → `swapped` |
| Doctor parity | status `warnings`, healthScore 50, newChecks 1, regressed 0 | `gate.parity`; verdict `pass` |
| Total downtime | 56274 ms | journal `run_completed.downtimeMs`: quiesce start → gate done |
| Success-leg rollback | 63244 ms, exit 0 | `rollback --run <real>`, wall clock |

The plan's four required numbers are the quiesce window, the snapshot duration + bytes, the image build
time and the total downtime; all four are above. L1's "~1.2 s for the supervisor drain" holds for the
drain (a 764 ms window here; F1's controlled run measured 1150 ms), while the measured QUIESCE LOOP is
3.3 s and the total downtime is ~56 s. **The window is dominated by the image build (40.3 s), not by the
supervisor drain.**

# Gate C — the migration-collision fixture (D9), verbatim

```
MEASURED FIXTURE: FIXTURE: config.version 149 -> 143; open_loops replaced (id TEXT PRIMARY KEY)
MEASURED FIXTURE STATEMENTS: DROP TABLE IF EXISTS open_loops CASCADE || CREATE TABLE open_loops (id TEXT PRIMARY KEY) || UPDATE config SET value = '143' WHERE key = 'version'
MEASURED FIXTURE PROBE: exit 1; stderr ERROR: column "source_id" does not exist
MEASURED FIXTURE PENDING: 6 migrations (144..149, derived from upstream m.version > current)
MEASURED APPLY-MIGRATIONS(failure leg): exitCode 1; message "apply-migrations exited 1"
MEASURED UN-FIXTURE: UN-FIXTURE: open_loops restored to the real schema; config.version -> 149
```

- The probe is upstream v144's own `CREATE INDEX ... ON open_loops (source_id, status, ...)` run on the
  **test-only psql lane**; its SQLSTATE **42703** is observed there and never through the product
  (`opsRpc` relays only `{ exitCode }` — G3). `plan` does not compute a pending count: there is no
  published contract for the schema version (U6), so the gate derives 6 from upstream's own
  `m.version > current` filter, named in its output.
- Fixture order (executed): pre-digest taken **after** the fixture; Leg 1's rollback asserts it restored
  the **fixtured** state exactly (recorded version 143 and the incompatible `open_loops`, digest equal,
  `columnsOf` = `['id']`); an explicit **UN-FIXTURE** runs between the legs so Leg 2 is clean against a
  149 brain. Both the fixture and its removal are printed and asserted.

# `playbook_ledger` state vocabulary (Slice 4 carry)

The CHECK allows only `pending|applied|skipped|awaiting_admin_decision`. A no-playbook-required version
is recorded as **`applied`** with the evidence in `notes` (honesty rule 7): Gate C C9 observed
`0.50.1.0`/`0.50.4.0`/`0.50.5.0` in state `applied` with `notes` matching
`upstream ships no playbook for this version` and the `skills/migrations/` listing, while `0.50.2.0` is
`awaiting_admin_decision` (it opens 8 checklist items). `skipped` would be a lie — nothing was skipped,
there was nothing to do. Filed as a Slice 4 carry: the ledger wants a `not_required` state.

# `check-update`'s cache path (observed, not assumed)

P2/A2 seeded and read it: **`/root/.gbrain/last-update-check`** (container `$HOME/.gbrain`, not
`GBRAIN_HOME`), content `UPGRADE_AVAILABLE <cur> <new>` or `UP_TO_DATE <cur>`, mode `0600`. The plan did
not name the path; it is recorded here from the probe.

# What `compareDigests` does not see (C4)

`compareDigests` reads contract-visible state (pin, sources, repos `HEAD` trees, config key names,
file-plane content, control row counts). The two things the fixture breaks — the recorded schema version
(a `config` row) and the incompatible `open_loops` table — are **below** that line, so C4 asserts them
directly through the same test-only psql lane (`recordedSchemaVersion` and `columnsOf`). "No differences"
is therefore not a broader claim than "the contract-visible state came back"; the direct assertions are
what cover the fixtured values. Stated so nobody reads the digest as wider than it is.
