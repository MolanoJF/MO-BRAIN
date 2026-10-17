## Mo-brain

This brain is a Mo-brain install: gbrain behind a small service. These routes come first; everything else routes through gbrain's table above.

| When the person says or needs | Read |
|---|---|
| "install mobrain", "set up my brain", first contact with a Mo-brain repo | `mobrain-install/SKILL.md` |
| "join mobrain", a join line with a URL and a key | `mobrain-join/SKILL.md` |
| connect, pause, or change a source; "collect my email now"; a timer woke you to run a collector | `mobrain-collect/SKILL.md` |
| add or change a page type, link type or folder; "the schema doesn't fit" | `mobrain-schema/SKILL.md` |
| "import my old brain / notes / vault", a `notes-import` collector | `mobrain-import/SKILL.md` |

Mo-brain rules that win over any skill:
- Brain writes go through the gbrain MCP server (`gbrain`, or `gbrain-company-<source>` for a company source). People, access, timers and the stack go through `mobrain` commands.
- Never redefine a `mobrain-core` or `mobrain-personal` type; extend `mobrain-brain` only (`mobrain-schema`).
- Never copy files into the brain raw; ingestion goes through gbrain (`brain-ingest-gate`).
