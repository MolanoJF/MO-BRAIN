# Pinned-Next 0.51.0.0 Drift Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the nightly pinned-next arm actually run the contract suite against gbrain `0.51.0.0`, and fix whatever that suite reports, without moving the supported pin off `0.50.5.0`.

**Architecture:** Issue #2's title says the contract suite breaks. Every nightly job since the issue opened, including the original run `35435063654` and the latest run `36417494700`, failed one step earlier: `docker/control-plane.Dockerfile` exits 1 because `contracts/v0.51.0.0/operations.json` does not exist. The contract suite was skipped, `contract-output.txt` was never written, and the tripwire body fell through to `see the run log`. Ops loads that JSON as its allowlist (`src/ops/dispatch.ts`). `capability.json` for the same version is what `capabilityPath()` readers open once `GBRAIN_VERSION=0.51.0.0`. Capture both artifacts, teach the tripwire to quote the real log line, then run the suite. Do that suite run after the worker-reset plan, or the 1280-d race will be misread as upstream drift.

**Tech Stack:** TypeScript, Bun, Docker, GitHub Actions, gbrain `0.51.0.0` as a candidate only.

**Spec:** https://github.com/MoliorOS/MO-BRAIN/issues/2 — the issue is the spec. The support-policy sentence it repeats is copied into Global Constraints. Closed issue #1 (`0.99.0.0`) was the tripwire proof and is out of scope.

## Global Constraints

- G1, from the issue: do not move the pin to make this pass. `PINNED_CURRENT` stays `0.50.5.0`. Do not change `.env` `GBRAIN_VERSION` on the live `mobrain-local` stack. Do not retag `ghcr.io/molanojf/control-plane` or the image that stack is running.
- Fix the seam or widen the contract test. Widening means asserting the new upstream field while still asserting the field the product reads. Deleting an assertion is not a fix.
- There is one `src/contracts/registry.ts`. `contracts/v0.50.5.0/operations.json` and `contracts/v0.51.0.0/operations.json` are both emits of that registry. Do not fork the registry per version. A flag `0.51.0.0` requires and `0.50.5.0` rejects has to be expressible by the one `buildArgv` path, or the work stops and the conflict is written on the issue.
- Do not `docker compose down -v` against project `mobrain-local`. Before any compose command in this plan, set `COMPOSE_PROJECT_NAME=mobrain-pin-051` and confirm `docker compose ps` prints `mobrain-pin-051`.
- Slice0 publishes no host ports. The production compose file publishes 80/443. Only one stack on this machine can bind those ports. Local probes use `compose/docker-compose.slice0.yml` only. The full production-compose suite runs in GitHub Actions, not against the live stack.
- Do not print `.env`. `capability:capture` and the slice0 file have defaults and do not need the live env file.
- Execute Task 5 only after `docs/superpowers/plans/2026-09-28-worker-reset-race.md` is implemented. Otherwise a `/finish` 500 or a re-template refusal is issue #6, not 0.51 drift.

---

### Task 1: The drift issue quotes the failing line

**Files:**
- Create: `scripts/drift-issue-body.sh`
- Create: `test/unit/drift-issue-body.test.ts`
- Modify: `.github/workflows/nightly.yml` (the build step, the bootstrap step, and the "Open or update a drift issue" step)

**Interfaces:**
- Consumes: nothing.
- Produces: `bash scripts/drift-issue-body.sh <gbrain-version> <run-url> <pinned-current>` writes the issue body to stdout. It prefers, in order, `(fail)` lines from `./contract-output.txt`, then `error:` lines from `./bootstrap-output.txt`, then `ERROR:` / `operations.json missing` lines from `./build-output.txt`. Each source is capped at 50 lines. When none of those files has a matching line, the body contains the sentence `no failure excerpt was captured; the job failed before the contract suite`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/drift-issue-body.test.ts`:

```ts
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function body(dir: string): Promise<string> {
  const proc = Bun.spawn(
    ['bash', 'scripts/drift-issue-body.sh', '0.51.0.0', 'https://example.test/runs/1', '0.50.5.0'],
    { cwd: dir, stdout: 'pipe', stderr: 'pipe' },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`drift-issue-body exited ${code}: ${stderr}`);
  return stdout;
}

describe('drift issue body', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'drift-body-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('quotes the Dockerfile gate when the suite never started', async () => {
    await writeFile(join(dir, 'build-output.txt'),
      'test -s "contracts/v0.51.0.0/operations.json"\n' +
      'operations.json missing for 0.51.0.0 — run Slice 0 first\n' +
      'ERROR: process "/bin/sh -c test -s" did not complete successfully: exit code: 1\n');
    const text = await body(dir);
    expect(text).toContain('0.51.0.0');
    expect(text).toContain('operations.json missing for 0.51.0.0');
    expect(text).toContain('Pinned-current (`0.50.5.0`) is unaffected');
    expect(text).toContain('do not move the pin');
    expect(text).not.toContain('see the run log');
  });

  test('quotes contract (fail) lines when the suite ran', async () => {
    await writeFile(join(dir, 'contract-output.txt'),
      '(pass) doctor --json\n(fail) schema lint --json reports against the active pack\n');
    await writeFile(join(dir, 'build-output.txt'), 'ERROR: should not win\n');
    const text = await body(dir);
    expect(text).toContain('(fail) schema lint --json reports against the active pack');
    expect(text).not.toContain('should not win');
  });

  test('says the excerpt is missing when no log file matched', async () => {
    const text = await body(dir);
    expect(text).toContain('no failure excerpt was captured');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/drift-issue-body.test.ts`

Expected: FAIL. `scripts/drift-issue-body.sh` does not exist, so the spawn throws or exits non-zero.

- [ ] **Step 3: Write the script and call it from the workflow**

Create `scripts/drift-issue-body.sh` with LF endings:

```sh
#!/bin/sh
# Body for the nightly pinned-next drift issue. Reads log excerpts from the
# current directory. Never calls gh.
set -eu
version=${1:?gbrain version}
run_url=${2:?run url}
pinned=${3:?pinned-current}

excerpt() {
  file=$1
  pattern=$2
  if [ ! -f "$file" ]; then
    return 1
  fi
  # grep exits 1 when nothing matches. That is "try the next source", not an error.
  hit=$(grep -E "$pattern" "$file" | head -50 || true)
  if [ -n "$hit" ]; then
    printf '%s\n' "$hit"
    return 0
  fi
  return 1
}

detail=$(excerpt contract-output.txt '^\(fail\)' || true)
if [ -z "$detail" ]; then
  detail=$(excerpt bootstrap-output.txt 'error:|/wizard/finish' || true)
fi
if [ -z "$detail" ]; then
  detail=$(excerpt build-output.txt 'ERROR:|operations.json missing|error:' || true)
fi
if [ -z "$detail" ]; then
  detail='no failure excerpt was captured; the job failed before the contract suite'
fi

cat <<EOF
Nightly pinned-next run failed against gbrain \`$version\`.

Run: $run_url
Pinned-current (\`$pinned\`) is unaffected; this is a tripwire, not an outage.

Failing tests:
\`\`\`
$detail
\`\`\`

G1 holds: do not move the pin to make this pass. Fix the seam or widen the contract test.
EOF
```

In `.github/workflows/nightly.yml`, replace the "Mirror the base and build the stack through the overlay (D2)" step's `run:` with:

```yaml
        run: |
          set -o pipefail
          docker tag "${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE:-molanojf}/gbrain-base:${GBRAIN_VERSION}" \
            "mobrain/gbrain-base:${GBRAIN_VERSION}"
          docker compose -f compose/docker-compose.yml -f compose/docker-compose.build.yml build \
            --build-arg "GBRAIN_VERSION=${GBRAIN_VERSION}" \
            --build-arg "HARNESS_VERSION=${HARNESS_VERSION}" \
            control-plane scheduler agent-runner 2>&1 | tee build-output.txt
```

Replace the bootstrap step's `run:` with:

```yaml
        run: |
          set -o pipefail
          bun run scripts/ci-bootstrap-brain.ts 2>&1 | tee bootstrap-output.txt
```

Keep that step's existing `env:` block (`BOOTSTRAP_BASE_URL` through `BOOTSTRAP_ORG`).

In the "Open or update a drift issue" step, replace the `body=$(printf ...)` assignment with:

```bash
          body=$(bash scripts/drift-issue-body.sh \
            "${{ matrix.gbrain }}" \
            "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}" \
            "$PINNED_CURRENT")
```

Leave the `gh label create`, the `gh issue list` lookup, and the comment-or-create branch as they are. Delete the inlined `printf` body so the script is the only copy of that text.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/unit/drift-issue-body.test.ts`

Expected: PASS, 3 tests. The first test's body contains `operations.json missing for 0.51.0.0` and does not contain `see the run log`.

- [ ] **Step 5: Commit**

```bash
git add scripts/drift-issue-body.sh test/unit/drift-issue-body.test.ts .github/workflows/nightly.yml
git commit -m "fix: nightly drift issue quotes the failing build or test line"
```

---

### Task 2: Commit the 0.51.0.0 operations allowlist

**Files:**
- Create: `contracts/v0.51.0.0/operations.json` (generated, do not hand-edit)
- Modify: `test/unit/registry.test.ts` (one new test in `describe('registry invariants')`)

**Interfaces:**
- Consumes: `OPERATIONS` from `src/contracts/registry.ts` and `bun run operations:emit` (`scripts/emit-operations.ts`), which writes `contracts/v${GBRAIN_VERSION}/operations.json`.
- Produces: a file whose `gbrainVersion` is `0.51.0.0` and whose `operations` array is the current registry. `src/ops/dispatch.ts` loads this file when `GBRAIN_VERSION=0.51.0.0`. The Dockerfile gate `test -s "contracts/v${GBRAIN_VERSION}/operations.json"` then passes. `contracts/v0.50.5.0/operations.json` is not modified in this task.

- [ ] **Step 1: Write the failing test**

In `test/unit/registry.test.ts`, after the test `operations.json matches registry.ts`, add:

```ts
  test('pinned-next operations.json is the same registry labeled 0.51.0.0', () => {
    const emitted = JSON.parse(readFileSync('contracts/v0.51.0.0/operations.json', 'utf8'));
    expect(emitted.gbrainVersion).toBe('0.51.0.0');
    const fromJson = Object.fromEntries(emitted.operations.map((o: { id: string }) => [o.id, o]));
    expect(fromJson).toEqual(JSON.parse(JSON.stringify(OPERATIONS)));
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/registry.test.ts`

Expected: FAIL. `contracts/v0.51.0.0/operations.json` cannot be read (`ENOENT`).

- [ ] **Step 3: Emit the file**

Run, without changing the live `.env`:

```bash
GBRAIN_VERSION=0.51.0.0 bun run operations:emit
```

On PowerShell, that is:

```powershell
$env:GBRAIN_VERSION = '0.51.0.0'; bun run operations:emit; Remove-Item Env:GBRAIN_VERSION
```

Confirm the printed line is `wrote contracts/v0.51.0.0/operations.json`. Do not copy `contracts/v0.50.5.0/operations.json` by hand — `generatedAt` and `gbrainVersion` have to come from the script.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/unit/registry.test.ts`

Expected: PASS, including `pinned-next operations.json is the same registry labeled 0.51.0.0` and the existing `operations.json matches registry.ts` (that one still reads `contracts/v${GBRAIN_VERSION}` or `v0.50.0.0`, and this task did not change it).

- [ ] **Step 5: Commit**

```bash
git add contracts/v0.51.0.0/operations.json test/unit/registry.test.ts
git commit -m "chore: emit the ops allowlist for gbrain 0.51.0.0"
```

---

### Task 3: Capture the 0.51.0.0 capability snapshot

**Files:**
- Create: `contracts/v0.51.0.0/capability.json` (generated by `bun run capability:capture`)
- Modify: `test/unit/pin.test.ts` (one new test)

**Interfaces:**
- Consumes: `scripts/capture-capability.ts`, which execs `gbrain serve` in the slice0 project and writes `contracts/v${snap.gbrainVersion}/capability.json`. `CapabilitySnapshot` is `{ gbrainVersion, capturedAt, tools, wellKnown, schemaPacks }` from `src/contracts/capability.ts`.
- Produces: `contracts/v0.51.0.0/capability.json` with `gbrainVersion === '0.51.0.0'`, `wellKnown !== null`, and `toolNames(tools).length > 0`. `capabilityPath('0.51.0.0')` then points at a real file. Runner contract tests that call `capabilityPath(GBRAIN_PIN)` can open it when the pin under test is `0.51.0.0`.

- [ ] **Step 1: Write the failing test**

In `test/unit/pin.test.ts`, add this import beside the existing pin imports:

```ts
import { toolNames, type CapabilitySnapshot } from '../../src/contracts/capability.ts';
```

Add this test inside `describe('pin.ts')`:

```ts
  test('pinned-next capability snapshot is a real 0.51.0.0 capture', async () => {
    const snap = JSON.parse(await readFile('contracts/v0.51.0.0/capability.json', 'utf8')) as CapabilitySnapshot;
    expect(snap.gbrainVersion).toBe('0.51.0.0');
    expect(snap.wellKnown).not.toBeNull();
    expect(toolNames(snap.tools).length).toBeGreaterThan(0);
    expect(capabilityPath('0.51.0.0')).toBe('contracts/v0.51.0.0/capability.json');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/pin.test.ts`

Expected: FAIL. `contracts/v0.51.0.0/capability.json` cannot be read.

- [ ] **Step 3: Build the 0.51 base image and capture**

Do this in a throwaway compose project. Refuse to continue if the project name is `mobrain-local`.

```powershell
$env:COMPOSE_PROJECT_NAME = 'mobrain-pin-051'
$env:GBRAIN_VERSION = '0.51.0.0'
docker compose -f compose/docker-compose.slice0.yml ps
```

The project column must be `mobrain-pin-051`. If it is `mobrain-local`, stop and unset the ambient project name before setting it again.

```powershell
docker build -f docker/gbrain-base.Dockerfile --build-arg GBRAIN_VERSION=0.51.0.0 -t mobrain/gbrain-base:0.51.0.0 .
docker compose -f compose/docker-compose.slice0.yml up -d --wait --build
bun run capability:capture
docker compose -f compose/docker-compose.slice0.yml down -v
Remove-Item Env:COMPOSE_PROJECT_NAME
Remove-Item Env:GBRAIN_VERSION
```

`capability:capture` throws if `wellKnown` is null. Do not commit a file that the script refused to write. The script logs `DRIFT DETECTED` or `no drift` against the previous file; there is no previous 0.51 file, so that branch does not run. The path it writes uses the binary's own version string. If that string is not `0.51.0.0`, do not rename the file — stop and record the printed version. The tag we asked to build is not evidence the binary inside it is that version.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/unit/pin.test.ts`

Expected: PASS, including `pinned-next capability snapshot is a real 0.51.0.0 capture`.

- [ ] **Step 5: Commit**

```bash
git add contracts/v0.51.0.0/capability.json test/unit/pin.test.ts
git commit -m "chore: capture gbrain 0.51.0.0 capability snapshot"
```

---

### Task 4: Prove the control-plane image builds at 0.51.0.0

**Files:**
- Modify: none beyond Tasks 2 and 3. This task is the build proof those files exist to satisfy.
- Test: the Docker build itself. `test/unit/control-plane-dockerfile.test.ts` already locks the ARG scope; do not weaken it.

**Interfaces:**
- Consumes: `contracts/v0.51.0.0/operations.json` from Task 2, and the local image `mobrain/gbrain-base:0.51.0.0` from Task 3.
- Produces: a local image tag `mobrain/control-plane:pin-probe-051` that is not the tag the live stack runs. No compose up. No push.

- [ ] **Step 1: Run the build after Tasks 2 and 3**

```powershell
$env:GBRAIN_VERSION = '0.51.0.0'
docker build -f docker/control-plane.Dockerfile --build-arg GBRAIN_VERSION=0.51.0.0 -t mobrain/control-plane:pin-probe-051 .
Remove-Item Env:GBRAIN_VERSION
```

Expected: exit 0. Then `docker image inspect mobrain/control-plane:pin-probe-051` exits 0.

The historical failure this replaces is exit 1 with `operations.json missing for 0.51.0.0 — run Slice 0 first`. If the build fails on a different `ERROR:` line, copy that line into the Task 5 artifact and stop. That is a seam for Task 6, not a reason to change `PINNED_CURRENT`.

Do not `docker tag` this image onto `ghcr.io/molanojf/control-plane:1.0.0` or onto the SHA the live `mobrain-local` stack is running. There is nothing to commit: Tasks 2 and 3 already committed the catalogs this build reads.

---

### Task 5: Run the 0.51 contract suite where it cannot touch the live stack

**Files:**
- Create: `docs/superpowers/plans/artifacts/2026-09-28-051-contract-failures.txt` (the captured `(fail)` lines, or the single line `none` if the suite passed)
- Modify: none of the product source in this task.

**Interfaces:**
- Consumes: Tasks 2 and 3, the local `mobrain/gbrain-base:0.51.0.0` image, and a finished implementation of `docs/superpowers/plans/2026-09-28-worker-reset-race.md`.
- Produces: the artifact file above. A non-empty failure list is the input to Task 6. `none` means issue #2's suite is green at `0.51.0.0` and Task 6 is a comment on the issue, not a code change.

- [ ] **Step 1: Local slice0 files only**

These files use `compose/docker-compose.slice0.yml` through `test/helpers/stack.ts` and publish no host ports:

`auth.contract.test.ts`, `config.contract.test.ts`, `discovery.contract.test.ts`, `init.contract.test.ts`, `lifecycle.contract.test.ts`, `mcp-grant.contract.test.ts`, `member-skills.contract.test.ts`, `revoke.contract.test.ts`, `runner.contract.test.ts`, `schema.contract.test.ts`, `schema-authoring.contract.test.ts`, `tutorial.contract.test.ts`.

Do not run `scheduler.contract.test.ts` or `upgrade.contract.test.ts` on this machine. They shell out to `compose/docker-compose.yml`, which publishes 80/443 and would collide with `mobrain-local`.

```powershell
$env:COMPOSE_PROJECT_NAME = 'mobrain-pin-051'
$env:GBRAIN_VERSION = '0.51.0.0'
docker compose -f compose/docker-compose.slice0.yml ps
```

Stop if the project name is not `mobrain-pin-051`.

```powershell
bash scripts/test-isolated.sh test/contract/init.contract.test.ts
```

Repeat the same `bash scripts/test-isolated.sh <file>` for each file in the list. `test-isolated.sh` takes a directory and runs every file in it, including the two dangerous ones, so do not point it at `test/contract` on this host. One file per invocation.

`OPENAI_API_KEY` must be set in the environment for `init`. Read it from the existing `.env` inside the process if the suite already does; do not print the file.

- [ ] **Step 2: Full suite on GitHub, not locally**

The production-compose legs belong in Actions. Dispatch the nightly workflow on the branch that contains Tasks 1–3 and the worker-reset plan. Do not pass `gbrain_version` (blank keeps `0.51.0.0`).

```bash
gh workflow run nightly.yml --ref <branch>
```

Wait for the run. Download the `contract (0.51.0.0)` log. The pinned-current job is allowed to fail only for a reason this plan did not introduce; if it fails on `/wizard/finish` init exit 1, that is still issue #6 and the worker-reset plan is not actually in the branch.

- [ ] **Step 3: Write the artifact**

From the local slice0 runs and the Actions log, write `docs/superpowers/plans/artifacts/2026-09-28-051-contract-failures.txt`.

One `(fail)` line per failing test, copied verbatim, plus the assertion message under it. If both runs are green, the file's only line is `none`.

- [ ] **Step 4: Comment on issue #2**

```bash
gh issue comment 2 --body-file docs/superpowers/plans/artifacts/2026-09-28-051-contract-failures.txt
```

The comment is the classified list, not another "see the run log". Include the Actions run URL.

- [ ] **Step 5: Commit the artifact**

```bash
git add docs/superpowers/plans/artifacts/2026-09-28-051-contract-failures.txt
git commit -m "docs: record gbrain 0.51.0.0 contract failures"
```

---

### Task 6: Fix the recorded seam, or widen the test

**Files:**
- Determined by the artifact from Task 5. The only files this task may edit are the ones named below, plus a new test next to an existing contract test when a behavior needs a new assertion.
- Do not edit `.env`, `PINNED_CURRENT`, or `src/contracts/pin.ts`.

**Interfaces:**
- Consumes: each `(fail)` line in `docs/superpowers/plans/artifacts/2026-09-28-051-contract-failures.txt`.
- Produces: that file's failures gone at `GBRAIN_VERSION=0.51.0.0`, and the same tests still passing at `GBRAIN_VERSION=0.50.5.0`. Both `operations.json` files still match the one registry (`bun test test/unit/registry.test.ts`).

If the artifact's only line is `none`, skip to Step 4 and do not change product code.

- [ ] **Step 1: Classify every failure before editing**

For each `(fail)` line, append a classification under it in the artifact. Use only these labels:

- `issue-6` — stderr or the bootstrap log contains `Refusing to silently re-template` or `/wizard/finish` with `init` exit 1 and no other upstream message. Stop. Do not widen a test. The worker-reset plan is incomplete on this branch.
- `registry` — gbrain rejected a flag or argument the registry sent (`Unknown flag`, exit 2 usage), or a contract test's `buildArgv` expectation no longer matches a flag that still exists. The edit is `src/contracts/registry.ts`, then both emits.
- `assertion` — the command succeeded and the test compared a field upstream added or renamed. The edit is the test file named on the `(fail)` line.
- `conflict` — the argv that passes on `0.51.0.0` fails on `0.50.5.0`, and one `buildArgv` call cannot send both. Do not guess a second registry. Write the two argv arrays into the artifact and stop this failure. Leave the others editable.

- [ ] **Step 2: Write the failing test for one `registry` or `assertion` item**

Take the first item that is not `issue-6` or `conflict`.

For `assertion`, change the expectation in that test to the value the 0.51 log actually printed, and keep the previous assertion on the field the product reads. Example shape, using the log's real field names rather than these samples:

```ts
test('schema active reports the resolution tier', async () => {
  const r = await execOperation(OPERATIONS['schema.active']!, {}, { timeoutMs: 60_000 });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('Active pack:');
  expect(r.stdout).toMatch(/Source:/);
});
```

Replace `Active pack:` / `Source:` with the labels the failing log printed if they changed, and keep both a pack identity assertion and a source-tier assertion. Run that one test at `GBRAIN_VERSION=0.51.0.0` and expect FAIL only if you have not edited it yet. Then edit. Then run it again at `0.51.0.0` (PASS) and at `0.50.5.0` (PASS). If `0.50.5.0` fails, the new assertion is too narrow — accept both the old and new label with one `toMatch` alternation, still requiring a pack identity and a tier.

For `registry`, add or change the `ParamSpec` on that operation so `buildArgv` emits the argv `0.51.0.0` accepted. Run:

```powershell
$env:GBRAIN_VERSION = '0.50.5.0'; bun run operations:emit
$env:GBRAIN_VERSION = '0.51.0.0'; bun run operations:emit
Remove-Item Env:GBRAIN_VERSION
bun test test/unit/registry.test.ts
```

Expected: both operations files match `OPERATIONS`. Then re-run the one contract file at both versions, using `COMPOSE_PROJECT_NAME=mobrain-pin-051` for the 0.51 run and the default slice0 project name `brainstand-slice0` for the 0.50.5.0 run. Never `mobrain-local`.

- [ ] **Step 3: Repeat Step 2 for every remaining editable item**

One commit per item:

```bash
git add <the test or registry file> contracts/v0.50.5.0/operations.json contracts/v0.51.0.0/operations.json
git commit -m "fix: accept gbrain 0.51.0.0 <operation id> without moving the pin"
```

Omit the JSON paths when the item was `assertion` and the registry did not change.

- [ ] **Step 4: Dispatch nightly again**

```bash
gh workflow run nightly.yml --ref <branch>
```

Expected: `contract (0.51.0.0)` gets past "Mirror the base and build the stack through the overlay (D2)". If the contract suite fails, the new drift comment quotes `(fail)` lines (Task 1) instead of `see the run log`. Fold any new line back into Step 1. `contract (0.50.5.0)` stays the blocking job and must be green.

When both jobs are green, comment on issue #2 with the run URL and the sentence `pinned-next contract suite passed at 0.51.0.0; pin remains 0.50.5.0`. Do not close the issue unless that run is green. Closing is a separate maintainer action; the comment is the deliverable.

---

## Self-review

Spec coverage:

- "Pinned-current is unaffected": no task edits `0.50.5.0` behavior except a registry change that Task 6 re-runs against `0.50.5.0` before it can land.
- "Fix the seam or widen the contract test": Task 6. Moving the pin is forbidden in Global Constraints and is not a step.
- The issue body cannot name tests because the suite never ran. Task 1 fixes the tripwire. Tasks 2–4 remove the Dockerfile gate that skipped the suite (`operations.json missing for 0.51.0.0 — run Slice 0 first` on run `36417494700`). Task 5 records the real failures. Task 6 consumes that record.
- `capability.json` is not what the Dockerfile checks, but `capabilityPath(GBRAIN_PIN)` is what runner contract tests open. Task 3 is what keeps Task 5 from failing on `ENOENT` for that file.

Placeholder scan: Task 6 does not contain the upstream assertion diff. That diff does not exist until Task 5 writes the artifact. The step gives the edit site, the re-emit command, and the two-version run. It tells the executor to stop on `conflict` rather than invent a second registry.

Type consistency: `gbrainVersion` `0.51.0.0` is the same string in the emit script's env, the new registry test, the capability test, the image tag argument, and the workflow matrix default. `CapabilitySnapshot.wellKnown` and `toolNames` match `src/contracts/capability.ts`.
