# CI runbook

GitHub Actions minutes are a budget. The `MoliorOS` org is on the Free plan:
**2,000 Linux minutes a month, shared by every private repo in the org**, each
job rounded up to the whole minute. On 2026-09-29 one PR fix loop spent 633 of
them in a day. Branch protection is unavailable on this plan, so a red run
blocks nothing; it only costs minutes.

## What runs when

| Workflow | Runs | Cost | What it proves |
|---|---|---|---|
| `ci.yml` | every PR push and push to `main` (docs-only changes skipped; superseded runs cancelled) | ~1 min | lint:forbidden, tsc, unit |
| `stack.yml` | **only** by hand | up to 40 min | the Docker self-test: `bin/mobrain selftest`, keyless, with the stub harness |

That is the whole workflow set. `.github/workflows` holds exactly those two files, and
`test/unit/workflows.test.ts` fails if a third appears.

Nothing is scheduled. The same test fails if a workflow gains a `schedule:`, if anything but
`ci.yml` triggers on push/PR, or if a job has no `timeout-minutes`.

## Running the self-test

Run it once, when a change touches the stack, `bin/mobrain`, the compose files or the
server's install path:

```bash
gh workflow run stack.yml --ref <branch>
gh run watch "$(gh run list --workflow stack.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

`stack.yml` takes no inputs. It runs on a clean runner, so it is the check that the install
path works without this host's state.

## Local first, CI last

Iterate locally against the dev stack, not by pushing:

```bash
bun run test:unit      # no Docker: the unit suite, as ci.yml runs it
bun run test:db        # a throwaway Postgres container, local only
```

Dispatch `stack.yml` once, when the local run is green, to confirm on a clean runner.

**Never use CI as a remote test runner.** Do not push commit after commit to a
PR to see whether a fix works. Do not push the same fix to several PR branches
at once; each push to each PR is a separate billed run.
