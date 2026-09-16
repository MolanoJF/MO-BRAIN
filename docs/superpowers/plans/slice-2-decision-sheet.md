# Slice 2 — Decision Sheet

**Purpose:** fill this in and hand it to the Slice 2 agent alongside the kickoff prompt.
Every item has a **Recommended** answer and a **Cost if wrong**. Leave a line blank and
the agent applies the recommendation; it does **not** guess on the items marked **BLOCKING**.

**How to use:** put your choice on the `Decision:` line. Delete the options you reject or
just write the label. `[accept recommended]` is valid if you agree.

---

## A. Blocking decisions (the agent will stop and ask if these are blank)

### A1 — Canonical provisioning primitive
Which upstream operation creates a Connection?
- Options: `mcp grant` · `auth register-client` · `agent register`
- **Recommended:** `mcp grant`. It is harness-aware (S4's Connection includes a harness),
  supports `--dry-run --json` for the confirm screen, and is already contract-tested.
  `auth register-client` is the fallback if `mcp grant`'s harness coupling proves too rigid.
- **Cost if wrong:** the credential artifact and the entire connection-builder UI are built
  on the wrong primitive; rework is a task, not a rewrite.

- **Decision:**
- **Rationale (optional):**

### A2 — Revoke operation
`gbrain auth revoke-client <client_id>` exists upstream (hard-deletes the client, cascades
to tokens and codes) but is **not in `src/contracts/registry.ts`**. Add it?
- Options: add `auth.revokeClient` to the allowlist + contract test · use `auth revoke --id` (tokens only) · other
- **Recommended:** add `auth.revokeClient` + a contract test (G4). Audit every revocation to
  the existing `audit_log` before the delete, since the delete is irreversible.
- **Cost if wrong:** Slice 2 ships grant without revoke — the exact thing the spec forbids
  ("revoke in the same sprint as grant"), and outstanding tokens cannot be killed.

- **Decision:**
- **Audit policy:** (recommended: record client_id, actor, timestamp, and the read/write
  set being revoked in `audit_log` before the hard delete)
- **Rationale (optional):**

### A3 — Claim link: what is it, and when is the client created?
S4 says *one install flow emits N MCP entries from a single claim link*.
- Options: claim link **is** the invite, provision at claim time · invite separate, provision
  at assignment, hold sealed until claim
- **Recommended:** one link per **member** (delivers all their Connections at once);
  **provision at claim time** so no live OAuth client exists for an unclaimed invite.
  Email-bound, TTL 24h, burn on fetch, store a hash only, never the token.
- **Cost if wrong:** provision-at-assignment leaves unclaimed live clients to reap
  (security smell); separate invite/link doubles the state machine and the UX.

- **Decision:**
- **TTL:** (recommended 24h)
- **Email-bound?** (recommended yes)
- **Rationale (optional):**

### A4 — OAuth client naming scheme
Upstream refuses duplicate client names and offers `--reissue` to rotate.
- **Recommended:** deterministic `bs-<memberId8>-<spaceSlug>` (collision-free, traceable in
  `auth clients` and in audit). Never use `--reissue` to resolve a collision — reissue is
  rotation, and **rotation is not revocation**.
- **Cost if wrong:** duplicate-name failures mid-provision, or silent identity confusion in
  the audit trail.

- **Decision:**
- **Rationale (optional):**

### A5 — RBAC source of truth
- Options: adopt Better Auth's organization + RBAC plugin as canonical (migrates tables) ·
  layer the plugin over our existing `organizations`/`memberships` (plugin does not own them)
- **Recommended:** **layer.** Keep our CHECK-constrained tables canonical; enable the plugin
  only for session/permission ergonomics and map onto our tables. Our tables already have
  tests and constraints; the plugin's schema is a migration of a running system.
- **Cost if wrong:** two sources of truth for membership if the plugin silently writes its own
  tables — explicitly alias or disable those tables to prevent it.

- **Decision:**
- **Rationale (optional):**

### A6 — Clean VM + real API spend (see also B1/B2)
- **Recommended:** run the exit gate on a clean Linux VM, not the Windows dev machine; the
  embedding/search path calls a real provider and costs real money.
- **Decision:** (clean VM available? yes/no · authorize provider spend? yes/no)

---

## B. Human-only authorizations (the agent cannot supply these)

- [ ] **B1 — Provider key + budget.** The exit gate runs real `init`/`embed`/`search`.
      Authorized to spend? Ceiling: __________
- [ ] **B2 — Clean VM.** Roadmap exit gate says "on a clean VM, not a dev machine."
      Provided? yes/no
- [ ] **B3 — Orchestrator + model.** Which harness runs Slice 2, and is
      `superpowers:subagent-driven-development` installed? __________
- [ ] **B4 — Docker Desktop** started manually (and per the Slice 1 notes, PATH may need a prefix).
- [ ] **B5 — Upstream identity**, **only if** you choose to upstream the `.connection` fix (A9).
- [ ] **B6 — Product naming** before any user-facing copy ships ("brainstand" is a codename).

---

## C. Non-blocking decisions (agent applies the recommendation if blank)

### C1 — Personal vs company mode in Slice 2
- **Recommended:** defer. Company-first; personal is a derived flag for a later slice.
- **Decision:**

### C2 — Compiler placement
- **Recommended:** a **pure, shared** module (`src/contracts/compile.ts`), no DB and no
  spawn, imported by both the control plane (for the dry-run diff) and ops. The spec's
  `ops/compile.ts` puts I/O-free logic behind an RPC boundary for no reason.
- **Cost if wrong:** a file location; consumers import by name.
- **Decision:**

### C3 — Harness picker: hardcode vs upstream
`.connection` is stripped from `publicHarnessMetadata()` (V10).
- **Recommended:** hardcode the id→class map now, with a drift test that fails when
  `.well-known` returns an adapter id not in the map. File the upstream fix as a follow-up.
- **Cost if wrong:** the map silently misses a new adapter — the drift test is what bounds it.
- **Decision:**

### C4 — Revocation is a hard delete
- **Recommended:** accept it; the `audit_log` entry from A2 is the durable record.
- **Decision:**

### C5 — Open Q1 decision rule
The 25-Space synthetic brain measurement needs a *rule* before it runs.
- **Recommended:** define "degrade" up front (search p95 latency and recall against the
  1-Space baseline); if it degrades past the threshold, **stop and escalate** rather than
  redesign Space boundaries inside Slice 2.
- **Decision / threshold:**

---

## D. Design artifacts the agent must produce — review these, no decision needed now

- The **confirm-screen diff** (honesty rules as a readable before/after; must show that a
  write fence also disables fact extraction/ingestion).
- The **Connection mental model** in the UI (member → N Connections; two write Spaces = two
  Connections made obvious).
- **Offboarding**: what happens to a departing member's Connections and their write Space.
- **Per-harness wiring** output for the 13 adapters (template per adapter vs one generic snippet).
- The **access overview** (who can read/write what).

---

## E. Defaults the agent will assume if a section is blank

1. Provision via `mcp grant` (dry-run confirm first).
2. Add `auth.revokeClient` + audit-before-delete.
3. One claim link per member, provision at claim, 24h, email-bound, hash-only, burn on fetch.
4. Deterministic client names; never reissue to fix a collision.
5. Layer RBAC; our tables stay canonical.
6. Defer personal mode; compiler in `src/contracts/compile.ts`; hardcode the harness map.

If any of these is not what you want, write it on the relevant `Decision:` line.
