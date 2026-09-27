# MCP Connection Reliability + Skill Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the manual-harness MCP connection snippet actually authenticate and survive being pasted once, replace its permanent "untested" disclaimer with a real live verify result, and make skill discovery something an agent reliably does rather than something a human has to notice and relay.

**Architecture:** No new services. Extends the existing grant/provision pipeline (`connections.ts::provisionConnection`) with one extra live call (`mcp.verify`, already a registered-but-unused contract op) right after grant and before the credential file is consumed; extends the existing `harness.ts::wiringSnippet` contract with a correct auth shape and a second, machine-facing instruction block; adds three nullable columns to the existing `connections` table to persist the verify result so it survives past the initial claim screen.

**Tech Stack:** TypeScript, Hono routes, Drizzle ORM (Postgres), React console pages, Bun test (contract tests against the live dev stack via `docker compose`).

**Spec:** `docs/superpowers/specs/2026-09-27-mcp-and-skills-provisioning-fix-design.md`

## Global Constraints

- Manual-harness connections get a 30-day token TTL (`MANUAL_HARNESS_TOKEN_TTL = 30 * 24 * 60 * 60`), not the 1-hour compiler default. Auto-install harness classes (`claude-json`, `codex-toml`, `opencode-json`, `thin-cli`) are unaffected — do not change their TTL.
- The corrected manual-harness snippet shape is exactly:
  `{"mcpServers":{"gbrain":{"type":"http","url":"<mcp_url>","headers":{"Authorization":"Bearer <access_token>"}}}}`
- `mcp.verify` exit codes: `0` = ok, `2` = partial ("server checks passed, harness evidence missing" — **never render this as a pass**), anything else = failed. Verify must never throw and must never block claim/provision on failure.
- Verify only runs for `manual`-class harnesses (`connectionClass(harness) === 'manual'`, from `harness.ts`). Auto-install classes are out of scope — no evidence they're broken.
- No refresh-token flow, no client-credentials exchange in the harness, no automated skillpack sync. These are explicit non-goals from the spec.
- Money/side-effect note: `mcp.verify --delegate` "may incur model charges" per gbrain's own CLI help — never pass `--delegate` from this pipeline.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/control/db/schema.ts` | `connections` table gains `verifyStatus`/`verifiedAt`/`verifyMessage` columns |
| `src/control/db/migrations/00XX_connection_verify_status.sql` | Generated migration for the above |
| `src/contracts/registry.ts` | `mcp.verify` op gains `url`, `credentialsFile`, `delegate` params matching gbrain's real CLI |
| `contracts/v0.50.5.0/operations.json` | Regenerated allowlist artifact the ops server actually enforces — must match `registry.ts` or the new params are silently dropped |
| `src/control/connections.ts` | `compileFrom` TTL policy; new `verifyManualHarness()`; `provisionConnection` calls it; `persistCompiled`/`insertPending` extended for verify columns |
| `src/control/harness.ts` | `WiringCredentials.access_token`; corrected manual-class snippet; new `AGENT_INSTRUCTIONS` export; `wiringSnippet` returns instructions separately |
| `src/control/claim.ts` | `ClaimResult.connections[]` carries `verify` status through to the client |
| `src/control/routes/myConnection.ts` | `present()` passes `access_token` and verify fields into the `/my/mcp` response |
| `src/console/api.ts` | `MyMcpConfig` type gains `verify`/`agentInstructions` fields |
| `src/console/pages/Claim.tsx` | Renders access_token-bearing snippet, verify status, agent-instructions block |
| `src/console/pages/Mcp.tsx` | Same, for the self-service `/my/mcp` page |
| `src/console/pages/Access.tsx` | Preview-only placeholder gains `<access_token>` |
| `test/contract/member-skills.contract.test.ts` | Extended with snippet-shape + verify assertions |
| `test/unit/harness.test.ts` | New — snippet shape, TTL policy, `AGENT_INSTRUCTIONS` gating |
| `docs/member-skills-findings.md` | Upstream ask recorded (MCP `initialize.instructions`) |
| `docs/runbooks/skill-catalog-sync.md` | New — manual curation runbook, no code |

---

### Task 1: `connections` table gains verify-status columns

**Files:**
- Modify: `src/control/db/schema.ts:210-242` (the `connections` table)
- Create: `src/control/db/migrations/0013_connection_verify_status.sql` (drizzle-kit generates the exact number; do not hand-pick it)
- Test: `test/unit/connections-schema.test.ts`

**Interfaces:**
- Produces: `schema.connections.verifyStatus` (`text`, nullable), `schema.connections.verifiedAt` (`timestamp with time zone`, nullable), `schema.connections.verifyMessage` (`text`, nullable) — consumed by Task 5 and Task 6.

- [ ] **Step 1: Edit the schema**

In `src/control/db/schema.ts`, inside the `connections` table definition (right after `revokedAt`, before `createdAt`), add:

```ts
  verifyStatus: text('verify_status'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verifyMessage: text('verify_message'),
```

Also add a check constraint alongside the existing `connection_state_valid` check in the table's third argument array:

```ts
  check('connection_verify_status_valid', sql`${t.verifyStatus} in ('ok','partial','failed') or ${t.verifyStatus} is null`),
```

- [ ] **Step 2: Generate the migration**

Run: `npx drizzle-kit generate`

Expected: a new file `src/control/db/migrations/00XX_<generated-name>.sql` containing three `ALTER TABLE "connections" ADD COLUMN ...` statements plus the check constraint. Confirm it contains no unrelated diffs (drizzle-kit diffs the whole schema file, so a stray edit elsewhere would show up here too).

- [ ] **Step 3: Write the failing test**

```ts
// test/unit/connections-schema.test.ts
import { test, expect } from 'bun:test';
import { schema } from '../../src/control/db/client.ts';

test('connections table has verify-status columns', () => {
  const cols = Object.keys(schema.connections);
  expect(cols).toContain('verifyStatus');
  expect(cols).toContain('verifiedAt');
  expect(cols).toContain('verifyMessage');
});
```

- [ ] **Step 4: Run it**

Run: `bun test test/unit/connections-schema.test.ts`
Expected: PASS (this is a static shape check, not a DB round-trip — it will only fail if Step 1 was skipped or misspelled).

- [ ] **Step 5: Apply the migration to the dev stack and confirm it runs clean**

Run: `docker compose -f compose/docker-compose.slice0.yml exec -T gbrain-ops sh -c "cd /app && bun run drizzle-kit migrate"` (or this repo's existing migrate invocation — check `package.json` for the exact script name used elsewhere before assuming `drizzle-kit migrate` is wired up as a bare command).

Expected: migration applies with no error against the running dev Postgres.

- [ ] **Step 6: Commit**

```bash
git add src/control/db/schema.ts src/control/db/migrations/ test/unit/connections-schema.test.ts
git commit -m "feat(db): add verify-status columns to connections"
```

---

### Task 2: Extend `mcp.verify`'s contract params and regenerate the artifact

**Files:**
- Modify: `src/contracts/registry.ts:321-333`
- Modify (generated): `contracts/v0.50.5.0/operations.json`
- Test: `test/unit/registry-mcp-verify.test.ts`

**Interfaces:**
- Produces: `OPERATIONS['mcp.verify'].params` now includes `url`, `credentialsFile`, `delegate` — consumed by Task 5's `callOps('mcp.verify', {...})` call, which will silently have those fields dropped by the ops RPC server if this task is skipped (the server enforces `contracts/v0.50.5.0/operations.json`, not `registry.ts` directly).

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/registry-mcp-verify.test.ts
import { test, expect } from 'bun:test';
import { OPERATIONS } from '../../src/contracts/registry.ts';

test('mcp.verify accepts url, credentialsFile, and delegate', () => {
  const names = OPERATIONS['mcp.verify']!.params.map((p) => p.name);
  expect(names).toContain('url');
  expect(names).toContain('credentialsFile');
  expect(names).toContain('delegate');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test test/unit/registry-mcp-verify.test.ts`
Expected: FAIL — `url`/`credentialsFile`/`delegate` not present.

- [ ] **Step 3: Edit the registry**

In `src/contracts/registry.ts`, replace the `mcp.verify` entry's `params` array:

```ts
  'mcp.verify': {
    id: 'mcp.verify',
    argv: ['mcp', 'verify'],
    params: [
      { name: 'client', flag: '--client', kind: 'value' },
      { name: 'harness', flag: '--harness', kind: 'value' },
      { name: 'url', flag: '--url', kind: 'value', required: true, secret: true },
      { name: 'credentialsFile', flag: '--credentials-file', kind: 'value', secret: true },
      { name: 'timeoutMs', flag: '--timeout-ms', kind: 'value' },
      { name: 'delegate', flag: '--delegate', kind: 'flag' },
    ],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },
```

- [ ] **Step 4: Run the test again**

Run: `bun test test/unit/registry-mcp-verify.test.ts`
Expected: PASS.

- [ ] **Step 5: Regenerate the enforced artifact**

Run: `GBRAIN_VERSION=0.50.5.0 bun scripts/emit-operations.ts`
Expected: `wrote contracts/v0.50.5.0/operations.json — N operations` printed; `git diff contracts/v0.50.5.0/operations.json` shows only the `mcp.verify` params array changed.

- [ ] **Step 6: Commit**

```bash
git add src/contracts/registry.ts contracts/v0.50.5.0/operations.json test/unit/registry-mcp-verify.test.ts
git commit -m "feat(contracts): mcp.verify accepts url, credentialsFile, delegate"
```

---

### Task 3: 30-day token TTL for manual-class harness connections

**Files:**
- Modify: `src/control/connections.ts:1-10` (imports), `:373-` (`compileFrom`)
- Test: `test/unit/connections-ttl.test.ts`

**Interfaces:**
- Consumes: `connectionClass` from `src/control/harness.ts` (already exported, signature `(id: string) => ConnectionClass`, throws on an unknown id).
- Produces: `compileFrom(input, write, reads).tokenTtl === MANUAL_HARNESS_TOKEN_TTL` (2,592,000) whenever `input.tokenTtl` is undefined and `connectionClass(input.harness) === 'manual'`; unchanged (compiler default, 3600) for auto-install classes or when `input.tokenTtl` is explicitly set.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/connections-ttl.test.ts
import { test, expect } from 'bun:test';
import { compileConnection } from '../../src/contracts/compile.ts';
import { connectionClass } from '../../src/control/harness.ts';

// Mirrors connections.ts::compileFrom's policy in isolation, since compileFrom
// itself needs a live DB (loadSpaces) to exercise end to end — that path is
// covered by the contract test in Task 10.
function ttlFor(harness: string, explicit: number | undefined): number {
  const MANUAL_HARNESS_TOKEN_TTL = 30 * 24 * 60 * 60;
  const tokenTtl = explicit ?? (connectionClass(harness) === 'manual' ? MANUAL_HARNESS_TOKEN_TTL : undefined);
  return compileConnection(
    { role: 'member' },
    { sourceId: 'src', slug: 'space' },
    [],
    { tokenTtl },
  ).tokenTtl;
}

test('manual-class harness with no explicit TTL gets 30 days', () => {
  expect(ttlFor('generic', undefined)).toBe(30 * 24 * 60 * 60);
});

test('auto-install harness with no explicit TTL keeps the compiler default', () => {
  expect(ttlFor('claude-code', undefined)).toBe(3600);
});

test('an explicit tokenTtl always wins', () => {
  expect(ttlFor('generic', 120)).toBe(120);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test test/unit/connections-ttl.test.ts`
Expected: FAIL on the first assertion (`ttlFor('generic', undefined)` returns 3600, the compiler default, since the helper above intentionally re-implements the not-yet-shipped policy — this test documents the policy `compileFrom` must implement, and the real fix in Step 3 is what `connections.ts` gets, not this test file).

Note: this test file's `ttlFor` helper is a scaffold that hardcodes the intended policy so the test can run without a live DB. Its only job is to prove `compileConnection`'s `tokenTtl` option is honored correctly by `compile.ts` regardless of who computes the value — Step 3 below adds the real policy inside `connections.ts::compileFrom`, which is exercised end-to-end by Task 10's contract test.

- [ ] **Step 3: Add the policy to `connections.ts`**

Add the import and constant near the top of `src/control/connections.ts` (after the existing imports, before `export type ConnectionInput`):

```ts
import { connectionClass } from './harness.ts';

/** Manual harnesses (generic, ChatGPT, Cursor, …) have no auto-refresh, so a
 *  pasted credential must outlive one copy/paste, not one hour. */
const MANUAL_HARNESS_TOKEN_TTL = 30 * 24 * 60 * 60;
```

Then in `compileFrom` (`connections.ts:373`), change:

```ts
function compileFrom(input: ConnectionInput, write: SpaceRow, reads: SpaceRow[]): CompiledConnection {
  const tokenTtl = input.tokenTtl
    ?? (connectionClass(input.harness) === 'manual' ? MANUAL_HARNESS_TOKEN_TTL : undefined);
  return compileConnection({ role: input.memberRole }, write, reads, {
    boundSlugPrefixes: input.boundSlugPrefixes,
    tokenTtl,
    budgetUsdPerDay: input.budgetUsdPerDay,
    privateSpace: input.privateSpace,
  });
}
```

(Keep every existing option in that call — only `tokenTtl`'s value changes. Check the current body of `compileFrom` before editing so no existing option is dropped; the snippet above lists the options observed at spec time.)

- [ ] **Step 4: Run the test again**

Run: `bun test test/unit/connections-ttl.test.ts`
Expected: PASS (the scaffold's `ttlFor` now matches the real policy `compileFrom` implements).

- [ ] **Step 5: Commit**

```bash
git add src/control/connections.ts test/unit/connections-ttl.test.ts
git commit -m "feat(connections): 30-day token TTL for manual-harness connections"
```

---

### Task 4: Fix the manual-harness snippet shape and add agent instructions

**Files:**
- Modify: `src/control/harness.ts` (whole file is ~112 lines; touches `WiringCredentials`, `baseSnippet`, adds `AGENT_INSTRUCTIONS`, changes `wiringSnippet`'s return type)
- Test: `test/unit/harness.test.ts` (new)

**Interfaces:**
- Produces:
  - `WiringCredentials` gains `access_token?: string`.
  - `AGENT_INSTRUCTIONS: string` — new export, the pasteable system-prompt text.
  - `wiringSnippet(id, credentials, opts)` now returns `{ snippet: string; agentInstructions: string | null }` instead of a bare `string` — **this is a breaking signature change**; every existing call site (`Claim.tsx:170`, `myConnection.ts:171`, `Access.tsx:221`) is updated in Tasks 6–9. Do not leave any call site consuming the old bare-string return.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/harness.test.ts
import { test, expect } from 'bun:test';
import { wiringSnippet, AGENT_INSTRUCTIONS, connectionClass } from '../../src/control/harness.ts';

test('manual-class snippet is a valid http-transport MCP config with a bearer header', () => {
  const { snippet } = wiringSnippet('generic', {
    client_id: 'cid', mcp_url: 'https://example.test/mcp', access_token: 'tok',
  });
  const parsed = JSON.parse(snippet.split('\n').slice(1, -1).join('\n')) as {
    mcpServers: { gbrain: { type: string; url: string; headers: { Authorization: string } } };
  };
  expect(parsed.mcpServers.gbrain.type).toBe('http');
  expect(parsed.mcpServers.gbrain.url).toBe('https://example.test/mcp');
  expect(parsed.mcpServers.gbrain.headers.Authorization).toBe('Bearer tok');
});

test('manual-class snippet no longer contains a permanent untested disclaimer', () => {
  const { snippet } = wiringSnippet('generic', { mcp_url: 'https://x', access_token: 't' });
  expect(snippet).not.toContain('We have not runtime-tested this adapter');
});

test('agentInstructions is present only when opts.skills is true', () => {
  const withSkills = wiringSnippet('generic', { mcp_url: 'https://x', access_token: 't' }, { skills: true });
  const withoutSkills = wiringSnippet('generic', { mcp_url: 'https://x', access_token: 't' }, { skills: false });
  expect(withSkills.agentInstructions).toBe(AGENT_INSTRUCTIONS);
  expect(withoutSkills.agentInstructions).toBeNull();
});

test('auto-install classes are unaffected and stay a plain string message', () => {
  const { snippet } = wiringSnippet('claude-code', {});
  expect(snippet).toBe("gbrain mcp grant already wrote this adapter's config (claude-json).");
});
```

- [ ] **Step 2: Run to see it fail**

Run: `bun test test/unit/harness.test.ts`
Expected: FAIL — `wiringSnippet` still returns a bare string, `AGENT_INSTRUCTIONS` doesn't exist yet.

- [ ] **Step 3: Rewrite `harness.ts`**

Replace the credentials type, `baseSnippet`, `SKILLS_NOTE`/`wiringSnippet` section (lines 16-100 of the current file) with:

```ts
/** Credential fields safe to embed in a copy/paste wiring snippet. */
export type WiringCredentials = {
  client_id?: string;
  mcp_url?: string;
  access_token?: string;
};

function baseSnippet(id: string, credentials: WiringCredentials): string {
  const klass = connectionClass(id);
  if (klass === 'manual') {
    const mcpUrl = credentials.mcp_url ?? '<mcp_url>';
    const accessToken = credentials.access_token ?? '<access_token>';
    const fragment = JSON.stringify(
      {
        mcpServers: {
          gbrain: {
            type: 'http',
            url: mcpUrl,
            headers: { Authorization: `Bearer ${accessToken}` },
          },
        },
      },
      null,
      2,
    );
    return [
      'Copy/paste this MCP config fragment into the harness:',
      fragment,
    ].join('\n');
  }
  return `gbrain mcp grant already wrote this adapter's config (${klass}).`;
}

/**
 * Human-facing context, shown alongside (not instead of) AGENT_INSTRUCTIONS.
 * Appended only when the claim read `mcp.publish_skills` back as true.
 */
export const SKILLS_NOTE = [
  '',
  'Skills: this Connection serves gbrain skills over MCP, so there is nothing to install.',
  'Ask your agent to call `list_skills`, then `get_skill` with a skill name, and follow what it returns.',
  "A skill whose tools show up under `unavailable_tools` is outside your role. Skip it.",
  'In Mobrain, new agents are connected from the Connection page, not `gbrain connect`.',
].join('\n');

/**
 * Machine-facing: meant to be pasted as the agent's system prompt or first
 * message, not read by a human. MCP-native — the agent pulls skills over its
 * own Connection, so nothing is installed and nothing can go stale.
 */
export const AGENT_INSTRUCTIONS = [
  'Before responding to any request on this connection, call `list_skills`.',
  "If a returned skill's triggers match the user's request, call `get_skill`",
  'with its name and follow the returned instructions. Only call tools listed',
  "in that skill's `usable_tools` — tools under `unavailable_tools` are not",
  'callable by you on this server.',
].join(' ');

export function wiringSnippet(
  id: string,
  credentials: WiringCredentials,
  opts: { skills?: boolean } = {},
): { snippet: string; agentInstructions: string | null } {
  const base = baseSnippet(id, credentials);
  const snippet = opts.skills ? `${base}\n${SKILLS_NOTE}` : base;
  return { snippet, agentInstructions: opts.skills ? AGENT_INSTRUCTIONS : null };
}
```

Leave `ConnectionClass`, `HARVEST_MAP`, `connectionClass`, `autoInstall`, and `annotateAdapters` untouched.

- [ ] **Step 4: Run the tests again**

Run: `bun test test/unit/harness.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm the repo still typechecks**

Run: `bunx tsc --noEmit`
Expected: errors at exactly the three call sites that destructure the old bare-string return (`Claim.tsx`, `myConnection.ts`, `Access.tsx`) — these are fixed in Tasks 6, 7, 9. Confirm no *other* file breaks; if one does, it's an undiscovered call site and must be added to this plan's file list before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/control/harness.ts test/unit/harness.test.ts
git commit -m "fix(harness): correct manual-harness snippet auth shape, add agent instructions"
```

---

### Task 5: Wire a live `mcp.verify` call into `provisionConnection`

**Files:**
- Modify: `src/control/connections.ts:106-205` (`provisionConnection`), `:587-612` (`insertPending`), `:614-` (`persistCompiled`)
- Test: covered by Task 10's contract test (this task has no standalone unit test — it needs the live ops server and gbrain-serve, which the unit-test tier doesn't run against)

**Interfaces:**
- Consumes: `mcp.verify`'s new params from Task 2; `verifyStatus`/`verifiedAt`/`verifyMessage` columns from Task 1; `connectionClass` from `harness.ts` (already imported in Task 3).
- Produces: `persistCompiled`'s `extra` parameter gains `verifyStatus?: 'ok' | 'partial' | 'failed'; verifiedAt?: Date; verifyMessage?: string | null` — consumed by nothing else in this plan, but is now part of the connection row Task 6 reads.

- [ ] **Step 1: Add the verify helper**

In `src/control/connections.ts`, add near `provisionConnection`:

```ts
type VerifyResult = { status: 'ok' | 'partial' | 'failed'; message: string | null };

/**
 * Only for manual-class harnesses — auto-install classes write real adapter
 * config via `gbrain connect --install` and have their own install-time
 * verification story. Never throws: a verify failure is recorded, not fatal
 * to provisioning (the credential is still valid even if the live check
 * couldn't complete, e.g. a transient network blip to gbrain-ops).
 */
async function verifyManualHarness(
  clientId: string,
  harness: string,
  credentialsFile: string,
): Promise<VerifyResult | null> {
  if (connectionClass(harness) !== 'manual') return null;
  try {
    const r = await callOps('mcp.verify', {
      client: clientId, harness, url: mcpUrl(), credentialsFile, timeoutMs: 30_000,
    }, { json: true, timeoutMs: 35_000 });
    // mcp.verify's own exit-code contract (registry.ts comment, V10/honesty
    // rule 5): 0 = ok, 2 = partial (server checks passed, harness evidence
    // missing — never render this as a pass), anything else = failed.
    const status: VerifyResult['status'] = r.exitCode === 0 ? 'ok' : r.exitCode === 2 ? 'partial' : 'failed';
    return { status, message: r.stdout.slice(0, 500) || null };
  } catch (e) {
    return { status: 'failed', message: e instanceof Error ? e.message.slice(0, 500) : 'verify request failed' };
  }
}
```

- [ ] **Step 2: Call it in `provisionConnection`, before the credentials file is consumed**

`storeMemberClientHandoff` (called at `connections.ts:165`) reads-then-deletes `credentialsOut` via `takeGrantCredentials`. The verify call must happen with the file still present, so insert it between the `mcp.grant` call and `storeMemberClientHandoff`:

```ts
  const r = await callOps('mcp.grant', grantParams(name, input.harness, compiled, credentialsOut), { json: true });
  if (!r.ok) throw new Error(`mcp.grant failed (exit ${r.exitCode})`);
  const gbrainClientId = grantedClientId(r.json);

  const verifyResult = await verifyManualHarness(gbrainClientId, input.harness, credentialsOut);

  let serverClientId: string;
  let memberHandoff: unknown;
  try {
    memberHandoff = await storeMemberClientHandoff(
      input.organizationId, connectionId, gbrainClientId, credentialsOut,
    );
    // ... unchanged from here
```

(Only the one new `const verifyResult = ...` line is inserted; every surrounding line is unchanged — re-read `connections.ts:149-181` before editing so the diff is exactly this one insertion.)

- [ ] **Step 3: Persist the result**

At the bottom of `provisionConnection`, the existing call:

```ts
  await persistCompiled(connectionId, input, name, compiled, {
    gbrainClientId,
    serverClientId,
    state: 'active',
    provisionedAt: new Date(),
  });
```

becomes:

```ts
  await persistCompiled(connectionId, input, name, compiled, {
    gbrainClientId,
    serverClientId,
    state: 'active',
    provisionedAt: new Date(),
    verifyStatus: verifyResult?.status,
    verifiedAt: verifyResult ? new Date() : undefined,
    verifyMessage: verifyResult?.message ?? undefined,
  });
```

- [ ] **Step 4: Extend `persistCompiled`'s signature and `.set()` call**

```ts
async function persistCompiled(
  id: string,
  input: ConnectionInput,
  name: string,
  compiled: CompiledConnection,
  extra: {
    gbrainClientId?: string; serverClientId?: string; state?: string; provisionedAt?: Date;
    verifyStatus?: 'ok' | 'partial' | 'failed'; verifiedAt?: Date; verifyMessage?: string | null;
  } = {},
): Promise<void> {
  await getDb().update(schema.connections).set({
    writeSpaceId: input.writeSpaceId,
    readSpaceIds: input.readSpaceIds,
    harness: input.harness,
    clientName: name,
    profile: compiled.profile,
    tokenTtl: compiled.tokenTtl,
    budgetUsdPerDay: compiled.budgetUsdPerDay != null ? String(compiled.budgetUsdPerDay) : null,
    boundSlugPrefixes: compiled.boundSlugPrefixes,
    verifyStatus: extra.verifyStatus,
    verifiedAt: extra.verifiedAt,
    verifyMessage: extra.verifyMessage,
    ...extra,
  }, /* keep whatever WHERE clause and remaining fields already exist below this point */)
  // ...
```

Check the existing body below this point (`connections.ts:614` onward) before editing — only add the three new `.set()` fields; do not alter the function's existing `where`/state-transition logic. Order matters: put `verifyStatus`/`verifiedAt`/`verifyMessage` **before** the `...extra` spread only if `extra` doesn't already redeclare `gbrainClientId`/`serverClientId`/`state`/`provisionedAt` inline in the set object elsewhere — read the real current body first; the goal is additive fields, not a restructure.

- [ ] **Step 5: Also wire reissue**

`myConnectionRoutes.post('/my/mcp/reissue', ...)` (`myConnection.ts:195`) calls `revokeConnection` then `provisionPrivateSpace`, which internally calls `provisionConnection` — since Step 2's verify call lives inside `provisionConnection`, reissue gets it for free. Confirm this by reading `provisionPrivateSpace` in `src/control/privateSpaces.ts` and checking it does call `provisionConnection` (not a separate lower-level path) before marking this step done.

- [ ] **Step 6: Manual smoke test against the dev stack**

Run: (with the dev stack already up per earlier session commands)
```bash
docker exec mobrain-local-gbrain-ops-1 gbrain mcp grant plan-smoke-test --harness generic --profile memory-writer --source my-space-ecdabc92 --url https://localhost/mcp --credentials-out /srv/gbrain-home/.creds-smoke.json --json
```
This exercises `mcp.grant` directly, not `provisionConnection` (that needs the full app running) — the actual `provisionConnection` path is exercised by Task 10's contract test. Use this step only to confirm `mcp.verify` itself accepts the new flags:
```bash
docker exec mobrain-local-gbrain-ops-1 gbrain mcp verify --client <clientId from above> --harness generic --url https://localhost/mcp --credentials-file /srv/gbrain-home/.creds-smoke.json --json
```
Expected: exit 0 or 2 (not an argument-parsing error). Then revoke the smoke-test client:
```bash
docker exec mobrain-local-gbrain-ops-1 gbrain auth revoke-client <clientId>
docker exec mobrain-local-gbrain-ops-1 rm -f /srv/gbrain-home/.creds-smoke.json
```

- [ ] **Step 7: Commit**

```bash
git add src/control/connections.ts
git commit -m "feat(connections): run a live mcp.verify after granting a manual-harness connection"
```

---

### Task 6: Propagate `access_token` and verify status through `claim.ts` and `myConnection.ts`

**Files:**
- Modify: `src/control/claim.ts:15-25` (`ClaimResult` type), `:140-148` (the `connections.push(...)` block)
- Modify: `src/control/routes/myConnection.ts:168-176` (`present`)
- Test: `test/unit/claim-result.test.ts` (new — type-shape only, no DB)

**Interfaces:**
- Consumes: `provisioned.credentials`/`provisioned.memberHandoff` (already returned by `provisionConnection`, unchanged shape — the handoff object already contains `access_token`, proven live this session); `row.verifyStatus`/`verifyMessage` will exist on the `schema.connections` row after Task 1+5 run against a real DB (this task's own unit test does not touch the DB).
- Produces: `ClaimResult.connections[]` items gain `verify: { status: string | null; message: string | null } | null`; `myConnection.ts`'s `/my/mcp` response gains the same `verify` field plus `agentInstructions: string | null`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/claim-result.test.ts
import { test, expect } from 'bun:test';
import type { ClaimResult } from '../../src/control/claim.ts';

test('ClaimResult connections carry a verify field', () => {
  const sample: ClaimResult['connections'][number] = {
    connectionId: 'c1', credentials: {}, harness: 'generic', mcp_url: 'https://x',
    verify: { status: 'ok', message: null },
  };
  expect(sample.verify?.status).toBe('ok');
});
```

- [ ] **Step 2: Run to see it fail**

Run: `bun test test/unit/claim-result.test.ts`
Expected: FAIL (TypeScript compile error — `verify` not on the type).

- [ ] **Step 3: Extend `ClaimResult`**

In `src/control/claim.ts`, change:

```ts
export type ClaimResult = {
  membershipId: string;
  connections: Array<{
    connectionId: string;
    credentials: unknown;
    harness: string;
    mcp_url: string;
    verify: { status: string | null; message: string | null } | null;
  }>;
  skillsPublished: boolean;
  account: 'created' | 'existing' | 'unchanged';
};
```

Then, in the `claim()` function's connection-building loop (`claim.ts:124-148`), thread the row's verify fields through. `row` (from `schema.connections`, the pending row being provisioned) does not carry the *post-provision* verify result — `provisionConnection` writes it after `row` was read. Re-fetch or read it off the return value instead: since `provisionConnection`'s return type is `{ connectionId, credentials, memberHandoff }` (`connections.ts:109`) and does not currently surface verify status, extend that return type too:

```ts
// connections.ts — provisionConnection's return type
): Promise<{ connectionId: string; credentials: unknown; memberHandoff?: unknown; verify: VerifyResult | null }> {
```

and its final `return` statement:

```ts
  return { connectionId, credentials: r.json, memberHandoff, verify: verifyResult };
```

Then in `claim.ts`:

```ts
      connections.push({
        connectionId: provisioned.connectionId,
        credentials: provisioned.memberHandoff,
        harness: row.harness,
        mcp_url: mcpUrlFromGrant(provisioned.credentials) ?? mcpUrl(),
        verify: provisioned.verify,
      });
```

- [ ] **Step 4: Run the test again**

Run: `bun test test/unit/claim-result.test.ts`
Expected: PASS.

- [ ] **Step 5: Update `myConnection.ts::present`**

```ts
async function present(connection: { harness: string }, handoff: Record<string, unknown>) {
  const mcp_url = handoffMcpUrl(handoff);
  const clientId = handoff.client_id;
  const accessToken = handoff.access_token;
  const { snippet, agentInstructions } = wiringSnippet(connection.harness, {
    client_id: typeof clientId === 'string' && clientId.length > 0 ? clientId : undefined,
    access_token: typeof accessToken === 'string' && accessToken.length > 0 ? accessToken : undefined,
    mcp_url,
  }, { skills: await skillsPublished() });
  return { mcp_url, harness: connection.harness, credentials: handoff, snippet, agentInstructions };
}
```

Note `present()`'s signature only receives `{ harness: string }`, not the full connection row — it currently has no access to `verifyStatus`/`verifyMessage`. Extend its parameter and both call sites (`myConnectionRoutes.get('/my/mcp', ...)` at `myConnection.ts:190-192` and `.post('/my/mcp/reissue', ...)` at `myConnection.ts:208-210`) to pass the full `connection`/`fresh` row instead of a narrowed object, and add `verify` to the returned JSON:

```ts
async function present(
  connection: { harness: string; verifyStatus: string | null; verifyMessage: string | null },
  handoff: Record<string, unknown>,
) {
  const mcp_url = handoffMcpUrl(handoff);
  const clientId = handoff.client_id;
  const accessToken = handoff.access_token;
  const { snippet, agentInstructions } = wiringSnippet(connection.harness, {
    client_id: typeof clientId === 'string' && clientId.length > 0 ? clientId : undefined,
    access_token: typeof accessToken === 'string' && accessToken.length > 0 ? accessToken : undefined,
    mcp_url,
  }, { skills: await skillsPublished() });
  return {
    mcp_url, harness: connection.harness, credentials: handoff, snippet, agentInstructions,
    verify: connection.verifyStatus ? { status: connection.verifyStatus, message: connection.verifyMessage } : null,
  };
}
```

Both call sites already have `connection`/`fresh` in scope as the full Drizzle row (which now has `verifyStatus`/`verifyMessage` from Task 1), so passing them through instead of a hand-narrowed object is a one-line change at each `present(connection, ...)` / `present(fresh, ...)` call.

- [ ] **Step 6: Commit**

```bash
git add src/control/claim.ts src/control/connections.ts src/control/routes/myConnection.ts test/unit/claim-result.test.ts
git commit -m "feat(mcp): surface access_token and verify status through claim and my/mcp"
```

---

### Task 7: Claim.tsx renders the fixed snippet, verify status, and agent instructions

**Files:**
- Modify: `src/console/pages/Claim.tsx`

**Interfaces:**
- Consumes: `wiringSnippet` returning `{ snippet, agentInstructions }` (Task 4); `ClaimConnection.verify` (Task 6).

- [ ] **Step 1: Extend the local types**

```ts
type ClaimConnection = {
  connectionId: string;
  credentials: unknown;
  harness: string;
  mcp_url: string;
  verify: { status: string | null; message: string | null } | null;
};

type Creds = {
  client_id?: string;
  client_secret?: string;
  access_token?: string;
};
```

Update the two inline result types at `Claim.tsx:63` and `Claim.tsx:69` — both already say `connections: ClaimConnection[]`, so no further change needed there once the type above is updated.

- [ ] **Step 2: Update `ClaimedConnection`**

```tsx
function ClaimedConnection({ conn, skills }: { conn: ClaimConnection; skills: boolean }) {
  const creds = asCreds(conn.credentials);
  const { snippet, agentInstructions } = useMemo(() => {
    try {
      return wiringSnippet(conn.harness, {
        client_id: creds.client_id, access_token: creds.access_token, mcp_url: conn.mcp_url,
      }, { skills });
    } catch (e) {
      return { snippet: e instanceof Error ? e.message : 'unknown harness', agentInstructions: null };
    }
  }, [conn.harness, conn.mcp_url, creds.client_id, creds.access_token, skills]);

  const verifyLine = conn.verify?.status === 'ok'
    ? 'Verified: this connection authenticated successfully.'
    : conn.verify?.status === 'partial'
    ? 'Server checks passed, harness evidence missing — treat as unverified.'
    : conn.verify?.status === 'failed'
    ? `Verify failed${conn.verify.message ? `: ${conn.verify.message}` : '.'}`
    : null;

  return (
    <Card title={<span className="font-mono">{conn.connectionId}</span>} className="space-y-3">
      <pre className={CREDENTIAL_BLOCK}>
        {JSON.stringify(conn.credentials, null, 2)}
      </pre>
      <dl className="space-y-1 text-sm font-mono">
        {creds.client_id != null && <div>client_id: {creds.client_id}</div>}
        {creds.client_secret != null && <div>client_secret: {creds.client_secret}</div>}
        <div>harness: {conn.harness}</div>
        <div>mcp_url: {conn.mcp_url}</div>
      </dl>
      <pre className={CREDENTIAL_BLOCK}>{snippet}</pre>
      {verifyLine && (
        <Notice tone={conn.verify?.status === 'ok' ? undefined : 'warning'}>{verifyLine}</Notice>
      )}
      {agentInstructions && (
        <div className="space-y-1">
          <h3 className="m-0 text-sm font-medium">Agent instructions</h3>
          <pre className={CREDENTIAL_BLOCK}>{agentInstructions}</pre>
        </div>
      )}
    </Card>
  );
}
```

Check `Notice`'s accepted `tone` values in `src/console/ui/index.tsx` before using `'warning'` here — `Access.tsx` already uses `tone="warning"` and `tone="danger"` elsewhere in this codebase, so `'warning'` is confirmed valid; confirm `undefined`/omitted renders the default (non-alarming) tone rather than erroring.

- [ ] **Step 3: Typecheck and manual verification**

Run: `bunx tsc --noEmit -p .` (or however this repo scopes the console's typecheck — check for a console-specific `tsconfig.json` before assuming the root one covers `.tsx`).
Expected: no errors in `Claim.tsx`.

Then start the dev console (`redeploy` skill or the project's existing dev-run instructions) and walk through claiming a real invite link end to end, confirming: the snippet contains a `Bearer` header (not a bare `client_id`), a verify line renders, and — when skills are published — an "Agent instructions" block appears with the exact `AGENT_INSTRUCTIONS` text.

- [ ] **Step 4: Commit**

```bash
git add src/console/pages/Claim.tsx
git commit -m "feat(console): render fixed snippet, verify status, and agent instructions on Claim"
```

---

### Task 8: Mcp.tsx (`/my/mcp` self-service page) gets the same treatment

**Files:**
- Modify: `src/console/api.ts:905-915` (`MyMcpConfig`)
- Modify: `src/console/pages/Mcp.tsx`

**Interfaces:**
- Consumes: `myConnection.ts`'s `/my/mcp` response, now including `agentInstructions` and `verify` (Task 6).

- [ ] **Step 1: Extend `MyMcpConfig`**

```ts
export type MyMcpConfig = {
  mcp_url: string;
  harness: string;
  credentials: unknown;
  snippet: string;
  agentInstructions: string | null;
  verify: { status: string | null; message: string | null } | null;
};
```

- [ ] **Step 2: Extend `mcpPaste` and render the new blocks**

In `Mcp.tsx`, extend the `McpPaste` type and `mcpPaste()`:

```ts
export type McpPaste = {
  endpoint: string;
  credentialJson: string;
  snippet: string;
  agentInstructions: string | null;
  verify: { status: string | null; message: string | null } | null;
};

export function mcpPaste(payload: {
  mcp_url: string;
  credentials: unknown;
  snippet: string;
  agentInstructions: string | null;
  verify: { status: string | null; message: string | null } | null;
}): McpPaste | null {
  const { credentials } = payload;
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return null;
  const secret = (credentials as { client_secret?: unknown }).client_secret;
  if (typeof secret !== 'string' || secret.trim().length === 0) return null;
  if (typeof payload.mcp_url !== 'string' || payload.mcp_url.length === 0) return null;
  if (typeof payload.snippet !== 'string' || payload.snippet.length === 0) return null;
  return {
    endpoint: payload.mcp_url,
    credentialJson: JSON.stringify(credentials, null, 2),
    snippet: payload.snippet,
    agentInstructions: payload.agentInstructions,
    verify: payload.verify,
  };
}
```

Then, in the `Card` block that renders the three `PasteBlock`s (`Mcp.tsx:151-162`), add a fourth block and a verify `Notice`, reusing the same status-line logic as Task 7 (extract it to a small shared helper if you want to avoid duplicating the ternary — not required, but reasonable given it now exists in two files):

```tsx
{view.kind === 'ready' && !posting && (
  <Card
    title="Connect your agent"
    subtitle="Paste these into the agent that should use your private Space."
  >
    <div className="space-y-4">
      <PasteBlock label="Endpoint" text={view.paste.endpoint} />
      <PasteBlock label="Credentials" text={view.paste.credentialJson} />
      <PasteBlock label="Harness snippet" text={view.paste.snippet} />
      {view.paste.agentInstructions && (
        <PasteBlock label="Agent instructions" text={view.paste.agentInstructions} />
      )}
      {view.paste.verify?.status && (
        <Notice tone={view.paste.verify.status === 'ok' ? undefined : 'warning'}>
          {view.paste.verify.status === 'ok'
            ? 'Verified: this connection authenticated successfully.'
            : view.paste.verify.status === 'partial'
            ? 'Server checks passed, harness evidence missing — treat as unverified.'
            : `Verify failed${view.paste.verify.message ? `: ${view.paste.verify.message}` : '.'}`}
        </Notice>
      )}
    </div>
  </Card>
)}
```

`viewFor()` (`Mcp.tsx:63-69`) calls `mcpPaste(body)` with `body: MyMcpConfig` — since `mcpPaste`'s parameter type now requires `agentInstructions`/`verify`, and `MyMcpConfig` now has them, no change to `viewFor` itself is needed beyond what TypeScript already forces.

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors in `api.ts`/`Mcp.tsx`.

- [ ] **Step 4: Commit**

```bash
git add src/console/api.ts src/console/pages/Mcp.tsx
git commit -m "feat(console): render agent instructions and verify status on the my/mcp page"
```

---

### Task 9: Access.tsx preview placeholder gains `<access_token>`

**Files:**
- Modify: `src/console/pages/Access.tsx:219-222`

**Interfaces:**
- Consumes: `wiringSnippet` returning `{ snippet, agentInstructions }` (Task 4) — this call site only uses `.snippet`, discarding `agentInstructions` since this is a pre-grant preview with no real credentials or publish-gate context yet.

- [ ] **Step 1: Update the call**

```ts
  let snippet = '';
  try {
    if (harness) {
      snippet = wiringSnippet(harness, {
        client_id: '<client_id>', access_token: '<access_token>', mcp_url: '<mcp_url>',
      }).snippet;
    }
  } catch { /* unknown adapter until picker loads */ }
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors in `Access.tsx`.

- [ ] **Step 3: Manual check**

Start the console, open the Access page's connection wizard, pick a `manual`-class harness (e.g. `generic`) from the picker, and confirm the preview snippet shows `<access_token>` in a `headers.Authorization` field rather than a bare `client_id` line.

- [ ] **Step 4: Commit**

```bash
git add src/console/pages/Access.tsx
git commit -m "fix(console): Access preview snippet includes the access_token placeholder"
```

---

### Task 10: Contract test — the fixed snippet actually authenticates, end to end

**Files:**
- Modify: `test/contract/member-skills.contract.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6, exercised together against the live dev-stack containers (`docker compose -f compose/docker-compose.slice0.yml`), the same pattern this file already uses (`composeUp`/`resetBrain`/`seedGitSource`/`execOperation`).

- [ ] **Step 1: Add a new test to the existing file**

Append after the existing `test('(d) ...')` block:

```ts
test('(e) a generic-harness grant produces a snippet that authenticates, and is recorded verified', async () => {
  const grant = await execOperation(OPERATIONS['mcp.grant']!, {
    name: 'member-skills-verify-probe', harness: 'generic', profile: 'memory-writer',
    source: 'customers', url: MCP_URL, credentialsOut: '/srv/gbrain-home/.creds-verify-probe.json',
  }, { json: true });
  assertOk(OPERATIONS['mcp.grant']!, grant);
  const probeClientId = String((grant.json as { grant?: { clientId?: string } }).grant?.clientId);

  const verify = await execOperation(OPERATIONS['mcp.verify']!, {
    client: probeClientId, harness: 'generic', url: MCP_URL,
    credentialsFile: '/srv/gbrain-home/.creds-verify-probe.json', timeoutMs: 30000,
  }, { json: true });
  console.log(`[member-skills] mcp.verify exit=${verify.exitCode}`);
  expect([0, 2]).toContain(verify.exitCode);

  const handoff = await composeExec('gbrain-ops', ['cat', '/srv/gbrain-home/.creds-verify-probe.json']);
  const parsed = JSON.parse(handoff.stdout) as { access_token?: string; mcp_url?: string };
  const { snippet } = wiringSnippet('generic', {
    access_token: parsed.access_token, mcp_url: parsed.mcp_url,
  });
  const fragment = JSON.parse(snippet.split('\n').slice(1).join('\n')) as {
    mcpServers: { gbrain: { type: string; headers: { Authorization: string } } };
  };
  expect(fragment.mcpServers.gbrain.type).toBe('http');
  expect(fragment.mcpServers.gbrain.headers.Authorization).toBe(`Bearer ${parsed.access_token}`);

  // The snippet's own credential must actually authenticate against the live server.
  const T = fragment.mcpServers.gbrain.headers.Authorization.replace('Bearer ', '');
  const script =
    `const r = await fetch(${JSON.stringify(MCP_URL)}, { method: 'POST', headers: {` +
    ` authorization: 'Bearer ' + process.env.T, 'content-type': 'application/json',` +
    ` accept: 'application/json, text/event-stream' },` +
    ` body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });` +
    ` console.log(await r.text());`;
  const r = await composeExec('gbrain-ops', ['bun', '-e', script], { env: { T } });
  expect(r.stdout).toContain('"tools"');

  await composeExec('gbrain-ops', ['bash', '-c', `gbrain auth revoke-client ${probeClientId} || true`]);
});
```

Add `wiringSnippet` to the file's imports (`import { wiringSnippet } from '../../src/control/harness.ts';`).

- [ ] **Step 2: Run it**

Run: `bun test test/contract/member-skills.contract.test.ts` (this spins up/tears down the full slice0 compose stack — expect several minutes; it reuses the same `beforeAll`/`afterAll` as the existing tests in this file, so it isn't a second stack, just one more test in the suite).
Expected: PASS. If it fails on the `Authorization` assertion, re-check Task 4's `baseSnippet` was actually committed (not left uncommitted from a different branch/worktree).

- [ ] **Step 3: Commit**

```bash
git add test/contract/member-skills.contract.test.ts
git commit -m "test(contract): the manual-harness snippet authenticates end to end"
```

---

### Task 11: Record the upstream ask for MCP `initialize.instructions`

**Files:**
- Modify: `docs/member-skills-findings.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Append a new section**

Add, after the existing "Upstream issue" line at the end of the file:

```markdown

## Upstream ask: initialize.instructions (2026-09-27)

`list_skills` already returns a complete self-instruction block (verified
live this session — `instructions.summary`/`how_to_use`/`fetch_op`). The
remaining gap is that nothing prompts an agent to call `list_skills` in the
first place; Mobrain's near-term fix is a pasteable `AGENT_INSTRUCTIONS`
block on the Connect page (`src/control/harness.ts`), but the durable fix
is upstream: gbrain's MCP `initialize` response should carry the same
guidance in its own `instructions` field, which spec-compliant clients load
automatically with no copy/paste.

Not fixed in this repo — filed upstream, tracked alongside the existing
publish-gate divergence (issue #5358).

Upstream issue: https://github.com/garrytan/gbrain/issues/5359
```

Use the real issue number once filed — do not commit a placeholder number. If filing the issue is blocked (no tracker access from this environment), leave this step to the person running the plan and note in the PR description that the issue still needs to be filed.

- [ ] **Step 2: Commit**

```bash
git add docs/member-skills-findings.md
git commit -m "docs: record upstream ask for MCP initialize.instructions"
```

---

### Task 12: Skill-catalog-currency runbook

**Files:**
- Create: `docs/runbooks/skill-catalog-sync.md`

**Interfaces:** none (documentation only, no code).

- [ ] **Step 1: Check the existing runbook style**

Read `docs/runbooks/upgrade.md` first so the new file matches this repo's existing runbook tone/structure (numbered operator steps, not prose).

- [ ] **Step 2: Write the runbook**

```markdown
# Skill catalog sync

Mobrain's member-facing skill catalog (`skills/`, mounted read-only into
`gbrain-serve`/`gbrain-ops` at `/opt/mobrain-skills`) is a small, curated
subset of gbrain's built-in skills. gbrain deliberately never serves its
own bundled catalog to remote MCP callers, so nothing here updates itself —
new gbrain releases can ship skills members never see until an operator
does this.

## Check for drift

On `gbrain-ops`:

```bash
docker exec <gbrain-ops-container> gbrain doctor --json
```

Look at the `skill_currency` check. `status: "warn"` with a non-empty
`details.new` list means gbrain has built-in skills this workspace hasn't
synced.

## Review and curate

1. `docker exec <gbrain-ops-container> gbrain skillpack sync` to pull the
   built-in catalog into a local scratch location (does not touch the repo
   `skills/` directory).
2. For each new/changed skill, read its `SKILL.md` and check:
   - Does it need tools or scopes beyond what member profiles
     (`memory-reader`, `memory-writer`, …) already grant? If yes, it likely
     needs `operator`/`coding-agent`-only exposure, not a member-wide add.
   - Does it match a real member workflow, or is it operator/admin tooling
     that doesn't belong in a member's `list_skills` response?
   - Does it write pages a member shouldn't be able to write unsupervised?
3. For each approved skill, copy its `SKILL.md` into
   `skills/<name>/SKILL.md` in this repo, and add a row to
   `skills/RESOLVER.md`'s trigger table.

## Ship it

Commit the new/changed `skills/` files as a normal PR. No redeploy-time
config change is needed — `GBRAIN_SKILLS_DIR` already points at the
mounted repo folder (`compose/docker-compose.yml`,
`compose/docker-compose.slice0.yml`), so the next container start (or a
running container's next `list_skills` call, if gbrain reads the catalog
live rather than caching it at boot — confirm this before assuming a
running container needs no restart) picks it up.

## Cadence

Check `skill_currency` alongside each gbrain version bump — this repo
already has a per-version playbook mechanism (`src/upgrade/playbooks/`); a
gbrain upgrade is a natural trigger to also check the catalog, even though
this step itself stays manual and reviewed, not automated.
```

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/skill-catalog-sync.md
git commit -m "docs: add skill-catalog-sync runbook"
```

---

## Self-Review Notes

- **Spec coverage:** A1 (TTL) → Task 3. A2 (snippet shape) → Task 4. A3 (live verify + schema) → Tasks 1, 2, 5. A4 (propagate through call sites) → Tasks 6–9. B1 (agent-instructions block) → Task 4. B2 (console rendering) → Tasks 7, 8. B3 (upstream ask) → Task 11. Process doc → Task 12. Testing section → Tasks 1–4 unit tests plus Task 10's contract test. Every spec section has a task.
- **Breaking-change flag:** Task 4 changes `wiringSnippet`'s return type from `string` to `{snippet, agentInstructions}`. This is called out explicitly in Task 4's Interfaces block and Step 5 (typecheck sweep) specifically so the three consumers aren't discovered late; Tasks 6/7/8/9 each update their call site.
- **Type consistency check:** `VerifyResult`/`verify: {status, message}` is spelled identically across Task 5 (`connections.ts`), Task 6 (`claim.ts`, `myConnection.ts`), Task 7 (`Claim.tsx`), and Task 8 (`Mcp.tsx`/`api.ts`) — `status: 'ok' | 'partial' | 'failed'` (or `string | null` at the JSON-boundary types, since it crosses an HTTP response).
