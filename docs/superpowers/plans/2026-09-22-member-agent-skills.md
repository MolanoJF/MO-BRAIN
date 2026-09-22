# Member Agent Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A member's agent, connected through a Mobrain Connection, can discover and load gbrain's prose skills over MCP (`list_skills` / `get_skill`) with nothing installed on the member's machine.

**Architecture:** gbrain serves skills over MCP when `mcp.publish_skills` is on (`gbrain init` defaults it on) **and** the serving host resolves a skills directory. For remote MCP callers gbrain deliberately never serves its own bundled dev catalog (`skill-catalog.ts` trust boundary), so a hosted brain with no `$GBRAIN_SKILLS_DIR` / `mcp.skills_dir` / repo `skills/RESOLVER.md` returns `storage_error` — measured on the pin (Task 1, `docs/member-skills-findings.md`). Given a catalog, the remaining blocker is the MCP **surface**: every Connection compiles to `starter`, which does not expose `list_skills`/`get_skill`, and because Mobrain sets it as operator, `request_tools` cannot widen it. So this plan (0) provisions a Mobrain-owned host skills catalog, (1) proves the mechanism on the pinned binary, (2) compiles member Connections to surface `full` and applies it at mint time, (3) backfills live Connections, and (4) tells the member in the wiring snippet, gated on a live readback of `mcp.publish_skills`.

**Tech Stack:** Bun + TypeScript, Hono control plane, drizzle/Postgres, gbrain `0.50.5.0` driven through the `gbrain-ops` RPC allowlist (`callOps`), React console.

**Spec:** The design pasted into the 2026-09-22 session ("skill delivery for new/invited Mobrain members"), **as corrected by § Design corrections below**. No spec file was written. If one is wanted, write `docs/superpowers/specs/2026-09-22-member-agent-skills-design.md` from this plan's Architecture + Design corrections sections.

## Design corrections (measured against code, 2026-09-22)

The original design would not have worked as written. These corrections are the actual basis for this plan:

| Design claim | Reality | Evidence |
|---|---|---|
| Members can load skills once `mcp.publish_skills` is on | Publishing is necessary but **not sufficient**: remote callers resolve a host skills dir via `autoDetectSkillsDir` (no `install_path` tier); with none present `list_skills` returns `storage_error` | `test/contract/member-skills.contract.test.ts` (measured); `gbrain/src/core/skill-catalog.ts` `resolveSkillsDir` |
| Mobrain must flip `mcp.publish_skills` on in install/upgrade | `gbrain init` already writes `mcp: { publish_skills: true }` | `gbrain/src/commands/init.ts:1360,1700`; observed in `docs/slice-3.5-findings.md:703` |
| Members can call `get_skill` once publishing is on | Connections compile to surface `starter`; `get_skill`/`list_skills` are not in `STARTER_OPS`; an operator-set surface blocks `request_tools` widening | `src/contracts/compile.ts:78`; `gbrain/src/mcp/surface.ts:88`; `gbrain/src/core/ops/request-tools.ts:208` |
| `wiringSnippet()` runs `gbrain skillpack scaffold --stub` | `wiringSnippet()` is a pure string function rendered in the browser (`Claim.tsx:91`, `Connection.tsx:168`); it executes nothing | `src/control/harness.ts:53` |
| `--stub` scaffold works on a member's machine | Stub preflight reads `mcp.publish_skills` and the skills dir from the **local** brain config and exits 2 without one. A member laptop has no local brain | `gbrain/src/commands/skillpack/harness.ts:256-300` |
| Add a `mobrain-member` persona to `plugin-lanes.json` | That file is upstream gbrain (image installs `github:garrytan/gbrain#v<pin>`). A persona only curates what scaffold installs, not what `get_skill` serves | `docker/gbrain-base.Dockerfile:15`; `gbrain/src/core/skillpack/personas.ts:1-20` |
| Host-only skills are excluded per RBAC | `get_skill` serves the whole host catalog; RBAC is enforced at **tool dispatch** by the grant profile's scopes and reported per skill as `unavailable_tools` | `contracts/v0.50.5.0/capability.json:1144-1161` |

**Deferred (not in this plan):**
- Stub skill files for warm discovery in claude-code. This needs an upstream gbrain change so stub preflight can target a remote brain.
- A Mobrain vocabulary addendum skill. The right vehicle is a brain-resident skillpack (`skillpack.json` with `brain_resident: true` at a Space source's repo root, served per source by `list_brain_skillpack`/`get_skill {source}`). Seeding pack files into every member's knowledge repo is its own design decision.
- The auto-install snippet text "gbrain mcp grant already wrote this adapter's config" is suspect: the grant runs inside `gbrain-ops`, not on the member's machine. It is unchanged here and should be filed separately.
- Run tokens (`src/agent/token.ts`) stay on their persisted surface. The runner's tool list is curated by `PRODUCT_TOOL_ALLOWLIST`.

## Global Constraints

- gbrain pin: `GBRAIN_VERSION=0.50.5.0`. Contract tests run against it.
- Every gbrain interaction goes through a registered operation in `src/contracts/registry.ts` via `callOps`. No new registry entries are needed: `auth.rescopeClient` already carries `--surface`, and `config.get` exists.
- Never report skills as available without a readback. `mcp.publish_skills` is read live with `config.get`. An unreadable or absent value counts as **off** (fail closed).
- D8 pairing: a Connection's member client and server client always carry identical compiled scoping, surface included.
- A client minted and then left half-configured must be revoked, never left live (the existing compensation pattern in `provisionConnection`).
- Any module that `test/integration/*` mocks (`src/control/opsClient.ts`) must not gain exports in this plan. New helpers go in new modules that import `callOps`.
- With `skills` false or omitted, `wiringSnippet` output must be byte-identical to today's.
- Host skills catalog: the serving gbrain must resolve a skills dir, or `list_skills` returns `storage_error` (Task 0). Mobrain ships repo-root `skills/` and mounts it read-only at `/opt/mobrain-skills`, exported as `$GBRAIN_SKILLS_DIR` in the containers that resolve skills. This is an operator opt-in alongside `mcp.publish_skills`. Never point it at gbrain's bundled catalog — a hosted brain must not serve upstream dev skills.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `skills/RESOLVER.md` | Mobrain-owned host skills catalog root (Task 0) | Create |
| `skills/query/SKILL.md` | First published skill; the contract test asserts it (Task 0) | Create |
| `compose/docker-compose.yml` | Mount `skills/` + set `GBRAIN_SKILLS_DIR` on `gbrain-serve` (Task 0) | Modify |
| `compose/docker-compose.slice0.yml` | Same on `gbrain-ops`, the contract-test target (Task 0) | Modify |
| `compose/docker-compose.dev.yml` | Same, only if it redefines `gbrain-serve`/`gbrain-ops` (Task 0) | Modify (if present) |
| `test/contract/member-skills.contract.test.ts` | Live proof on the pinned binary: publish default, starter hides skills, full exposes them, profile scopes still deny admin ops | Create |
| `docs/member-skills-findings.md` | Measured numbers from the contract test (tool counts, denial shape) | Create |
| `src/contracts/compile.ts` | Member Connections compile to surface `full` | Modify `:76-78` |
| `test/unit/compile.test.ts` | Pin the new surface | Modify `:205-208` |
| `src/control/connections.ts` | Apply compiled surface to freshly minted clients; backfill live Connections | Modify `provisionConnection`, `provisionServerClient`; add `widenConnectionSurfaces` |
| `test/integration/connections.test.ts` | Surface applied at mint, compensation on failure, backfill | Modify |
| `scripts/widen-member-surfaces.ts` | One-shot operator entrypoint for the backfill | Create |
| `src/control/configValue.ts` | `readConfigValue(key)`, moved out of `routes/schema.ts` so claim can use it | Create |
| `src/control/routes/schema.ts` | Import `readConfigValue` instead of defining it | Modify `:198-212` |
| `src/control/claim.ts` | `ClaimResult.skillsPublished` from a live readback | Modify |
| `test/integration/claim.test.ts` | Readback true/false/unreadable | Modify |
| `src/control/harness.ts` | `wiringSnippet(id, creds, { skills })` appends the skills paragraph | Modify `:53-77` |
| `test/unit/harness.test.ts` | Skills paragraph present only when asked; byte-identical otherwise | Modify |
| `src/console/pages/Claim.tsx` | Pass `skillsPublished` into the snippet | Modify |
| `docs/runbooks/upgrade.md` | One step: run the backfill once after deploying this change | Modify |

---

### Task 0: Provision the Mobrain host skills catalog (prerequisite)

Task 1 measured that the `full` surface exposes `list_skills`/`get_skill`, but the call fails with `storage_error: No skills directory found on the server host.` For remote MCP callers gbrain resolves a host skills dir via `autoDetectSkillsDir` and deliberately never serves the image's bundled catalog. Mobrain must own and mount one. This task ships a minimal catalog and points the containers at it. It changes no `src/`.

**Files:**
- Create: `skills/RESOLVER.md`
- Create: `skills/query/SKILL.md`
- Modify: `compose/docker-compose.yml` (`gbrain-serve`)
- Modify: `compose/docker-compose.slice0.yml` (`gbrain-ops`)
- Modify: `compose/docker-compose.dev.yml` (only if it redefines `gbrain-serve`/`gbrain-ops`)
- Modify: `docs/member-skills-findings.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `$GBRAIN_SKILLS_DIR=/opt/mobrain-skills`, a read-only mount of repo-root `skills/`, present in every container that resolves skills. No `mcp.skills_dir` DB write.

- [ ] **Step 1: Author the catalog**

Create `skills/RESOLVER.md`:

```markdown
# Mobrain Skill Resolver

Skills are prose instruction sets the member's agent loads over MCP. This file
is the human-readable dispatch map; each skill's frontmatter `triggers:` is the
authoritative routing signal.

| Trigger | Skill |
|---------|-------|
| "what do we know about", "tell me about", "look up", "search for", "who is" | `skills/query/SKILL.md` |
```

Create `skills/query/SKILL.md`. This is Mobrain's own skill — do not copy gbrain's bundled content:

```markdown
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
```

The manifest is derived by walking `<skillsDir>/<dir>/SKILL.md` (`skill-manifest.ts` `deriveManifest`), so no `manifest.json` is needed.

- [ ] **Step 2: Mount the catalog and set the env**

Compose resolves relative host paths against the compose file's directory (`compose/`), so the mount is `../skills`.

In `compose/docker-compose.yml`, on the `gbrain-serve` service (around `:60-76`), add to `volumes`:

```yaml
      - ../skills:/opt/mobrain-skills:ro
```

and to `environment`:

```yaml
      GBRAIN_SKILLS_DIR: /opt/mobrain-skills
```

Do the same on `gbrain-ops` in `compose/docker-compose.slice0.yml` (the container the contract test runs `gbrain serve` inside). Check `compose/docker-compose.dev.yml` with `grep -n "gbrain-serve\|gbrain-ops" compose/docker-compose.dev.yml`; if it redefines either service's `volumes`/`environment`, mirror the addition there so the dev stack also resolves skills.

- [ ] **Step 3: Re-run the contract test**

Run: `bun test test/contract/member-skills.contract.test.ts` (10–15 min; the stack recreates on the config change). Expected: all four pass. If (c) still fails, check inside the container: `docker compose -f compose/docker-compose.slice0.yml exec gbrain-ops printenv GBRAIN_SKILLS_DIR` and `... exec gbrain-ops ls /opt/mobrain-skills`.

- [ ] **Step 4: Record the re-run**

In `docs/member-skills-findings.md`, flip the gate verdict to PASS, update row (c) to pass with the measured `full` tool count and `list_skills` byte count, and add a short "Catalog provisioning" section stating the mount/env and that the catalog is Mobrain-owned (repo `skills/`), not gbrain's bundled catalog.

- [ ] **Step 5: Commit**

```bash
git add skills compose/docker-compose.yml compose/docker-compose.slice0.yml compose/docker-compose.dev.yml docs/member-skills-findings.md
git commit -m "feat(skills): provision the Mobrain host skills catalog so members can load skills over MCP"
```

---

### Task 1: Contract proof on the pinned binary (decision gate)

Every later task assumes four facts about gbrain 0.50.5.0. This task measures them and doesn't change product code.

**Gate:** if assertion (c) or (d) fails, **stop** and report back with the findings doc. Tasks 2–6 are wrong if `full` does not expose skills, or if `full` lets a memory-writer call admin ops.

**Files:**
- Create: `test/contract/member-skills.contract.test.ts`
- Create: `docs/member-skills-findings.md`

**Interfaces:**
- Consumes: `execOperation`, `assertOk` (`src/contracts/exec.ts`); `OPERATIONS` (`src/contracts/registry.ts`); `composeUp`, `composeDown`, `composeExec`, `resetBrain`, `seedGitSource`, `BRAIN_DB_URL` (`test/helpers/stack.ts`).
- Produces: measured facts only. No exports.

- [ ] **Step 1: Write the contract test**

```ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { execOperation, assertOk } from '../../src/contracts/exec.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { composeUp, composeDown, composeExec, resetBrain, seedGitSource, BRAIN_DB_URL } from '../helpers/stack.ts';

/**
 * Member skill delivery rests on four facts at the pin, proven here:
 *  (a) `init` leaves mcp.publish_skills on;
 *  (b) a memory-writer client on the compiled `starter` surface cannot see
 *      list_skills/get_skill;
 *  (c) rescoped to `full`, the same client lists and fetches skills;
 *  (d) on `full`, the memory-writer profile still cannot call an admin op.
 * The slice0 stack has no gbrain-serve, so serve runs inside gbrain-ops on
 * loopback, the pattern discovery.contract.test.ts uses.
 */

const MCP_URL = 'http://127.0.0.1:3131/mcp';
const CREDS = '/srv/gbrain-home/.creds-member-skills.json';
let serve: ReturnType<typeof Bun.spawn> | null = null;
let clientId = '';
let token = '';

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

/** One JSON-RPC call from inside gbrain-ops (serve is bound to its loopback). */
async function mcp(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const script =
    `const r = await fetch(${JSON.stringify(MCP_URL)}, { method: 'POST', headers: {` +
    ` authorization: 'Bearer ' + process.env.T, 'content-type': 'application/json',` +
    ` accept: 'application/json, text/event-stream' }, body: ${JSON.stringify(body)} });` +
    ` console.log(await r.text());`;
  const r = await composeExec('gbrain-ops', ['bun', '-e', script], { env: { T: token } });
  const text = r.stdout.trim();
  const frame = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('data:')).pop();
  return JSON.parse(frame ? frame.slice(5).trim() : text) as Record<string, unknown>;
}

async function toolNames(): Promise<string[]> {
  const msg = await mcp('tools/list', {});
  const tools = ((msg.result as { tools?: Array<{ name: string }> })?.tools) ?? [];
  return tools.map((t) => t.name);
}

beforeAll(async () => {
  await composeUp();
  await resetBrain();
  assertOk(OPERATIONS.init!, await execOperation(OPERATIONS.init!, {
    nonInteractive: true, force: true, url: BRAIN_DB_URL,
    embeddingModel: 'openai:text-embedding-3-small',
  }, { timeoutMs: 600_000 }));
  await seedGitSource('customers');
  assertOk(OPERATIONS['sources.add']!, await execOperation(OPERATIONS['sources.add']!, {
    id: 'customers', path: '/srv/brain-repos/customers',
  }));

  const grant = await execOperation(OPERATIONS['mcp.grant']!, {
    name: 'member-skills-probe', harness: 'claude-code', profile: 'memory-writer',
    source: 'customers', url: MCP_URL, credentialsOut: CREDS,
  }, { json: true });
  assertOk(OPERATIONS['mcp.grant']!, grant);
  clientId = String((grant.json as { client_id?: string }).client_id);
  const handoff = await composeExec('gbrain-ops', ['cat', CREDS]);
  token = String((JSON.parse(handoff.stdout) as { access_token?: string }).access_token);
  expect(token.length).toBeGreaterThan(0);

  serve = Bun.spawn([
    'docker', 'compose', '-f', 'compose/docker-compose.slice0.yml', 'exec', '-T', 'gbrain-ops',
    'gbrain', 'serve', '--http', '--bind', '127.0.0.1', '--port', '3131',
  ], { stdout: 'pipe', stderr: 'pipe' });
  for (let i = 0; i < 60; i++) {
    const r = await composeExec('gbrain-ops', ['bun', '-e',
      `const r = await fetch('http://127.0.0.1:3131/.well-known/gbrain').catch(() => null); process.exit(r && r.ok ? 0 : 1);`]);
    if (r.exitCode === 0) break;
    await Bun.sleep(1000);
  }
}, 900_000);

afterAll(async () => {
  serve?.kill();
  await killRemoteServe();
  await composeDown();
}, 120_000);

test('(a) init leaves mcp.publish_skills on', async () => {
  const r = await execOperation(OPERATIONS['config.get']!, { key: 'mcp.publish_skills' });
  assertOk(OPERATIONS['config.get']!, r);
  const line = r.stdout.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('[config]'));
  expect(line).toBe('true');
});

test('(b) the compiled starter surface hides list_skills and get_skill', async () => {
  const names = await toolNames();
  console.log(`[member-skills] starter tools/list count=${names.length}`);
  expect(names).not.toContain('list_skills');
  expect(names).not.toContain('get_skill');
});

test('(c) rescoped to full, the member lists and fetches skills', async () => {
  // Full re-statement of scoping, exactly what rescopeParams() sends.
  const rs = await execOperation(OPERATIONS['auth.rescopeClient']!, {
    id: clientId, source: 'customers', profile: 'memory-writer', surface: 'full',
    federatedRead: '', boundSlugPrefixes: 'none',
  }, { json: true });
  assertOk(OPERATIONS['auth.rescopeClient']!, rs);

  const names = await toolNames();
  console.log(`[member-skills] full tools/list count=${names.length}`);
  expect(names).toContain('list_skills');
  expect(names).toContain('get_skill');

  const listed = await mcp('tools/call', { name: 'list_skills', arguments: {} });
  expect(listed.error).toBeUndefined();
  const listText = JSON.stringify(listed.result);
  console.log(`[member-skills] list_skills bytes=${listText.length}`);
  expect(listText).toContain('query');

  const got = await mcp('tools/call', { name: 'get_skill', arguments: { name: 'query' } });
  expect(got.error).toBeUndefined();
  expect(JSON.stringify(got.result)).toContain('body');
});

test('(d) on full, memory-writer scopes still deny an admin op', async () => {
  const r = await mcp('tools/call', {
    name: 'sources_add', arguments: { id: 'escape', path: '/tmp/escape' },
  });
  const denied = r.error !== undefined
    || (r.result as { isError?: boolean } | undefined)?.isError === true;
  console.log(`[member-skills] sources_add as memory-writer: ${JSON.stringify(r).slice(0, 300)}`);
  expect(denied).toBe(true);
});
```

- [ ] **Step 2: Run it**

Run: `bun test test/contract/member-skills.contract.test.ts`
Expected: all four pass. Copy the four `[member-skills]` log lines into your notes.

If (c) fails because `auth rescope-client` rejects one of the re-stated flags, retry with only `{ id, surface: 'full' }`. If that passes, record it in the findings doc and use `{ id, surface }` as `applySurface`'s params in Task 3 (not `rescopeParams`). If (c) or (d) still fails, **stop and report.**

> **Measured 2026-09-22 (first run):** the full re-statement was rejected with `Invalid client grant: read_source_inactive`; only `{ id, surface: 'full' }` succeeded. The grant receipt field at the pin is `grant.json.grant.clientId`, not `grant.json.client_id`. The committed `test/contract/member-skills.contract.test.ts` already reflects both corrections; Task 3 uses `{ id, surface }`. When Task 0 lands, (c) must pass without further test edits.

- [ ] **Step 3: Record findings**

Create `docs/member-skills-findings.md`:

```markdown
# Member skills — measured at gbrain 0.50.5.0

Source: `test/contract/member-skills.contract.test.ts`, run <date>.

| Fact | Result |
|---|---|
| (a) `init` leaves `mcp.publish_skills` = `true` | <pass/fail> |
| (b) starter `tools/list` count; skills hidden | <n>; <pass/fail> |
| (c) full `tools/list` count; `list_skills` bytes; `get_skill query` ok | <n>; <bytes>; <pass/fail> |
| (d) `sources_add` as memory-writer on full is denied | <pass/fail>; shape: <error snippet> |
| Rescope params that worked | full `rescopeParams` / `{ id, surface }` only |

Consequence: member Connections compile to `full`. Callable scope is still
bounded by the grant profile (d). The cost is tool-list size (b → c).
```

Fill in every `<…>` with the measured value.

- [ ] **Step 4: Commit**

```bash
git add test/contract/member-skills.contract.test.ts docs/member-skills-findings.md
git commit -m "test(contract): prove member skill serving needs the full surface, and full keeps profile scopes"
```

---

### Task 2: Member Connections compile to surface `full`

**Files:**
- Modify: `src/contracts/compile.ts:76-78`
- Test: `test/unit/compile.test.ts:205-208`

**Interfaces:**
- Consumes: nothing new.
- Produces: `compileConnection(...).surface === 'full'` for every role. Task 3 relies on it through `rescopeParams(clientId, compiled)`, which already forwards `compiled.surface`.

- [ ] **Step 1: Change the unit test to the new truth**

Replace the test at `test/unit/compile.test.ts:205-208`:

```ts
  // Member skills: list_skills/get_skill are not in gbrain's STARTER_OPS, and
  // an operator-set surface blocks request_tools widening, so a Connection
  // must be minted at `full`. The grant profile's scopes still bound what is
  // callable (docs/member-skills-findings.md, fact d).
  test('surface is full for every reachable profile', () => {
    for (const role of ROLES) expect(compile(role).surface).toBe('full');
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test test/unit/compile.test.ts`
Expected: FAIL. `expected 'full', received 'starter'`.

- [ ] **Step 3: Implement**

In `src/contracts/compile.ts`, replace lines 76-78:

```ts
    // Member skills: `full`, not the profile's `starter` default —
    // list_skills/get_skill are outside STARTER_OPS. Scopes still come from
    // the profile (docs/member-skills-findings.md). Applied by
    // auth.rescopeClient, since mcp grant takes no --surface.
    surface: 'full',
```

- [ ] **Step 4: Run it to see it pass**

Run: `bun test test/unit/compile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/compile.ts test/unit/compile.test.ts
git commit -m "feat(compile): member Connections compile to the full MCP surface"
```

---

### Task 3: Apply the compiled surface at mint, and backfill live Connections

`mcp grant` has no `--surface`, so a freshly minted client comes out at the profile default (`starter`). The existing rescope path already sends `compiled.surface`. New mints need the same call right after the grant. Live Connections minted before this change need a one-shot backfill.

**Files:**
- Modify: `src/control/connections.ts` (`provisionConnection` new-grant branch ~`:139-167`; `provisionServerClient` ~`:195-220`; new export `widenConnectionSurfaces`)
- Create: `scripts/widen-member-surfaces.ts`
- Modify: `docs/runbooks/upgrade.md`
- Test: `test/integration/connections.test.ts`

**Interfaces:**
- Consumes: `compileConnection(...).surface === 'full'` (Task 2). The admin move path keeps using the existing private `rescopeParams(clientId, compiled)` (`connections.ts:478`); the mint/backfill surface call sends `{ id, surface }`, because the full re-statement is rejected by the pin (Task 1, measured).
- Produces:
  - `async function applySurface(clientId: string, compiled: CompiledConnection): Promise<void>` (module-private; throws `auth.rescopeClient (surface) failed (exit N)`).
  - `export async function widenConnectionSurfaces(actor: string): Promise<{ widened: string[]; failed: Array<{ connectionId: string; error: string }> }>`.

- [ ] **Step 1: Write the failing integration tests**

Append inside `describe('provisionConnection', …)` in `test/integration/connections.test.ts`:

```ts
  test('a new mint applies the compiled full surface to BOTH clients', async () => {
    await provisionConnection(input(), actor);

    const rescopes = calls.filter((c) => c.op === 'auth.rescopeClient');
    expect(rescopes.map((c) => c.params?.id).sort()).toEqual(['gbrain_cl_mock', 'gbrain_cl_mock_1']);
    for (const r of rescopes) {
      expect(r.params?.surface).toBe('full');
      expect(r.opts?.dryRun).not.toBe(true);
    }
  });

  test('a failed member surface rescope revokes both minted clients', async () => {
    callOpsHandler = async (op, params, opts) => {
      if (op === 'auth.rescopeClient' && params?.id === 'gbrain_cl_mock') {
        return {
          ok: false, exitCode: 1, argv: ['gbrain', 'auth', 'rescope-client'],
          stdout: '', stderr: 'boom', json: null,
        };
      }
      return defaultOk(op, opts);
    };

    let err: unknown;
    try { await provisionConnection(input(), actor); } catch (e) { err = e; }
    expect(String(err)).toMatch(/surface/);

    const revoked = calls.filter((c) => c.op === 'auth.revokeClient').map((c) => c.params?.clientId);
    expect(revoked.sort()).toEqual(['gbrain_cl_mock', 'gbrain_cl_mock_1']);
    const [row] = await getDb().select().from(schema.connections)
      .where(eq(schema.connections.organizationId, orgId));
    expect(row?.state).toBe('pending');
  });

  test('a failed server surface rescope revokes the server client and the member client', async () => {
    callOpsHandler = async (op, params, opts) => {
      if (op === 'auth.rescopeClient' && params?.id === 'gbrain_cl_mock_1') {
        return {
          ok: false, exitCode: 1, argv: ['gbrain', 'auth', 'rescope-client'],
          stdout: '', stderr: 'boom', json: null,
        };
      }
      return defaultOk(op, opts);
    };

    let err: unknown;
    try { await provisionConnection(input(), actor); } catch (e) { err = e; }
    expect(String(err)).toMatch(/surface/);
    const revoked = calls.filter((c) => c.op === 'auth.revokeClient').map((c) => c.params?.clientId);
    expect(revoked.sort()).toEqual(['gbrain_cl_mock', 'gbrain_cl_mock_1']);
  });
```

Add a new describe block after `describe('provisionConnection', …)`. Also add `widenConnectionSurfaces` to the destructured `await import('../../src/control/connections.ts')` at the top of the file.

```ts
describe('widenConnectionSurfaces', () => {
  test('rescopes both clients of every active Connection to full and skips the rest', async () => {
    const active = await insertConnection('active');
    await getDb().update(schema.connections)
      .set({ serverClientId: 'gbrain_cl_live_server' })
      .where(eq(schema.connections.id, active.id));
    await insertConnection('revoked', { clientName: 'bs-revoked-x', gbrainClientId: 'gbrain_cl_dead' });

    const out = await widenConnectionSurfaces(actor);

    expect(out.widened).toEqual([active.id]);
    expect(out.failed).toEqual([]);
    const rescopes = calls.filter((c) => c.op === 'auth.rescopeClient');
    expect(rescopes.map((c) => c.params?.id)).toEqual(['gbrain_cl_live_server', 'gbrain_cl_live']);
    expect(rescopes.every((c) => c.params?.surface === 'full')).toBe(true);
    const audits = await getDb().select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'connection.widen_surface'));
    expect(audits.map((a) => a.target)).toEqual([active.id]);
  });

  test('one failing Connection is reported and does not stop the rest', async () => {
    const a = await insertConnection('active', { clientName: 'bs-a', gbrainClientId: 'gbrain_cl_a' });
    const b = await insertConnection('active', { clientName: 'bs-b', gbrainClientId: 'gbrain_cl_b' });
    callOpsHandler = async (op, params, opts) => {
      if (op === 'auth.rescopeClient' && params?.id === 'gbrain_cl_a') {
        return { ok: false, exitCode: 1, argv: [], stdout: '', stderr: 'gone', json: null };
      }
      return defaultOk(op, opts);
    };

    const out = await widenConnectionSurfaces(actor);
    expect(out.widened).toEqual([b.id]);
    expect(out.failed.map((f) => f.connectionId)).toEqual([a.id]);
  });
});
```

`insertConnection` returns `{ id }`. Confirm at `test/integration/connections.test.ts:~160` and adapt the accessor if it returns a different shape. Keep the assertions the same.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/integration/connections.test.ts`
Expected: the 5 new tests FAIL (no rescope on mint; `widenConnectionSurfaces` is not a function). Existing tests still pass.

- [ ] **Step 3: Implement `applySurface` and wire it into both mints**

In `src/control/connections.ts`, next to `rescopeParams`:

```ts
/**
 * `mcp grant` takes no --surface, so a fresh client comes out at its
 * profile's default (`starter`). Apply the compiled surface right after the
 * mint. MEASURED: the full re-statement is rejected (`read_source_inactive`);
 * `{ id, surface }` alone works and leaves the mint-time scoping intact, so
 * D8 holds (both clients were compiled identically at mint). See
 * docs/member-skills-findings.md.
 */
async function applySurface(clientId: string, compiled: CompiledConnection): Promise<void> {
  const r = await callOps('auth.rescopeClient', { id: clientId, surface: compiled.surface }, { json: true });
  if (!r.ok) throw new Error(`auth.rescopeClient (surface) failed (exit ${r.exitCode})`);
}
```

In `provisionServerClient`, after `const clientId = grantedClientId(r.json);`:

```ts
  try {
    await applySurface(clientId, compiled);
  } catch (e) {
    try {
      await callOps('auth.revokeClient', { clientId });
    } catch {
      // Best-effort; the caller revokes the member client and rethrows.
    }
    throw e;
  }
```

In `provisionConnection`'s new-grant branch, replace the existing `let serverClientId` / `try { … } catch` block with two tries. A server-client failure keeps today's behaviour (revoke the member client). A member-surface failure revokes both, because the server client already exists by then:

```ts
  let serverClientId: string;
  try {
    serverClientId = await provisionServerClient(
      connectionId, input.organizationId, name, input.harness, compiled,
    );
  } catch (e) {
    try { await callOps('auth.revokeClient', { clientId: gbrainClientId }); } catch { /* operator signal is the throw */ }
    throw e;
  }
  try {
    await applySurface(gbrainClientId, compiled);
  } catch (e) {
    for (const id of [gbrainClientId, serverClientId]) {
      try { await callOps('auth.revokeClient', { clientId: id }); } catch { /* operator signal is the throw */ }
    }
    throw e;
  }
```

Keep the existing comment ("Half a Connection is worse than none…") on the first catch.

Order check against the tests: the server-surface test fails inside `provisionServerClient`, which revokes `gbrain_cl_mock_1`, then the first outer catch revokes `gbrain_cl_mock`. Both appear. The member-surface test gets past `provisionServerClient`, fails `applySurface(gbrain_cl_mock)`, and revokes both.

- [ ] **Step 4: Implement `widenConnectionSurfaces`**

Append to `src/control/connections.ts`:

```ts
/**
 * One-shot backfill: Connections minted before member skills sit at
 * `starter`. Re-derive each active Connection's compiled scoping and rescope
 * both clients (server first, D8). Per-row failures are collected, not
 * thrown, so one dead client never blocks the rest.
 */
export async function widenConnectionSurfaces(actor: string): Promise<{
  widened: string[];
  failed: Array<{ connectionId: string; error: string }>;
}> {
  const rows = await getDb().select().from(schema.connections)
    .where(eq(schema.connections.state, 'active'));
  const widened: string[] = [];
  const failed: Array<{ connectionId: string; error: string }> = [];
  for (const row of rows) {
    try {
      if (!row.gbrainClientId) throw new Error('active Connection has no gbrainClientId');
      const { write, reads } = await loadSpaces(
        row.organizationId, row.writeSpaceId, asStringArray(row.readSpaceIds),
      );
      const compiled = compileFrom(connectionInputFromRow(row), write, reads);
      if (row.serverClientId) await applySurface(row.serverClientId, compiled);
      await applySurface(row.gbrainClientId, compiled);
      await audit(row.organizationId, actor, 'connection.widen_surface', row.id, {
        surface: compiled.surface, clientId: row.gbrainClientId, serverClientId: row.serverClientId,
      });
      widened.push(row.id);
    } catch (e) {
      failed.push({ connectionId: row.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { widened, failed };
}
```

`compileFrom` takes a `ConnectionInput`. If `connections.ts` has no row→input helper, add one next to `compileFrom`:

```ts
function connectionInputFromRow(row: typeof schema.connections.$inferSelect): ConnectionInput {
  return {
    organizationId: row.organizationId,
    membershipId: row.membershipId,
    writeSpaceId: row.writeSpaceId,
    readSpaceIds: asStringArray(row.readSpaceIds),
    harness: row.harness,
    memberRole: roleForProfile(row.profile),
    connectionId: row.id,
    boundSlugPrefixes: Array.isArray(row.boundSlugPrefixes) ? asStringArray(row.boundSlugPrefixes) : undefined,
    tokenTtl: row.tokenTtl,
    budgetUsdPerDay: row.budgetUsdPerDay != null ? Number(row.budgetUsdPerDay) : undefined,
  };
}
```

Before adding it: `grep -n "asStringArray\|function audit\|memberRole" src/control/connections.ts`. Reuse any existing helper of the same purpose. If `memberRole` is resolved from `memberships` elsewhere in this file (e.g. inside `assertMembership`), load it the same way instead of adding `roleForProfile`.

- [ ] **Step 5: Run the tests**

Run: `bun test test/integration/connections.test.ts`
Expected: all PASS, old and new. If `a rescope moves BOTH clients` or `rescope never requests --dry-run` now count extra rescopes, the extra calls come from their setup mint. Reset `calls.length = 0` after setup, as `a rescope moves BOTH` already does. Don't loosen assertions.

- [ ] **Step 6: Operator entrypoint + runbook**

Create `scripts/widen-member-surfaces.ts`:

```ts
#!/usr/bin/env bun
/**
 * One-shot: rescope every active Connection to its compiled surface (`full`),
 * so members minted before member skills can reach list_skills/get_skill.
 * Run inside the control-plane container. Idempotent: safe to re-run.
 */
import { widenConnectionSurfaces } from '../src/control/connections.ts';
import { closeDb } from '../src/control/db/client.ts';

const out = await widenConnectionSurfaces('system:widen-member-surfaces');
console.log(JSON.stringify(out, null, 2));
await closeDb();
process.exit(out.failed.length > 0 ? 1 : 0);
```

In `docs/runbooks/upgrade.md`, add a step in the post-deploy section (find it with `grep -n "^## " docs/runbooks/upgrade.md`):

```markdown
### Member skills backfill (once, for the release that ships member skills)

    docker compose -f compose/docker-compose.yml exec control-plane bun run scripts/widen-member-surfaces.ts

Exit 0: every active Connection now serves `list_skills`/`get_skill`. Exit 1:
the JSON lists each failed Connection. Re-run after fixing (idempotent).
```

- [ ] **Step 7: Commit**

```bash
git add src/control/connections.ts test/integration/connections.test.ts scripts/widen-member-surfaces.ts docs/runbooks/upgrade.md
git commit -m "feat(connections): apply the compiled surface at mint, and backfill live Connections"
```

---

### Task 4: Live `publish_skills` readback on claim

**Files:**
- Create: `src/control/configValue.ts`
- Modify: `src/control/routes/schema.ts:198-212` (remove the local `readConfigValue`, import it)
- Modify: `src/control/claim.ts` (`ClaimResult`, end of `claim`)
- Test: `test/integration/claim.test.ts`

**Interfaces:**
- Consumes: `callOps` (`src/control/opsClient.ts`).
- Produces:
  - `export async function readConfigValue(key: string): Promise<string | null>` in `src/control/configValue.ts`.
  - `export async function skillsPublished(): Promise<boolean>` in the same file (`true` only on a readback of exactly `'true'`).
  - `ClaimResult.skillsPublished: boolean`.

- [ ] **Step 1: Write the failing tests**

In `test/integration/claim.test.ts`, add inside the claim describe block (next to `'credentials from takeGrantCredentials are on the claim result…'`). Reuse the file's existing mint-and-claim setup (copy the first 6-8 lines of that neighbouring test that mint the link and call `claim(token, email)`):

```ts
  test('skillsPublished is true only when config.get reads back exactly "true"', async () => {
    callOpsHandler = (op, params, opts) => op === 'config.get' && params?.key === 'mcp.publish_skills'
      ? { ok: true, exitCode: 0, argv: [], stdout: 'true\n[config] source: db', stderr: '', json: null }
      : defaultOk(op, opts);
    const result = await claimFreshMember();
    expect(result.skillsPublished).toBe(true);
  });

  test('skillsPublished is false when the key is off or unreadable (fail closed)', async () => {
    callOpsHandler = (op, params, opts) => op === 'config.get'
      ? { ok: false, exitCode: 1, argv: [], stdout: '', stderr: 'Config key not found', json: null }
      : defaultOk(op, opts);
    expect((await claimFreshMember()).skillsPublished).toBe(false);
  });
```

Define `claimFreshMember()` once at file scope. It is the neighbouring test's mint + `claim(...)` sequence returning the `ClaimResult`. Don't duplicate that sequence inline.

- [ ] **Step 2: Run to see them fail**

Run: `bun test test/integration/claim.test.ts`
Expected: the 2 new tests FAIL (`skillsPublished` is `undefined`).

- [ ] **Step 3: Implement**

Create `src/control/configValue.ts`. Move the doc comment and body verbatim from `routes/schema.ts`:

```ts
import { callOps } from './opsClient.ts';

/**
 * `gbrain config get <key>` reads the DB plane, which is the truth for a
 * per-source override. It prints the value on the first line then a
 * `[config] source: ...` note; a missing key exits 1 with
 * `Config key not found`. `callOps` returns `{ ok: false }` on that — it does
 * NOT throw on a non-zero op exit. Parse the first non-`[config]` line.
 * MEASURED; docs/schema-pack-findings.md S1 and S6 probe 1.
 */
export async function readConfigValue(key: string): Promise<string | null> {
  const r = await callOps<never>('config.get', { key }, { timeoutMs: 60_000 });
  if (!r.ok) return null;
  const line = (r.stdout ?? '').split('\n').map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('[config]'));
  return line ?? null;
}

/**
 * Whether gbrain serves list_skills/get_skill. Never assumed from `init`'s
 * default: read back live, and anything but exactly 'true' — absent,
 * unreadable, ops down — is off.
 */
export async function skillsPublished(): Promise<boolean> {
  try {
    return (await readConfigValue('mcp.publish_skills')) === 'true';
  } catch {
    return false;
  }
}
```

In `src/control/routes/schema.ts`, delete the local `readConfigValue` (comment + function, `:198-212`) and add `import { readConfigValue } from '../configValue.ts';`.

In `src/control/claim.ts`: add `skillsPublished: boolean;` to `ClaimResult`, import `skillsPublished` from `./configValue.ts`, and change the success return to:

```ts
    return { membershipId, connections, skillsPublished: await skillsPublished() };
```

The readback runs after every grant has succeeded, inside the existing `try`. `skillsPublished()` never throws, so it cannot trigger claim compensation.

- [ ] **Step 4: Run the tests**

Run: `bun test test/integration/claim.test.ts test/integration/schema-routes.test.ts test/integration/schema.test.ts`
Expected: all PASS. The schema suites prove the move didn't change behaviour.

- [ ] **Step 5: Commit**

```bash
git add src/control/configValue.ts src/control/routes/schema.ts src/control/claim.ts test/integration/claim.test.ts
git commit -m "feat(claim): report skillsPublished from a live mcp.publish_skills readback"
```

---

### Task 5: The wiring snippet tells the member about skills

**Files:**
- Modify: `src/control/harness.ts:53-77`
- Modify: `src/console/pages/Claim.tsx:5-31,88-94`
- Test: `test/unit/harness.test.ts`

**Interfaces:**
- Consumes: `ClaimResult.skillsPublished` (Task 4).
- Produces: `wiringSnippet(id: string, credentials: WiringCredentials, opts?: { skills?: boolean }): string` and `export const SKILLS_NOTE: string`.

- [ ] **Step 1: Write the failing tests**

Add `SKILLS_NOTE` to the import list in `test/unit/harness.test.ts`, then append inside `describe('wiringSnippet', …)`:

```ts
  test('skills omitted or false is byte-identical to the plain snippet', () => {
    for (const id of Object.keys(EXPECTED)) {
      const plain = wiringSnippet(id, creds);
      expect(wiringSnippet(id, creds, { skills: false })).toBe(plain);
      expect(plain).not.toContain('list_skills');
    }
  });

  test('skills true appends the MCP-native skills note for every class', () => {
    for (const id of Object.keys(EXPECTED)) {
      const snip = wiringSnippet(id, creds, { skills: true });
      expect(snip.startsWith(wiringSnippet(id, creds))).toBe(true);
      expect(snip.endsWith(SKILLS_NOTE)).toBe(true);
    }
  });

  test('the skills note names the tools and installs nothing', () => {
    expect(SKILLS_NOTE).toContain('list_skills');
    expect(SKILLS_NOTE).toContain('get_skill');
    expect(SKILLS_NOTE).toContain('unavailable_tools');
    expect(SKILLS_NOTE).not.toMatch(/skillpack scaffold|--stub/);
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test test/unit/harness.test.ts`
Expected: FAIL (`SKILLS_NOTE` is not exported).

- [ ] **Step 3: Implement**

In `src/control/harness.ts`, rename the current `wiringSnippet` body to a private `baseSnippet(id, credentials)`, then add:

```ts
/**
 * Appended only when the claim read `mcp.publish_skills` back as true.
 * MCP-native: the member's agent pulls skills over its own Connection, so
 * nothing is installed and nothing can go stale. Nothing here promises a skill
 * is callable — `unavailable_tools` is gbrain's per-caller answer to that.
 */
export const SKILLS_NOTE = [
  '',
  'Skills: this Connection serves gbrain skills over MCP, so there is nothing to install.',
  'Ask your agent to call `list_skills`, then `get_skill` with a skill name, and follow what it returns.',
  "A skill whose tools show up under `unavailable_tools` is outside your role. Skip it.",
  'In Mobrain, new agents are connected from the Connection page, not `gbrain connect`.',
].join('\n');

export function wiringSnippet(
  id: string,
  credentials: WiringCredentials,
  opts: { skills?: boolean } = {},
): string {
  const base = baseSnippet(id, credentials);
  return opts.skills ? `${base}\n${SKILLS_NOTE}` : base;
}
```

The `skills: true` test asserts `snip.endsWith(SKILLS_NOTE)` and `startsWith(base)`. With the leading `''` element, `SKILLS_NOTE` begins with `\n`, so the output is `base + '\n' + '\n…'` (one blank line). Keep that.

In `src/console/pages/Claim.tsx`:
- add `skillsPublished: boolean` to the `api.post<…>` response type and the `useState` type (`:26`, `:31`);
- give `ClaimedConnection` a `skills: boolean` prop, rendered as `<ClaimedConnection … skills={result.skillsPublished} />`;
- call `wiringSnippet(conn.harness, { client_id: creds.client_id, mcp_url: conn.mcp_url }, { skills })` and add `skills` to the `useMemo` deps.

`Connection.tsx:168` stays as is. The admin preview has no readback, so it shows the plain snippet.

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test test/unit/harness.test.ts && bunx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/control/harness.ts test/unit/harness.test.ts src/console/pages/Claim.tsx
git commit -m "feat(harness): the claim snippet tells members how to load skills when publishing is on"
```

---

### Task 6: Full verification

**Files:** none new.

- [ ] **Step 1: Unit + integration**

Run: `bun run test:unit && bun run test:integration:isolated`
Expected: all PASS.

- [ ] **Step 2: Contract proof again, on the final tree**

Run: `bun test test/contract/member-skills.contract.test.ts`
Expected: PASS, with the same counts as `docs/member-skills-findings.md`.

- [ ] **Step 3: Manual console check**

Run the dev stack (`/redeploy`). Create a Connection for a member, open the claim link and claim it. Confirm:
1. The snippet ends with the Skills note.
2. `docker compose exec gbrain-ops gbrain auth clients --json` shows the member client **and** its `-server` client with `surface: "full"`.
3. `gbrain config set mcp.publish_skills false`, then a fresh claim shows **no** Skills note. Restore it with `gbrain config set mcp.publish_skills true`.

- [ ] **Step 4: Report**

State each result plainly, including anything that failed or was skipped. Then use superpowers:finishing-a-development-branch.

---

## Self-review

- **Spec coverage (corrected design):** publish readback (T1a, T4). Surface blocker (T1b-c, T2, T3). RBAC still enforced (T1d). Degradation when publishing is off (T4 fail-closed, T5 byte-identical). Snippet messaging (T5). Live-Connection migration (T3 backfill). Contract test mirroring `annotateAdapters`-style gating (T5 unit tests + T1 contract). Persona, stubs, and addendum skill are deferred with reasons above.
- **Placeholders:** the findings doc's `<…>` cells are measured values filled in during T1 Step 3, by design. There are two conditional instructions (T1 Step 2 rescope params, T3 Step 4 helper reuse), and each has a concrete fallback.
- **Type consistency:** `applySurface(clientId, compiled)`, `widenConnectionSurfaces(actor)`, `readConfigValue(key)`, `skillsPublished()`, `ClaimResult.skillsPublished`, `wiringSnippet(id, creds, { skills })`, and `SKILLS_NOTE` are used identically across tasks.
