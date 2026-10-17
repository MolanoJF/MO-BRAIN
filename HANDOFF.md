# Handoff — read this first

**Mo-brain 2 (simplified)** replaced v1 on 2026-10-14. v1 is frozen at tag `v1-final` (control plane, ops sidecar, scheduler, agent runner, control MCP, zones). Nothing from v1 runs any more.

- Design: `docs/superpowers/specs/2026-10-14-mobrain-simple-design.md`. Probe results: `docs/superpowers/specs/2026-10-14-mobrain-simple-probes.md`.
- Build plan: `docs/superpowers/plans/2026-10-14-mobrain-simple/`.

## Shape

Four containers (`postgres`, `gbrain`, `autopilot`, `mobrain`), one bash CLI (`bin/mobrain`), five skills (`skills/`). gbrain is driven only through its CLI (argv arrays), its HTTP MCP, and `mcp grant` / `auth` commands. Mo-brain owns people, invites, grants, collector run history and the UI; every access decision is enforced by re-granting gbrain clients.

## Pins

| | |
|---|---|
| gbrain | `0.60.230.0` (`bin/mobrain` `PIN`, `.env` `GBRAIN_VERSION`) |
| Bun | `1.4.2` (images and CI) |
| App | `2.0.0-dev`, unreleased; images are built locally |

## Settled, do not re-argue

- No separate Mo-brain MCP. Brain work goes through gbrain's MCP; people and stack work through `bin/mobrain`.
- Collectors run in the person's own harness on a host timer. gbrain's subagents cannot reach external tools, so nothing server-side runs collectors.
- One schema per brain: `mobrain-core` ← `mobrain-personal` ← `mobrain-brain`. Only the last is edited.
- The UI is read-only except People & access and Connect your agent (plus sign-in and claim).

## Known gaps

- Harness adapters: Claude Code only. `codex exec` and others are a new `harness_run` branch in `bin/mobrain`.
- Agent tokens last at most 90 days; `collect --due` rotates them when the harness was registered by `mobrain`.
- Isolation is gbrain's application-level source scoping, not database row-level security; the host operator can read everything.
- No public-domain TLS; use `tailscale serve`.

## How to run (dev)

```bash
bin/mobrain install --owner-email dev@local.test --keyless --project mobrain-dev --port 8788
bin/mobrain status
bin/mobrain down          # stop when not in use: the VPS has 2 vCPUs
```

Tests: `bun run test:unit` (CI), `bun run test:db` (local), `bin/mobrain selftest` (local, dev project only).
