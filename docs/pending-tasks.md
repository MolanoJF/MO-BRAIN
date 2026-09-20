# Pending tasks

> **As of Mobrain 1.0.0** (self-host GA, tag `v1.0.0`, 2026-09-19). This is the
> backlog left deliberately open when Slice 5 closed. Nothing here is hidden
> behind a green test — the source of truth is
> [`docs/slice-5-findings.md`](slice-5-findings.md)'s *Resolutions and deferrals*
> section, the roadmap's [Slice 6](../docs/superpowers/plans/2026-09-14-brainstand-roadmap.md#slice-6--managed-cloud-deferred)
> and *Open questions*, and `HANDOFF.md`. When this file and those disagree, they win.

Priority: **P1** blocks the next stage · **P2** hardening, no GA impact · **P3** observability/optional ·
**P4** housekeeping.

| # | Task | Owner slice | Priority | Blocking? |
|---|---|---|---|---|
| 1 | Measure the search-mode cost spread on a populated corpus; decide `tokenmax` reindex | Cloud/pricing (Slice 6) | P1 | **Blocks Slice 6 pricing** |
| 2 | `DELETE /api/connections/:id` for revoked Connections (F22) | Next hardening slice | P2 | No |
| 3 | Full D5 injected-`OpsCaller` cure for host-side scripts | Next hardening slice | P2 | No |
| 4 | Product path to retry a `lease_expired` agent run | Next runner slice | P2 | No |
| 5 | `runner_never_seen` alert kind has no product writer | Next hardening slice | P3 | No |
| 6 | `capability_snapshots` per-tenant rendering | Cloud slice (Slice 6) | P3 | No |
| 7 | Observability track: pre-cap alerting, queue-age p95, trended `doctor --json`, Prometheus/Grafana profile | Cloud/observability slice | P3 | No |
| 8 | Managed-cloud provisioner + billing (Slice 6) | Slice 6 | P1 | Needs #1 |
| 9 | Housekeeping batch (digest rot, stale `0.50.0.0` fallbacks, `package.json` name, dev-stack debt) | Whoever picks up next | P4 | No |

---

## P1 — Blocks the next stage

### 1. The search-mode cost spread, and the `tokenmax` reindex

Slice 5's Task 9 probe measured every mode's 20-query delta as `$0.0000000` on a 7-page corpus, so
per D7 `SEARCH_MODES[].measuredCost` stays **`null`** and the wizard says *"not measured on this
deployment"* rather than printing upstream's 25×. That is the honest state, not a bug — but it is
also the arithmetic managed-cloud pricing depends on (**Open Question 2**).

Related defect F21 renamed the vocabulary to the pinned binary's real values
(`conservative | balanced | tokenmax`), but the product does **not** run the pinned binary's
`gbrain reindex --markdown` backfill when a brain switches to `tokenmax`, so existing pages are not
re-synopsised until an operator runs it by hand.

**Do:** populate a real corpus, re-run `scripts/measure-search-modes.ts`, write the measured ratio
(and its date/corpus) into `src/control/lifecycle.ts`, then decide whether the `tokenmax` backfill
becomes a product step. Reference: P5 and the *Resolutions and deferrals* row in
[`slice-5-findings.md`](slice-5-findings.md).

### 8. Slice 6 — Managed cloud

No plan exists yet; it must be written at its own gate. **Substrate is decided (D12): one VM per
tenant**, provisioned through a cloud provider API and installed by running **this release's
`install.sh` over SSH**, with the stack's own backup/restore and upgrade lanes operated per tenant.
Rejected: a shared fleet of compose projects per host, and Kubernetes (it forks the deployment
artifact). **N stacks, not one stack with tenants** — gbrain is single-brain-per-`GBRAIN_HOME`.
Upgrade automation is load-bearing for the business model. Billing is deliberately not built yet and
is downstream of #1. Reference: roadmap *Slice 6*, D12 in
[`2026-09-18-slice-5-self-host-ga.md`](../docs/superpowers/plans/2026-09-18-slice-5-self-host-ga.md).

---

## P2 — Hardening backlog

### 2. Purge a revoked Connection (F22)

There is no `DELETE /api/connections/:id` route and no console control, so a revoked Connection
survives until its member is offboarded — and offboarding cascades, which cannot happen while a live
schedule still holds that member's Connection. Measured during Task 14 (two revoked rows remain,
visible and inert).

**Do:** add `DELETE /api/connections/:id` for `state = 'revoked'` only, with the schedule interaction
decided *in the route* (the audit survives by design — `agent_runs.connection_id` is
`on delete set null`), a console control, and a test. Deliberately not built during cleanup (D11).

### 3. Full D5 injected-caller cure

F32 fixed the measured leak (ops URL/token now resolved at call time), but the host-side spend read
still reaches `src/control/opsClient.ts` directly instead of through an injected `OpsCaller`. A
future file that mutates other module-level state could still race a sibling in Bun's shared test
process.

**Do:** route the remaining host-side call sites through the injectable caller shape
`src/control/opsCaller.ts` established in Task 1.

### 4. Retry a `lease_expired` agent run

No product path retries an agent run whose runner died and whose lease expired (Slice 4's F15). The
retry policy exists and the class is classified; nothing calls it. Gate C's second attempt is written
by the gate, not the product. Changing retry semantics is runner behaviour, which Slice 5's D13 froze,
so it was left for a runner slice.

---

## P3 — Observability and optional surfaces

### 5. `runner_never_seen` alert kind has no product writer

The claim-refusal code of the same name is a different surface. The runbook states this rather than
implying a writer exists. Cosmetic.

### 6. `capability_snapshots` per-tenant rendering

Carried from Slice 3.5: the writer exists, the per-tenant view does not. Not load-bearing for a
single self-host deployment; D12's one-VM-per-tenant shape decides whether it is ever needed.

### 7. Observability track (deliberately out of GA)

Each needs a time series the product does not have, so adding one for GA would have been a subsystem,
not a slice:

- alerting **before** the hard cap stops an agent mid-run (the cap itself ships and alerts — Slice 4 C9);
- run queue-age p95;
- `doctor --json` trended over time rather than one-shot;
- an optional Prometheus/Grafana **compose profile** (note: Task 8 deliberately made `/metrics` *no
  more* public; C1 pins the negative — public `/metrics` is `401`).

Spend per member and per org **already shipped** (Slice 5 Tasks 10–12) because cost attribution is a
headline feature.

---

## P4 — Housekeeping discovered during the Slice 5 close

- **Digest rot.** The `publish` job runs on every push to `main`, and image builds are not
  bit-reproducible, so the tags/digests in `CHANGELOG.md`/`HANDOFF.md` move on each push. Either move
  publishing to a tag/release trigger, or re-record digests after a push. Documented in `PROGRESS.md`.
- **Remaining stale pin fallbacks.** `src/ops/dispatch.ts:11` and `src/upgrade/snapshot.ts:239` still
  fall back to `'0.50.0.0'` (the Slice 5 close fixed `scripts/backup.ts`, `scripts/emit-operations.ts`,
  `scripts/upgrade.ts`, and `docker/control-plane.Dockerfile`). Also the compose `:-dev` fallback and
  `scripts/upgrade.ts:869`'s `?? 'dev'`; a default install now always supplies `APP_VERSION=1.0.0`, so
  these are last-resort only.
- **`package.json` name is still `brainstand`.** Low value and entangled with the legacy
  `BRAINSTAND_*` aliases and the frozen `COMPOSE_PROJECT_NAME` default; skipped deliberately.
- **Dev-stack D11 debt is back.** A destructive e2e cycle restored an older control-DB snapshot, so the
  dev stack again carries ~10 memberships, ~10 Connections, two open alerts and eight pending
  `0.50.2.0` checklist items. It is clearable through product paths (`/upgrades`, `/schedules`, the
  members surface) — see Task 14's procedure — and is stated in `HANDOFF.md`, not hidden.
- **P8's wire-level gap.** The new-domain restore's OAuth issuer/redirect-URI **rejection** is
  documented, not measured, because no alternate hostname resolves on the dev host. A real DNS name
  would close it.
- **Upstream relationship.** The product name was decided (**Mobrain**); the still-open half of Open
  Question 3 is *whether to approach upstream before or after launch*, plus a lawyer's eye on naming
  and positioning ("built on gbrain" is a claim about someone else's active project).
- **Opportunistic upstream contributions** that would shrink our maintenance surface: a production
  Dockerfile + reference compose, and bearer auth for `/admin/api/*`.

---

## Open questions (carried)

1. **Many sources at scale** — search fan-out, `federated_read[]` length, repo count. Probed at Slice 2
   with a synthetic 25-Space brain; revisit before committing hard to Space-per-boundary at scale.
2. **Managed-cloud pricing vs the search-mode cost spread** — **still open after 1.0.0**; this is task
   #1 above and it blocks Slice 6.
3. **Product name / upstream approach** — name decided; the approach timing and legal review remain.

---

## Explicitly NOT pending

Not a backlog item, so nobody re-opens it: every Slice 5 defect **F20–F32** is **fixed** (except the
documented deferrals above); the eight verification commands are green on the frozen tree; Gate A is
green in CI on an un-seeded runner; the nightly drift tripwire has been seen to fire and seen not to
duplicate; and Mobrain 1.0.0 is tagged, published, and pulled by digest on a fresh runner.
