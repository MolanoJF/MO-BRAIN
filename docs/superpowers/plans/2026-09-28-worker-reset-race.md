# Worker Reset Race Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wizard `/finish` and the contract harness's `resetBrain()` drop the brain schema only while `gbrain-serve` and `gbrain-worker` cannot reconnect and re-template `content_chunks.embedding` at 1280.

**Architecture:** A pause file on the shared `gbrain-home` volume is the switch. `gbrain-serve` and `gbrain-worker` run under a small entrypoint that starts `gbrain` only when `/srv/gbrain-home/.gbrain/config.json` exists and `/srv/gbrain-home/.mobrain-writers-paused` does not. Ops creates the pause file and waits until those processes are gone before `resetBrainSchema()`; it deletes the file only after `init` has succeeded. The control plane never gets a Docker socket. The slice0 harness has no worker service, so `resetBrain()` runs a proc-scoped kill of `gbrain` processes inside `gbrain-ops` and does not restart them — the test's own `init` comes next.

**Tech Stack:** TypeScript, Bun, Hono, Postgres (`bun` SQL), Docker Compose, POSIX `/bin/sh`, gbrain pin `0.50.5.0`.

**Spec:** https://github.com/MoliorOS/MO-BRAIN/issues/6 — the issue is the spec. Requirements that the plan implements are copied into Global Constraints. Run `36415332351` failed inside `POST /api/wizard/finish` (`init` exit 1) before the contract suite started, so "reset and init are back-to-back in one request" is not sufficient.

## Global Constraints

- Pinned-current stays `0.50.5.0`. Do not change `GBRAIN_VERSION` in `.env`, `PINNED_CURRENT`, or `src/contracts/pin.ts` to make this pass.
- S2: `control-plane` has no Docker socket and no `GBRAIN_DATABASE_URL`. Quiesce goes through `gbrain-ops` and the shared `gbrain-home` volume.
- `POSTGRES_USER` is `gbrain`, and the Postgres image makes that role a superuser. `ALTER ROLE gbrain CONNECTION LIMIT` does not lock the worker out. Do not use it.
- At this pin `gbrain jobs supervisor stop` leaves the worker process alive (`test/contract/upgrade.contract.test.ts`, the block under "leaves the worker process ALIVE"). `gbrain-worker`'s `restart: unless-stopped` cold-starts again if pid 1 exits. Do not implement this issue by calling `jobs.supervisorStop` around the reset.
- `gbrain-worker` and `gbrain-serve` both cold-start the schema (`docs/slice-5-findings.md`, F31). Gate both.
- Do not `docker compose down -v` against project `mobrain-local`. Before any compose command, set `COMPOSE_PROJECT_NAME` to `brainstand-slice0` (slice0) and confirm `docker compose ps` prints that project name.
- Do not print or overwrite `.env`. Do not regenerate `ENCRYPTION_KEY`.
- Integration tests that open `CONTROL_DATABASE_URL` must use a throwaway database. The live `mobrain-local` database is not published on the host; do not point tests at it.
- Write every new `*.sh` file with LF line endings. The image's `/bin/sh` rejects CR.

---

### Task 1: Gate serve and the worker on the pause file

**Files:**
- Create: `docker/gbrain-gated-entrypoint.sh`
- Create: `test/build/gbrain-gated-entrypoint.test.sh`
- Modify: `docker/gbrain-base.Dockerfile` (insert the `COPY` before `ENTRYPOINT`)
- Modify: `compose/docker-compose.yml` (`gbrain-serve` command at the `command:` key, `gbrain-worker` command at its `command:` key)
- Modify: `test/integration/compose-invariants.test.ts` (add one test inside `describe('compose invariants')`)

**Interfaces:**
- Consumes: nothing from later tasks.
- Produces: container command `/opt/mobrain/gbrain-gated-entrypoint.sh` followed by the previous `gbrain` argv. The entrypoint polls every `${MOBRAIN_GATE_POLL_SECONDS:-0.5}` seconds. It starts that argv only when `$MOBRAIN_GBRAIN_HOME/.gbrain/config.json` exists (default home `/srv/gbrain-home`) AND `$MOBRAIN_GBRAIN_HOME/.mobrain-writers-paused` does not. Creating the pause file SIGTERMs the child within one poll, waits up to 50s, then SIGKILLs. Deleting the pause file while `config.json` exists starts the child again. A missing `config.json` never starts `gbrain`, which is what stops a virgin boot from templating `vector(1280)`.

- [ ] **Step 1: Write the failing entrypoint test**

Create `test/build/gbrain-gated-entrypoint.test.sh` with LF endings:

```sh
#!/bin/sh
# Proves the gate: no config => stay down; config => run; pause file => stop
# and stay stopped; clearing the pause file => start again.
set -eu
root=$(mktemp -d)
gate=""
cleanup() {
  if [ -n "$gate" ]; then
    kill -TERM "$gate" 2>/dev/null || true
    wait "$gate" 2>/dev/null || true
  fi
  rm -rf "$root"
}
trap cleanup EXIT
mkdir -p "$root/bin" "$root/home/.gbrain"
cat > "$root/bin/gbrain" <<'EOF'
#!/bin/sh
echo "started" >> "$GATE_LOG"
trap 'echo "stopped" >> "$GATE_LOG"; exit 0' TERM INT
while true; do sleep 1; done
EOF
chmod 0755 "$root/bin/gbrain"
export PATH="$root/bin:$PATH"
export MOBRAIN_GBRAIN_HOME="$root/home"
export MOBRAIN_GATE_POLL_SECONDS=0.2
export GATE_LOG="$root/log"
: > "$GATE_LOG"

sh docker/gbrain-gated-entrypoint.sh gbrain jobs supervisor --concurrency 2 &
gate=$!

sleep 1
if grep -q started "$GATE_LOG"; then
  echo "gbrain started with no config.json" >&2
  exit 1
fi

echo '{}' > "$root/home/.gbrain/config.json"
echo paused > "$root/home/.mobrain-writers-paused"
sleep 1
if grep -q started "$GATE_LOG"; then
  echo "gbrain started while the pause file existed" >&2
  exit 1
fi

rm -f "$root/home/.mobrain-writers-paused"
i=0
while ! grep -q started "$GATE_LOG"; do
  i=$((i + 1))
  if [ "$i" -gt 20 ]; then
    echo "gbrain did not start after config.json existed and the pause file was gone" >&2
    exit 1
  fi
  sleep 0.2
done

echo paused > "$root/home/.mobrain-writers-paused"
i=0
while ! grep -q stopped "$GATE_LOG"; do
  i=$((i + 1))
  if [ "$i" -gt 30 ]; then
    echo "gbrain did not stop after the pause file was created" >&2
    exit 1
  fi
  sleep 0.2
done

before=$(grep -c started "$GATE_LOG")
sleep 1
after=$(grep -c started "$GATE_LOG")
if [ "$before" != "$after" ]; then
  echo "gbrain restarted while the pause file still existed" >&2
  exit 1
fi

rm -f "$root/home/.mobrain-writers-paused"
i=0
while [ "$(grep -c started "$GATE_LOG")" -lt 2 ]; do
  i=$((i + 1))
  if [ "$i" -gt 20 ]; then
    echo "gbrain did not start again after the pause file was removed" >&2
    exit 1
  fi
  sleep 0.2
done

echo "ok"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash test/build/gbrain-gated-entrypoint.test.sh`

Expected: FAIL. The script is missing, so bash exits non-zero (`can't open docker/gbrain-gated-entrypoint.sh` or `No such file`).

- [ ] **Step 3: Write the entrypoint**

Create `docker/gbrain-gated-entrypoint.sh` with LF endings and mode `0755`:

```sh
#!/bin/sh
# Start the given gbrain argv only when the brain has a config AND ops has
# not asked writers to stay down. tini is pid 1; this script is the child
# Compose names in `command:`.
set -u
if [ "$#" -lt 1 ]; then
  echo "gbrain-gated-entrypoint: command required" >&2
  exit 64
fi

HOME_DIR=${MOBRAIN_GBRAIN_HOME:-/srv/gbrain-home}
PAUSE="$HOME_DIR/.mobrain-writers-paused"
CONFIG="$HOME_DIR/.gbrain/config.json"
POLL=${MOBRAIN_GATE_POLL_SECONDS:-0.5}

child=""

stop_child() {
  if [ -z "$child" ]; then
    return 0
  fi
  if ! kill -0 "$child" 2>/dev/null; then
    wait "$child" 2>/dev/null || true
    child=""
    return 0
  fi
  kill -TERM "$child" 2>/dev/null || true
  i=0
  while kill -0 "$child" 2>/dev/null && [ "$i" -lt 50 ]; do
    sleep 1
    i=$((i + 1))
  done
  if kill -0 "$child" 2>/dev/null; then
    kill -KILL "$child" 2>/dev/null || true
  fi
  wait "$child" 2>/dev/null || true
  child=""
}

trap 'stop_child; exit 0' TERM INT

while true; do
  if [ -f "$CONFIG" ] && [ ! -f "$PAUSE" ]; then
    if [ -z "$child" ] || ! kill -0 "$child" 2>/dev/null; then
      if [ -n "$child" ]; then
        wait "$child" 2>/dev/null || true
        child=""
      fi
      "$@" &
      child=$!
    fi
  else
    stop_child
  fi
  sleep "$POLL"
done
```

In `docker/gbrain-base.Dockerfile`, immediately above the `ENTRYPOINT` line, add:

```dockerfile
COPY docker/gbrain-gated-entrypoint.sh /opt/mobrain/gbrain-gated-entrypoint.sh
RUN chmod 0755 /opt/mobrain/gbrain-gated-entrypoint.sh
```

Task 4 adds the second `COPY` for `docker/quiesce-gbrain-procs.sh`. This task does not reference that file.

In `compose/docker-compose.yml`, replace the `gbrain-serve` command with:

```yaml
    command: ["/opt/mobrain/gbrain-gated-entrypoint.sh", "gbrain", "serve", "--http", "--bind", "0.0.0.0", "--port", "3131",
              "--public-url", "https://${DOMAIN}"]
```

Replace the `gbrain-worker` command with:

```yaml
    command: ["/opt/mobrain/gbrain-gated-entrypoint.sh", "gbrain", "jobs", "supervisor", "--concurrency", "${WORKER_CONCURRENCY:-2}"]
```

Leave `restart: unless-stopped` and `stop_grace_period: 60s` on the worker as they are. The entrypoint is what stays up; `gbrain` is its child.

In `test/integration/compose-invariants.test.ts`, inside `describe('compose invariants')`, add:

```ts
  test('serve and the worker start through the pause-file gate', () => {
    expect(svc('gbrain-serve').command[0]).toBe('/opt/mobrain/gbrain-gated-entrypoint.sh');
    expect(svc('gbrain-serve').command[1]).toBe('gbrain');
    expect(svc('gbrain-serve').command[2]).toBe('serve');
    expect(svc('gbrain-worker').command[0]).toBe('/opt/mobrain/gbrain-gated-entrypoint.sh');
    expect(svc('gbrain-worker').command.slice(1, 4)).toEqual(['gbrain', 'jobs', 'supervisor']);
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bash test/build/gbrain-gated-entrypoint.test.sh`

Expected: a final line `ok` and exit 0.

Run: `bun test test/integration/compose-invariants.test.ts`

Expected: PASS, including `serve and the worker start through the pause-file gate`. The Docker-backed test in that file may skip only when `BRAINSTAND_ALLOW_SKIP_COMPOSE_DOCKER_CHECK` is set; the new test does not need Docker.

- [ ] **Step 5: Commit**

```bash
git add docker/gbrain-gated-entrypoint.sh docker/gbrain-base.Dockerfile compose/docker-compose.yml test/build/gbrain-gated-entrypoint.test.sh test/integration/compose-invariants.test.ts
git commit -m "fix: gate gbrain serve and worker on the brain-ready pause file"
```

---

### Task 2: Ops pause and resume routes

**Files:**
- Create: `src/ops/writerGate.ts`
- Create: `test/unit/writer-gate.test.ts`
- Modify: `src/ops/server.ts` (import, and two routes beside `/fileplane/reset-brain-schema`)
- Modify: `src/control/opsClient.ts` (two client functions beside `resetBrainSchema`)

**Interfaces:**
- Consumes: Task 1's pause file path `/srv/gbrain-home/.mobrain-writers-paused` (overridable with `GBRAIN_HOME`).
- Produces:
  - `pauseBrainWriters(deps?: { writePause?: () => Promise<void>; waitUntilQuiet?: () => Promise<void> }): Promise<void>` in `src/ops/writerGate.ts`. Writes the pause file, then waits until `gbrain jobs supervisor status --json` exits 1 and `pg_stat_activity` shows no other backend on the current database. Timeout `60_000` ms throws `Error` whose message includes `writers did not quiesce`.
  - `resumeBrainWriters(deps?: { clearPause?: () => Promise<void> }): Promise<void>`. Unlinks the pause file. `ENOENT` is success.
  - `POST /fileplane/pause-writers` and `POST /fileplane/resume-writers` on gbrain-ops, both returning `{ ok: true }`.
  - `pauseBrainWriters(): Promise<void>` and `resumeBrainWriters(): Promise<void>` in `src/control/opsClient.ts`, posting to those paths with timeouts `90_000` and `30_000`.

- [ ] **Step 1: Write the failing unit test**

Create `test/unit/writer-gate.test.ts`:

```ts
import { test, expect, describe } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pauseBrainWriters, resumeBrainWriters, pauseFilePath } from '../../src/ops/writerGate.ts';

describe('writerGate', () => {
  test('pause writes the pause file and waits before returning', async () => {
    const dir = join(tmpdir(), `writer-gate-${crypto.randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const prev = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = dir;
    const order: string[] = [];
    try {
      await pauseBrainWriters({
        writePause: async () => { order.push('write'); },
        waitUntilQuiet: async () => { order.push('wait'); },
      });
      expect(order).toEqual(['write', 'wait']);
    } finally {
      if (prev === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('default pause creates the file and default resume removes it', async () => {
    const dir = join(tmpdir(), `writer-gate-${crypto.randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const prev = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = dir;
    try {
      await pauseBrainWriters({ waitUntilQuiet: async () => {} });
      const body = await readFile(pauseFilePath(), 'utf8');
      expect(body.length).toBeGreaterThan(0);
      await resumeBrainWriters();
      await expect(readFile(pauseFilePath(), 'utf8')).rejects.toThrow();
      await resumeBrainWriters();
    } finally {
      if (prev === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a quiet timeout names the gate', async () => {
    await expect(pauseBrainWriters({
      writePause: async () => {},
      waitUntilQuiet: async () => { throw new Error('writers did not quiesce within 60000ms'); },
    })).rejects.toThrow(/writers did not quiesce/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/writer-gate.test.ts`

Expected: FAIL. The module `../../src/ops/writerGate.ts` does not exist.

- [ ] **Step 3: Implement the gate, the routes, and the client**

Create `src/ops/writerGate.ts`:

```ts
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { SQL } from 'bun';

const QUIET_TIMEOUT_MS = 60_000;
const QUIET_POLL_MS = 500;

export function pauseFilePath(): string {
  return join(process.env.GBRAIN_HOME ?? '/srv/gbrain-home', '.mobrain-writers-paused');
}

async function defaultWritePause(): Promise<void> {
  const path = pauseFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${new Date().toISOString()}\n`, { mode: 0o644 });
}

async function defaultClearPause(): Promise<void> {
  await unlink(pauseFilePath()).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e;
  });
}

function runGbrain(argv: string[], timeoutMs: number): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('gbrain', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stderr });
    });
  });
}

async function otherBackends(): Promise<number> {
  const url = process.env.GBRAIN_DATABASE_URL;
  if (!url) throw new Error('GBRAIN_DATABASE_URL is required to quiesce writers');
  const brain = new SQL(url, { max: 1 });
  try {
    const rows = await brain.unsafe(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()',
    ) as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  } finally {
    await brain.end().catch(() => {});
  }
}

export async function defaultWaitUntilQuiet(): Promise<void> {
  const deadline = Date.now() + QUIET_TIMEOUT_MS;
  let last = 'supervisor status not yet read';
  for (;;) {
    const status = await runGbrain(['jobs', 'supervisor', 'status', '--json'], 15_000);
    const backends = await otherBackends();
    // Exit 1 is "not running" (registry okExitCodes). Exit 0 means it is still up.
    const supervisorDown = status.exitCode === 1;
    if (supervisorDown && backends === 0) return;
    last = `supervisor exit ${status.exitCode}, other backends ${backends}`;
    if (Date.now() > deadline) {
      throw new Error(
        `writers did not quiesce within ${QUIET_TIMEOUT_MS}ms (${last}). ` +
        'gbrain-serve and gbrain-worker must use gbrain-gated-entrypoint.sh',
      );
    }
    await Bun.sleep(QUIET_POLL_MS);
  }
}

export async function pauseBrainWriters(deps?: {
  writePause?: () => Promise<void>;
  waitUntilQuiet?: () => Promise<void>;
}): Promise<void> {
  await (deps?.writePause ?? defaultWritePause)();
  await (deps?.waitUntilQuiet ?? defaultWaitUntilQuiet)();
}

export async function resumeBrainWriters(deps?: {
  clearPause?: () => Promise<void>;
}): Promise<void> {
  await (deps?.clearPause ?? defaultClearPause)();
}
```

In `src/ops/server.ts`, add `pauseBrainWriters, resumeBrainWriters` to the import from `./writerGate.ts`. Immediately after the `/fileplane/reset-brain-schema` block, add:

```ts
      if (url.pathname === '/fileplane/pause-writers') {
        await pauseBrainWriters();
        return json({ ok: true });
      }

      if (url.pathname === '/fileplane/resume-writers') {
        await resumeBrainWriters();
        return json({ ok: true });
      }
```

In `src/control/opsClient.ts`, immediately after `resetBrainSchema`, add:

```ts
/** Hold serve and the worker down across a schema reset. See writerGate.ts. */
export async function pauseBrainWriters(): Promise<void> {
  await post('/fileplane/pause-writers', {}, 90_000);
}

/** Allow the gated entrypoint to start serve and the worker again. */
export async function resumeBrainWriters(): Promise<void> {
  await post('/fileplane/resume-writers', {}, 30_000);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/unit/writer-gate.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ops/writerGate.ts src/ops/server.ts src/control/opsClient.ts test/unit/writer-gate.test.ts
git commit -m "fix: ops can pause and resume gbrain writers around a schema reset"
```

---

### Task 3: Wizard finish holds the pause across init

**Files:**
- Modify: `src/control/routes/wizard.ts` (import line, `/finish` handler)
- Modify: `scripts/ci-bootstrap-brain.ts` (the comment above `resetBrainSchema`, lines 6–15)
- Modify: `test/integration/wizard.test.ts` (record pause/reset/resume order; one new test)
- Modify the opsClient mock factories so the app still loads. Beside each existing `resetBrainSchema:` line, add the two no-op methods shown in Step 3. Files:
  - `test/helpers/opsMock.ts`
  - `test/integration/claim.test.ts`
  - `test/integration/connections.test.ts`
  - `test/integration/agent-runs.test.ts`
  - `test/integration/private-spaces.test.ts`
  - `test/integration/routes.test.ts`
  - `test/integration/scheduler-routes.test.ts`
  - `test/integration/schema-routes.test.ts`
  - `test/integration/sources-routes.test.ts`
  - `test/integration/spend.test.ts`
  - `test/integration/wizard.test.ts` (this file gets the recording versions, not the no-ops)

**Interfaces:**
- Consumes: `pauseBrainWriters` and `resumeBrainWriters` from `src/control/opsClient.ts` (Task 2).
- Produces: `POST /api/wizard/finish` calls pause, then `resetBrainSchema`, then `init`. It calls resume only when that `init` result has `ok === true`. A failed init leaves the pause file in place and includes a redacted stderr tail on that step: `{ id, ok, exitCode, stderr? }`. Pause failures return HTTP 503 `{ error: string }`.

- [ ] **Step 1: Write the failing wizard tests**

In `test/integration/wizard.test.ts`, next to `let resetBrainSchemaCalls = 0;`, add:

```ts
let failInit = false;
const finishOrder: string[] = [];
```

Inside the `mock.module` factory, replace `resetBrainSchema: async () => { resetBrainSchemaCalls += 1; },` with:

```ts
  resetBrainSchema: async () => { resetBrainSchemaCalls += 1; finishOrder.push('reset'); },
  pauseBrainWriters: async () => { finishOrder.push('pause'); },
  resumeBrainWriters: async () => { finishOrder.push('resume'); },
```

In the `callOps` mock, as the first line of the function body, add `finishOrder.push(op);`.

Before the generic success return, add:

```ts
    if (op === 'init' && failInit) {
      return {
        ok: false, exitCode: 1, argv: ['gbrain', 'init'],
        stdout: '', stderr: 'Refusing to silently re-template existing brain\npostgres://gbrain:secret@postgres:5432/gbrain\n',
        json: null,
      };
    }
```

Extend the existing test `finish does not pass json:true for init or config.set` by resetting `finishOrder.length = 0` next to `callOpsCalls.length = 0`, and add:

```ts
    expect(finishOrder.indexOf('pause')).toBeGreaterThanOrEqual(0);
    expect(finishOrder.indexOf('pause')).toBeLessThan(finishOrder.indexOf('reset'));
    expect(finishOrder.indexOf('reset')).toBeLessThan(finishOrder.indexOf('init'));
    expect(finishOrder.indexOf('init')).toBeLessThan(finishOrder.indexOf('resume'));
```

Add this test immediately before `finish does not pass json:true for init or config.set`. That test advances the brain to `ready`; `/finish` from `ready` returns 409, so the failure test has to run while the lifecycle is still `sources-added`.

```ts
  test('finish leaves writers paused when init fails and returns the stderr tail', async () => {
    failInit = true;
    finishOrder.length = 0;
    try {
      const res = await call('/api/wizard/finish', {});
      expect(res.status).toBe(500);
      const body = await res.json() as {
        ok: boolean;
        steps: { id: string; ok: boolean; stderr?: string }[];
      };
      expect(body.ok).toBe(false);
      const init = body.steps.find((s) => s.id === 'init');
      expect(init?.ok).toBe(false);
      expect(init?.stderr).toContain('Refusing to silently re-template');
      expect(init?.stderr).not.toContain('secret');
      expect(finishOrder).toContain('pause');
      expect(finishOrder).toContain('reset');
      expect(finishOrder).not.toContain('resume');
    } finally {
      failInit = false;
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/integration/wizard.test.ts`

Expected: FAIL. `finishOrder.indexOf('pause')` is `-1` because `/finish` never calls `pauseBrainWriters`. The new test fails the same way. A missing throwaway `CONTROL_DATABASE_URL` is an environment failure, not the expected failure — point it at a throwaway Postgres, never `mobrain-local`.

- [ ] **Step 3: Wire `/finish` and the other mocks**

In `src/control/routes/wizard.ts`, change the opsClient import to:

```ts
import { callOps, patchFilePlaneConfig, seedSpace, resetBrainSchema, putSchemaPackJson, pauseBrainWriters, resumeBrainWriters } from '../opsClient.ts';
```

Add this helper next to `audit`:

```ts
function redactStepStderr(stderr: string): string {
  return stderr
    .replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/gi, '$1[redacted]@')
    .slice(-500);
}
```

In the `/finish` handler, replace the `steps` element type and the `run` callback's push so a failed op keeps a redacted stderr tail:

```ts
  const steps: { id: string; ok: boolean; exitCode: number; stderr?: string }[] = [];
  const run = async (id: string, op: string, params: Record<string, unknown>, timeoutMs = 900_000) => {
    const r = await callOps(op, params, { ...finishCallOpts(op), timeoutMs });
    steps.push({
      id, ok: r.ok, exitCode: r.exitCode,
      ...(r.ok ? {} : { stderr: redactStepStderr(r.stderr ?? '') }),
    });
    return r;
  };
```

Replace the comment and `await resetBrainSchema(); await run('init', ...)` block with:

```ts
  // Serve and the worker cold-start vector(1280) on any reconnect. The pause
  // file keeps their entrypoint from starting gbrain until init has created
  // the 1536-d schema. A failed init leaves the pause in place so a retry
  // cannot race a half-written config.json.
  try {
    await pauseBrainWriters();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return c.json({ error: message }, 503);
  }
  await resetBrainSchema();
  const initResult = await run('init', 'init', {
    nonInteractive: true,
    force: true,
    embeddingModel: brain.embeddingModel ?? 'openai:text-embedding-3-small',
    ...(brain.schemaPack ? { schemaPack: brain.schemaPack } : {}),
  });
  if (initResult.ok) await resumeBrainWriters();
```

Do not resume in a `finally`. Later steps (`sources.add`, sync, embed, doctor) stay as they are.

In `scripts/ci-bootstrap-brain.ts`, replace the comment that says the in-request reset+init window is already closed (the paragraph starting "A fresh `docker compose up`") with:

```ts
 * A fresh `docker compose up` used to let gbrain-worker/serve cold-start
 * `content_chunks.embedding` at upstream's default width (1280). `/finish`
 * now pauses those writers for the whole reset+init, and resumes them only
 * after init succeeds. This script still drives that product path. It does
 * not call `gbrain init` itself.
```

In every mock factory listed above except `wizard.test.ts`, add these two lines next to `resetBrainSchema`:

```ts
    pauseBrainWriters: async () => {},
    resumeBrainWriters: async () => {},
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/integration/wizard.test.ts`

Expected: PASS, including the new stderr test and the order assertions on the existing finish test.

Run: `bun test test/integration/routes.test.ts test/integration/mode.test.ts`

Expected: PASS. `routes.test.ts` uses an inline mock; `mode.test.ts` uses `installOpsMock()`. A load failure means a mock factory is still missing the two methods.

- [ ] **Step 5: Commit**

```bash
git add src/control/routes/wizard.ts scripts/ci-bootstrap-brain.ts test/integration/wizard.test.ts test/helpers/opsMock.ts test/integration/claim.test.ts test/integration/connections.test.ts test/integration/agent-runs.test.ts test/integration/private-spaces.test.ts test/integration/routes.test.ts test/integration/scheduler-routes.test.ts test/integration/schema-routes.test.ts test/integration/sources-routes.test.ts test/integration/spend.test.ts
git commit -m "fix: wizard finish pauses gbrain writers until init succeeds"
```

---

### Task 4: Contract `resetBrain()` kills in-container gbrain processes first

**Files:**
- Create: `docker/quiesce-gbrain-procs.sh`
- Create: `test/build/quiesce-gbrain-procs.test.sh`
- Modify: `docker/gbrain-base.Dockerfile` (second `COPY` next to the entrypoint copy)
- Modify: `test/helpers/stack.ts` (`resetBrain`)

**Interfaces:**
- Consumes: the gbrain-base image build from Task 1. This task adds the `COPY` that puts the script at `/opt/mobrain/quiesce-gbrain-procs.sh`.
- Produces: `resetBrain()` runs that script, then the existing `DROP SCHEMA` / home wipe. It does not start `gbrain` again. Callers already call `init` after `resetBrain()` (`test/contract/lifecycle.contract.test.ts`, `scheduler.contract.test.ts`, `runner.contract.test.ts`). Restarting inside `resetBrain()` would reopen the race.

- [ ] **Step 1: Write the failing proc-kill test**

Create `test/build/quiesce-gbrain-procs.test.sh` with LF endings:

```sh
#!/bin/sh
set -eu
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/proc/42" "$root/proc/7" "$root/proc/99"
printf 'gbrain\0jobs\0supervisor\0' > "$root/proc/42/cmdline"
printf 'sleep\0infinity\0' > "$root/proc/7/cmdline"
printf '/root/.bun/bin/gbrain\0serve\0--http\0' > "$root/proc/99/cmdline"

PROC_ROOT="$root/proc" QUIESCE_DRY_RUN=1 sh docker/quiesce-gbrain-procs.sh > "$root/out"

grep -qx 'TERM 42' "$root/out"
grep -qx 'TERM 99' "$root/out"
if grep -q 'TERM 7' "$root/out"; then
  echo "sleep was signaled" >&2
  exit 1
fi
echo "ok"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash test/build/quiesce-gbrain-procs.test.sh`

Expected: FAIL because the script is missing or does not print `TERM 42`.

- [ ] **Step 3: Implement the script and call it from `resetBrain`**

Create `docker/quiesce-gbrain-procs.sh` with LF endings:

```sh
#!/bin/sh
# Signal every gbrain process under PROC_ROOT (default /proc). The slice0
# container's pid 1 is `sleep infinity`; this must not signal it. QUIESCE_DRY_RUN=1
# prints the signals instead of sending them, which is how the host test
# avoids kill(1) against a fake pid.
set -u
PROC_ROOT=${PROC_ROOT:-/proc}
DRY=${QUIESCE_DRY_RUN:-}

is_gbrain() {
  cmd=$(tr '\0' ' ' < "$1" 2>/dev/null || true)
  case "$cmd" in
    gbrain|gbrain\ *|*/gbrain|*/gbrain\ *) return 0 ;;
    *) return 1 ;;
  esac
}

signal_term() {
  if [ "$DRY" = "1" ]; then
    echo "TERM $1"
    return 0
  fi
  kill -TERM "$1" 2>/dev/null || true
}

signal_kill() {
  if [ "$DRY" = "1" ]; then
    return 0
  fi
  kill -KILL "$1" 2>/dev/null || true
}

for dir in "$PROC_ROOT"/[0-9]*; do
  [ -f "$dir/cmdline" ] || continue
  pid=${dir##*/}
  if is_gbrain "$dir/cmdline"; then
    signal_term "$pid"
  fi
done

if [ "$DRY" = "1" ]; then
  exit 0
fi

i=0
while [ "$i" -lt 45 ]; do
  left=0
  for dir in "$PROC_ROOT"/[0-9]*; do
    [ -f "$dir/cmdline" ] || continue
    if is_gbrain "$dir/cmdline"; then
      left=1
    fi
  done
  [ "$left" -eq 0 ] && exit 0
  sleep 1
  i=$((i + 1))
done

for dir in "$PROC_ROOT"/[0-9]*; do
  [ -f "$dir/cmdline" ] || continue
  pid=${dir##*/}
  if is_gbrain "$dir/cmdline"; then
    signal_kill "$pid"
  fi
done
exit 0
```

In `docker/gbrain-base.Dockerfile`, add a second copy next to the entrypoint copy from Task 1:

```dockerfile
COPY docker/quiesce-gbrain-procs.sh /opt/mobrain/quiesce-gbrain-procs.sh
RUN chmod 0755 /opt/mobrain/quiesce-gbrain-procs.sh
```

In `test/helpers/stack.ts`, at the start of `resetBrain()`, before the `psql` `composeExec`, add:

```ts
  const stopped = await composeExec('gbrain-ops', ['sh', '/opt/mobrain/quiesce-gbrain-procs.sh'], { timeoutMs: 60_000 });
  if (stopped.exitCode !== 0) {
    throw new Error(`quiesce gbrain procs failed (${stopped.exitCode}): ${stopped.stderr}`);
  }
```

Do not add a `gbrain` start after the schema drop.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bash test/build/quiesce-gbrain-procs.test.sh`

Expected: `ok` and exit 0.

The slice0 image picks up the script on the next `compose up` because `compose/docker-compose.slice0.yml` builds `gbrain-ops` from `docker/gbrain-base.Dockerfile`. Do not run that up against project `mobrain-local`. CI's contract job builds the image before the suite; that is the end-to-end check for this task.

- [ ] **Step 5: Commit**

```bash
git add docker/quiesce-gbrain-procs.sh docker/gbrain-base.Dockerfile test/build/quiesce-gbrain-procs.test.sh test/helpers/stack.ts
git commit -m "fix: resetBrain stops in-container gbrain processes before dropping the schema"
```

---

## Self-review

Spec coverage:

- Stop writers before `resetBrainSchema()` in `/finish`: Task 3.
- Restart them only after init succeeds: Task 3 (`resume` is skipped when `initResult.ok` is false). Schema-pack apply is an argument of that same `init` call, so it is inside the pause.
- `test/helpers/stack.ts` `resetBrain()`: Task 4. Restart-after-init stays with each contract file's existing `init`, because restarting inside `resetBrain()` would reopen the window the issue describes.
- Varied failures (`schema lint`, `jobs supervisor`, `/wizard/space` 500, seam gate A1) are the cascade the issue names. Making `/finish` deterministic and making `resetBrain()` kill a live supervisor removes the shared cause. No contract assertion is weakened.
- `jobs.supervisorStop` was considered and rejected in Global Constraints because it does not stop the process that reconnects.

Placeholder scan: every new function, route, test, and shell script is written out. Task 1's image `COPY` names only the entrypoint. Task 4 adds the proc-script `COPY` in the same commit as the script.

Type consistency: `pauseBrainWriters` / `resumeBrainWriters` keep those names in `src/ops/writerGate.ts`, `src/ops/server.ts`, and `src/control/opsClient.ts`. The pause file path is `.mobrain-writers-paused` under `GBRAIN_HOME` in both the entrypoint (`MOBRAIN_GBRAIN_HOME`, default `/srv/gbrain-home`) and `pauseFilePath()`. Compose sets `GBRAIN_HOME=/srv/gbrain-home` on ops, serve, and the worker, so the defaults meet.
