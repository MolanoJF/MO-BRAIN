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
| `stack.yml` | **only** by hand, or from `release.yml` | `all` ≈ 29 min · `contract` ≈ 13 · `e2e` ≈ 9 · `integration` ≈ 4 · `build` ≈ 2 | the Docker stack: build gates, integration, contract, restore, slice2 |
| `release.yml` | `v*` tag or dispatch | stack + publish | stack green → publish the three pinned images |
| `release-verify.yml` | **only** by hand | 1–45 min per job | published images pull by digest, are anonymously public, and install on a clean host; `push-permission` (5 min) checks the token may push the three packages — dispatch it before tagging a release |

Releases publish the three pinned images under the MoliorOS org namespace
(`ghcr.io/molioros`); after each release, refresh `release-verify.yml`'s digest
defaults with the new `RepoDigest`s (the current defaults record the v1.0.0
digests).

Nothing is scheduled. `test/unit/workflows.test.ts` fails if a workflow gains a
`schedule:`, if anything but `ci.yml` triggers on push/PR (the one exemption is
`release.yml`'s `v*` tag push), or if a job has no `timeout-minutes` (jobs that
only `uses:` a reusable workflow are exempt: they inherit the callee's timeouts).

## Running the stack suites

Run the suite you are changing, not `all`:

```bash
gh workflow run stack.yml --ref <branch> -f suite=contract
gh run watch "$(gh run list --workflow stack.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Drift check when an upstream gbrain tag lands (this replaced the nightly cron):

```bash
gh workflow run stack.yml -f suite=contract -f gbrain_version=0.51.0.0
```

## Local first, CI last

Iterate locally against the dev stack, not by pushing:

```bash
bun run test:unit
bun run test:integration:isolated   # needs the dev stack up
bun run test:contract:isolated      # needs the dev stack up and bootstrapped
bun test test/e2e/slice2.e2e.test.ts
```

Dispatch `stack.yml` once, when the local run is green, to confirm on a clean
runner.

**Never use CI as a remote test runner.** Do not push commit after commit to a
PR to see whether a fix works. Do not push the same fix to several PR branches
at once; each push to each PR is a separate billed run.
