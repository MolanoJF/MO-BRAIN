# Mobrain Skill Resolver

Skills are prose instruction sets the member's agent loads over MCP. This file
is the human-readable dispatch map; each skill's frontmatter `triggers:` is the
authoritative routing signal.

| Trigger | Skill |
|---------|-------|
| "what do we know about", "tell me about", "look up", "search for", "who is" | `skills/query/SKILL.md` |
