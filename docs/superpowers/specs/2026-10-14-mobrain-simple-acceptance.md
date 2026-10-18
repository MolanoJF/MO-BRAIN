# Mo-brain 2: acceptance run on `mobrain-dev`

Date: 2026-10-18. Host: the 2 vCPU VPS. gbrain `0.60.230.0`. Two runs on the real install path: Claude Code headless, the owner's Gmail and Calendar through the `executor` CLI, one OpenAI key for embeddings. Both ran on the `mobrain-dev` compose project; nothing touched a live stack.

Run 1 found the defects below. Run 2 was a wipe and fresh install after they were fixed, and covered what run 1 had not: the full email backfill, the unattended timer cycle and a member on a populated brain.

## Results

| Check | Result |
|---|---|
| Fresh install, cold image build | 1 min 57 s; `/api/health` `ok: true`, `pin.matches: true` |
| Calendar backfill (30 days) | `ok`, 2 to 3 min (2m22s in run 1): 166 events (18 standalone, 148 recurring occurrences in 6 series), 29 pages (18 events, 5 series, 6 people) |
| Email backfill (90 days) | `ok` on the 7th headless run, about 12 min in total: 19 pages created, 76 threads skipped as noise or already ingested. Runs 1 to 6 each returned `partial` and the watermark held until the last |
| Brain after both | 66 pages, 66 embedded, 103 links |
| Search | `mobrain search "meeting"` returns calendar pages |
| Unattended run | the systemd timer started an email run at 21:31:06 with nobody present; it finished `ok` (`read 1, skipped 1 already ingested`), the second `ok` run for that collector |
| Company mode and a member | `mode company`, invite, claim: the member sees only their own empty private source, and gets 403 on the owner's source, `/api/people` and `/api/activity` |

Not exercised: a browser walk of the UI (no browser tool on the host; the API walk above stands in), a second real member with granted company sources, and `codex` or any harness but Claude Code.

## Human touchpoints

The install itself needed the OpenAI key and the owner email. The source connection needed a decision about the tool route (see defect 3). Everything else ran without the owner.

## Defects found

1. **Collector overwrites returned 500.** Real gbrain refuses `put` over an existing page without `--expected-revision` (`revision_required`), so `collector set` and re-adding a collector failed. The unit and db tests use a fake gbrain CLI, which hid it. Fixed with `--force` on the collector API's own write; `putPageArgv` tests updated.
2. **The headless run only allowed `mcp__gbrain__*`.** A dev stack registered as `gbrain-dev` could not write. Fixed with `MOBRAIN_MCP_NAME` (read from `runner.env`, so timers inherit it); new test in `test/unit/cli/collect.test.ts`.
3. **`executor mcp` over stdio sees nothing.** It starts with an empty local scope; only the `executor` CLI, which uses the signed-in server profile, reaches Gmail and Calendar. Collectors use `--tools 'Bash(executor *)'`. Documented in `skills/mobrain-install/SKILL.md` and `docs/runbooks/collectors.md`.
4. **`Bash(executor *)` is broad.** The executor also holds CRM, Notion, Drive and other integrations. The collector notes restrict the agent to one integration, but that is an instruction, not a boundary. Documented as a trust decision in the collectors runbook.
5. **A malformed percent escape (`/%zz`) returned 500 from static serving.** It now serves the app shell. Test added in `test/db/routes-static.test.ts`.
6. **The first email backfill needed 7 headless runs.** Each run triages a bounded slice of about 90 candidate threads and gives up on the rest, so a 90-day mailbox converges slowly. This is a throughput limit of the skill, not an error. Candidate follow-up: let the skill keep a cursor across runs inside one `--backfill` invocation.

Also recorded: a stale `mobrain` MCP entry (pointing at the old live brain, 401) made headless runs mention a second server. Remove stale entries before the first collector run.

## Verdict

The install path works end to end on a clean host, and the collectors, search, timers and member isolation behave as the spec says. Defects 1 to 3 and 5 are fixed and covered by tests; 4 is documented; 6 is open.
