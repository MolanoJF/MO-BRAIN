# mobrain-personal schema pack — Design

**Date:** 2026-09-27
**Status:** Approved in brainstorming; awaiting spec review.
**Follow-up:** `mobrain-company` (its own spec) will `extends: mobrain-personal`.

## 1. Why

Mobrain ships gbrain's schema packs as-is, and they are shaped around a YC /
investor workflow: `deal`, `tweet`, `yc`, `invested_in`, `led_round`. The
default, `gbrain-base-v2`, has no first-class goals, decisions, ideas, life
areas, or health and finance history. Mobrain should be opinionated: every new
brain starts on **our** personal ontology, built for the *professional self*
(founder / consultant / knowledge worker) with a light life layer.

## 2. Decisions (from brainstorming, 2026-09-27)

| # | Decision |
|---|---|
| P1 | Focus: the professional self. People, meetings, projects, learning, ideas, writing, decisions, commitments; plus timeline, health and finances. |
| P2 | Standalone pack (`extends: null`). Every type and verb is declared here; no investor leftovers. |
| P3 | Keep every page-type name gbrain hardcodes: `person`, `company` (enrich / whoknows defaults), `meeting` (timeline extraction), `note` (capture, dream cycle), `concept` (import fallback), `atom`, `synthesis`, `extract_receipt` (extraction machinery). |
| P4 | Health and finances are `area` overview pages plus one dated record type each — no fine-grained `medication` / `account` / `transaction` types. |
| P5 | Commitments stay a gbrain facts kind (`commitment`) plus the `owes_to` / `awaiting_reply_from` verbs; no page type. |
| P6 | `mobrain-personal` is the default for every new brain (`DEFAULT_SCHEMA_PACK`). |
| P7 | The Schema page shows only `mobrain-personal` and `gbrain-base-v2` (read-only reference). The other five gbrain bundled packs are hidden, **not deleted** — `schema validate` hardcodes `gbrain-base` and `gbrain-everything` extends `gbrain-investor`. |
| P8 | Editing is **auto-layer on first edit**: `mobrain-personal` stays read-only and Mobrain-managed; the first edit creates `my-personal` (`extends: mobrain-personal`), applies it, and puts the edit there, so future shipped versions still flow in. |
| P9 | Existing brains on `gbrain-base-v2` are not migrated automatically. |
| P10 | Health / finance type names stay in the core pack even though `mobrain-company` will inherit them (vocabulary only; data lives in private My Spaces). |

## 3. The ontology

### 3.1 Page types (17 user + 3 system)

| Type | Primitive | Primary folder | Extra prefixes | extractable | expert_routing | Purpose |
|---|---|---|---|---|---|---|
| `person` | entity | `people/` | `person/` | yes | yes | Personal CRM core |
| `company` | entity | `companies/` | `company/`, `orgs/` | no | yes | Employers, clients, vendors, providers |
| `meeting` | temporal | `meetings/` | `meeting/`, `calls/` | yes | no | Calendar / transcript ingestion |
| `conversation` | temporal | `conversations/` | `emails/`, `chats/` | yes | no | Async threads (replaces `email`, `slack`) |
| `event` | temporal | `events/` | `life/events/`, `calendar/` | no | no | Dated happenings: milestones, trips, launches, job changes, deadlines |
| `journal` | temporal | `journal/` | `life/diary/` | yes | no | Daily notes, reflection (replaces `diary`) |
| `area` | concept | `areas/` | — | no | no | Ongoing areas of life: Health, Finances, Career, Family |
| `goal` | concept | `goals/` | — | no | no | Quarterly / yearly outcomes |
| `project` | concept | `projects/` | `project/` | no | no | Finite work with an outcome |
| `decision` | annotation | `decisions/` | — | yes | no | Decision log: context, options, choice, review date |
| `idea` | concept | `ideas/` | — | no | no | Raw product / business / content ideas |
| `concept` | concept | `topics/` | `wiki/concepts/`, `wiki/concept/` | yes | no | Evergreen knowledge |
| `note` | concept | `notes/` | `note/`, `inbox/` | yes | no | Catch-all / inbox |
| `source` | media | `sources/` | `source/`, `books/`, `articles/`, `podcasts/`, `videos/`, `media/` | yes | no | Things consumed (merges `media` + `source`) |
| `writing` | media | `writing/` | `posts/`, `newsletters/`, `talks/` | yes | no | My own output |
| `health_record` | temporal | `health/` | — | yes | no | Visits, labs, diagnoses, prescriptions, biometric summaries |
| `finance_record` | temporal | `finances/` | — | yes | no | Tax returns, statements, big purchases, policies, loans, subscriptions, net-worth snapshots |
| `atom` | annotation | `atoms/` | — | no | no | System (kept verbatim from gbrain-base-v2) |
| `synthesis` | annotation | — | — | no | no | System (kept verbatim from gbrain-base) |
| `extract_receipt` | annotation | `extracts/` | — | no | no | System (kept verbatim from gbrain-base) |

Every type carries `aliases: []` except `journal` (`["diary"]`), `source`
(`["media"]`) and `event` (`["calendar-event"]`), so pages written under the old
names keep resolving.

Dropped relative to `gbrain-base-v2` / `gbrain-base`: `deal`, `tweet`,
`social-digest`, `slack`, `email`, `analysis`, `diary`, `media`, `yc`, `civic`,
`hardware`, `architecture`, `guide`, `calendar-event`, `code`, `image`.

### 3.2 Link verbs

`inference` is only set where gbrain's own packs already use that exact form
(regex verbs from v2, `attended` via `page_type: meeting` from base). All other
from → to pairings are documentation for the folder READMEs and agents, not
manifest constraints.

| Verb | Inverse | Intended from → to | Inference |
|---|---|---|---|
| `works_at` | `employs` | person → company | v2 regex |
| `founded` | `founded_by` | person → company | v2 regex |
| `advises` | `advised_by` | person → person, company | v2 regex |
| `introduced` | `introduced_by` | person → person | — |
| `attended` | `attended_by` | person → meeting, event | `page_type: meeting` |
| `decided_in` | — | decision → meeting | — |
| `belongs_to` | `contains` | goal, project, event, health_record, finance_record → area | — |
| `serves` | `served_by` | project → goal | — |
| `contributes_to` | `contributors` | person → project | — |
| `affects` | `affected_by` | decision → project, goal | — |
| `supersedes` | — | decision → decision, writing → writing | — |
| `owes_to` | — | page → person | — |
| `awaiting_reply_from` | — | page → person | — |
| `authored` | `authored_by` | person → source, writing | — |
| `sourced_from` | — | idea, concept, writing → source | — |
| `derived_from` | — | idea, concept, writing → idea, source | — |
| `discusses` | — | any → concept | — |
| `provider_for` | `provided_by` | person, company → health_record, finance_record, area | — |
| `mentions` | — | any → any | — |
| `relates_to` | `relates_to` | any ↔ any | — |
| `redirects_to` | — | system | — |

Dropped: `invested_in`, `partner_of`, `attributed_to`, `yc_partner`,
`led_round`, `image_of`, `discussed_in`, `source`, `related_to`.

### 3.3 Frontmatter links

| page_type | fields | link_type |
|---|---|---|
| person | `company`, `companies` | `works_at` |
| meeting | `attendees` | `attended` |
| event | `attendees` | `attended` |
| goal, project, event, health_record, finance_record | `area` | `belongs_to` (one entry per type) |
| project | `goal` | `serves` |
| decision | `project`, `goal` | `affects` |
| decision | `meeting` | `decided_in` |
| source, writing | `author`, `authors` | `authored` |
| idea, writing | `sources` | `sourced_from` |
| health_record, finance_record | `provider` | `provider_for` |

### 3.4 Rest of the manifest

- `api_version: gbrain-schema-pack-v1`, `name: mobrain-personal`, `version: 1.0.0`,
  `extends: null` (explicit — a missing key silently inherits `gbrain-base`, S7),
  `borrow_from: []`, `gbrain_min_version` = the pinned gbrain's `x.y.z`.
- `enrichable_types`: `person` → `person-default`, `company` → `company-default`.
- `takes_kinds`: `fact`, `take`, `bet`, `hunch` (a personal `bet` is a dated prediction).
- `filing_rules`: one per user type, `directory` = primary folder, with a one-line description.
- Frontmatter conventions (folder READMEs only, not enforced): `event.date` +
  optional `end_date`; journal slugs `journal/YYYY-MM-DD`; `goal.horizon`
  (quarter|year) + `status`; `project.status`; `decision.status` +
  `review_date`; `health_record.date`, `finance_record.date`.

## 4. Components

### 4.1 The pack file — `packs/mobrain-personal/pack.json`
The full manifest from §3, checked in. Source of truth for the shipped version.

### 4.2 Seeding — `src/ops/fileplane.ts` + control-plane boot
- `MOBRAIN_PACKS = ['mobrain-personal']` (managed packs).
- On boot, for each managed pack, write the repo manifest to
  `~/.gbrain/schema-packs/<name>/pack.json` if absent or if its `version`
  differs (upgrade path). Idempotent, advisory-locked like other file-plane writes.
- Seeding runs **before** the wizard can call `gbrain init`, which needs the
  pack on disk.
- `assertUserPackName` refuses writes to managed names from the API (only the
  seeder writes them).

### 4.3 Default — `src/control/bootstrap.ts`
`DEFAULT_SCHEMA_PACK = 'mobrain-personal'`. Wizard comments / D6 references to
`gbrain-base-v2` updated.

### 4.4 Visible packs — `src/control/routes/schema.ts`, `wizard.ts`
- A `VISIBLE_BUNDLED = ['gbrain-base-v2']` list filters `listSchemaPackSections`
  output; the five others never reach the console. If a brain's resolved pack
  is a hidden one (legacy), it is still shown as the active pack, never hidden.
- Managed packs are reported as `bundled: false, managed: true, editable: true`
  (editable in the auto-layer sense, §4.5).

### 4.5 Auto-layer on first edit — `POST /schema/packs/:name/mutations`
When the target is a managed pack:
1. If `my-personal` does not exist, create it via the existing draft path:
   `{ name: 'my-personal', extends: 'mobrain-personal', pageTypes: [], linkVerbs: [] }`.
2. Apply the mutation batch to `my-personal`.
3. If the brain's resolved pack is `mobrain-personal`, apply `my-personal`
   (same apply + `schema active` readback as today; divergence surfaced, S2).
4. Return the result naming `my-personal` so the console navigates to it.

Mutations that target *inherited* types or verbs (`remove_type`,
`remove_link_type`, `update_type` of a `mobrain-personal` type) are refused
on the layer with a clear message unless Task 0 proves gbrain's child-wins
merge supports overriding them (see §6).

Console: the `mobrain-personal` detail page shows an "Edit" affordance with the
note "Your changes go into *my-personal*, layered on top, so Mobrain updates
still reach you."

### 4.6 Switching an existing brain
The Schema page's existing apply flow is the path. Its confirm dialog gains:
"Pages that already have a type keep it — `schema sync` only fills blank types."
No automatic migration.

## 5. Testing

- **Pack validity:** `gbrain schema validate mobrain-personal` and
  `gbrain schema lint mobrain-personal` exit 0 on the dev stack; effective
  `schema show` reports 20 page types and 21 link types.
- **Unit:** seeder (absent → written; same version → untouched; new version →
  overwritten); pack listing hides the five packs and keeps a legacy active one;
  managed names rejected by `assertUserPackName`; auto-layer creates
  `my-personal` once, reuses it on the second edit, refuses inherited removals.
- **Live probe (fresh dev brain):** bootstrap → wizard → `schema active` reads
  `mobrain-personal` with `Source: home-config`; a page written to
  `health/2026-09-lab.md` syncs as `health_record`; a person page with
  `company:` creates a `works_at` link; `gbrain whoknows` and `gbrain enrich`
  run without type errors.

## 6. Task 0 probes (before building)

Label results MEASURED / FALSIFIED in `docs/schema-pack-findings.md` (new §S8):
1. Does a standalone pack without `media` / `email` / `diary` break any gbrain
   skill or cycle (`gbrain doctor`, dream cycle, capture)?
2. Does `frontmatter_links` accept one entry per page type sharing a field name
   (`area` on five types)?
3. In an `extends` child, can `remove_type` / `update_type` affect an
   inherited type, or only own types? (Decides §4.5's refusal rule.)
4. Does `gbrain init` accept a user-installed pack name as its schema pack?

## 7. Out of scope

`mobrain-company`; per-Space packs; migrating existing typed pages; console
calendar / timeline views; seeding default `area` pages (Health, Finances,
Career) — a possible follow-up once the pack ships.
