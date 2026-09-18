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
| U1 | `compose/Caddyfile`'s public `@gbrain` route publishes an unauthenticated Prometheus `/metrics` surface naming brains, Spaces, models or spend | `contradicted` — the pinned `gbrain-serve` answers `401` with `{"error":"Admin authentication required"}`; no body, no cardinality. S1's argument does not need to be extended to `/metrics` on this pin |
| U2 | The `operator` profile carries the `admin` scope `get_usage` requires, so no elevation to `full` is needed | `confirmed` |
| U3 | `get_usage` over the HTTP MCP lane answers with totals and upstream's `coverage` block verbatim, and the short-TTL client minted for the call is revoked | `confirmed` |
| F20 | On the stock compose stack `readBrainUsage` minted its client with the internal plain-HTTP data lane as the grant `--url`, which gbrain's `assertSecureEndpoint` refuses, so `/api/spend` shipped `brain: null` / `coverage.brainReachable: false` — the host-run contract test hid it by setting `GBRAIN_MCP_URL` | `confirmed` — fixed here |
| F21 | Mobrain's `SEARCH_MODES` offers ids `fast` and `thorough`, but the pinned gbrain `0.50.5.0` accepts only `conservative \| balanced \| tokenmax`; `search.mode` is stored verbatim and the resolver silently falls back to `balanced`, so the product's mode picker does not change the search pipeline | `confirmed` — fixed here |

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

