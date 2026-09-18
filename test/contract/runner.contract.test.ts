/**
 * Gate A — the Slice 4 seam, headless (`test/contract/runner.contract.test.ts`, A1–A10).
 *
 * What a contract test may assert, and why this file is where Task 15's legs live. Every boundary
 * Slice 4 added is pinned here against the artifact that actually carries the fact:
 *
 *   - the PURE seam (`buildHarnessArgv`, `allowedToolsFor`, `parseStreamJson`, `priceUsage`,
 *     `classifyAgentExit`, `retryPolicyFor`, `verifyHarnessPin`) runs in this process, with no
 *     container and no HTTP surface, exactly as `test/contract/upgrade.contract.test.ts` tests the
 *     emitted operations.json rather than a live RPC where a value would do;
 *   - the frames A3 parses are the ones `docs/slice-4-findings.md` captured VERBATIM (P2-a, P2-b,
 *     P8). Not one of them is invented here, because an invented frame proves the parser agrees with
 *     itself;
 *   - the two facts source text cannot carry are exercised for real: the registry operations the
 *     token lane depends on run against gbrain at the pin (`execOperation`, the slice0 harness —
 *     the same discipline `mcp-grant.contract.test.ts` / `revoke.contract.test.ts` follow), and
 *     `/fileplane/delete-credential-journal` runs against a really spawned ops server (the harness
 *     `test/integration/ops-server.test.ts` shows how);
 *   - `assertBudget`'s cap boundary and `claimNextRun`'s job-type filter run against the scratch
 *     control Postgres, because both are DB decisions and neither has a pure form.
 *
 * Where a leg could not discriminate, it says so in place rather than passing quietly — a probe that
 * cannot tell the two outcomes apart is not evidence (the cautionary tale of Slice 3.5's P2).
 *
 * L2: `CONTROL_DATABASE_URL` is defaulted in this file's own header, never required as an export.
 */
import { test, expect, describe, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { buildHarnessArgv, isErrorFrame, normalizeEvent, parseStreamJson } from '../../src/runner/harness.ts';
import { PRODUCT_TOOL_ALLOWLIST, TOOL_PREFIX, allowedToolsFor } from '../../src/agent/tools.ts';
import { MODEL_PRICING, PRICED_AT, priceUsage } from '../../src/gateway/pricing.ts';
import { classifyAgentExit, retryPolicyFor } from '../../src/agent/classify.ts';
import { HARNESS_PIN, verifyHarnessPin } from '../../src/runner/pin.ts';
import { GBRAIN_PIN, capabilityPath } from '../../src/contracts/pin.ts';
import { parseGbrainVersion, toolNames } from '../../src/contracts/capability.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { buildArgv } from '../../src/contracts/argv.ts';
import { execOperation, assertOk } from '../../src/contracts/exec.ts';
import { BRAIN_DB_URL, composeDown, composeExec, composeUp, resetBrain, seedGitSource } from '../helpers/stack.ts';
import { mcpUrl } from '../../src/control/connections.ts';
import type { CapabilitySnapshot } from '../../src/contracts/capability.ts';
import type { UsageCounts } from '../../src/gateway/pricing.ts';
import type { AgentRunClaim, FailureClass } from '../../src/agent/types.ts';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(48);
process.env.CONTROL_DATABASE_URL ??= 'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';

/** Every leg here is a local call: an in-process function, a scratch Postgres on localhost, or a
 *  container exec. 30s is far above any of them and turns a wedged query into a named failure rather
 *  than a suite that never ends. The docker legs state their own, longer timeouts. */
setDefaultTimeout(30_000);

/** The control-DB half: the meter and the claim select are DB decisions, so they are imported late
 *  (after the env defaults above — a module that read `CONTROL_DATABASE_URL` at load would see a hole). */
const { GatewayRefusal, accruedCost, assertBudget, recordUsage } = await import('../../src/gateway/meter.ts');
const { closeDb, getDb, pinDb, runMigrations, schema } = await import('../../src/control/db/client.ts');
const { JOB_TYPES, claimNextRun } = await import('../../src/scheduler/claim.ts');

// ===========================================================================
// Shared fixtures and helpers.
// ===========================================================================

/** The model P2 actually observed (`system/init`: the alias `haiku` resolves to a dated id). */
const HAIKU = 'claude-haiku-4-5';
const DATED_HAIKU = 'claude-haiku-4-5-20251001';

/** The built-in surface of the pinned binary, as `buildHarnessArgv` emits it. */
const DISALLOWED_BUILTINS = [
  'Bash', 'CronCreate', 'CronDelete', 'CronList', 'Edit', 'EnterWorktree', 'ExitWorktree',
  'ListAgents', 'NotebookEdit', 'Read', 'ReportFindings', 'ScheduleWakeup', 'SendMessage',
  'Skill', 'Task', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'TaskUpdate',
  'WebFetch', 'WebSearch', 'Workflow', 'Write',
];

/** P2-a's `usage`, verbatim from `docs/slice-4-findings.md` — the counts every price assertion uses. */
const P2A_USAGE = {
  input_tokens: 10,
  cache_creation_input_tokens: 6922,
  cache_read_input_tokens: 13607,
  output_tokens: 54,
  cache_creation: { ephemeral_1h_input_tokens: 6922, ephemeral_5m_input_tokens: 0 },
};

/** The harness's own `result.total_cost_usd` for that run (P2-a). A hint (F9), used here only to
 *  calibrate the table against the frame it was derived from. */
const P2A_REPORTED_COST = 0.0154847;

function repoFile(rel: string): string {
  return readFileSync(join(import.meta.dir, '..', '..', rel), 'utf8');
}

/** `check('name', sql\`…\`)` — the tuple a CHECK permits, read from the schema that declares it. */
function parseCheckValues(schemaText: string, checkName: string): string[] {
  const at = schemaText.indexOf(`check('${checkName}'`);
  if (at < 0) throw new Error(`no check('${checkName}') in the control schema`);
  const start = schemaText.indexOf('`', at);
  const end = schemaText.indexOf('`', start + 1);
  if (start < 0 || end < 0) throw new Error(`check('${checkName}') is not a template literal`);
  return [...schemaText.slice(start + 1, end).matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/** The values a `jobTypes: [...]` call site passes, read from the consumer that passes them. */
function parseJobTypeLiterals(sourceText: string): string[] {
  return [...sourceText.matchAll(/jobTypes:\s*\[([^\]]*)\]/g)]
    .flatMap((m) => [...m[1]!.matchAll(/'([^']+)'/g)].map((v) => v[1]!));
}

/** D5's totality + exclusivity question, as one function so the negative arm uses the SAME logic:
 *  every value the CHECK permits must be claimed by at least one consumer. */
function uncoveredJobTypes(permitted: readonly string[], claimedByConsumers: readonly string[]): string[] {
  const claimed = new Set(claimedByConsumers);
  return permitted.filter((type) => !claimed.has(type));
}

/** `export type X = 'a' | 'b';` — the members of a union the compiler erases. */
function parseUnionMembers(sourceText: string, typeName: string): string[] {
  const m = new RegExp(`export type ${typeName}\\s*=\\s*([^;]+);`).exec(sourceText);
  if (!m) throw new Error(`no \`export type ${typeName}\` in the source`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((v) => v[1]!);
}

/** Is `docker compose` usable at all? Mirrors the e2e and Slice 3.5 suites' probe. */
async function probeDockerCompose(): Promise<boolean> {
  try {
    const p = Bun.spawn(['docker', 'compose', 'version'], { stdout: 'pipe', stderr: 'pipe' });
    return (await p.exited) === 0;
  } catch { return false; }
}
const dockerAvailable = await probeDockerCompose();

/** The same snapshot with one tool removed, keeping the catalog in the encoding it arrived in — a
 *  re-encoded array would test `toolNames` rather than the intersection that is A2's subject. */
function withoutTool(snapshot: CapabilitySnapshot, name: string): CapabilitySnapshot {
  const tools = snapshot.tools;
  if (Array.isArray(tools)) {
    return {
      ...snapshot,
      tools: tools.filter((t) => (t as { name?: string } | null)?.name !== name),
    };
  }
  if (tools && typeof tools === 'object') {
    const copy = { ...(tools as Record<string, unknown>) };
    delete copy[name];
    return { ...snapshot, tools: copy };
  }
  return snapshot;
}

// ===========================================================================
// A1 — buildHarnessArgv: the exact argv, and the refusals that come before a process exists.
// ===========================================================================
describe('A1 buildHarnessArgv', () => {
  /** A representative claim: the shape `POST /api/runs/claim` hands the runner. */
  const CLAIM: AgentRunClaim = {
    runId: '11111111-2222-3333-4444-555555555555',
    scheduleId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    attempt: 1,
    prompt: 'Use mcp__gbrain__get_page on `ops/runbook` and reply with only its first line.',
    model: HAIKU,
    maxTokens: 1024,
    harnessVersion: HARNESS_PIN,
    // Deliberately unsorted: the argv must carry what the claim carried.
    allowedTools: [`${TOOL_PREFIX}put_page`, `${TOOL_PREFIX}get_page`, `${TOOL_PREFIX}search`],
    mcp: { url: 'https://localhost/mcp', token: 'gbrain-run-token-not-a-real-secret' },
    gateway: { url: 'https://localhost/api/gateway', token: 'gateway-token-not-a-real-secret' },
    budgetUsd: 0.25,
    timeoutSeconds: 300,
    leaseExpiresAt: '2026-09-17T00:05:00.000Z',
  };

  test('the exact argv for a representative claim', () => {
    const argv = buildHarnessArgv(CLAIM);
    const mcpConfig = JSON.stringify({
      mcpServers: {
        gbrain: {
          type: 'http',
          url: CLAIM.mcp.url,
          headers: { Authorization: `Bearer ${CLAIM.mcp.token}` },
        },
      },
    });

    expect(argv).toEqual([
      // F2: `-p` with stream-json exits 1 without --verbose; the flag sits with the prompt it explains.
      '-p', CLAIM.prompt,
      '--verbose',
      '--output-format', 'stream-json',
      '--model', HAIKU,
      // F3: the built-in surface is removed at the source, not merely fenced.
      '--tools', '',
      '--disallowedTools', DISALLOWED_BUILTINS.join(','),
      '--permission-mode', 'dontAsk',
      '--permission-prompts', 'none',
      '--allowedTools', CLAIM.allowedTools.join(','),
      '--mcp-config', mcpConfig,
      '--strict-mcp-config',
      '--max-budget-usd', '0.25',
    ]);
  });

  test('the flags the findings make mandatory are present, in the shape that works', () => {
    const argv = buildHarnessArgv(CLAIM);
    // F2 — observed, not assumed: without it the pinned binary exits 1 on this exact flag set.
    expect(argv[argv.indexOf('-p') + 2]).toBe('--verbose');
    // F3 — `--tools ""` narrows the surface to the MCP allowlist, and `--disallowedTools` stays as
    // defence in depth behind it (D5, honesty rule 2).
    expect(argv[argv.indexOf('--tools') + 1]).toBe('');
    // The flag is VARIADIC: a comma-joined list in ONE element, or the next flag becomes a tool name.
    const allowed = argv[argv.indexOf('--allowedTools') + 1]!;
    expect(allowed).toBe(CLAIM.allowedTools.join(','));
    expect(allowed).not.toContain(' ');
    // The run's bearer crosses in the MCP config (P4: sent byte for byte, no OAuth dance) ...
    expect(JSON.parse(argv[argv.indexOf('--mcp-config') + 1]!)).toEqual({
      mcpServers: {
        gbrain: {
          type: 'http',
          url: CLAIM.mcp.url,
          headers: { Authorization: `Bearer ${CLAIM.mcp.token}` },
        },
      },
    });
    // ... and NEVER in argv, where any `ps` inside the container could read the gateway token (F5).
    expect(argv.join(' ')).not.toContain(CLAIM.gateway.token);
    expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe(String(CLAIM.budgetUsd));
  });

  test('a prompt containing spaces and newlines is still exactly one element', () => {
    const prompt = 'line one\n--tools "Bash"\nrm -rf /';
    const argv = buildHarnessArgv({ ...CLAIM, prompt });
    expect(argv.filter((a) => a === prompt)).toHaveLength(1);
    expect(argv[argv.indexOf('-p') + 1]).toBe(prompt);
    // No shell string anywhere (G2): the injected text reached no other element.
    expect(argv.filter((a) => a.includes('rm -rf /'))).toHaveLength(1);
  });

  test('an empty allowlist is refused, with the reason named', () => {
    // The refusal is a THROW naming the reason — not a truthiness check on the return value. A claim
    // with no tools cannot do its job, and it must fail here rather than silently do nothing.
    expect(() => buildHarnessArgv({ ...CLAIM, allowedTools: [] }))
      .toThrow(/refusing claim: allowedTools is empty, and a run with no tools cannot do its job/);
    expect(() => buildHarnessArgv({ ...CLAIM, allowedTools: ['', '  '] }))
      .toThrow(/allowedTools is empty/);
  });

  test('a tool outside the closed list is refused, and F11 names the trap', () => {
    // F11: `delete_page` is in the real grant's allowedOperations and NOT on the granted MCP surface.
    // A claim that named it would burn its budget learning the server rejects it.
    expect(() => buildHarnessArgv({ ...CLAIM, allowedTools: [`${TOOL_PREFIX}delete_page`] }))
      .toThrow(/refusing claim: mcp__gbrain__delete_page is not on the closed gbrain tool list/);
    expect(() => buildHarnessArgv({ ...CLAIM, allowedTools: ['Bash'] }))
      .toThrow(/refusing claim: Bash is not on the closed gbrain tool list/);
  });

  test('every other precondition is refused by name, before a process exists', () => {
    expect(() => buildHarnessArgv({ ...CLAIM, prompt: '  ' })).toThrow(/prompt is empty/);
    expect(() => buildHarnessArgv({ ...CLAIM, model: '' })).toThrow(/model is empty/);
    expect(() => buildHarnessArgv({ ...CLAIM, mcp: { ...CLAIM.mcp, url: '' } })).toThrow(/mcp\.url is empty/);
    expect(() => buildHarnessArgv({ ...CLAIM, mcp: { ...CLAIM.mcp, token: '' } })).toThrow(/mcp\.token is empty/);
    expect(() => buildHarnessArgv({ ...CLAIM, budgetUsd: 0 })).toThrow(/budgetUsd is not positive \(0\)/);
    expect(() => buildHarnessArgv({ ...CLAIM, budgetUsd: Number.NaN }))
      .toThrow(/budgetUsd is not positive/);
  });
});

// ===========================================================================
// A2 — allowedToolsFor is the intersection with the SURFACE, never with the grant.
// ===========================================================================
describe('A2 allowedToolsFor', () => {
  /** The real catalog at the pin (`gbrain --tools-json`), the same artifact
   *  `capability_snapshots.tools_json` holds — not a hand-written tool list. */
  const SNAPSHOT: CapabilitySnapshot = (() => {
    const doc = JSON.parse(readFileSync(capabilityPath(GBRAIN_PIN), 'utf8')) as CapabilitySnapshot;
    expect(doc.gbrainVersion).toBe(GBRAIN_PIN);
    return doc;
  })();
  const CATALOG = toolNames(SNAPSHOT.tools);

  test('the pin\'s catalog is the input, and it is large enough for the intersection to mean something', () => {
    expect(CATALOG.length).toBeGreaterThan(50);
    // Every name the product list would grant must exist at the pin, or the allowlist is empty.
    for (const tool of PRODUCT_TOOL_ALLOWLIST) expect(CATALOG).toContain(tool);
  });

  test('the result is exactly (product allowlist ∩ the pin\'s catalog), fully qualified and sorted', () => {
    const tools = allowedToolsFor(null, SNAPSHOT);
    const expected = PRODUCT_TOOL_ALLOWLIST
      .filter((t) => CATALOG.includes(t))
      .map((t) => `${TOOL_PREFIX}${t}`)
      .sort();
    expect(tools).toEqual(expected);
    expect(tools.length).toBe(PRODUCT_TOOL_ALLOWLIST.length);
  });

  test('F11: a tool the server rejects is excluded even though the SURFACE does not have to exclude it', () => {
    // The measured premise, re-asserted here rather than assumed: the pin's full catalog carries
    // `delete_page` (136 operations), while a Connection's granted surface does not.
    expect(CATALOG).toContain('delete_page');
    // The product list is curated against that measured surface, so the result never names it ...
    expect(allowedToolsFor(null, SNAPSHOT)).not.toContain(`${TOOL_PREFIX}delete_page`);
    // ... and nothing outside the closed list can appear, whatever the catalog holds.
    for (const qualified of allowedToolsFor(null, SNAPSHOT)) {
      expect(PRODUCT_TOOL_ALLOWLIST).toContain(qualified.slice(TOOL_PREFIX.length));
    }
  });

  test('an upstream REMOVAL narrows the allowlist: the snapshot half is really read', () => {
    // A catalog missing `search` yields an allowlist without it, even though the product list has it.
    // If the function ignored the snapshot, this call would still name `search`.
    const tools = allowedToolsFor(null, withoutTool(SNAPSHOT, 'search'));
    expect(tools).not.toContain(`${TOOL_PREFIX}search`);
    expect(tools).toContain(`${TOOL_PREFIX}put_page`); // the rest survive
  });

  test('the GRANT cannot widen the surface: allowedOperations is not an input', () => {
    // F11's discriminator. The token lane's grant lists `delete_page` in `allowedOperations` while the
    // granted MCP surface does not carry it. A grant-shaped connection object is passed here with a
    // catalog that has LOST `search`: an implementation that intersected with `allowedOperations`
    // would name `search` (and `delete_page`); the surface decides, so neither appears.
    const narrowed = withoutTool(SNAPSHOT, 'search');
    const grantShaped = {
      profile: 'memory-writer',
      allowedOperations: [...PRODUCT_TOOL_ALLOWLIST, 'delete_page', 'forget', 'add_link'],
      boundTools: [...PRODUCT_TOOL_ALLOWLIST, 'delete_page'],
    } as unknown as { profile?: string | null };
    const tools = allowedToolsFor(grantShaped, narrowed);
    expect(tools).not.toContain(`${TOOL_PREFIX}search`);
    expect(tools).not.toContain(`${TOOL_PREFIX}delete_page`);
    expect(tools).toEqual(allowedToolsFor(null, narrowed)); // the grant changed nothing
  });

  test('a memory-reader Connection cannot be handed the write tool', () => {
    const reader = allowedToolsFor({ profile: 'memory-reader' }, SNAPSHOT);
    expect(reader).not.toContain(`${TOOL_PREFIX}put_page`);
    expect(allowedToolsFor({ profile: 'memory-writer' }, SNAPSHOT)).toContain(`${TOOL_PREFIX}put_page`);
  });

  test('empty-safe: a missing or unreadable snapshot yields the empty list, never a guessed one', () => {
    // The catalog is the half of the intersection we cannot invent (`tools.ts`). Empty is legal here;
    // A1 is where it becomes a refusal rather than a harness with no tools.
    expect(allowedToolsFor(null, null)).toEqual([]);
    expect(allowedToolsFor(null, undefined)).toEqual([]);
    expect(allowedToolsFor(null, { ...SNAPSHOT, tools: null })).toEqual([]);
    expect(allowedToolsFor(null, { ...SNAPSHOT, tools: [] })).toEqual([]);
    // And the empty list is refused by the argv builder, so the two halves compose.
    expect(() => buildHarnessArgv({
      runId: 'r', scheduleId: 's', attempt: 1, prompt: 'p', model: HAIKU, maxTokens: 1,
      harnessVersion: HARNESS_PIN, allowedTools: allowedToolsFor(null, null),
      mcp: { url: 'https://localhost/mcp', token: 't' },
      gateway: { url: 'https://localhost/api/gateway', token: 'g' },
      budgetUsd: 1, timeoutSeconds: 60, leaseExpiresAt: '2026-09-17T00:05:00.000Z',
    })).toThrow(/allowedTools is empty/);
  });
});

// ===========================================================================
// A3 — parseStreamJson over the frames P2 captured, plus the partial final line.
// ===========================================================================
describe('A3 parseStreamJson', () => {
  /** P2-a's `result` frame, transcribed value for value from the findings doc. */
  const P2A_RESULT = {
    duration_api_ms: 1868,
    stop_reason: 'end_turn',
    session_id: '8d003c68-24a3-44d7-ba4a-47c4529a60a3',
    total_cost_usd: P2A_REPORTED_COST,
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 6922,
      cache_read_input_tokens: 13607,
      output_tokens: 54,
      output_tokens_details: { thinking_tokens: 27 },
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: 'standard',
      cache_creation: { ephemeral_1h_input_tokens: 6922, ephemeral_5m_input_tokens: 0 },
      inference_geo: 'not_available',
      iterations: [{
        input_tokens: 10, output_tokens: 54, cache_read_input_tokens: 13607,
        cache_creation_input_tokens: 6922,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 6922 },
        type: 'message',
      }],
      speed: 'standard',
    },
    modelUsage: {
      [DATED_HAIKU]: {
        inputTokens: 10, outputTokens: 54, cacheReadInputTokens: 13607,
        cacheCreationInputTokens: 6922, webSearchRequests: 0, costUSD: P2A_REPORTED_COST,
        contextWindow: 200000, maxOutputTokens: 32000, thinkingTokens: 27,
        canonicalModel: HAIKU, provider: 'firstParty', costBasis: 'list',
      },
    },
    permission_denials: [],
    terminal_reason: 'completed',
    fast_mode_state: 'off',
    fast_mode_disabled_reason: 'sdk_opt_in_required',
    is_error: false,
    num_turns: 1,
    subtype: 'success',
    api_error_status: null,
    result: 'Hey! 👋 Ready to help you with whatever you\'re working on. What\'s up?',
    ttft_ms: 1681, type: 'result', duration_ms: 2003,
    ttft_stream_ms: 1424, time_to_request_ms: 133, first_content_frame_ms: 1425,
    queued_turn_count: 0, result_index: 0,
  };

  /** P2-b's `tool_use` assistant frame, verbatim from the findings doc. */
  const P2B_TOOL_USE = {
    type: 'assistant',
    message: {
      model: DATED_HAIKU,
      id: 'msg_011Cf9Ba2m9e8RkHqr7MKL7V',
      type: 'message', role: 'assistant',
      content: [{
        type: 'tool_use', id: 'toolu_01HjZUDZEfYKhEJjkd3sPqo4', name: 'Read',
        input: { file_path: '/tmp/probe/notes.txt' }, caller: { type: 'direct' },
      }],
      stop_reason: null, stop_sequence: null,
      usage: {
        input_tokens: 10, cache_creation_input_tokens: 3032,
        cache_read_input_tokens: 17512,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3032 },
        output_tokens: 3, service_tier: 'standard', inference_geo: 'not_available',
      },
    },
    parent_tool_use_id: null,
    session_id: '54726187-4936-48eb-85ac-31e712e71bf6',
    uuid: '698a02ba-192e-479d-bd61-2370fd474de9',
    timestamp: '2026-09-17T14:38:48.693Z',
    request_id: 'req_011Cf9Ba2Gt6M1WCV3oX9s43',
    wire_tool_inputs: { toolu_01HjZUDZEfYKhEJjkd3sPqo4: { file_path: '/tmp/probe/notes.txt' } },
  };

  /** P2-b's tool RESULT frame: it arrives on a `user` frame, never an assistant one. */
  const P2B_TOOL_RESULT = {
    type: 'user',
    message: {
      role: 'user',
      content: [{
        tool_use_id: 'toolu_01HjZUDZEfYKhEJjkd3sPqo4',
        type: 'tool_result',
        content: '1\tPROBE-LINE-ALPHA\n2\tsecond line\n3\t',
      }],
    },
    tool_use_result: {
      type: 'text',
      file: {
        filePath: '/tmp/probe/notes.txt', content: 'PROBE-LINE-ALPHA\nsecond line\n',
        numLines: 3, startLine: 1, totalLines: 3,
      },
    },
  };

  /** P8's `put_page` result, verbatim — the F10 frame: a SUCCESSFUL write that reports
   *  `status: "skipped"` with `write_through.written: true`. The envelope is P2-b's tool-result
   *  shape, because that is the only place a tool's output appears in the stream. */
  const P8_PUT_PAGE = {
    slug: 'probe-runner/p8-probe',
    status: 'skipped',
    chunks: 0,
    chunk_skip_reason: 'write_skipped',
    // The three `hint` strings are elided with "…" in the findings doc; they are transcribed here
    // without the ellipsis and no assertion reads them. Every other value is verbatim.
    auto_links: { skipped: 'remote', hint: 'auto_link/auto_timeline run for trusted local writers only' },
    auto_timeline: { skipped: 'remote', hint: 'remote writer' },
    facts_backstop: { skipped: 'slug_bound_client' },
    chronicle_backstop: { skipped: 'not_imported' },
    write_through: { written: true, path: '/srv/brain-repos/shared/probe-runner/p8-probe.md' },
  };
  const P8_WRITE_FRAME = {
    type: 'user',
    message: {
      role: 'user',
      content: [{
        tool_use_id: 'toolu_01HjZUDZEfYKhEJjkd3sPqo4',
        type: 'tool_result',
        content: JSON.stringify(P8_PUT_PAGE),
      }],
    },
    tool_use_result: P8_PUT_PAGE,
  };

  const line = (frame: unknown) => `${JSON.stringify(frame)}\n`;

  test('a chunk split mid-frame yields no half-frame, and the frame arrives exactly once', () => {
    const full = line(P2B_TOOL_USE);
    const cut = Math.floor(full.length / 2);

    const first = parseStreamJson(full.slice(0, cut));
    expect(first.frames).toEqual([]);            // nothing half-parsed is ever emitted
    expect(first.badLines).toEqual([]);          // ... and the tail is not reported as garbage
    expect(first.carry).toBe(full.slice(0, cut));

    const second = parseStreamJson(full.slice(cut), first.carry);
    expect(second.frames).toEqual([P2B_TOOL_USE]);
    expect(second.badLines).toEqual([]);
    expect(second.carry).toBe('');
  });

  test('frames keep their order across a chunk that holds several', () => {
    const chunk = line(P2B_TOOL_USE) + line(P2B_TOOL_RESULT) + line(P2A_RESULT);
    const parsed = parseStreamJson(chunk);
    expect(parsed.frames).toEqual([P2B_TOOL_USE, P2B_TOOL_RESULT, P2A_RESULT]);
    expect(parsed.badLines).toEqual([]);
    expect(parsed.carry).toBe('');
  });

  test('a partial FINAL line survives to the flush, and the flush does not duplicate it', () => {
    // stdout that ends without a trailing newline still ends with a frame.
    const withoutNewline = JSON.stringify(P2A_RESULT);
    const mid = parseStreamJson(withoutNewline);
    expect(mid.frames).toEqual([]);
    expect(mid.carry).toBe(withoutNewline);

    const flushed = parseStreamJson('\n', mid.carry);
    expect(flushed.frames).toEqual([P2A_RESULT]);
    expect(flushed.carry).toBe('');

    // A genuinely truncated frame at EOF is reported as a bad line, never dropped: a receipt with a
    // hole in it is not a receipt (honesty rule 11).
    const truncated = parseStreamJson('\n', JSON.stringify(P2A_RESULT).slice(0, 40));
    expect(truncated.frames).toEqual([]);
    expect(truncated.badLines).toHaveLength(1);
  });

  test('F2\'s own error line is reported, and the frame that follows it still parses', () => {
    const stderrLike = 'Error: When using --print, --output-format=stream-json requires --verbose';
    const parsed = parseStreamJson(`${stderrLike}\n${line(P2B_TOOL_USE)}\n`);
    expect(parsed.frames).toEqual([P2B_TOOL_USE]);
    expect(parsed.badLines).toEqual([stderrLike]);
  });

  test('the tool result is read off the `user` frame, where P2-b measured it lives', () => {
    const [frame] = parseStreamJson(line(P2B_TOOL_RESULT)).frames;
    const record = frame as { type?: string; tool_use_result?: { file?: { content?: string } } };
    expect(record.type).toBe('user');
    expect(record.tool_use_result?.file?.content).toBe('PROBE-LINE-ALPHA\nsecond line\n');
    // The discriminator: a parser that switches only on `assistant`/`result` drops exactly this.
    const assistantOnly = parseStreamJson(line(P2B_TOOL_USE)).frames;
    expect(JSON.stringify(assistantOnly)).not.toContain('PROBE-LINE-ALPHA');
  });

  test('F10: a successful write that reports status "skipped" is not a failure', () => {
    const [frame] = parseStreamJson(line(P8_WRITE_FRAME)).frames;
    expect(frame).toEqual(P8_WRITE_FRAME);
    expect(isErrorFrame(frame)).toBe(false);

    // The positive control, so the false above means something: a `result` frame that DID report an
    // error is a failure (P2-a's frame with its one measured field flipped, and the harness's own
    // error frame type).
    expect(isErrorFrame({ ...P2A_RESULT, is_error: true })).toBe(true);
    expect(isErrorFrame({ type: 'error', error: 'something' })).toBe(true);
    expect(isErrorFrame(P2A_RESULT)).toBe(false);
    // A tool that failed is the model's business, not the run's: it sees the error and recovers.
    expect(isErrorFrame({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', is_error: true, content: 'boom' }] },
    })).toBe(false);

    // Honesty rule 1, cross-wired to the classifier: exit 0 with no error frames is a SUCCESS even
    // though the write reported `status: "skipped"` (F10).
    const frames = parseStreamJson(line(P2B_TOOL_USE) + line(P8_WRITE_FRAME) + line(P2A_RESULT)).frames;
    const errorFrames = frames.filter(isErrorFrame).length;
    expect(errorFrames).toBe(0);
    expect(classifyAgentExit({ exitCode: 0, errorFrames })).toBeNull();
  });

  test('normalizeEvent keeps the vocabulary P2 measured, redacted rather than dropped', () => {
    expect(normalizeEvent(P2B_TOOL_USE, 0)).toMatchObject({ seq: 0, kind: 'assistant' });
    expect(normalizeEvent(P2B_TOOL_RESULT, 1)).toMatchObject({ seq: 1, kind: 'user' });
    // `result` is one shape whose subtype is a FIELD; only `system` frames are qualified.
    expect(normalizeEvent(P2A_RESULT, 2)).toMatchObject({ seq: 2, kind: 'result' });
    // `system/init` and `system/thinking_tokens` are two of the eight measured shapes (P2-a/P2-b's
    // frame order); the type/subtype pair is what the kind rule reads.
    expect(normalizeEvent({ type: 'system', subtype: 'thinking_tokens' }, 3))
      .toMatchObject({ seq: 3, kind: 'system/thinking_tokens' });
    expect(normalizeEvent({ type: 'system', subtype: 'init' }, 4))
      .toMatchObject({ seq: 4, kind: 'system/init' });
    // A shape a future harness adds is recorded as itself, never dropped.
    expect(normalizeEvent({ type: 'whatever_next' }, 5)).toMatchObject({ seq: 5, kind: 'whatever_next' });
  });
});

// ===========================================================================
// A4 — priceUsage: five rates, the 1h/5m split, and null for a model we cannot price.
// ===========================================================================
describe('A4 priceUsage', () => {
  test('a known model, from P2-a\'s captured counts — the table reproduces the frame it came from', () => {
    const priced = priceUsage(HAIKU, P2A_USAGE);
    expect(priced).toBe(P2A_REPORTED_COST);
    // The alias resolves to a dated id (P2), and the dated id must price identically.
    expect(priceUsage(DATED_HAIKU, P2A_USAGE)).toBe(P2A_REPORTED_COST);
    expect(priceUsage('claude-haiku-4-5-20250101', P2A_USAGE)).toBe(P2A_REPORTED_COST);
    // P9's own arithmetic: 10*1 + 54*5 + 6922*2 (the 1h rate) + 13607*0.1 = 15484.7 per-MTok units.
    expect(priced).toBe(15484.7 / 1e6);
  });

  test('an unknown model is null, never 0', () => {
    expect(priceUsage('claude-haiku-3', P2A_USAGE)).toBeNull();
    expect(priceUsage('gpt-4o', P2A_USAGE)).toBeNull();
    expect(priceUsage('', P2A_USAGE)).toBeNull();
    // null is not 0: a cost we could not price is not a cost of zero (honesty rule 3).
    expect(priceUsage('gpt-4o', P2A_USAGE)).not.toBe(0);
    expect(priceUsage('gpt-4o', null)).toBeNull();
    expect(MODEL_PRICING.models).not.toHaveProperty('gpt-4o');
  });

  test('the 1-hour cache-write rate is distinct from the 5-minute one', () => {
    const asFiveMinute = {
      ...P2A_USAGE,
      cache_creation: { ephemeral_5m_input_tokens: 6922, ephemeral_1h_input_tokens: 0 },
    };
    const oneHour = priceUsage(HAIKU, P2A_USAGE)!;
    const fiveMinutes = priceUsage(HAIKU, asFiveMinute)!;

    expect(fiveMinutes).toBe(0.0102932);
    expect(oneHour).not.toBe(fiveMinutes);
    // The entire difference is 6,922 tokens at ($2 - $1.25) per MTok — the rate pair, not a rounding.
    expect(oneHour - fiveMinutes).toBeCloseTo(0.0051915, 7);
    expect(MODEL_PRICING.models[HAIKU].cacheWrite1h).toBe(2);
    expect(MODEL_PRICING.models[HAIKU].cacheWrite5m).toBe(1.25);

    // P9's undercount, reproduced from these counts: pricing the 1h write at the 5m rate.
    expect(1 - fiveMinutes / oneHour).toBeCloseTo(0.335, 3);
    // The reverse direction, on the same counts: pricing a 5m write at the 1h rate.
    // P9 quotes 54.8% for the reverse; the captured P2-a counts give 50.4%, and the number that
    // reproduces is stated here so a reader can check it rather than take it. (Reported in the
    // worker's answer: the 54.8% figure is not reproducible from P2-a's counts.)
    expect((oneHour - fiveMinutes) / fiveMinutes).toBeCloseTo(0.504, 3);
  });

  test('the split is read, and the sum is the fallback only when the split is absent', () => {
    // `cache_creation_input_tokens` is the SUM of the two and is what a frame without the split has:
    // priced at the 5m rate (P9's rule), which is exactly what the frame costs.
    const noSplit = {
      input_tokens: 10,
      output_tokens: 54,
      cache_read_input_tokens: 13607,
      cache_creation_input_tokens: 6922,
    };
    expect(priceUsage(HAIKU, noSplit)).toBe(0.0102932);
    // A frame with BOTH the sum and the split is priced off the split — the sum is ignored.
    expect(priceUsage(HAIKU, { ...noSplit, cache_creation: { ephemeral_1h_input_tokens: 6922 } }))
      .toBe(0.0154847);
  });

  test('the table is a pinned table with a date, not a live lookup', () => {
    expect(MODEL_PRICING.pricedAt).toBe('2026-09-17'); // P9's read of the pricing page
    expect(PRICED_AT).toBe(MODEL_PRICING.pricedAt); // the exported name and the table cannot drift
    expect(MODEL_PRICING.source).toMatch(/^https:\/\/platform\.claude\.com\//);
    for (const rate of Object.values(MODEL_PRICING.models)) {
      expect(rate.cacheWrite1h).toBeGreaterThan(rate.cacheWrite5m);
      expect(rate.cacheWrite5m).toBeGreaterThan(rate.input);
      expect(rate.cacheRead).toBeLessThan(rate.input);
    }
  });
});

// ===========================================================================
// A6 — classifyAgentExit: the separate mapper, and the union it must NOT have widened.
// ===========================================================================
describe('A6 classifyAgentExit', () => {
  const EXECUTE_SRC = repoFile('src/scheduler/execute.ts');
  const TYPES_SRC = repoFile('src/agent/types.ts');
  const SCHEMA_SRC = repoFile('src/control/db/schema.ts');

  /** `Classification` and `SEVERITY` are total over each other in `execute.ts`; both are read from
   *  the source rather than trusted to the plan, because a widened union silently reorders Slice 3's
   *  "worse of the two steps" verdict. */
  const CLASSIFICATION = parseUnionMembers(EXECUTE_SRC, 'Classification');
  const SEVERITY_KEYS = (() => {
    const at = EXECUTE_SRC.indexOf('const SEVERITY: Record<Classification, number>');
    if (at < 0) throw new Error('SEVERITY is gone from src/scheduler/execute.ts');
    const body = EXECUTE_SRC.slice(at, EXECUTE_SRC.indexOf('};', at));
    return [...body.matchAll(/(\w+):\s*\d+/g)].map((m) => m[1]!);
  })();
  const FAILURE_CLASS = parseUnionMembers(TYPES_SRC, 'FailureClass');
  const FAILURE_CHECK = parseCheckValues(SCHEMA_SRC, 'agent_failure_class_valid');

  test('the scheduler\'s Classification union and its SEVERITY map are unchanged and total', () => {
    expect(CLASSIFICATION).toEqual([
      'ok', 'failed', 'blocked', 'conflict', 'lock_lost', 'timeout', 'cancelled', 'refused',
    ]);
    expect([...SEVERITY_KEYS].sort()).toEqual([...CLASSIFICATION].sort());
    expect(SEVERITY_KEYS).toHaveLength(CLASSIFICATION.length); // no duplicate keys either
  });

  test('the agent vocabulary did not leak into the scheduler\'s union', () => {
    for (const agentOnly of ['agent_failed', 'infra_failed', 'budget_exceeded']) {
      expect(CLASSIFICATION).not.toContain(agentOnly);
    }
    expect(FAILURE_CLASS).toEqual([
      'budget_exceeded', 'agent_failed', 'infra_failed', 'timeout', 'refused',
    ]);
    // No failure class means success, and success has no class: `ok` is not in the vocabulary.
    expect(FAILURE_CLASS).not.toContain('ok');
    // The column the mapper writes into permits exactly that vocabulary (Task 4's CHECK).
    expect([...FAILURE_CHECK].sort()).toEqual([...FAILURE_CLASS].sort());
  });

  test('every exit path classifies, and every answer is a FailureClass', () => {
    const cases: Array<[string, Parameters<typeof classifyAgentExit>[0], FailureClass | null]> = [
      ['clean exit', { exitCode: 0 }, null],
      ['our own timeout (143 = 128 + SIGTERM)', { exitCode: 143 }, 'timeout'],
      // 4 is LOCK_LOST: "someone else owns this now" is infrastructure, so it retries (D11).
      ['lock lost (4)', { exitCode: 4 }, 'infra_failed'],
      ['no process ever reported a code (-1)', { exitCode: -1 }, 'infra_failed'],
      ['a plain harness failure (1)', { exitCode: 1 }, 'agent_failed'],
      ['a command exit that has no agent meaning (5)', { exitCode: 5 }, 'agent_failed'],
      ['a signal-killed harness (137 = 128 + SIGKILL)', { exitCode: 137 }, 'agent_failed'],
      ['exit 0 but the stream carried an error frame', { exitCode: 0, errorFrames: 1 }, 'agent_failed'],
      ['exit 0 and no error frames', { exitCode: 0, errorFrames: 0 }, null],
      ['a recorded class wins over a non-zero exit (L14)', { exitCode: 1, recorded: 'budget_exceeded' }, 'budget_exceeded'],
      ['a recorded class wins over a timeout (L14)', { exitCode: 143, recorded: 'refused' }, 'refused'],
    ];
    for (const [label, facts, expected] of cases) {
      const got = classifyAgentExit(facts);
      expect({ label, got }).toEqual({ label, got: expected });
      if (got !== null) expect(FAILURE_CLASS).toContain(got);
    }
  });

  test('the mapper never returns a scheduler-only verdict', () => {
    // `failed`, `blocked`, `conflict`, `lock_lost`, `cancelled` are `Classification` values that the
    // agent lane must never store on `agent_runs.failure_class` — the CHECK would reject them.
    const schedulerOnly = CLASSIFICATION.filter((c) => !FAILURE_CLASS.includes(c));
    for (const code of [0, 1, 2, 4, 5, 128, 137, 143]) {
      for (const facts of [{ exitCode: code }, { exitCode: code, errorFrames: 3 }]) {
        const got = classifyAgentExit(facts);
        expect(schedulerOnly).not.toContain(got);
      }
    }
    // The `finalMessage` self-assessment is carried and never read: the stream decides (honesty rule 1).
    expect(classifyAgentExit({
      exitCode: 0, errorFrames: 0, finalMessage: 'I could not complete the task.',
    })).toBeNull();
    expect(classifyAgentExit({
      exitCode: 1, errorFrames: 0, finalMessage: 'All done!',
    })).toBe('agent_failed');
  });
});

// ===========================================================================
// A7 — retryPolicyFor: one retryable class, one cap.
// ===========================================================================
describe('A7 retryPolicyFor', () => {
  test('infra_failed retries, with a cap of 2', () => {
    const first = retryPolicyFor('infra_failed', 1);
    expect(first).toMatchObject({ retry: true, nextAttempt: 2, cap: 2 });
    const second = retryPolicyFor('infra_failed', 2);
    expect(second).toMatchObject({ retry: true, nextAttempt: 3, cap: 2 });
    // The failed attempt AT the cap still retries; the one past it does not. Asserted with plain
    // numbers so the boundary cannot drift by an off-by-one.
    expect(retryPolicyFor('infra_failed', 3)).toMatchObject({ retry: false, nextAttempt: null, cap: 2 });
    expect(retryPolicyFor('infra_failed', 3).reason).toMatch(/cap of 2 retries is spent/);
    expect(retryPolicyFor('infra_failed', 9).retry).toBe(false);
  });

  test('nothing else ever retries — enumerated, not sampled', () => {
    for (const cls of ['budget_exceeded', 'timeout', 'agent_failed', 'refused'] as const) {
      for (const attempt of [1, 2, 3]) {
        const decision = retryPolicyFor(cls, attempt);
        expect({ cls, attempt, retry: decision.retry, nextAttempt: decision.nextAttempt, cap: decision.cap })
          .toEqual({ cls, attempt, retry: false, nextAttempt: null, cap: 0 });
        expect(decision.reason.length).toBeGreaterThan(0);
      }
    }
    // A successful run has nothing to retry either.
    expect(retryPolicyFor(null, 1)).toMatchObject({ retry: false, nextAttempt: null, cap: 0 });
  });

  test('exactly one class in the whole vocabulary retries', () => {
    const retrying = (['budget_exceeded', 'agent_failed', 'infra_failed', 'timeout', 'refused'] as const)
      .filter((cls) => retryPolicyFor(cls, 1).retry);
    expect(retrying).toEqual(['infra_failed']);
  });

  test('an attempt the caller cannot state fails closed', () => {
    expect(retryPolicyFor('infra_failed', Number.NaN).retry).toBe(false);
    expect(retryPolicyFor('infra_failed', Number.POSITIVE_INFINITY).retry).toBe(false);
    expect(retryPolicyFor('infra_failed', 0).retry).toBe(true); // below the cap is still below it
  });
});

// ===========================================================================
// A5 / A9 — the control-DB half. Both are DB decisions with no pure form.
// ===========================================================================
describe('Slice 4 control-DB boundary (A5, A9)', () => {
  const ORG_ID = `gate-a-${randomUUID().slice(0, 8)}`;
  let nowMs = 0;

  beforeAll(async () => {
    pinDb();
    const probe = await Bun.connect({
      hostname: 'localhost', port: 5432,
      socket: { data() {}, open() {}, error() {} },
    }).catch(() => null);
    if (!probe) {
      throw new Error(
        `Could not reach Postgres at localhost:5432, so the A5/A9 contract legs were not run. `
          + `Start the scratch Postgres (docs/slice-3-findings.md F10), then rerun:\n\n`
          + `  bun test test/contract/runner.contract.test.ts\n\n`
          + `CONTROL_DATABASE_URL=${process.env.CONTROL_DATABASE_URL}`,
      );
    }
    probe.end();
    await runMigrations();
    await getDb().insert(schema.organizations)
      .values({ id: ORG_ID, name: 'Gate A', slug: ORG_ID });
    nowMs = Date.now();
  }, 120_000);

  afterAll(async () => {
    const db = getDb();
    await db.delete(schema.agentRunUsage).where(inArray(
      schema.agentRunUsage.runId,
      db.select({ runId: schema.agentRuns.runId }).from(schema.agentRuns)
        .where(eq(schema.agentRuns.organizationId, ORG_ID)),
    ));
    await db.delete(schema.agentRuns).where(eq(schema.agentRuns.organizationId, ORG_ID));
    await db.delete(schema.scheduleRuns).where(eq(schema.scheduleRuns.organizationId, ORG_ID));
    await db.delete(schema.scheduleAlerts).where(eq(schema.scheduleAlerts.organizationId, ORG_ID));
    await db.delete(schema.schedules).where(eq(schema.schedules.organizationId, ORG_ID));
    await db.delete(schema.organizations).where(eq(schema.organizations.id, ORG_ID));
    await closeDb();
  }, 60_000);

  /** One occurrence of either job type, ready to claim or already running. The agent columns are
   *  set only for `agent_prompt`: `shape_matches_job_type` forbids them on a `gbrain_command` row,
   *  so a third job type added to the CHECK has no shape here and the insert that follows fails. */
  async function seedRun(opts: {
    jobType?: string; state?: string; budgetUsd?: string; fireAtMs?: number;
  } = {}): Promise<{ runId: string; scheduleId: string }> {
    const scheduleId = randomUUID();
    const runId = randomUUID();
    const jobType = opts.jobType ?? 'agent_prompt';
    const budgetUsd = opts.budgetUsd ?? '0.5000000';
    await getDb().insert(schema.schedules).values({
      id: scheduleId,
      organizationId: ORG_ID,
      name: `gate-a-${scheduleId.slice(0, 8)}`,
      kind: 'interval',
      intervalSeconds: 3600,
      anchorAt: new Date(nowMs),
      jobType,
      operation: jobType === 'gbrain_command' ? 'sources-push' : null,
      agentPrompt: jobType === 'agent_prompt' ? 'gate A' : null,
      agentModel: jobType === 'agent_prompt' ? HAIKU : null,
      agentMaxTokens: jobType === 'agent_prompt' ? 256 : null,
      agentBudgetUsd: jobType === 'agent_prompt' ? budgetUsd : null,
      agentHarnessVersion: jobType === 'agent_prompt' ? HARNESS_PIN : null,
      createdBy: 'gate-a',
    });
    await getDb().insert(schema.scheduleRuns).values({
      id: runId,
      scheduleId,
      organizationId: ORG_ID,
      slot: `gate-a-${runId}`,
      fireAt: new Date(opts.fireAtMs ?? nowMs - 1000),
      state: opts.state ?? 'running',
    });
    await getDb().insert(schema.agentRuns).values({
      runId, organizationId: ORG_ID, model: HAIKU, harnessVersion: HARNESS_PIN, budgetUsd,
    });
    return { runId, scheduleId };
  }

  // --- A5: the cap boundary, at exactly the cap and not after -------------------------------
  describe('A5 assertBudget', () => {
    /** P2-a's run, priced by our own table — the number the DB row carries. */
    const COST = priceUsage(HAIKU, P2A_USAGE)!; // 0.0154847
    /** P2-a's captures in the shape the ledger stores: the 1h cache write as its own count. */
    const P2A_COUNTS: UsageCounts = {
      inputTokens: 10, outputTokens: 54, cacheReadTokens: 13607,
      cacheWrite5mTokens: 0, cacheWrite1hTokens: 6922,
    };

    test('the priced frame is what the ledger stores, and zero rows are a known 0', async () => {
      const { runId } = await seedRun({ budgetUsd: '0.5000000' });
      expect(await accruedCost(runId)).toBe(0); // nothing spent is a known amount
      const verdict = await assertBudget(runId);
      expect(verdict.accruedUsd).toBe(0);
      expect(verdict.remainingUsd).toBe(0.5);

      const row = await recordUsage({
        runId, model: DATED_HAIKU, counts: P2A_COUNTS,
        costUsd: COST, stopReason: 'end_turn', httpStatus: 200,
      });
      expect(row.seq).toBe(1);
      // The number in the ledger is the price of P2-a's captured frame.
      expect(await accruedCost(runId)).toBe(P2A_REPORTED_COST);
    });

    test('accrued < cap forwards, with the money left stated', async () => {
      const { runId } = await seedRun({ budgetUsd: '0.5000000' });
      await recordUsage({
        runId, model: HAIKU,
        counts: P2A_COUNTS,
        costUsd: COST,
      });
      const verdict = await assertBudget(runId);
      expect(verdict.accruedUsd).toBe(COST);
      expect(verdict.budgetUsd).toBe(0.5);
      expect(verdict.remainingUsd).toBeCloseTo(0.4845153, 7);
      expect(verdict.scheduleId).not.toBeNull();
    });

    test('accrued == cap REFUSES — at exactly the cap, not after it', async () => {
      const { runId } = await seedRun({ budgetUsd: COST.toFixed(7) });
      await recordUsage({
        runId, model: HAIKU,
        counts: P2A_COUNTS,
        costUsd: COST,
      });
      expect(await accruedCost(runId)).toBe(Number(COST.toFixed(7)));

      const refusal = await assertBudget(runId).then(() => null, (e: unknown) => e);
      expect(refusal).toBeInstanceOf(GatewayRefusal);
      const err = refusal as InstanceType<typeof GatewayRefusal>;
      expect(err.code).toBe('budget_exceeded');
      expect(err.status).toBe(402);
      // The message names BOTH numbers, so an operator can see it was the boundary and not a blowout.
      expect(err.message).toBe(`run ${runId} has spent $${COST.toFixed(7)} of its $${COST.toFixed(7)} budget`);

      // The refusal is never silent: the run and its occurrence carry the reason, and one alert exists.
      const [run] = await getDb().select().from(schema.agentRuns).where(eq(schema.agentRuns.runId, runId));
      expect(run!.failureClass).toBe('budget_exceeded');
      const [occ] = await getDb().select().from(schema.scheduleRuns).where(eq(schema.scheduleRuns.id, runId));
      expect(occ!.classification).toBe('budget_exceeded');
      const alerts = await getDb().select().from(schema.scheduleAlerts)
        .where(eq(schema.scheduleAlerts.runId, runId));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.kind).toBe('agent_budget_exceeded');

      // A second refusal is the same fact restated, not a second alert.
      await assertBudget(runId).catch(() => {});
      expect(await getDb().select().from(schema.scheduleAlerts)
        .where(eq(schema.scheduleAlerts.runId, runId))).toHaveLength(1);
    });

    test('accrued == cap over a SUM of rows refuses too — the rollup, not one row', async () => {
      const { runId } = await seedRun({ budgetUsd: COST.toFixed(7) });
      const counts = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 };
      await recordUsage({ runId, model: HAIKU, counts, costUsd: 0.01 });
      await recordUsage({ runId, model: HAIKU, counts, costUsd: 0.0054847 });
      expect(await accruedCost(runId)).toBe(Number(COST.toFixed(7)));
      const refusal = await assertBudget(runId).then(() => null, (e: unknown) => e);
      expect(refusal).toBeInstanceOf(GatewayRefusal);
      expect((refusal as InstanceType<typeof GatewayRefusal>).message)
        .toMatch(/has spent \$0\.0154847 of its \$0\.0154847 budget/);
    });

    test('one micro-dollar below the cap still forwards — the boundary discriminates', async () => {
      const { runId } = await seedRun({ budgetUsd: (COST + 1e-7).toFixed(7) });
      await recordUsage({
        runId, model: HAIKU,
        counts: P2A_COUNTS,
        costUsd: COST,
      });
      const verdict = await assertBudget(runId);
      expect(verdict.accruedUsd).toBe(COST);
      expect(verdict.remainingUsd).toBeCloseTo(1e-7, 9);
    });

    test('NULL cost is NOT zero: the remaining budget is unknowable, and the call is refused', async () => {
      // An unpriced call (honesty rule 3: `agent_run_usage.cost_usd` is NULL when `priceUsage`
      // returned null). A cap computed over an unknown term is not a cap.
      const { runId } = await seedRun({ budgetUsd: '0.5000000' });
      await recordUsage({
        runId, model: 'gpt-4o',
        counts: { inputTokens: 10, outputTokens: 54, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 },
        costUsd: priceUsage('gpt-4o', P2A_USAGE), // null — the model is not in the table
      });
      expect(await accruedCost(runId)).toBeNull();
      expect(await accruedCost(runId)).not.toBe(0);

      const refusal = await assertBudget(runId).then(() => null, (e: unknown) => e);
      const err = refusal as InstanceType<typeof GatewayRefusal>;
      expect(err).toBeInstanceOf(GatewayRefusal);
      expect(err.code).toBe('budget_unknowable');
      expect(err.status).toBe(402);
      expect(err.message).toMatch(/has a call that could not be priced; the remaining budget is unknowable/);
      // And it is NOT reported as the cap being reached: those are different facts.
      expect(err.code).not.toBe('budget_exceeded');
    });

    test('a terminal run never reaches the cap check', async () => {
      const { runId } = await seedRun({ budgetUsd: '0.5000000', state: 'succeeded' });
      const refusal = await assertBudget(runId).then(() => null, (e: unknown) => e);
      const err = refusal as InstanceType<typeof GatewayRefusal>;
      expect(err).toBeInstanceOf(GatewayRefusal);
      expect(err.code).toBe('run_terminated');
      expect(err.status).toBe(401);
    });
  });

  // --- A9: the job-type filter is total over what the CHECK permits --------------------------
  describe('A9 claimNextRun jobTypes', () => {
    const SCHEMA_SRC = repoFile('src/control/db/schema.ts');
    const SCHEDULER_MAIN = repoFile('src/scheduler/main.ts');
    const AGENT_CLAIM = repoFile('src/agent/claim.ts');

    /** The two consumers and the sets they pass, read out of the call sites that pass them. */
    const CONSUMERS: Array<{ label: string; file: string; types: string[]; worker: string }> = [
      {
        label: 'the scheduler',
        file: 'src/scheduler/main.ts',
        types: parseJobTypeLiterals(SCHEDULER_MAIN),
        worker: 'gate-a-scheduler',
      },
      {
        label: 'the runs claim path',
        file: 'src/agent/claim.ts',
        types: parseJobTypeLiterals(AGENT_CLAIM),
        worker: 'gate-a-runs',
      },
    ];
    const jobTypesOf = (types: readonly string[]) => types as Array<(typeof JOB_TYPES)[number]>;

    test('the two consumers\' sets cover every value the CHECK permits — and a third value would fail', () => {
      const permitted = parseCheckValues(SCHEMA_SRC, 'job_type_valid');
      expect(permitted).toEqual(['gbrain_command', 'agent_prompt']);

      // The consumers are the ones this slice ships, read from their own call sites.
      expect(CONSUMERS.find((c) => c.file === 'src/scheduler/main.ts')!.types)
        .toEqual(['gbrain_command']);
      expect(CONSUMERS.find((c) => c.file === 'src/agent/claim.ts')!.types)
        .toEqual(['agent_prompt']);

      const claimed = CONSUMERS.flatMap((c) => c.types);
      expect(uncoveredJobTypes(permitted, claimed)).toEqual([]);
      // The declared list agrees with the CHECK, so a value added to either one alone is a failure.
      const declared: string[] = [...JOB_TYPES];
      expect(declared.sort()).toEqual([...permitted].sort());
      // A consumer naming a value the CHECK forbids is also a bug, not a wider allowlist.
      for (const type of claimed) expect(permitted).toContain(type);

      // THE DISCRIMINATOR: the same logic, fed a CHECK that permits a third value, must report it.
      // Without this the assertion above could pass on any input at all.
      expect(uncoveredJobTypes([...permitted, 'third_type'], claimed)).toEqual(['third_type']);
      expect(uncoveredJobTypes(permitted, ['gbrain_command'])).toEqual(['agent_prompt']);
    });

    test('each consumer claims only its own rows, and every permitted value is claimable', async () => {
      // One pending occurrence per permitted job type. A third value added to the CHECK would make
      // this loop fail — either at the insert (no `shape_matches_job_type` arm for it) or, if a shape
      // were added too, with no consumer able to claim the row.
      const permitted = parseCheckValues(SCHEMA_SRC, 'job_type_valid');
      const seeded = new Map<string, string>();
      for (const type of permitted) {
        // `agent_prompt` is strictly OLDER, so it holds the head of the queue: the scheduler's claim
        // below proves a row of the other lane at the head is invisible to it (it neither claims it
        // nor is starved by it).
        const { runId } = await seedRun({
          jobType: type, state: 'pending', fireAtMs: nowMs - (type === 'agent_prompt' ? 60_000 : 0),
        });
        seeded.set(type, runId);
      }
      const claimedByConsumer = new Map<string, string[]>();
      for (const consumer of CONSUMERS) {
        const rows: string[] = [];
        // Bounded: one more claim than there are rows to claim, so a filter that matched nothing
        // (or everything, forever) cannot hang the suite.
        for (let i = 0; i <= permitted.length; i += 1) {
          const claimed = await claimNextRun(consumer.worker, Date.now(), {
            jobTypes: jobTypesOf(consumer.types),
          });
          if (claimed === 'none') break;
          const jobType = claimed.schedule.jobType;
          // Exclusivity: a consumer never claims a row of another lane's type.
          expect(consumer.types).toContain(jobType);
          expect(claimed.run.claimedBy).toBe(consumer.worker);
          rows.push(claimed.run.id);
        }
        claimedByConsumer.set(consumer.label, rows);
      }

      // Totality, behaviourally: every permitted value was claimed by SOME consumer, and the two
      // consumers between them claimed exactly the rows that were seeded.
      const claimedIds = [...claimedByConsumer.values()].flat();
      for (const type of permitted) expect(claimedIds).toContain(seeded.get(type)!);
      expect(claimedIds.sort()).toEqual([...seeded.values()].sort());

      // A consumer with an empty set claims nothing (fail-closed rather than claim-anything).
      await seedRun({ jobType: 'agent_prompt', state: 'pending' });
      expect(await claimNextRun('gate-a-empty', Date.now(), { jobTypes: [] })).toBe('none');
    });
  });
});

// ===========================================================================
// A8 — the registry operations the token lane depends on, against gbrain at the pin.
//
// A restated A8. The plan said "the new registry entry's --json support is proven against the real
// binary at the pin", but Task 1's P6 proved there is no revocable token id, so D8 took the fallback
// and `src/contracts/registry.ts` gained NO operation. Nothing is invented here: the two operations
// the token lane actually depends on — `mcp.grant` and `auth.revokeClient` — are asserted to exist,
// and then exercised for real.
// ===========================================================================
describe('A8 the token lane\'s registry operations (real binary at the pin)', () => {
  /** `execOperation` targets the slice0 harness: the pinned mobrain/gbrain-base image, never
   *  rebuilt from the working tree — the same target `mcp-grant.contract.test.ts` uses. */
  const RUN_ID = randomUUID().slice(0, 8);
  const GRANT_NAME = `runner-contract-${RUN_ID}`;
  const CREDS_FILE = `/srv/gbrain-home/.creds-runner-contract-${RUN_ID}.json`;
  const JOURNAL_FILE = (clientId: string) =>
    `/srv/gbrain-home/.gbrain/credential-deliveries/${clientId}.json`;
  /** The client the grant leg minted, for the revoke and journal legs. Bun runs a file's tests in
   *  declaration order, so this is set before either of them reads it — and the leg below fails with
   *  a named error rather than a confusing one if that ever stops being true. */
  let grantedClientId = '';

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
  }, 900_000);
  afterAll(async () => {
    // The grant's own residue: the handoff file it wrote, and the journal the revoke leg proved
    // survives a revoke (which is the whole reason the ops verb exists).
    await composeExec('gbrain-ops', ['rm', '-f', CREDS_FILE]);
    if (grantedClientId !== '') {
      await composeExec('gbrain-ops', ['rm', '-f', JOURNAL_FILE(grantedClientId)]);
    }
    await composeDown();
  }, 120_000);

  test('the suite is not silently skipped when docker is unavailable', () => {
    if (dockerAvailable) return;
    if (process.env.BRAINSTAND_ALLOW_SKIP_RUNNER_CONTRACT === '1') return;
    throw new Error(
      'docker compose is not usable, so the A8/A10 contract legs were skipped rather than run. '
        + 'Install/start Docker, then rerun:\n\n  bun test test/contract/runner.contract.test.ts\n\n'
        + 'If skipping is genuinely intended, set BRAINSTAND_ALLOW_SKIP_RUNNER_CONTRACT=1.',
    );
  });

  test.skipIf(!dockerAvailable)('both operations exist in the registry, and the --json claim is stated', () => {
    const grant = OPERATIONS['mcp.grant']!;
    const revoke = OPERATIONS['auth.revokeClient']!;

    expect(grant.argv).toEqual(['mcp', 'grant']);
    expect(revoke.argv).toEqual(['auth', 'revoke-client']);
    // L6: an accepted flag is not an implemented flag. The registry's `supportsJson` is the claim the
    // two legs below test against real output.
    expect(grant.supportsJson).toBe(true);
    expect(grant.supportsDryRun).toBe(true);
    // V15: `auth revoke-client` has NO --json, and asking for one is refused in buildArgv rather than
    // silently dropped — the flag never reaches the binary.
    expect(revoke.supportsJson).toBe(false);
    expect(() => buildArgv(revoke, { clientId: 'x' }, { json: true }))
      .toThrow('auth.revokeClient does not support --json');
    expect(buildArgv(revoke, { clientId: 'gbrain_cl_probe' }))
      .toEqual(['auth', 'revoke-client', 'gbrain_cl_probe']);
    expect(buildArgv(grant, { name: 'n', url: 'https://localhost/mcp' }, { json: true }))
      .toContain('--json');
    // The lane's own URL builder: HTTP on loopback is the only plaintext the grant accepts (F6).
    expect(mcpUrl()).toBe('http://127.0.0.1:3131/mcp');
  });

  test.skipIf(!dockerAvailable)('gbrain at the pin is what the operations run against', async () => {
    const r = await composeExec('gbrain-ops', ['gbrain', '--version']);
    expect(r.exitCode).toBe(0);
    expect(parseGbrainVersion(r.stdout)).toBe(GBRAIN_PIN);
  });

  test.skipIf(!dockerAvailable)('a real grant: --json is IMPLEMENTED (the output parses), and F11 holds on the receipt', async () => {
    const spec = OPERATIONS['mcp.grant']!;
    const r = await execOperation(spec, {
      name: GRANT_NAME, harness: 'claude-code', profile: 'memory-writer',
      source: 'customers', federatedRead: ['customers'],
      boundSlugPrefixes: 'runner-contract/',
      url: mcpUrl(), credentialsOut: CREDS_FILE, tokenTtl: '300',
    }, { json: true });
    assertOk(spec, r);

    // L6, the whole point: `execOperation` parsed the receipt off stdout. A flag that were merely
    // accepted would leave `json` null here.
    expect(r.json).not.toBeNull();
    const body = r.json as {
      status?: string;
      grant?: { clientId?: string; allowedOperations?: string[]; tokenTtlSeconds?: number };
      credentials?: { client_id?: string };
    };
    expect(body.status).toBe('granted');
    const clientId = body.grant?.clientId;
    expect(clientId).toMatch(/^gbrain_cl_[A-Za-z0-9_-]+$/); // the shape the ops verb validates (P6)
    expect(body.grant?.tokenTtlSeconds).toBe(300);
    grantedClientId = clientId!;

    // F11, measured on THIS receipt rather than quoted: `delete_page` is in the grant's
    // allowedOperations while the pin's catalog carries it and the granted SURFACE does not. Our
    // allowlist names neither, which is what A2's intersection exists for.
    const allowed = body.grant?.allowedOperations ?? [];
    const snapshot = JSON.parse(readFileSync(capabilityPath(GBRAIN_PIN), 'utf8')) as CapabilitySnapshot;
    if (!allowed.includes('delete_page')) {
      throw new Error(
        'F11 did not reproduce against this grant: `delete_page` is absent from allowedOperations, '
          + `so the probe proves nothing. Receipt: ${JSON.stringify(body.grant)}`,
      );
    }
    expect(snapshot.tools).toBeDefined();
    expect(toolNames(snapshot.tools)).toContain('delete_page');
    expect(allowedToolsFor(null, snapshot)).not.toContain(`${TOOL_PREFIX}delete_page`);
    console.log(`MEASURED mcp.grant at ${GBRAIN_PIN}: client ${clientId!.slice(0, 14)}…, `
      + `allowedOperations=${allowed.length} (delete_page ${allowed.includes('delete_page') ? 'listed' : 'absent'}), `
      + `surface catalog=${toolNames(snapshot.tools).length} tools (delete_page ${toolNames(snapshot.tools).includes('delete_page') ? 'present' : 'absent'}), `
      + `our allowlist=${allowedToolsFor(null, snapshot).length} tools`);

    // The credential went to the private handoff file, never to stdout (P6).
    const handoff = await composeExec('gbrain-ops', ['test', '-s', CREDS_FILE]);
    expect(handoff.exitCode).toBe(0);
    expect(JSON.stringify(body)).not.toContain('access_token');
  }, 300_000);

  test.skipIf(!dockerAvailable)('a real revoke: exit 0, then not-found — the output IS the evidence', async () => {
    const spec = OPERATIONS['auth.revokeClient']!;
    if (grantedClientId === '') {
      throw new Error('the grant leg did not record a client id, so there is nothing to revoke');
    }
    const clientId = grantedClientId;

    const revoked = await execOperation(spec, { clientId });
    assertOk(spec, revoked);
    expect(revoked.exitCode).toBe(0);

    // The second call is the evidence that the first one acted: exit 1, not-found, and the declared
    // contract (okExitCodes [0]) reports that as not-ok.
    const again = await execOperation(spec, { clientId });
    expect(again.exitCode).toBe(1);
    expect(spec.okExitCodes.includes(again.exitCode)).toBe(false);
    expect(again.stdout + again.stderr).toMatch(/No client found/i);
  }, 300_000);

  test.skipIf(!dockerAvailable)('F7: the grant retained a credential journal, and the revoke did NOT delete it', async () => {
    // The journal is written before the grant commits (F7) and survives `revoke-client`, so after the
    // revoke above it is the last copy of a dead secret on the file plane. The path is the one the ops
    // verb computes from a validated client id — proved here against the real grant's own client.
    if (grantedClientId === '') {
      throw new Error('the grant leg did not record a client id, so the journal cannot be located');
    }
    const journal = await composeExec('gbrain-ops', ['test', '-s', JOURNAL_FILE(grantedClientId)]);
    expect(journal.exitCode).toBe(0);

    // And the credential is really gone from the client's own view: a revoked client cannot
    // authenticate. (The revoke leg already proved the SECOND revoke exits 1; this proves the
    // journal the revoke left behind is a real file, which is what the ops verb deletes.)
    const rows = await composeExec('gbrain-ops', [
      'sh', '-c', `ls /srv/gbrain-home/.gbrain/credential-deliveries | wc -l`,
    ]);
    expect(rows.exitCode).toBe(0);
    expect(Number(rows.stdout.trim())).toBeGreaterThan(0); // F13: earlier slices' journals persist here
  }, 120_000);
});

// ===========================================================================
// A8(b) — the ops verb the revoke path adds, against a really spawned ops server.
// ===========================================================================
describe('A8 the ops verb: /fileplane/delete-credential-journal', () => {
  // Only the directory this describe created is removed afterwards — GateA is shared scratch, and
  // an afterAll that wipes it takes other legs' fixtures with it.
  const OPS_HOME = join(process.cwd(), '.brainstand-tmp', 'slice4', 'GateA', 'ops-verb');
  const OPS_PORT = '13191';
  const OPS_TOKEN = 'gate-a-token-not-a-real-secret';
  const BASE = `http://127.0.0.1:${OPS_PORT}`;
  let server: ReturnType<typeof Bun.spawn> | null = null;

  beforeAll(async () => {
    mkdirSync(join(OPS_HOME, '.gbrain', 'credential-deliveries'), { recursive: true });
    mkdirSync(join(OPS_HOME, 'repos'), { recursive: true });
    server = Bun.spawn(['bun', 'run', 'src/ops/server.ts'], {
      env: {
        ...process.env,
        OPS_RPC_TOKEN: OPS_TOKEN,
        OPS_RPC_PORT: OPS_PORT,
        GBRAIN_HOME: OPS_HOME, // fileplane.ts binds this at module load (ruling 14)
        BRAIN_REPOS: join(OPS_HOME, 'repos'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`${BASE}/healthz`)).ok) return;
      } catch { /* not up yet */ }
      await Bun.sleep(200);
    }
    throw new Error('the ops server did not start');
  }, 60_000);

  afterAll(async () => {
    server?.kill();
    rmSync(OPS_HOME, { recursive: true, force: true });
  }, 60_000);

  const del = (clientId: unknown) => fetch(`${BASE}/fileplane/delete-credential-journal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${OPS_TOKEN}` },
    body: JSON.stringify({ clientId }),
  });

  test('it deletes the journal computed from a `gbrain_cl_…` client id', async () => {
    // The id SHAPE is the one the real grant produced (asserted in the leg above), so the probe
    // cannot pass on an id the real lane would never produce.
    const clientId = `gbrain_cl_${randomUUID().replace(/-/g, '')}`;
    const journal = join(OPS_HOME, '.gbrain', 'credential-deliveries', `${clientId}.json`);
    writeFileSync(journal, JSON.stringify({ client_secret: 'sk-journal-once' }));

    const res = await del(clientId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(Bun.file(journal).size).toBe(0); // gone: reading it now yields nothing

    // A second call is not an error: the journal is absent, and that is the normal case for a client
    // whose journal was never written or already deleted.
    const again = await del(clientId);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ deleted: false });
  }, 60_000);

  test('it rejects a client id that is not `gbrain_cl_…`-shaped, and never touches a path', async () => {
    // The rejection arm. Each id is one a caller might invent; none may reach the filesystem as a path.
    for (const bad of ['not-a-client-id', 'gbrain_cl_', 'gbrainXcl_abc', '../etc/passwd', 'gbrain_cl_../../etc/passwd', 42, null]) {
      const res = await del(bad);
      expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
      const body = await res.json() as { error?: string };
      expect(body.error).toMatch(/invalid client id/);
    }
    // And the traversal attempt left nothing behind outside the journal directory.
    expect(await Bun.file(join(OPS_HOME, '.gbrain', '..', 'passwd')).exists()).toBe(false);
  }, 60_000);
});

// ===========================================================================
// A10 — verifyHarnessPin fails on a mismatch (and is not a constant read).
// ===========================================================================
describe('A10 verifyHarnessPin', () => {
  const BOGUS = '0.0.0-not-the-pin';

  test('the pinned value passes', async () => {
    const verdict = await verifyHarnessPin(HARNESS_PIN, async () => `${HARNESS_PIN} (Claude Code)`);
    expect(verdict).toEqual({ declared: HARNESS_PIN, observed: HARNESS_PIN, matches: true });
  });

  test('a different value fails, naming both — and the real pin is the one it names', async () => {
    const verdict = await verifyHarnessPin(BOGUS, async () => `${HARNESS_PIN} (Claude Code)`);
    expect(verdict.matches).toBe(false);
    expect(verdict.declared).toBe(BOGUS);
    expect(verdict.observed).toBe(HARNESS_PIN); // both values are named in the result
    expect({ ...verdict }).not.toEqual({ declared: HARNESS_PIN, observed: BOGUS, matches: false });
  });

  test('an unverifiable harness is null, NEVER a mismatch (F1\'s failure mode)', async () => {
    // F1: `sh: 1: claude: Permission denied`, and a tmpfs at $HOME gives
    // `error: Script not found "claude"`. Unverifiable is a different failure class from a mismatch,
    // and the runner must report it as one — a caller checks `matches === true`, never `!== false`.
    for (const [, raw] of Object.entries({
      f1: 'sh: 1: claude: Permission denied\n',
      missing: 'error: Script not found "claude"\n',
    })) {
      const verdict = await verifyHarnessPin(HARNESS_PIN, async () => raw);
      expect(verdict.observed).toBeNull();
      expect(verdict.matches).toBeNull();
      expect(verdict.declared).toBe(HARNESS_PIN);
    }
    const unreachable = await verifyHarnessPin(HARNESS_PIN, async () => {
      throw new Error('ENOENT: claude');
    });
    expect(unreachable.matches).toBeNull();
  });

  test.skipIf(!dockerAvailable)('the check reads the REAL binary at the pin, not a value', async () => {
    // Task 8's `readHarnessVersion` spawns `claude --version`, and this is where that is proven: the
    // program runs INSIDE the pinned runner image (the tree's own `pin.ts` mounted over /app/src, so
    // the module under test is the working tree's while the binary is the image's).
    const src = join(process.cwd(), 'src');
    const program = [
      'const m = await import("/app/src/runner/pin.ts");',
      'console.log(JSON.stringify({',
      '  bin: m.HARNESS_BIN,',
      '  good: await m.verifyHarnessPin(),',
      `  bad: await m.verifyHarnessPin(${JSON.stringify(BOGUS)}),`,
      '}));',
    ].join(' ');
    const run = async (argv: string[]) => {
      const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
      ]);
      return { exitCode, stdout, stderr };
    };
    const image = `mobrain/agent-runner:${HARNESS_PIN}`;
    const reported = await run(['docker', 'run', '--rm', '--entrypoint', 'claude', image, '--version']);
    expect({ code: reported.exitCode, stderr: reported.stderr }).toMatchObject({ code: 0 });
    const installed = reported.stdout.trim().split(/\s+/)[0]!; // "2.1.274 (Claude Code)" -> the token
    expect(installed).toBe(HARNESS_PIN);
    // The build-time gate reads the FIRST token, not the last — the value the pin compares against.
    expect(reported.stdout.trim().split(/\s+/).at(-1)).not.toBe(HARNESS_PIN);

    const probe = await run([
      'docker', 'run', '--rm', '--entrypoint', 'bun',
      '-v', `${src}:/app/src:ro`, '--tmpfs', '/tmp',
      '-e', `HARNESS_VERSION=${HARNESS_PIN}`,
      image, '-e', program,
    ]);
    expect({ code: probe.exitCode, stderr: probe.stderr }).toMatchObject({ code: 0 });
    const out = JSON.parse(probe.stdout.trim().split('\n').at(-1)!) as {
      bin: string;
      good: { declared: string; observed: string | null; matches: boolean | null };
      bad: { declared: string; observed: string | null; matches: boolean | null };
    };
    expect(out.bin).toBe('claude'); // the production value: the image puts it on PATH
    expect(out.good).toEqual({ declared: HARNESS_PIN, observed: HARNESS_PIN, matches: true });
    // The failure arm reads the SAME real binary and names both values.
    expect(out.bad.declared).toBe(BOGUS);
    expect(out.bad.observed).toBe(installed);
    expect(out.bad.matches).toBe(false);
    console.log(`MEASURED verifyHarnessPin inside ${image}: claude --version reports "${reported.stdout.trim()}", `
      + `HARNESS_BIN=${out.bin}, pinned ${out.good.matches}, ${BOGUS} -> matched ${out.bad.matches} ` +
      `(observed ${out.bad.observed})`);
  }, 300_000);
});

// ===========================================================================
// A11 — F16's page removal: the revert's remove-by-name step, against gbrain at the pin.
//
// The revert's `sync` cannot undo the page an agent run writes, and that is F15: MCP `put_page`
// creates the row brain-first with its chunks embedded inline, so the page survives a file whose
// addition and removal both landed inside one unsynced delta. The repair is a delete BY NAME, and
// this describe is where the operation that carries it is pinned — the G4 coverage this registry
// entry cannot ship without, and L6's proof that `--json` is IMPLEMENTED rather than accepted.
//
// Every clause is measured against the real binary. What each leg proves:
//   1. the argv the registry builds is the argv the pin takes, and both flags it depends on are
//      REQUIRED, not optional — a missing `--source-id` is refused before the binary runs;
//   2. a real `put_page`-shaped page (row plus write-through file, never synced) is removed, and
//      the receipt is PARSED: status, slug, source_id, write_through and residuals;
//   3. the receipt is the evidence, not the exit code: the page stops answering a real `search`;
//   4. `--source-id` targets the named source's row and leaves the same slug in another source
//      alone — the `#4329` failure mode, which on a multi-source brain would purge the wrong row.
// ===========================================================================
describe('A11 the revert\'s page removal (real binary at the pin)', () => {
  const RUN_ID = randomUUID().slice(0, 8);
  const SLUG = `runner-contract/revert-${RUN_ID}`;
  /** A phrase that appears only in this leg's page, so a keyword search either
   *  finds that page or finds nothing of ours. */
  const NEEDLE = `revert-needle-${RUN_ID}`;
  const CONTENT = `# Revert contract ${RUN_ID}\n\n${NEEDLE}\n`;

  beforeAll(async () => {
    await composeUp();
    await resetBrain();
    assertOk(OPERATIONS.init!, await execOperation(OPERATIONS.init!, {
      nonInteractive: true, force: true, url: BRAIN_DB_URL,
      embeddingModel: 'openai:text-embedding-3-small',
    }, { timeoutMs: 600_000 }));
    for (const id of ['customers', 'shared']) {
      await seedGitSource(id);
      // `--federated` is not decoration: the default is `federated: false`
      // ("only searched when explicitly named via --source"), and the registry's
      // `search` carries no source param — an unfederated source would be
      // invisible to the unqualified searches below, and the two legs would fail
      // on their CONTROL step rather than on anything the purge did.
      assertOk(OPERATIONS['sources.add']!, await execOperation(OPERATIONS['sources.add']!, {
        id, path: `/srv/brain-repos/${id}`, federated: true,
      }));
    }
  }, 900_000);

  afterAll(async () => {
    await composeDown();
  }, 120_000);

  /** A brain-first write exactly as MCP `put_page` performs it: the row first,
   *  and the markdown lands in the Space's working tree as an UNTRACKED file the
   *  agent's finish path would commit. `put` has no `--source` flag, so the
   *  source is selected the way the local CLI does it (GBRAIN_SOURCE). */
  const putPage = async (sourceId: string, slug: string, content: string, timeoutMs = 120_000) => {
    const r = await composeExec('gbrain-ops', ['gbrain', 'put', slug, '--content', content], {
      env: { GBRAIN_SOURCE: sourceId }, timeoutMs,
    });
    if (r.exitCode !== 0) {
      throw new Error(`gbrain put ${slug} exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(0, 300)}`);
    }
    return r;
  };

  /** The hits a real `search` answers with, as `{slug, source_id}` pairs.
   *  Asserted to PARSE: a search whose receipt came back null would otherwise
   *  read as "the page is gone". The SOURCE is what the two-source leg needs —
   *  one slug can be answered by a row in each source, and only the pair says
   *  which row the purge reached. */
  const searchHits = async (query: string): Promise<Array<{ slug: string; sourceId: string }>> => {
    const r = await execOperation(OPERATIONS.search!, { query, limit: '10' }, { json: true });
    assertOk(OPERATIONS.search!, r);
    if (r.json === null) throw new Error(`gbrain search emitted no JSON to parse: ${r.stdout.slice(0, 300)}`);
    const hits = r.json as Array<{ slug?: string; source_id?: string }>;
    return hits.map((h) => ({ slug: h.slug ?? '', sourceId: h.source_id ?? '' }));
  };
  const searchSlugs = async (query: string): Promise<string[]> =>
    (await searchHits(query)).map((h) => h.slug);

  test('the operation is the pin\'s argv, and --source-id is required rather than defaulted', () => {
    const spec = OPERATIONS['page.delete']!;
    expect(spec.argv).toEqual(['delete']);
    expect(buildArgv(spec, { slug: SLUG, sourceId: 'customers', purge: true }, { json: true }))
      .toEqual(['delete', SLUG, '--source-id', 'customers', '--purge', '--json']);
    // Multi-source is the reason this cannot be optional: the local default is
    // `ctx.sourceId`, which for the platform would be `default` — a different row.
    expect(() => buildArgv(spec, { slug: SLUG, purge: true })).toThrow(/missing required param sourceId/);
    // The claim the legs below test against real output (L6).
    expect(spec.supportsJson).toBe(true);
    expect(spec.privilege).toBe('brain-db');
  });

  test.skipIf(!dockerAvailable)('a brain-first page is purged, and the page really stops answering', async () => {
    await putPage('customers', SLUG, CONTENT);

    // The control: the page IS answerable before the purge. Without it, "the
    // search no longer returns it" would pass on a page that was never indexed.
    expect(await searchSlugs(NEEDLE)).toContain(SLUG);

    const spec = OPERATIONS['page.delete']!;
    const r = await execOperation(spec, { slug: SLUG, sourceId: 'customers', purge: true }, { json: true });
    assertOk(spec, r);
    // L6, the whole point: this parses the receipt off stdout. A flag that were
    // merely accepted would leave `json` null here.
    expect(r.json).not.toBeNull();
    const receipt = r.json as {
      status?: string; slug?: string; source_id?: string;
      write_through?: { removed?: boolean; path?: string; skipped?: string };
      residuals?: string;
    };
    expect(receipt.status).toBe('purged');
    expect(receipt.slug).toBe(SLUG);
    expect(receipt.source_id).toBe('customers');
    // The write-through half, which is why the revert path needs a TREE guard:
    // this verb UNLINKS the page's markdown when it is on disk. Here it is (the
    // `put` above never committed), so the purge removes it.
    expect(receipt.write_through?.path).toBe(`/srv/brain-repos/customers/${SLUG}.md`);
    expect(receipt.write_through?.removed).toBe(true);
    expect(typeof receipt.residuals).toBe('string');

    // The evidence the revert's promise needs: the same query no longer finds it.
    expect(await searchSlugs(NEEDLE)).not.toContain(SLUG);

    console.log(`MEASURED page.delete at ${GBRAIN_PIN}: status=${receipt.status} slug=${receipt.slug} `
      + `source_id=${receipt.source_id} write_through.removed=${receipt.write_through?.removed} `
      + `(${receipt.write_through?.skipped ?? receipt.write_through?.path}) inserted=${JSON.stringify(r.argv)}; `
      + `search "${NEEDLE}": before=[hit], after=[]`);
  }, 300_000);

  test.skipIf(!dockerAvailable)('--source-id targets the named source, and leaves the same slug elsewhere', async () => {
    const other = `${SLUG}-twin`;
    // The same base name in the source `shared` and in `customers`: a multi-source
    // brain can hold one slug in several sources, and the reverted page belongs to
    // the write Space's own.
    await putPage('shared', other, `# shared twin ${RUN_ID}\n\n${NEEDLE}-shared\n`);
    await putPage('customers', other, `# customers twin ${RUN_ID}\n\n${NEEDLE}-customers\n`);
    const before = await searchHits(`${NEEDLE}-shared`);
    // Both rows answer the same query: the SAME slug, one per source. (The two
    // needles share their tokens, so a keyword search reaches both pages.)
    expect(before).toContainEqual({ slug: other, sourceId: 'customers' });
    expect(before).toContainEqual({ slug: other, sourceId: 'shared' });

    const spec = OPERATIONS['page.delete']!;
    const r = await execOperation(spec, { slug: other, sourceId: 'customers', purge: true }, { json: true });
    assertOk(spec, r);
    // One named boundary read of the receipt, the shape the pin prints (above).
    const receipt = r.json as { status?: string; slug?: string; source_id?: string } | null;
    expect(receipt?.status).toBe('purged');
    expect(receipt?.source_id).toBe('customers');

    // The named source's row is gone; the OTHER source's row is untouched and
    // still answers. A dropped `--source-id` (the pre-#4329 behaviour) would have
    // purged `shared`'s row and left this one live.
    const after = await searchHits(`${NEEDLE}-shared`);
    expect(after.filter((h) => h.sourceId === 'customers')).toEqual([]);
    expect(after).toContainEqual({ slug: other, sourceId: 'shared' });

    await execOperation(spec, { slug: other, sourceId: 'shared', purge: true }, { json: true });
    console.log(`MEASURED page.delete --source-id on a two-source brain: customers' "${other}" purged, `
      + `shared's copy still answered "${NEEDLE}-shared", then purged too`);
  }, 300_000);
});
