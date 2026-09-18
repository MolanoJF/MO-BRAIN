/**
 * The harness seam: argv, child environment, and the audit receipt's parser.
 *
 * `buildHarnessArgv` is **pure** — `AgentRunClaim` in, `string[]` out — because
 * that is how every other argv builder in this repo is tested without a
 * container (`src/contracts/argv.ts` is the precedent, and Task 15's Gate A
 * asserts this function's exact output).
 *
 * Every flag below is a measurement of `brainstand/agent-runner:2.1.274`
 * (`docs/slice-4-findings.md`), never an assumption:
 *
 *   F2  `-p` with `--output-format stream-json` **exits 1 without `--verbose`**.
 *   F3  `--tools ""` yields an MCP-only tool surface (`tools: []` in the init
 *       frame until the MCP server connects) and removes the `ToolSearch` turn.
 *   P4  `--mcp-config` takes an HTTP server with a static `Authorization`
 *       header, sent byte for byte, with no OAuth negotiation attempted.
 *   F5  `ANTHROPIC_AUTH_TOKEN` goes out as `Authorization: Bearer` on the model
 *       request, so the gateway token belongs in the child's ENV and never in
 *       argv, where any `ps` in the container could read it.
 *   F9  the harness's own `total_cost_usd` is a hint, not the ledger: the
 *       gateway meters. It is recorded as a frame datum and never summed here.
 *   P4-d / D5: a deny-list does not fail loudly on an unknown name — measured,
 *       `--disallowedTools BogusTool` is accepted silently. It stays as defence
 *       in depth behind `--tools ""`; the fence is D6's network (honesty rule 2).
 */
import { scrubOutput } from '../docker/host.ts';
import { PRODUCT_TOOL_ALLOWLIST, TOOL_PREFIX } from '../agent/tools.ts';
import type { AgentRunClaim, AgentRunEvent } from '../agent/types.ts';

/**
 * The built-in surface of the pinned binary, read out of its own `system/init`
 * frame (`tools` with no `--tools` flag). `--tools ""` already removes every one
 * of them at the source; naming them again is D5's defence in depth, and the
 * list is the pin's — not a guess from another version's vocabulary.
 */
const DISALLOWED_BUILTINS: readonly string[] = [
  'Bash', 'CronCreate', 'CronDelete', 'CronList', 'Edit', 'EnterWorktree', 'ExitWorktree',
  'ListAgents', 'NotebookEdit', 'Read', 'ReportFindings', 'ScheduleWakeup', 'SendMessage',
  'Skill', 'Task', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'TaskUpdate',
  'WebFetch', 'WebSearch', 'Workflow', 'Write',
];

/**
 * D5's closed list, spelled in the one place the product allowlist is written
 * (`src/agent/tools.ts`, which `allowedToolsFor` also intersects with the
 * capability snapshot). Importing it rather than copying it is what stops the
 * runner's refusal from drifting away from the claim's grant.
 */
const CLOSED_TOOLS: Record<string, true> = {};
for (const tool of PRODUCT_TOOL_ALLOWLIST) CLOSED_TOOLS[`${TOOL_PREFIX}${tool}`] = true;

/**
 * The environment variables the child is allowed to see. A whitelist, not a
 * filter: the harness runs model-chosen tool calls, and `RUNNER_TOKEN`,
 * `CONTROL_URL` and (in a misconfigured deployment) a provider key must not be
 * reachable from inside it, however the model is talked into behaving.
 */
const CHILD_ENV_ALLOWLIST: readonly string[] = [
  'PATH', 'HOME', 'TMPDIR',
  'NODE_EXTRA_CA_CERTS',
  'DISABLE_AUTOUPDATER', 'DISABLE_UPDATES', 'DISABLE_TELEMETRY', 'DO_NOT_TRACK',
  'DISABLE_ERROR_REPORTING', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'LANG', 'LC_ALL', 'TZ',
];

/**
 * Build the harness invocation as an argv ARRAY. Never a shell string (G2): the
 * prompt is exactly one element, whatever it contains.
 *
 * Refusals, all of them before a process exists:
 *
 *   - `allowedTools` empty or blank  — a run with no tools cannot do its job;
 *     it must fail loudly at claim time, not silently do nothing (`tools.ts`).
 *   - a tool outside the closed list — anything not `mcp__gbrain__<product tool>`,
 *     including the right-looking-but-unmeasured `mcp__gbrain__delete_page` (F11)
 *     and any bare built-in name.
 *   - an empty prompt, model, `mcp.url` or `mcp.token` — each is the difference
 *     between the run the schedule asked for and a different one.
 *   - a non-positive budget — the meter would refuse the first call anyway, and
 *     a run that cannot afford a call is a misconfiguration, not a run.
 */
export function buildHarnessArgv(claim: AgentRunClaim): string[] {
  if (claim.prompt.trim() === '') throw new Error('refusing claim: prompt is empty');
  if (claim.model.trim() === '') throw new Error('refusing claim: model is empty');
  if (claim.mcp.url.trim() === '') throw new Error('refusing claim: mcp.url is empty');
  if (claim.mcp.token.trim() === '') throw new Error('refusing claim: mcp.token is empty');
  if (!(claim.budgetUsd > 0) || !Number.isFinite(claim.budgetUsd)) {
    throw new Error(`refusing claim: budgetUsd is not positive (${claim.budgetUsd})`);
  }

  const tools = claim.allowedTools.map((tool) => tool.trim());
  if (tools.length === 0 || tools.every((tool) => tool === '')) {
    throw new Error('refusing claim: allowedTools is empty, and a run with no tools '
      + 'cannot do its job');
  }
  for (const tool of tools) {
    if (CLOSED_TOOLS[tool] !== true) {
      throw new Error(`refusing claim: ${tool} is not on the closed gbrain tool list`);
    }
  }

  // D5: exactly one MCP server, gbrain's `/mcp`, with the run's bearer as a
  // static header. P4 measured that the header is sent as given and that a 401
  // produces two requests and a `failed` server status — never an OAuth dance.
  const mcpConfig = JSON.stringify({
    mcpServers: {
      gbrain: {
        type: 'http',
        url: claim.mcp.url,
        headers: { Authorization: `Bearer ${claim.mcp.token}` },
      },
    },
  });

  return [
    // F2: `-p` with stream-json exits 1 without `--verbose`.
    '-p', claim.prompt,
    '--verbose',
    '--output-format', 'stream-json',
    // Pinned per schedule (D7's reproducibility rule), never a constant here.
    '--model', claim.model,
    // F3: the built-in surface is removed at the source, and the deny-list below
    // stays as defence in depth (honesty rule 2).
    '--tools', '',
    '--disallowedTools', DISALLOWED_BUILTINS.join(','),
    // The non-interactive, deny-by-default pair: `dontAsk` denies anything that
    // would have prompted, and `--permission-prompts none` means nobody is there
    // to answer anyway (`claude --help`, 2.1.274).
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    // Fully qualified `mcp__gbrain__<tool>`, comma-joined into ONE element: the
    // flag is variadic, so a list split across elements would swallow the next
    // flag as a tool name.
    '--allowedTools', tools.join(','),
    '--mcp-config', mcpConfig,
    '--strict-mcp-config',
    // The harness's own money bound, beside D7's meter. F9: its arithmetic runs
    // ~8.8% high on a multi-request run, so it can only ever stop a run early —
    // the gateway's meter is the ledger, and this is the second fence, not the
    // first. The claim carries no turn ceiling, so `--max-turns` is not emitted:
    // `maxTokens` is a model field the gateway sets (Task 7), and inventing a
    // turn count from it would be a number with no meaning.
    '--max-budget-usd', String(claim.budgetUsd),
  ];
}

/**
 * The child's environment. `ANTHROPIC_BASE_URL` is D7's proxy and
 * `ANTHROPIC_AUTH_TOKEN` is the per-run gateway token (F5), both in the
 * environment so no `ps` can read them.
 *
 * A claim with no gateway is refused rather than defaulted: a harness with no
 * base URL would address the real API, and the container's job is to have
 * exactly one route out (D6).
 */
export function buildHarnessEnv(
  claim: AgentRunClaim,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (claim.gateway.url.trim() === '') throw new Error('refusing claim: gateway.url is empty');
  if (claim.gateway.token.trim() === '') throw new Error('refusing claim: gateway.token is empty');

  const env: Record<string, string> = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = base[name];
    if (typeof value === 'string' && value !== '') env[name] = value;
  }
  env.ANTHROPIC_BASE_URL = claim.gateway.url;
  env.ANTHROPIC_AUTH_TOKEN = claim.gateway.token;
  return env;
}

// --- the audit receipt -------------------------------------------------------

export type ParsedStream = {
  /** Every frame this chunk completed, in order. */
  frames: unknown[];
  /** Lines that were not JSON. Reported, never dropped: a receipt with a hole
   *  in it is not a receipt (honesty rule 11). */
  badLines: string[];
  /** The unterminated tail, to be prepended to the next chunk. */
  carry: string;
};

/**
 * A line-oriented NDJSON parser that is tolerant of a partial final line.
 *
 * stdout arrives in arbitrary chunks, and a chunk boundary lands wherever the
 * kernel decides — frequently inside a frame. The unterminated tail is therefore
 * carried into the next call rather than parsed, so no frame is dropped or
 * half-read. At EOF the caller flushes with `parseStreamJson('\n', carry)`:
 * output that ends without a trailing newline still ends with a frame.
 */
export function parseStreamJson(chunk: string, carry = ''): ParsedStream {
  const lines = (carry + chunk).split('\n');
  const tail = lines.pop() ?? '';
  const frames: unknown[] = [];
  const badLines: string[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (text === '') continue;
    try {
      frames.push(JSON.parse(text));
    } catch {
      badLines.push(text);
    }
  }
  return { frames, badLines, carry: tail };
}

/** Objects only; every frame shape P2 measured is an object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Redact a frame with the repository's existing redactor (D4) and hand back the
 * frame itself, not a string: the receipt is read as structure by the console.
 *
 * `scrubOutput` is string-shaped, and its rules are key-context ones (it matches
 * `"client_secret": "…"`), so it is applied to the whole serialized frame rather
 * than to individual string leaves — a per-field pass would silently miss the
 * patterns it exists for. If redaction ever produced text that is not JSON, the
 * redacted text is kept as the datum rather than the frame being dropped.
 */
function redactFrame(frame: unknown): unknown {
  const text = scrubOutput(JSON.stringify(frame));
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * One frame into one `agent_run_events` row. `seq` is the caller's monotonic
 * counter — the UNIQUE `(run_id, seq)` key is what makes a replayed batch
 * idempotent, so the counter must not restart inside a run.
 *
 * The vocabulary is the eight shapes P2 measured: `system/init`,
 * `system/api_retry`, `system/thinking_tokens`, `assistant`, `user`,
 * `rate_limit_event`, `result`, plus this mapping's own tolerant fallback for a
 * shape a future harness adds — recorded as itself, never dropped.
 */
export function normalizeEvent(frame: unknown, seq: number): AgentRunEvent {
  const record = asRecord(frame);
  const type = typeof record?.type === 'string' ? record.type : 'unknown';
  const subtype = typeof record?.subtype === 'string' ? record.subtype : null;
  // Only `system` frames are qualified: `system/init`, `system/api_retry`,
  // `system/thinking_tokens` are three distinct shapes, where `result`+`success`
  // is one shape whose subtype is a field. A subtype on any other type would
  // split one kind into a family nobody asked for.
  const kind = type === 'system' && subtype !== null ? `system/${subtype}` : type;
  return { seq, kind, data: redactFrame(frame) };
}

/**
 * Honesty rule 1: a run with error frames or a non-zero exit is failed,
 * regardless of what its final assistant message says.
 *
 * Deliberately narrow, and each exclusion is a measured fact rather than a
 * preference:
 *
 *   - `status: "skipped"` is NOT an error (F10): a successful MCP write carries
 *     `chunk_skip_reason: "write_skipped"` with `write_through.written: true`.
 *   - an `isError` inside a tool result is NOT a run error: the model sees the
 *     tool's failure and can recover on the next turn.
 *   - a `system/api_retry` frame is a retry, not a failure.
 */
export function isErrorFrame(frame: unknown): boolean {
  const record = asRecord(frame);
  if (record === null) return false;
  if (record.type === 'error') return true;
  return record.is_error === true;
}

/** The harness's own turn count, from the `result` frame. A hint, like F9's cost. */
export function numTurnsOf(frame: unknown): number | null {
  const record = asRecord(frame);
  return typeof record?.num_turns === 'number' ? record.num_turns : null;
}
