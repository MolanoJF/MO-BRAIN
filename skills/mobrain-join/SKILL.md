---
name: mobrain-join
description: Connect this machine's agent to an existing Mo-brain as an invited person - download the CLI, register the gbrain MCP server, install skills, connect the person's own sources and start their collectors. Use when the person pastes a line like "Join Mo-brain at <url> with key <key>", or says "join mobrain" or "connect me to the company brain".
triggers:
  - "join mobrain"
  - "join Mo-brain at"
  - "connect me to the company brain"
---

# Join a Mo-brain

## Contract

Same as `mobrain-install`, without the stack: the person pasted one line and answers one batch. You finish with their agent connected, their sources collecting into their private space, and timers running. No Docker is needed on this machine.

## Phase 1: Get the CLI and join

The pasted line holds a URL and a one-time key. Run:

```bash
mkdir -p ~/.local/bin
curl -fsSL <url>/install/mobrain -o ~/.local/bin/mobrain && chmod +x ~/.local/bin/mobrain
~/.local/bin/mobrain join --url <url> --key <key>
```

`join` registers the `gbrain` MCP server in your harness, installs the skills bundle in `~/.claude/skills`, and installs the collector timer. If the key was already used, ask the person to create a new one under **Connect your agent** in the UI.

## Phase 2: Ask once, then connect sources

Follow `mobrain-install` Phases 1, 2 (without the OpenAI key and email questions; the brain already has them), 5, 6 and 7, using `~/.local/bin/mobrain` instead of `bin/mobrain`. Collectors write into the person's private source. Company sources are shared by an admin's grant; you read them, you do not write them.

## Phase 3: Report

> You're connected to Mo-brain at <url>.
> - Your private space: <source id>. Shared with you: <granted company sources>.
> - Ingested: <per source>. Collectors: <list>.
> - Restart this session once so I can use the brain directly.
