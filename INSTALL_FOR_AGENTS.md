# Installing Mo-brain (for agents)

Follow `skills/mobrain-install/SKILL.md` in this repository. It is the whole procedure. These are the traps:

1. **One batch of questions.** Ask for the OpenAI key (or keyless), the owner email, and the sources, together. Find the person's existing tools yourself first.
2. **Never authenticate sources in Mo-brain.** Collectors use your harness's own MCP connections or the person's gateway. Mo-brain stores no source credential.
3. **`install` refuses rather than reuses** (exit 17): an existing `.env`, an existing compose project of that name, a busy port, too little RAM or CPU, or an old Docker Compose. Fix the cause; never delete someone else's stack or volumes to get past it.
4. **Your interactive session cannot see the gbrain MCP until it restarts.** That is expected. Backfills run headless (`bin/mobrain collect <slug> --backfill`) and pick it up.
5. **Never `docker compose down -v`** outside the `mobrain-dev` project, never edit or regenerate `.env` after install (`ENCRYPTION_KEY` seals stored tokens), and never copy files into the brain's volumes.
6. **The schema base is locked.** Extend only `mobrain-brain` (`skills/mobrain-schema`).
7. **gbrain is pinned** (`0.60.230.0`). Upgrades go through `bin/mobrain upgrade --gbrain <version>`, which backs up first.
