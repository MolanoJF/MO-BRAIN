---
name: query
version: 1.0.0
description: |
  Answer a question from this brain using search and citation propagation.
  Use when the member asks a question, wants a lookup, or needs information.
triggers:
  - "what do we know about"
  - "tell me about"
  - "look up"
  - "search for"
  - "who is"
tools:
  - search
  - get_page
  - list_pages
mutating: false
---

# Query

Answer from brain content only. Never invent facts.

1. Search the brain for the question's terms and close paraphrases.
2. Read the pages that actually bear on the answer (`get_page`, `list_pages`).
3. Answer with a citation for every claim, traced to a page slug.
4. If the brain has nothing, say so plainly rather than guessing.
