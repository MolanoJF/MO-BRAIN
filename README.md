# Mo-brain

A personal or company brain your coding agent installs and runs for you. Mo-brain is [gbrain](https://github.com/garrytan/gbrain), packaged: four containers, a set of agent skills, and a small review UI.

## Install

Tell your coding agent:

> Install Mo-brain from https://github.com/MoliorOS/MO-BRAIN

It asks you one batch of questions (an OpenAI key, your email, which sources to connect), then installs the stack, ingests your sources, and schedules collectors that run with your agent's own connections. You review everything at the URL it gives you. To change anything, ask your agent.

## What runs

| Container | Does |
|---|---|
| `postgres` | the brain and Mo-brain's small people database |
| `gbrain` | gbrain's MCP server |
| `autopilot` | spec §8.5 loop: `gbrain sweep --once` and `gbrain embed --stale` (not `gbrain autopilot`, which exits `No repo path`) |
| `mobrain` | the review UI, people and access, the collector API, and the `/mcp` proxy |

Collectors run on the host from a timer: `bin/mobrain collect --due` wakes your agent headless with the `mobrain-collect` skill.

## Docs

- [`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md): what an installing agent reads first.
- [`docs/runbooks/`](docs/runbooks/): operate, collectors, company mode, backup and restore, upgrade, CI.
- [`HANDOFF.md`](HANDOFF.md): state of the project for the next developer.
