# Kind: calendar

- Each run reads events from 7 days back to 14 days ahead; backfill reads `backfill_days` back and 60 days ahead.
- One `event` page per event under `calendar/YYYY/`, with time, attendees, location or link, and the agenda if any. Update the page when the event changes; mark cancelled events `status: cancelled`, never delete.
- Enrich attendees who are not the person.
- Recurring events: one page per series under `calendar/series/`, plus pages only for occurrences with notes or changes.
- Watermark: the run time (calendar windows are re-read each run, so the watermark only records the last successful run).
