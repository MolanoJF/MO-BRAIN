# Agent rules for this repo

Start with `HANDOFF.md`. Procedures: `docs/runbooks/`. Do not read `docs/archive/` unless asked.

CI rules (`docs/runbooks/ci.md`):

- GitHub Actions minutes are a shared, capped budget (Free plan, 2,000 min/month for the whole org).
- Never iterate on a fix by pushing to a PR or to `main` and waiting for CI. Run the suite locally (`bun run test:unit`, `bun run test:db`, …) until it is green, then push once.
- Never push the same change to more than one PR branch in a loop.
- `stack.yml` runs `bin/mobrain selftest` by hand only (`gh workflow run stack.yml`). Dispatch at most once per finished change, never on a schedule.
- Do not add `schedule:` triggers or new push/PR workflows; `test/unit/workflows.test.ts` will fail.
