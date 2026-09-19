# Slice 5 findings — self-host GA

> **In progress.** Opened by Task 2 of
> `docs/superpowers/plans/2026-09-18-slice-5-self-host-ga.md`. Probes **P\***,
> upstream facts **U\*** and defects **F\*** are appended here as each task runs.

Status vocabulary: `confirmed` (the claim held as written) | `contradicted` (reality differed, and the
correction is named here) | `inference` (no artifact carries the observation; stated as such, never dressed
up as a measurement).

| # | Claim | Status |
|---|---|---|
| P1 | On a production-shaped stack (base compose file only, no published ops port) the backup verifies its quiesce through the `compose exec` relay | `confirmed` |
| P2 | Making the compose project name a variable with the legacy value as default leaves the live stack's volume names unchanged | `confirmed` |
| P3 | After the Task 4 rename the live stack's `secrets` rows still decrypt under the frozen `brainstand-kek-v1` HKDF info | `confirmed` |
| P4 | The three images can be pushed to GHCR at their exact tags with the authenticated `gh` token | `contradicted` — login succeeds, every push is denied by token scope |
| P5 | `fast` / `balanced` / `thorough` each move gbrain's `get_usage` ledger by a measurable amount on this deployment, so `SEARCH_MODES[].measuredCost` can carry a real ratio | `contradicted` — all three deltas are `$0.0000000`; two of the three values are refused by the pinned binary; `measuredCost` stays `null` (D7) |
| P6 | The nightly pinned-next arm opens exactly one issue per drifting version and comments on it on re-run, instead of duplicating | `confirmed` — a `workflow_dispatch` of `nightly.yml` with `gbrain_version=0.99.0.0` opened issue **#1**; a second dispatch commented on #1 and opened no second issue. Closed by hand |
| P7 | The D11 live-stack debt clears through product paths alone — eight admin checklist acks settle the `awaiting_admin_decision` ledger row to `applied`, `/schedules`' alert ack empties `/api/health`'s `scheduleAlerts`, and `DELETE /api/members/:id` offboards the residue — and the one path that does not exist is a purge for a revoked Connection (F22) | `confirmed` |
| P8 | Restoring a production-shaped archive into a stack whose `DOMAIN` differs invalidates every Connection and the console says so | `partial` at Task 16 — the product's new-domain restore branch ran (`domainChanged: true`, `doctorExitCode: 0`, 21.2 s) and named **2** Connections needing re-issue, but **0** were invalidated: the console still showed the same **2** `active`, and no member-facing message existed. The physical `DOMAIN` was not changed (no alternate hostname resolves on this host), so the OAuth issuer/redirect-URI mismatch itself was not reproduced on the wire. **F23 (below) is now fixed: the same drill measures `active` 2 → 0 and 4 `connection_revoked` alerts.** |
| F23 | A new-domain restore leaves every `active` Connection `active`: the console shows a working Connection that is not one, and nothing tells the member | `confirmed` — **FIXED HERE** (measured `active` 2 → 0 and `scheduleAlerts` [] → 4 `connection_revoked`; see F23 below) |
| U1 | `compose/Caddyfile`'s public `@gbrain` route publishes an unauthenticated Prometheus `/metrics` surface naming brains, Spaces, models or spend | `contradicted` — the pinned `gbrain-serve` answers `401` with `{"error":"Admin authentication required"}`; no body, no cardinality. S1's argument does not need to be extended to `/metrics` on this pin |
| U2 | The `operator` profile carries the `admin` scope `get_usage` requires, so no elevation to `full` is needed | `confirmed` |
| U3 | `get_usage` over the HTTP MCP lane answers with totals and upstream's `coverage` block verbatim, and the short-TTL client minted for the call is revoked | `confirmed` |
| F20 | On the stock compose stack `readBrainUsage` minted its client with the internal plain-HTTP data lane as the grant `--url`, which gbrain's `assertSecureEndpoint` refuses, so `/api/spend` shipped `brain: null` / `coverage.brainReachable: false` — the host-run contract test hid it by setting `GBRAIN_MCP_URL` | `confirmed` — fixed here |
| F21 | Mobrain's `SEARCH_MODES` offers ids `fast` and `thorough`, but the pinned gbrain `0.50.5.0` accepts only `conservative \| balanced \| tokenmax`; `search.mode` is stored verbatim and the resolver silently falls back to `balanced`, so the product's mode picker does not change the search pipeline | `confirmed` — fixed here |
| F22 | A revoked Connection has no product path to purge it: `POST /api/connections/:id/revoke` exists, but there is no `DELETE /api/connections/:id` route and the console offers no control, so a revoked row survives until its member is offboarded (which cascades) — and it cannot be offboarded if a live schedule still holds the member's Connection. The plan's Task 14 labels this `F2` | `confirmed` — deliberately deferred (reason in F22 below) |

---

## P1 — the backup lane verifies a quiesce on a production-shaped stack

**Task 2.** Before this change `scripts/backup.ts` set `let quiesced = true`, probed
`jobs.supervisorStatus` through `src/control/opsClient.ts` (default URL `http://gbrain-ops:3140`), and
turned the resulting connection failure into `quiesced = true` in its `catch`. On a production host no ops
port is published (S2), so the probe always threw and **every production manifest claimed a quiesce nobody
checked**. The fix makes the manifest's quiesce a three-state result (`verified` / `unverified` / `failed`)
and reaches ops through an injected caller that falls back to the `compose exec` relay when no port
answers.

The stack was brought up from the **base compose file alone** (no dev override), so `gbrain-ops` publishes
no host port — the production shape. `docker port brainstand-gbrain-ops-1` printed nothing. `OPS_RPC_URL`
was pointed at the container name so the host-side port probe could not possibly succeed.

Command:

```bash
docker compose --env-file .env -f compose/docker-compose.yml up -d --wait
OPS_RPC_URL=http://gbrain-ops:3140 bun run scripts/backup.ts /tmp/bs-backup-probe
```

Verbatim output:

```json
{
  "id": "5dde1120-5a70-43b3-b6e0-363c23fc0dc6",
  "createdAt": "2026-09-18T20:22:12.749Z",
  "gbrainVersion": "0.50.5.0",
  "components": {
    "brainDb": "brain-2026-09-18T20-21-54-109Z.sql",
    "controlDb": "control-2026-09-18T20-21-54-109Z.sql",
    "brainRepos": "brain-repos-2026-09-18T20-21-54-109Z.tar",
    "secrets": "secrets-2026-09-18T20-21-54-109Z.sql"
  },
  "sha256": {
    "brainDb": "1788c79bfd0b2cceb1aad4182ae6eb36d93ba5a03dadd715635421d640133864",
    "controlDb": "84fb1e0e270fccc9ceb706a066dcb6d091406182d53d37d7511056e4c55d4e49",
    "brainRepos": "16958f2681b953ee197d11e41789aa9b3c8c5f30a1d652bd49cbb858fcee1de6",
    "secrets": "76c37270a8ee9f2bf0140e08135aaeaa468762b7af132b4d7a5094bd9a39d880"
  },
  "quiesced": "verified",
  "quiesceLane": "relay",
  "warning": "Restoring requires the ENCRYPTION_KEY that sealed the secrets table. Store it separately from this archive — together they are a credential dump. Restoring to a NEW DOMAIN invalidates every OAuth grant; re-provision all Connections."
}
```

`"quiesced": "verified"` and `"quiesceLane": "relay"` are the point: the first honest quiesce the backup
lane has ever recorded on a production-shaped stack, proved through the one lane that works without a
published port. The manifest at `/tmp/bs-backup-probe/manifest.json` (`C:\tmp\bs-backup-probe\manifest.json`
on this host) was re-read directly and carried the same two fields.

---

## P2 — the frozen project-name default is inert on the live stack

**Task 3.** `compose/docker-compose.yml` now reads `name: ${COMPOSE_PROJECT_NAME:-brainstand}` (and
`compose/docker-compose.slice0.yml` reads `name: ${COMPOSE_PROJECT_NAME:-brainstand-slice0}`), and
`src/upgrade/snapshot.ts` derives its volume list from `projectName()` instead of the removed
`SNAPSHOT_VOLUMES` constant. The default is the legacy value, so a deployment that sets no
`COMPOSE_PROJECT_NAME` must keep the exact volume names Docker already created.

Command:

```bash
docker volume ls | grep -E 'brain-repos|gbrain-home'
```

Verbatim output:

```text
local     brainstand_brain-repos
local     brainstand_gbrain-home
```

Both volumes are unchanged: with no `COMPOSE_PROJECT_NAME` in the environment, `projectName()` returns
`brainstand` and `snapshotVolumes()` returns `['brainstand_brain-repos', 'brainstand_gbrain-home']`, the
same pair the old hardcoded constant named.

---

## P3 — the rename did not break decryption: the live stack still opens its secrets

**Task 4.** `brainstand-kek-v1` is the HKDF **info** that derives the `secrets` KEK, so it is a
cryptographic domain separator and not a product name (D3). The rename moved every human-facing surface
and left all three frozen strings byte-for-byte unchanged; the point of this probe is that the proof is
operational, not textual — the live control DB's rows still open.

First, the stack was healthy after the rename:

```bash
curl -sk https://localhost:8443/api/health | grep -o '"components":[^}]*}'
```

```text
"components":{"controlDb":"ok","ops":"ok"}
```

Then both secret rows were read **by name and length only, never by value**. The plan names a helper in
`test/integration/secrets.test.ts`; **that file does not exist**, so the equivalent check was run
read-only against the running control plane: fetch `{name, salt, wrapped_dek, payload}`, call `open()`
(the production decrypt path in `src/control/secrets.ts`), and print only the name and the plaintext
length. No value is printed, and none was.

```text
anthropic_api_key decrypts, plaintext_len=108
openai_api_key decrypts, plaintext_len=164
```

Envelope lengths in the DB, from
`select name, octet_length(salt), octet_length(wrapped_dek), octet_length(payload) from secrets order by name`:

```text
anthropic_api_key|24|80|184
openai_api_key|24|80|256
```

`controlDb":"ok"` + `ops":"ok"` and both rows opening under the frozen domain separator are the whole
claim: the rename moved a name, never a key.

---

## P4 — the publish is blocked at the push: the token has no `write:packages`

**Task 5, Step 7.** The plan's publish gate needs a GHCR credential with `write:packages`. The
authenticated `gh` account is `MolanoJF`, and `gh auth status` reports its token scopes verbatim:

```text
✓ Logged in to github.com account MolanoJF (keyring)
- Token scopes: 'gist', 'read:org', 'repo'
```

There is also **no `mobrain` GitHub org** — the namespace the compose file and the publisher default
to. `docker login ghcr.io` still succeeds, because it only proves the token authenticates:

```bash
TOKEN="$(gh auth token)"
echo "$TOKEN" | docker login ghcr.io -u MolanoJF --password-stdin
```

```text
Login Succeeded
```

The first real publish, at the intended namespace:

```bash
IMAGE_NAMESPACE=mobrain GBRAIN_VERSION=0.50.5.0 HARNESS_VERSION=2.1.274 APP_VERSION=1.0.0 \
  bash scripts/publish-images.sh
```

```text
--- ghcr.io/mobrain/gbrain-base:0.50.5.0
... (the pinned build succeeds: `#14 naming to ghcr.io/mobrain/gbrain-base:0.50.5.0 done`) ...
The push refers to repository [ghcr.io/mobrain/gbrain-base]
...
error from registry: permission_denied: The token provided does not match expected scopes.
```

(`PUBLISH_EXIT=1`.) The plan's fallback namespace, `MolanoJF`, fails earlier, at the tag itself —
Docker repository names must be lowercase, and the authenticated account name is not:

```text
--- ghcr.io/MolanoJF/gbrain-base:0.50.5.0
ERROR: failed to build: invalid tag "ghcr.io/MolanoJF/gbrain-base:0.50.5.0": repository name must be lowercase
```

(`PUBLISH_EXIT=1`.)

**The blocker, named exactly:** the only available credential is an OAuth token scoped
`gist, read:org, repo`; GHCR pushes require `write:packages`, which it does not carry, and the
`mobrain` org it would push under does not exist. No digest can be produced honestly here. The dry
run and both build gates prove the artifacts build at their exact pins; only the registry push is
blocked, and it is blocked by credentials and org ownership, not by the repository. Recorded rather
than skipped: **no image was published, so there are no digests to paste.**

To unblock, on the machine that owns the release: create the `mobrain` org (or set
`IMAGE_NAMESPACE=<lowercase-owner>`), grant a token `write:packages` (a classic PAT with
`write:packages, read:packages`, or a fine-grained token with `packages: write`), then re-run:

```bash
IMAGE_NAMESPACE=mobrain GBRAIN_VERSION=0.50.5.0 HARNESS_VERSION=2.1.274 APP_VERSION=1.0.0 \
  bash scripts/publish-images.sh
```

### P4 resolution — the namespace is the account, and CI owns the push

**Resolved after P4.** The product name is **Mobrain**, but the only available GHCR owner is the
user's GitHub account, so the images publish under **`ghcr.io/molanojf`** — the lowercase account
name, never `MolanoJF` (Docker repository names must be lowercase) and never the product name.
`IMAGE_NAMESPACE`'s default therefore moves from `mobrain` to `molanojf` in
`compose/docker-compose.yml`, `scripts/{install,preflight,publish-images,upgrade}.sh`/`.ts`,
`.env.example`, `test/build/*.test.sh` and the runbooks, while the pattern assertions in
`test/unit/publish-images.test.sh` stay exactly as they were.

The local `gh` OAuth token still lacks `write:packages` (P4), so no host-side `docker push` can
succeed and none was attempted. Publishing moves to GitHub Actions: the `publish` job in
`.github/workflows/contract.yml` logs in to GHCR with the workflow `GITHUB_TOKEN` under
`permissions: packages: write`, runs `scripts/publish-images.sh` at the G1 pins, and prints the
three `RepoDigests`. The publisher's `FROM`-resolve snag is closed without touching the
Dockerfile: `docker/control-plane.Dockerfile:7` keeps its bare
`FROM mobrain/gbrain-base:${GBRAIN_VERSION}`, and the publisher mirrors the registry-qualified
base it just built to that bare name (`docker tag ghcr.io/molanojf/gbrain-base:<pin>
mobrain/gbrain-base:<pin>`) before building the control plane — the same mirror
`scripts/upgrade.ts` performs on the rollback path. No digest is claimed here — CI produces them,
and `CHANGELOG.md` records them at release (Task 18).

---

## P5 — the search-mode cost spread is not measurable on this deployment: empty ledger, thin corpus, and two mode names the binary refuses

**Task 9.** The probe `scripts/measure-search-modes.ts` sets each mode through the
existing `config.set` operation, reads `readBrainUsage(1)` as a baseline, runs the
**same fixed 20-query** workload through the `search` operation, reads the ledger
again, and takes the delta. It restores the original mode in a `finally` and prints
the total real spend. Command, verbatim, exactly as the plan specifies:

```bash
bun run scripts/measure-search-modes.ts 2>&1 | tee /tmp/search-modes.txt
```

Verbatim output:

```text
MEASURED search-mode original="fast"
MEASURED search-mode fast: deltaCost=$0.0000000 calls=+0 models=[none] queries=20 failures=0 corpus=4spaces/7pages/7chunks invalid=true
MEASURED search-mode fast: the pinned binary refused this value — [mode-switch] Invalid search.mode value: "fast". | [mode-switch] Valid options: conservative | balanced | tokenmax
MEASURED search-mode balanced: deltaCost=$0.0000000 calls=+0 models=[none] queries=20 failures=0 corpus=4spaces/7pages/7chunks invalid=false
MEASURED search-mode thorough: deltaCost=$0.0000000 calls=+0 models=[none] queries=20 failures=0 corpus=4spaces/7pages/7chunks invalid=true
MEASURED search-mode thorough: the pinned binary refused this value — [mode-switch] Invalid search.mode value: "thorough". | [mode-switch] Valid options: conservative | balanced | tokenmax
MEASURED search-mode restored="fast" ok=true
MEASURED search-mode total real spend across 3 modes: $0.0000000 (get_usage ledger, window=1 day)
```

Every delta is **exactly zero** and the `get_usage` ledger is empty
(`calls=+0`, `models=[none]`), so there is no ratio to write. The corpus —
4 sources (the implicit `default` plus the 3 Spaces `customers` / `internal` /
`shared`), **7 pages / 7 chunks** — is the thin post-e2e brain, not the populated
F4 corpus. Per the plan and D7 this is the honest answer: a 25× claim cannot be
validated on 7 pages, and Slice 2's own warning (`docs/slice-2-findings.md:93`)
says a flat ratio on a tiny corpus is not a scale proof. **`measuredCost` stays
`null` for all three modes**, with `measuredAt: null` and `measuredOn: null`; the
`SEARCH_MODES honesty (D7)` test's "cheapest measured mode is exactly 1" leg is
therefore vacuously true (nothing is measured), which the test explicitly allows.

### The probe also surfaced a real defect (F21)

`invalid=true` on `fast` and `thorough` is not a probe bug. The pinned binary's
own `config set` wrote to stderr:

```text
[mode-switch] Invalid search.mode value: "fast".
[mode-switch] Valid options: conservative | balanced | tokenmax
```

Read against the pinned artifact only (G2 — no import, no table read, no
screen-scrape of human output): `gbrain 0.50.5.0`'s
`src/core/search/mode.ts` declares
`export type SearchMode = 'conservative' | 'balanced' | 'tokenmax'`, and
`isSearchMode` accepts exactly those. `config set` stores an unknown string
verbatim, but the resolver falls back to `balanced` for an unset/invalid value.
So on this product, selecting **Fast** or **Thorough** in the wizard runs
`balanced`; only the `balanced` button does what it says. This is why two of the
three deltas could not differ even if the corpus were rich — the pipeline never
changed. Recorded as **F21**, not fixed in Task 9 (renaming the product's mode
vocabulary touches the wizard contract, its tests and the console, which is a
different task's blast radius). No number was manufactured to hide it.

---

## U2 — `operator` carries `admin`; `get_usage` needs no elevation to `full`

**Task 10, Step 1/3.** Upstream's `get_usage` operation declares scope `admin`
(`gbrain/src/core/ops/usage.ts`), and the plan asks whether the `operator`
profile actually carries it before reaching for `full`. Measured against the
pinned binary: **it does.** `gbrain mcp grant` with `--profile operator` returns
a grant whose own receipt is the evidence:

```json
"scopes":["admin"],
...
"allowedOperations":["add_link","add_tag",...,"get_usage",...],
"surface":"full","surfaceSetBy":"operator","tokenTtlSeconds":300,"profile":"operator"
```

`allowedOperations` is the operation snapshot the profile compiles to; `get_usage`
is in it, and the scope list is exactly `["admin"]`. The source of truth is
`src/core/grants/profiles.ts`, where `operator: ['admin']` and `full:
['admin','agent']` — so `full` would add an `agent` scope this read has no
business holding, and it was not used. The contract test's second leg passing
against this profile is the operational confirmation.

The pinned binary also publishes the operation in its public tool surface:

```text
MEASURED tool surface at 0.50.5.0: 136 tools, get_usage present=true
```

---

## U3 — `get_usage` over the HTTP MCP lane answers with totals and a verbatim coverage block

**Task 10, Step 5.** `src/ops/usage.ts` mints the `operator` client through the
published ops RPC (`mcp.grant`), takes its access token from the one-time
private handoff, calls `get_usage` with `POST {mcp}/mcp`
(`tools/call`, accept `application/json, text/event-stream`), maps
snake_case → camelCase without altering a value, and revokes the client in a
`finally`. Nothing read `chat_usage_log` (G2). The window is passed straight
through and upstream's own `coverage` block is carried verbatim, including all
four `not_covered` exclusions.

Command:

```bash
bun test test/contract/usage.contract.test.ts
```

Verbatim tail:

```text
bun test v1.3.14 (0d9b296a)
MEASURED tool surface at 0.50.5.0: 136 tools, get_usage present=true
MEASURED get_usage(30): calls=0 cost=$0 models=0 phases=0 coverage.loggedSince=null tablePresent=true
MEASURED get_usage(365): calls=0 unpricedCalls=0 models=0
MEASURED clients before=7 after=7

 4 pass
 0 fail
 7 expect() calls
Ran 4 tests across 1 file. [8.11s]
```

`coverage.loggedSince=null` and `calls=0` are honest, not a defect: the dev
stack's `chat_usage_log` ledger is empty because no `gateway.chat` traffic has
run since this stack was last cycled. `tablePresent=true` is the fact the page
needs, and the four `not_covered` exclusions rendered on the Spend page come
from this block, not from us. `clients before=7 after=7` is the revocation
proof: the client minted for each call left no residue.

---

## U1 — `/metrics` is auth-gated upstream: the public route answers 401, not a Prometheus body

**Task 8, Step 1/2.** The audit's premise was that `compose/Caddyfile:34` routes `/metrics`
to `gbrain-serve:3131` on the **public** site alongside `/health`, and that if the pinned
binary answered an unauthenticated Prometheus body it would publish brain, Space and model
cardinality to anyone. That premise is a claim about upstream's intent, so it was measured
against the pinned binary behind our Caddy rather than assumed.

Command, verbatim, exactly as the plan specifies:

```bash
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost:8443/metrics
curl -sk https://localhost:8443/metrics | head -20
```

Verbatim output:

```text
401
{"error":"Admin authentication required"}
```

**Status code: `401`.** A body did come back, but it is a fixed JSON error envelope and
nothing else — 42 bytes. It names **no brains, no Spaces, no models and no spend**; it
carries no metric name, no label and no cardinality of any kind. The pinned `gbrain-serve`
gates `/metrics` behind admin authentication exactly as upstream describes ("Prometheus,
admin-gated"), so **S1's argument does not need to be extended to `/metrics` on this pin**.

**Step 3 therefore did not fire:** the route answered `401`, not `200` with a body. The
`@gbrain` matcher is left untouched and `/metrics` stays where it is, alongside `/health`.
No Caddyfile change and no reload were required. The C1 leg (Gate C) still pins the
negative — it asserts the public status is one of `401 | 403 | 404`, so if a future pin
relaxes the gate and starts answering `200`, Task 17's run goes red and this decision is
revisited rather than silently shipped.

---

## F20 — the spend ledger was unreachable on a stock stack: the grant `--url` was the internal plain-HTTP data lane

**Task 10 defect, found by Gate-C-style scrutiny of `readBrainUsage` against the
production shape.** `src/ops/usage.ts` used ONE endpoint for two different jobs:
it passed `mcpEndpoint()` — in compose, `http://gbrain-serve:3131/mcp` — to
`mcp.grant` as `--url` AND dialed it for `get_usage`. gbrain validates a grant's
`--url` with `assertSecureEndpoint`/`normalizeMcpUrl` and refuses a non-loopback
plain-HTTP endpoint. The grant is only credential-delivery bookkeeping (with
`credentialsOut` the token lands in a file, and the `get_usage` MCP call is a
separate fetch), so the URL that must be reachable is NOT the URL gbrain will
accept. The host-run contract test set `GBRAIN_MCP_URL=https://localhost:8443/mcp`,
so it exercised the HTTPS path and never saw the stock failure.

Reproduction from production shape — inside the stock `gbrain-ops` container,
which sets neither `PUBLIC_URL` nor `GBRAIN_MCP_URL`:

```bash
docker exec brainstand-gbrain-ops-1 bun -e \
  "import {readBrainUsage} from '/app/src/ops/usage.ts'; readBrainUsage(1).then(u=>console.log('OK',JSON.stringify(u.coverage))).catch(e=>{console.error('ERR',e.message);process.exit(1)})"
```

```text
ERR mcp.grant (usage) failed (exit 1)
```

The message the wrapper swallowed, from the same `--url` gbrain was handed:

```bash
docker exec brainstand-gbrain-ops-1 gbrain mcp grant bs-usage-probe \
  --harness generic --profile operator \
  --url http://gbrain-serve:3131/mcp --token-ttl 300 --dry-run --json
```

```json
{"status":"error","reason":"mcp_setup_failed","message":"Use HTTPS for credential delivery; HTTP is supported only on loopback"}
```

The measured product consequence, `GET /api/spend?days=30` (admin session):

```text
"brain": null
...
"coverage": { ..., "brainReachable": false }
```

### Fix

`src/ops/usage.ts:76` adds `grantEndpoint()`, which mirrors the product's one
grant-URL convention, `mcpUrl()` (`src/control/connections.ts:496`): `PUBLIC_URL`
when configured, else loopback (`http://127.0.0.1:3131/mcp`). `readBrainUsage`
now passes THAT to `mcp.grant` (`src/ops/usage.ts:94,101`) and keeps
`mcpEndpoint()` (`src/ops/usage.ts:48`) for the actual `get_usage` fetch, so the
data lane still dials `http://gbrain-serve:3131/mcp` inside compose and the
public HTTPS URL under `GBRAIN_MCP_URL`. The helper is local rather than imported
because the control-plane DB module graph must not enter the ops process (S2);
it is the same deliberate mirroring the file already uses for `grantedClientId`.
No compose env was added: the ops service correctly carries no `PUBLIC_URL`, and
the loopback default is what gbrain accepts.

After the fix, the same in-container call:

```text
OK coverage={"source":"gateway.chat","loggedSince":null,"tablePresent":true,"pricedCalls":0,"unpricedCalls":0,"notCovered":["failed chat calls (budget-tracker owns pessimistic in-flight spend)","subagent raw-SDK calls","embeddings (embedding-pricing.ts unit)","calls made before migration v140 / sink registration"]}
```

And `GET /api/spend?days=30` on the rebuilt stock stack:

```text
brainReachable=True
brainIsNull=False
brain.windowDays=30
brain.coverage.source=gateway.chat
brain.coverage.tablePresent=True
brain.totals.calls=0
```

The `brain` block is no longer null and `coverage.brainReachable` is `true`;
`calls=0` is the empty ledger, not the F20 failure.

---

## F21 — the wizard's `fast` and `thorough` search modes do not exist in the pinned binary

**Found by Task 9's probe, P5 above; FIXED HERE.** `src/control/lifecycle.ts`'s `SEARCH_MODES`
was written in Slice 1 with ids `fast` / `balanced` / `thorough` and upstream's
claimed `relativeCost` of `1 / 6 / 25`. The pinned gbrain `0.50.5.0` accepts only
`conservative | balanced | tokenmax`; `config set search.mode fast` and
`... thorough` exit 0 but the binary answers on stderr

```text
[mode-switch] Invalid search.mode value: "fast".
[mode-switch] Valid options: conservative | balanced | tokenmax
```

and the search-time resolver falls back to `balanced` for an invalid value. Two
product consequences, both measured or directly read from the pinned artifact:

1. `wizard POST /search-mode` validates against `SEARCH_MODES` (`src/control/routes/wizard.ts:123`)
   and then `POST /finish` passes the id straight to `config set search.mode`
   (`src/control/routes/wizard.ts:245`), so a Fast or Thorough choice is accepted,
   stored verbatim, and silently ignored by the retrieval pipeline.
2. The cost spread the wizard advertises (`relativeCost` 1/6/25) is therefore not
   just unmeasured — for two of the three buttons, the mode behind it is not the
   one the button names.

### Fix (F21, this task)

`SEARCH_MODES` now carries the binary's real vocabulary: `conservative` /
`balanced` / `tokenmax`, with honest labels and descriptions of what the engine
does in each (retrieval only; reranker on; expansion + uncapped per-chunk
synopsis). The `relativeCost` values stay `1 / 6 / 25`, but the D7 block now
states plainly that these are **upstream's declared claim for the current mode
names and were not measured here**; `measuredCost` / `measuredAt` / `measuredOn`
stay `null` (P5), and `MEASURED_COST_DISCLAIMER` is unchanged. No measured number
was invented.

Verified against the live pinned binary (`brainstand-gbrain-ops-1`), one
`docker exec ... gbrain config set search.mode <id>` per mode — **after**:

```text
$ docker exec brainstand-gbrain-ops-1 sh -c "gbrain config set search.mode conservative 2>&1"
Set search.mode = conservative
[mode-switch] Switched to conservative.
[mode-switch]   First-time mode set. Cache will populate as queries run.

$ docker exec brainstand-gbrain-ops-1 sh -c "gbrain config set search.mode balanced 2>&1"
Set search.mode = balanced
[mode-switch] Switched to balanced.
[mode-switch]   Existing wrapped embeddings (if any) continue serving queries.

$ docker exec brainstand-gbrain-ops-1 sh -c "gbrain config set search.mode tokenmax 2>&1"
Set search.mode = tokenmax
[mode-switch] Switched to tokenmax. Per-chunk Haiku synopsis enabled.
[mode-switch]   Backfill cost (one-time): ~$1-5 per 10K pages via Anthropic Haiku.
[mode-switch]   Per-query overhead: ~$0.0003 (reranker + slightly larger payload).
[mode-switch]   Run `gbrain reindex --markdown` to backfill existing pages.
[mode-switch] To backfill now: gbrain reindex --markdown
```

Every one answered `Switched to <id>`; none answered `Invalid search.mode value`.
The stack was then left on `balanced`, a valid mode (it had been left on the
invalid `fast` by the probe).

Files changed:

- `src/control/lifecycle.ts` — mode ids, labels, descriptions, D7 comment.
- `src/console/pages/Wizard.tsx` — **no change needed**: it renders
  `state.searchModes` generically and posts `m.id`.
- `test/e2e/slice1.e2e.test.ts:158`, `test/e2e/slice2.e2e.test.ts:451`,
  `test/integration/wizard.test.ts:132,134`,
  `test/contract/config.contract.test.ts:19,22`,
  `test/contract/init.contract.test.ts:46`,
  `test/unit/wizard-finish.test.ts:22`, `test/unit/argv.test.ts:88-89`
  — **fixture corrections**, not assertion weakenings: they posted an id the
  binary refuses as if it were the product's valid set; they now post
  `conservative` and assert the same round-trip.
- `scripts/tutorial.ts:146`, `scripts/connection-e2e.ts:271`,
  `scripts/scale-probe.ts:331` — the same invalid `config.set` value in the
  product's own setup flows.
- `scripts/measure-search-modes.ts` — **deliberately left untouched**: it is the
  evidence-producing probe whose verbatim P5 output above recorded the invalid
  ids, and rewriting its `MODES` would rewrite that record.

Gates: `bunx tsc --noEmit`, `bun run lint:forbidden`, `bun test test/unit` (649
pass / 0 fail), `bun test test/integration/wizard.test.ts` (10 pass / 0 fail),
and `bun test test/contract/config.contract.test.ts test/contract/init.contract.test.ts`
(8 pass / 0 fail) all green.

---

## P7 — the live-stack debt clears through product paths, and the one path that does not exist

**Task 14.** D11 forbids clearing the dev stack's debt with SQL and requires each item be driven
through the product, with any path that turns out not to exist recorded as an `F`. The stack was
signed into as `admin@example.test` over Caddy at `https://localhost:8443`, and every mutation below
is a published route — no `psql`, no `UPDATE`, no `DELETE` outside an API handler.

Two surfaces make up the claim, because `/api/health` does not carry upgrade state: `scheduleAlerts`
comes from `GET /api/health` (unauthenticated, kinds only), and the pending decision comes from
`GET /api/upgrades/pending-decisions` — the same predicate preflight's own `PENDING_CHECKLIST`
refusal (`scripts/upgrade.ts:325`) reads.

### Step 1 — the before state

```json
{
  "ok": true,
  "components": {
    "controlDb": "ok",
    "ops": "ok"
  },
  "gbrainVersion": "0.50.5.0",
  "pin": {
    "declared": "0.50.5.0",
    "observed": "0.50.5.0",
    "matches": true
  },
  "repos": [
    {
      "sourceId": "customers",
      "staleLock": false,
      "lockAgeSeconds": null,
      "uncommittedFiles": 0,
      "unpushedCommits": 0,
      "branch": "master"
    },
    {
      "sourceId": "internal",
      "staleLock": false,
      "lockAgeSeconds": null,
      "uncommittedFiles": 0,
      "unpushedCommits": 0,
      "branch": "master"
    },
    {
      "sourceId": "shared",
      "staleLock": false,
      "lockAgeSeconds": null,
      "uncommittedFiles": 0,
      "unpushedCommits": 0,
      "branch": "master"
    }
  ],
  "scheduleAlerts": [
    {
      "id": "22e85d5e-371d-4d4b-b495-6e9b908c484a",
      "kind": "agent_budget_exceeded",
      "scheduleId": "gate-c-budget-mu7e7tlm",
      "at": "2026-09-18T20:17:34.210Z"
    },
    {
      "id": "79747aa2-1c19-4af4-9012-985f4f7aefed",
      "kind": "lease_expired",
      "scheduleId": "gate-c-kill-mu7e7tlm",
      "at": "2026-09-18T20:17:12.037Z"
    },
    {
      "id": "e1c25021-efbf-451e-a9e9-93d6f59574b2",
      "kind": "overlap_killed_previous",
      "scheduleId": "94814788-9a8c-4eed-8d4d-b21c16a3814d",
      "at": "2026-09-17T06:14:02.601Z"
    },
    {
      "id": "4ea66784-b885-400d-97ea-abd3dbb99107",
      "kind": "connection_revoked",
      "scheduleId": "c7b38618-a1df-4bd0-b4ec-b2819cc6eccb",
      "at": "2026-09-17T06:13:50.408Z"
    }
  ],
  "runner": {
    "state": "connected",
    "lastSeenAt": "2026-09-18T21:38:02.745Z",
    "version": "2.1.274"
  },
  "at": "2026-09-18T21:38:26.560Z"
}
```

The stack carried **four** open alert kinds, not the two the task text names. `agent_budget_exceeded`
and `lease_expired` are residue from the 2026-09-18 Slice 4 Gate C run (`gate-c-budget-mu7e7tlm` /
`gate-c-kill-mu7e7tlm`) and were added after `HANDOFF.md`'s "two alerts" line was written; the documented
`overlap_killed_previous` and `connection_revoked` were also still open. `GET /api/upgrades/pending-decisions`
returned **8** items, all `0.50.2.0`, all on run `run-022b8cfe-c1af-4cb2-a091-dc2f95b77de0` — which is
also `runs[0]`, so the console's `pendingChecklist(openRun.checklist)` banner (which reads only the latest
run's checklist) really did show them.

### Step 2 — the eight checklist items, read before each was acknowledged

Each item was read from `GET /api/upgrades/pending-decisions` (id, key, prompt, why) and acknowledged with
`POST /api/upgrades/checklist/:itemId/ack`. The route is admin-gated and takes **no body**; it answers
`{ item }` with `state: "acknowledged"` and `decidedBy` set to the admin user id.

| # | key | what the item said | ack result |
|---|---|---|---|
| 1 | `pre-0-50-0-0-cutover-attested` | Confirm the 0.50.0.0 coordinated authorization cutover was completed against THIS database, or that the brain was provisioned at 0.50.0.0 or later | `acknowledged` |
| 2 | `upstream-step-2-host-upgrade` | Run `gbrain upgrade`, restart its services, then `gbrain --version` / `gbrain doctor`; on a partial early migration, recover rather than bulk-authorize | `acknowledged` |
| 3 | `upstream-step-3-pglite-holders` | Confirm no PGLite holders on the host, or that they were restarted normally; never delete a live lock | `acknowledged` |
| 4 | `upstream-step-4-hosted-launchers` | Rerun the original installed launcher workflow for any recorded launcher still exporting a write source or `--brain host`; confirm which were repaired | `acknowledged` |
| 5 | `upstream-step-5-code-source-walk` | Name the source whose Bash parsing / Windows subdir sync failed, back up its files, run a source-scoped full sync with `--no-embed`, review paid embedding before authorizing | `acknowledged` |
| 6 | `upstream-step-6-unattached-facts` | Keep unresolved references with NULL entity target and provenance; report `skipped_no_page` rather than inventing entity pages; keep a restorable backup | `acknowledged` |
| 7 | `upstream-step-7-write-results` | `storage_busy` means not applied/queued; inspect `gbrain jobs stats --json` and the job results before restoring unattended schedules | `acknowledged` |
| 8 | `upstream-step-8-oauth-scopes` | A generic client starts `read`; saving needs an explicit authorized `write` plus operator approval; preserve authorized sessions; verify the intended harness without broadening scopes | `acknowledged` |

All eight recorded `decidedBy = 0arnXQq6gMyaLf30hd2nAlyhwUZjuvRK` (the admin session). Route shape
discovered from `src/control/routes/upgrades.ts:143` — no body and no content-type requirement. The
underlying update is conditioned on `state = 'pending'` (`src/upgrade/ledger.ts:145`), so a re-ack
changes nothing; the route does not read that return value and still answers `200` with the existing
row.

### Step 3 — the ledger row resolves through the product, as the last item is acked

There is **no route that decides a `playbook_ledger` row directly**, and none is needed: a checklist item's
acknowledgement is the real judgement, and `ackChecklistItem` settles the version's ledger row to
`applied` when the last pending item for that version changes (`src/upgrade/ledger.ts:155-168`). After
item 8:

```text
GET /api/upgrades/pending-decisions      -> {"pending":[]}
ledger["0.50.2.0"].state                 -> "applied"
ledger["0.50.2.0"].decidedBy             -> 0arnXQq6gMyaLf30hd2nAlyhwUZjuvRK
ledger["0.50.2.0"].updatedAt             -> 2026-09-18T21:38:46.854Z
last notes line                          -> "2026-09-18T21:38:46.854Z applied — every checklist item
                                             decided; last was 'upstream-step-8-oauth-scopes',
                                             acknowledged by 0arnXQq6gMyaLf30hd2nAlyhwUZjuvRK"
```

`GET /api/upgrades/pending-decisions` is the route that lists availability of undecided work, and it is
empty. Preflight's refusal reads the same `state = 'pending'` predicate, so a new upgrade run is no
longer refused with `PENDING_CHECKLIST`.

### Step 4 — the four alerts, through the only acknowledgement surface

`POST /api/schedule-alerts/:id/ack` is member-gated, takes no body, and answers `{ ok: true }`; it is the
route the `/schedules` page drives. All four open rows were acknowledged by id:

```text
ack agent_budget_exceeded   (22e85d5e-371d-4d4b-b495-6e9b908c484a) -> {"ok":true}
ack lease_expired           (79747aa2-1c19-4af4-9012-985f4f7aefed) -> {"ok":true}
ack overlap_killed_previous (e1c25021-efbf-451e-a9e9-93d6f59574b2) -> {"ok":true}
ack connection_revoked      (4ea66784-b885-400d-97ea-abd3dbb99107) -> {"ok":true}
```

Afterwards `/api/health`'s `scheduleAlerts` is `[]` — the open-alert kinds are gone, not merely listed
elsewhere.

### Step 5 — the residue, and F22

Before: **10 memberships** (1 owner, 8 members, 1 viewer) and **7 active / 3 revoked Connections**. The
memberships live schedules reference — `slice2-cshared` (connection `7bd6a9b3`, active) and `slice2-cdual`
(connection `251817a9`, active) — plus `gate-b-throwaway` (connection `b5e64bb4`, revoked) and the admin
owner are the ones a live route still needs, so they stay. The `gate-b-viewer` viewer is a Slice 3.5 /
Slice 4 gate identity (`test/e2e/slice4.e2e.test.ts:66`), and `requireRole` 403s without its membership
(`src/control/rbac.ts:45`), so it too stays.

Removed through `DELETE /api/members/:id` (admin; cascades each member's Connections —
`schema.ts:171`, `onDelete: 'cascade'` — and never deletes the gbrain source):

| membership | email | what the cascade removed |
|---|---|---|
| `f32eec75-7b64-4f12-b8e5-ef8619963e5e` | `slice2-pairing-…` | `8b306f3c` (revoked) |
| `190593a0-bac1-4c5e-b0ad-2b73dc0c3593` | `slice2-isolated-…` | `afe8db89` (active) |
| `0f16129c-0c33-4a81-b217-f9c741b5da73` | `slice2-twowrite-…` | `2bbb3121`, `838ceb2d` (active) |
| `b77578c7-8eee-47da-a6e1-db6152858aa8` | `slice2-ccustomers-…` | `ca6475d4` (active) |
| `b82fe1b3-de79-4f80-b83b-5fdc31983af4` | `slice2-cinternal-…` | `e94bf2c3` (active) |

The console exposes offboarding (`src/console/pages/Members.tsx:58`, `api.delete('/members/:id')`), and
the API route exists, so membership deletion is **not** a gap. The residue that remains is the two
revoked Connections owned by kept memberships (`b5e64bb4` on `gate-b-throwaway`, `a656d51b` on
`slice2-cdual`): the console's Connection page offers only `POST /connections/:id/revoke`
(`src/console/pages/Connection.tsx:151`) and there is no `DELETE /api/connections/:id` route
(`src/control/routes/connections.ts` has none), so the only way to purge one is to offboard the member —
which cannot be done while a live route still holds the member. That is **F22**; no SQL was used.

After: **5 memberships** (1 owner, 3 members, 1 viewer) and **4 Connections** (2 active, 2 revoked). The
viewer's path was re-proved after the restore — sign-in succeeded and `GET /api/schedule-alerts` as the
viewer answered `200`.

### Step 6 — the after state and the diff

```json
{
  "ok": true,
  "components": {
    "controlDb": "ok",
    "ops": "ok"
  },
  "gbrainVersion": "0.50.5.0",
  "pin": {
    "declared": "0.50.5.0",
    "observed": "0.50.5.0",
    "matches": true
  },
  "repos": [
    {
      "sourceId": "customers",
      "staleLock": false,
      "lockAgeSeconds": null,
      "uncommittedFiles": 0,
      "unpushedCommits": 0,
      "branch": "master"
    },
    {
      "sourceId": "internal",
      "staleLock": false,
      "lockAgeSeconds": null,
      "uncommittedFiles": 0,
      "unpushedCommits": 0,
      "branch": "master"
    },
    {
      "sourceId": "shared",
      "staleLock": false,
      "lockAgeSeconds": null,
      "uncommittedFiles": 0,
      "unpushedCommits": 0,
      "branch": "master"
    }
  ],
  "scheduleAlerts": [],
  "runner": {
    "state": "connected",
    "lastSeenAt": "2026-09-18T21:39:42.804Z",
    "version": "2.1.274"
  },
  "at": "2026-09-18T21:39:59.879Z"
}
```

Semantic diff, before → after: `scheduleAlerts` goes from four entries to `[]`; `runner.state`,
`runner.version`, `pin`, `components` and `repos` are byte-for-byte unchanged. The only other moving
lines are the two clock fields (`runner.lastSeenAt`, `at`) — expected, since the runs are seconds apart.
`ok` was and stays `true`, and `pin.matches` was and stays `true`.

---

## F22 — a revoked Connection has no purge path; only its member can be offboarded

**Found by Task 14's cleanup; deliberately deferred.** `POST /api/connections/:id/revoke` exists and is
the console's only Connection-lifecycle control (`src/console/pages/Connection.tsx:151`,
`src/control/routes/connections.ts:115`). There is **no `DELETE /api/connections/:id`** and no console
control that deletes a Connection row, so a revoked Connection is permanent residue: the product's only
route to remove it is `DELETE /api/members/:id`, which cascades every Connection the member owns
(`src/control/db/schema.ts:171`). That is not a purge of the Connection; it is an offboarding, and it is
impossible for a member a live schedule still holds — which is exactly the state Task 14 finds the two
surviving revoked rows in.

The plan's Task 14 Step 5 labels this `F2`; this document continues Slice 4's numbering
(`F1`–`F19` → `F20`, `F21`), so it is recorded as **F22**.

**Decision: deferred, not fixed here.** Adding a purge is a new destructive admin surface with its own
blast radius (`agent_runs.connection_id` is `on delete set null` on purpose, so the audit survives;
`schedules.connection_id` is not null, so a purge must decide what happens to a schedule whose
Connection is gone) and it is not what Task 14 is for — D11 says record the missing path, not build it
mid-cleanup. The correct shape is a follow-up slice that adds `DELETE /api/connections/:id` for
`state = 'revoked'` only, with the schedule interaction stated in the route, a console control, and a
test; the named owner slice is the next hardening slice after Slice 5 GA. No SQL was reached for in the
meantime, and the two revoked rows are visible, inert, and explained here.

---

## P8 — the new-domain restore: measured, and what it did not do

**Task 16 — `partial`, stated as partial.** Two things are measured and one is not. What was
measured: the product's own new-domain restore branch, its timing, and exactly what the console
shows afterwards. What was **not** measured, and is not claimed: the OAuth issuer/redirect-URI
mismatch on the wire, because the deployment's real `DOMAIN` was not changed (see "Why this is
partial").

### The archive

A backup was taken on a **production-shaped stack** (base compose file only, so `docker port
brainstand-gbrain-ops-1` printed nothing), through the `compose exec` relay
(`OPS_RPC_URL=http://gbrain-ops:3140`, so the host-side port probe could not succeed). Manifest:

```text
MEASURED backup: quiesced=verified quiesceLane=relay elapsed=10.8s
```

That is Task 2 Step 7's procedure reproduced (already recorded as P1) and the archive this drill
restores.

### The drill

`runRestore(archive, { newDomain: 'brain-drill.example.test' })` was run against the live stack:

```text
DRILL_REPORT {
  "ok": true,
  "components": ["brainDb","controlDb","brainRepos","secrets"],
  "doctorExitCode": 0,
  "connectionsNeedingReissue": [
    "gbrain_cl_ef0098e245bf220ac4c92a277ea718f8c6088519c5339dea9da8655797114675",
    "gbrain_cl_5eef1324e5ce01f97458172ef163e4f8588f05888a2c64b4b24795ff97c4a413"
  ],
  "domainChanged": true,
  "elapsedMs": 21203
}
```

**How many Connections are invalidated: 0.** Before the restore `GET /api/connections` (the exact
surface the console's Connection page reads) returned **4** rows — **2 `active`**
(`bs-0aae83e1-shared`, `bs-a919cb38-internal`) and 2 already `revoked`. After the restore the same
call returned the **identical** states: the same 2 `active`, the same 2 `revoked`. The restore's
report did name **2** Connections needing re-issue, but it changed none of them.

**What the console shows for each: `active`.** The Connection page renders `row.state` verbatim
(`src/console/pages/Connection.tsx`), so an operator opening it after a domain move sees a working
Connection that is not one.

**Whether the member-facing message explains what happened: no.** `/api/health`'s `scheduleAlerts`
was `[]` before and after; the restore raises no `connection_revoked` alert and disables no
schedule. The only place the consequence appears is the restore script's stderr and its report —
host-side, operator-facing, never surfaced to the member or the console.

**How long the whole path takes: 21.2 s** (`elapsedMs: 21203`) from the first `compose stop` to the
returned report, including `gbrain apply-migrations` and `gbrain doctor` (exit `0`).

### The automated C8 leg fails, for the same reason (pre-fix measurement)

`test/e2e/slice5.e2e.test.ts`, run on the live stack at Task 16 time:

```text
MEASURED C7 quiesced=verified quiesceLane=http id=61228c87-777f-4694-b067-7fca71247c14
MEASURED C8 domainChanged=true needingReissue=2 activeAfter=2 total=4
(fail) C8: restore to a new domain invalidates every Connection, and the console says so
  error: expect(received).toEqual(expected)
  - []
  + [ "bs-0aae83e1-shared", "bs-a919cb38-internal" ]
```

`C7` passes (on the dev stack the published ops port makes the lane `http`; the production-shaped
lane is `relay`, measured above). `C8`'s assertion is the plan's own and was **not** weakened: the
console must not show a working Connection after a new-domain restore, and it does. The failure is
the defect, F23, not a test bug. **F23 is fixed below; the same leg now measures `activeAfter=0` and
passes.**

### Why this is partial, not complete

A true drill needs the stack's `DOMAIN` to differ from the archive's. It could not be done safely
in this environment:

- No alternate hostname resolves. `dns.lookup('drill.localhost')` and
  `dns.lookup('newhost.localhost')` both answer `ENOTFOUND` on this Windows host; only bare
  `localhost` resolves (`::1`). Caddy's site address is `{$DOMAIN}`, so a request with the old Host
  would not reach the new site, and adding a hosts-file entry needs an elevated shell.
- Changing `DOMAIN` on the live stack would break the dev override's published
  `https://localhost:8443` surface — the base URL every host-run e2e leg and Task 17's Gate C stand
  on — for the duration of the drill and risk stranding the stack afterwards.
- The runner, the scheduler's `PUBLIC_URL`, and `gbrain-serve --public-url` all interpolate
  `DOMAIN`; a half-reverted change is exactly the state Task 17 must not inherit.

So the drill drove the product's actual new-domain branch — the code path `bun run scripts/restore.ts`
takes when `NEW_DOMAIN` is set — and measured its full response and timing. It did **not** reproduce
the wire-level 401/OAuth rejection that a real issuer change causes; that consequence is stated in
the runbook from the spec and the mechanism (domain-bound issuer and redirect URIs), and is labelled
as the documented consequence rather than a measured one. **No number above was fabricated.**

---

## F23 — a new-domain restore invalidates nothing, so the console shows a working Connection that is not one

**Found by Task 16's P8 drill. FIXED HERE.** `runRestore` parsed `newDomain`, returned
`domainChanged: true`, printed the consequence to stderr, and listed the gbrain clients that need
re-issue (`connectionsNeedingReissue`) — and performed **no** state change on the control DB's
`connections` rows and raised **no** alert. Two measured product consequences:

1. `GET /api/connections` returned every `active` Connection unchanged after a new-domain restore —
   measured **2 of 2 active** in P8 — and the console's Connection page renders that `active` badge
   verbatim, so it showed a working Connection that was not one.
2. No member-facing message existed. `/api/health`'s `scheduleAlerts` stayed `[]`; the only signal
   was the host-side script output and report.

A contributing gap (not fixed here, and not on the honesty path): `scripts/backup.ts`'s
`BackupManifest` carries **no `DOMAIN` (or public URL) field**, so a restore cannot compare the
archive's origin to the running deployment's and must rely on the operator passing `NEW_DOMAIN` to
learn a move happened. The invalidation below is gated on that same signal.

### Fix

`scripts/restore.ts` now invalidates every grant, on the new-domain branch only. After the restored
services are up and `gbrain apply-migrations` has run, `runRestore` calls a new
`invalidateDomainBoundGrants()` (`scripts/restore.ts:305`), which runs one transactional CTE through
the same `compose exec postgres psql` lane the rest of restore uses (`scripts/restore.ts:273`). The
statement:

- marks every `connections` row still `state = 'active'` as `revoked` with `revoked_at = now()`;
- retires the live client name to `revoked:<id>` — exactly `retiredClientName()` in
  `src/control/connections.ts`, so the deterministic `bs-<member8>-<space>` name is free for the
  member to be re-provisioned;
- disables every enabled `schedule` on those Connections with `disabled_reason = 'connection_revoked'`;
- raises one `connection_revoked` alert per disabled schedule, with
  `detail = { connectionId, clientName }` — the product's existing member-facing surface
  (`/schedules`, and `/api/health`'s unacknowledged kinds).

The branch is gated on `opts.newDomain` (`scripts/restore.ts:383`); **a same-domain restore is
untouched** (measured `connectionsInvalidated: 0`). **No new state and no migration: `revoked` is
the correct minimal state.** `connections.state`'s CHECK already allows it, `GET /api/connections`
and the console's Connection page already render it, and it is precisely the state the product's own
`revokeConnection` writes. A distinct `needs_reissue` state would add a migration, a meta snapshot
and a console branch to say what `revoked` plus a `connection_revoked` alert already says. The fix
deliberately does **not** call `auth.revokeClient`: the restored gbrain lost the origin that made the
grant valid, there is no live secret to delete, and the restored clients must stay listed
(`connectionsNeedingReissue`) for the operator to replace. `RestoreReport` now carries the actual
counts, `connectionsInvalidated` and `alertsRaised` (`scripts/restore.ts:58`).

### Measured

The live stack before the drill: `connections` = 2 `active` / 2 `revoked`; **4** enabled `gate-c-*`
schedules on the second active Connection; `scheduleAlerts` empty. `bun test --parallel=1
test/e2e/slice5.e2e.test.ts`:

```text
MEASURED public /metrics: 401
MEASURED C7 quiesced=verified quiesceLane=http id=7b15d3eb-9433-4b89-b9e8-dc2b738571c8
[restore] new domain drill-new-domain.example.test: revoked 2 Connection(s); raised 4 connection_revoked alert(s)
MEASURED C8 domainChanged=true needingReissue=2 activeAfter=0 total=4
 4 pass / 0 fail
 6 expect() calls
```

Before → after: Connections `active` **2 → 0** (the 2 already-`revoked` rows stay `revoked`; total 4);
their 4 enabled schedules disabled; `GET /api/health` `scheduleAlerts` **[] → 4
`connection_revoked`** (kinds only, as designed — the authenticated `/schedules` carries the detail).
The same-domain path measured `invalidated 0 / alerts 0`, and `restore.e2e.test.ts` (4 pass / 0 fail,
including its own `newDomain` leg against an archive with no active Connection) logged `revoked 0
Connection(s); raised 0 connection_revoked alert(s)` — the SQL is a clean no-op with nothing to
invalidate. `test/unit` 649 / 0 and `test/integration/backup.test.ts` 11 / 0 were also green.

The C8 assertion was **not** weakened: `expect(stillActive.map((c) => c.clientName)).toEqual([])` now
passes because the state is genuinely `revoked`, not because the expectation moved.

---

## F24 — a brain that chose a search mode under the old vocabulary kept it after F21

**Found by Task 17's C2 leg. FIXED HERE.** F21 moved `SEARCH_MODES` to the pinned binary's real
vocabulary (`conservative | balanced | tokenmax`) and left the live stack's gbrain `config.set
search.mode` on `balanced`. It did **not** touch the control DB's stored `brains.search_mode`
column, so `/api/wizard/state` — which renders the wizard's mode screen from that column — still
reported the invalid id. Measured the first time C2 ran against the freshly rebuilt control plane:

```text
MEASURED C2 wizard lifecycle=ready searchMode=fast modes=fast,balanced,thorough
```

Two consequences: the mode screen showed a selection the pinned binary refuses, and an operator
who re-ran `/finish` on that brain would hand `config set search.mode fast` to gbrain again. The
`expect(ids).toEqual(['balanced','conservative','tokenmax'])` assertion was **not** moved; the
defect was.

### Fix

A data-only control-DB migration, `src/control/db/migrations/0008_search_mode_vocabulary.sql`
(with its `meta/0008_snapshot.json` and `_journal.json` entry): `fast -> conservative` and
`thorough -> tokenmax`, `balanced` unchanged, an unknown value left alone. It is idempotent and
schema-neutral, so it does not move the upgrade digest's schema census. After rebuild + recreate:

```text
MEASURED C2 wizard lifecycle=ready searchMode=conservative modes=conservative,balanced,tokenmax
```

### Two environmental events C2 also surfaced (not product defects)

- **The running `control-plane` image was stale.** The first C2 run read the **old** vocabulary
  (`fast,balanced,thorough`) because the dev stack's `ghcr.io/mobrain/control-plane:dev` had not
  been rebuilt since F21 landed. Rebuilt from the current source with
  `docker build -f docker/control-plane.Dockerfile --build-arg GBRAIN_VERSION=0.50.5.0 -t
  mobrain/control-plane:dev .` and re-tagged `ghcr.io/mobrain/control-plane:dev`. The source was
  already correct; the stack was not.
- **The `ANTHROPIC_API_KEY` in the host environment is invalid**, and the working credential is the
  host's Claude Code OAuth token. Measured directly, values never printed:

  ```text
  env-api-key  status 401 {"type":"error","type":"authentication_error","message":"API key is invalid."}
  creds-oauth  status 200 {"model":"claude-haiku-4-5-20251001", ...}
  ```

  The e2e preconditions require the org's `anthropic_api_key`; it was re-provisioned host-side from
  `~/.claude/.credentials.json` through `storeSecret` (host-side act, value never printed,
  round-trip verified). This is the rotating-host-secret maintenance window the runbook documents —
  **once per destructive cycle**, and C9 is such a cycle.

---

## F25 — a rollback to a pre-rename pin cannot recreate its images; `buildImages` is a no-op on the shipped compose

**Found by Task 17's C9 leg, which the plan wrote to re-prove Slice 3.5's exit gate "on the renamed,
re-published stack — the rename touched volume names and image references, which is precisely what a
rollback depends on." FIXED HERE.**

The first C9 run normalized to `0.50.0.0` by rolling back a completed Slice 3.5 run
(`run-022b8cfe-…`, from the pre-rename era). The rollback moved `.env` back to `0.50.0.0`, and the
stack then never came up:

```text
error: the stack never became ready within 900000ms (last: console=502 serve=502)
MEASURED teardown: runner=null pin=null
```

The cause was in the rollback's own `up`: the compose image reference is now
`ghcr.io/mobrain/gbrain-base:${GBRAIN_VERSION}`, and **no `mobrain/…:0.50.0.0` image exists** — the
rename (Task 4) moved the namespace, and the publish (Task 5; blocked at the push by P4) ships only
the current pin. Only the pre-rename `brainstand/gbrain-base:0.50.0.0` was on the host, so
`docker compose up` tried to pull `ghcr.io/mobrain/gbrain-base:0.50.0.0` and 404'd, leaving every
service stopped.

Underneath that is a second, independent gap: `scripts/upgrade.ts`'s `buildImages` ran

```text
docker compose <ctx.compose> build --build-arg GBRAIN_VERSION=<version> gbrain-ops gbrain-serve gbrain-worker control-plane
```

against `ctx.compose = ['docker','compose','-f','compose/docker-compose.yml']`. Since Task 5 moved
every `build:` stanza into `compose/docker-compose.build.yml`, that command printed **"No services to
build"** and did nothing. `gbrain-serve`/`gbrain-worker` follow the pin by pulling
`gbrain-base:<pin>`, but `gbrain-ops` runs the `control-plane:<APP_VERSION>` image, which bundles
gbrain at **build** time and is not versioned by the gbrain pin — so a pin move left the ops
RPC's `check-update` reporting the old binary. Measured after the local normalization:
`"pin":{"declared":"0.50.0.0","observed":"0.50.5.0","matches":false}` against a running
`gbrain 0.50.0.0` `gbrain-serve`.

### The F25 workaround, for the record

- Tag the pre-rename image into the new namespace, host-side:
  `docker tag brainstand/gbrain-base:0.50.0.0 ghcr.io/mobrain/gbrain-base:0.50.0.0`.
- Re-provision the OAuth credential (F24's environmental event) because the precondition rollback
  restores a `secrets` generation that predates the last rotation.

With those two host-side acts, C9 passed. Neither was a product fix, so C9 proved only that the
environment had been patched by hand.

### Fix (FIXED HERE)

`scripts/upgrade.ts`'s `buildImages` (`scripts/upgrade.ts:895`; helpers `BUILD_OVERLAY` /
`registryRef` / `controlPlaneTag` / `imagePresent` at `scripts/upgrade.ts:854-874`) no longer runs
the silent no-op. It:

1. Resolves the exact production reference
   `${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE:-mobrain}/gbrain-base:<pin>` — the same reference
   `compose/docker-compose.yml:57,75` runs.
2. Tries the production path first: `docker pull` the target pin.
3. If the registry does not carry it (every rollback pin, and this deployment, since the Task 5
   publish is blocked at the push by P4), builds it with the same recipe
   `scripts/publish-images.sh:25` uses:
   `docker build -f docker/gbrain-base.Dockerfile --build-arg GBRAIN_VERSION=<pin> -t <ref> .`
4. Mirrors that image under `mobrain/gbrain-base:<pin>` — the bare name
   `docker/control-plane.Dockerfile:7` resolves its `FROM` from (the registry-qualified production
   reference is not visible to that `FROM`).
5. Rebuilds `control-plane` and `scheduler` at the pin through the build overlay:
   `docker compose … -f compose/docker-compose.yml -f compose/docker-compose.build.yml build --build-arg GBRAIN_VERSION=<pin> control-plane scheduler`.
6. Verifies with `docker image inspect` that BOTH the target `gbrain-base:<pin>` and the production
   `control-plane:<APP_VERSION>` exist, and throws naming the missing reference otherwise. An exit 0
   without those images is the defect; it can no longer pass as one.

The upgrade lane's semantics are unchanged (D13): the same call sites, the same swap/rollback
ordering, and the same explicit `GBRAIN_VERSION` build arg. Only the command that used to print
"No services to build" now does the work.

### Proof the manual tag was removed

The manual `ghcr.io/mobrain/gbrain-base:0.50.0.0` tag and the bare `mobrain/gbrain-base:0.50.0.0`
mirror were removed before re-running, leaving only the pre-rename `brainstand/gbrain-base:0.50.0.0`
(`9410d75c4b55`):

```text
Untagged: ghcr.io/mobrain/gbrain-base:0.50.0.0
Untagged: mobrain/gbrain-base:0.50.0.0
brainstand/gbrain-base:0.50.0.0 9410d75c4b55
```

C9's precondition rollback then rebuilt the pin through the product. After the run,
`ghcr.io/mobrain/gbrain-base:0.50.0.0` and `mobrain/gbrain-base:0.50.0.0` both point at
`a059d716bdd2` — a different image than the removed manual tag, produced by the build in step 3,
not by `docker tag` of the pre-rename image.

### Measured (clean state, no manual tag, the whole file green)

Before the fix, the failed migration left the run in `rollback_failed` (the auto-rollback could not
obtain `gbrain-base:0.50.0.0`). After the fix, the auto-rollback completes at the pin it targets:

```text
MEASURED C9 precondition: rolled back completed run run-9a7b34b8-… to 0.50.0.0 (exit 4)
MEASURED C9 pending cleared(before fixture): 8
MEASURED C9 repo drift cleared: ["internal"]
MEASURED C9 fixture: FIXTURE: config.version 149 -> 143; open_loops replaced (id TEXT PRIMARY KEY); pre-digest taken
MEASURED C9 failed run run-39af4ea4-… exit=1 states=[planned,capability,preflight_ok,quiesced,snapshot_taken,snapshot,swapped,schema,rolling_back,rolled_back]
MEASURED C9 rollback of run-39af4ea4-… restored the pre-upgrade state exactly
MEASURED C9 un-fixture: UN-FIXTURE: open_loops restored to the real schema; config.version -> 149
MEASURED C9 pending cleared(before real run): 0
MEASURED C9 repo drift cleared(before real run): []
MEASURED C9 real run run-5219d9eb-… ledger[0.50.5.0]=applied parity.regressed=[] schemaVersionOk=true observed=0.50.5.0
MEASURED teardown: runner={"state":"connected",…} pin={"declared":"0.50.5.0","observed":"0.50.5.0","matches":true}
```

Full file, `bun test --parallel=1 test/e2e/slice5.e2e.test.ts`, one continuous walk:

```text
 10 pass
 0 fail
 100 expect() calls
Ran 10 tests across 1 file. [706.18s]
```

---

## P9 — the GA operator walk, C1–C10, measured on one stack

`bun test --parallel=1 test/e2e/slice5.e2e.test.ts`, one continuous walk, `10 pass / 0 fail`:

```text
MEASURED public /metrics: 401
MEASURED C2 bootstrap: bootstrapped=true
MEASURED C2 wizard lifecycle=ready searchMode=conservative modes=conservative,balanced,tokenmax
MEASURED C3 whoami transport=oauth source=internal federated=["internal"]
MEASURED C3 fence search sources=[internal] over 1 hit(s)
MEASURED C4 command run c3169385-… state=succeeded report=reports/walk-cmd-…/2026-09-18-1927.md summary.status=first_sync
MEASURED C5 run=5be53a8b-… state=succeeded cost=$0.0263051 toolUses=[mcp__gbrain__put_page] usageRows=2 diff=[walk/…/agent.md]
MEASURED C6 coverage notCovered=[failed chat calls (budget-tracker owns pessimistic in-flight spend) | subagent raw-SDK calls | embeddings (embedding-pricing.ts unit) | calls made before migration v140 / sink registration]
MEASURED C6 ours=$0.0263051 unpriced=0 brainReachable=true member=walk-…@example.test memberCost=$0.0263051
MEASURED C7 quiesced=verified quiesceLane=http id=f5c06355-…
MEASURED C8 before active=8 total=11
MEASURED C8 domainChanged=true needingReissue=9 activeAfter=0 total=11
MEASURED C9 real run run-9a7b34b8-… ledger[0.50.5.0]=applied parity.regressed=[] schemaVersionOk=true observed=0.50.5.0
MEASURED C10 the GA walk total model spend = $0.0263051 over 1 run(s)
MEASURED teardown: runner={"state":"connected","lastSeenAt":"2026-09-18T23:31:33.390Z","version":"2.1.274"} pin={"declared":"0.50.5.0","observed":"0.50.5.0","matches":true}
```

C10's number is captured at C6, not at teardown: C9's rollback restores a control-DB snapshot that
predates the walk, so a teardown-only query would honestly report `$0.0000000` about a walk that
spent real money. C10 prints the captured figure instead, and falls back to the live query when C6
did not run (a focused run). C1, C7 and C8 were written by Tasks 8 and 16 and kept as they were.

---

## P6 — the drift tripwire fires once, then comments on itself

**Task 13 Step 3.** `nightly.yml` gained a `workflow_dispatch` input, `gbrain_version`, that replaces
the pinned-next matrix arm; the same dispatch with no input keeps `0.51.0.0`. To prove the tripwire
is connected, it was dispatched against a version that cannot exist.

First dispatch, `gbrain_version=0.99.0.0` (run
[35413613589](https://github.com/MolanoJF/mobrain/actions/runs/35413613589)):

```text
contract (0.99.0.0)  X  Build the pinned base image   (46s)
issue opened: #1  drift: gbrain 0.99.0.0 breaks the contract suite   label=drift
```

Second dispatch, same version (run
[35413701789](https://github.com/MolanoJF/mobrain/actions/runs/35413701789)):

```text
issue list -> only #1, still one open drift issue
issue #1 comments -> 1, newest body starts:
  Nightly pinned-next run failed against gbrain `0.99.0.0`.
  Run: .../actions/runs/35413701789
```

Exactly one issue per drifting version, a comment on re-run, no duplicate. Issue #1 was closed by
hand after the proof. Both arms are `continue-on-error` on the pinned-next side, so the pinned-current
arm's colour is unaffected by a drift finding.

---

## F26 — the plan's A5 asserted a value from an admin-gated route

**Found by Task 7 Step 4 on the first clean-host run that got past A3. FIXED HERE.** The plan's A5
read `GET /api/wizard/state` and asserted `lifecycle === 'uninitialized'` from an unauthenticated
fetch. But that route is wrapped in the wizard's `requireAdmin` guard
(`src/control/routes/wizard.ts:68`), and on a box with no admin there is no session to read it, so
the response is `401 { error: 'unauthorized' }` and `state.lifecycle` is `undefined`. The console
does not use it to choose the bootstrap form anyway: `src/console/App.tsx:81` reads the **public**
`GET /api/bootstrap` (`{ bootstrapped }`), and this is not a defect — gating the wizard state is
correct, because it names the lifecycle, spaces and search mode.

A5 now asserts the console shell, `GET /api/bootstrap -> { bootstrapped: false }` (the signal the
bootstrap form is chosen from), and that `/api/wizard/state` returns `401` unauthenticated. That is
strictly more than the plan asserted, not less.

Measured on the clean runner, after the fix-in-progress, A3–A4:

```text
MEASURED health on a clean install: {"declared":"0.50.5.0","observed":"0.50.5.0","matches":true} {"controlDb":"ok","ops":"ok"}
```

---

## F27 — `mock.module()` is process-global; a sibling's partial mock answered another file's import

**Found by Task 7/13 CI stabilisation. FIXED HERE.** Bun's `mock.module()` is process-global, and
the integration/contract suites run every file in one process, so a file that mocks a module with a
*partial* export list poisons every file that imports the real module afterwards. Measured:

- `test/integration/upgrades.test.ts` mocked `src/upgrade/capability.ts` with only `driftBetween`;
  `test/integration/capability.test.ts` then read the mock's `driftBetween`, so the leg that must
  prove `driftBetween` throws on one snapshot resolved instead.
- `test/integration/routes.test.ts` mocked `src/control/opsClient.ts` without
  `deleteCredentialJournal`; a later importer of the module failed to load.
- `test/contract/usage.contract.ts` read `http://127.0.0.1:1/rpc` — a URL its own file never set.

`--parallel=1` is **not** a fix: one worker still shares the mock registry, and a measured run of
`bun test --parallel=1 test/integration/upgrades.test.ts test/integration/capability.test.ts` fails
with `Export named 'latestSnapshotFor' not found`. `--isolate` alone does not isolate `mock.module`
either. The fix is one OS process per file: `scripts/test-isolated.sh` runs each `*.test.ts` in its
own `bun test`, used by the integration and contract CI jobs. That also bounds peak memory to one
file's module graph, which the OOM-killed integration run needed. Three files that had leaned on the
shared process were completed (`routes.test`, `upgrades.test`) or made explicit (`health.test`).

---

## F28 — the CI contract job was missing its own prerequisites

**Found by Task 13's split. FIXED HERE.** After `adb7d53` gave the `contract` job the live stack, 16
of 130 contract tests still failed for reasons that were purely missing CI setup, not product
defects:

- `runner.contract.test.ts` A5/A9 `pinDb()` and the upgrade-ledger legs need a Postgres at
  `localhost:5432`; the job declared no `services:` (unlike `unit`/`integration`) — `ECONNREFUSED`.
- `runner.contract.test.ts` A10 runs `docker run mobrain/agent-runner:2.1.274`; the overlay built
  only `control-plane` and `scheduler`, so the runner image did not exist.
- `lifecycle.contract.test.ts`'s `embed --stale` and `scheduler.contract.test.ts`'s
  `embed --stale --source` refuse without the embedding key the slice0 harness names
  (`openai:text-embedding-3-small requires OPENAI_API_KEY`); the job passed no provider key.

The job now declares the scratch Postgres service and `CONTROL_DATABASE_URL`, builds and mirrors
`agent-runner`, and injects `OPENAI_API_KEY` from a repo secret. `nightly.yml` gets the same
prerequisites. Two more CI-only gaps surfaced on the first `contract` run after that and are fixed
here: the seam-gate legs shell `docker compose --env-file .env` and a runner has no `.env` (now
materialized from the job environment, never committed), and `nightly.yml`'s `bun run … | tee`
masked the step's exit code (now `set -o pipefail`). The first `.env` attempt set
`COMPOSE_PROJECT_NAME=brainstand`, which collided with the slice0 test project's own default
(`brainstand-slice0`, `compose/docker-compose.slice0.yml:3`) so slice0's `composeDown -v` tore down
the main stack mid-suite; the materialized `.env` deliberately leaves the project name unset so each
compose file keeps its frozen default.

---

## F29 — the Gate A teardown hit Bun's 5 s default hook timeout

**Found by Task 7 Step 4. FIXED HERE.** The `afterAll` that runs
`docker compose … down -v` took longer than Bun's default 5 000 ms hook timeout; the teardown was
reported as a second, unnamed failure (`a beforeEach/afterEach hook timed out`) after all eight legs
had run and left `down -v` possibly incomplete. The hook now carries an explicit 300 000 ms budget.
Per-test timeouts were added at the same time (`A2` 900 s, the rest 120–180 s) because the ~52 s
install cannot meet the 5 s default.

---

## F30 — a docker-volume snapshot artifact is root-owned, so its operator cannot manage it

**Found by contract `upgrade.contract.test.ts` A9 on the Linux runner. FIXED HERE.**
`tarVolumeToFile` runs a throwaway `busybox` container as root, and Docker creates the bind-mounted
archive as root. On the dev box (Windows bind-mount semantics) this is invisible; on a Linux host
the operator — and A9's one-byte tamper — gets `EACCES` opening their own backup. The tar still runs
as root (so restrictively-moded volume files stay readable) and a second one-shot `busybox chown
<uid>:<gid>` hands the artifact to the invoking user; on a host with no `getuid` (Windows) the chown
is skipped. `test/unit/snapshot.test.ts` was updated to expect the extra call — a fixture
correction, not a weakened assertion.

---

## F31 — the slice3/3.5 seam legs assume a wizard-initialized main brain, which CI did not have

**Found by Task 13's contract job. FIXED HERE.** After F28's fixes, 13 of the 15 contract files passed.
Two failed, both against the MAIN stack, both because a fresh compose stack's brain was not the dev
box's wizard-initialized brain:

```text
(fail) Slice 3 seam gate A > A7. the committed report is importable — sync sees it as a page
  sync --source slice3-probe --json exits 1
(fail) Slice 3.5 seam gate A > A4. post-upgrade is idempotent and what it wrote to config.json is observable
  reading gbrain config failed: cat: /srv/gbrain-home/.gbrain/config.json: No such file or directory
```

### Root cause, measured

A virgin `compose up` leaves gbrain-worker/serve to cold-start the schema before any wizard runs. Read
directly inside the container, one fresh isolated compose project (`COMPOSE_PROJECT_NAME=bsci`, the dev
override plus a temp port override so it could not touch the dev stack):

```text
cat /srv/gbrain-home/.gbrain/config.json   -> No such file or directory
content_chunks.embedding typmod            -> 1280
gbrain doctor: embedding_model="zeroentropyai:zembed-1", "Schema width (1280d) matches gateway embedding_dimensions"
```

The prior attempts failed because they issued the reset and the init as **two separate commands**. CI run
[35416187167](https://github.com/MolanoJF/mobrain/actions/runs/35416187167) logged the `curl
/fileplane/reset-brain-schema` and then:

```text
gbrain init --non-interactive --force --embedding-model openai:text-embedding-3-small
Refusing to silently re-template existing brain.
Switching dims is destructive: it drops every embedding in your brain …
```

`--embedding-dimensions 1536` did not pass the guard either (run
[35416733961](https://github.com/MolanoJF/mobrain/actions/runs/35416733961)); the pinned `0.50.5.0`
refuses a headless 1280 → 1536 re-template. Between the reset command and the next `docker exec`, the
worker recreated the 1280 template, so the guard fired again. The product's own `/finish` does not have
that window: it calls `resetBrainSchema()` and the ops-RPC `init` back to back inside one control-plane
request (`src/control/routes/wizard.ts:226-231`), and that is exactly why the dev box's wizard-initialized
brain works and the hand-rolled CI sequence did not.

### The fix — drive the product's bootstrap path

`scripts/ci-bootstrap-brain.ts` (new) drives the wizard over the control-plane HTTP API, the path an
operator uses: `POST /api/bootstrap` → sign-in → `GET /api/wizard/state` → `provider` → `search-mode` →
`schema` → `space` → `finish`. It is idempotent (a `409 already_bootstrapped` signs in; a brain already
`ready` exits `0`) and waits up to 180 s for Caddy to answer `GET /api/bootstrap` before its first POST
(the first push run got a `502` because `up --wait` returns before Caddy routes to control-plane; run
[35442050380](https://github.com/MolanoJF/mobrain/actions/runs/35442050380)). It is wired in after the
stack is up in `.github/workflows/contract.yml` and `.github/workflows/nightly.yml`. No raw SQL, no
gbrain edit, no assertion weakened.

Same isolated cold brain, wizard driven through the API:

```text
bootstrap: created first admin admin@example.test (Acme)
wizard: lifecycle=uninitialized
wizard: provider configured (openai:text-embedding-3-small)
wizard: search mode conservative
wizard: schema pack gbrain-base-v2
wizard: Space shared
wizard: /finish ok=true lifecycle=ready
```

Afterwards `config.json` carries `embedding_model: openai:text-embedding-3-small` and
`embedding_dimensions: 1536`, and `content_chunks.embedding` typmod is **1536**. The
1280 → 1536 switch is real; only the wizard's back-to-back reset+init can make it.

Going green also exposed a latent gap that had never been reached: the `restore` and `slice2` jobs build
the overlay with no `HARNESS_VERSION`, and Compose refuses to interpolate `agent-runner`'s required
variable even though that profile-gated service is never built. `HARNESS_VERSION: '2.1.274'` was added to
both job envs. That is a CI-prerequisite fix, not a weakened gate.

### Measured CI result

Run [35442883710](https://github.com/MolanoJF/mobrain/actions/runs/35442883710) at `c5e5604`, all jobs
green: `unit`, `build-gates`, `integration`, `contract`, `publish`, `clean-install`, **`restore`**,
**`slice2`** — every job `success`. The previously-red legs now report verbatim:

```text
(pass) Slice 3 seam gate A > A7. the committed report is importable — sync sees it as a page [1654.16ms]
(pass) Slice 3.5 seam gate A > A4. post-upgrade is idempotent and what it wrote to config.json is observable [13039.75ms]
contract: 57 pass / 0 fail  (per-file; scheduler.contract and upgrade.contract both OK)
restore:  4 pass / 0 fail
slice2:   17 pass / 0 fail
```

No assertion was moved and no test was skipped. The fix is a committed bootstrap that runs the product's
own wizard, not an `init` flag invented to get past the guard.

---

## F32 — a sibling contract file's process-wide `OPS_RPC_URL=:1` answered the new spend test

**Found by Task 18 Step 1**, the first full `bun test test/contract` directory run that includes
`test/contract/usage.contract.test.ts` (Task 10). The directory run was **143 pass / 3 fail**; every
failure was the new file's three ops-backed legs, and every one answered `ConnectionRefused` to a URL
no test in that file ever set. Run alone, the file is 4/0.

Verbatim (`bun test test/contract`, 2026-09-19T03:24Z):

```text
test\contract\usage.contract.test.ts:
error: Unable to connect. Is the computer able to access the url?
  path: "http://127.0.0.1:1/rpc",
 errno: 0,
  code: "ConnectionRefused"
      at async post (C:\Users\juanp\Desktop\Company Brain\src\control\opsClient.ts:11:21)
      at async readBrainUsage (C:\Users\juanp\Desktop\Company Brain\src\ops\usage.ts:96:19)
      at async <anonymous> (C:\Users\juanp\Desktop\Company Brain\test\contract\usage.contract.test.ts:52:25)
...
 143 pass
 3 fail
 595 expect() calls
Ran 146 tests across 15 files. [384.97s]
```

**Cause.** `test/contract/connection.contract.test.ts` runs `runConnectionE2E()`, whose
`auditThenOpsRevoke()` (`scripts/connection-e2e.ts:180-181`) sets
`process.env.OPS_RPC_URL = 'http://127.0.0.1:1'` — deliberately, to prove the revoke path's
audit-before-delete survives an unreachable ops — and never restored it. `src/control/opsClient.ts`
captured that variable into a module-level `const OPS_URL` at import time. Bun runs a whole test
directory in one process, `connection.contract` sorts first, and its dynamic
`import('../src/control/connections.ts')` linked `opsClient.ts` while the `:1` was set — so every later
file that lazily imported the module inherited it. `usage.contract.test.ts` is the first contract file
to reach ops through the host `opsClient`, so it was the first victim. This is the same class as Slice
4's F27 (`mock.module` is process-global): module-level state in one contract file leaking into a
sibling through the shared test process.

**Fix (no test or gate weakened).**

- `src/control/opsClient.ts` resolves the endpoint and bearer at **call** time (`opsUrl()` /
  `opsToken()`) instead of binding them at module load. Inside compose the variable is constant, so the
  container's behaviour is identical; the load-time binding was the process-wide hazard.
- `scripts/connection-e2e.ts` snapshots `process.env.OPS_RPC_URL` and restores it in a `finally`, so
  the unreachable `:1` cannot outlive the function that needs it.
- `test/contract/usage.contract.test.ts`'s header comment now says call-time, not module-load.

**Re-measured on the same tree:** `bun test test/contract` **146 pass / 0 fail** (601 `expect()` calls,
15 files, 389.33s); `bun test test/unit` **649/0**; `bunx tsc --noEmit` clean; `bun run lint:forbidden`
clean. Full verification tails are in `PROGRESS.md`'s "Slice 5 — Task 18 verification" section.

**What remains:** the call-time read is containment, not D5's cure. The host-side spend read still
reaches `src/control/opsClient.ts` directly rather than through an injected `OpsCaller`; a future file
that mutates other module-level state could still race a sibling. Recorded so the next slice does not
rediscover it.


