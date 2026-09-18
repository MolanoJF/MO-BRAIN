import { test, expect, describe } from 'bun:test';
import {
  runnerStateLabel, runnerStateTone, runnerBanner, runStatusLine, failureText, revertedLine,
  costText, budgetText, costNote, tokensText, eventLabel, toolCalls, errorFrameCount,
  agentSelfSummary, diffText, isForeignCommit, fileStatusLabel, readSpaceMoveAlert,
  revertChoice, revertSuccessText, REVERT_DISCLOSURE,
} from '../../src/console/pages/Runs.tsx';
import { AGENT_RUNNER_WARNING } from '../../src/console/pages/Access.tsx';
import type { AgentRunEventRow, AgentRunRow, AgentRunUsageRow } from '../../src/console/api.ts';
import type { DiffSummary } from '../../src/agent/types.ts';

/**
 * The console's runs lane. Every one of these assertions is a trust property
 * rather than a rendering detail: the runner's three states (honesty rule 8), a
 * cost that could not be priced (rule 3), a diff that cannot be attributed
 * (rule 6), a read Space that moved (rule 10), and a run whose status must never
 * come from the agent's own closing message (rule 1).
 */

const run = (over: Partial<AgentRunRow> = {}): AgentRunRow => ({
  runId: 'run-1',
  scheduleId: 'sch-1',
  scheduleName: 'nightly-briefing',
  state: 'succeeded',
  attempt: 1,
  slot: '2026-09-17T02:00',
  fireAt: '2026-09-17T06:00:00.000Z',
  startedAt: '2026-09-17T06:00:01.000Z',
  finishedAt: '2026-09-17T06:03:00.000Z',
  model: 'claude-opus-4-1-20250805',
  harnessVersion: '2.1.274',
  budgetUsd: '5.00',
  costUsd: '0.012164',
  failureClass: null,
  numTurns: 3,
  revertedAt: null,
  revertCommit: null,
  ...over,
});

const usage = (over: Partial<AgentRunUsageRow> = {}): AgentRunUsageRow => ({
  seq: 1,
  at: '2026-09-17T06:00:02.000Z',
  model: 'claude-opus-4-1-20250805',
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadTokens: 8000,
  cacheWriteTokens: 6900,
  costUsd: '0.012164',
  stopReason: 'end_turn',
  httpStatus: 200,
  ...over,
});

const event = (seq: number, kind: string, data: unknown): AgentRunEventRow => ({
  seq, at: '2026-09-17T06:00:02.000Z', kind, data,
});

const call = (toolUseId: string, name: string, input: unknown) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: toolUseId, name, input }] },
});

const result = (toolUseId: string, content: unknown, isError = false) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
});

const diff = (over: Partial<DiffSummary> = {}): DiffSummary => ({
  write: {
    sourceId: 'shared',
    before: 'aaaaaaaaaaaa',
    after: 'bbbbbbbbbbbb',
    commits: [
      { sha: 'bbbbbbbbbbbb', author: 'Ada Ops', email: 'ada@example.test', subject: 'briefing', at: '2026-09-17T06:01:00.000Z' },
      { sha: 'cccccccccccc', author: 'Ada Ops', email: 'ada@example.test', subject: 'notes', at: '2026-09-17T06:02:00.000Z' },
    ],
    files: [{ status: 'A', path: 'reports/briefing.md' }],
    concurrentWriters: false,
    foreignCommitCount: 0,
    foreignAuthors: [],
  },
  readSpaceMoves: [],
  concurrentWriters: false,
  ...over,
});

describe('the runner states — honesty rule 8', () => {
  test('only `connected` is green', () => {
    expect(runnerStateTone('connected')).toBe('ok');
    for (const state of ['disabled', 'never_claimed', 'unreported', 'enabled', '']) {
      expect(runnerStateTone(state)).not.toBe('ok');
    }
  });

  test('disabled and never_claimed are two different states, not two shades of one', () => {
    expect(runnerStateLabel('disabled')).not.toBe(runnerStateLabel('never_claimed'));
    const disabled = runnerBanner({ state: 'disabled', lastSeenAt: null, version: null });
    const never = runnerBanner({ state: 'never_claimed', lastSeenAt: null, version: null });
    expect(disabled).not.toBe(never);
    // "the runner is enabled" is not "the runner is connected": the configured
    // state must say so in words.
    expect(never).toMatch(/enabled is not the same as being connected/i);
    expect(disabled).toMatch(/not part of this deployment/i);
  });

  test('the banner reads lastSeenAt, because state alone cannot tell never from lapsed', () => {
    const never = runnerBanner({ state: 'never_claimed', lastSeenAt: null, version: null });
    const lapsed = runnerBanner({
      state: 'never_claimed', lastSeenAt: '2026-09-16T02:00:00.000Z', version: null,
    });
    expect(never).toMatch(/no claim has ever been recorded/i);
    expect(lapsed).not.toMatch(/no claim has ever been recorded/i);
    expect(lapsed).toContain(new Date('2026-09-16T02:00:00.000Z').toLocaleString());
  });

  test('a control plane that reports nothing is not called disabled, and is not green', () => {
    const text = runnerBanner({ state: 'unreported', lastSeenAt: null, version: null });
    expect(text).toMatch(/did not report a runner state/i);
    expect(runnerStateTone('unreported')).not.toBe('ok');
  });

  test('a state this build does not know is named, and is never read as connected', () => {
    const text = runnerBanner({ state: 'wat', lastSeenAt: null, version: null });
    expect(text).toContain('wat');
    expect(text).toMatch(/not connected/i);
  });

  test('a load still in flight is distinct from every state', () => {
    expect(runnerBanner(null)).toMatch(/checking/i);
  });
});

describe('the run status — honesty rule 1', () => {
  test('every failure class this build knows gets its own diagnosis, from the row', () => {
    const classes = ['infra_failed', 'budget_exceeded', 'timeout', 'agent_failed', 'refused'];
    const texts = classes.map((c) => failureText(run({ state: 'failed', failureClass: c })));
    for (const [i, text] of texts.entries()) expect(text).not.toBeNull();
    expect(new Set(texts).size).toBe(classes.length);
    expect(texts[0]).toMatch(/retries|retried/i);
    expect(texts[1]).toMatch(/never retried/i);
  });

  test('a class this console has never seen is surfaced, not hidden behind a friendly word', () => {
    expect(failureText(run({ state: 'failed', failureClass: 'melted' }))).toContain('melted');
  });

  test('a run that did not fail has no failure sentence at all', () => {
    expect(failureText(run())).toBeNull();
    expect(runStatusLine(run())).toContain('Succeeded');
  });

  test('the agent\'s closing message is displayed, but never becomes the status', () => {
    const events = [
      event(1, 'assistant', call('t1', 'Read', { file_path: 'x' })),
      event(2, 'result', { type: 'result', subtype: 'success', is_error: false, result: 'Everything is fine.' }),
      event(3, 'error', { type: 'error', is_error: true, message: 'stream failed' }),
    ];
    const row = run({ state: 'failed', failureClass: 'agent_failed' });
    expect(agentSelfSummary(events)).toBe('Everything is fine.');
    expect(errorFrameCount(events)).toBe(1); // the `error` frame; the result frame is not one
    expect(runStatusLine(row)).toMatch(/error frames/i);
    expect(runStatusLine(row)).not.toMatch(/fine/i);
  });

  test('the state is the scheduler\'s own vocabulary — no raw enum reaches the reader', () => {
    const line = runStatusLine(run({ state: 'lease_expired', failureClass: 'infra_failed', attempt: 2 }));
    expect(line).toContain('Lease expired');
    expect(line).toContain('attempt 2');
    expect(line).not.toContain('lease_expired');
  });

  test('a normal result frame is not counted as an error, and a tool error is not a run error', () => {
    const ok = [event(1, 'result', { type: 'result', subtype: 'success', is_error: false, result: 'done' })];
    const toolError = [event(1, 'user', result('t1', 'not found', true))];
    expect(errorFrameCount(ok)).toBe(0);
    expect(errorFrameCount(toolError)).toBe(0);
  });

  test('a reverted run names the commit that reverted it', () => {
    expect(revertedLine(run())).toBeNull();
    const line = revertedLine(run({ revertedAt: '2026-09-17T07:00:00.000Z', revertCommit: 'dddddddd' }));
    expect(line).toContain('dddddddd');
    expect(line).toMatch(/never a history rewrite/i);
  });
});

describe('cost and budget — honesty rule 3, U9', () => {
  test('a NULL cost renders as words, never as $0.00', () => {
    const text = costText(run({ costUsd: null, numTurns: 3 }));
    expect(text).not.toContain('$0.00');
    expect(text).toMatch(/not priced/i);
    expect(text).toMatch(/unknown, not zero/i);
  });

  test('a run with no priced call says that, rather than blaming the price table', () => {
    const text = costText(run({ costUsd: null, numTurns: 0 }));
    expect(text).not.toContain('$0.00');
    expect(text).toMatch(/no priced model call was recorded/i);
  });

  test('a real zero is still $0.00 — the NULL case does not swallow it', () => {
    expect(costText(run({ costUsd: '0', numTurns: 1 }))).toContain('$0.00');
  });

  test('the run cap is labelled as ours, so it cannot be confused with gbrain\'s daily budget', () => {
    const text = budgetText(run());
    expect(text).toContain('$5.00');
    expect(text).toContain('budget_usd_per_day');
    expect(text).toMatch(/not gbrain's/i);
    expect(text).toMatch(/two different budgets on different money/i);
  });

  test('an unpriced call makes the total a floor, and says so', () => {
    const note = costNote(run(), [usage(), usage({ seq: 2, costUsd: null })]);
    expect(note).toMatch(/1 of 2 metered call\(s\) could not be priced/i);
  });

  test('a rollup that disagrees with the calls it rolls up is called unverified', () => {
    const note = costNote(run({ costUsd: '9.99' }), [usage()]);
    expect(note).toMatch(/does not match the calls/i);
    expect(note).toMatch(/unverified/i);
  });

  test('agreement is silent — the warning is not printed on every healthy run', () => {
    expect(costNote(run(), [usage()])).toBeNull();
  });

  test('token counts are summed over the metered calls and say how many there were', () => {
    expect(tokensText([usage(), usage({ seq: 2, inputTokens: 800, outputTokens: 100 })])).toMatch(
      /2,000 in · 400 out · 16,000 cache read · 13,800 cache write, over 2 call\(s\)/,
    );
    expect(tokensText([])).toMatch(/no model call was metered/i);
  });
});

describe('the tool-call timeline', () => {
  test('a call and its result pair up, and the result is the only place the output appears', () => {
    const calls = toolCalls([
      event(1, 'assistant', call('t1', 'mcp__gbrain__search', { query: 'alpha' })),
      event(2, 'user', result('t1', 'PROBE-LINE-ALPHA')),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('mcp__gbrain__search');
    expect(calls[0]!.input).toContain('alpha');
    expect(calls[0]!.result).toBe('PROBE-LINE-ALPHA');
    expect(calls[0]!.isError).toBe(false);
  });

  test('a call with no recorded result is unanswered, not a success', () => {
    const calls = toolCalls([event(1, 'assistant', call('t1', 'Write', { path: 'x' }))]);
    expect(calls[0]!.result).toBeNull();
  });

  test('a tool error is marked as one, and content blocks are flattened to text', () => {
    const calls = toolCalls([
      event(1, 'assistant', call('t1', 'Read', {})),
      event(2, 'user', result('t1', [{ type: 'text', text: 'denied' }], true)),
    ]);
    expect(calls[0]!.isError).toBe(true);
    expect(calls[0]!.result).toBe('denied');
  });

  test('a frame that is not a tool call contributes no timeline row', () => {
    const calls = toolCalls([
      event(1, 'system/init', { type: 'system', subtype: 'init', model: 'claude-opus-4-1-20250805' }),
      event(2, 'rate_limit_event', { type: 'rate_limit_event' }),
    ]);
    expect(calls).toHaveLength(0);
  });

  test('every kind the runner can emit has a human label, and an unknown one is named', () => {
    for (const kind of ['system/init', 'system/api_retry', 'system/thinking_tokens', 'assistant', 'user', 'result', 'rate_limit_event', 'error']) {
      expect(eventLabel(kind)).not.toBe(kind);
    }
    expect(eventLabel('tool_use')).toContain('tool_use');
  });
});

describe('the diff hedge — honesty rule 6, D9', () => {
  test('foreign commits are stated as a count out of the range, never as gbrain\'s work', () => {
    const text = diffText(diff({
      write: {
        ...diff().write,
        commits: new Array(5).fill(diff().write.commits[0]!),
        concurrentWriters: true,
        foreignCommitCount: 2,
        foreignAuthors: ['Grace Writer <grace@example.test>'],
      },
      concurrentWriters: true,
    }));
    expect(text).toContain('2 of 5 commits in this range were not written by this run');
    expect(text).toContain('Grace Writer <grace@example.test>');
    expect(text).not.toMatch(/gbrain (wrote|committed)/i);
    expect(text).toMatch(/second, explicit confirmation/i);
  });

  test('a range that is entirely this run\'s work says exactly that', () => {
    const text = diffText(diff());
    expect(text).toMatch(/every commit in this range was written by this run's own writer/i);
    expect(text).not.toMatch(/were not written by this run/i);
  });

  test('an empty range is a fact, not a success and not an error', () => {
    const text = diffText(diff({ write: { ...diff().write, commits: [], files: [] } }));
    expect(text).toMatch(/range is empty/i);
    expect(text).not.toMatch(/every commit/i);
    expect(text).not.toMatch(/were not written/i);
  });

  test('no summary at all is not the same as an empty range', () => {
    const text = diffText(null);
    expect(text).toMatch(/no diff was recorded/i);
    expect(text).not.toMatch(/range is empty/i);
  });

  test('a commit can be marked foreign only through the attribution it arrived with', () => {
    const commit = { sha: 'a', author: 'Grace', email: 'grace@example.test', subject: 's', at: 'now' };
    expect(isForeignCommit(commit, ['Grace <grace@example.test>'])).toBe(true);
    expect(isForeignCommit(commit, [])).toBe(false);
  });

  test('git\'s own status token is spelled out, and kept', () => {
    expect(fileStatusLabel('A')).toBe('added');
    expect(fileStatusLabel('R100')).toContain('R100');
    expect(fileStatusLabel('X')).toBe('changed');
  });
});

describe('a read Space that moved — honesty rule 10', () => {
  test('a move is an alert naming the Space and both heads', () => {
    const text = readSpaceMoveAlert(diff({
      readSpaceMoves: [{ sourceId: 'customers', before: '1111111111', after: '2222222222' }],
    }));
    expect(text).toMatch(/read isolation broke/i);
    expect(text).toContain('customers');
    expect(text).toContain('1111111');
    expect(text).toContain('2222222');
    expect(text).toMatch(/alerted rather than shown as a diff row/i);
  });

  test('no move, or no diff at all, is no alert', () => {
    expect(readSpaceMoveAlert(diff())).toBeNull();
    expect(readSpaceMoveAlert(null)).toBeNull();
  });
});

describe('revert refusals are choices — D10', () => {
  test('a recorded revert names the commit and never offers a second revert', () => {
    const choice = revertChoice({
      error: 'already_reverted', runId: 'run-1', reason: 'recorded',
      revertedAt: '2026-09-17T07:00:00.000Z', revertCommit: 'dddddddd',
      detail: 'run run-1 was already reverted by commit dddddddd',
    });
    expect(choice.headline).toMatch(/already recorded as reverted/i);
    expect(choice.headline).toContain('dddddddd');
    expect(choice.confirmConcurrent).toBe(false);
    expect(choice.context).toContain('Reason: recorded');
  });

  test('an empty range is its own already-reverted, and does not claim a recorded revert', () => {
    const choice = revertChoice({
      error: 'already_reverted', runId: 'run-1', reason: 'empty_range', revertedAt: null, revertCommit: null,
      detail: 'the recorded range aaaaaaa..bbbbbbb in shared is empty',
    });
    expect(choice.headline).toMatch(/range recorded for this run is empty/i);
    expect(choice.headline).not.toMatch(/already recorded as reverted/i);
    expect(choice.context).toContain('Reason: empty_range');
  });

  test('an unknown already-reverted reason is named as unknown', () => {
    const choice = revertChoice({ error: 'already_reverted', runId: 'run-1', reason: 'wat' });
    expect(choice.headline).toContain('wat');
  });

  test('concurrent writers need a second explicit confirmation, and the count is the same hedge', () => {
    const choice = revertChoice({
      error: 'revert_concurrent_writers', runId: 'run-1', sourceId: 'shared',
      commitCount: 5, foreignCommitCount: 2, foreignAuthors: ['Grace Writer <grace@example.test>'],
      detail: '2 of 5 commits in aaaaaaa..bbbbbbb were not written by ada@example.test',
    });
    expect(choice.confirmConcurrent).toBe(true);
    expect(choice.headline).toContain('2 of 5 commits in this range were not written by this run');
    expect(choice.headline).toContain('Grace Writer <grace@example.test>');
    expect(choice.context).toContain('Write Space: shared');
  });

  test('a conflict is surfaced and never forced', () => {
    const choice = revertChoice({
      error: 'revert_conflict', runId: 'run-1', sourceId: 'shared',
      detail: 'git revert --no-commit did not apply cleanly',
    });
    expect(choice.confirmConcurrent).toBe(false);
    expect(choice.headline).toMatch(/does not revert cleanly/i);
    expect(choice.headline).toMatch(/no button here that forces it/i);
    expect(choice.context).toContain('git revert --no-commit did not apply cleanly');
  });

  test('a refusal code this build does not know is shown with its whole body, not swallowed', () => {
    const choice = revertChoice({ error: 'wat', runId: 'run-1', extra: 1 });
    expect(choice.code).toBe('wat');
    expect(choice.headline).toContain('wat');
    expect(choice.context.join(' ')).toContain('"extra":1');
    expect(choice.confirmConcurrent).toBe(false);
  });

  test('the button says what it will do before it is pressed', () => {
    expect(REVERT_DISCLOSURE).toMatch(/never rewrites history/i);
    expect(REVERT_DISCLOSURE).toMatch(/nothing reverts on its own/i);
    expect(REVERT_DISCLOSURE).toMatch(/re-indexes the brain/i);
  });

  test('success says the index moved back too — honesty rule 7', () => {
    const text = revertSuccessText({
      reverted: true, runId: 'run-1', sourceId: 'shared', revertCommit: 'eeeeeeee',
      revertedAt: '2026-09-17T07:00:00.000Z', files: [],
      index: {
        purge: [{
          slug: 'gate-c/r1/nightly', outcome: 'purged',
          detail: "removed from shared's index by name",
        }],
        sync: {}, embed: {},
      },
    });
    expect(text).toContain('eeeeeeee');
    expect(text).toMatch(/re-synced and re-embedded/i);
    // F16: the page that had to be removed BY NAME is the one the sync cannot
    // reach, and the line says so rather than leaving the operator to assume it.
    expect(text).toContain('gate-c/r1/nightly');
    expect(text).toMatch(/removed from the index by name/i);
    expect(text).toMatch(/stop answering searches/i);
    expect(text).not.toMatch(/left in the index/i);
  });

  // The other half of the same honesty rule: a purge the guard SKIPPED (the file
  // is still in the write Space, so the page is someone's live work) must be
  // visible, with its reason — a git-only revert must not read as a full one.
  test('a skipped purge is named, and the line does not claim the page is gone', () => {
    const text = revertSuccessText({
      reverted: true, runId: 'run-1', sourceId: 'shared', revertCommit: 'eeeeeeee',
      revertedAt: '2026-09-17T07:00:00.000Z', files: [],
      index: {
        purge: [{
          slug: 'gate-c/r1/nightly',
          outcome: 'skipped_file_present',
          detail: "gate-c/r1/nightly.md is still in the write Space's working tree, so "
            + 'gate-c/r1/nightly is live work rather than a reverted page: nothing was removed',
        }],
        sync: {}, embed: {},
      },
    });
    expect(text).toContain('gate-c/r1/nightly');
    expect(text).toMatch(/left in the index on purpose/i);
    expect(text).toMatch(/still answerable/i);
    expect(text).toMatch(/live work rather than a reverted page/i);
    expect(text).not.toMatch(/stop answering searches/i);
  });
});

describe('the Access page carries D12 in plain words', () => {
  test('it says what enabling the runner means, in the installer\'s own words', () => {
    expect(AGENT_RUNNER_WARNING).toContain(
      "This container runs model-written code against your brain, using your organization's API key, "
      + 'on a schedule, with nobody watching.',
    );
    expect(AGENT_RUNNER_WARNING).toContain('COMPOSE_PROFILES=runner');
    expect(AGENT_RUNNER_WARNING).toMatch(/nothing on this page can switch it on/i);
  });
});
