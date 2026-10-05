# Agent rules for this repo

Start with `HANDOFF.md`. CI rules (`docs/runbooks/ci.md`):

- GitHub Actions minutes are a shared, capped budget (Free plan, 2,000 min/month for the whole org).
- Never iterate on a fix by pushing to a PR or to `main` and waiting for CI. Run the suite locally (`bun run test:unit`, `bun run test:contract:isolated`, …) until it is green, then push once.
- Never push the same change to more than one PR branch in a loop.
- The Docker suites run only by hand (`gh workflow run stack.yml -f suite=<one suite>`) or from `release.yml`. Dispatch at most once per finished change, and never on a schedule.
- Do not add `schedule:` triggers or new push/PR workflows; `test/unit/workflows.test.ts` will fail.
