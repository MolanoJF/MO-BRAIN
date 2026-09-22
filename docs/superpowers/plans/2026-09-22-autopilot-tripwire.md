# Autopilot Tripwire Preset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `gbrain autopilot --status --json` into Mobrain end to end (registry → allowlist → executor → preset → console → docs → tests) as a daily **tripwire** that alarms when a gbrain autopilot install exists, because in Mobrain any install is a second scheduler competing with ours.

**Architecture:** A new `autopilot.status` operation in the RPC allowlist; a brain-wide `autopilot-status` scheduler command; a payload-driven branch in `classifyExit()` (the JSON `installed` field decides, not the exit code); a pinned `autopilot_installed` alert; an admin-only `autopilot-tripwire` preset, daily 07:05, `on_change_or_failure`.

**Tech Stack:** Bun + TypeScript, bun:test, Drizzle/Postgres control DB, Hono routes, React console, the pinned gbrain 0.50.5.0 in `gbrain-ops`.

**Spec:** The task brief pasted into the session on 2026-09-22 ("integrate gbrain's `autopilot --status` health gate as a scheduler preset"), as amended by the user's decision to build a **tripwire** instead of the literal health gate (see "Research findings" below). Task 7 records both the brief and the amendment in `docs/autopilot-status-findings.md`.

## Research findings (OBSERVED 2026-09-22, already done — do not redo, re-verify in Task 1)

Observed on the live dev stack's `brainstand-gbrain-ops-1` (`gbrain --version` → `gbrain 0.50.5.0`), and read from the pinned source at `/root/.bun/install/cache/@GH@garrytan-gbrain-668b9ba@@@1/src/commands/autopilot.ts`:

| Probe | Exit | Output |
|---|---|---|
| `gbrain autopilot --status` | 0 | `Autopilot: not installed. Install with ...` (prose) |
| `gbrain autopilot --status --json` | 0 | `{"installed":false,"install_target":null,"state":"not_installed","disabled_reason":null,"paused_reason":null,"heartbeat_age_seconds":null,"stale_after_seconds":1800,"last_log":""}` |
| `gbrain autopilot status --json` (subcommand form) | 0 | same JSON |
| `gbrain autopilot --status --source` | 0 | same prose: `--source` is silently ignored. There is no source scope. |
| `gbrain autopilot --status --source default` | **2** | `Unknown autopilot argument 'default'. Expected one of: status, install, uninstall, start, help.` (a usage error, **no JSON**) |
| `gbrain autopilot --bogus-flag` | **1** | `unknown flag --bogus-flag ...` (**no JSON**) |

From the source:
- `AutopilotState = 'not_installed' | 'disabled' | 'paused' | 'never_run' | 'stale' | 'fresh'` (autopilot.ts:2468).
- `autopilotStatusExitCode` (autopilot.ts:2489): `disabled`→2, `stale|never_run|paused`→1, everything else (incl. `not_installed`, `fresh`)→0. **Upstream's doc table is accurate.**
- `runAutopilotStatus` is "engine-free … Everything it reads is filesystem (lock mtime, markers, plist/unit/crontab, log tail)" (autopilot.ts:2318-2324).
- `detectInstalledTarget` (autopilot.ts:~2557) checks the macOS plist, a systemd unit, `$GBRAIN_HOME/start-autopilot.sh` (`ephemeral-container`), then `crontab -l`. The gbrain-ops container has **no `crontab` binary** and no systemd. The only install it can see is `ephemeral-container`, via the `gbrain-home` volume, which `gbrain-serve`, `gbrain-worker` and `gbrain-ops` all mount (compose/docker-compose.yml:72,86,105). So a rogue install from any gbrain container is visible to the probe.

**Why the literal preset was rejected:** Mobrain never installs autopilot. `scripts/lint-forbidden.ts` fails the build on the install text, and `src/scheduler/main.ts:13-16` plus three runbooks say the scheduler replaces it. The steady state is therefore `not_installed`/exit 0 forever, so an exit-code health gate would report "ok" every day and never fire. The user chose the **tripwire**: `not_installed` is the only healthy state, and any install is the alarm, **including `fresh` (exit 0)**. That means the verdict must come from the JSON, not the exit code. A second reason: exit 1 and exit 2 are **ambiguous** at this pin. Both are also usage-error exits that print no JSON, so an exit-code-only classifier would misread a broken argv as "daemon disabled".

## Design decisions (each one is recorded in the findings note and in a code comment)

1. **Classification: `'conflict'`, driven by the payload.** An install means two schedulers own one brain. That is the same shape as `sources-push`'s pull conflict, and `conflict` is already in `run_classification_valid` (src/control/db/schema.ts:370), so no migration is needed. The rules:
   - `installed === false && state === 'not_installed'` → `ok`, but only on exit 0.
   - `installed === true` (any state, any of exit 0/1/2) → `conflict`.
   - No readable JSON, or a shape we don't recognise → `failed`. This is the V6 lesson: a gate that can't read its evidence must not pass vacuously.
   - The general rules still run first: exit 4 → `lock_lost`, 143 → `timeout`.
2. **Alert:** `alertKind('autopilot-status', 'conflict')` → `autopilot_installed`. It is **pinned** in the console with `danger` tone. The `PINNED_ALERT_KINDS` doc comment is widened: a rogue scheduler means work is silently *doubled*, not silently stopped, and that is just as missable.
3. **Connection:** it needs *a* Connection, as every schedule does. It reads no Space content, but the report lands in the Connection's write Space, and `loadContext` refuses on a null Connection. Scope is `brain-wide` with `fenced: []`. The probe cannot be fenced (it reads the host's GBRAIN_HOME), so the preset has `requiresRole: 'admin'`, following `doctor`. The console banner's "reads the whole brain" overstates what it reads. It errs on the safe side, so it is left as is and noted in the findings.
4. **okExitCodes `[0, 1, 2]`:** all three are status verdicts, not crashes. This follows `jobs.supervisorStatus`'s `[0, 1]`. It affects only `src/contracts/exec.ts`'s `assertOk` and the ops server's `ok` field. The scheduler classifies on its own.
5. **changeCount:** `installed === true ? 1 : installed === false ? 0 : null`. Combined with `reportPolicy: 'on_change_or_failure'`, a healthy day writes **no report**, and a rogue install or unreadable output always writes one. `'always'` would put a "not installed" page in the Space repo every day, which is the noise the brief warned about.
6. **Preset:** `autopilot-tripwire`, calendar, daily 07:05 (upstream says 7 AM; 07:05 is the free assignable slot), `timeoutSeconds: 60` (the DB CHECK floor is 30; the probe ran in under 1s), catchup `skip`, overlap `skip`, `requiresRole: 'admin'`. It is a user preset, not `system`, so an admin opts in.
7. **No `--interval` param.** An installed daemon always runs the default interval (autopilot.ts:2326-2329). Exposing it would only let someone break the stale check. YAGNI.

## Global Constraints

- gbrain pin: `GBRAIN_VERSION=0.50.5.0` (`.env.example`). Every CLI shape cited must be OBSERVED against it.
- `scripts/lint-forbidden.ts` rule `autopilot-install` matches `/autopilot\s+--install/` as raw text in any non-doc file. **No `.ts`/`.tsx`/`.sh` file may contain the word autopilot followed by whitespace and `--install`**, not even in a comment. Docs (`docs/`), `.superpowers/` and root `HANDOFF.md` are exempt.
- The registry doc header says: "Adding an entry without a contract test is not allowed."
- TDD: failing test first, for every task.
- Don't touch `src/agent/**`, the agent-runner, or the `agent_prompt` lane.
- Git Bash on Windows: prefix `docker exec` commands with `MSYS_NO_PATHCONV=1`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

| File | Change |
|---|---|
| `src/contracts/registry.ts` | + `'autopilot.status'` operation |
| `contracts/v0.50.0.0/operations.json` | regenerated by `bun run operations:emit` |
| `test/contract/scheduler.contract.test.ts` | + shape test, + A3b refusal of `autopilot.install`, + A10 live probe |
| `src/scheduler/commands.ts` | + `'autopilot-status'` command, + `AUTOPILOT_STATUS_KEYS` |
| `test/unit/scheduler-commands.test.ts` | brain-wide list, + changeCount tests |
| `src/scheduler/execute.ts` | `classifyExit` + `alertKind` branches |
| `test/unit/scheduler-classify.test.ts` | + tripwire classification tests |
| `src/scheduler/presets.ts` | + `'autopilot-tripwire'` |
| `test/unit/scheduler-presets.test.ts` | catalogue list, + preset shape test |
| `src/console/pages/Schedules.tsx` | pin + label + tone for `autopilot_installed` |
| `test/unit/console-schedules.test.ts` | pinned-kind lists, scope test |
| `test/integration/scheduler-execute.test.ts` | + three tripwire executor tests |
| `test/integration/scheduler-routes.test.ts` | catalogue list, + admin gate for the preset |
| `docs/product-overview.md`, `docs/runbooks/scheduler.md` | preset table rows + runbook "autopilot_installed" response |
| `docs/autopilot-status-findings.md` | new findings note |

---

### Task 1: Registry entry, emitted allowlist, contract tests (Seam Gate A)

**Files:**
- Modify: `src/contracts/registry.ts` (insert after `'jobs.supervisorStop'`, ~line 415)
- Modify: `test/contract/scheduler.contract.test.ts`
- Regenerate: `contracts/v0.50.0.0/operations.json`

**Interfaces:**
- Produces: `OPERATIONS['autopilot.status']`, with `argv: ['autopilot', '--status']`, `params: []`, `supportsJson: true`, `okExitCodes: [0, 1, 2]`. `buildArgv(spec, {}, { json: true })` → `['autopilot', '--status', '--json']`.

- [ ] **Step 1: Re-verify the observation (the brief requires it; the stack must be up)**

```bash
export MSYS_NO_PATHCONV=1
docker exec brainstand-gbrain-ops-1 gbrain --version
docker exec brainstand-gbrain-ops-1 gbrain autopilot --status --json; echo "exit=$?"
grep -rni "autopilot" src/contracts/registry.ts
```
Expected: `gbrain 0.50.5.0`; the JSON from the findings table with `exit=0`; the registry grep hits only the `post-upgrade` doc comment (~line 926), not an operation key. If any of these differ, STOP and report.

- [ ] **Step 2: Write the failing headless shape test.** Add it to the `describe('scheduler operation shapes (no container needed)'` block:

```ts
  test('autopilot.status is the engine-free status probe, JSON on, no source scope', () => {
    // OBSERVED at 0.50.5.0: `gbrain autopilot --status --json` prints one JSON
    // object; `--source` is silently ignored (there is no source scope at all).
    const spec = OPERATIONS['autopilot.status']!;
    expect(buildArgv(spec, {}, { json: true })).toEqual(['autopilot', '--status', '--json']);
    expect(spec.params).toEqual([]);
    expect(spec.supportsDryRun).toBe(false);
    // 0 fresh/not-installed, 1 stale/never_run/paused, 2 disabled: verdicts, not crashes.
    expect([...spec.okExitCodes]).toEqual([0, 1, 2]);
  });
```

- [ ] **Step 3: Write the failing live tests.** Add them to `describe('Slice 3 seam gate A'`, after A9:

```ts
  test('A3b. the install verb is never reachable through the RPC', async () => {
    // Mobrain's scheduler replaces gbrain's autopilot; only the read-only
    // status probe is allowlisted.
    const r = await opsRpc('autopilot.install', {}, {});
    expect(r.error).toMatch(/unknown operation/);
  });

  test('A10. autopilot --status --json reports not_installed on a Mobrain stack', async () => {
    // The tripwire's baseline. OBSERVED 2026-09-22 against 0.50.5.0. If this
    // ever reads installed:true, a second scheduler is running on this brain.
    const r = await opsRpc('autopilot.status', {}, { json: true, timeoutMs: 60_000 });
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBe(0);
    const body = r.json as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'disabled_reason', 'heartbeat_age_seconds', 'install_target', 'installed',
      'last_log', 'paused_reason', 'stale_after_seconds', 'state',
    ]);
    expect(body.installed).toBe(false);
    expect(body.state).toBe('not_installed');
  }, 120_000);
```

Leave the existing A3 (`opsRpc('autopilot', ...)`) unchanged. It still refuses, because the key is `autopilot.status`.

- [ ] **Step 4: Run and confirm the failures**

Run: `bun test test/contract/scheduler.contract.test.ts -t "autopilot"`
Expected: the shape test FAILS (`undefined is not an object`); A10 FAILS with `unknown operation` (the running image predates the entry); A3b passes already.

- [ ] **Step 5: Add the registry entry** after `'jobs.supervisorStop'`:

```ts
  /**
   * The tripwire probe (docs/autopilot-status-findings.md). OBSERVED at
   * 0.50.5.0: `--status --json` prints one AutopilotStatusReport,
   * { installed, install_target, state, disabled_reason, paused_reason,
   *   heartbeat_age_seconds, stale_after_seconds, last_log },
   * and never opens the engine: it reads only the filesystem, so it answers
   * during a DB outage. `--source` is silently ignored — no source scope.
   *
   * okExitCodes [0, 1, 2]: upstream's autopilotStatusExitCode maps
   * disabled→2, stale/never_run/paused→1, else 0. Each is a verdict, not a
   * crash. But 1 and 2 are ALSO usage-error exits that print no JSON, so the
   * scheduler never classifies on the exit code alone (classifyExit).
   *
   * Only the status verb is allowlisted. The install verb is lint-forbidden
   * and deliberately absent: the scheduler service replaces it.
   */
  'autopilot.status': {
    id: 'autopilot.status',
    argv: ['autopilot', '--status'],
    params: [],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0, 1, 2],
  },
```

(`privilege: 'brain-db'` because it must run in gbrain-ops, which holds GBRAIN_HOME. `read-only` means "safe for a thin-client home", which this is not.)

- [ ] **Step 6: Regenerate the emitted allowlist and rebuild the ops image**

```bash
bun run operations:emit
git diff --stat contracts/
bash scripts/redeploy.sh --full
```
Expected: `operations.json` gains an `autopilot.status` entry; gbrain-ops restarts, and its log reports one more allowlisted operation.

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `bun test test/contract/scheduler.contract.test.ts`
Expected: all PASS, including the shape test, A3, A3b and A10.

- [ ] **Step 8: Lint and commit**

```bash
bun run lint:forbidden
git add src/contracts/registry.ts contracts/v0.50.0.0/operations.json test/contract/scheduler.contract.test.ts
git commit -m "feat(scheduler): allowlist autopilot --status as a read-only probe"
```

---

### Task 2: The `autopilot-status` scheduler command

**Files:**
- Modify: `src/scheduler/commands.ts` (after the `doctor` entry)
- Test: `test/unit/scheduler-commands.test.ts`

**Interfaces:**
- Consumes: `OPERATIONS['autopilot.status']` (Task 1).
- Produces: `SCHEDULER_COMMANDS['autopilot-status']`: `{ id: 'autopilot-status', operation: 'autopilot.status', scope: 'brain-wide', fenced: [], tunable: {}, json: true }`. `changeCount(payload)` → `1` if installed, `0` if not, `null` if unreadable. Also exports `readAutopilotReport(payload): { installed: boolean; state: string } | null`, which Task 3 uses.

- [ ] **Step 1: Write the failing tests.** Replace the `doctor is the only brain-wide command` test, and add a describe block:

```ts
  test('doctor and the autopilot probe are the only brain-wide commands', () => {
    const brainWide = Object.values(SCHEDULER_COMMANDS)
      .filter((c) => c.scope === 'brain-wide').map((c) => c.id).sort();
    expect(brainWide).toEqual(['autopilot-status', 'doctor']);
  });
```

```ts
describe('autopilot-status', () => {
  // OBSERVED at 0.50.5.0 on a Mobrain stack.
  const NOT_INSTALLED = {
    installed: false, install_target: null, state: 'not_installed', disabled_reason: null,
    paused_reason: null, heartbeat_age_seconds: null, stale_after_seconds: 1800, last_log: '',
  };
  const cmd = SCHEDULER_COMMANDS['autopilot-status']!;

  test('is brain-wide, unfenced, untunable and JSON', () => {
    expect(cmd).toMatchObject({
      operation: 'autopilot.status', scope: 'brain-wide', fenced: [], tunable: {}, json: true,
    });
    expect(buildArgv(OPERATIONS[cmd.operation]!, {}, { json: true }))
      .toEqual(['autopilot', '--status', '--json']);
  });

  test('no install is no change', () => {
    expect(cmd.changeCount(NOT_INSTALLED)).toBe(0);
  });

  test('ANY install is a change — including a fresh one that exits 0', () => {
    for (const state of ['fresh', 'stale', 'never_run', 'paused', 'disabled']) {
      expect(cmd.changeCount({ ...NOT_INSTALLED, installed: true, install_target: 'ephemeral-container', state }))
        .toBe(1);
    }
  });

  test('an unreadable report is UNKNOWN, never "not installed"', () => {
    expect(cmd.changeCount(null)).toBeNull();
    expect(cmd.changeCount({})).toBeNull();
    expect(cmd.changeCount({ installed: 'no', state: 'not_installed' })).toBeNull();
    expect(cmd.changeCount({ installed: false, state: 'mystery' })).toBeNull();
    // A key-set drift at a version bump is unknown too.
    expect(cmd.changeCount({ installed: false, state: 'not_installed' })).toBeNull();
  });

  test('installed:false is only believed alongside state not_installed', () => {
    expect(cmd.changeCount({ ...NOT_INSTALLED, state: 'fresh' })).toBeNull();
  });

  test('a caller cannot pass anything to it', () => {
    expect(() => validateParams(cmd, { source: 'x' })).toThrow(/unknown param/);
  });
});
```

- [ ] **Step 2: Run and confirm the failures**

Run: `bun test test/unit/scheduler-commands.test.ts`
Expected: FAIL (`undefined is not an object` / brain-wide list mismatch).

- [ ] **Step 3: Implement.** Add these above `SCHEDULER_COMMANDS`:

```ts
/**
 * `autopilot --status --json`'s AutopilotStatusReport, OBSERVED from the
 * pinned gbrain (docs/autopilot-status-findings.md): exactly these keys, and
 * on a Mobrain stack `installed:false, state:'not_installed'`.
 */
const AUTOPILOT_STATUS_KEYS = [
  'installed', 'install_target', 'state', 'disabled_reason', 'paused_reason',
  'heartbeat_age_seconds', 'stale_after_seconds', 'last_log',
];
const AUTOPILOT_STATES = ['not_installed', 'disabled', 'paused', 'never_run', 'stale', 'fresh'];

/**
 * The tripwire's evidence, or null when it cannot be read. "Not installed" is
 * believed only when the whole report agrees with itself: a key-set drift or
 * an `installed:false` next to a live state is unknown, never a pass — a gate
 * that cannot read its evidence must not pass vacuously (Slice 0 V6).
 */
export function readAutopilotReport(payload: unknown): { installed: boolean; state: string } | null {
  const o = obj(payload);
  if (!o) return null;
  if (Object.keys(o).length !== AUTOPILOT_STATUS_KEYS.length) return null;
  if (!AUTOPILOT_STATUS_KEYS.every((k) => k in o)) return null;
  if (typeof o.installed !== 'boolean' || typeof o.state !== 'string') return null;
  if (!AUTOPILOT_STATES.includes(o.state)) return null;
  if (!o.installed && o.state !== 'not_installed') return null;
  return { installed: o.installed, state: o.state };
}
```

Then add this entry after `doctor`:

```ts
  /**
   * A TRIPWIRE, not a health gate. Mobrain never installs gbrain's autopilot
   * (this scheduler replaces it), so the only healthy answer is
   * not_installed, and ANY install — even a `fresh` one that exits 0 — is a
   * second scheduler on this brain. Brain-wide because the probe reads the
   * shared GBRAIN_HOME, which no Space fences.
   */
  'autopilot-status': {
    id: 'autopilot-status', operation: 'autopilot.status', scope: 'brain-wide',
    fenced: [], tunable: {}, json: true,
    changeCount(payload) {
      const r = readAutopilotReport(payload);
      if (!r) return null;
      return r.installed ? 1 : 0;
    },
  },
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test test/unit/scheduler-commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/commands.ts test/unit/scheduler-commands.test.ts
git commit -m "feat(scheduler): autopilot-status command reads the install verdict from JSON"
```

---

### Task 3: Classification and alert kind

**Files:**
- Modify: `src/scheduler/execute.ts` (`classifyExit`, `alertKind`)
- Test: `test/unit/scheduler-classify.test.ts`

**Interfaces:**
- Consumes: `readAutopilotReport` (Task 2).
- Produces: `classifyExit('autopilot-status', code, payload)` → `'ok' | 'conflict' | 'failed' | 'lock_lost' | 'timeout'`; `alertKind('autopilot-status', 'conflict')` → `'autopilot_installed'` (not exported; covered through the integration test in Task 6).

- [ ] **Step 1: Write the failing tests.** Add them to `test/unit/scheduler-classify.test.ts`:

```ts
describe('the autopilot tripwire', () => {
  const report = (installed: boolean, state: string) => ({
    installed, install_target: installed ? 'ephemeral-container' : null, state,
    disabled_reason: null, paused_reason: null, heartbeat_age_seconds: null,
    stale_after_seconds: 1800, last_log: '',
  });

  test('not installed, exit 0, is the only ok', () => {
    expect(classifyExit('autopilot-status', 0, report(false, 'not_installed'))).toBe('ok');
  });

  test('a FRESH install is a conflict even though upstream exits 0', () => {
    expect(classifyExit('autopilot-status', 0, report(true, 'fresh'))).toBe('conflict');
  });

  test('stale / never_run / paused (exit 1) and disabled (exit 2) are conflicts', () => {
    for (const s of ['stale', 'never_run', 'paused']) {
      expect(classifyExit('autopilot-status', 1, report(true, s))).toBe('conflict');
    }
    expect(classifyExit('autopilot-status', 2, report(true, 'disabled'))).toBe('conflict');
  });

  test('exit 1 or 2 with NO JSON is a usage error, not a verdict', () => {
    // OBSERVED: an unknown flag exits 1, an unknown positional exits 2, and
    // neither prints a report.
    expect(classifyExit('autopilot-status', 1, null)).toBe('failed');
    expect(classifyExit('autopilot-status', 2, null)).toBe('failed');
  });

  test('exit 0 with an unreadable report never passes vacuously', () => {
    expect(classifyExit('autopilot-status', 0, null)).toBe('failed');
    expect(classifyExit('autopilot-status', 0, { installed: false })).toBe('failed');
  });

  test('the shared exit rules still come first', () => {
    expect(classifyExit('autopilot-status', 143, null)).toBe('timeout');
    expect(classifyExit('autopilot-status', 4, null)).toBe('lock_lost');
  });
});
```

Also, in the existing `'zero is ok for every command'` test, **leave the id list unchanged**. `autopilot-status` is the one command where exit 0 alone is not ok, and the new describe block covers that.

- [ ] **Step 2: Run and confirm the failures**

Run: `bun test test/unit/scheduler-classify.test.ts`
Expected: FAIL. `fresh`/exit 0 reads `ok`, and exit 1/2 with a report reads `failed`.

- [ ] **Step 3: Implement.** In `execute.ts`, add `readAutopilotReport` to the `./commands.ts` import. Append this to `classifyExit`'s doc comment:

```ts
 *  - autopilot-status is a TRIPWIRE, and its verdict is the JSON, not the exit
 *    code. Upstream exits 0 for a `fresh` install — the worst case for us, a
 *    second live scheduler — and its 1 ("needs attention") and 2 ("disabled")
 *    collide with its own usage-error exits, which print no report. So: an
 *    install in any state is `conflict` (two schedulers own one brain, the
 *    same shape as a push conflict, already in run_classification_valid);
 *    not_installed on exit 0 is `ok`; anything unreadable is `failed`,
 *    because a gate that cannot read its evidence must not pass (Slice 0 V6).
```

Then restructure the top of the function so the tripwire runs after the shared rules and **before** the `exitCode === 0` shortcut:

```ts
export function classifyExit(commandId: string, exitCode: number, payload: unknown): Classification {
  if (exitCode === 4) return 'lock_lost';
  if (exitCode === 143) return 'timeout';

  if (commandId === 'autopilot-status') {
    const report = readAutopilotReport(payload);
    if (report?.installed) return 'conflict';
    if (report && exitCode === 0) return 'ok';
    return 'failed';
  }

  if (exitCode === 0) return 'ok';
  // ...the sources-push block and the final `return 'failed'` are unchanged
```

(Moving `exitCode === 0` below 4/143 changes nothing for the other commands: 0 is neither 4 nor 143.)

In `alertKind`:

```ts
  if (commandId === 'autopilot-status' && classification === 'conflict') {
    return 'autopilot_installed';
  }
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test test/unit/scheduler-classify.test.ts test/unit/scheduler-commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/execute.ts test/unit/scheduler-classify.test.ts
git commit -m "feat(scheduler): classify an autopilot install as a conflict, from the report"
```

---

### Task 4: The `autopilot-tripwire` preset

**Files:**
- Modify: `src/scheduler/presets.ts` (after `weekly-health`)
- Test: `test/unit/scheduler-presets.test.ts`

**Interfaces:**
- Consumes: `SCHEDULER_COMMANDS['autopilot-status']`.
- Produces: `PRESETS['autopilot-tripwire']`.

- [ ] **Step 1: Write the failing tests.** Update the catalogue test, and add a shape test:

```ts
  test('ships five user presets: four commands and one agent run', () => {
    const user = Object.values(PRESETS).filter((p) => !p.system).map((p) => p.id).sort();
    expect(user).toEqual([
      'autopilot-tripwire', 'live-sync', 'nightly-agent-briefing', 'nightly-dream', 'weekly-health',
    ]);
  });
```

```ts
  test('autopilot-tripwire: daily 07:05, admin-gated, short, and quiet when healthy', () => {
    const p = PRESETS['autopilot-tripwire']!;
    expect(p.operation).toBe('autopilot-status');
    expect(p.kind).toBe('calendar');
    expect(p.params).toEqual({});
    expect(p.requiresRole).toBe('admin');
    expect(p.system).toBeUndefined();
    expect(p.defaults).toMatchObject({
      calendarHour: 7, calendarMinute: 5, slotMinute: 5, calendarDaysOfWeek: null,
      catchupPolicy: 'skip', overlapPolicy: 'skip',
      // A healthy day has nothing to say; an install or an unreadable probe
      // always reports (changeCount 1 or null).
      reportPolicy: 'on_change_or_failure',
      timeoutSeconds: 60,
    });
  });
```

The existing `weekly-health is brain-wide and therefore admin-gated` test (~line 80) names only `weekly-health`. Add this invariant next to it, so any future brain-wide preset is covered too:

```ts
  test('every brain-wide preset is admin-gated', () => {
    for (const p of Object.values(PRESETS)) {
      if (!p.operation || SCHEDULER_COMMANDS[p.operation]?.scope !== 'brain-wide') continue;
      expect(p.requiresRole).toBe('admin');
    }
  });
```

- [ ] **Step 2: Run and confirm the failures**

Run: `bun test test/unit/scheduler-presets.test.ts`
Expected: FAIL (catalogue mismatch; `undefined` preset).

- [ ] **Step 3: Implement.** Add after `weekly-health`:

```ts
  /**
   * docs/guides/cron-schedule.md recommends `autopilot --status` daily at 7 AM
   * as a health gate. In Mobrain it is a TRIPWIRE instead: autopilot is never
   * installed here, so a healthy run is always "not installed" and writes no
   * report, and any install at all raises a pinned autopilot_installed alert
   * (docs/autopilot-status-findings.md). Filesystem-only, so the timeout is
   * the DB floor's neighbourhood, not doctor's hour.
   */
  'autopilot-tripwire': {
    id: 'autopilot-tripwire',
    title: 'Competing-scheduler tripwire',
    description:
      "Checks daily that gbrain's own autopilot scheduler was never installed on this brain. "
      + 'Mobrain schedules everything itself, so an install means two schedulers are running '
      + 'the same jobs — that raises an alert. Silent when all is well. Needs an admin Connection.',
    kind: 'calendar',
    operation: 'autopilot-status',
    params: {},
    defaults: {
      calendarHour: 7, calendarMinute: 5, calendarDaysOfWeek: null, slotMinute: 5,
      catchupPolicy: 'skip', overlapPolicy: 'skip', reportPolicy: 'on_change_or_failure',
      timeoutSeconds: 60,
    },
    requiresRole: 'admin',
  },
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test test/unit/scheduler-presets.test.ts`
Expected: PASS, including the existing "distinct slot" and "assignable slot" tests (07:05 is free).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/presets.ts test/unit/scheduler-presets.test.ts
git commit -m "feat(scheduler): autopilot-tripwire preset, daily 07:05, admin-gated"
```

---

### Task 5: Console: the alert is pinned, labelled and danger-toned

**Files:**
- Modify: `src/console/pages/Schedules.tsx` (`PINNED_ALERT_KINDS` ~line 521, `ALERT_LABEL`, `ALERT_TONE`)
- Test: `test/unit/console-schedules.test.ts`

- [ ] **Step 1: Write the failing tests.** Extend the kind lists in two existing tests, and the scope test:

```ts
  test('every pinned kind is pinned for the right reason', () => {
    for (const kind of ['push_blocked', 'lease_expired', 'connection_revoked', 'autopilot_installed']) {
```

```ts
    for (const kind of ['push_rejected', 'push_blocked', 'lease_expired', 'connection_revoked',
      'autopilot_installed']) {
      expect(isPinnedAlert(kind)).toBe(true);
    }
```

```ts
    expect(commandScope('autopilot-status')).toBe('brain-wide');
```

Add one more test:

```ts
  test('a rogue autopilot install reads as a reason, not an enum', () => {
    expect(alertLabel('autopilot_installed')).not.toContain('_');
    expect(alertLabel('autopilot_installed')).toMatch(/autopilot/i);
  });
```

- [ ] **Step 2: Run and confirm the failures**

Run: `bun test test/unit/console-schedules.test.ts`
Expected: FAIL on the pinned predicate and the label.

- [ ] **Step 3: Implement.** Widen the doc comment above `PINNED_ALERT_KINDS`, keeping its existing text:

```ts
 * `autopilot_installed` is pinned for the mirror-image reason: a second
 * scheduler means work is silently DOUBLED — two writers on one brain — which
 * is exactly as invisible from the run history as work that stopped.
```

```ts
const PINNED_ALERT_KINDS = [
  'push_rejected', 'push_blocked', 'lease_expired', 'connection_revoked', 'autopilot_installed',
];
```

Add to `ALERT_LABEL`:

```ts
  autopilot_installed:
    "gbrain's own autopilot is installed — a second scheduler is running jobs on this brain",
```

Add to `ALERT_TONE`:

```ts
  autopilot_installed: 'danger',
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test test/unit/console-schedules.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/console/pages/Schedules.tsx test/unit/console-schedules.test.ts
git commit -m "feat(console): pin the autopilot_installed alert"
```

---

### Task 6: Integration: the executor and the routes

**Files:**
- Modify: `test/integration/scheduler-execute.test.ts`
- Modify: `test/integration/scheduler-routes.test.ts`

These tests should **pass as soon as they are written**, because Tasks 1–5 built the behaviour. That is expected: this task proves the pieces fit together. To keep it honest, run Step 2's mutation check.

- [ ] **Step 1: Add the executor tests.** Put them in `describe('executing a claimed run'` in `scheduler-execute.test.ts`, reusing its `schedule`, `occurrence`, `harness`, `rowOf` and `alertKinds` helpers:

```ts
  const AUTOPILOT = (installed: boolean, state: string) => ({
    installed, install_target: installed ? 'ephemeral-container' : null, state,
    disabled_reason: null, paused_reason: null, heartbeat_age_seconds: installed ? 12 : null,
    stale_after_seconds: 1800, last_log: '',
  });

  test('the autopilot tripwire is silent when nothing is installed', async () => {
    const scheduleId = await schedule({
      operation: 'autopilot-status', preset: 'autopilot-tripwire', reportPolicy: 'on_change_or_failure',
    });
    const claimed = await occurrence(scheduleId, { slot: 's-ap-ok', fireAtMs: AWAKE_MS, nowMs: AWAKE_MS });
    const { deps, captured, writes } = harness(() => ({ exitCode: 0, json: AUTOPILOT(false, 'not_installed') }), AWAKE_MS);

    const result = await executeRun(claimed, deps);

    expect(result.classification).toBe('ok');
    expect(captured[0]!.op).toBe('autopilot.status');
    expect(captured[0]!.params).toEqual({});          // brain-wide: no fence injected
    expect(writes.length).toBe(0);                    // changeCount 0 -> no report
    expect(await alertKinds(scheduleId)).toEqual([]);
    expect((await rowOf(claimed.run.id)).state).toBe('succeeded');
  });

  test('a FRESH autopilot install trips the wire even though gbrain exited 0', async () => {
    const scheduleId = await schedule({
      operation: 'autopilot-status', preset: 'autopilot-tripwire', reportPolicy: 'on_change_or_failure',
    });
    const claimed = await occurrence(scheduleId, { slot: 's-ap-fresh', fireAtMs: AWAKE_MS, nowMs: AWAKE_MS });
    const { deps, writes } = harness(() => ({ exitCode: 0, json: AUTOPILOT(true, 'fresh') }), AWAKE_MS);

    const result = await executeRun(claimed, deps);

    expect(result.classification).toBe('conflict');
    expect(writes.length).toBe(1);
    expect(await alertKinds(scheduleId)).toEqual(['autopilot_installed']);
    expect((await rowOf(claimed.run.id)).state).toBe('failed');
  });

  test('an unreadable autopilot probe is a failure with a report, never a pass', async () => {
    const scheduleId = await schedule({
      operation: 'autopilot-status', preset: 'autopilot-tripwire', reportPolicy: 'on_change_or_failure',
    });
    const claimed = await occurrence(scheduleId, { slot: 's-ap-junk', fireAtMs: AWAKE_MS, nowMs: AWAKE_MS });
    const { deps, writes } = harness(() => ({
      exitCode: 2, stderr: "Unknown autopilot argument 'x'.\n",
    }), AWAKE_MS);

    const result = await executeRun(claimed, deps);

    expect(result.classification).toBe('failed');
    expect(writes.length).toBe(1);
    expect(await alertKinds(scheduleId)).toEqual(['run_failed']);
  });
```

If the `schedules` insert rejects `preset` as a column name, check `schema.schedules` for the actual field (it is read as `schedule.preset` in `execute.ts:planSteps`) and use that name.

- [ ] **Step 2: Mutation check.** Temporarily delete the `autopilot-status` block in `classifyExit` (Task 3), run `bun test test/integration/scheduler-execute.test.ts -t "autopilot"`, and confirm the "FRESH" test FAILS (it reads `ok`). Restore the block, then re-run and confirm PASS.

- [ ] **Step 3: Add the routes tests.** In `scheduler-routes.test.ts`, update the catalogue list at ~line 1195 to:

```ts
      .toEqual(['autopilot-tripwire', 'live-sync', 'nightly-agent-briefing', 'nightly-dream', 'weekly-health']);
```

Next to `'a brain-wide schedule requires an admin-or-better Connection'` (~line 468), add:

```ts
  test('the autopilot tripwire is admin-gated like any brain-wide preset', async () => {
    const refused = await hit('POST', '/api/schedules', adminCookie, {
      name: uniqueName('autopilot-tripwire'), preset: 'autopilot-tripwire', connectionId: memberConn,
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ scope: 'brain-wide' });

    const allowed = await hit('POST', '/api/schedules', adminCookie, {
      name: uniqueName('autopilot-tripwire'), preset: 'autopilot-tripwire', connectionId: ownerConn,
    });
    expect(allowed.status).toBe(201);
    const body = await allowed.json() as {
      operation: string; calendarHour: number; slotMinute: number; reportPolicy: string; timeoutSeconds: number;
    };
    expect(body).toMatchObject({
      operation: 'autopilot-status', calendarHour: 7, slotMinute: 5,
      reportPolicy: 'on_change_or_failure', timeoutSeconds: 60,
    });
  });
```

- [ ] **Step 4: Run the integration suites**

Run: `bun run test:integration:isolated`, or if the control DB is already up, `bun test test/integration/scheduler-execute.test.ts test/integration/scheduler-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/integration/scheduler-execute.test.ts test/integration/scheduler-routes.test.ts
git commit -m "test(scheduler): autopilot tripwire end to end through the executor and routes"
```

---

### Task 7: Docs and the findings note

**Files:**
- Modify: `docs/product-overview.md` §5.4 table (~line 175)
- Modify: `docs/runbooks/scheduler.md` preset table (~line 47), and add a response entry for the alert
- Create: `docs/autopilot-status-findings.md`

- [ ] **Step 1: product-overview row.** Insert it after `weekly-health`:

```markdown
| `autopilot-tripwire` | daily 07:05 | Alerts if gbrain's own autopilot scheduler is ever installed — a second scheduler on the brain (needs an admin Connection; silent when healthy) |
```

- [ ] **Step 2: runbook row.** Insert it after `weekly-health`:

```markdown
| `autopilot-tripwire` | daily 07:05 | `autopilot --status` | Tripwire, not a health gate: healthy is always "not installed" and writes no report. Any install raises the pinned `autopilot_installed` alert. Brain-wide, so it needs an admin Connection. Timeout 60s. |
```

Then add a row to the `## Alerts: what each one means` table (~line 168), after `push_rejected`:

```markdown
| `autopilot_installed` | The tripwire read `installed: true` — gbrain's own autopilot is running beside this scheduler (`conflict`, any exit 0/1/2 with a report). Pinned. | Remove it — see the next section. |
```

Then add a section after `## Resolve a rejected push by hand`, in the same style:

```markdown
## Remove a rogue autopilot install

gbrain's own autopilot is installed somewhere that shares `gbrain-home`, so a second scheduler is running
sync/embed/dream beside this one. Confirm and find the target:

    docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml exec gbrain-ops gbrain autopilot --status --json

`install_target` says where it came from (in these containers it can only be `ephemeral-container`, i.e.
`$GBRAIN_HOME/start-autopilot.sh`). Remove it with `gbrain autopilot --uninstall` in the same container,
re-run the status probe until it reads `not_installed`, then acknowledge the alert.
```

(Docs are exempt from `lint:forbidden`, but don't write the install command in the remedy anyway. The remedy is uninstall.)

- [ ] **Step 3: Write `docs/autopilot-status-findings.md`.** Use the `slice-0-findings.md` status vocabulary (`confirmed` / `falsified` / `changed`):

```markdown
# `gbrain autopilot --status` — findings (2026-09-22)

Observed against the pinned gbrain **0.50.5.0** in the dev stack's `gbrain-ops`
(`gbrain --version`), plus the pinned source at
`~/.bun/install/cache/@GH@garrytan-gbrain-668b9ba@@@1/src/commands/autopilot.ts`.
Status: `confirmed` (upstream's claim held) | `falsified` | `changed`.

## Upstream claim vs. observed

| # | Upstream claim (docs/guides/cron-schedule.md) | Status | Evidence |
|---|---|---|---|
| A1 | `autopilot --status` exists | `confirmed` | exit 0, prose verdict; `autopilot status` subcommand form is equivalent (autopilot.ts:494, #1525) |
| A2 | `--json` is supported | `confirmed` | one-line AutopilotStatusReport: `installed, install_target, state, disabled_reason, paused_reason, heartbeat_age_seconds, stale_after_seconds, last_log` |
| A3 | exit 0 fresh/not installed, 1 needs attention, 2 took itself out of rotation | `confirmed`, with a caveat | `autopilotStatusExitCode` (autopilot.ts:2489). **Caveat:** 1 is also the unknown-flag exit and 2 the unknown-positional exit, and neither prints JSON — so the exit code alone is ambiguous |
| A4 | filesystem-only, works during a DB outage | `confirmed` | `runAutopilotStatus` is dispatched before `connectEngine` (autopilot.ts:2318-2324) |
| A5 | (implicit) a useful daily health gate | `changed` for Mobrain | Mobrain never installs autopilot, so the steady state is `not_installed`/exit 0 forever: a literal gate would never fire |
| A6 | (brief's question) source scope? | none | `--source` silently ignored; `--source <id>` is a usage error (exit 2) |

## Where it can see an install from

`detectInstalledTarget` checks a macOS plist, a systemd unit, `$GBRAIN_HOME/start-autopilot.sh`, and
`crontab -l`. The gbrain-ops container has no `crontab` binary and no systemd, so the only detectable target is
`ephemeral-container`, via the `gbrain-home` volume shared by gbrain-serve, gbrain-worker and gbrain-ops.
An install on the **host** crontab is invisible to this probe. That is a known blind spot, not a false pass.

## Decisions

1. **Tripwire, not health gate** (user decision, 2026-09-22). Healthy = `not_installed`. Any install, in any
   state and including `fresh`/exit 0, is a second scheduler on the brain.
2. **Verdict from the JSON, not the exit code.** It follows from A3's caveat and from `fresh` exiting 0.
3. **Classification `conflict`**: two schedulers, one brain, the same shape as a push conflict, and already in
   `run_classification_valid`. Unreadable output is `failed`, never `ok` (Slice 0 V6: a gate must not pass
   vacuously).
4. **Alert `autopilot_installed`, pinned, danger**: doubled work is as invisible in run history as stopped work.
5. **Brain-wide, admin Connection**: it reads the shared GBRAIN_HOME, which no Space fences. The console
   banner's "reads the whole brain" overstates the reach (it reads no brain content) but errs safe.
6. **`reportPolicy: on_change_or_failure`**: `changeCount` is 1 for an install, 0 for none, null for
   unreadable. A healthy day writes no report; a trip or an unreadable probe always does.
7. **okExitCodes `[0, 1, 2]`**: all three are verdicts. Only the status verb is allowlisted; the install verb
   stays lint-forbidden and is asserted refused at the RPC (contract A3b).
```

- [ ] **Step 4: Commit**

```bash
git add docs/product-overview.md docs/runbooks/scheduler.md docs/autopilot-status-findings.md
git commit -m "docs: autopilot tripwire preset, runbook response and findings"
```

---

### Task 8: Full verification and PR

- [ ] **Step 1: Run everything**

```bash
bun run lint:forbidden
bunx tsc --noEmit
bun run test:unit
bun run test:integration:isolated
bun test test/contract/scheduler.contract.test.ts
```
Expected: all green. `lint:forbidden` must report zero violations. If `tsc` isn't the repo's typecheck entry, use whatever `package.json`/CI runs.

- [ ] **Step 2: Live smoke on the dev stack.** Redeploy (`bash scripts/redeploy.sh --full`), create the preset from the console as an owner Connection, then use "run now" (or wait for 07:05). Confirm the run is `succeeded`, has no report, and raises no alert.

- [ ] **Step 3: PR.** Use superpowers:finishing-a-development-branch. The PR body links `docs/autopilot-status-findings.md` and states the tripwire inversion up front.
