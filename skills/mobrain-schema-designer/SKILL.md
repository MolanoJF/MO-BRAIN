---
name: mobrain-schema-designer
description: Design a custom Mo-brain schema pack (the brain's ontology: page types, their folders, and the link verbs between them) from a team's requirements. Use when someone says "design our schema", "set up types for our brain", "what page types should we have", "custom ontology", or describes their domain (legal, research, sales, hiring) and wants the brain shaped around it. Produces a PackDraft JSON for an admin to import in the Mo-brain console; it never changes the brain itself.
triggers:
  - "design our schema"
  - "set up types for our brain"
  - "what page types should we have"
  - "custom ontology"
---

# Mo-brain schema designer

You turn a team's requirements into a **PackDraft**: a JSON document an admin
pastes into **Console → Schema → New pack → Import draft**. The console
validates it, runs gbrain's own lint, and the admin decides whether to create and
apply it. You never create, apply or edit a pack yourself, and you never write
pages while doing this.

## 1. Understand the domain (ask, don't assume)

Ask at most five questions, one at a time, and stop early when you have enough:
1. What does the team do, and what decisions should the brain help with?
2. What are the *things* you keep track of? (people, clients, contracts, experiments…)
3. What *happens* over time? (meetings, matters, sprints, trials…)
4. How do those things relate? Phrase it as "a ___ ___ a ___", for example "a contract governs a matter".
5. Which things should the brain know *experts* on, and which pages hold facts worth extracting?

## 2. Look at what already exists (read-only, if you are connected)

If you have the gbrain MCP tools, use only `list_pages`, `search` and `get_page`
to see existing folders and page names. Reuse a folder the team already uses
instead of inventing a parallel one.

## 3. Choose types

- Keep it to 3–12 types. Every type must earn its place: fewer than ~20 pages
  expected in its first quarter means it's probably a tag, not a type.
- Pick one **primitive** per type:
  - `entity`: a durable thing with an identity (person, company, contract, product)
  - `temporal`: something anchored in time (meeting, matter, sprint, trial)
  - `concept`: an idea or topic (thesis, framework, technique)
  - `annotation`: a note *about* other pages (memo, review, decision)
  - `media`: a captured artifact (paper, recording, deck)
- `folder` is lowercase, plural, and ends with `/` (`contracts/`, `matters/`). Nested is fine (`legal/contracts/`).
- `extractable: true` only where facts should be pulled out of pages (contracts, people).
- `expertRouting: true` only for types that represent people or teams who *know* things.
- `extends`: always set it. Use `"mobrain-core"`, or `"mobrain-personal"` for a
  personal-life brain. Never `null` and never a gbrain pack: every Mo-brain
  schema builds on core, and the console refuses anything that doesn't.
- **Reuse core, don't redeclare it.** Core is locked: its types and verbs can't
  be removed or redefined, and a draft that names one is refused.
  - Core's 12 types: `person`, `company`, `meeting`, `conversation`, `event`,
    `project`, `concept`, `note`, `source`, `atom`, `synthesis`, `extract_receipt`.
  - Core's 10 verbs: `relates_to`, `mentions`, `discusses`, `part_of`
    (inverse `has_part`), `member_of` (`has_member`), `attended`
    (`attended_by`), `created_by` (`created`), `owned_by` (`owns`),
    `derived_from`, `supersedes` (`superseded_by`).
  - If the team needs a "client", "matter" or "paper", add a new type. If a core
    type nearly fits (a person, a company, a project), use it as is.

## 4. Choose link verbs

`snake_case` verbs read left to right: `fromType` `name` `toType`
(`contract governs matter`). Add `inverse` when the reverse reads naturally
(`governed_by`). Prefer 3–10 verbs. Phrase domain relations as **new** verbs
(`governs`, `cites`, `signed`); for a general relation, use core's `relates_to`,
`part_of`, `member_of`, `owned_by` or `created_by` instead of inventing a synonym.
Never reuse a core verb or core inverse name.

## 5. Output

Show a short table of types (name, primitive, folder, why), then the verbs, then
**one** fenced `json` block containing the PackDraft and nothing else. It must
satisfy `pack-draft.schema.json` next to this file. See `examples/` for two
complete drafts. End with: "Paste this into Console → Schema → New pack → Import
draft. Creating it adds a README to each folder in every Space that uses it;
existing pages keep their types."
