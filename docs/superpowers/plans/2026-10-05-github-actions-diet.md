# GitHub Actions Diet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut this repo's GitHub Actions spend from "can exhaust the org's 2,000 free minutes in two days" to a predictable ≤ 400 billed minutes a month. Only a ~1-minute lint/typecheck/unit check runs on its own. Every Docker-backed suite runs on demand or before a release.

**Architecture:** `contract.yml` (7 jobs, ~33 billed minutes per push or PR event) splits in two. `ci.yml` runs only the `unit` job on push and PR, cancels superseded runs, and skips docs-only changes. `stack.yml` holds build-gates, integration, contract, restore, and slice2, runs only by `workflow_dispatch` or `workflow_call`, and can run one suite at a time. Both scheduled workflows go away. `nightly.yml`'s drift arm becomes a `stack.yml` dispatch with `gbrain_version`. `ghcr-visibility.yml`'s check and `contract.yml`'s `clean-install` move into the dispatch-only `release-verify.yml`. `release.yml` calls `stack.yml` before it publishes. A unit test (`test/unit/workflows.test.ts`) locks the budget rules in, so the expensive shapes cannot drift back.

**Tech Stack:** GitHub Actions YAML, Bun 1.3.14 (`bun:test`), the `yaml` npm package (already a dependency), `actionlint` via Docker, `gh` CLI.

**Spec:** the audit in the "Audit findings" section below (2026-10-05). It is reproduced here because the audit was done in a chat session, not a committed doc.

## Global Constraints

- The org `MoliorOS` is on the GitHub **Free** plan: **2,000 Linux minutes/month shared across every private repo**, including `MOLIOR-OS` (which used 1,071 of September's 1,844). Every job is billed rounded **up** to the whole minute.
- Branch protection and rulesets are unavailable (HTTP 403 "Upgrade to GitHub Pro or make this repository public"). CI is advisory and blocks nothing, so a red run is pure cost.
- Pinned versions stay as they are: `GBRAIN_VERSION` `0.50.5.0` (pinned-current), `HARNESS_VERSION` `2.1.274`, `APP_VERSION` `1.0.0`, Bun `1.3.14`. Do not change pins in this plan.
- No workflow may have a `schedule:` trigger.
- Only `ci.yml` may trigger on `push` or `pull_request`.
- Every job has `timeout-minutes` (a job without it can run 360 minutes). The exception is a job that only `uses:` a reusable workflow, whose own jobs carry the timeout.
- Do not ignore `contracts/**` in path filters. `test/unit/registry.test.ts` reads `contracts/v0.51.0.0/operations.json`.
- Do not print or overwrite `.env`. CI materializes its own throwaway `.env` from job env only.
- Write every YAML and `*.sh` file with LF line endings.
- actionlint steps below use Docker. If Docker Desktop is not running, use the standalone binary instead. Download `https://github.com/rhysd/actionlint/releases/download/v1.7.7/actionlint_1.7.7_windows_amd64.zip` into the scratchpad, unzip `actionlint.exe`, and run it from the repo root with the same file arguments. The plan's `ci.yml` and `stack.yml` drafts passed actionlint 1.7.7 on 2026-10-05.
- `gh` now has the `workflow` scope (verified with `gh auth status` on 2026-10-05), so workflow-file pushes no longer need the temporary deploy key `HANDOFF.md` describes.

---

## Audit findings (the spec)

### Where the minutes went

| Window | MO-BRAIN billed minutes | Cause |
|---|---|---|
| 2026-09-29 (one day) | **633** | 27 `contract` runs on PRs #4 and #5. An agent fix-and-push loop pushed each commit to **both** PR branches at the same minute, every 5–30 min, from 03:32 to 07:42 UTC. Every run had a distinct SHA, none were docs-only, and all 27 failed. The PRs were used as a remote test runner. |
| 2026-09-19 (personal account, before the org transfer) | ~454 | 17 pushes to `main` in 2 h, one `contract` run per commit, all `ci(...)`/`test(...)` fixes, all failed. |
| Every day since 09-24 | ~9–10 | `nightly` (2 matrix arms × ~4 min) + `ghcr-visibility` (1 min). About 320 min/month. |
| Contract, normal weeks (09-22 → 10-05, excluding 09-29) | ~194 / 2 weeks | About 415 min/month even without storms. 8 of the 69 contract runs touched only docs. |

Per-run cost of `contract.yml` (run `36433526872`): unit 1, build-gates 2, clean-install 4, integration 4, **contract 13**, restore 4, slice2 5 = **33 billed minutes**. There is no `concurrency` group and no path filter, and 4 of the 7 jobs each rebuild `gbrain-base` from scratch.

### Why runs fail

| ID | Where | Status | Root cause | Category |
|---|---|---|---|---|
| R1 | `contract.yml` → `slice2` | **Deterministic, still failing** (3/3) | `src/control/privateSpaces.ts` (`if (created) { … } catch { /* best-effort */ }` around `seedSpace` + `sources.add`) swallows a failed source registration. Only the first member's `my-space-*` source registers. Later members' MCP grants fail `source_inactive, read_source_inactive`, claims return 400, and slice2 tests 5–7 and C2–C6 cascade. Main also lacks the explicit test timeouts added on the PR branches (`47df3d7`, `9dc6f65`, `4bdd620`), so tests 3 and C1 time out at Bun's 5 s default. slice2 was hidden from 09-21 to 09-28 because `contract` failed first and skipped it. | Product bug + stale test |
| R2 | `contract.yml` → `contract` | Mitigated | The worker cold-start race in issue #6. It is fixed by `pauseBrainWriters` (merged 09-28), and contract passed in the three runs after the fix. | Flaky race (fixed) |
| R2′ | `contract` job and **both** `nightly` arms | **Intermittent, still failing nightly** | `POST /api/wizard/finish` fails 503/499/500 in the bootstrap step. `src/ops/writerGate.ts:60` needs `backends === 0`, but "other backends" stays at 1–2 with the supervisor down. `QUIET_TIMEOUT_MS` is 60 s (`writerGate.ts:6`), the same as the control plane's `idleTimeout` (`src/control/app.ts`). That is probably why some runs report 499 `{"raw":""}` instead of 503 (UNVERIFIED: CI captures no container logs). | Product bug in the new gate |
| R3a | `contract.yml` → `unit` | One-off | `fileplane.test.ts:122` EACCES on `/srv/gbrain-home`, likely module-load-order dependent in the single-process unit run. | Order-dependent test |
| R3b, R4 | `unit` / bootstrap | Fixed | A stale `contracts/v0.51.0.0/operations.json` on an old branch, and `company_mode_required` in `scripts/ci-bootstrap-brain.ts` (fixed in `5850c1e`). | Stale fixture/script |
| N1 | `nightly` 0.51 arm | Noise | The real 0.51 drift (missing `operations.json`) was fixed 09-28 by `fc4d6f1`. Since then the arm dies at R2′, not drift. It still posts a nightly comment on issue #2 (17 so far). Each comment says "Pinned-current (0.50.5.0) is unaffected" (`scripts/drift-issue-body.sh:39`), which is false. `main` has been `5554c95` since 09-28, so every nightly re-runs identical code. | Noise |

No infra failures (disk, OOM, secrets, GHCR) appeared in any sampled log.

### Decision per automation

| Automation | Trigger today | Cost | Decision | Why |
|---|---|---|---|---|
| `contract.yml` → `unit` (lint:forbidden, tsc, unit) | push main + every PR event | 1 min | **KEEP, as `ci.yml`**, with concurrency cancel and a docs path filter | Cheap and fast, and catches most regressions. It is the only check worth running automatically. |
| `contract.yml` → `build-gates` | push + PR | 2 min | **MOVE to `stack.yml`** (suite `build`) | Pin-rule proof. It only matters when a Dockerfile or pin changes. |
| `contract.yml` → `integration` | push + PR | 4 min | **MOVE to `stack.yml`** (suite `integration`) | Needs the full Docker stack, and can run locally against the dev stack. |
| `contract.yml` → `contract` | push + PR | 13 min | **MOVE to `stack.yml`** (suite `contract`) | 42% of all cost, and currently flaky (R2′). Run on demand. |
| `contract.yml` → `restore`, `slice2` | push + PR (chained behind `contract`) | 9 min | **MOVE to `stack.yml`** (suite `e2e`), unchained | Chaining hid R1 for a week. They become independent jobs. |
| `contract.yml` → `clean-install` | push + PR | 4 min | **MOVE to `release-verify.yml`** | It pulls the already-published v1.0.0 images, so it tests nothing in the PR. It is only meaningful after a release. |
| `nightly.yml` | daily cron | ~290 min/mo | **DELETE**. Drift becomes `stack.yml -f gbrain_version=<next>` on demand. | It has re-run identical code to the same flake every day since 09-28 and is misattributing comments on #2. Drift is checked when an upstream tag lands, not nightly. |
| `scripts/drift-issue-body.sh` + `test/unit/drift-issue-body.test.ts` | used only by `nightly.yml` | — | **DELETE** | No caller is left. |
| `ghcr-visibility.yml` | daily cron | ~30 min/mo | **DELETE**. The check moves into `release-verify.yml` as a dispatchable job. | `release.yml`'s `verify-public` already checks at publish time. During the MVP, a manual toggle to private is caught by the next release or a manual dispatch. |
| `release.yml` | `v*` tag / dispatch | ~0 idle | **KEEP**, gated on `stack.yml`, with timeouts | Releases are rare. A release must prove the stack first. |
| `release-verify.yml` | dispatch only | 0 idle | **KEEP**, absorbing `public` and `clean-install` | All post-release proofs live in one on-demand place. |

### Budget after the change

| Item | Estimate |
|---|---|
| `ci.yml` (`unit`, ~1 min, cancel-superseded, docs skipped) | ~100–200 min/mo |
| Scheduled workflows | 0 |
| `stack.yml` by hand (`all` ≈ 29 min; `contract` only ≈ 13 min; `build` ≈ 2 min) | ~150–200 min/mo at ~10 targeted runs |
| `release.yml` (stack ≈ 29 + publish) | ~40 min per release |
| **Total** | **≤ 400 min/mo**, versus 633 on one storm day before |

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `test/unit/workflows.test.ts` | Create | Guardrail: encodes the budget rules (triggers, schedules, timeouts, release gating) as tests. |
| `.github/workflows/ci.yml` | Create | The only automatic workflow: lint:forbidden, tsc, unit. |
| `.github/workflows/stack.yml` | Create | On-demand Docker suites (build, integration, contract, e2e), selectable by `suite`, any `gbrain_version`. |
| `.github/workflows/contract.yml` | Delete | Split into `ci.yml` + `stack.yml`. |
| `.github/workflows/nightly.yml` | Delete | Replaced by dispatching `stack.yml` with `gbrain_version`. |
| `.github/workflows/ghcr-visibility.yml` | Delete | Check moved into `release-verify.yml`. |
| `.github/workflows/release-verify.yml` | Modify | Adds `public` and `clean-install` jobs and timeouts. |
| `.github/workflows/release.yml` | Modify | Calls `stack.yml` before `publish`; adds timeouts. |
| `scripts/drift-issue-body.sh`, `test/unit/drift-issue-body.test.ts` | Delete | No remaining caller. |
| `docs/runbooks/ci.md` | Create | What runs when, the budget, how to dispatch, and the "no CI fix loops" rule. |
| `CLAUDE.md` | Create | Short agent-facing rule: never use PR/push CI as a test loop; run suites locally. |
| `docs/support-policy.md`, `HANDOFF.md`, `scripts/redeploy.sh` | Modify | Remove references to the nightly cron, daily visibility check, `contract.yml`, and the stale deploy-key note. |

---

### Task 1: Split `contract.yml` into `ci.yml` (automatic) and `stack.yml` (on demand)

**Files:**
- Create: `test/unit/workflows.test.ts`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/stack.yml`
- Delete: `.github/workflows/contract.yml`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `stack.yml` accepts inputs `suite` (`all | build | integration | contract | e2e`, default `all`) and `gbrain_version` (string, blank = `0.50.5.0`) on both `workflow_dispatch` and `workflow_call`. Task 3 calls it with `suite: all`.
  - Test helpers in `test/unit/workflows.test.ts`: `workflows(): Record<string, Workflow>` and `triggers(wf: Workflow): string[]`. Tasks 2 and 3 add `test(...)` blocks that use them.

- [ ] **Step 1: Write the failing guardrail test**

Create `test/unit/workflows.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// Actions minutes are a budget (docs/runbooks/ci.md): the org's Free plan shares
// 2,000 Linux minutes a month across every private repo, and on 2026-09-29 one
// PR fix loop burned 633 of them in a day. These checks keep the expensive
// shapes out of .github/workflows for good.
const DIR = join(import.meta.dir, '..', '..', '.github', 'workflows');

type Job = { 'timeout-minutes'?: number; uses?: string; needs?: string | string[] };
type Workflow = {
  on: string | string[] | Record<string, unknown>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs: Record<string, Job>;
};

function workflows(): Record<string, Workflow> {
  const out: Record<string, Workflow> = {};
  for (const name of readdirSync(DIR).filter((n) => /\.ya?ml$/.test(n))) {
    out[name] = parse(readFileSync(join(DIR, name), 'utf8')) as Workflow;
  }
  return out;
}

function triggers(wf: Workflow): string[] {
  if (typeof wf.on === 'string') return [wf.on];
  if (Array.isArray(wf.on)) return wf.on;
  return Object.keys(wf.on);
}

describe('workflow budget rules', () => {
  test('only ci.yml runs on push or pull_request', () => {
    const automatic = Object.entries(workflows())
      .filter(([, wf]) => triggers(wf).some((t) => t === 'push' || t === 'pull_request'))
      .map(([name]) => name);
    // release.yml's tag push is the one allowed exception: it is a release.
    expect(automatic.filter((n) => n !== 'release.yml')).toEqual(['ci.yml']);
  });

  test('release.yml pushes only on v* tags, never on branches', () => {
    const on = workflows()['release.yml'].on as Record<string, { tags?: string[]; branches?: string[] }>;
    expect(on.push.tags).toEqual(['v*']);
    expect(on.push.branches).toBeUndefined();
    expect(on.pull_request).toBeUndefined();
  });

  test('ci.yml cancels superseded runs and skips docs-only changes', () => {
    const ci = workflows()['ci.yml'];
    expect(ci.concurrency?.['cancel-in-progress']).toBe(true);
    const on = ci.on as Record<string, { 'paths-ignore'?: string[] }>;
    for (const event of ['push', 'pull_request']) {
      expect(on[event]['paths-ignore']).toContain('docs/**');
      expect(on[event]['paths-ignore']).not.toContain('contracts/**');
    }
  });

  test('stack.yml runs only on demand or from another workflow', () => {
    expect(triggers(workflows()['stack.yml']).sort()).toEqual(['workflow_call', 'workflow_dispatch']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/workflows.test.ts`
Expected: FAIL. `only ci.yml…` reports `contract.yml` in the list, and the `ci.yml`/`stack.yml` tests throw `undefined is not an object` because those files do not exist yet.

- [ ] **Step 3: Create `.github/workflows/ci.yml`**

```yaml
name: ci

# The ONLY workflow that runs on its own: lint, typecheck and the unit suite on
# every PR push and every push to main (~1 billed minute). Everything that needs
# Docker (build gates, integration, contract, e2e) lives in stack.yml and runs
# on demand or before a release. Budget and rules: docs/runbooks/ci.md.
on:
  push:
    branches: [main]
    paths-ignore: ['docs/**', '*.md']
  pull_request:
    paths-ignore: ['docs/**', '*.md']
  workflow_dispatch:

# A newer push to the same branch/PR makes the older run worthless.
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  unit:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    env:
      # Bun loads the repo's .env locally; a CI runner has none, so the pin is
      # passed explicitly. Without it pin.ts falls back to 0.50.0.0 and the
      # operations.json seam test reads the wrong registered version.
      GBRAIN_VERSION: '0.50.5.0'
      HARNESS_VERSION: '2.1.274'
      CONTROL_DATABASE_URL: postgres://gbrain:ci-not-a-real-secret@localhost:5432/control
    services:
      # The unit suite's Postgres-backed checks refuse to skip silently.
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_USER: gbrain
          POSTGRES_PASSWORD: ci-not-a-real-secret
          POSTGRES_DB: control
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U gbrain -d control"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 30
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.14 }
      - run: bun install --frozen-lockfile
      - run: bun run lint:forbidden
      - run: bunx tsc --noEmit
      - run: bun run test:unit
```

Note: `'*.md'` matches root-level Markdown only (GitHub's `*` does not cross `/`). Markdown files elsewhere, such as schema packs, still trigger CI.

- [ ] **Step 4: Create `.github/workflows/stack.yml`**

```yaml
name: stack

# The Docker-backed suites: build gates, integration, contract, and the restore
# and slice2 e2e legs. `all` costs ~30 billed minutes, so this workflow NEVER
# runs on push or pull_request (docs/runbooks/ci.md). Run it by hand when a
# change touches the stack, ideally one suite at a time:
#   gh workflow run stack.yml --ref <branch> -f suite=contract
# release.yml calls it before publishing. It also replaces nightly.yml's
# pinned-next drift arm:
#   gh workflow run stack.yml -f gbrain_version=0.51.0.0
on:
  workflow_dispatch:
    inputs:
      suite:
        description: 'Suite to run'
        type: choice
        options: [all, build, integration, contract, e2e]
        default: all
      gbrain_version:
        description: 'gbrain pin under test (blank = pinned-current 0.50.5.0)'
        type: string
        default: ''
  workflow_call:
    inputs:
      suite:
        type: string
        default: all
      gbrain_version:
        type: string
        default: ''

concurrency:
  group: stack-${{ github.ref }}-${{ inputs.suite }}-${{ inputs.gbrain_version }}
  cancel-in-progress: true

permissions:
  contents: read

# GHCR coordinates come from repo Actions variables; the product defaults
# (ghcr.io / molanojf) apply when a variable is unset or empty.
env:
  IMAGE_REGISTRY: ${{ vars.IMAGE_REGISTRY }}
  IMAGE_NAMESPACE: ${{ vars.IMAGE_NAMESPACE }}
  GBRAIN_VERSION: ${{ inputs.gbrain_version || '0.50.5.0' }}
  HARNESS_VERSION: '2.1.274'

jobs:
  build-gates:
    if: inputs.suite == 'all' || inputs.suite == 'build'
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.14 }
      - run: bun install --frozen-lockfile
      # Both gates keep the exact-pin rule honest: the pinned build must
      # succeed and a deliberately wrong pin must be rejected (G1).
      - name: gbrain-base build gate
        run: bash test/build/pin.test.sh
      - name: agent-runner build gate
        run: bash test/build/harness-pin.test.sh

  integration:
    if: inputs.suite == 'all' || inputs.suite == 'integration'
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      DOMAIN: localhost
      POSTGRES_PASSWORD: ci-not-a-real-secret
      OPS_RPC_TOKEN: ci-not-a-real-token
      # Host-side tests: opsClient defaults to http://gbrain-ops:3140 (in-compose DNS).
      OPS_RPC_URL: http://127.0.0.1:3140
      ENCRYPTION_KEY: ci-encryption-key-at-least-32-characters-long
      BETTER_AUTH_SECRET: ci-better-auth-secret-at-least-32-chars
      CONTROL_DATABASE_URL: postgres://gbrain:ci-not-a-real-secret@localhost:5432/control
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_USER: gbrain
          POSTGRES_PASSWORD: ci-not-a-real-secret
          POSTGRES_DB: control
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U gbrain -d control"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 30
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.14 }
      - run: bun install --frozen-lockfile
      - name: Build the pinned base image
        run: |
          docker build -f docker/gbrain-base.Dockerfile \
            --build-arg "GBRAIN_VERSION=${GBRAIN_VERSION}" \
            -t "${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE:-molanojf}/gbrain-base:${GBRAIN_VERSION}" .
      - name: "Mirror the base and build the stack through the overlay (D2)"
        run: |
          docker tag "${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE:-molanojf}/gbrain-base:${GBRAIN_VERSION}" \
            "mobrain/gbrain-base:${GBRAIN_VERSION}"
          docker compose -f compose/docker-compose.yml -f compose/docker-compose.build.yml build \
            --build-arg "GBRAIN_VERSION=${GBRAIN_VERSION}" \
            control-plane scheduler
      - name: Bring the dev stack up on the pinned images
        run: docker compose -f compose/docker-compose.yml -f compose/docker-compose.dev.yml up -d --wait
      # mock.module() is process-global, so one file's partial mock answers a
      # sibling's import in a single Bun process. One process per file is the
      # isolation the suite needs, and it bounds peak memory to one file's
      # module graph (the full-stack + all-files run was OOM-killed).
      - run: bun run test:integration:isolated
      # CI had no container logs, which is why the 499s in the audit are still
      # unexplained. Cheap to print, priceless when red.
      - name: Dump stack logs on failure
        if: failure()
        run: docker compose -f compose/docker-compose.yml -f compose/docker-compose.dev.yml logs --no-color --tail=300

  contract:
    if: inputs.suite == 'all' || inputs.suite == 'contract'
    runs-on: ubuntu-latest
    timeout-minutes: 45
    env:
      APP_VERSION: '1.0.0'
      DOMAIN: localhost
      POSTGRES_PASSWORD: ci-not-a-real-secret
      OPS_RPC_TOKEN: ci-not-a-real-token
      # Host-side contract tests reach the main stack (ops at :3140, serve at :3131).
      OPS_RPC_URL: http://127.0.0.1:3140
      ENCRYPTION_KEY: ci-encryption-key-at-least-32-characters-long
      BETTER_AUTH_SECRET: ci-better-auth-secret-at-least-32-chars
      # runner.contract's A5/A9 legs pinDb() against the scratch Postgres below.
      CONTROL_DATABASE_URL: postgres://gbrain:ci-not-a-real-secret@localhost:5432/control
      # The slice0 stack's `gbrain init`/`embed` refuse without the key their
      # embedding model names (compose/docker-compose.slice0.yml passes it in).
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_USER: gbrain
          POSTGRES_PASSWORD: ci-not-a-real-secret
          POSTGRES_DB: control
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U gbrain -d control"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 30
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.14 }
      - run: bun install --frozen-lockfile
      # The seam-gate contract legs (scheduler, upgrade) shell
      # `docker compose --env-file .env …` and read `.env` for OPS_RPC_TOKEN.
      # A CI runner has no .env; materialize one from the job environment so
      # those legs address the stack this job just brought up. Never committed.
      - name: Materialize .env for the live-stack contract legs
        run: |
          {
            echo "DOMAIN=${DOMAIN}"
            echo "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}"
            echo "OPS_RPC_TOKEN=${OPS_RPC_TOKEN}"
            echo "ENCRYPTION_KEY=${ENCRYPTION_KEY}"
            echo "BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}"
            echo "GBRAIN_VERSION=${GBRAIN_VERSION}"
            echo "HARNESS_VERSION=${HARNESS_VERSION}"
            echo "APP_VERSION=${APP_VERSION}"
            echo "IMAGE_REGISTRY=${IMAGE_REGISTRY:-ghcr.io}"
            echo "IMAGE_NAMESPACE=${IMAGE_NAMESPACE:-molanojf}"
            echo "OPENAI_API_KEY=${OPENAI_API_KEY}"
          } > .env
      - name: Build the pinned base image
        run: |
          docker build -f docker/gbrain-base.Dockerfile \
            --build-arg "GBRAIN_VERSION=${GBRAIN_VERSION}" \
            -t "${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE:-molanojf}/gbrain-base:${GBRAIN_VERSION}" .
      - name: "Mirror the base and build the stack through the overlay (D2)"
        run: |
          docker tag "${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE:-molanojf}/gbrain-base:${GBRAIN_VERSION}" \
            "mobrain/gbrain-base:${GBRAIN_VERSION}"
          docker compose -f compose/docker-compose.yml -f compose/docker-compose.build.yml build \
            --build-arg "GBRAIN_VERSION=${GBRAIN_VERSION}" \
            --build-arg "HARNESS_VERSION=${HARNESS_VERSION}" \
            control-plane scheduler agent-runner
      - name: Mirror the agent-runner under the bare name the contract test runs
        run: |
          # runner.contract.test.ts runs `docker run mobrain/agent-runner:<pin>`;
          # the overlay tags it with the registry-qualified service name.
          docker tag "${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE:-molanojf}/agent-runner:${HARNESS_VERSION}" \
            "mobrain/agent-runner:${HARNESS_VERSION}"
      - name: Bring the dev stack up on the pinned images
        run: docker compose -f compose/docker-compose.yml -f compose/docker-compose.dev.yml up -d --wait
      # F31: drive the PRODUCT's own wizard so the main brain is
      # operator-initialized before the seam legs. Idempotent.
      - name: Bootstrap the main brain through the wizard (F31)
        run: bun run scripts/ci-bootstrap-brain.ts
        env:
          BOOTSTRAP_BASE_URL: https://localhost:8443
          BOOTSTRAP_TLS_INSECURE: '1'
          BOOTSTRAP_ADMIN_EMAIL: admin@example.test
          BOOTSTRAP_ADMIN_PASSWORD: a-long-enough-password
          BOOTSTRAP_ORG: Acme
      # One process per file: see test:integration:isolated above.
      - run: bun run test:contract:isolated
      - name: Dump stack logs on failure
        if: failure()
        run: docker compose -f compose/docker-compose.yml -f compose/docker-compose.dev.yml logs --no-color --tail=300
      # A capability snapshot is only news on a drift run (a non-default pin).
      - name: Capture the capability snapshot (drift runs only)
        if: always() && inputs.gbrain_version != ''
        run: bun run capability:capture || true
      - uses: actions/upload-artifact@v4
        if: always() && inputs.gbrain_version != ''
        with:
          name: capability-${{ env.GBRAIN_VERSION }}-${{ github.sha }}
          path: contracts/
          retention-days: 7

  # Untested restore is not backup. Not chained behind `contract` any more:
  # the chain hid slice2's deterministic failure for a week (audit R1).
  restore:
    if: inputs.suite == 'all' || inputs.suite == 'e2e'
    runs-on: ubuntu-latest
    timeout-minutes: 45
    env:
      DOMAIN: localhost
      POSTGRES_PASSWORD: ci-not-a-real-secret
      OPS_RPC_TOKEN: ci-not-a-real-token
      # Host-side e2e: opsClient defaults to http://gbrain-ops:3140 (in-compose DNS).
      OPS_RPC_URL: http://127.0.0.1:3140
      ENCRYPTION_KEY: ci-encryption-key-at-least-32-characters-long
      BETTER_AUTH_SECRET: ci-better-auth-secret-at-least-32-chars
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.14 }
      - run: bun install --frozen-lockfile
      - name: Build the pinned base image
        run: |
          docker build -f docker/gbrain-base.Dockerfile \
            --build-arg "GBRAIN_VERSION=${GBRAIN_VERSION}" \
            -t "${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE:-molanojf}/gbrain-base:${GBRAIN_VERSION}" .
      - name: "Mirror the base and build the stack through the overlay (D2)"
        run: |
          docker tag "${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE:-molanojf}/gbrain-base:${GBRAIN_VERSION}" \
            "mobrain/gbrain-base:${GBRAIN_VERSION}"
          docker compose -f compose/docker-compose.yml -f compose/docker-compose.build.yml build \
            --build-arg "GBRAIN_VERSION=${GBRAIN_VERSION}" \
            control-plane scheduler
      - run: bun test test/e2e/restore.e2e.test.ts

  slice2:
    if: inputs.suite == 'all' || inputs.suite == 'e2e'
    runs-on: ubuntu-latest
    timeout-minutes: 45
    env:
      DOMAIN: localhost
      POSTGRES_PASSWORD: ci-not-a-real-secret
      OPS_RPC_TOKEN: ci-not-a-real-token
      # Host-side e2e: opsClient defaults to http://gbrain-ops:3140 (in-compose DNS).
      OPS_RPC_URL: http://127.0.0.1:3140
      ENCRYPTION_KEY: ci-encryption-key-at-least-32-characters-long
      BETTER_AUTH_SECRET: ci-better-auth-secret-at-least-32-chars
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.14 }
      - run: bun install --frozen-lockfile
      - name: Build the pinned base image
        run: |
          docker build -f docker/gbrain-base.Dockerfile \
            --build-arg "GBRAIN_VERSION=${GBRAIN_VERSION}" \
            -t "${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE:-molanojf}/gbrain-base:${GBRAIN_VERSION}" .
      - name: "Mirror the base and build the stack through the overlay (D2)"
        run: |
          docker tag "${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE:-molanojf}/gbrain-base:${GBRAIN_VERSION}" \
            "mobrain/gbrain-base:${GBRAIN_VERSION}"
          docker compose -f compose/docker-compose.yml -f compose/docker-compose.build.yml build \
            --build-arg "GBRAIN_VERSION=${GBRAIN_VERSION}" \
            control-plane scheduler
      # Keyword search does not need OPENAI_API_KEY (sync --no-embed).
      - run: bun test test/e2e/slice2.e2e.test.ts
```

What changed versus `contract.yml`, so a reviewer can diff intent rather than text:
- No `unit` job; `needs:` chains are removed.
- Every job has an `if:` suite filter and a `timeout-minutes` (step-level `timeout-minutes: 90` becomes a 45-minute job cap).
- `clean-install` is gone; it moves in Task 2.
- Stack logs are dumped on failure.
- The capability capture and artifact upload run only on drift runs, with 7-day retention.
- `GBRAIN_VERSION` comes from `inputs.gbrain_version`.

- [ ] **Step 5: Delete `contract.yml`**

```bash
git rm .github/workflows/contract.yml
```

- [ ] **Step 6: Run the guardrail test to verify it passes**

Run: `bun test test/unit/workflows.test.ts`
Expected: PASS, 4 tests. (`nightly.yml` and `ghcr-visibility.yml` are not push/PR-triggered, so `only ci.yml…` already passes.)

- [ ] **Step 7: Lint the workflows with actionlint**

Run (Git Bash):
```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo" -w /repo rhysd/actionlint:1.7.7 \
  .github/workflows/ci.yml .github/workflows/stack.yml
```
Expected: no output, exit 0. Fix every error it reports in these two files. Shellcheck `info`/`style` notes on lines copied verbatim from `contract.yml` may be left as they were.

- [ ] **Step 8: Run the full unit gate that `ci.yml` will run**

Run: `bun run lint:forbidden && bunx tsc --noEmit && bun run test:unit`
Expected: all three exit 0. (`test:unit` needs `CONTROL_DATABASE_URL` pointing at a throwaway Postgres, as in `ci.yml`. Never point it at `mobrain-local`.)

- [ ] **Step 9: Commit**

```bash
git add test/unit/workflows.test.ts .github/workflows/ci.yml .github/workflows/stack.yml
git commit -m "ci: run only lint/tsc/unit automatically; move Docker suites to on-demand stack.yml"
```

---

### Task 2: Remove both scheduled workflows; move post-release proofs into `release-verify.yml`

**Files:**
- Delete: `.github/workflows/nightly.yml`
- Delete: `.github/workflows/ghcr-visibility.yml`
- Delete: `scripts/drift-issue-body.sh`
- Delete: `test/unit/drift-issue-body.test.ts`
- Modify: `.github/workflows/release-verify.yml` (add `timeout-minutes` to `verify`; append jobs `public` and `clean-install`)
- Modify: `test/unit/workflows.test.ts` (add one test)

**Interfaces:**
- Consumes: `workflows()` and `triggers()` from Task 1.
- Produces: `release-verify.yml` jobs `verify`, `public`, and `clean-install`, all dispatch-only.

- [ ] **Step 1: Add the failing test**

Append inside `describe('workflow budget rules', …)` in `test/unit/workflows.test.ts`:

```ts
  test('no workflow runs on a schedule', () => {
    const scheduled = Object.entries(workflows())
      .filter(([, wf]) => triggers(wf).includes('schedule'))
      .map(([name]) => name);
    expect(scheduled).toEqual([]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/workflows.test.ts -t "schedule"`
Expected: FAIL. Received `["ghcr-visibility.yml", "nightly.yml"]`.

- [ ] **Step 3: Delete the scheduled workflows and the orphaned drift-issue script**

```bash
git rm .github/workflows/nightly.yml .github/workflows/ghcr-visibility.yml \
       scripts/drift-issue-body.sh test/unit/drift-issue-body.test.ts
```

Confirm nothing else calls the script: `git grep -n "drift-issue-body"`. Expected: no hits outside `docs/` history files.

- [ ] **Step 4: Extend `release-verify.yml`**

Add `timeout-minutes: 15` under `verify:` → `runs-on: ubuntu-latest`. Then append these two jobs at the end of the file, under `jobs:`:

```yaml
  # Was ghcr-visibility.yml's daily cron. Package visibility can flip to private
  # outside any release (a manual toggle, or a package deleted and recreated).
  # release.yml's verify-public catches it at publish time; dispatch this
  # workflow to check it any other time. It never logs in to ghcr.io (see
  # scripts/ci/check-public-images.sh); the point is to see what a
  # credential-less `docker compose pull` sees.
  public:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    env:
      IMAGE_REGISTRY: ghcr.io
      IMAGE_NAMESPACE: molanojf
      GBRAIN_VERSION: '0.50.5.0'
      HARNESS_VERSION: '2.1.274'
      APP_VERSION: '1.0.0'
    steps:
      - uses: actions/checkout@v4
      - name: Verify the three pinned images are publicly, anonymously pullable
        run: bash scripts/ci/check-public-images.sh

  # Gate A, moved from contract.yml: the clean-host install proof. It pulls the
  # already-published RELEASE images, so it says nothing about a PR. It belongs
  # here, after a release, on a fresh runner with none of our images.
  clean-install:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    env:
      CLEAN_INSTALL_E2E: '1'
      CLEAN_INSTALL_DIR: /tmp/clean-install
      IMAGE_REGISTRY: ghcr.io
      IMAGE_NAMESPACE: molanojf
      GBRAIN_VERSION: '0.50.5.0'
      HARNESS_VERSION: '2.1.274'
      # The published control-plane tag. Without it Compose falls back to `dev`,
      # which no registry carries.
      APP_VERSION: '1.0.0'
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.14 }
      - run: bun install --frozen-lockfile
      - name: Free disk space (preflight's 20 GB floor is real on a stock runner)
        uses: jlumbroso/free-disk-space@v1.3.1
        with:
          tool-cache: false
          large-packages: true
          docker-images: true
          swap-storage: true
      - name: Log in to GHCR to pull the published images
        run: echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u "${{ github.actor }}" --password-stdin
      # D1: the runner must be as clean as a stranger's box. Prove it first.
      - name: Assert no image of ours is present
        run: |
          if docker image ls --format '{{.Repository}}' | grep -q "${IMAGE_NAMESPACE}"; then
            echo "runner is pre-seeded; this gate would be a tautology" >&2; exit 1
          fi
      - run: mkdir -p /tmp/clean-install
      - run: bun test test/e2e/install.e2e.test.ts
```

The workflow-level `permissions: { contents: read, packages: read }` already covers `clean-install`'s GHCR pull.

- [ ] **Step 5: Run the guardrail test and actionlint**

Run: `bun test test/unit/workflows.test.ts`
Expected: PASS, 5 tests.

Run: `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo" -w /repo rhysd/actionlint:1.7.7 .github/workflows/release-verify.yml`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
# The four deletions are already staged by Step 3's `git rm`.
git add .github/workflows/release-verify.yml test/unit/workflows.test.ts
git commit -m "ci: drop the nightly and ghcr-visibility crons; post-release proofs are on demand"
```

---

### Task 3: Gate `release.yml` on `stack.yml` and put a timeout on every job

**Files:**
- Modify: `.github/workflows/release.yml` (add a `stack` job before `publish`; `publish.needs: stack`; timeouts on `publish` and `verify-public`)
- Modify: `test/unit/workflows.test.ts` (add two tests)

**Interfaces:**
- Consumes: `stack.yml`'s `workflow_call` inputs `suite` and `gbrain_version` (Task 1), and `workflows()` (Task 1).
- Produces: nothing new.

- [ ] **Step 1: Add the failing tests**

Append inside the `describe` block:

```ts
  test('every job has a timeout (a reusable-workflow call inherits its callee\'s)', () => {
    const missing: string[] = [];
    for (const [name, wf] of Object.entries(workflows())) {
      for (const [id, job] of Object.entries(wf.jobs)) {
        if (job.uses === undefined && job['timeout-minutes'] === undefined) missing.push(`${name}:${id}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('release.yml publishes only after the stack suite passes', () => {
    const { jobs } = workflows()['release.yml'];
    expect(jobs.stack.uses).toBe('./.github/workflows/stack.yml');
    expect([jobs.publish.needs].flat()).toContain('stack');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/workflows.test.ts`
Expected: 2 FAIL. The timeout test lists `release.yml:publish` and `release.yml:verify-public`. The gating test throws because `jobs.stack` is undefined.

- [ ] **Step 3: Edit `release.yml`**

Insert as the first entry under `jobs:`:

```yaml
  # Prove the stack before anything is published. This is the one place the
  # full Docker suite runs without a human dispatching it.
  stack:
    uses: ./.github/workflows/stack.yml
    with:
      suite: all
    secrets: inherit
```

In `publish:`, add `needs: stack` and `timeout-minutes: 60` directly under `runs-on: ubuntu-latest`. In `verify-public:`, add `timeout-minutes: 10` under `runs-on: ubuntu-latest`.

Update the header comment's first paragraph to end with: `It runs stack.yml (all suites) first; nothing is published unless the stack is green.`

- [ ] **Step 4: Run the guardrail test and actionlint**

Run: `bun test test/unit/workflows.test.ts`
Expected: PASS, 7 tests.

Run: `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo" -w /repo rhysd/actionlint:1.7.7`
Expected: no errors in any workflow file. actionlint resolves the local `uses: ./.github/workflows/stack.yml` and checks the `with:` inputs against it.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml test/unit/workflows.test.ts
git commit -m "ci: release publishes only after stack.yml passes; every job has a timeout"
```

---

### Task 4: Document the CI policy where people and agents will read it

**Files:**
- Create: `docs/runbooks/ci.md`
- Create: `CLAUDE.md`
- Modify: `docs/support-policy.md` (the two bullets beginning "**The nightly drift job is the tripwire.**" and "**The three pinned images stay publicly, anonymously pullable.**")
- Modify: `HANDOFF.md:292-294` (the "Workflow-file pushes need a temporary deploy key" bullet)
- Modify: `scripts/redeploy.sh:169` (comment only)

**Interfaces:**
- Consumes: workflow and input names from Tasks 1–3.
- Produces: nothing code-facing.

- [ ] **Step 1: Write `docs/runbooks/ci.md`**

````markdown
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
| `release-verify.yml` | **only** by hand | 1–15 min per job | published images pull by digest, are anonymously public, and install on a clean host |

Nothing is scheduled. `test/unit/workflows.test.ts` fails if a workflow gains a
`schedule:`, if anything but `ci.yml` triggers on push/PR, or if a job has no
`timeout-minutes`.

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
````

- [ ] **Step 2: Write `CLAUDE.md`**

```markdown
# Agent rules for this repo

Start with `HANDOFF.md`. CI rules (`docs/runbooks/ci.md`):

- GitHub Actions minutes are a shared, capped budget (Free plan, 2,000 min/month for the whole org).
- Never iterate on a fix by pushing to a PR or to `main` and waiting for CI. Run the suite locally (`bun run test:unit`, `bun run test:contract:isolated`, …) until it is green, then push once.
- Never push the same change to more than one PR branch in a loop.
- The Docker suites run only via `gh workflow run stack.yml -f suite=<one suite>`. Dispatch at most once per finished change, and never on a schedule.
- Do not add `schedule:` triggers or new push/PR workflows; `test/unit/workflows.test.ts` will fail.
```

- [ ] **Step 3: Update `docs/support-policy.md`**

Replace the bullet that starts `- **The nightly drift job is the tripwire.**` with:

```markdown
- **The drift check runs when an upstream tag lands.** Dispatch `stack.yml` with `gbrain_version` set to the new tag (`gh workflow run stack.yml -f suite=contract -f gbrain_version=<tag>`); pinned-current `0.50.5.0` is the default when the input is blank. A drift finding is news, not a broken build, and it is what starts the clock on the next supported upgrade. There is no nightly cron (see `docs/runbooks/ci.md` for why).
```

Replace the bullet that starts `- **The three pinned images stay publicly, anonymously pullable.**` with:

```markdown
- **The three pinned images stay publicly, anonymously pullable.** `scripts/ci/check-public-images.sh` runs a credential-less `docker pull` of `gbrain-base`, `control-plane`, and `agent-runner`, the same thing `scripts/install.sh` does for an external user. `release.yml`'s `verify-public` job runs it right after every publish and fails that release outright if any image isn't public. Visibility is a GitHub setting outside the release pipeline and can regress on its own (a manual toggle, or a package deleted and recreated, which defaults to private), so `release-verify.yml`'s `public` job runs the same check on demand.
```

- [ ] **Step 4: Update `HANDOFF.md` and `scripts/redeploy.sh`**

In `HANDOFF.md`, replace the bullet `- **Workflow-file pushes need a temporary deploy key.** …delete it immediately.` (three lines) with:

```markdown
- **CI is budgeted.** Only `ci.yml` (lint/tsc/unit, ~1 min) runs on push/PR; the Docker suites run on demand via `stack.yml`. Read `docs/runbooks/ci.md` before touching `.github/workflows/`. The `gh` token has the `workflow` scope (checked 2026-10-05), so workflow-file pushes no longer need a deploy key.
```

In `scripts/redeploy.sh` line 169, change `# (.github/workflows/contract.yml) and scripts/publish-images.sh does the` to `# (.github/workflows/stack.yml) and scripts/publish-images.sh does the`.

- [ ] **Step 5: Check no live doc still points at deleted workflows**

Run: `git grep -nE "nightly\.yml|ghcr-visibility\.yml|contract\.yml|drift-issue-body" -- ':!docs/superpowers/**' ':!docs/slice-*-findings.md' ':!CHANGELOG.md'`
Expected: no hits. Dated findings docs, plans, and the changelog are history and stay as written.

- [ ] **Step 6: Commit**

```bash
git add docs/runbooks/ci.md CLAUDE.md docs/support-policy.md HANDOFF.md scripts/redeploy.sh
git commit -m "docs: CI budget runbook and the no-CI-fix-loop rule"
```

---

### Task 5: Ship it and prove the wiring on GitHub

**Files:** none (verification only).

**Interfaces:**
- Consumes: everything above.
- Produces: evidence (run IDs) recorded in the PR description.

- [ ] **Step 1: Push a branch and open one PR**

```bash
git push -u origin ci/actions-diet
gh pr create --title "ci: actions diet — 1-min ci.yml on push/PR, Docker suites on demand" \
  --body-file - <<'EOF'
Implements docs/superpowers/plans/2026-10-05-github-actions-diet.md.

- `ci.yml` (lint/tsc/unit, ~1 min) is the only push/PR workflow.
- `stack.yml` holds build/integration/contract/e2e and runs only by dispatch or from `release.yml`.
- `nightly.yml` and `ghcr-visibility.yml` crons removed; their checks are dispatchable.
- `test/unit/workflows.test.ts` locks the rules in.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 2: Verify only `ci` ran on the PR**

Run: `gh pr checks --watch`
Expected: exactly one check, `ci / unit`, green, billed ~1 minute. No `contract`, `restore`, `slice2`, or `clean-install` checks appear. If `ci / unit` fails, fix locally (Task 1 Step 8) and push once.

- [ ] **Step 3: Merge, then dispatch the cheapest stack suite to prove dispatch works**

`workflow_dispatch` only works once the file is on the default branch.

```bash
gh pr merge --merge
gh workflow run stack.yml -f suite=build
gh run watch "$(gh run list --workflow stack.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```
Expected: one `build-gates` job runs (~2 min) and the other four jobs show as skipped. Do **not** dispatch `suite=all` yet: Phase 2's R1 and R2′ will turn it red, which is known and costs ~29 min.

- [ ] **Step 4: Confirm the active workflow list**

Run: `gh workflow list`
Expected: `ci`, `stack`, `release`, and `release-verify` are active. The deleted three are no longer listed as active.

- [ ] **Step 5: Re-point the open PRs**

For PR #4 (`worktree-mcp-and-skills-provisioning-fix`) and PR #5 (`feat/mobrain-personal-pack`):
- Run: `git fetch origin && git diff --stat origin/main...origin/<branch> -- .github/`
- If either branch modified a deleted workflow file, merge `main` into it and resolve by keeping the deletion. Otherwise no action is needed: `pull_request` runs read workflows from the merge ref, so `contract.yml` will not run for them again.

---

### Task 6: Issue housekeeping (outward-facing: confirm with the repo owner before posting)

**Files:** none.

- [ ] **Step 1: Correct the record on issue #2**

```bash
gh issue comment 2 --body "Since 2026-09-29 the nightly 0.51.0.0 arm failed at the bootstrap /wizard/finish step (writer-gate 503/499), not at 0.51 drift, so the comments since then are misattributed. Their 'Pinned-current is unaffected' line was also false: the 0.50.5.0 arm failed the same way. The nightly cron is now removed (docs/runbooks/ci.md). Real 0.51 failures (A11 page.delete) are in docs/superpowers/plans/artifacts/2026-09-28-051-contract-failures.txt; re-check with: gh workflow run stack.yml -f suite=contract -f gbrain_version=0.51.0.0"
```

- [ ] **Step 2: Record the remaining variant on issue #6**

```bash
gh issue comment 6 --body "The cold-start race looks fixed by pauseBrainWriters (contract green in the 3 runs after 09-28). New variant: /wizard/finish -> 503 'writers did not quiesce within 60000ms (supervisor exit 1, other backends 1|2)', sometimes surfacing as 499 because QUIET_TIMEOUT_MS (src/ops/writerGate.ts:6) equals the control plane's 60s idleTimeout. Tracked as Phase 2b in docs/superpowers/plans/2026-10-05-github-actions-diet.md."
```

---

## Phase 2: make `stack.yml all` green (each item needs its own plan)

These are product and test bugs, not CI configuration. `stack.yml` will be red for these reasons until they are fixed, and `release.yml` will refuse to publish, which is intended. Fix them **locally** against the dev stack. Write a separate plan per item with `superpowers:systematic-debugging` first: the root causes below are evidenced but not all are confirmed.

- **2a. slice2 / private spaces (R1, deterministic).**
  - `src/control/privateSpaces.ts`: the `try { seedSpace(...); callOps('sources.add', ...) } catch { /* best-effort */ }` block swallows the registration failure.
  - Find out why only the first member's `my-space-*` source registers, then make the failure surface or retry instead of being swallowed.
  - Port the explicit test timeouts from PR-branch commits `47df3d7`, `9dc6f65`, `4bdd620` into `test/e2e/slice2.e2e.test.ts`.
  - Verify with `bun test test/e2e/slice2.e2e.test.ts` locally, then dispatch `stack.yml -f suite=e2e` once.
- **2b. Writer-gate quiesce (R2′, intermittent).** `src/ops/writerGate.ts:38-60` counts **every** other backend on the brain database. Use the new failure log dump (Task 1) or a local repro to identify the 1–2 lingering backends from `pg_stat_activity` (`application_name`, `client_addr`, `backend_type`). Then either filter the count to serve/worker connections or wait for those connections to drain. Keep `QUIET_TIMEOUT_MS` safely below the control plane's 60 s `idleTimeout` (or raise the timeout for `/wizard/finish`), so the failure surfaces as a readable 503 rather than a 499 with an empty body.
- **2c. Unit order dependency (R3a, rare).** `test/unit/fileplane.test.ts:122` hit EACCES on `/srv/gbrain-home` because `SCHEMA_PACK_DIR` bound to the default at import time. Because `ci.yml` now runs on every push, a flake here costs re-runs; make the module read `GBRAIN_HOME` lazily, or isolate the file.
- **2d. Pinned-next 0.51.** Continue `docs/superpowers/plans/2026-09-28-pinned-next-051-drift.md` Task 5 once 2b is fixed. Check it with `gh workflow run stack.yml -f suite=contract -f gbrain_version=0.51.0.0`.
- **2e. GHCR namespace risk (not yet broken).** Images publish to `ghcr.io/molanojf/*` (the personal account), but the repo now lives in the `MoliorOS` org. An org repo's `GITHUB_TOKEN` generally cannot push to a user-owned package unless that package grants the repo write access. The next `release.yml` run will show whether this works. Before the next release, check *Package settings → Manage Actions access* on each of the three packages, or plan a move to `ghcr.io/moliorOS/*` via the `IMAGE_NAMESPACE` repo variable.
- **Org-wide.** `MOLIOR-OS` spent 1,071 of September's org minutes and draws on the same 2,000. Apply the same audit there; it is out of scope for this repo.
