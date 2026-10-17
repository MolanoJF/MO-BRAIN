---
name: mobrain-schema
description: Extend or change this brain's schema the gbrain way - mirror gbrain's schema-author procedure, change only the mobrain-brain layer, and never redefine a mobrain-core or mobrain-personal entry. Use when the person says "add a type", "track deals as their own pages", "the schema doesn't fit", "rename this type", or when ingestion keeps producing untyped pages.
triggers:
  - "add a page type"
  - "change the schema"
  - "the schema doesn't fit"
  - "track * as their own pages"
---

# Change the Mo-brain schema

## Authority

Read the installed gbrain skill `schema-author/SKILL.md` and follow its phases in its order (at gbrain 0.60.230.0: Brain, Assess, Propose, Apply, Sync, Verify, Commit). If its phases differ from that list, stop and tell the person the gbrain version drifted from what this skill expects.

## Mo-brain deltas

**Mo-brain (Brain):** the active pack is always `mobrain-brain`, which extends `mobrain-personal`, which extends `mobrain-core`. Confirm with `get_active_schema_pack` or `mobrain schema show`.

**Mo-brain (Propose):** a proposal may only add to `mobrain-brain`. It may not reuse a type name, alias, folder prefix or link type name already defined by `mobrain-core` or `mobrain-personal` (`mobrain schema show` lists each with its layer). Show the person the proposal and wait for a yes.

**Mo-brain (Apply):**
- Types, aliases, prefixes and link types: `schema_apply_mutations` through gbrain MCP, against pack `mobrain-brain` (owners and admins only).
- Anything gbrain accepts only as a file edit (frontmatter links, enrichable types, filing rules, subtypes, mapping rules, cardinality, temporal): on the stack host,
  `mobrain schema edit --out /tmp/mobrain-brain.json`, edit that file, then `mobrain schema apply /tmp/mobrain-brain.json`. `apply` validates, lints, checks the core lock, and rolls back on any failure.

**Mo-brain (Sync):** backfills use gbrain's own flows through `mobrain schema exec -- sync|review-orphans|unify-types ...` on the stack host.

**Mo-brain (Verify):** `mobrain schema check` must print `core lock ok`. The UI's Schema page shows the new type with layer `brain`.

**Mo-brain (Commit):** there is no separate repo to commit; the pack lives with the brain and is in every `mobrain backup`.

## Anti-patterns

- Editing `mobrain-core` or `mobrain-personal`, or activating another pack.
- Renaming a core type to fit a habit; add an alias in `mobrain-brain` only if it does not collide.
- Applying without the person's yes on the proposal.
