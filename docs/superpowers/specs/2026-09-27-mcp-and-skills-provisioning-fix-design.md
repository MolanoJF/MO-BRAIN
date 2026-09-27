# MCP connection reliability + skill discovery — design

Date: 2026-09-27
Status: proposed

## Problem

Two related provisioning mechanisms were runtime-tested live against the
dev stack this session and found broken or incomplete.

**MCP connection (manual harnesses).** The "Harness snippet" shown on the
Connect page (`Claim.tsx`, `Access.tsx`, the `/my/mcp` route in
`myConnection.ts`) for any harness in `harness.ts`'s `manual` class
(`claude-desktop`, `cursor`, `chatgpt`, `perplexity`, `generic`, …) emits:

```json
{ "mcpServers": { "gbrain": { "url": "<mcp_url>", "client_id": "<client_id>" } } }
```

Measured this session:

- No mainstream MCP client (verified against Claude Code's own
  `claude mcp add-json`) accepts this shape — it was rejected outright
  (`Invalid configuration: Invalid input`). There is no `client_id`-only
  auth mode; a real config needs `{"type":"http","url":...,"headers":
  {"Authorization":"Bearer <token>"}}`.
- Even a corrected shape needs a token this snippet never carries. The
  real handoff (`storeMemberClientHandoff`, `connections.ts:212`) always
  includes `client_secret` and `access_token`; the snippet strips both.
- The access token that *is* shown to the member (in the "Credentials"
  JSON block) has a default 1-hour TTL (`TOKEN_TTL_DEFAULT = 3600`,
  `compile.ts:35`), and nothing overrides it for member connections. A
  captured example from this session had already expired by the time it
  was read back minutes later. A static copy/paste credential with a
  1-hour life is unusable regardless of snippet shape.
- Nothing ever exercises `gbrain mcp verify` against a freshly granted
  manual-harness connection. `mcp.verify` is already a registered
  contract op (`registry.ts:321`) with commentary describing exactly this
  gap ("every adapter carries `evidence.runtimeTestedAt: null`"), but no
  code path calls it. The console's only "verify" UI
  (`Access.tsx:503-589`) reads the `mcp.grant --dry-run` preview, not a
  live check, and the snippet's permanent, unconditional disclaimer ("We
  have not runtime-tested this adapter") is static copy, not a real
  result.

**Skill discovery.** `list_skills` already returns a complete, correct
self-instruction block (`instructions.summary`/`how_to_use`) — verified
live against the dev stack. The gap is upstream of that: nothing prompts
an agent to call `list_skills` in the first place. The only nudge today
is `SKILLS_NOTE` (`harness.ts:85-91`), a human-readable paragraph appended
after the snippet — easy to skip, and not something the agent itself
ever sees unless a human manually relays it.

**Catalog currency.** `gbrain doctor` reports the mounted catalog
(`skills/`) has 2 skills while gbrain ships 62 built-in ones
(`skill_currency` check, `gbrain doctor --json`). None of the 62 reach
members because gbrain deliberately never serves its bundled catalog to
remote callers — Mobrain must opt in per skill.

## Scope

1. **Fix A** — make the manual-harness snippet actually authenticate, give
   it a credential that survives being pasted once, and replace the
   static "untested" disclaimer with a real, live verify result.
2. **Fix B** — add a machine-actionable instruction block that reliably
   gets a connected agent to call `list_skills`, plus file the upstream
   ask so gbrain's own `initialize` handshake eventually carries it.
3. **Process doc** — a manual, human-reviewed runbook for curating gbrain's
   built-in skills into Mobrain's member-facing catalog. No code.

Decisions already made (see prior turn):
- Token lifetime: raise manual-harness connections to a 30-day TTL rather
  than building refresh-token or client-credentials-exchange support.
- Skills: ship the pasteable instruction block now; file the upstream
  `initialize.instructions` ask as a tracked follow-up, not a blocker.
- Catalog sync: manual, curated, reviewed — no automation.

## Fix A — MCP connection reliability

### A1. Token TTL policy for manual harnesses

`connections.ts::compileFrom` (line 373) is the one place that already
sees both `input.harness` and `input.tokenTtl` before calling
`compileConnection`. Add a policy there:

```ts
const MANUAL_HARNESS_TOKEN_TTL = 30 * 24 * 60 * 60; // 30d

function compileFrom(input: ConnectionInput, write: SpaceRow, reads: SpaceRow[]): CompiledConnection {
  const tokenTtl = input.tokenTtl
    ?? (connectionClass(input.harness) === 'manual' ? MANUAL_HARNESS_TOKEN_TTL : undefined);
  return compileConnection({ role: input.memberRole }, write, reads, { ..., tokenTtl });
}
```

Requires importing `connectionClass` from `harness.ts` into
`connections.ts` (not currently imported there). `compile.ts` itself
stays harness-agnostic — the 30-day default is harness-*class* policy,
not a compiler concern, so it belongs in `connections.ts`, not
`compile.ts`. `TOKEN_TTL_MAX` (90d, `compile.ts:34`) already bounds it,
so no clamp change needed. Auto-install harnesses (`claude-json`,
`codex-toml`, `opencode-json`, `thin-cli`) keep the existing 1-hour
default — they aren't the ones cold-pasting a static secret into a
config file the harness might refresh itself (out of scope here; no
evidence this session that they're broken).

An explicit `input.tokenTtl` (e.g. a future admin override) still wins —
this only fills the gap when nothing was specified.

### A2. Snippet shape

`harness.ts`:
- Extend `WiringCredentials` with `access_token?: string`.
- Rewrite `baseSnippet`'s `manual` branch to emit:
  ```json
  {
    "mcpServers": {
      "gbrain": {
        "type": "http",
        "url": "<mcp_url>",
        "headers": { "Authorization": "Bearer <access_token>" }
      }
    }
  }
  ```
- Drop the unconditional "We have not runtime-tested this adapter" line
  from `baseSnippet`. It becomes a live fact (A3), not permanent copy.
  When no verify result exists yet (e.g. the Access.tsx preview with
  placeholder credentials), keep a narrower, honest line: "Not yet
  verified for this harness."

### A3. Live verify, wired to the existing contract op

`mcp.verify`'s registry entry (`registry.ts:321`) is missing `url`,
`credentialsFile`, and `delegate` params that `gbrain mcp verify --help`
shows as real flags — extend it to match:

```ts
'mcp.verify': {
  ...,
  params: [
    { name: 'client', flag: '--client', kind: 'value' },
    { name: 'harness', flag: '--harness', kind: 'value' },
    { name: 'url', flag: '--url', kind: 'value', required: true, secret: true },
    { name: 'credentialsFile', flag: '--credentials-file', kind: 'value', secret: true },
    { name: 'timeoutMs', flag: '--timeout-ms', kind: 'value' },
    { name: 'delegate', flag: '--delegate', kind: 'flag' },
  ],
},
```

Call it once, right after grant, from `provisionConnection`
(`connections.ts:106-205`), only for `manual`-class harnesses (auto-install
classes write real adapter config and have their own install-time
verification story — out of scope). Use the just-taken
`credentialsOut` file as `--credentials-file`; skip `--delegate` (it "may
incur model charges" per the CLI help — a real worker check is a
deliberate opt-in, not part of provisioning).

Persist the result. `connections` (`schema.ts:210`) gets three new
columns via migration:
- `verify_status text` (`'ok' | 'partial' | 'failed' | null`)
- `verified_at timestamp with time zone`
- `verify_message text`

`mcp.verify` exit codes: 0 = ok, 2 = partial (server stages passed,
harness evidence missing — **never render this as green**, per the
existing honesty-rule comment at `registry.ts:317-320`), other = failed.
A failure here must not fail the whole claim/provision — record it and
surface it, the way a failed extraction doesn't block a page write. Wire
the same call into `myConnectionRoutes.post('/my/mcp/reissue', ...)`
(`myConnection.ts:195`) since reissue re-grants and the old verify result
would otherwise go stale silently.

### A4. Surface access_token + verify result through existing call sites

Three call sites already construct `wiringSnippet` from data they already
possess; each needs the same two additions (pass `access_token`, render
verify status):

- `Claim.tsx:170` (`ClaimedConnection`) — `conn.credentials` is already
  the full handoff (has `access_token`); `asCreds` needs the field added
  and passed through. `ClaimResult` (`claim.ts:15-25`) needs a
  `verify: { status, message }` per connection, populated from A3.
- `myConnection.ts:168` (`present`) — `handoff.access_token` is already
  loaded; pass it. Add `verify` fields read from the connection row to
  the JSON response consumed by `Mcp.tsx`.
- `Access.tsx:221` — preview-only, placeholder credentials
  (`<client_id>`, `<mcp_url>`) become `<access_token>` too; no real verify
  call here (nothing has been granted yet).

`Mcp.tsx` and `Claim.tsx` render a small status line next to the
snippet: ok (real pass), partial (amber, "server checks passed, harness
evidence missing" — reuse the existing `verifyAmber` copy pattern from
`Access.tsx:584-589`), failed (red, with `verify_message`), or "not yet
verified" if null.

## Fix B — skill discovery

### B1. Pasteable agent-instructions block

`harness.ts` gets a second, distinct block from `SKILLS_NOTE` — one
meant to be pasted as the agent's system prompt or first message, not
read by a human:

```ts
export const AGENT_INSTRUCTIONS = [
  'Before responding to any request on this connection, call `list_skills`.',
  'If a returned skill\'s triggers match the user\'s request, call `get_skill`',
  'with its name and follow the returned instructions. Only call tools listed',
  'in that skill\'s `usable_tools` — tools under `unavailable_tools` are not',
  'callable by you on this server.',
].join(' ');
```

`wiringSnippet`'s `opts.skills` gains this as a returned structured value
(not string-concatenated into the same block as `SKILLS_NOTE`, so the
console can render it as its own labeled, individually-copyable section —
matching the existing Endpoint / Credentials / Harness snippet pattern
on the Connect page). `SKILLS_NOTE`'s human-facing prose stays as
context around it, unchanged.

### B2. Console rendering

`Claim.tsx`, `Mcp.tsx`, and `Access.tsx`'s snippet displays add a fourth
copy block, "Agent instructions," directly below "Harness snippet," only
when `skillsPublished()` is true (same gate `SKILLS_NOTE` already uses).

### B3. Upstream ask (tracked, non-blocking)

File the ask against gbrain (same pattern as the existing tracked
divergence in `docs/member-skills-findings.md` → issue #5358): request
that `list_skills`' `instructions` block also populate the MCP
`initialize` response's own `instructions` field, so spec-compliant
clients load it automatically with no copy/paste. Record the ask in
`docs/member-skills-findings.md` alongside the existing upstream item,
including the live evidence from this session (the `instructions` block
already present in `list_skills`' tool response, captured verbatim).

## Process doc — catalog currency runbook

New `docs/runbooks/skill-catalog-sync.md` (no code):

1. On `gbrain-ops`, run `gbrain skillpack sync` and `gbrain doctor --json`
   to see the current `skill_currency` diff (which built-in skills are
   new/changed since the last sync).
2. An operator reviews each new/changed skill's `SKILL.md` for: does it
   need tools/scopes beyond what member profiles (`memory-reader`,
   `memory-writer`, …) already grant; does it match a real member
   workflow; does it write pages a member shouldn't be able to write
   unsupervised.
3. Approved skills are copied into repo `skills/<name>/SKILL.md`, and
   `skills/RESOLVER.md`'s trigger table gets a new row.
4. Commit as a normal PR — the mounted volume (`compose/*.yml`,
   `../skills:/opt/mobrain-skills:ro`) picks it up on next container
   start; no redeploy-time code change needed since `GBRAIN_SKILLS_DIR`
   already points at the repo folder.
5. Suggested cadence: check `skill_currency` alongside each gbrain
   version bump (there's already an `upgrade/playbooks` mechanism per
   version in this repo — a natural place to add a reminder, not an
   automated step).

## Testing

- `test/contract/member-skills.contract.test.ts`: extend to assert the
  rendered snippet for a `generic`-harness grant deserializes to a valid
  `claude mcp add-json`-shaped config (type/url/headers.Authorization),
  and that the granted token is accepted end-to-end (already proven
  possible live this session).
- New contract test for A1: a `generic`-harness `provisionConnection`
  call yields `tokenTtl === MANUAL_HARNESS_TOKEN_TTL`; a `claude-code`
  one is unaffected.
- New contract test for A3: after provisioning a manual-harness
  connection, the connection row's `verify_status` is `'ok'` against the
  live dev stack (mirrors the existing `beforeAll` grant setup in
  `member-skills.contract.test.ts`).
- Unit tests in a new `test/unit/harness.test.ts` (none currently exists
  for `harness.ts`): snippet shape per class, `AGENT_INSTRUCTIONS`
  presence gated on `opts.skills`, TTL policy function.
- Migration test: `connections` table accepts the three new nullable
  columns without breaking existing inserts (`test/unit` or a drizzle
  migration smoke test, matching existing schema test conventions).

## Non-goals

- No refresh-token flow or client-credentials exchange for manual
  harnesses (explicitly decided against — no mainstream MCP client
  supports it, and the product's existing "Issue a new connection"
  reissue flow is the accepted rotation story).
- No automated skillpack sync (explicitly decided as manual/curated).
- No change to auto-install harness classes' token TTL or grant flow —
  no evidence this session that they're affected.
