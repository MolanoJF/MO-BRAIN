# Agent control MCP — spec

Status: **built (v1, phases 1–3)** on branch `MolanoJF/fulmar`, unreleased. Phase 4 (OAuth consent,
bootstrap code) is not built. The §8 probe has **not yet been run** — it needs a stack built from this
branch plus the owner credentials. §13 records where the build departs from §3–§5.

## 1. Goal

An agent (Claude Code, or any MCP client) should be able to operate most of Mo-brain on a member's behalf:
create a schema, add a source, rerun a schema sync, invite a member, grant a Space, change a schedule.
It must work the same on a self-hosted install and on a future hosted deployment. The console stays; it
is one client of the same operations, not the only one.

Non-goals: a second permission system; an admin superuser for agents; exposing gbrain's raw admin tools
to agents; any change to gbrain (it stays a pinned, unforked dependency).

## 2. Findings that shape the design

1. **gbrain's MCP already carries a lot** (`contracts/v0.60.104.0/capability.json`, 160 tools): page and
   search work, `whoami`, `sources_list/status`, `schema_lint`, `get_active_schema_pack`, and
   admin-scope tools (`schema_apply_mutations`, `reload_schema_pack`, `run_doctor`, …) plus a separate
   `sources_admin` scope (`sources_add`, `sources_remove`). Mo-brain's agent allowlist
   (`src/agent/tools.ts`) deliberately leaves the admin lane out.
2. **gbrain cannot be extended.** `/mcp`, `/authorize`, `/token`, `/register`, `/revoke` belong to
   `gbrain-serve` (Caddyfile). It is pinned and never forked; no extension point exists in the contracts.
3. **Most Mo-brain operations are not gbrain operations.** Sorted by what they touch:

   | Bucket | Operations | Home |
   |---|---|---|
   | A. Pure gbrain | page/search, `whoami`, read the schema, `sources_list/status`, lint | existing `/mcp` |
   | B. gbrain action + Mo-brain state | source add/rename/archive/remove/push; pack create/fork/mutate/assign/apply/sync; Connection issue/revoke | control plane |
   | C. Mo-brain only | members, invites, org mode, `space_grants`, schedules and runs, spend, upgrades, backup, provider keys | control plane |

4. **Bucket B cannot be the raw gbrain tool.** The wrapper owns invariants gbrain does not know: the
   `spaces` row, `space_grants`, the git scaffold (`gitScaffold`), the encrypted credential row,
   company-mode gating (`requireCapability`), the preview-before-apply step, and `audit_log`. A source
   added over MCP would be an orphan the control plane cannot repair — it holds no brain DB credentials
   (S2). gbrain's `admin` scope is also much wider than "configure Mo-brain" (`submit_job`,
   `purge_deleted_pages`, `migrate_embeddings`, `file_upload`).
5. **Every route already enforces a role** (`requireRole` in `src/control/rbac.ts`; `guard('admin')` etc.),
   but only understands a browser session. That is the single reason an agent cannot call them.

## 3. Decisions

**D1. A separate control MCP, served by the control plane, not merged into `/mcp`.**
Endpoint `POST /api/control-mcp` (already routed to `control-plane` by the existing `handle /api/*`; no
Caddy change). Rejected: a merging proxy in front of `gbrain-serve` (couples us to gbrain's protocol and
OAuth discovery on every pin bump, one bug takes the data lane down, and it mixes a Space-scoped data
credential with a role-scoped control identity).

**D2. One credential: the member's existing Connection token.** The control plane identifies the caller by
asking `gbrain-ops` (`POST /mcp/whoami`, ops-net) to present the bearer to `gbrain-serve`'s published
`whoami` tool (read scope, MCP). The control plane has no network route to `gbrain-serve` (brain-net
only); ops already dials it for `get_usage`. The gbrain-CLI operations allowlist is unchanged. gbrain does the
cryptographic verification and returns `client_id`. The control plane maps `client_id` →
`connections.gbrainClientId` → `membershipId` → role. No introspection endpoint, no gbrain table reads.
Cache a successful resolution for a short TTL (≤ 60 s) keyed by a hash of the token, never by the token.
**UNVERIFIED — see §8 (probe) and §9 (fallback).**

**D3. The tool list is generated from, and executes through, the existing routes.** Each tool calls the
same service function the route calls, with the resolved `{userId, orgId, role}`, so the console and the
agent cannot drift and there is no second permission check to maintain. `tools/list` is filtered by role:
a `viewer` agent sees almost nothing, an `owner` agent sees everything in §5.

**D4. Bucket A stays on `/mcp`.** A `mobrain-operator` skill, shipped in Mo-brain's `skills/` folder, which the
agent installs into its own skills folder during onboarding (Stage 3 of `docs/runbooks/onboarding.md`), tells the
agent which server to use for which task. `/my/mcp` returns both server entries in its handoff snippet.

**D5. Runner and per-run tokens are refused.** `agent-runner` reads untrusted content; a prompt-injected
run must never be able to invite members or change schemas. The control MCP rejects any token whose
`client_id` does not map to an `active` Connection of a human membership (`connections.state = 'active'`).
This is asserted by a test, and is consistent with HANDOFF ("the runner is a client of the control plane
for runs only").

**D6. Destructive and irreversible operations are gated, not hidden.** They require a `confirm` argument
that echoes a server-computed `confirmToken` returned by a prior dry-run/preview call. v1 omits entirely:
`DELETE /connections/:id` (does not exist), `sources.remove` with `confirmDestructive`, offboarding a
member, `restore`, and any `down -v`-class operation.

**D7. Every call is audited as the agent, owned by the human.** `audit_log` rows get
`actor = <membership user>` and a `via = control-mcp:<client_id>` detail, written through the same
`audit()` helper the routes use. Failed and refused calls are audited too.

## 4. Architecture

```
agent ──/mcp────────────► Caddy ► gbrain-serve        (data lane, unchanged)
  │
  └─/api/control-mcp────► Caddy ► control-plane
                                    1. bearer ──whoami──► gbrain-serve   (verify, get client_id)
                                    2. client_id → connections → membership → role
                                    3. tool → existing service fn (same as the route) → ops RPC / DB
                                    4. audit()
```

New code is a thin module (`src/control/mcp/`): transport (Streamable HTTP, stateless), token resolver
(`resolveCaller(bearer)`), a tool registry (name, input schema, min role, handler), and the audit wrapper.
Handlers call extracted service functions; where a route currently inlines its logic (e.g.
`routes/schema.ts` is 974 lines), extract the function first with no behaviour change, then add the tool.

## 5. Tool set (v1)

Names are verbs on nouns; each lists min role and the route/service it wraps.

| Tool | Min role | Wraps | Gated (D6) |
|---|---|---|---|
| `org_get` | viewer | `GET /org` | |
| `org_set_mode` | owner | `PATCH /org/mode` | yes |
| `member_list` | admin | `GET /members` | |
| `member_invite` | admin | `POST /members` (company mode) | yes |
| `space_list` | viewer | `GET /spaces` | |
| `source_list` | admin | `GET /sources` | |
| `source_create`, `source_rename` | admin | `POST /sources` (company mode), `PATCH /sources/:id` | |
| `grant_list`, `grant_set` | admin | `GET /grants`, `PUT /grants` (company mode) | |
| `schema_get`, `schema_pack_list`, `schema_pack_show` | admin | `GET /schema`, `/schema/packs`, `/schema/packs/:name` | |
| `schema_validate`, `schema_lint`, `schema_preview` | admin | `POST /schema/validate`, `/lint`, `/preview` (no side effects) | |
| `schema_scaffold` | admin | `POST /schema/scaffold` (commits folders) | |
| `schema_pack_create`, `schema_pack_mutate` | admin | `POST /schema/packs`, `/schema/packs/:name/mutations` | |
| `schema_apply` | admin | `POST /schema/apply` | yes (preview = active pack + validate + lint) |
| `schema_sync` | admin | `POST /schema/sync` (the "rerun"; additive-only) | |
| `schedule_list`, `schedule_get` | viewer | `GET /schedules`, `/schedules/:id` | |
| `schedule_create`, `schedule_update`, `schedule_run_now` | member | `POST /schedules`, `PATCH /schedules/:id`, `POST /schedules/:id/run-now` | |
| `run_list`, `run_get` | viewer | `GET /runs`, `/runs/:id` | |
| `connection_list`, `connection_preview` | admin | `GET /connections`, `POST /connections/preview` | |
| `connection_create` | admin | `POST /connections` | yes (preview = `POST /connections/preview`) |

Min role always equals the wrapped route's `guard`; the route enforces it, and a test asserts the
registry agrees. `skill_catalog_status` is dropped (no route). `grant_set` never removes a grant.

Not in v1: member removal, Connection delete/revoke, backup/restore, upgrade execution, provider keys.

## 6. Distribution and onboarding

- Self-hosted and hosted are identical: the control MCP lives on the install's own domain.
- Connecting: `/my/mcp` already hands the member a credential and a harness snippet. Extend `present()` so
  the snippet declares both `mobrain-data` (`/mcp`) and `mobrain-control` (`/api/control-mcp`) with the
  same credential. No extra secret to copy.
- Later (phase 4): an OAuth consent flow on the control MCP so a client given only the URL opens a browser
  and the human approves. Not needed for v1 because the credential already exists.
- **Hosted/first owner:** `POST /api/auth/bootstrap` creates the first owner and returns 409 afterwards.
  On a public host, whoever calls it first becomes owner. Before any hosted offering, the install must
  gate it with a one-time bootstrap code printed by `install.sh`. (`INSTALL_FOR_AGENTS.md` / the install
  wizard were not re-read for this spec; confirm current behaviour first.)

## 7. Safety and threat model

- **Prompt injection from brain content.** An agent that reads pages and then holds control tools is the
  main risk. Mitigations: D5 (no runner), D6 (confirm gate), role ceilings (a `member` agent cannot touch
  anything admin), TTL from `compileConnection` (default 3600 s) bounds a leaked token, D7 audit.
- **Token scope creep.** A data token now also grants control for its owner's role. Keep default TTL; show
  in the console which Connections are control-capable; allow an admin to mark a Connection data-only
  (phase 3) — a Connection flag, not a new role.
- **Confused deputy.** The control plane never accepts a `userId` from a tool argument; identity comes only
  from the resolved token (same rule as `commitAsMember`).
- **No raw gbrain passthrough.** Tools call named service functions; `ops` allowlist (S2) is unchanged.

## 8. The probe (must pass before phase 1)

Unverified: that forwarding a member's bearer to `gbrain-serve` `whoami` returns a stable `client_id` that
equals a `connections.gbrainClientId`, and that per-run runner tokens are distinguishable.

Run against a dev stack built from this branch (not another checkout's stack, not the live install):

1. Provision a member Connection via the console or `scripts/connection-e2e.ts`; read its client id/secret
   from the handoff.
2. `POST {serve}/token` with `grant_type=client_credentials` → bearer.
3. `POST {serve}/mcp` `tools/call whoami` with that bearer → expect `{transport:"oauth", client_id, source_id, …}`.
4. Compare `client_id` with `connections.gbrain_client_id` (control-plane DB, read-only SELECT).
5. Repeat with a per-run runner token → record what `client_id`/name it returns and confirm D5 can refuse it.
6. Record latency of the `whoami` round-trip (decides the cache TTL).

Pass = steps 3–5 as expected. Record results in the PR, not in `docs/archive/`.

## 9. Fallback if the probe fails

Mo-brain issues its own control token: `POST /api/my/control-token` (member-authenticated by session),
stored hashed (argon2/sha-256 + pepper from the existing KEK scheme, domain separator frozen like the
others), carrying `membershipId` and expiry, revocable from the console. The control MCP and everything
above D2 is unchanged; only `resolveCaller` differs. Cost: a second secret per member to distribute.

## 10. Phases

0. Probe (§8). Decide D2 vs §9.
1. **Auth seam:** `resolveCaller`, `requireRole` accepts the resolved caller; tests for role ceilings, the
   runner refusal, revoked and pending Connections. No tools yet.
2. **Read-only tools** (`*_list`, `*_get`, `schema_*` reads) plus the `mobrain-operator` skill and the
   `/my/mcp` snippet change.
3. **Mutating tools** in this order: sources, grants, members, schema authoring, `schema_apply`/`sync`,
   schedules. Each adds the D6 gate and D7 audit. Connection "data-only" flag.
4. OAuth consent for the control MCP; bootstrap-code hardening for hosted installs.

## 11. Tests

Run locally, never by iterating through CI (`docs/runbooks/ci.md`): `bun run test:unit` and
`bun run test:contract:isolated`.

- Unit: role filtering of `tools/list`; every tool's min role matches its wrapped route's `guard`; a tool
  cannot be called with a `userId` argument; confirm-token mismatch refuses; company-mode refusals pass
  through as `company_mode_required`.
- Contract: a registry test that every tool maps to a route or service and every state-changing tool
  writes an `audit_log` row (a table-driven test, so a new tool without audit fails).
- Integration (dev stack, by hand): the §8 probe has not been written yet; end-to-end "create a
  schema → preview → apply → sync" as a member-admin agent lives in `test/contract/control-mcp.contract.test.ts`.
- Workflows: no new `schedule:`/push/PR workflows (`test/unit/workflows.test.ts`).

## 12. Open questions

1. Does `coding-agent` (the admin/owner profile) hold enough read scope for `whoami` on every Connection
   state? (`whoami` is `read`; expected yes.)
2. Do we want a per-tool-group opt-in (an admin enabling "schema tools" for agents) rather than all of §5
   by role? Default in this spec: by role only.
3. Streamable HTTP vs SSE for the transport, given Hono and Bun in the control plane; pick whichever the
   current MCP SDK supports statelessly.
4. Rate limits per Connection on the control MCP.

## 13. Review corrections (2026-10-10)

Adopted by `docs/superpowers/plans/2026-10-10-agent-control-mcp.md`.

- **Execution (replaces §4's "extract first").** A tool runs the existing route in-process
  (`app.fetch`) with the resolved caller carried in Hono `env` under a module-private Symbol.
  `requireRole` accepts that caller and applies the same rank check. Nothing is extracted.
- **Audit (D7).** There is no shared `audit()` helper (nine private copies). The control MCP writes
  one `control_mcp.call` row per `tools/call` (`actor` = user id, `after.via` =
  `control-mcp:<client_id>`, outcome, status, guard, argument keys only). Route rows are unchanged.
  A refused token that names someone writes `control_mcp.refused`.
- **Gate (D6).** A gated tool called without `confirm` returns a preview and a `confirmToken`
  (HMAC, 5 min, bound to tool, arguments, membership and a state fingerprint). `schema_preview`
  previews sync, not apply.
- **Runner refusal (D5).** Per-run tokens are their own OAuth clients (`agent_runs.gbrain_client_id`);
  `connections.server_client_id` is the server-side minting client. Both are checked and refused
  as `runner_token`.
- **Snippet (§6).** The data server key stays `gbrain`; `mobrain-control` is added for every harness.
- **Transport (Q3).** Hand-rolled stateless Streamable HTTP, JSON responses, protocol
  `2025-06-18`/`2025-03-26`, no batching, `GET` → 405. **Rate limit (Q4):** token bucket per token
  hash, burst 60, 1/s.
- **401.** `WWW-Authenticate: Bearer error="invalid_token"` with no `resource_metadata`: Caddy
  sends all `/.well-known/*` to gbrain-serve. Phase 4 (OAuth consent, bootstrap code) needs a Caddy
  change and a separate plan.
- **Contract reference.** The pin is `0.60.115.0` (`operations.json` only); `whoami`'s OAuth client
  key is pinned by the probe.
