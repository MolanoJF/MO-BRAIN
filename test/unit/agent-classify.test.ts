import { test, expect, describe } from 'bun:test';
import { classifyAgentExit, retryPolicyFor } from '../../src/agent/classify.ts';
import { AGENT_ALERT_KINDS } from '../../src/agent/alerts.ts';

describe('classifyAgentExit reads L8, it never invents a second vocabulary', () => {
  test('a clean exit with a clean stream is a success, not a failure class', () => {
    expect(classifyAgentExit({ exitCode: 0 })).toBeNull();
    expect(classifyAgentExit({ exitCode: 0, errorFrames: 0, finalMessage: 'nothing to do' }))
      .toBeNull();
  });

  test('exit 143 is the timeout our own SIGTERM produced, and it is never retried', () => {
    expect(classifyAgentExit({ exitCode: 143 })).toBe('timeout');
    expect(retryPolicyFor('timeout', 1).retry).toBe(false);
  });

  test('exit 4 is LOCK_LOST — infrastructure ownership, not an agent mistake', () => {
    // L8 / Slice-0 V5: gbrain's supervisor defines ExitCodes.LOCK_LOST = 4,
    // "the queue-scoped DB lock was lost mid-run". Someone else owns this now.
    expect(classifyAgentExit({ exitCode: 4 })).toBe('infra_failed');
    expect(retryPolicyFor('infra_failed', 1).retry).toBe(true);
  });

  test('a harness the runner could not spawn at all is infrastructure', () => {
    // The runner reports -1 when no process ever produced an exit code — D11's
    // "harness spawn failure". Not the agent's fault, and it retries.
    expect(classifyAgentExit({ exitCode: -1 })).toBe('infra_failed');
  });

  test('any other non-zero exit is agent_failed', () => {
    for (const code of [1, 2, 5, 130, 137]) {
      expect(classifyAgentExit({ exitCode: code })).toBe('agent_failed');
    }
  });
});

describe('honesty rule 1: a harness does not grade its own run', () => {
  test('a cheerful final message after an error frame is a failed run', () => {
    // The receipt is the stream plus the git range. The model is not a witness.
    expect(classifyAgentExit({
      exitCode: 0,
      errorFrames: 1,
      finalMessage: 'All done! Everything worked perfectly and nothing needs attention.',
    })).toBe('agent_failed');
  });

  test('a despondent final message over a clean stream is still a success', () => {
    // The other direction, and why `finalMessage` is carried and never read:
    // the status comes from the receipt, in BOTH directions.
    expect(classifyAgentExit({
      exitCode: 0, errorFrames: 0, finalMessage: 'I could not finish this. Sorry.',
    })).toBeNull();
  });

  test('a non-zero exit is a failure whatever the last message claims', () => {
    expect(classifyAgentExit({ exitCode: 1, finalMessage: 'Success — everything passes.' }))
      .toBe('agent_failed');
  });
});

describe('L14: a class a witness already recorded wins over the exit code', () => {
  test('a timeout after the meter refused the cap is budget_exceeded, not a timeout', () => {
    // D7's mid-stream cap closes the upstream, the harness dies, and the
    // runner's own timeout may fire first. The meter witnessed the cause and
    // the exit code is only its symptom: D11 alerts on the money, not the clock.
    expect(classifyAgentExit({ exitCode: 143, recorded: 'budget_exceeded' }))
      .toBe('budget_exceeded');
    expect(retryPolicyFor('budget_exceeded', 1).retry).toBe(false);
  });

  test('a declared refusal is never re-derived into agent_failed', () => {
    expect(classifyAgentExit({ exitCode: 1, recorded: 'refused' })).toBe('refused');
  });
});

describe("D11's retry table", () => {
  test('infra_failed retries, and the cap is 2 — the third attempt is the last', () => {
    const first = retryPolicyFor('infra_failed', 1);
    expect(first.retry).toBe(true);
    expect(first.nextAttempt).toBe(2);
    expect(first.cap).toBe(2);

    const second = retryPolicyFor('infra_failed', 2);
    expect(second.retry).toBe(true);
    expect(second.nextAttempt).toBe(3);

    const third = retryPolicyFor('infra_failed', 3);
    expect(third.retry).toBe(false);
    expect(third.nextAttempt).toBeNull();
    expect(third.cap).toBe(2);
  });

  test('nothing else retries, ever', () => {
    for (const cls of ['budget_exceeded', 'timeout', 'agent_failed', 'refused'] as const) {
      const policy = retryPolicyFor(cls, 1);
      expect(policy.retry).toBe(false);
      expect(policy.nextAttempt).toBeNull();
      expect(policy.cap).toBe(0);
    }
    expect(retryPolicyFor(null, 1).retry).toBe(false);
  });

  test('every decision carries its reason, as prose an operator reads', () => {
    // L14: the reason is stored on the row so no renderer reconstructs it.
    const classes = [
      'infra_failed', 'budget_exceeded', 'timeout', 'agent_failed', 'refused', null,
    ] as const;
    for (const cls of classes) {
      const { reason } = retryPolicyFor(cls, 1);
      expect(reason).toContain(' ');
      expect(reason).not.toContain('_');
    }
    // ...and it is not one sentence copied across six rows.
    expect(new Set(classes.map((c) => retryPolicyFor(c, 1).reason)).size).toBe(classes.length);
  });
});

describe('the five agent alert kinds', () => {
  test('the kind strings are the ones the plan names', () => {
    expect(Object.values(AGENT_ALERT_KINDS).sort()).toEqual([
      'agent_budget_exceeded', 'agent_read_space_moved', 'agent_run_failed',
      'harness_pin_mismatch', 'runner_never_seen',
    ]);
  });
});
