# Kind: docs (Drive, Docs, Notion, other knowledge bases)

- Fetch documents created or modified since the watermark, within the folders, spaces or databases the collector notes name (ask the person once if the notes name none; never crawl everything silently).
- One `source` page per document under `sources/`: a summary, key points, the link, and the last-modified time. Not a raw copy.
- Then the concepts, projects, decisions and people the document establishes, through `idea-ingest` and `brain-ingest-gate`.
- A changed document updates its existing `source` page (same `source_ref`).
- Watermark: the newest modified time written.
