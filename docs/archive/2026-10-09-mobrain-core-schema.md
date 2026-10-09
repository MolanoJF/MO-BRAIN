# Plan: `mobrain-core` as the foundation of every Mo-brain schema

Status: Phase 1 implemented (contract probes not encoded as tests; probed by hand against gbrain 0.60.115.0). Deviation: the `event` `attendees` frontmatter rule was dropped from core, because gbrain stores it event → person, the reverse of meetings (fact 9). Date: 2026-10-09. gbrain pin: `0.60.115.0`.

## Goal

Replace `mobrain-personal` as the default schema with a minimal, domain-neutral
`mobrain-core`. Every Mo-brain schema (Personal, Company, and every schema a
user creates) extends core. Core's types and link verbs can't be removed or
redefined by any pack built on it.

## Decisions already made

| # | Decision |
|---|---|
| D1 | `mobrain-core` is the default pack for every new brain. A new Space follows the brain's pack. |
| D2 | Every Mo-brain pack's `extends` chain must end at `mobrain-core`. `gbrain-base-v2` stays available as a labeled gbrain fallback, not a Mo-brain schema. |
| D3 | Core's entries can't be removed or redefined by any child, including Mo-brain's own Personal and Company packs. A child adds new types and verbs. It never edits core's. |
| D4 | `project` is in core. `decision` is not. |
| D5 | Editing core goes to the layer `my-brain` (extends core). Editing Personal goes to `my-personal` (extends Personal). |
| D6 | Core's link verbs are general relations, not gbrain's investor vocabulary. Domain verbs belong to child packs. |
| D7 | Existing brains will be rebuilt from scratch. No data migration and no backward-compatibility code. |

## gbrain facts this design relies on

Read at tag `v0.60.115.0`. Each one gets a contract probe in Phase 1, Task 8.

1. **Merge contract** (`src/core/schema-pack/merge.ts`). For inherited fields the child wins, keyed per field:
   - `page_types` and `link_types` by `name`
   - `frontmatter_links` by `(page_type, link_type)`
   - `enrichable_types` by `type`
   - `filing_rules` by `kind`

   `takes_kinds` is a union, so it can't be narrowed. `borrow_from` outranks parents. **Nothing in gbrain stops a child from redefining a parent's type**, so Mo-brain has to enforce D3 itself.
2. **Type order.** The root pack (`extends: null`) forms the tail in its declared order. New types from any child are put ahead of it, nearest pack first. Prefix matching is a substring test that stops at the first hit (`markdown.ts:1101`), so a child's types win on nested paths.
3. **A missing `extends` falls back to `gbrain-base`.** Core must say `extends: null` explicitly.
4. **Types gbrain writes or falls back to by itself:**

   | Type | Where gbrain needs it |
   |---|---|
   | `concept` | Fallback for any path that matches no prefix (`markdown.ts:1093,1110`) |
   | `note` | Default for `capture` |
   | `atom` | Atom extraction |
   | `synthesis` | `think` |
   | `extract_receipt` | Fact extraction |
   | `conversation` | Transcript import |
   | `event` | Life Chronicle, which is on by default and writes under `life/events/` |
   | `meeting` | Attendance prior |
   | `source` | Meeting transcript sidecar |
   | `person`, `company` | Enrichment, expert routing, frontmatter map |
5. **Built-in verbs can't be switched off.** Prose extraction emits `works_at`, `founded`, `invested_in` and `advises` whatever the pack says (`link-extraction.ts:1242`, `VERB_RULES`). A pack can only get in first with its own `inference.regex`. A pack `frontmatter_links` entry *does* replace the hardcoded mapping for that field (`link-extraction.ts:1786–1798`).
6. **Explicit links are checked against the pack.** An explicit `add_link` or `capture` with a verb or type the pack doesn't declare is rejected (`write-vocabulary.ts`, #4655). Extractor-emitted edges are not checked.
7. **Typed reads across packs are refused.** A type-filtered read across sources that resolve different packs fails (`query-types.ts:17`). Plain search is unaffected.
8. **Relationship lifetimes can be declared.** `link_types[].temporal: state | event` gives a verb a lifetime. `state` means the relation holds over a period and can end. `event` means it happened on a date.
9. **Frontmatter link direction.** A verb with no built-in counterpart in `FRONTMATTER_LINK_MAP` is stored outgoing (page → target). `meeting.attendees → attended` is incoming (person → meeting).

## Target design

### `src/ops/packs/mobrain-core.json` (version `1.0.0`)

Types, in this order (the order is prefix priority):

| # | Type | Primitive | Path prefixes | Aliases | Extractable | Expert routing |
|---|---|---|---|---|---|---|
| 1 | `person` | entity | `people/`, `person/` | | ✓ | ✓ |
| 2 | `company` | entity | `companies/`, `company/`, `orgs/` | | | ✓ |
| 3 | `meeting` | temporal | `meetings/`, `meeting/`, `calls/` | | ✓ | |
| 4 | `conversation` | temporal | `conversations/`, `emails/`, `chats/` | | ✓ | |
| 5 | `event` | temporal | `events/`, `life/events/`, `calendar/` | `calendar-event` | | |
| 6 | `project` | concept | `projects/`, `project/` | | | |
| 7 | `concept` | concept | `topics/`, `wiki/concepts/`, `wiki/concept/` | | ✓ | |
| 8 | `note` | concept | `notes/`, `note/`, `inbox/` | | ✓ | |
| 9 | `source` | media | `sources/`, `source/`, `media/`, `articles/`, `books/`, `podcasts/`, `videos/` | `media` | ✓ | |
| 10 | `atom` | annotation | `atoms/` | the five atom aliases | | |
| 11 | `synthesis` | annotation | (none) | | | |
| 12 | `extract_receipt` | annotation | `extracts/` | | | |

`atom` keeps the three subtypes it has today (`extraction`, `manual`, `lore`).

Link verbs:

| Verb | Inverse | Temporal | Inference |
|---|---|---|---|
| `relates_to` | `relates_to` | | |
| `mentions` | | | |
| `discusses` | | | |
| `part_of` | `has_part` | state | |
| `member_of` | `has_member` | state | |
| `attended` | `attended_by` | event | `page_type: meeting` (as `mobrain-personal` declares it today) |
| `created_by` | `created` | event | |
| `owned_by` | `owns` | state | |
| `derived_from` | | | |
| `supersedes` | `superseded_by` | | |

Frontmatter links:

| Page type | Fields | Verb |
|---|---|---|
| person | `company`, `companies`, `organization` | `member_of` (replaces the hardcoded `works_at`) |
| meeting | `attendees` | `attended` |
| event | `attendees` | `attended` (direction probed in Task 8; dropped if it stores event → person) |
| project | `parent` | `part_of` |
| project | `owner` | `owned_by` |
| source | `author`, `authors` | `created_by` |
| note | `author`, `authors` | `created_by` |

Other fields:
- **Enrichable:** `person` (rubric `person-default`) and `company` (rubric `company-default`).
- **Filing rules:** one per user type (types 1–9), with neutral descriptions. System types get none, as today.
- **`takes_kinds`:** `fact`, `take`, `bet`, `hunch` (gbrain's default; can't be narrowed).
- `extends: null`, `borrow_from: []`.

### `src/ops/packs/mobrain-personal.json` (version `2.0.0`, `extends: "mobrain-core"`)

Personal declares only what it adds.

- **Types:** `journal`, `area`, `goal`, `decision` (annotation), `idea`, `writing`, `health_record`, `finance_record`, with today's prefixes. Optional fix: rename `journal` → `diary` with prefixes `journal/` and `life/diary/` and alias `journal`. gbrain's Chronicle checks `type === 'diary'` literally (`hybrid.ts:450`, `chronicle/eligibility.ts:84`).
- **Verbs:** `works_at`/`employs`, `founded`/`founded_by`, `advises`/`advised_by`, `introduced`/`introduced_by`, `belongs_to`/`contains`, `serves`/`served_by`, `contributes_to`/`contributors`, `affects`/`affected_by`, `decided_in`, `provider_for`/`provided_by`, `owes_to`, `awaiting_reply_from`.
- **Dropped:** `authored` (core's `created_by` replaces it), `sourced_from` (core's `derived_from`) and `redirects_to` (nothing in gbrain's code uses it).
- **Frontmatter links:**
  - `area` → `belongs_to` on goal, project, event, health_record and finance_record
  - project `goal` → `serves`
  - decision `project`/`goal` → `affects`
  - decision `meeting` → `decided_in`
  - writing `author(s)` → `created_by`
  - idea and writing `sources` → `derived_from`
  - health and finance `provider` → `provider_for`
- **Filing rules:** one per Personal type.

### Pack families after the change

```
mobrain-core (managed, locked)
├── my-brain                (layer; created on the first edit of core)
├── mobrain-personal (managed)
│   └── my-personal         (layer)
├── mobrain-company (managed, Phase 2)
└── <any user pack>         (must reach mobrain-core)
gbrain-base-v2              (gbrain fallback, labeled; not a Mo-brain schema)
company-brain               (gbrain pack; visible until Phase 2 replaces it)
```

### The core lock (rules L1–L5)

These apply to every pack except `mobrain-core`, Mo-brain's own managed packs included.

| Rule | Check | When |
|---|---|---|
| L1 | The `extends` chain (raw manifests, at most 8 hops) reaches `mobrain-core`. | Before writing and before activating |
| L2 | Its own `page_types` and `link_types` don't use a core type name, core verb or core inverse. | Before writing |
| L3 | Its own `frontmatter_links` don't map a `(page_type, field)` pair that core maps. Its own `enrichable_types` and `filing_rules` don't key a core type. | Before writing |
| L4 | `borrow_from` is empty for user packs. Managed packs may borrow, and L5 still holds. | Before writing |
| L5 | The **resolved** manifest contains every core entry, and each one's projection equals core's own. | After writing, and before activating |

L5's projection compares these fields:
- Types: name, primitive, prefixes, aliases, extractable, expert_routing
- Verbs: name, inverse, temporal
- Frontmatter links: key and fields
- Filing rules: kind and directory
- Enrichable types: type

Rules L1–L4 catch problems early with good error messages. L5 is the authority, because it reads gbrain's own merge output.

**On an L5 failure after a write:**
- A newly created pack is removed.
- A replaced pack is restored from the raw manifest read before the write, in the format it was read.
- Gbrain mutation batches are atomic and can't be undone from outside. For them, L2–L3 run before the batch; if L5 still fails, it's reported as an error and the pack can't be activated.

Refusal code: `CORE_LOCKED`. Message pattern: `"<name> comes from mobrain-core and can't be changed. Add a new type instead."`

## Phase 1: core, Personal on core, enforcement

Each task names its files and tests. Work on a short branch off `main` in `~/MO-BRAIN` and test against `mobrain-dev` only.

### Task 1: Write the core pack and rebase Personal onto it
- Add `src/ops/packs/mobrain-core.json` as specified above.
- Rewrite `src/ops/packs/mobrain-personal.json` as the 2.0.0 delta.
- Tests:
  - New `test/unit/mobrain-core-pack.test.ts`:
    - Identity, and explicit `extends: null`.
    - The 12 types in order.
    - Every type gbrain needs (fact 4) is present.
    - The 10 verbs and their inverses.
    - Every frontmatter link names a declared type and verb.
    - Filing rules cover exactly types 1–9.
    - Only `person` and `company` are enrichable and expert-routed.
    - No VC verb (`works_at`, `founded`, `invested_in`, `advises`, `led_round`, `yc_partner`) is declared.
  - Rewrite `test/unit/mobrain-pack.test.ts` for Personal:
    - `extends === 'mobrain-core'`.
    - No core name appears among its own types, verbs or inverses (L2).
    - No `(page_type, field)` pair overlaps core's (L3).
    - Its own frontmatter links point at types and verbs declared in Personal ∪ core.

### Task 2: Pack policy constants (`src/contracts/packs.ts`)
- `MANAGED_PACKS = ['mobrain-core', 'mobrain-personal']`, in seeding order.
- `CORE_PACK = 'mobrain-core'`.
- `LAYERS: Record<managed, layer> = { 'mobrain-core': 'my-brain', 'mobrain-personal': 'my-personal' }`, plus `layerFor(parent)` and `isLayerPack(name)`. This replaces `LAYER_PACK`/`LAYER_PARENT`.
- `GBRAIN_FALLBACK_PACKS = ['gbrain-base-v2', 'company-brain']`. These are activatable without L1/L5 and labeled as gbrain packs. `company-brain` leaves this list in Phase 2.
- Add `'company-brain'` to `BUNDLED_PACKS`. It's gbrain-bundled but missing from the list today, so the console wrongly treats it as an editable user pack. Add it to `VISIBLE_BUNDLED_PACKS` too, until Phase 2.
- Reserve names: the `mobrain-` prefix, every layer name, every bundled name.
- Update `test/unit/packs-policy.test.ts`.

### Task 3: Seeding (`src/ops/fileplane.ts` `seedManagedPacks`)
- Core is written before Personal. The loop already follows `MANAGED_PACKS` order, so this is just a test assertion.
- `test/unit/fileplane.test.ts`:
  - Both packs are seeded in order.
  - A version bump on either one rewrites only that one.
  - `writeSchemaPack`/`removeSchemaPack` still refuse both managed names.

### Task 4: The core lock module (new `src/control/coreLock.ts`)
- Pure functions:
  - `coreProjection(manifest)`
  - `ownViolations(rawManifest, core)` for L2–L4
  - `resolvedViolations(resolvedManifest, core)` for L5
- An async function `chainReachesCore(name, showRaw)` for L1. It walks raw `extends` through the injected `schema.showRaw` caller, with cycle and depth guards.
- Core is imported from `src/ops/packs/mobrain-core.json`. Both planes live in the same image, so there's one source of truth.
- New `test/unit/core-lock.test.ts`, one case per rule:
  - A redeclared `person`.
  - A redeclared `part_of` and a redeclared `has_part`.
  - Child `(person, works_at)` on field `company` (L3 overlap).
  - A child filing rule for `note`.
  - A non-empty `borrow_from`.
  - Chains: one ending at `gbrain-base-v2`, one ending at `null`, a cycle, depth 9.
  - A clean user pack.
  - Personal 2.0.0 passes.

### Task 5: Enforce on every write path (`src/control/routes/schema.ts`, `src/control/schemaDraft.ts`, `src/control/routes/wizard.ts`)

| Path | Change |
|---|---|
| `validateDraft` | `extends` is required and non-null. Drafts with a core-named type or verb are refused (L2). |
| `draftToManifest` | Keeps `borrow_from: []` and `frontmatter_links: []`. Unchanged. |
| `POST /schema/packs` mode `draft` | Rejects an `extends` that doesn't reach core (L1). After the write: L5, and remove the pack on failure. |
| `POST /schema/packs` mode `fork` | Refuses bundled and managed sources: a fork copies the raw manifest, so forking core would produce an unlocked copy. Allows forking user packs whose chain reaches core. L5 after. |
| `PUT /schema/pack` (raw YAML) | Parse with the `yaml` dependency already in `package.json`, run L1–L4, write, then L5 and restore on failure. Read the previous raw manifest first. |
| `POST /schema/packs/:name/mutations` | Generalize the `INHERITED_READONLY` check from the layer to **every** user pack. Refuse an `add_type`/`add_link_type` with a core name as `CORE_LOCKED`. Redirect managed → `layerFor(name)`, so core goes to `my-brain` and Personal to `my-personal`. The auto-activation after the first edit uses the same map. L5 after. |
| `POST /schema/apply`, `POST /schema/sources/:id`, wizard `POST /schema` (both branches) | Activation gate: the pack is in `GBRAIN_FALLBACK_PACKS`, or it passes L1 and L5. Otherwise 400 `CORE_LOCKED`. |
| `src/control/bootstrap.ts` | `DEFAULT_SCHEMA_PACK = 'mobrain-core'`. The wizard's finish step picks it up unchanged. |

- Copy edits: the layer description string, plus the error texts that name `mobrain-personal`.
- Tests:
  - `test/integration/schema-routes.test.ts` (about 50 references) and `test/integration/wizard.test.ts`: update names and add one refusal test per row above.
  - `test/integration/auth.test.ts` and `test/unit/wizard-finish.test.ts`: the default pack name.
  - Mocks are in `test/helpers/opsMock.ts`.

### Task 6: Console (`src/console/pages/Schema.tsx`, `SchemaBuilder.tsx`)
- The pack list shows core as "Mo-brain core · base of every schema · locked", and Personal as "extends core".
- Labels:
  - `GBRAIN_FALLBACK_PACKS` are labeled "gbrain pack · not built on Mo-brain core".
  - `editLabel`: managed → "Customize", bundled → no edit action.
- **New schema:** the "Builds on" select lists only packs that reach core, defaulting to `mobrain-core`, with no "none" option.
- **Templates:** "Start from template" forks only user packs.
- **Import draft:** a draft whose `extends` doesn't reach core shows the server's refusal.
- **Inherited rows:** show a lock badge "from mobrain-core". `MANAGED_EDIT_NOTE` becomes per-parent ("Your changes go into my-brain …").
- Update `test/unit/console-schema.test.ts`.

### Task 7: Designer skill (`skills/mobrain-schema-designer/`)
- `SKILL.md` §3:
  - `extends` is `"mobrain-core"`, or `"mobrain-personal"` for a personal-life brain. Never `null`, never a gbrain pack.
  - List core's 12 types and 10 verbs, and instruct the agent to reuse them rather than redeclare them.
  - Phrase domain relations as new verbs.
- `pack-draft.schema.json`: `extends` is a non-null string, and its description is rewritten to match.
- `examples/legal-ops.json` and `examples/research-lab.json`: change to `extends: "mobrain-core"`. Neither redeclares a core name; Task 4's tests should run both examples through `ownViolations`.
- The skill bundle is served from `GET /schema/skill`. No route change.

### Task 8: Contract probes against real gbrain (`test/contract/schema.contract.test.ts`, `schema-authoring.contract.test.ts`)
Run these with `bun run test:contract:isolated` against `mobrain-dev`:

1. `schema validate` and `lint` pass for core, Personal, and an empty `my-brain` and `my-personal`. The chain `my-personal → mobrain-personal → mobrain-core` resolves.
2. The resolved core projection equals the JSON file's projection (L5 baseline). Resolved Personal = core ∪ delta, with no core entry changed.
3. **Inference on sample paths** (fact 2) under core and under Personal, with the expected types written into the test:
   - `projects/x/decisions/y.md`
   - `inbox/a.md`
   - `life/events/a.md`
   - `journal/notes/a.md`
   - `sources/meetings/a.md`
   - `random/a.md` → `concept`
4. Prose "works at [Acme](companies/acme)" on a person page stores a `works_at` edge under core (fact 5). `schema lint --with-db` and doctor `schema_pack_consistency` raise no warning for it.
5. Frontmatter `company: companies/acme` on a person stores `member_of` person → company, and no `works_at` (fact 5, override).
6. Meeting and event `attendees` store `attended` person → meeting and person → event. If event comes out reversed, drop that rule from core (fact 9).
7. An explicit `add_link` with `invested_in` under core is refused (fact 6). This documents agent behavior.
8. A type-filtered read across two sources on different packs is refused (fact 7). This documents the constraint behind D1.
9. `schema list` lists `company-brain` under Bundled (Task 2's assumption).

Record anything that disagrees with this plan in the test and stop to re-plan. Don't weaken a probe.

### Task 9: Docs
- `HANDOFF.md`: the "fresh install is … `mobrain-personal`" line becomes core, plus one line on the lock.
- `docs/runbooks/install.md`: the default pack.
- `CHANGELOG.md`: an unreleased entry.
- Archive this plan when Phase 1 lands.

## Phase 2: `mobrain-company` (separate change)

- `mobrain-company` (managed, extends core) adds the business types:
  - `customer`, `competitor`, `supplier`, `distributor`, `weekly`, `strategy`, `runbook`
  - `decision`, defined as temporal here (Personal defines it as annotation)
- Add them with `borrow_from: company-brain` only where the definitions don't touch core names (L4 allows managed borrowing; L5 guards it). Otherwise declare them directly.
- Company verbs: `owned_by` is already in core. Add `competes_with`, `champion`/`champion_of` and `decided_in`.
- Add the layer `my-company`.
- Take `company-brain` out of `GBRAIN_FALLBACK_PACKS` and `VISIBLE_BUNDLED_PACKS`.
- Decide whether switching a brain to company mode also offers this pack.

## Verification before the single push

1. `bun run test:unit`
2. `bun run test:integration:isolated`
3. `bun run test:contract:isolated` (dev stack up with the dev override; stop it afterwards, since the VPS has 2 vCPUs)
4. Rebuild dev with the `redeploy` skill (`--full`, because the ops image carries the pack files). Run a fresh wizard on `mobrain-dev`, then check:
   - `/api/schema` shows `mobrain-core` stored and resolved.
   - Each scaffolded Space has folders for types 1–9 plus `atoms/` and `extracts/`, as today.
   - The first edit of core creates `my-brain` and activates it.
   - Switching to Personal works.
   - Importing a draft with `extends: gbrain-base-v2` is refused.
5. Push `main` once. Dispatch no Docker suite unless the release needs one (`docs/runbooks/ci.md`).

## Rolling out to the live brain

`~/mobrain-molior/molior.sh update` rebuilds `control-plane`, which is also the `gbrain-ops` image, so the new packs get seeded at boot. The live brain keeps the pack it's on. D7 says brains will be rebuilt from scratch, but **rebuilding the live brain is destructive and needs explicit approval at that time** (`CLAUDE.local.md`). It's a separate step after Phase 1 is verified on dev.

## Risks

| Risk | Mitigation |
|---|---|
| A child's types win on nested paths (fact 2), so `projects/x/decisions/` becomes `decision` under Personal | Intended (the more specific type wins). Pinned by Task 8 probe 3. |
| gbrain still emits VC verbs from prose (fact 5) | Accepted: they're undeclared, so agents aren't steered to them. A pack that wants them declares them (Personal does). |
| A per-Space override to a different pack breaks typed queries across Spaces (fact 7) | D1: Spaces follow the brain's pack by default. The console warns when a per-Space override differs from the brain-wide pack. |
| An L5 failure after a gbrain mutation can't be rolled back | L2/L3 pre-check every op. A failing pack is blocked from activation and reported. |
| A gbrain upgrade changes merge keys or resolver output | The L5 baseline probe (Task 8 #2) fails at the next pin bump, before release. |

## Open question

In company mode, may a member set a different pack on their own private Space? Recommendation: **no**, for now; keep one pack per brain, customized through `my-brain` (see fact 7). Until this is decided, `POST /schema/sources/:id` stays admin-only, as it is today.
