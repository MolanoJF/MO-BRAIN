# Onboarding: from a fresh install to a brain that keeps itself current

Starts the moment `scripts/install.sh` has finished and the stack is healthy. Two
tracks run side by side: the **person** (console) and the **agent** (MCP).
Install itself is in [`install.md`](install.md).

## Principles

1. **Start with a full brain.** Ingest the whole starting folder up front, so the
   brain begins with real, active files rather than an empty shell.
2. **The user decides automation.** Schedules are offered from a recommended
   list; the user picks which ones and how often.
3. **The runner is what keeps the brain growing.** It lets an agent pull key
   facts from notes, email and calendar. It comes after the schedules are
   running.
4. **Shape the schema last,** after the brain has run long enough to have many
   pages to learn from.
5. **Verify every stage.** Each ends with a check. Don't move on from a failed one.

## Stage map

| Stage | Person | Agent | Model $ |
|---|---|---|---|
| 1 Verify health | health, wizard, backup | — | no |
| 2 Connect MCP | paste the config | round-trip check | no |
| 3 Ingest the brain folder | import it all | report counts | embeddings |
| 4 Choose schedules | pick jobs and frequency | — | per job |
| 5 Enable the runner | enable, confirm healthy | — | capped |
| 6 Ingest from notes, email, calendar | connect sources, review | extract key facts | capped |
| 7 Shape the schema | review proposal | proposes types | small |

---

## Person track

### Stage 1 — Verify health

- Open the URL `install.sh` printed and complete the wizard: sign in, OpenAI key,
  Create brain.
- Console → Health: `ok: true` and `pin.matches: true`. `runner.state: "disabled"`
  is expected at this point.
- Take the first backup (`./molior.sh backup`, or the host equivalent in
  [`backup-restore.md`](backup-restore.md)).

**Gate:** health green, backup exists.

### Stage 2 — Connect MCP

- Settings → MCP: copy the endpoint, credential JSON and snippet into the agent
  you use. Enable agent instructions if the agent supports skills.
- Run the agent's round-trip check (below).

**Gate:** the agent writes a page and reads it back, and the page shows in the
console editor.

### Stage 3 — Ingest the brain folder

Import the whole starting folder (notes, vault, existing brain) into the private
Space as one Source, in one pass. Don't reorganize it first, and don't wait for
the habit of capturing facts by hand: the aim is an active brain with active
files on day one. If the folder is a git repo, add it with its git remote
(Settings → Sources) so changes keep flowing in.

Then check: page count matches what you imported, three random pages open
correctly, and embeddings finish (Health).

**Gate:** search finds things you know are in the folder, with citations, and
says "nothing" for things that aren't.

### Stage 4 — Choose schedules

Show the user the recommended schedules and let them choose which to enable and
how often. Nothing is on by default.

Console → Schedules. The catalogue the console offers today:

| Preset | Default cadence | Does | Model $ |
|---|---|---|---|
| `live-sync` | every 900s | imports new commits, embeds stale pages | embeddings |
| `nightly-dream` | daily 02:05 | consolidates and extracts (cap USD 10/run) | yes |
| `weekly-health` | Mondays 06:10 | `doctor --remediate`, reads whole brain (cap USD 5) | yes |
| `autopilot-tripwire` | daily 07:05 | alerts if autopilot ever gets installed | no |
| `push-reconcile` | daily 04:15 | pushes Sources with a git remote | no |
| `morning-briefing` | daily 08:05 | releases what quiet hours held | no |
| `nightly-agent-briefing` | daily 03:05 | agent prompt (needs the runner, stage 5) | yes |

> TODO: replace this table with the full recommended-schedules list.

Rules that apply: at most one enabled sub-hourly schedule per org; `weekly-health`
and the tripwire need an admin Connection. Details in
[`scheduler.md`](scheduler.md). Check Spend after the first night.

**Gate:** each chosen schedule shows a successful run.

### Stage 5 — Enable the runner

Read [`agent-runner.md`](agent-runner.md) first; it changes the trust model (a
model-written job running against the brain on a schedule, using the org's API
key). Enable it, confirm `runner.state` is healthy, then run `nightly-agent-briefing`
once by hand and read the result before it runs on a schedule.

**Gate:** healthy runner and one manual run you have read.

### Stage 6 — Ingest from notes, email and calendar

This is how the brain keeps growing: an agent extracts key facts from the
person's notes, email and calendar into the brain. Add one source at a time, in
the order of the value it brings, starting with notes, then calendar, then email.

For each source:

1. Connect it (OAuth or export), scoped as narrowly as possible.
2. Run it once by hand; read what it wrote.
3. Adjust the instructions, then put it on a schedule.

**Gate:** each source has a few runs the person has actually read, and the
facts it stores are correct and not noise.

### Stage 7 — Shape the schema

Once the brain has run for a while and has many pages, ask the agent to run
`skills/mobrain-schema-designer`. Review its proposal against the page kinds
that actually exist. Core types are locked (`CORE_LOCKED`); additions go in a
custom pack.

**Gate:** new pages land in the new types; old pages are untouched.

---

## Agent track

Give this to the agent verbatim, or let the console's agent instructions carry it.

### Standing rules

- Answer only from brain content, with a page slug for every claim. If the brain
  has nothing, say so. (`skills/query`)
- **Read before you write.** Search for the entity first and update the existing
  page; don't create near-duplicates.
- Write only to the member's private Space unless told otherwise.
- **Ask before any bulk write** (more than ~5 pages, or any rewrite of an
  existing page): say how many pages and show one example first.
- Never store secrets, tokens, passwords or full financial identifiers.
- Never change schema, schedules, connections or Sources. Propose; the person
  does it in the console.

### Stage 2 check — the round trip

1. `search` for `onboarding-test`: expect nothing.
2. `put_page` slug `onboarding/round-trip`, one line and today's date.
3. `get_page` it back; `search` again: expect the page.
4. Report the endpoint, the Source written to, and the page count (`list_pages`).
   Leave the page for the person to delete.

On any failure, report the exact error and stop. Don't loop and don't work
around a permission error.

### Stage 3 — after the ingest

Report counts, not content: pages found, skipped and why, embeddings pending.
Don't edit imported pages.

### Stage 6 — extracting from notes, email and calendar

- Extract **key facts**, not transcripts: decisions, commitments, people, dates,
  projects, preferences. Skip newsletters, receipts and noise.
- One page per entity (`people/ana-ruiz`, `projects/website-relaunch`,
  `decisions/2026-10-use-postgres`). First line is a one-sentence summary; then
  dated facts; then links to related slugs.
- Always record the source of a fact (note path, email date and sender, event
  title and date) so it can be traced back.
- Mark uncertainty ("unconfirmed") instead of asserting.
- Update an existing page rather than creating a new one; link new facts to
  existing entities.
- Each run ends with a report: pages created, pages updated, items skipped. The
  run's status is not the closing message; it is what the console shows.

### Stage 7 — proposing a schema

Use `skills/mobrain-schema-designer`. Count the page kinds that actually exist
and base the proposal on them. Present the types, how many existing pages each
covers, and which pages don't fit. Don't apply it.

### When the brain is thin

Say "I don't have anything on that yet" and offer to save what the person tells
you. Never fill the gap from general knowledge and present it as a brain fact.

---

## When something looks wrong

| Symptom | Likely cause | Do |
|---|---|---|
| Search returns nothing for known content | embeddings unfinished, or wrong Source | check page count and embedding state in Health |
| Agent reads but can't write | read-only Connection, or a company Source | check grants in Settings → Sources |
| `live-sync` runs, nothing changes | no git remote, or nothing new | check the Source's remote |
| Spend jumps | a dream or health run on a larger corpus | Spend page; pause the schedule ([`scheduler.md`](scheduler.md)) |
| Runner jobs write noise | extraction instructions too broad | pause the schedule, tighten the prompt, revert the run ([`agent-runner.md`](agent-runner.md)) |
| Agent invents answers | skill not loaded | confirm agent instructions are enabled; re-paste the MCP snippet |
