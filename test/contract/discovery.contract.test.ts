import { test, expect, beforeAll, afterAll } from 'bun:test';
import { execOperation, assertOk } from '../../src/contracts/exec.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { composeUp, composeDown, composeExec, resetBrain, BRAIN_DB_URL, PIN } from '../helpers/stack.ts';

beforeAll(async () => {
  await composeUp();
  await resetBrain();
  assertOk(OPERATIONS.init!, await execOperation(OPERATIONS.init!, {
    nonInteractive: true, force: true, url: BRAIN_DB_URL,
    embeddingModel: 'openai:text-embedding-3-small',
  }, { timeoutMs: 600_000 }));
}, 900_000);
afterAll(async () => { await composeDown(); }, 120_000);

// V14: --tools-json is the public CLI tool-catalog contract.
test('--tools-json emits the tool catalog', async () => {
  const r = await composeExec('gbrain-ops', ['gbrain', '--tools-json']);
  expect(r.exitCode).toBe(0);
  const catalog = JSON.parse(r.stdout);
  expect(catalog).toBeDefined();
  const count = Array.isArray(catalog) ? catalog.length : Object.keys(catalog).length;
  expect(count).toBeGreaterThan(50);
});

// Plan defect (Work Item I): the plan's poll loop shelled out to `curl`, but
// the pinned gbrain-ops image (docker/gbrain-base.Dockerfile) only installs
// git, ca-certificates, tini and postgresql-client — no curl, no wget.
// Confirmed empirically (`which curl` / `which wget`: both absent). Rather
// than add a dependency to the already-built, already-tested Task 1 base
// image for a Task 10 probe, use bun's built-in fetch() instead — bun is
// already on PATH in this image, so this needs no image change or rebuild.
async function fetchWellKnown(): Promise<Record<string, unknown> | null> {
  const probe = await composeExec('gbrain-ops', [
    'bun', '-e',
    'const r = await fetch("http://127.0.0.1:3131/.well-known/gbrain").catch(() => null); ' +
    'if (r && r.ok) console.log(await r.text());',
  ]);
  const t = probe.stdout.trim();
  return t.startsWith('{') ? JSON.parse(t) : null;
}

/**
 * Plan defect (Work Item L): `serve.kill()` on the LOCAL `Bun.spawn`'d
 * `docker compose exec -T ... gbrain serve` process only terminates the
 * local docker-exec CLIENT — it does not propagate to the remote process
 * inside the container. `-T` (no TTY, required for headless exec per G2)
 * means docker never wires the exec session's lifetime to the client's;
 * confirmed empirically by killing the client and then scanning /proc
 * inside the container: the real `gbrain serve` process (and a worker
 * fork) were both still alive afterward. In THIS slice the leak is masked
 * — `afterAll` tears down the whole container (`compose down -v`) moments
 * later — but it is a real stray process for the lifetime in between, and
 * would be a genuine port-3131 leak against any longer-lived container.
 * Fixed by also reaping the remote process directly: scan /proc for any
 * PID (other than the scanner's own — a self-match guard, since the
 * scanner's own argv literally contains the strings "gbrain" and "serve")
 * whose cmdline contains both "gbrain" and "serve", and SIGTERM it.
 */
async function killRemoteServe(): Promise<void> {
  await composeExec('gbrain-ops', [
    'bun', '-e',
    "const fs=require('fs'); for (const pid of fs.readdirSync('/proc')) { " +
    "if (!/^[0-9]+$/.test(pid) || Number(pid) === process.pid) continue; " +
    "try { const cmd = fs.readFileSync('/proc/'+pid+'/cmdline','utf8'); " +
    "if (cmd.indexOf('gbrain') >= 0 && cmd.indexOf('serve') >= 0) process.kill(Number(pid), 'SIGTERM'); " +
    "} catch (e) {} }",
  ]);
}

// V13: GET /.well-known/gbrain returns version, profiles and adapters. The
// harness picker and profile list render FROM THIS, never hard-coded.
test('.well-known/gbrain exposes live profiles and harness adapters', async () => {
  const serve = Bun.spawn([
    'docker', 'compose', '-f', 'compose/docker-compose.slice0.yml', 'exec', '-T', 'gbrain-ops',
    'gbrain', 'serve', '--http', '--bind', '127.0.0.1', '--port', '3131',
  ], { stdout: 'pipe', stderr: 'pipe' });

  try {
    // Poll rather than sleep blindly.
    let body: Record<string, unknown> | null = null;
    for (let i = 0; i < 60; i++) {
      body = await fetchWellKnown();
      if (body) break;
      await Bun.sleep(1000);
    }
    expect(body).not.toBeNull();
    expect(body!.version).toBe(PIN);
    expect(body!.protocol).toBe('mcp');
    expect(Array.isArray(body!.adapters)).toBe(true);
    const adapters = body!.adapters as Array<Record<string, unknown>>;
    // V10: 13 adapters at v0.50.0.0.
    expect(adapters.length).toBe(13);

    // Plan defect (Work Item J): the plan grouped adapters by `.connection`
    // and asserted "four connection classes" (the assertion array itself
    // actually listed five: claude-json, codex-toml, manual, opencode-json,
    // thin-cli — an internal inconsistency in the plan text, confirmed
    // against the real type union in the reference checkout,
    // src/core/harness/registry.ts:9, which does have exactly five). But
    // NEITHER public surface exposes `connection` at all: `.well-known`'s
    // `adapters` and `gbrain mcp adapters --json` both come from
    // publicHarnessMetadata() (registry.ts:63-65), which destructures only
    // { id, label, modes, guide→documentation, evidence } — `connection` is
    // deliberately internal-only. Confirmed empirically: every adapter's
    // `.connection` here is `undefined`. G3 forbids reading gbrain internals
    // directly, so grouping by connection class is not verifiable through
    // any contract surface at this pinned version. This is a slice-defining
    // finding: Slice 1's harness picker cannot render a connection-mechanism
    // grouping from live `.well-known` data as the roadmap assumed — that
    // would need either a hardcoded table on our side (defeats "renders FROM
    // THIS, never hard-coded") or an upstream change. Asserting the adapter
    // ID set instead, which still catches the registry drift V10 exists to
    // catch, and is actually observable.
    const ids = (adapters.map((a) => a.id) as string[]).sort();
    expect(ids).toEqual([
      'chatgpt', 'claude-code', 'claude-desktop', 'codex', 'cursor', 'generic',
      'grok-bot', 'grok-build', 'muse', 'muse-code', 'openclaw', 'opencode', 'perplexity',
    ]);
    expect(body!.profiles).toBeDefined();
  } finally {
    // Work Item L: kill both the local client AND the remote process it
    // does not actually control — see killRemoteServe's doc comment.
    serve.kill();
    await killRemoteServe();
  }
}, 180_000);

// V10: never promise auto-install for a manual-class adapter.
// Plan defect (Work Item M): the original raw argv was `['sh', '-c', 'gbrain
// mcp grant --help 2>&1 || true']` — a shell string invoking `gbrain`, which
// this repo's own `bun run lint:forbidden` (G2: argv arrays, never shell
// strings) correctly rejects. `--help` prints via `console.log` (`runMcp`,
// src/commands/mcp.ts), i.e. stdout, so no `2>&1` merge is needed; a plain
// argv array works and stays lint-clean.
test('hermes is absent and generic is the manual path for it', async () => {
  const probe = await composeExec('gbrain-ops', ['gbrain', 'mcp', 'grant', '--help']);
  expect((probe.stdout + probe.stderr).toLowerCase()).not.toContain('hermes');
});

// Plan defect (Work Item K): `schema list`'s handler ignores its args
// entirely (`function runList(_args: string[]): void`, src/commands/
// schema.ts — the leading underscore marks it unused) and always prints
// human prose ("Bundled packs:" + one name per line), regardless of --json.
// Confirmed empirically: `gbrain schema list --json` emits plain text.
// Fixed supportsJson to false on the registry entry and asserted the stable
// prose instead — the same non-JSON-command pattern Task 6 hit with
// `config show` (Work Item C).
test('schema list enumerates bundled packs', async () => {
  const spec = OPERATIONS['schema.list']!;
  const r = await execOperation(spec, {});
  assertOk(spec, r);
  expect(r.stdout).toContain('Bundled packs:');
  expect(r.stdout).toContain('gbrain-base');
});

test('sources list --json is parseable', async () => {
  const spec = OPERATIONS['sources.list']!;
  const r = await execOperation(spec, {}, { json: true });
  assertOk(spec, r);
  expect(r.json).not.toBeNull();
});
