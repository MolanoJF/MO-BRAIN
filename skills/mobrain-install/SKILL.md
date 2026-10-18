---
name: mobrain-install
description: Install Mo-brain end to end for the person - the Docker stack with gbrain, their sources, recurring collectors and timers - so they finish with a populated brain and a review UI. The person only asks, answers one batch of questions, and connects any source tool you do not already have. Use when the person says "install mobrain", "set up mobrain", "set up my brain", or shares the Mo-brain repository.
triggers:
  - "install mobrain"
  - "set up mobrain"
  - "set up my brain"
  - "install my brain"
---

# Install Mo-brain

## Contract

The person does three things: asks for the install, answers **one** batch of questions, and connects a source tool if you lack one. You do everything else, report once at the end, and never leave a step half-done without saying so.

Done means all of these are true, and you have checked each:
- `mobrain status` exits 0.
- `mobrain schema check` prints `core lock ok`.
- Every chosen source has a collector whose last run is `ok` or `partial` (`mobrain collector list`).
- `mobrain search "<a term you saw in a source>"` returns a page.
- `mobrain timers status` shows the collector timer.

## Before you start

- Work from a checkout of `https://github.com/MoliorOS/MO-BRAIN` on the machine that will host the brain. Run every command as `bin/mobrain` from the checkout root (or put it on `PATH`). If the person wants the brain on another machine (a VPS), stop and ask; this skill installs where you run.
- Requirements: Docker Compose 2.20 or newer, 2 CPUs, 4 GB RAM, a free loopback port (default 8787). `install` checks them and refuses with exit 17 and a reason.
- Read `INSTALL_FOR_AGENTS.md` at the checkout root once.

## Phase 1: Find the tools you already have

Look at your own tool list. For each source kind, note the tools that could read it:

| Kind | Looks like |
|---|---|
| `email` | Gmail or Outlook tools: `mcp__claude_ai_Gmail__*`, names containing `gmail`, `outlook`, `mail`; gateway tools (Composio `GMAIL_*`; executor, see below) |
| `calendar` | `*calendar*`, Google Calendar, Outlook calendar, gateway calendar tools |
| `meetings` | Granola, Fireflies, Circleback, Otter, Fathom, tl;dv, or Meet notes in Drive |
| `docs` | Google Drive or Docs (`*drive*`), Notion (`*notion*`), Confluence, any knowledge base tool |
| `notes-import` | a local folder you can read: an Obsidian vault, an old gbrain brain, Markdown, a Notion export |

**Executor.** If `executor` is on `PATH` (`executor whoami` works), check `executor tools integrations` for `google_gmail`, `google_calendar`, `google_drive`. Use it through its CLI: `--tools 'Bash(executor *)'`. Do not use `mcp__executor__*`: `executor mcp` over stdio starts with an empty local scope and sees none of the signed-in server's connections. `Bash(executor *)` reaches every integration the executor holds, so say in `--notes` which one integration the collector may touch (for example "google_gmail only").

Do not ask the person to authenticate anything to Mo-brain. Source access stays in their harness or gateway.

## Phase 2: Ask once

Send one message, in this shape, filled in from Phase 1:

> I'll install Mo-brain here and set everything up. I need:
> 1. An OpenAI API key (it powers search and extraction), or say "keyless" for keyword search only. Paste it and I'll store it privately.
> 2. The email for your login to the review UI.
> 3. What to connect: email, calendar, meeting notes, Drive/Docs, Notion or another knowledge base, an existing notes folder or old brain. I can already reach: <list>. For <missing kinds> I'd need you to add a connector to me first (<exact suggestion, e.g. "add the Notion connector in claude.ai settings" or "add your Composio MCP server">).

Accept "skip" for any source. Write the key to a temporary file with mode 0600 (`umask 077; printf '%s' "$KEY" > /tmp/mobrain-key`), never into chat logs you keep or any repo file, and delete it after install.

## Phase 3: Install the stack

```bash
bin/mobrain install --owner-email <email> --openai-key-file /tmp/mobrain-key   # or --keyless
rm -f /tmp/mobrain-key
```

It prints `ui_url`, `owner_password`, `local_url` and `runner_env`. Keep the password for the final report. On exit 17, read the reason and fix the cause; never delete `.env`, volumes or another compose project to get past it. Ask the person if the fix touches anything you did not create.

## Phase 4: Connect yourself and install skills

```bash
bin/mobrain client issue agent --register
bin/mobrain skills install --dir ~/.claude/skills
```

The registration adds an MCP server named `gbrain` to your harness. For a dev stack beside a live one, register under another name (for example `gbrain-dev`) and set `MOBRAIN_MCP_NAME=gbrain-dev` in `~/.config/mobrain/runner.env`, so headless collector runs allow and write through that server. This interactive session will not see it until a restart; headless runs do, which is why backfills below run headless. The skills bundle is gbrain's pinned skills plus Mo-brain's, with one resolver; read its `RESOLVER.md` once.

## Phase 5: Create the collectors

For each source the person chose:

```bash
bin/mobrain collector add --title "<human title>" --kind <kind> --cadence <cadence> \
  --tools '<tool patterns from Phase 1, comma-separated>' --notes "<what to include or skip, in the person's words>"
```

Default cadences: email `2h`, calendar `daily@06:30` plus `6h`, meetings `3h`, docs `1d`, notes-import `once`. Default backfill: email and meetings 90 days, calendar 30 days back, docs all (the collect skill samples first).

For `notes-import`, put the folder's absolute path in `--notes`.

## Phase 6: Backfill

For each collector, one at a time:

```bash
bin/mobrain collect system/collectors/<slug> --backfill
```

Each run prints `<slug>: <status> (<summary>)`. On `error`, read the newest log in `~/.local/state/mobrain/collect/<slug>/`, fix the cause (usually a tool missing from `--tools`, which `mobrain collector set` cannot change; re-create the collector with `mobrain collector add` and the same title), and run it again. A `partial` backfill is fine; the timer finishes it.

## Phase 7: Timers and verification

```bash
bin/mobrain timers install
bin/mobrain status && bin/mobrain schema check && bin/mobrain collector list
bin/mobrain search "<a real term from a source>"
```

Fix anything that fails before reporting. gbrain maintenance runs in the `autopilot` container as the spec §8.5 loop (`gbrain sweep --once` and `gbrain embed --stale`). `gbrain autopilot` exits `No repo path` and does not tick (probe P6). You do not schedule it.

## Phase 8: Report

One message:

> Mo-brain is running.
> - Review it at <ui_url> (sign in as <email>, password `<owner_password>`; change it any time by asking me).
> - Ingested: <per source: N pages, time range>.
> - Collectors: <title, cadence> each. They run on this machine every 15 minutes when due, using my connections.
> - Search mode is balanced. <If keyless: semantic search and extraction are off until you give me an OpenAI key.>
> - To change anything (a source, a schedule, the schema, inviting people), just ask me.
> - Restart this session once so I can use the brain directly.

If the person wants to reach the UI from other devices, offer `tailscale serve` and ask before running it:
`tailscale serve --bg --https=8443 http://127.0.0.1:<port>`, then `bin/mobrain` needs no change except that new clients use that URL; re-run `client issue agent --register` on other machines through `mobrain join`.

## Anti-patterns

- Asking more than one batch of questions, or asking for things you can find yourself.
- Building an OAuth flow, storing a source credential in Mo-brain, or asking the person to paste a source password.
- Writing collector pages or brain pages by copying files into a volume.
- Running `docker compose down -v`, `mobrain restore`, or editing `.env` to recover from an install error.
- Reporting "done" before every check in the contract passed.
