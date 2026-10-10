# Mo-brain Skill Resolver

Skills are prose instruction sets the member's agent keeps in its own skills folder (installed once during
onboarding, see `docs/runbooks/onboarding.md` Stage 3). This file is the human-readable dispatch map; each
skill's frontmatter `triggers:` is the authoritative routing signal.

| Trigger | Skill |
|---------|-------|
| "what do we know about", "tell me about", "look up", "search for", "who is" | `skills/query/SKILL.md` |
| "design our schema", "set up types for our brain", "what page types should we have", "custom ontology" | `skills/mobrain-schema-designer/SKILL.md` |
| "create a schema", "apply the schema", "rerun the schema sync", "add a source", "invite", "grant access", "create a schedule" | `skills/mobrain-operator/SKILL.md` |
