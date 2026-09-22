---
name: mobrain-schema-designer
description: Design a custom Mobrain schema pack (the brain's ontology: page types, their folders, and the link verbs between them) from a team's requirements. Use when someone says "design our schema", "set up types for our brain", "what page types should we have", "custom ontology", or describes their domain (legal, research, sales, hiring) and wants the brain shaped around it. Produces a PackDraft JSON for an admin to import in the Mobrain console; it never changes the brain itself.
triggers:
  - "design our schema"
  - "set up types for our brain"
  - "what page types should we have"
  - "custom ontology"
---

# Mobrain schema designer

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
- `extends`: use `"gbrain-base-v2"` unless the team explicitly wants *only* their
  types. It keeps people, companies, meetings and the other basics. Set it to `null` for a
  standalone ontology, and then declare every type your link verbs mention.

## 4. Choose link verbs

`snake_case` verbs read left to right: `fromType` `name` `toType`
(`contract governs matter`). Add `inverse` when the reverse reads naturally
(`governed_by`). Prefer 3–10 verbs.

## 5. Output

Show a short table of types (name, primitive, folder, why), then the verbs, then
**one** fenced `json` block containing the PackDraft and nothing else. It must
satisfy `pack-draft.schema.json` next to this file. See `examples/` for two
complete drafts. End with: "Paste this into Console → Schema → New pack → Import
draft. Creating it adds a README to each folder in every Space that uses it;
existing pages keep their types."
