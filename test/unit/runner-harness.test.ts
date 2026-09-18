/**
 * Task 8, the harness seam: `buildHarnessArgv` / `buildHarnessEnv` /
 * `parseStreamJson` / `normalizeEvent`, plus the runner process's own first act.
 *
 * Every flag asserted here is a MEASUREMENT from `docs/slice-4-findings.md` (P2,
 * P3, P4, P5) or from `claude --help` read out of the pinned binary itself —
 * `brainstand/agent-runner:2.1.274`, harness `2.1.274`:
 *
 *   F2   `-p` + `--output-format stream-json` exits 1 without `--verbose`.
 *   F3   `--tools ""` yields an MCP-only surface and removes the ToolSearch turn.
 *   P4   `--mcp-config` takes one HTTP server with a static `Authorization`
 *        header, sent byte-for-byte, no OAuth negotiation (U4).
 *   F5   `ANTHROPIC_AUTH_TOKEN` goes out as `Authorization: Bearer`, so the
 *        gateway credentials live in the child's ENV, never in argv where `ps`
 *        would show them.
 *   P5   the container's writable set is `/tmp` alone.
 *
 * The frame fixtures are the probe's verbatim capture, not invented: P2-a's
 * `result` frame, P2-b's `assistant` tool_use frame and P2-b's `user`
 * tool_result frame are copied character for character.
 */
import { test, expect, describe } from 'bun:test';
import { join } from 'node:path';
import {
  buildHarnessArgv, buildHarnessEnv, parseStreamJson, normalizeEvent,
  isErrorFrame, numTurnsOf,
} from '../../src/runner/harness.ts';
import { assertRunnerEnv } from '../../src/runner/main.ts';
import type { AgentRunClaim } from '../../src/agent/types.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/**
 * A representative claim: two read tools and the one write tool, a dated model
 * id (the alias `haiku` resolves to one — P2-a), and both secrets non-empty.
 */
const CLAIM: AgentRunClaim = {
  runId: '11111111-2222-3333-4444-555555555555',
  scheduleId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  attempt: 1,
  prompt: 'Write the page agent/demo with the title "Demo" and nothing else.',
  model: 'claude-haiku-4-5-20251001',
  maxTokens: 4096,
  harnessVersion: '2.1.274',
  allowedTools: ['mcp__gbrain__get_page', 'mcp__gbrain__put_page'],
  mcp: { url: 'https://localhost/mcp', token: 'gbrain-run-token-abc' },
  gateway: { url: 'http://control-plane:3150/api/gateway', token: 'gateway-run-token-xyz' },
  budgetUsd: 0.25,
  timeoutSeconds: 600,
  leaseExpiresAt: '2026-09-17T15:00:00.000Z',
};

/** The built-in surface, read out of the pinned binary's `system/init` frame. */
const DISALLOWED = [
  'Bash', 'CronCreate', 'CronDelete', 'CronList', 'Edit', 'EnterWorktree', 'ExitWorktree',
  'ListAgents', 'NotebookEdit', 'Read', 'ReportFindings', 'ScheduleWakeup', 'SendMessage',
  'Skill', 'Task', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'TaskUpdate',
  'WebFetch', 'WebSearch', 'Workflow', 'Write',
];

const MCP_CONFIG = '{"mcpServers":{"gbrain":{"type":"http","url":"https://localhost/mcp",'
  + '"headers":{"Authorization":"Bearer gbrain-run-token-abc"}}}}';

describe('buildHarnessArgv', () => {
  test('emits the exact measured argv for a representative claim', () => {
    expect(buildHarnessArgv(CLAIM)).toEqual([
      '-p', CLAIM.prompt,
      '--verbose',
      '--output-format', 'stream-json',
      '--model', 'claude-haiku-4-5-20251001',
      '--tools', '',
      '--disallowedTools', DISALLOWED.join(','),
      '--permission-mode', 'dontAsk',
      '--permission-prompts', 'none',
      '--allowedTools', 'mcp__gbrain__get_page,mcp__gbrain__put_page',
      '--mcp-config', MCP_CONFIG,
      '--strict-mcp-config',
      '--max-budget-usd', '0.25',
    ]);
  });

  // F2: without --verbose the harness exits 1 before a single frame. A missing
  // `--verbose` is not a style regression, it is every run failing.
  test('--verbose rides with -p, because stream-json exits 1 without it (F2)', () => {
    const argv = buildHarnessArgv(CLAIM);
    expect(argv).toContain('-p');
    expect(argv).toContain('--verbose');
  });

  // F3: a weaker fence than the network, but the strongest tool fence available.
  test('--tools "" removes the built-in surface at the source and keeps the deny-list (F3, D5)', () => {
    const argv = buildHarnessArgv(CLAIM);
    const i = argv.indexOf('--tools');
    expect(argv[i + 1]).toBe('');
    const d = argv.indexOf('--disallowedTools');
    expect(argv[d + 1]!.split(',')).toContain('Bash');
    expect(argv[d + 1]!.split(',')).toContain('Write');
    expect(argv[d + 1]!.split(',')).toContain('Edit');
  });

  test('the model is the claim\'s, never a constant', () => {
    const argv = buildHarnessArgv({ ...CLAIM, model: 'claude-opus-5' });
    expect(argv[argv.indexOf('--model') + 1]).toBe('claude-opus-5');
  });

  test('exactly one MCP server, with the run bearer as a static header (P4)', () => {
    const argv = buildHarnessArgv(CLAIM);
    const config = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]!);
    expect(Object.keys(config.mcpServers)).toEqual(['gbrain']);
    expect(config.mcpServers.gbrain).toEqual({
      type: 'http',
      url: 'https://localhost/mcp',
      headers: { Authorization: 'Bearer gbrain-run-token-abc' },
    });
    expect(argv).toContain('--strict-mcp-config');
  });

  // F5/D7: the gateway token goes out as `Authorization: Bearer` on the model
  // request. In argv it would be readable by any `ps` in the container.
  test('the gateway token is nowhere in argv', () => {
    expect(buildHarnessArgv(CLAIM).join(' ')).not.toContain(CLAIM.gateway.token);
  });

  // G2: an argv array, never a shell string. Values survive as whole elements.
  test('a prompt with quotes and metacharacters is exactly one argv element', () => {
    const argv = buildHarnessArgv({ ...CLAIM, prompt: 'a "quoted" $(rm -rf /) | b' });
    expect(argv[1]).toBe('a "quoted" $(rm -rf /) | b');
    expect(argv).toHaveLength(buildHarnessArgv(CLAIM).length);
  });

  test('refuses a claim with an empty allowlist rather than running with no tools', () => {
    expect(() => buildHarnessArgv({ ...CLAIM, allowedTools: [] }))
      .toThrow('allowedTools is empty');
    expect(() => buildHarnessArgv({ ...CLAIM, allowedTools: ['  '] }))
      .toThrow('allowedTools is empty');
  });

  test('refuses a tool outside the closed list, qualified or not', () => {
    // A bare built-in name: the harness would read it as a built-in tool.
    expect(() => buildHarnessArgv({ ...CLAIM, allowedTools: ['Bash'] }))
      .toThrow('Bash is not on the closed gbrain tool list');
    // F11: on the grant's allowedOperations, absent from the granted surface.
    expect(() => buildHarnessArgv({ ...CLAIM, allowedTools: ['mcp__gbrain__delete_page'] }))
      .toThrow('mcp__gbrain__delete_page is not on the closed gbrain tool list');
    // The right shape, the wrong server.
    expect(() => buildHarnessArgv({ ...CLAIM, allowedTools: ['mcp__slack__post_message'] }))
      .toThrow('mcp__slack__post_message is not on the closed gbrain tool list');
  });

  test('refuses a claim missing what the run cannot do without', () => {
    expect(() => buildHarnessArgv({ ...CLAIM, prompt: '  ' })).toThrow('prompt is empty');
    expect(() => buildHarnessArgv({ ...CLAIM, model: '' })).toThrow('model is empty');
    expect(() => buildHarnessArgv({ ...CLAIM, mcp: { url: 'https://localhost/mcp', token: '' } }))
      .toThrow('mcp.token is empty');
    expect(() => buildHarnessArgv({ ...CLAIM, mcp: { url: '', token: 't' } }))
      .toThrow('mcp.url is empty');
    expect(() => buildHarnessArgv({ ...CLAIM, budgetUsd: 0 })).toThrow('budgetUsd is not positive');
  });
});

describe('buildHarnessEnv', () => {
  const BASE = {
    PATH: '/opt/harness/bin:/usr/local/bin',
    HOME: '/home/runner',
    NODE_EXTRA_CA_CERTS: '/etc/ssl/caddy-root.crt',
    DISABLE_AUTOUPDATER: '1',
    RUNNER_TOKEN: 'the-runner-bearer',
    CONTROL_URL: 'http://control-plane:3150',
  } as unknown as NodeJS.ProcessEnv;

  test('points the harness at the gateway with the run token (F5, D7)', () => {
    const env = buildHarnessEnv(CLAIM, BASE);
    expect(env.ANTHROPIC_BASE_URL).toBe('http://control-plane:3150/api/gateway');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('gateway-run-token-xyz');
  });

  // D1/S2: the child executes model-chosen code. It must not hold the bearer
  // that can claim runs, no matter which tool the model talks itself into.
  test('never hands the child the runner bearer or the control URL', () => {
    const env = buildHarnessEnv(CLAIM, BASE);
    expect(env.RUNNER_TOKEN).toBeUndefined();
    expect(env.CONTROL_URL).toBeUndefined();
  });

  test('keeps the CA and the silence vars the image depends on', () => {
    const env = buildHarnessEnv(CLAIM, BASE);
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/caddy-root.crt');
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
    expect(env.PATH).toBe('/opt/harness/bin:/usr/local/bin');
    expect(env.HOME).toBe('/home/runner');
  });

  test('refuses a claim with no gateway, rather than letting the child default', () => {
    expect(() => buildHarnessEnv({ ...CLAIM, gateway: { url: '', token: 't' } }, BASE))
      .toThrow('gateway.url is empty');
    expect(() => buildHarnessEnv({ ...CLAIM, gateway: { url: 'http://c:3150/g', token: '' } }, BASE))
      .toThrow('gateway.token is empty');
  });
});

// --- the audit receipt -------------------------------------------------------

/**
 * P2-b, verbatim: the assistant frame carrying the `tool_use` block.
 */
const ASSISTANT_TOOL_USE = '{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001",'
  + '"id":"msg_011Cf9Ba2m9e8RkHqr7MKL7V","type":"message","role":"assistant","content":'
  + '[{"type":"tool_use","id":"toolu_01HjZUDZEfYKhEJjkd3sPqo4","name":"Read",'
  + '"input":{"file_path":"/tmp/probe/notes.txt"},"caller":{"type":"direct"}}],'
  + '"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,'
  + '"cache_creation_input_tokens":3032,"cache_read_input_tokens":17512,'
  + '"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":3032},'
  + '"output_tokens":3,"service_tier":"standard","inference_geo":"not_available"}},'
  + '"parent_tool_use_id":null,"session_id":"54726187-4936-48eb-85ac-31e712e71bf6",'
  + '"uuid":"698a02ba-192e-479d-bd61-2370fd474de9","timestamp":"2026-09-17T14:38:48.693Z",'
  + '"request_id":"req_011Cf9Ba2Gt6M1WCV3oX9s43",'
  + '"wire_tool_inputs":{"toolu_01HjZUDZEfYKhEJjkd3sPqo4":{"file_path":"/tmp/probe/notes.txt"}}}';

/**
 * P2-b, verbatim: the tool RESULT arrives on a `user` frame, never on an
 * assistant one. This is the only place the tool's output appears.
 */
const USER_TOOL_RESULT = '{"type":"user","message":{"role":"user","content":'
  + '[{"tool_use_id":"toolu_01HjZUDZEfYKhEJjkd3sPqo4","type":"tool_result",'
  + '"content":"1\\tPROBE-LINE-ALPHA\\n2\\tsecond line\\n3\\t"}]},'
  + '"tool_use_result":{"type":"text","file":{"filePath":"/tmp/probe/notes.txt",'
  + '"content":"PROBE-LINE-ALPHA\\nsecond line\\n","numLines":3,"startLine":1,"totalLines":3}}}';

/** P2-a, verbatim: the terminal `result` frame. */
const RESULT_OK = '{"duration_api_ms":1868,"stop_reason":"end_turn",'
  + '"session_id":"8d003c68-24a3-44d7-ba4a-47c4529a60a3","total_cost_usd":0.0154847,'
  + '"usage":{"input_tokens":10,"cache_creation_input_tokens":6922,'
  + '"cache_read_input_tokens":13607,"output_tokens":54,'
  + '"output_tokens_details":{"thinking_tokens":27},'
  + '"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},'
  + '"service_tier":"standard",'
  + '"cache_creation":{"ephemeral_1h_input_tokens":6922,"ephemeral_5m_input_tokens":0},'
  + '"inference_geo":"not_available","iterations":[{"input_tokens":10,"output_tokens":54,'
  + '"cache_read_input_tokens":13607,"cache_creation_input_tokens":6922,'
  + '"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":6922},'
  + '"type":"message"}],"speed":"standard"},'
  + '"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":10,"outputTokens":54,'
  + '"cacheReadInputTokens":13607,"cacheCreationInputTokens":6922,"webSearchRequests":0,'
  + '"costUSD":0.0154847,"contextWindow":200000,"maxOutputTokens":32000,"thinkingTokens":27,'
  + '"canonicalModel":"claude-haiku-4-5","provider":"firstParty","costBasis":"list"}},'
  + '"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off",'
  + '"fast_mode_disabled_reason":"sdk_opt_in_required","is_error":false,"num_turns":1,'
  + '"subtype":"success","api_error_status":null,"result":"Hey! \\ud83d\\udc4b Ready to help.",'
  + '"ttft_ms":1681,"type":"result","duration_ms":2003,"ttft_stream_ms":1424,'
  + '"time_to_request_ms":133,"first_content_frame_ms":1425,"queued_turn_count":0,'
  + '"result_index":0}';

/** P2-a's init frame's shape: the measured key set, with `tools` empty (F3). */
const SYSTEM_INIT = '{"type":"system","subtype":"init","cwd":"/tmp/agent-run/1111",'
  + '"session_id":"767a39c8-f737-4331-a7bc-94654baacd88","tools":["mcp__gbrain__put_page"],'
  + '"mcp_servers":[{"name":"gbrain","status":"connected","source":"dynamic"}],'
  + '"model":"claude-haiku-4-5-20251001","permissionMode":"dontAsk"}';

/** A real `system/api_retry` frame, captured off the pinned binary. */
const SYSTEM_API_RETRY = '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,'
  + '"retry_delay_ms":520,"error_status":null,"error":"unknown",'
  + '"session_id":"767a39c8-f737-4331-a7bc-94654baacd88",'
  + '"uuid":"3f71d94b-b8ac-4936-8242-a2597405110d"}';

const SYSTEM_THINKING = '{"type":"system","subtype":"thinking_tokens","estimated_tokens":27,'
  + '"session_id":"54726187-4936-48eb-85ac-31e712e71bf6",'
  + '"uuid":"0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0"}';

const RATE_LIMIT = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning",'
  + '"resetsAt":1790000000,"rateLimitType":"five_hour","utilization":0.31},'
  + '"session_id":"8d003c68-24a3-44d7-ba4a-47c4529a60a3",'
  + '"uuid":"1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809"}';

/** P2-a's frame order; the tool-use arm adds the two middle shapes (P2-b). */
const STREAM = [
  SYSTEM_INIT,
  RATE_LIMIT,
  SYSTEM_THINKING,
  SYSTEM_THINKING,
  ASSISTANT_TOOL_USE,
  USER_TOOL_RESULT,
  ASSISTANT_TOOL_USE,
  RATE_LIMIT,
  RESULT_OK,
].join('\n') + '\n';

const KINDS = [
  'system/init',
  'rate_limit_event',
  'system/thinking_tokens',
  'system/thinking_tokens',
  'assistant',
  'user',
  'assistant',
  'rate_limit_event',
  'result',
];

describe('parseStreamJson', () => {
  test('parses the measured frame sequence, in order', () => {
    const { frames, badLines, carry } = parseStreamJson(STREAM);
    expect(carry).toBe('');
    expect(badLines).toEqual([]);
    expect(frames.map((f) => normalizeEvent(f, 0).kind)).toEqual(KINDS);
  });

  /**
   * P2-a/P2-b, the whole vocabulary this pin emits. Seven shapes, plus this
   * mapping's fallback for a shape a future harness adds — a parser that only
   * knew `assistant`/`result` would drop the `tool_use_result` payload, which is
   * the only place a tool's output appears.
   */
  test('names every measured frame shape, and keeps an unmeasured one as itself', () => {
    const shapes: Array<[string, string]> = [
      [SYSTEM_INIT, 'system/init'],
      [SYSTEM_API_RETRY, 'system/api_retry'],
      [SYSTEM_THINKING, 'system/thinking_tokens'],
      [ASSISTANT_TOOL_USE, 'assistant'],
      [USER_TOOL_RESULT, 'user'],
      [RATE_LIMIT, 'rate_limit_event'],
      [RESULT_OK, 'result'],
      ['{"type":"prompt_suggestion","suggestion":"x"}', 'prompt_suggestion'],
    ];
    for (const [line, kind] of shapes) {
      const { frames, badLines } = parseStreamJson(`${line}\n`);
      expect(badLines).toEqual([]);
      expect(normalizeEvent(frames[0], 0).kind).toBe(kind);
    }
  });

  // The whole point of the carry: the kernel hands us arbitrary chunks. A split
  // in the middle of a frame must not drop or corrupt the frame.
  test('a chunk boundary inside a frame produces the same frames as one chunk', () => {
    const whole = parseStreamJson(STREAM).frames.map((f) => normalizeEvent(f, 0).kind);

    const chunks = [STREAM.slice(0, 200), STREAM.slice(200, 1200), STREAM.slice(1200)];
    let carry = '';
    const kinds: string[] = [];
    for (const chunk of chunks) {
      const parsed = parseStreamJson(chunk, carry);
      carry = parsed.carry;
      expect(parsed.badLines).toEqual([]);
      for (const frame of parsed.frames) kinds.push(normalizeEvent(frame, 0).kind);
    }
    expect(carry).toBe('');
    expect(kinds).toEqual(whole);
  });

  test('holds an unterminated final line back as the carry, and flushes it at EOF', () => {
    const first = parseStreamJson(`${SYSTEM_INIT}\n${RESULT_OK}`);
    expect(first.frames).toHaveLength(1);
    expect(first.frames[0]).toMatchObject({ type: 'system', subtype: 'init' });
    expect(first.carry).toBe(RESULT_OK);

    // Output can end without a trailing newline; that last frame is a frame.
    const flushed = parseStreamJson('\n', first.carry);
    expect(flushed.carry).toBe('');
    expect(flushed.badLines).toEqual([]);
    expect(flushed.frames).toEqual([JSON.parse(RESULT_OK)]);
  });

  test('a frame truncated by the end of the stream is reported, never dropped', () => {
    const { frames, badLines } = parseStreamJson('\n', ASSISTANT_TOOL_USE.slice(0, 40));
    expect(frames).toEqual([]);
    expect(badLines).toHaveLength(1);
  });

  test('reports a malformed line instead of dropping it silently', () => {
    const { frames, badLines } = parseStreamJson(`not json\n${RESULT_OK}\n`);
    expect(frames).toHaveLength(1);
    expect(badLines).toEqual(['not json']);
  });

  test('skips blank lines, and handles CRLF', () => {
    const { frames, badLines } = parseStreamJson(`\n\n${RESULT_OK}\r\n\r\n`);
    expect(frames).toHaveLength(1);
    expect(badLines).toEqual([]);
  });
});

describe('normalizeEvent', () => {
  test('names the frame, sequences it, and redacts the payload', () => {
    const event = normalizeEvent(JSON.parse(SYSTEM_INIT), 7);
    expect(event.seq).toBe(7);
    expect(event.kind).toBe('system/init');
    expect(event.data).toMatchObject({ permissionMode: 'dontAsk' });
  });

  test('the tool result rides the user frame, not the assistant one', () => {
    const { frames } = parseStreamJson(STREAM);
    const user = frames[5];
    const event = normalizeEvent(user, 5);
    expect(event.kind).toBe('user');
    expect((event.data as { tool_use_result?: unknown }).tool_use_result)
      .toMatchObject({ type: 'text' });
  });

  test('an unmeasured frame shape is recorded as itself, never dropped', () => {
    expect(normalizeEvent({ type: 'prompt_suggestion', suggestion: 'x' }, 0).kind)
      .toBe('prompt_suggestion');
    expect(normalizeEvent({ type: 'system' }, 0).kind).toBe('system');
    expect(normalizeEvent('nonsense', 0).kind).toBe('unknown');
  });

  test('redacts credentials that a frame carries with scrubOutput (D4)', () => {
    const event = normalizeEvent(
      { type: 'result', result: 'dsn postgres://gbrain:hunter2@postgres:5432/control' },
      0,
    );
    expect(JSON.stringify(event.data)).not.toContain('hunter2');
  });
});

describe('error frames (honesty rule 1, F10)', () => {
  test('a non-zero exit or an is_error result frame is the failure signal', () => {
    expect(isErrorFrame(JSON.parse(RESULT_OK))).toBe(false);
    expect(isErrorFrame({ type: 'result', is_error: true })).toBe(true);
    expect(isErrorFrame({ type: 'assistant' })).toBe(false);
  });

  // F10: a SUCCESSFUL MCP write reports status "skipped" with chunk_skip_reason
  // "write_skipped" and write_through.written true. A parser that read `status`
  // as a failure would fail every successful run.
  //
  // The envelope is the live one: the harness wraps an MCP tool result as
  // `{type:'text', text:'<the tool's JSON>'}` — captured from a real run of the
  // pinned harness against a stub MCP server, where the model called
  // `mcp__gbrain__put_page`. The payload inside is P8's, verbatim.
  test('a skipped write with write_through.written true is not a failure', () => {
    const payload = JSON.stringify({
      slug: 'probe-runner/p8-probe',
      status: 'skipped',
      chunks: 0,
      chunk_skip_reason: 'write_skipped',
      write_through: {
        written: true,
        path: '/srv/brain-repos/shared/probe-runner/p8-probe.md',
      },
    });
    const frame = {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          tool_use_id: 'toolu_01HDhYwaEpGkb2CVHuyP2hZ4',
          type: 'tool_result',
          content: payload,
        }],
      },
      tool_use_result: { type: 'text', text: payload },
    };
    expect(isErrorFrame(frame)).toBe(false);
    const event = normalizeEvent(frame, 3);
    expect(event.kind).toBe('user');
    // ...and the write is visible in the receipt, including its `written: true`.
    const inner = JSON.parse(
      (event.data as { tool_use_result: { text: string } }).tool_use_result.text,
    ) as { status: string; write_through: { written: boolean } };
    expect(inner.status).toBe('skipped');
    expect(inner.write_through.written).toBe(true);
  });

  test('reads the turn count off the result frame when it reports one', () => {
    expect(numTurnsOf(JSON.parse(RESULT_OK))).toBe(1);
    expect(numTurnsOf({ type: 'assistant' })).toBeNull();
  });
});

describe('the runner\'s own first act (S2, D1)', () => {
  // D1: the runner is a client of the control plane and never of the database.
  // The token it holds is the whole of its authority; a DB URL or an ops token
  // appearing in this directory is that boundary being crossed.
  test('names no database URL, no ops token and no provider key', async () => {
    const forbidden: Record<string, true> = {
      CONTROL_DATABASE_URL: true,
      DATABASE_URL: true,
      OPS_RPC_TOKEN: true,
      OPS_RPC_URL: true,
      GBRAIN_HOME: true,
      ANTHROPIC_API_KEY: true,
    };
    const files = ['main.ts', 'client.ts', 'harness.ts', 'workspace.ts', 'pin.ts'];
    const offenders: string[] = [];
    for (const file of files) {
      const source = await Bun.file(join(import.meta.dir, '..', '..', 'src', 'runner', file)).text();
      for (const [line, index] of source.split('\n').map((l, i) => [l, i + 1] as const)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
        for (const name of Object.keys(forbidden)) {
          if (line.includes(name)) offenders.push(`${file}:${index} ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('refuses a token that is unset, empty or whitespace', () => {
    expect(() => assertRunnerEnv({} as unknown as NodeJS.ProcessEnv))
      .toThrow('RUNNER_TOKEN is unset or empty');
    expect(() => assertRunnerEnv({ RUNNER_TOKEN: '' } as unknown as NodeJS.ProcessEnv))
      .toThrow('RUNNER_TOKEN is unset or empty');
    expect(() => assertRunnerEnv({ RUNNER_TOKEN: '   ' } as unknown as NodeJS.ProcessEnv))
      .toThrow('RUNNER_TOKEN is unset or empty');
    expect(assertRunnerEnv({ RUNNER_TOKEN: 'tok' } as unknown as NodeJS.ProcessEnv)).toBe('tok');
  });

  // The guard is only real if the PROCESS exits non-zero before claiming. This
  // runs the real entrypoint with the environment compose interpolates for a
  // runner-less deployment: `${RUNNER_TOKEN:-}`.
  test('the process exits non-zero, naming the variable, before any claim', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/runner/main.ts'], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        CONTROL_URL: 'http://127.0.0.1:1',
        RUNNER_TOKEN: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain('RUNNER_TOKEN is unset or empty');
  });
});
