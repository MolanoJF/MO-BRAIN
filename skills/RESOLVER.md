# Mobrain Skill Resolver

Skills are prose instruction sets the member's agent loads over MCP. This file
is the human-readable dispatch map; each skill's frontmatter `triggers:` is the
authoritative routing signal.

| Trigger | Skill |
|---------|-------|
| "what do we know about", "tell me about", "look up", "search for", "who is" | `skills/query/SKILL.md` |
| "design our schema", "set up types for our brain", "what page types should we have", "custom ontology" | `skills/mobrain-schema-designer/SKILL.md` |
