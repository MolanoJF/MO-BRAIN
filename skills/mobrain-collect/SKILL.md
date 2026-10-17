---
name: mobrain-collect
description: Run one Mo-brain collector - read new items from a source with the person's own tools, ingest them into the brain through gbrain's MCP following gbrain's ingestion skills, and advance the collector's watermark only after a clean batch. Also covers adding, pausing and rescheduling collectors. Use when a timer prompt says "Use the mobrain-collect skill to run collector ...", or the person says "collect my email now", "connect my calendar", "pause the Notion collector", "check my sources more often".
triggers:
  - "mobrain-collect"
  - "run collector"
  - "collect my email now"
  - "pause the collector"
  - "connect my calendar"
---

# Run a Mo-brain collector

## Contract

One run handles one collector page, `system/collectors/<id>`, in one source. It:
- reads only items newer than the page's `watermark` (or within `backfill_days` in backfill mode);
- writes every item through gbrain's MCP, via the skill gbrain names for that content;
- moves `watermark` forward only past items that were written;
- ends its final message with exactly two lines:

```
MOBRAIN_STATUS: ok|partial|error
MOBRAIN_SUMMARY: <one line: read N, created N, updated N, skipped N, errors N>
```

`partial` means some items remain (cap reached) or some failed and were left behind the watermark. The runner records these lines; a run without them counts as `error`.

## Phase 1: Read the collector

`get_page` the collector slug, in the source named by the prompt, with `include_content: true`. Read `kind`, `enabled`, `allowed_tools`, `watermark`, `backfill_days` and the body notes. If `enabled` is false, stop with `MOBRAIN_STATUS: ok` and `MOBRAIN_SUMMARY: disabled`.

Read the kind reference next to this file: `kinds/<kind>.md`.

## Phase 2: Fetch

Use only the tools in `allowed_tools` to list items newer than the watermark, oldest first, at most 200 in incremental mode and at most 500 per run in backfill mode. In backfill mode, follow gbrain's `bulk-ingestion` discipline inside the run: process 5 to 10 items, check their pages against the filing rules below, fix your approach, then continue.

## Phase 3: Ingest each item through gbrain

Read the installed gbrain skills named here as the authority; do not restate them from memory:
- Before creating any page: `brain-ingest-gate` (resolve entities, deduplicate).
- Meetings and transcripts: `meeting-ingestion`, end to end, including its verification checklist.
- Documents and articles: `idea-ingest` or `media-ingest` as gbrain's resolver routes them.
- Every person and company touched: `enrich`.
- Where a page goes: `brain-taxonomist`, against the active schema (`mobrain-brain`, which extends `mobrain-core`).

**Mo-brain:** write through the MCP server the prompt names (`gbrain`, or `gbrain-company-<source>` for a company source). Give every page from an external item a stable `source_ref` in its frontmatter (`gmail:<threadId>`, `gcal:<eventId>`, `drive:<fileId>`, `notion:<pageId>`, `granola:<id>`), and look it up before writing so a re-run updates instead of duplicating. Cite the item's link in the page.

## Phase 4: Advance the watermark

Only after every item up to a point is written, set the collector page's `watermark` to that point (`put_page` with the page's current revision as `expected_revision`, everything else unchanged). Never move it past a failed item. On a revision conflict, re-read the page and retry once.

## Phase 5: Report

End with the two lines from the contract.

## Managing collectors (interactive, when the person asks)

- Add: `mobrain collector add` (see `mobrain-install` Phase 5), then `mobrain collect system/collectors/<slug> --backfill`.
- Pause or resume: `mobrain collector set system/collectors/<slug> --enabled false|true`, or edit the page's `enabled` through gbrain MCP.
- Change cadence: `mobrain collector set system/collectors/<slug> --cadence <cadence>`. Allowed: `<n>m` (15 or more), `<n>h`, `<n>d`, `daily@HH:MM`, `once`.
- Run now: `mobrain collect system/collectors/<slug>`.

## Anti-patterns

- Fetching with a tool not in `allowed_tools`, or calling a source API directly with a credential.
- Copying a whole email body, document or transcript into a page instead of following the ingestion skill.
- Advancing the watermark at the start of a run, or past a failure.
- Omitting the two closing lines.
