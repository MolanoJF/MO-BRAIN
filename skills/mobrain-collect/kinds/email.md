# Kind: email

- Fetch threads with new messages since the watermark (an ISO timestamp of the newest message processed). Newest-first listing is fine; process oldest first.
- Skip without writing: newsletters and marketing (List-Unsubscribe header, bulk senders), automated notifications, no-reply senders, calendar invites (the calendar collector owns those), and anything the collector notes say to skip.
- One `conversation` page per meaningful thread under `emails/`: who, what was asked or promised, decisions, dates; quote sparingly; link to the thread.
- Enrich every person and company with a real role in the thread.
- Note open loops (someone waiting on the person, or the person promised something) in the page body under `## Open loops`.
- Watermark: the newest message timestamp written.
