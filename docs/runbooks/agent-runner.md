# The agent runner: what ran at 3am, what it cost, and the one button that undoes it

The agent runner is the **optional** container that hands a prompt to a pinned Claude Code harness
against your brain, **using your organization's API key, on a schedule, with nobody watching**. It is
the second consumer of the Slice 3 scheduler: `agent_prompt` is a `job_type` on `schedules`, the run
ledger is still `schedule_runs`, and the runner claims its rows over HTTP long-poll. It is also the
only container in this stack that executes code a model chose, so every sentence in this document
exists because of a way that goes wrong unattended.

It is off unless someone turned it on. `agent-runner` ships under the compose profile **`runner`**; a
deployment that only connects members' own agents omits it and loses nothing else — not `/schedules`,
not the console, not a health check ([D12](../superpowers/plans/2026-09-17-slice-4-agent-runner.md)).

Compose commands below use the form this repo uses locally, with the dev override appended:

```bash
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml <verb>
```

On the VM drop `-f compose/docker-compose.dev.yml`. That override carries the dev-only Caddy CA copy
(`caddy-ca-export`, `NODE_EXTRA_CA_CERTS`) that the runner needs to dial `https://${DOMAIN}/mcp` with
a locally-issued certificate, and nothing else the runner lane needs.

## The service

`agent-runner` runs `bun run /app/src/runner/main.ts` from `brainstand/agent-runner:${HARNESS_VERSION}`
— the harness is `@anthropic-ai/claude-code` at an **exact** pinned version (`2.1.274` at this pin; the
image build fails on a mismatch, and `lint:forbidden`'s `moving-harness-pin` fails the build on a
moving reference). It is **strictly the least privileged process in the stack**:

- **One bearer, no data lane.** `RUNNER_TOKEN` for the control plane (`CONTROL_URL=http://control-plane:3150`)
  and, per run, one short-lived gbrain token. It holds **no** `CONTROL_DATABASE_URL`, **no**
  `GBRAIN_DATABASE_URL`, **no** `GBRAIN_HOME`, **no** `OPS_RPC_TOKEN`, **no** `ENCRYPTION_KEY` and
  **no** provider key.
- **One network, and it has no route out.** `runner-net` is `internal: true`, so there is no gateway
  and no NAT. Its only members are `agent-runner` (this network and nothing else), `caddy` (aliased to
  `${DOMAIN}`, so `https://${DOMAIN}/mcp` is the one way into gbrain) and `control-plane` (the
  claim/heartbeat/events/finish and gateway routes, never routed publicly).
- **Hardened by construction.** `read_only: true`, `user: "10001:10001"`, `cap_drop: ["ALL"]`,
  `no-new-privileges`, `pids_limit: 256`, `mem_limit: 2g`, `cpus: 1.0`, `tmpfs: [/tmp]`, `volumes: []`
  (none, ever), no `ports:`, `stop_grace_period: 60s`, and **no `restart:` policy** — a runner that
  refuses to start on a misconfiguration must not become a crash loop that hides the message.
- **Pull, not push.** `POST /api/runs/claim` long-polls up to 25 s and answers `204` on an empty window
  (Gate B measured `204` after 25012 ms); the runner loops immediately. Heartbeats every **15 s**. The
  lease is `timeoutSeconds * 1000 + 60_000` from the last heartbeat. `schedule_runs.claimed_by` carries
  the runner's own id, `${HOSTNAME}-${uuid8}`.
- **One queue, two consumers.** The scheduler claims `['gbrain_command']`, the runner claims
  `['agent_prompt']`, and the filter is applied inside the `FOR UPDATE SKIP LOCKED` select — neither
  lane can starve the other, and a run row the wrong consumer owns is never locked.
- **The tool surface is closed.** Exactly one MCP server (gbrain) and an allowlist of
  `mcp__gbrain__<tool>` names intersected with the running pin's capability snapshot.

Verify the profile model for yourself — this is what "optional" means mechanically:

```bash
# The active profile model: agent-runner is NOT here (measured).
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml config --services
# postgres gbrain-worker gbrain-ops scheduler gbrain-serve control-plane caddy

# The profile it hides behind (measured).
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml config --profiles
# runner

# With the profile on, dev adds the one-shot CA copy too (measured).
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml \
  --profile runner config --services        # … caddy-ca-export agent-runner caddy

# Production has no caddy-ca-export: the runner dials ${DOMAIN} there (measured).
docker compose --env-file .env -f compose/docker-compose.yml --profile runner config --services
```

`config` renders and starts nothing, so it is always safe to run.

## Enable and disable

**The switch is `RUNNER_TOKEN` in `.env`.** Empty means the lane is off: the control plane answers
`503 {"error":"runner_disabled"}` on the runner's own routes, the create route refuses an
`agent_prompt` schedule, and an empty bearer never authenticates (two empty strings would pass
`timingSafeEqual`, which is exactly why the empty case is refused before the comparison). The runner
refuses to start at all without it and exits non-zero.

`COMPOSE_PROFILES=runner` is what starts it on a plain `up`. `scripts/install.sh` asks in plain words
and writes both — anything but an explicit yes (including EOF on a non-interactive install) leaves the
runner off:

```
This container runs model-written code against your brain, using your organization's API key, on a
schedule, with nobody watching. Enable it? [y/N]:
```

### Enable, by hand

```bash
# 1. The switch and the profile, in .env. Any long random string will do — never a guessable one.
#    `bash scripts/install.sh` writes exactly these two lines and generates the value itself
#    (`head -c 48 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-48`, one POSIX-shell line that the
#    Windows shell this document was written from cannot run: it has no /dev/urandom).
printf 'RUNNER_TOKEN=<48+ random characters>\n' >> .env
printf 'COMPOSE_PROFILES=runner\n' >> .env

# 2. The control plane must see the token, then the runner can claim.
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml \
  up -d --force-recreate control-plane
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml \
  up -d agent-runner

# 3. Read the lane's state (three keys, no token, no client id).
curl -sk https://localhost/api/health | python -c "import sys,json;print(json.load(sys.stdin)['runner'])"
```

Order is not fatal: a runner that starts first gets `503 runner_disabled` or `401 unauthorized` on its
claim, logs it, and backs off. But nothing is claimed until the control plane has the token, so do step
2 first.

**The trap: never `--no-deps` the runner up.** In dev the runner mounts `/etc/ssl/caddy-root.crt`, which
the one-shot `caddy-ca-export` writes into the dev-only `runner-ca` volume
(`depends_on: caddy-ca-export: { condition: service_completed_successfully }`). Skip the dependency and
the subpath mount fails outright. Measured on this machine, in a throwaway project so the live lane was
untouched:

```
$ docker compose -p runbookprobe --env-file .env -f compose/docker-compose.yml \
    -f compose/docker-compose.dev.yml up -d --no-deps agent-runner
 Container runbookprobe-agent-runner-1 Starting
Error response from daemon: cannot access path
  /var/lib/docker/volumes/runbookprobe_runner-ca/_data/caddy-root.crt:
  lstat ...: no such file or directory
exit=1
```

The same failure from the bare volume API, which is the whole mechanism:

```
$ docker run --rm --mount type=volume,source=runbook-ca-probe,target=/etc/ssl/caddy-root.crt,\
volume-subpath=caddy-root.crt,readonly busybox:1.36 ls -l /etc/ssl/caddy-root.crt
docker: Error response from daemon: cannot access path
  /var/lib/docker/volumes/runbook-ca-probe/_data/caddy-root.crt: …: no such file or directory
```

So `up -d agent-runner` (which runs its dependencies) or `--profile runner up -d` — never
`--no-deps agent-runner`. The exported file is a `0644` copy because Caddy writes its own authority
files `0600` under a `0700` directory and the runner is uid 10001 with `cap_drop: ALL`; the live
volume's content is one such copy (`-rw-r--r-- root root 1311 caddy-root.crt`, measured).

After recreating the control plane, **restart the runner too**. A long poll is held against the address
the old container had, and the runner's own log records exactly what that looks like (`logs --tail 100
agent-runner`, measured on this stack while the lane was otherwise up):

```
[runner] 06fc334a371f-3156fbca up, harness 2.1.274, tools 7 on the closed list
[runner] claim failed: Unable to connect. Is the computer able to access the url?
```

That is a transport failure to a service that no longer exists at that address, not a connected lane,
and it is why Gate B re-reads health after its own recreate instead of assuming a healthy one.

### Disable

```bash
# 1. Stop the consumer. SIGTERM drains: the in-flight run finishes, nothing new is claimed.
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml \
  stop agent-runner

# 2. Take the token away from the control plane. The empty value in the child environment wins over
#    .env (compose precedence: process env > --env-file), which is exactly how the state below was
#    produced by Gate B without editing a file.
RUNNER_TOKEN= docker compose --env-file .env -f compose/docker-compose.yml \
  -f compose/docker-compose.dev.yml up -d --force-recreate control-plane

# 3. To make it permanent, edit .env: RUNNER_TOKEN= empty, and remove COMPOSE_PROFILES=runner.
```

What each half does, and what to expect:

| Surface | With the token empty | With the token set |
|---|---|---|
| `GET /api/health` → `runner.state` | `disabled` | `connected` while a runner is polling (`RUNNER_SEEN_WINDOW_MS`, 50 s) or holding a live lease; `never_claimed` once the last sighting ages out |
| `POST /api/runs/claim` (runner bearer) | `503 {"error":"runner_disabled"}` — measured by Gate B's B10 | `401 {"error":"unauthorized"}` for an empty, absent or wrong bearer — measured live here |
| `POST /api/schedules` with `jobType: agent_prompt` | `409 runner_not_enabled`, with `state` and `lastSeenAt` | accepted (`201`) while a runner is **seen** — idle and long-polling counts, and that is the point of D2 |

The disable/enable pair was **not re-run while writing this document**: Gate B is executing that exact
sequence as its B10 leg and Gate C covers it again as C12, and two agents flipping `RUNNER_TOKEN` and
recreating `control-plane` at once would make both flaky. Gate B's measured output (its own run log):

```
[gate-b] B10 health while disabled: {"state":"disabled","lastSeenAt":null,"version":null}
[gate-b] B10 create while disabled: 409 runner_not_enabled (state disabled)
[gate-b] B10 restored: runner={"state":"never_claimed","lastSeenAt":null,"version":null}
                       container=bdf52ea983e9-461f92f8 harness=2.1.274
[gate-b] B12 states: disabled={"state":"disabled","lastSeenAt":null,"version":null}
                     connected={"state":"connected","lastSeenAt":"2026-09-17T17:44:38.545Z","version":null}
                     never_claimed={"state":"never_claimed","lastSeenAt":"2026-09-17T17:44:38.545Z","version":null}
```

`runner.state == "disabled"`, `503 {"error":"runner_disabled"}`, the refusal at the create route, the
`stop agent-runner` in step 1 and the restored `never_claimed` are therefore **Gate B's** measurements,
not re-run here. What this document did run independently is the mechanic behind step 2 (an empty
`RUNNER_TOKEN` in the child environment renders both services' token empty — see *Provenance*) and the
health read in step 3.

> **D2 changed two lines of that log.** The restored lane now reads `connected`
> (`{"state":"connected","lastSeenAt":"…","version":"2.1.274"}`) instead of `never_claimed`/`null`,
> because a runner that is polling **has been seen** — and the B12 third state is now the IDLE read,
> taken after a claim request that consumed nothing. The refusal text moved with it (below). The
> `disabled` half of the log is unchanged: an empty `RUNNER_TOKEN` still short-circuits to `null`/`null`
> without consulting the sighting record at all.

## "What did the 3am agent do?"

**Getting in.** The console's door is a **sign-in page** (`src/console/pages/SignIn.tsx`, the `signin`
phase of `src/console/App.tsx`'s `phaseFor`, F18). A returning operator is asked to sign in with their
own account — the page posts `/api/auth/sign-in/email` — because the session probe `GET
/api/wizard/state` is `requireAdmin` and answers **401** to a request that carries no session. A wrong
password is answered in words (`That email and password do not match an account. Check them and try
again.`), not with the raw 401; every other refusal keeps the server's own text, including Better Auth's
`403 Invalid origin`, which is deliberately **not** read as a bad password. The fresh-install form is
still there for a box that genuinely has no admin, and its own `already_bootstrapped` refusal now routes
to sign-in instead of printing the code. **Before F18 the bundle had no sign-in page at all**: a
returning operator landed on "Create the first admin" and every submission was refused
`already_bootstrapped` — a 409 from a form that had nothing left to do — so a lane that was running
perfectly was unreachable from its own console. The page's existence and the two measured screens
(`h1 = "Create the first admin"` before, `h1 = "Sign in"` after) are **F18's** measurements, in
[`docs/slice-4-findings.md`](../slice-4-findings.md), not re-run here.

Console: **`/runs`**. The list, and then a detail that renders the prompt, the tool-call timeline, the
token counts, the cost, the diff and the revert button. That page is the answer to the question, and
`GET /api/runs/:id` is the **one request** behind it — a `viewer` session is enough:

```bash
curl -sk -b <session-cookie-jar> https://localhost/api/runs
curl -sk -b <session-cookie-jar> https://localhost/api/runs/<runId>
```

The detail's key set (measured live, 26 keys):

```
runId scheduleId scheduleName state attempt slot fireAt startedAt finishedAt
model harnessVersion budgetUsd costUsd numTurns failureClass failureDetail
connectionId clientName prompt events usage diff heads tokenRevokedAt
revertedAt revertCommit
```

- `prompt` is the schedule's prompt, `events` the redacted, `seq`-ordered stream (assistant frames,
  tool-use blocks with their results, parse errors, runner refusals), `usage` one row per metered model
  call (model, four token counts, `costUsd`, `stopReason`, `httpStatus`), `diff` the git range,
  `heads` the before/after head per Space.
- It **never** returns the run's gbrain token, the gateway token, or a raw model request body.
- A `gbrain_command` run has no agent view: `/api/runs` is the agent lane only. Command runs live on
  `/schedules` ([scheduler.md](./scheduler.md)).

Three things the page states that a reader must not soften:

1. **The run's status comes from the exit code and the error frames — never from the agent's own
   closing message.** The harness's final assistant text is one frame in `events`; the run's
   `state`/`classification` is the control plane's reading of the process. A run that says "done!" and
   exits 1 is a failed run, and the console renders it as one (honesty rule 1).
2. **`costUsd: null` means "could not be priced", not zero.** The price table is pinned and dated
   (`MODEL_PRICING.pricedAt`, `2026-09-17`); a model absent from it is unpriced by definition, and a
   call the gateway cannot price is a call it refuses to forward — so an unpriced *schedule* is refused
   at creation, when an operator is looking, rather than producing a 3am run whose cost nobody can
   state (honesty rule 3). The page says "Not priced … the cost is unknown, not zero".
3. **The cost is a rollup that must reconcile.** `agent_runs.cost_usd` equals
   `SUM(agent_run_usage.cost_usd)`; when the stored total and the calls disagree the page says so
   instead of showing a figure as if it were verified.

When the console is not reachable, the same facts are one read-only `SELECT` away (both queries below
were executed against the live control DB; they returned 0 rows because the gates had just cycled it):

```bash
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml \
  exec -T postgres psql -U gbrain -d control -c "
    select r.id, r.slot, r.attempt, r.state, r.classification, r.claimed_by,
           r.started_at, r.finished_at, a.model, a.cost_usd, a.budget_usd, a.num_turns, a.failure_class
      from schedule_runs r join agent_runs a on a.run_id = r.id
     order by r.started_at desc nulls last limit 10;"

docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml \
  exec -T postgres psql -U gbrain -d control -c "
    select u.run_id, u.seq, u.model, u.input_tokens, u.output_tokens,
           u.cache_read_tokens, u.cache_write_tokens, u.cost_usd, u.http_status
      from agent_run_usage u order by u.at desc limit 20;"
```

The runner's own log is line-oriented and never prints a body: the run id, model, tool count, budget,
timeout, harness exit code and error-frame count (`logs --tail 100 agent-runner`).

## Killing a run, and what happens if you do not

There is **no cancel button on a run** in this slice. Deliberate kills are host actions:

| Command | What it does |
|---|---|
| `docker compose … stop agent-runner` | SIGTERM → the runner **drains**: it finishes the in-flight run (finish path classifies it, revokes its gbrain token, commits its writes, computes the diff), claims nothing new, exits 0. Bounded by the service's `stop_grace_period: 60s`; past that Docker SIGKILLs it and the run becomes a lapsed lease. |
| `docker compose … kill agent-runner` | SIGKILL. No drain, no finish report. |

A graceful stop says so in the log — these two lines are from the runner's own log on this stack, after
a real `stop agent-runner`:

```
[runner] SIGTERM: draining — finishing the in-flight run, claiming nothing new
[runner] stopped
```

If you do nothing, the lease lapses — and it is not quick: the lease is
`timeoutSeconds + 60s` measured from the **last heartbeat** (heartbeats every 15 s, so the default
30-minute nightly briefing leaves the row leased for about half an hour after the runner dies). Then
the scheduler leader's next tick (`SCHEDULER_TICK_MS`, default 15000) reclaims it, and the reclaimer
does five things:

1. `schedule_runs.state = lease_expired`, `classification = infra_failed` — the word honesty rule 5
   uses, and only the agent lane gets it (a dead `gbrain_command` run is still `failed`).
2. `agent_runs.failure_class = infra_failed`, `failure_detail = { reason: 'lease_expired', claimedBy, … }`.
3. A schedule alert of kind **`lease_expired`**, whose detail names `jobType` and `claimedBy` and says
   the reclaimer revoked the token — **not** the process that died.
4. **The run's gbrain token is revoked by the reclaimer.** A dead runner's run is not a finished run:
   the per-run credential must not outlive the process that owned it (honesty rules 5 and 9).
5. No automatic retry. The reclaimer classifies; it does not re-run. A retry row (`attempt = n+1`,
   slot `<slot>#r<n+1>`, so the `(schedule_id, slot)` idempotency key still holds and the failed
   attempt stays in history) is created by the **finish/refusal** paths under D11's policy: retry only
   `infra_failed`, cap 2, and never `budget_exceeded`, `timeout`, `agent_failed` or `refused`.

What the agent already did is **not** undone: a page it wrote before dying is still written. Open
`/runs`, read the row, and revert (below) if the work should not stand.

The only cancellation path that exists is a schedule with `overlapPolicy: kill_previous`: the new
occurrence marks the in-flight agent run cancelled, the runner's next heartbeat gets
`409 cancel_requested`, and the runner SIGTERMs the harness — the run finishes `cancelled`.

Also relevant: an upgrade **refuses to start** while any `schedule_runs` row is `running` (preflight
`RUN_IN_FLIGHT`), precisely so a half-written agent run is never frozen into a snapshot.

## Revert: `POST /api/runs/:id/revert`

Admin only — a `viewer` session gets `403 {"error":"forbidden"}` and no session gets
`401 {"error":"unauthorized"}` (both measured). The console's button is the same call with its
confirmation in front.

What it does, in order:

1. `git revert --no-commit <before>..<after>` in the run's write Space, under the repo lock.
2. `commitAs(sourceId, actor = the acting admin, "revert: agent run <runId>")` — the audit story is
   that a **named human** reverted it, never that "the system" did.
3. **the pages the revert removed, deleted by name** (`gbrain delete <slug> --source-id <write Space>
   --purge`, F16): the page an agent run writes is created brain-first by MCP `put_page`, and `sync`
   reconciles `anchor..HEAD` — a file added and removed inside that one window nets to nothing, so a
   re-sync alone leaves the reverted page answering. A slug whose file is still in the write Space is
   **skipped** and named in the response, because that file is someone's live work; then
4. `sync` + `embed --stale` through the **normal scheduler command path**, so the rest of the brain's
   index moves back with the tree. Honesty rule 7: **a reverted file that still answers searches is not
   reverted.** A failed re-index is an error, not a success: the message names the revert commit that
   already landed, so you know the tree moved and the index did not — the two are never presented as
   both done when only one is.

It is a **new commit**, never a history rewrite, and **nothing ever auto-reverts.**

Three refusals, each an explicit choice the console renders rather than a dead end:

| Code | When | What the operator does |
|---|---|---|
| `already_reverted` | The row already carries a revert (`reason: "recorded"`), the recorded range holds no commits (`"empty_range"` — the normal case for a run that wrote nothing), or git found an empty inverse diff (`"nothing_to_revert"`). | Nothing. Read the `reason` and the detail; there is no revert to make. |
| `revert_concurrent_writers` | The range contains commits this run did not write. The body carries `commitCount`, `foreignCommitCount` and `foreignAuthors`. | Decide deliberately, then re-POST with `?confirm=concurrent`. Reverting undoes those commits too. |
| `revert_conflict` | The range does not revert cleanly, **or** there is no recorded head range — a run that never finished, or whose Connection is gone. | Resolve on the host. The console shows it and never forces it. |

Measured live against a `succeeded` run whose recorded range was empty:

```
$ curl -sk -b <admin-cookie-jar> -X POST https://localhost/api/runs/c7fac43c-…/revert
{"error":"already_reverted","runId":"c7fac43c-…","reason":"empty_range","revertedAt":null,
 "revertCommit":null,"detail":"the recorded range 40add43..40add43 in internal is empty: run
 c7fac43c-… never committed anything there, so there is nothing to revert"}
http=409
```

and the run afterwards was unchanged (`revertedAt` still `null`, `state` still `succeeded`) — a refusal
is not a mutation. That refusal needed no money and no state change, which is why it is the one this
document used.

## The diff's honest limits

The diff is the **git range** of the write Space, captured as a head pair at claim and re-read at
finish. Three limits are stated rather than hidden:

- **gbrain makes no commit for an MCP write.** In this stack a `put_page` over `/mcp` leaves an
  *untracked file* and `HEAD` unmoved (`docs/slice-4-findings.md`, P8). So the run's **finish path
  commits the run's writes itself** — `commitAs(writeSpace, runMember, "agent run <runId>")` — *before*
  it reads the after-head. That is what makes the range real, and it is why the author of a commit in
  these Spaces is one of **our** writers and never gbrain.
- **A commit written by another of our writers is reported, not assumed away.** `live-sync`, a
  member's own agent, or another brainstand job can commit in the same Space during the window.
  `attributeCommits` sets `concurrentWriters: true`, lists `foreignAuthors`, and the console says
  *"2 of 5 commits in this range were not written by this run"* — never presenting them as the agent's
  work. Revert then needs `?confirm=concurrent`. (We cannot stamp our own run id on commits made by
  other writers in the same Space, so this is the honest ceiling on attribution rather than a
  temporary gap — and it is why the console phrases it as a count, not a verdict.)
- **A read Space whose range moved is an alert, not a diff row.** `agent_read_space_moved` is raised
  org-level, and the page renders it as the loudest element: read isolation is the Slice 2 promise and
  a read Space is handed to the agent as read-only. A run holds no write authority there, so the mover
  is something else — and the finding is the movement itself.

An empty range is a **fact, not a failure**: `files: []` with `before == after` means nothing was
committed in that Space during the run, and the revert correctly refuses with `empty_range`.

## Rotating the Anthropic key

The organization's Anthropic credential is a row in the **control DB's `secrets`** table, scoped to the
org, named **`anthropic_api_key`**, envelope-encrypted: an AES-256-GCM payload under a per-row wrapped
DEK, with the KEK derived by HKDF from `ENCRYPTION_KEY`. It is read **only by the model gateway, in
process** (`readSecret` in `src/gateway/proxy.ts`). It is never handed to the runner, never written
into a runner's workspace, never logged, and never part of the claim response.

**What this dev stack holds today, stated plainly.** The stored value is a **Claude Code OAuth access
token**, not an `sk-ant-` API key. Measured without reading the value out (the probe printed the shape
and the length only):

```
[{"name":"openai_api_key","version":1,"createdAt":"2026-09-17T06:12:35.047Z","rotatedAt":null},
 {"name":"anthropic_api_key","version":1,"createdAt":"2026-09-17T15:59:40.311Z","rotatedAt":null,
  "length":108,"kind":"claude_code_oauth_access_token"}]
```

The gateway discriminates on the segment after the prefix — `sk-ant-api…` goes upstream as an `x-api-key`,
**everything else** (including `sk-ant-oat…`) as a `Bearer` credential with Anthropic's OAuth beta
header. In **production, store an `sk-ant-api…` key** from the Anthropic Console: that is the
organization's billed credential, and a developer's personal subscription token is not one.

Rotation is a **new version of the same name** — `storeSecret` bumps `secrets.version`, `rotateSecret`
also stamps `rotated_at`. Readers take the highest version, so a new key is live on the **next model
call**, with no restart and no image. Previous versions stay readable until reaped; rotation is not
revocation of anything downstream (outstanding gbrain tokens are unaffected).

**How a rotation actually happens today.** The only shipped writer is the setup wizard's
`POST /api/wizard/provider` (admin), which stores the key **and** mirrors it into gbrain's file-plane
config — and it advances a brain's lifecycle, which only allows the same step or the next one. So on an
initialized deployment there is no console path that replaces the key: a production rotation is a
deliberate, host-side act against the `secrets` row, and the account owner should record who did it and
when.

When the credential expires or is revoked, every harness model call starts failing upstream (a `401
authentication_error`). The run ends as a failure — the exit code and the error frames decide, not the
agent's prose — the per-call rows carry the upstream HTTP status, and nothing retries: an
`agent_failed` run is never re-run (D11). Fix the key, then `POST /api/schedules/:id/run-now` if you
want the work redone now.

**This dev stack's credential is a rotating host secret, and the refresh is what revokes it.**
`~/.claude/.credentials.json` is rewritten whenever the machine's Claude Code refreshes its OAuth
token, and that refresh **invalidates the previous access token** — so the row stored here starts
answering `401 authentication_error` / `OAuth access token has been revoked.` with nothing changed in
this repository. Measured on 2026-09-18 (both halves of the same minute, so the contradiction is not a
stale reading): the file's token authenticated upstream directly — a `POST /v1/messages` with the
gateway's own auth shape (`Bearer` + `anthropic-beta: oauth-2025-04-20`) answered `200` — while the
stored row answered `401 OAuth access token has been revoked.`, and its `expiresAt` was 5.1 h out. A
rotation is therefore a **maintenance window, not a fix**: store the key, then run the work that needs
it immediately, and re-check the file's mtime and `expiresAt` before blaming the product for a fresh
401.

**The e2e family's own cycles can undo a rotation, so a rotation made before a suite run may not be
there when the money legs reach the gateway.** `restore.e2e.test.ts` drops and reloads the control
database from a backup, and the upgrade gate's rollback restores a volume snapshot; either can put back
a `secrets` generation that predates the rotation (measured: a version stored at 11:41:55 was gone from
the control DB after the next pass's cycle, and the money legs answered the same 401). Re-provision
**after** a cycle, not before it — the e2e file's own precondition message says the same thing
("nothing re-provisions that credential … after such a cycle"), and the value to store is the host's
current Claude Code token. Record who rotated it and when: both 2026-09-18 rotations were host-side
acts by agents working this slice, v1 → v2 at 16:41:55Z and again to a fresh version during the
verification passes, each storing the token out of `~/.claude/.credentials.json` with the value never
printed.

**Two budgets, two different piles of money (U9).** Our cap is per run:
`schedules.agent_budget_usd` → `agent_runs.budget_usd`, metered call by call in `agent_run_usage`,
checked **before** the gateway forwards and again **mid-stream**, so a single expensive request is
capped in flight rather than after it is paid for. Crossing it ends the run `budget_exceeded` and
raises an alert; it never silently truncates the agent's context and carries on. gbrain's own
`budget_usd_per_day` is a per-OAuth-client cap on **gbrain's** model calls, metered in gbrain's tables,
which this product neither reads nor writes. The Runs page labels ours and says explicitly that they
are not the same number.

## The three health states

`GET /api/health` carries — unauthenticated, three keys, never a token or a client id:

```json
"runner": { "state": "disabled" | "never_claimed" | "connected", "lastSeenAt": …, "version": … }
```

| State | Meaning |
|---|---|
| `disabled` | `RUNNER_TOKEN` is unset or whitespace. The lane is off — the configuration fact and the refusal are the same fact. |
| `never_claimed` | The lane is configured and **no runner has been seen in `RUNNER_SEEN_WINDOW_MS` (50 s)**: either none has ever polled, or the last one has stopped polling. A live lease also keeps the lane out of this state, so "no fourth word" still holds. |
| `connected` | A runner is there: seen within the window (a claim request that found nothing still counts — D2), or holding a live `agent_prompt` lease. **The only green state.** |

**"The runner is enabled" is not "the runner is connected."** The green word is earned by a **sighting**:
`runner_presence` gets a row on every `POST /api/runs/claim`, written before anything is claimed, so a
runner that is long-polling an empty queue is `connected` — and a runner that stopped polling falls back
to `never_claimed` 50 s later. Read `lastSeenAt` with the state: `null` means literally never, a
timestamp means a runner was here and is not any more. Measured live on this stack (runner container
stopped and restarted by hand, `RUNNER_TOKEN` set throughout):

```
15:26:23  {"state":"connected",    "lastSeenAt":"2026-09-18T15:26:23.599Z","version":"2.1.274"}   # polling
15:26:37  {"state":"connected",    "lastSeenAt":"2026-09-18T15:26:23.599Z","version":"2.1.274"}   # stopped, inside the window
15:27:40  {"state":"never_claimed","lastSeenAt":"2026-09-18T15:26:23.599Z","version":"2.1.274"}   # window lapsed
15:27:49  {"state":"connected",    "lastSeenAt":"2026-09-18T15:27:49.629Z","version":"2.1.274"}   # restarted, first poll
```

The third reading is the one to read twice: it is the same lane, the same `lastSeenAt` column, and only
the state moved — because the window is the only thing that lapsed.

`version` is the harness version the last-seen runner reported **in the request that recorded it**
(D4's `harnessVersion`), and it is `null` only when no runner has ever been seen. It is the last
sighting's version, not a claim about the build running right now: a runner that upgrades and polls
again replaces it. No runner id is projected — the row is keyed by one, and `/api/health` carries no
client id of any kind.

### Alerts this lane raises

Read them on `/schedules` (or `GET /api/schedule-alerts`) — the console is the **only** place to
acknowledge one. `GET /api/health` carries unacknowledged **kinds only**, never `detail`, because it is
reachable without a session.

| Kind | Meaning | What to do |
|---|---|---|
| `lease_expired` | A runner died mid-run; the run is `infra_failed` and its gbrain token was revoked by the reclaimer. | Read the run, decide whether the work needs redoing (it is not retried for you). |
| `agent_run_failed` | The harness exited non-zero, or its stream carried error frames. | Read the run's events and exit code; a retry is not automatic and would ask the same agent the same question. |
| `agent_budget_exceeded` | The run crossed its per-run cap (before forwarding, or mid-stream); the run ends. | Raise the schedule's `agentBudgetUsd` deliberately, or make the prompt cheaper. It is never retried. |
| `agent_read_space_moved` | A **read** Space's HEAD moved during a run. Org-level, and never a diff row. | Read isolation broke: find out what else writes there (a sync, another writer) before trusting the run's inputs. |
| `harness_pin_mismatch` | A runner refused a claim because its own binary's version is not the schedule's pin. Org-level. | Rebuild or pull the runner image at the pin. Never edit the schedule. |

### `runner_never_seen`, and the three words around it

Three related names, three different surfaces — do not read one as another:

- The **health state** is `never_claimed`. That is what you look at.
- The **refusal you get** when you try to create an `agent_prompt` schedule with no runner seen is
  `409 runner_not_enabled`, and its body carries `state` and `lastSeenAt` plus a detail that names the
  fix. Measured live on this stack, 63 s after the runner container was stopped by hand (the window had
  just lapsed, and the detail names the window — it never claims nothing has *ever* claimed a run,
  which was false about a runner that is merely slow to poll):

  ```
  POST /api/schedules {"name":"d2-never-claimed-probe","connectionId":"…","preset":"nightly-agent-briefing"}
  -> 409 {"error":"runner_not_enabled","state":"never_claimed","lastSeenAt":"2026-09-18T15:26:23.599Z",
          "detail":"No agent runner has been seen: no claim request has reached the control plane in the
                    last 50s (lastSeenAt is when one last did). Start the runner
                    (docker compose --profile runner up -d agent-runner) and try again — a runner that
                    is polling is accepted here."}
  schedule row created? False
  ```

  With the same container **running**, the same body is accepted (`201`): the create gate asks whether a
  runner has been seen, and a long poll with an empty queue is a sighting.

- The **claim refusal code** `runner_never_seen` means something narrower: a claim arrived **without a
  runner id**, so no run was claimed and none was consumed. That is a runner bug, not an operator
  condition. And the **alert kind** `runner_never_seen` is registered in the console's kind table for a
  deployment-level "an agent schedule exists and no runner ever claimed" case; no product writer raises
  it yet, so do not go looking for it in `/schedules`.

So: a schedule that refuses to be created means **start the runner**, and the refusal already tells you
how. A lane that reads `never_claimed` after it ran work yesterday means the runner is not connected
**right now** — check `logs --tail 100 agent-runner` and `ps agent-runner` before assuming the work is
lost.

One more alert belongs here: **`harness_pin_mismatch`** (org-level). A runner refused a claim because
the version its own binary reports is not the version the schedule is pinned to. The fix is to rebuild
or pull the runner image at the pin (`HARNESS_VERSION`), never to edit the schedule. Both the refusal
and the alert are visible on this stack right now — the runner's log names the mismatch, and Gate B
produced one deliberately:

```
[runner] claim refused: harness_pin_mismatch — schedule gate-b-pin-mu5tzqf4 pins harness
         0.0.0-gate-b-mu5tzqf4 but the claiming runner reports 2.1.274: the run was refused rather
         than run on an unknown binary
[gate-b] B1 claimed_by=bdf52ea983e9-461f92f8 scheduler=d77272312df2-bf116fa8 run=3b534d73-…
         state=failed classification=refused reason=harness_pin_mismatch
```

## Quiesce and upgrades

The runner is **never a path to an upgrade** (G5), and the upgrade lane treats it as one more writer:

- **It stops first.** `QUIESCE_ORDER` is `agent-runner → scheduler → gbrain-worker → control-plane →
  gbrain-serve → gbrain-ops`: the runner is the one consumer that keeps writing to the brain after the
  scheduler stops materializing, so it drains before everything else and Postgres is left alone.
- **Its grace is a teardown, not a run** (60 s, matching its own `stop_grace_period`). Preflight
  refuses the upgrade while any run row is `running`, so nothing here waits a run out — the in-flight
  harness is SIGTERMed and its token revoked through the control plane, which is still up because the
  runner is first in the order.
- **The lane is derived from the real compose profile model.** Quiesce asks `config --services` (the
  active profile model — what a resume may start) and `ps -a --services` (containers that exist,
  whatever the profile says). So a runner-less deployment still quiesces correctly, `stop` of a
  profile-gated service exits 0, and **`resume` never switches the runner on** — `up -d --no-deps`
  would, so anything not in the active model is excluded. If the project cannot be rendered at all, the
  drain stops everything and the restore still starts nothing profile-gated.
- **A gbrain pin move does not touch it.** `SWAP_SERVICES` does not gain the runner: its image carries
  no gbrain binary, so it is not rebuilt by an upgrade.
- **The three agent tables join `UNCOUNTED_TABLES`** (`agent_runs`, `agent_run_events`,
  `agent_run_usage`) so the rollback digest-parity gate is not tripped by rows the rollback restores.

The plain-English consequence: enabling the runner does not make the deployment harder to upgrade, and
disabling it does not change how quiesce runs.

## What NOT to do

- **Never enable Bash.** Bash is a distinct, higher-trust job class that this slice deliberately does
  not implement, and `schedules` refuses to store it: there is no column, no field and no pass-through
  for a tool allowlist, a permission mode or a shell, so a payload carrying one dies as an **unknown
  field** before it can become a row. Measured (C11, and F3's probe before it): a prompt that asks for
  Bash produces **no `tool_use` at all** and `permission_denials: []`, because `--tools ""` removes the
  built-in surface at the source — the model cannot call a tool it was never offered. There is no
  denied-tool event to look for; the evidence that the request died is the empty tool surface, the
  empty diff and an unmoved head.
- **Never treat the tool flags as the fence.** `--allowedTools` / `--disallowedTools` are defence in
  depth; the fence is `runner-net` being `internal: true`. Never attach the runner to a second network,
  and never add a Caddy route for `/api/runs/*` or `/api/gateway/*` — those two surfaces are
  internal-only by design.
- **Never mount the Docker socket** into anything that touches agent output. The runner is dispatched
  by long-poll; nothing in this lane shells out to `docker`.
- **Never give the runner a database URL** (brain or control), `GBRAIN_HOME`, `OPS_RPC_TOKEN`,
  `ENCRYPTION_KEY`, or a provider key. Its only credentials are `RUNNER_TOKEN` and the per-run gbrain
  token.
- **Never add a `ports:` entry to the runner**, and never mount a volume into it (`volumes: []`, ever).
  Its workspace is a fresh directory under the `/tmp` tmpfs, created per run and destroyed on every
  exit path. Caddy is the only service publishing host ports.
- **Never `--no-deps` the runner up.** The dev CA export must run first; skipping it fails the mount
  loudly (see *Enable, by hand*).
- **Never `git add .env`.** It holds `RUNNER_TOKEN`, `OPS_RPC_TOKEN`, `ENCRYPTION_KEY`,
  `BETTER_AUTH_SECRET` and the Postgres password.
- **Never widen or re-pin the harness by hand.** `HARNESS_VERSION` is an exact version, and
  `lint:forbidden`'s `moving-harness-pin` / `shell-string-harness` rules fail the build on a moving
  reference or a shelled-out invocation.
- **Never run `gbrain upgrade` or `gbrain autopilot` from the runner** — there is no gbrain in that
  image, and an agent run is never a path to an upgrade, a schema change, a grant, a secret read or a
  compose operation.
- **Never edit a schedule's harness version to make a claim succeed.** Fix the image.
- **Never read the agent's closing message as the run's status**, and never read a `costUsd` of `null`
  as zero.
- **Never revoke a Connection as a way to pause agent runs.** That disables its schedules and raises a
  `connection_revoked` alert, and a run whose Connection is inactive refuses rather than running.
- **Never `docker compose down -v` to "clean up" an agent run.** The populated brain is the expensive
  fixture; revert is the way back, and it is a new commit, not a wipe.

## Provenance

Run on the live dev stack (`brainstand-*-1`, gbrain `0.50.5.0`, `DOMAIN=localhost`, runner lane
enabled) on **2026-09-17**, by the agent that wrote this file. Executed here:

- the compose profile renderings — `config --services`, `config --profiles`, the `--profile runner`
  variants in both the dev and the production file set, and `ps -a --format`;
- the CA-export trap, twice over: a throwaway project (`runbookprobe`) for
  `up -d --no-deps agent-runner` (exit 1, then `down -v` and the leftover volume removed) and a
  throwaway empty volume for the bare `volume-subpath` mount failure;
- `docker run … ls -l` against `brainstand_runner-ca` to read the exported file's mode and size;
- the `RUNNER_TOKEN` interpolation check — `config --format json` with and without an empty child-env
  override, printing only empty/non-empty and lengths, never a value;
- the internal claim probes from inside `control-plane` (empty bearer, absent header, bogus bearer);
- the `secrets` shape probe (name, version, timestamps, length and shape classification only — the
  value was never read out);
- the read-only `psql` queries against `control` (both parse and run; 0 rows at the time);
- `curl https://localhost/api/health` (exact form above), `GET /api/runs`, `GET /api/runs/:id`,
  `POST /api/runs/:id/revert` with an admin session and without any session, and the guarded
  create-`agent_prompt` probe (which refused, and created no row);
- `logs --tail 100 agent-runner` and `ps -a agent-runner`, which produced every `[runner]` line quoted
  above, including the SIGTERM drain, the `Unable to connect` claim failure and the pin refusal.

**Not executed here, and why.** The disable/enable sequence (`stop agent-runner`; an empty
`RUNNER_TOKEN`; `up -d --force-recreate control-plane`) — Gate B is running it as its B10 leg and Gate
C covers it again, and two agents toggling the lane at once would make both flaky and prove nothing;
the `503 runner_disabled`, `disabled`/`connected` health readings, the create-while-disabled refusal,
the 25 s long-poll timeout and the pin-mismatch leg quoted above are therefore **Gate B's**
measurements (B10/B11/B12/B1, and its `run1.txt`), attributed as such. Also not executed: the
`/dev/urandom` generator line (`scripts/install.sh`'s own; this Windows shell has no `/dev/urandom`),
and the runner's own startup refusal without `RUNNER_TOKEN`, which is read from `src/runner/main.ts`
rather than exercised — starting the container to watch it refuse would toggle the lane.

**Extended 2026-09-18, and by whom.** *The three health states*, the sighting-window blockquote and the
refusal text under *`runner_never_seen`* were measured on this stack on **2026-09-18** by the agent that
changed the gate (F19) — those readings are the ones quoted there, not re-run by the file's original
author. *Getting in* is **F18's** measurement by the agent that built the sign-in page, quoted from the
live bundle in a fresh browser profile. This pass (the slice-4 close-out re-verification, 2026-09-18)
folded both into [`docs/slice-4-findings.md`](../slice-4-findings.md) as F18/F19 and did **not** re-drive
the browser or re-toggle the lane.

The run detail and the revert refusal were captured against the control DB generation that existed at
that moment; the gates cycle the stack, so a fresh `/api/runs` is empty until something runs again.
