import { useEffect, useState } from 'react';
import {
  ApiError, runApi, type AgentRunDetail, type AgentRunEventRow, type AgentRunRow,
  type AgentRunUsageRow, type RevertSuccess, type RunnerStatusRow,
} from '../api.ts';
import { runStateLabel, runStateTone, type Tone } from './Schedules.tsx';
import type { DiffSummary, RangeCommit } from '../../agent/types.ts';

/**
 * The agent lane's own reading of a run: the LIST row, then one DETAIL page that
 * carries honesty rule 11's five items — prompt, tool calls, token counts, cost
 * and the brain diff — out of a single `GET /api/runs/:id` (see `runApi.detail`).
 *
 * Every pure function lives above the component because that is what the unit
 * tests import; there is no DOM harness in this repo. Nothing here re-derives a
 * fact the server already classified (L14): the state comes from
 * `schedule_runs.state`, the diagnosis from `agent_runs.failure_class`, the diff
 * from `agent_runs.diff_summary`, and the transcript is shown, never used as
 * evidence of success (honesty rule 1).
 */

const TONE_CLASS: Record<Tone, string> = {
  ok: 'text-ok', warning: 'text-warning', danger: 'text-danger', muted: 'text-muted',
};

const num = (n: number): string => n.toLocaleString('en-US');

/** A commit sha at the width the host tools print it. */
const short = (sha: string): string => (sha.length > 7 ? sha.slice(0, 7) : sha || 'unrecorded');

/** A stored amount, formatted. Never called with NULL: the callers say "not
 *  priced" in words instead, because a NULL cost rendered as $0.00 is the
 *  honesty-rule-3 bug this page exists to avoid. */
function money(amount: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `unreadable amount (${amount})`;
  return n === 0 ? '$0.00' : `$${n.toFixed(4)}`;
}

/**
 * Honesty rule 8 — three states, and only `connected` is green. `never_claimed`
 * is deliberately NOT a shade of `disabled`: the first says a runner is
 * configured and none is connected right now, the second says the container is
 * not part of this deployment at all. `unreported` is this console's own word
 * for a control plane that answers nothing, which is not green either.
 */
export function runnerStateLabel(state: string): string {
  switch (state) {
    case 'connected': return 'Runner connected';
    case 'never_claimed': return 'Runner configured — no runner connected';
    case 'disabled': return 'Runner disabled';
    case 'unreported': return 'Runner state not reported';
    default: return `Unknown runner state (${state})`;
  }
}

export function runnerStateTone(state: string): Tone {
  if (state === 'connected') return 'ok';
  if (state === 'disabled') return 'muted';
  // never_claimed, unreported, and any word this build does not know: none of
  // them is "a runner is connected", so none of them may be green.
  return 'warning';
}

/**
 * The banner reads BOTH fields, because `state` alone cannot tell "no runner has
 * ever claimed" from "the runner that claimed yesterday is not connected now".
 * `lastSeenAt` is the discriminator `src/agent/runners.ts` names: null means
 * literally never, a timestamp means a runner was here and is not any more.
 */
export function runnerBanner(status: RunnerStatusRow | null): string {
  if (status === null) return 'Checking the runner…';
  const last = status.lastSeenAt === null
    ? 'no claim has ever been recorded'
    : `last claim ${new Date(status.lastSeenAt).toLocaleString()}`;
  switch (status.state) {
    case 'disabled':
      return 'The runner is not part of this deployment — its compose profile is off. No agent schedule can run, '
        + 'and nothing runs model-written code against this brain on a schedule. Member-owned agents are unaffected.';
    case 'never_claimed':
      return `No runner is connected right now (${last}). Being enabled is not the same as being connected: `
        + 'an agent schedule waits until a runner claims it.';
    case 'connected':
      return `A runner is connected and holding a lease (${last}).`;
    case 'unreported':
      return 'This control plane did not report a runner state at all. That is not a runner being connected, and '
        + 'this page will not assume otherwise.';
    default:
      return `This console does not understand the runner state "${status.state}" — treating it as not connected.`;
  }
}

/**
 * D11's five classes, in the operator's words, each with the retry policy that
 * goes with it. The class is READ from `agent_runs.failure_class`; it is never
 * reconstructed by this renderer (L14 — Slice 3's mistake).
 */
const FAILURE_TEXT: Record<string, string> = {
  infra_failed: 'Infrastructure failed: the lease was lost, the gateway was unreachable, or the harness could not '
    + 'start. This is the one class D11 retries, up to twice, as a new attempt row.',
  budget_exceeded: 'The budget cap refused a model call before forwarding it. Never retried — a cap that stops the '
    + 'run after the money is spent is not a cap (honesty rule 4).',
  timeout: 'The run exceeded its timeout and the harness was stopped. Never retried.',
  agent_failed: 'The harness exited non-zero, or the stream carried error frames. Never retried, whatever the '
    + 'agent\'s closing message says (honesty rule 1).',
  refused: 'The runner refused the claim: no active Connection, no runner ever seen, or a harness pin mismatch. '
    + 'Never retried.',
};

/** The diagnosis from the row, or null for a run that did not fail. `null` is a
 *  SUCCESS in that column, not a sixth class. */
export function failureText(run: AgentRunRow): string | null {
  if (run.failureClass === null) return null;
  return FAILURE_TEXT[run.failureClass]
    ?? `Failure class "${run.failureClass}" — this console has no description for it and will not invent one.`;
}

/**
 * Honesty rule 1: the run's status is the ROW's, never the agent's own closing
 * message. This function takes no events, so the transcript cannot reach it.
 */
export function runStatusLine(run: AgentRunRow): string {
  const base = `${runStateLabel(run.state)} (attempt ${run.attempt})`;
  const why = failureText(run);
  return why === null ? base : `${base} — ${why}`;
}

/** D10: a reverted run says which commit did it. Nothing auto-reverts, ever. */
export function revertedLine(run: AgentRunRow): string | null {
  if (run.revertedAt === null) return null;
  return `Reverted ${new Date(run.revertedAt).toLocaleString()} by commit `
    + `${run.revertCommit ?? 'an unrecorded commit'} — a new commit plus a re-index, never a history rewrite.`;
}

/**
 * Honesty rule 3: a cost we could not price is not a cost of zero. `cost_usd` is
 * NULL when the model is absent from the price table, and NULL renders as words,
 * never as $0.00. A run with no priced call at all says that instead, because
 * "the model could not be priced" would be the wrong reason for it.
 */
export function costText(run: AgentRunRow): string {
  if (run.costUsd === null) {
    return run.numTurns === 0
      ? 'No priced model call was recorded for this run, so there is no cost to show.'
      : 'Not priced — at least one call used a model with no rate in the price table, so the cost is unknown, not zero.';
  }
  return `${money(run.costUsd)} over ${num(run.numTurns)} model turn(s).`;
}

/**
 * U9, in words: the run's cap is OURS — the harness's spend through our gateway,
 * metered per call in `agent_run_usage`. gbrain's own `budget_usd_per_day` caps
 * gbrain's model calls per client, on different money, and this page never reads
 * it. A reader must not be able to conflate the two.
 */
export function budgetText(run: AgentRunRow): string {
  return `Cap for this run: ${money(run.budgetUsd)} — the harness's own spend through our gateway, metered per `
    + 'call. That is not gbrain\'s budget_usd_per_day, which caps gbrain\'s own model calls per client; they are '
    + 'two different budgets on different money, and this page reads only ours.';
}

/**
 * C3's invariant handed to the reader: `agent_runs.cost_usd` is a rollup of
 * `agent_run_usage.cost_usd` and must equal its SUM. When a call carries a NULL
 * cost, or the stored total disagrees with the calls, the console says so rather
 * than showing a figure as if it were verified. null means the two agree.
 */
export function costNote(run: AgentRunRow, usage: AgentRunUsageRow[]): string | null {
  const priced = usage.filter((u) => u.costUsd !== null);
  const unpriced = usage.length - priced.length;
  const sum = priced.reduce((acc, u) => acc + (Number(u.costUsd) || 0), 0);
  if (unpriced > 0) {
    return `${unpriced} of ${usage.length} metered call(s) could not be priced, so any total here is a floor, not the cost.`;
  }
  if (run.costUsd === null) {
    return usage.length === 0
      ? null
      : `The run row carries no cost, but its ${usage.length} metered call(s) sum to ${money(sum.toFixed(6))}. `
        + 'Read the per-call rows: the rollup was never written.';
  }
  const stored = Number(run.costUsd);
  if (Number.isFinite(stored) && Math.abs(stored - sum) > 1e-9) {
    return `The run row says ${money(run.costUsd)} but its ${usage.length} metered call(s) sum to `
      + `${money(sum.toFixed(6))} — the rollup does not match the calls it rolls up, so treat the figure as unverified.`;
  }
  return null;
}

/**
 * The four counts, summed over the metered calls — the same rows the cost comes
 * from, so the page never shows a token total it cannot attribute to a call.
 */
export function tokensText(usage: AgentRunUsageRow[]): string {
  if (usage.length === 0) return 'No model call was metered for this run.';
  const t = usage.reduce(
    (a, u) => ({
      input: a.input + u.inputTokens,
      output: a.output + u.outputTokens,
      cacheRead: a.cacheRead + u.cacheReadTokens,
      cacheWrite: a.cacheWrite + u.cacheWriteTokens,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  return `${num(t.input)} in · ${num(t.output)} out · ${num(t.cacheRead)} cache read · `
    + `${num(t.cacheWrite)} cache write, over ${num(usage.length)} call(s)`;
}

/** Every kind `normalizeEvent` can emit, plus a tolerant fallback — the same
 *  discipline `runStateLabel` follows: no raw enum reaches the UI. */
export function eventLabel(kind: string): string {
  switch (kind) {
    case 'system/init': return 'Harness started';
    case 'system/api_retry': return 'Model call retried';
    case 'system/thinking_tokens': return 'Thinking tokens reported';
    case 'assistant': return 'Model turn';
    case 'user': return 'Tool result';
    case 'result': return 'Harness result';
    case 'rate_limit_event': return 'Rate limit event';
    case 'error': return 'Error frame';
    default: return `Unrecognised frame (${kind})`;
  }
}

/** The redacted frames' `message.content[]`, which is where the harness puts its
 *  blocks — on an `assistant` frame for calls, on a `user` frame for results. */
function contentBlocks(frame: unknown): Record<string, unknown>[] {
  const message = (frame as { message?: { content?: unknown } } | null)?.message;
  const content = message?.content;
  return Array.isArray(content)
    ? content.filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
    : [];
}

/** A tool result as text: the harness sends a string, or blocks carrying `text`. */
function resultText(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((piece) => {
        if (typeof piece === 'string') return piece;
        const text = (piece as { text?: unknown } | null)?.text;
        return typeof text === 'string' ? text : '';
      })
      .filter((line) => line !== '')
      .join('\n');
  }
  return content === undefined || content === null ? '' : JSON.stringify(content);
}

export type ToolCall = {
  seq: number;
  name: string;
  id: string | null;
  /** The redacted `input` object as JSON — S3c redacts it before it is stored. */
  input: string;
  /** null while no result frame has been recorded: the run ended mid-call, and
   *  an unanswered call is not a success. */
  result: string | null;
  isError: boolean;
};

/**
 * The tool-call timeline, read from the frames the runner stored. P2 measured the
 * shapes: each call is a `{type:'tool_use'}` block inside an `assistant` frame's
 * `message.content[]`, and its result comes back on a `user` frame — which is
 * the only place the tool's output appears, so a parser that switches on
 * `assistant`/`result` alone would silently drop every result.
 */
export function toolCalls(events: AgentRunEventRow[]): ToolCall[] {
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    for (const block of contentBlocks(event.data)) {
      if (event.kind === 'assistant' && block.type === 'tool_use') {
        const call: ToolCall = {
          seq: event.seq,
          name: typeof block.name === 'string' ? block.name : 'unnamed tool',
          id: typeof block.id === 'string' ? block.id : null,
          input: JSON.stringify(block.input ?? null),
          result: null,
          isError: false,
        };
        calls.push(call);
        if (call.id !== null) byId.set(call.id, call);
      }
      if (event.kind === 'user' && block.type === 'tool_result') {
        const call = typeof block.tool_use_id === 'string' ? byId.get(block.tool_use_id) : undefined;
        if (call) {
          call.result = resultText(block);
          call.isError = block.is_error === true;
        }
      }
    }
  }
  return calls;
}

/**
 * Honesty rule 1's receipt: error frames are counted from the stream itself, so
 * the page can say the run failed even when the agent's closing message claims
 * success. A `system/api_retry` frame is a retry, and an `isError` inside a tool
 * result is the model's problem to recover from — neither is a run failure.
 */
export function errorFrameCount(events: AgentRunEventRow[]): number {
  return events.filter(
    (e) => e.kind === 'error' || (e.data as { is_error?: unknown } | null)?.is_error === true,
  ).length;
}

/**
 * The agent's OWN closing words, from the `result` frame. Honesty rule 1: this is
 * never the run's status — a run with error frames or a non-zero exit is failed
 * whatever this says — so the page labels it as the agent's self-report.
 */
export function agentSelfSummary(events: AgentRunEventRow[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind !== 'result') continue;
    const result = (event.data as { result?: unknown } | null)?.result;
    return typeof result === 'string' && result.trim() !== '' ? result : null;
  }
  return null;
}

/**
 * D9's hedge (honesty rule 6), and the wording is the point. Every commit
 * observed in these Spaces is authored by one of our own writers — `commitAs`
 * passes `-c user.name -c user.email`, and gbrain itself makes no commit at all
 * (P8) — so a commit this run did not write is ANOTHER WRITER's work in the same
 * Space. It must never read as "gbrain wrote these", and the reader must be able
 * to take away "2 of 5 commits in this range were not written by this run".
 */
export function diffText(diff: DiffSummary | null): string {
  if (diff === null) {
    return 'No diff was recorded for this run, so nothing here is presented as the agent\'s work. A run that never '
      + 'reached the finish path records no range at all.';
  }
  const { write } = diff;
  const total = write.commits.length;
  if (total === 0) {
    return `The recorded range is empty: nothing was committed in ${write.sourceId} during this run `
      + `(${short(write.before)}..${short(write.after)}). A write that never reached git — an untracked file — `
      + 'looks exactly like this, and an empty range is a fact rather than a failure.';
  }
  if (write.foreignCommitCount === 0) {
    return `${num(total)} commit(s) in ${write.sourceId}, ${num(write.files.length)} file(s) changed. Every commit `
      + 'in this range was written by this run\'s own writer, and this run held the write Space alone, so no other '
      + 'agent run contributes to it.';
  }
  return `${num(write.foreignCommitCount)} of ${num(total)} commits in this range were not written by this run — `
    + `they were written by ${write.foreignAuthors.join(', ') || 'another writer'}. They are another writer's work in `
    + `${write.sourceId}, listed here rather than presented as the agent's; reverting this run would undo their work `
    + 'too, which is why the revert needs a second, explicit confirmation.';
}

/** Whether a commit in the range is one the attribution flagged. The projection
 *  carries no member email, so the only per-commit judgement this console can
 *  honestly make is which commits `attributeCommits` counted as foreign. */
export function isForeignCommit(commit: RangeCommit, foreignAuthors: string[]): boolean {
  return foreignAuthors.includes(`${commit.author} <${commit.email}>`);
}

/** `git diff --name-status`'s own token, spelled out — never normalized away. */
export function fileStatusLabel(status: string): string {
  const first = status.charAt(0);
  const name = first === 'A' ? 'added'
    : first === 'M' ? 'modified'
      : first === 'D' ? 'deleted'
        : first === 'R' ? 'renamed'
          : first === 'C' ? 'copied'
            : first === 'T' ? 'type changed'
              : 'changed';
  return status.length > 1 ? `${name} (${status})` : name;
}

/**
 * Honesty rule 10: a read Space whose HEAD moved under a run is a FINDING, not a
 * diff row. Read isolation is the Slice 2 promise and a read Space is handed to
 * the agent as read-only, so this is the page's loudest element. It names no
 * culprit: this run holds no write authority in a read Space, so something else
 * moved it — another writer, or a sync — and the console says exactly that
 * instead of guessing.
 */
export function readSpaceMoveAlert(diff: DiffSummary | null): string | null {
  if (diff === null || diff.readSpaceMoves.length === 0) return null;
  const names = diff.readSpaceMoves
    .map((m) => `${m.sourceId} (${short(m.before)} → ${short(m.after)})`)
    .join(', ');
  return `Read isolation broke: ${names} moved during this run. A read Space is handed to the agent as read-only and `
    + 'must not change while it runs — this run has no write authority there, so another writer or a sync moved it. '
    + 'The movement is the finding, and it is alerted rather than shown as a diff row.';
}

/** D10, in the operator's words, above the button. */
export const REVERT_DISCLOSURE =
  'Reverting commits the inverse of this run\'s range as a NEW commit and then re-indexes the brain, so the files go '
  + 'back and the reverted pages stop answering searches. It never rewrites history, and nothing reverts on its own — '
  + 'a human clicks this.';

/** One of D10's refusals, as a choice with its context. */
export type RevertChoice = {
  code: string;
  headline: string;
  context: string[];
  /** Only `revert_concurrent_writers` may be confirmed, and only explicitly. */
  confirmConcurrent: boolean;
};

/**
 * D10's three refusal codes, in the same `{error, …context}` style the console
 * already renders `slot_taken` / `nextFree` in. Each keeps its own context
 * because the choice differs: an already-reverted run says WHICH already, a
 * concurrent-writers range needs a second confirmation, and a conflict is
 * surfaced and never forced.
 */
export function revertChoice(body: Record<string, unknown>): RevertChoice {
  const code = typeof body.error === 'string' ? body.error : 'unknown';
  const detail = typeof body.detail === 'string' ? body.detail : null;
  const context: string[] = [];

  if (code === 'already_reverted') {
    const reason = typeof body.reason === 'string' ? body.reason : 'unknown';
    const at = typeof body.revertedAt === 'string' ? body.revertedAt : null;
    const commit = typeof body.revertCommit === 'string' ? body.revertCommit : null;
    context.push(`Reason: ${reason}`);
    if (at !== null) context.push(`Recorded at ${new Date(at).toLocaleString()}`);
    if (commit !== null) context.push(`Revert commit ${commit}`);
    if (detail !== null) context.push(detail);
    const headline = reason === 'recorded'
      ? `This run is already recorded as reverted by commit ${commit ?? 'an unrecorded commit'}`
        + `${at === null ? '' : ` at ${new Date(at).toLocaleString()}`}. Reverting again would revert the revert.`
      : reason === 'empty_range'
        ? 'The range recorded for this run is empty: it never committed anything in its write Space, so there is '
          + 'nothing in git to undo. An MCP write lands as an untracked file in this stack, which is the normal case '
          + 'rather than a failure.'
        : reason === 'nothing_to_revert'
          ? 'git found an empty inverse diff: the changes this range carried are already gone from the tree, so there '
            + 'is nothing left to revert.'
          : `This run is already reverted, and the reason given ("${reason}") is not one this console knows.`;
    return { code, headline, context, confirmConcurrent: false };
  }

  if (code === 'revert_concurrent_writers') {
    const total = typeof body.commitCount === 'number' ? body.commitCount : 0;
    const foreign = typeof body.foreignCommitCount === 'number' ? body.foreignCommitCount : 0;
    const authors = Array.isArray(body.foreignAuthors)
      ? body.foreignAuthors.filter((a): a is string => typeof a === 'string')
      : [];
    if (typeof body.sourceId === 'string') context.push(`Write Space: ${body.sourceId}`);
    if (detail !== null) context.push(detail);
    return {
      code,
      headline: `${num(foreign)} of ${num(total)} commits in this range were not written by this run — they were `
        + `written by ${authors.join(', ') || 'another writer'}. Reverting this run undoes their work too, so it needs `
        + 'a second, explicit confirmation.',
      context,
      confirmConcurrent: true,
    };
  }

  if (code === 'revert_conflict') {
    if (typeof body.sourceId === 'string') context.push(`Write Space: ${body.sourceId}`);
    if (detail !== null) context.push(detail);
    return {
      code,
      headline: `This range does not revert cleanly${typeof body.sourceId === 'string' ? ` in ${body.sourceId}` : ''}, `
        + 'so nothing was changed. A conflict means the tree no longer matches the range the run recorded, and '
        + 'resolving that needs a human on the host: there is no button here that forces it.',
      context,
      confirmConcurrent: false,
    };
  }

  return {
    code,
    headline: `The revert was refused (${code}).`,
    context: [JSON.stringify(body)],
    confirmConcurrent: false,
  };
}

/**
 * D10's success, saying what the re-index did — honesty rule 7: a revert that
 * did not re-index is not a revert.
 *
 * F16 makes this line carry a second distinction. The step that actually undoes
 * a reverted PAGE is the delete by name: the page an agent run writes is created
 * brain-first (MCP `put_page`), and `sync` reconciles `anchor..HEAD`, so a file
 * added and removed inside one unsynced delta nets to nothing — `sync` answers
 * `deleted: 0` and the page keeps answering. So the page removals are named, and
 * a purge the guard SKIPPED — its file is still in the write Space, which makes
 * it someone's live work — is said out loud with its reason rather than folded
 * into a claim that the brain forgot something it still holds.
 */
export function revertSuccessText(result: RevertSuccess): string {
  const purged = result.index.purge.filter((p) => p.outcome === 'purged');
  const kept = result.index.purge.filter((p) => p.outcome !== 'purged');
  const removed = purged.length === 0
    ? 'no page had to be removed from the index by name (the revert removed no page-shaped file)'
    : `${purged.length} reverted page(s) were removed from the index by name — `
      + `${purged.map((p) => p.slug).join(', ')} — so they stop answering searches`;
  const left = kept.length === 0
    ? ''
    : ' Left in the index on purpose, and still answerable: '
      + `${kept.map((p) => `${p.slug} (${p.detail})`).join('; ')}.`;
  return `Reverted by commit ${result.revertCommit} at ${new Date(result.revertedAt).toLocaleString()} — a new commit, `
    + `never a rewrite — and ${result.sourceId} was re-synced and re-embedded: ${removed}.${left}`;
}

export function Runs() {
  const [runner, setRunner] = useState<RunnerStatusRow | null>(null);
  const [runs, setRuns] = useState<AgentRunRow[]>([]);
  const [detail, setDetail] = useState<AgentRunDetail | null>(null);
  const [refusal, setRefusal] = useState<RevertChoice | null>(null);
  const [reverted, setReverted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (openRunId?: string) => {
    const [status, list] = await Promise.all([runApi.runner(), runApi.list()]);
    setRunner(status);
    setRuns(list.runs);
    const target = openRunId ?? list.runs[0]?.runId;
    setDetail(target === undefined ? null : await runApi.detail(target).catch(() => null));
    setError(null);
  };

  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : 'Load failed'));
  }, []);
  useEffect(() => {
    const t = setInterval(() => { void load().catch(() => { /* the next poll retries */ }); }, 15_000);
    return () => clearInterval(t);
  }, []);

  const open = (runId: string) => async () => {
    setRefusal(null);
    setReverted(null);
    setBusy(true);
    try {
      setDetail(await runApi.detail(runId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the run');
    } finally {
      setBusy(false);
    }
  };

  const revert = (confirm?: 'concurrent') => async () => {
    if (detail === null) return;
    setBusy(true);
    setRefusal(null);
    setReverted(null);
    try {
      setReverted(revertSuccessText(await runApi.revert(detail.runId, confirm)));
      await load(detail.runId);
    } catch (e) {
      // A refusal is a 409 whose BODY is the choice (D10). Anything else is an
      // error the operator reads as an error.
      if (e instanceof ApiError && e.status === 409) setRefusal(revertChoice(e.body));
      else setError(e instanceof Error ? e.message : 'The revert request failed');
    } finally {
      setBusy(false);
    }
  };

  const tone: Tone = runner === null ? 'muted' : runnerStateTone(runner.state);
  const moved = readSpaceMoveAlert(detail?.diff ?? null);
  const note = detail === null ? null : costNote(detail, detail.usage);
  const selfSummary = detail === null ? null : agentSelfSummary(detail.events);
  const errors = detail === null ? 0 : errorFrameCount(detail.events);
  const calls = detail === null ? [] : toolCalls(detail.events);

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Runs</h1>
        <p className="text-sm text-muted">
          Every agent run in this organization, with the receipt it left: the prompt, the tool calls, the token
          counts, the cost and the brain diff — all in one page load.
        </p>
      </header>

      {error && <div className="text-danger text-sm">{error}</div>}

      {/* Honesty rule 8, above the ledger: what a reader needs to know before
          reading "why did no run happen". */}
      <section className={`card space-y-1 ${tone === 'ok' ? '' : 'border-warning'}`}>
        <div className={TONE_CLASS[tone]}>
          {runner === null ? 'Checking the runner…' : runnerStateLabel(runner.state)}
        </div>
        <p className="text-sm">{runnerBanner(runner)}</p>
      </section>

      <section className="card space-y-2">
        <h2 className="text-lg font-semibold">Run ledger</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-muted">
            No agent run yet. An <span className="font-mono">agent_prompt</span> schedule only runs once a runner is
            connected ({runnerStateLabel(runner?.state ?? 'unreported').toLowerCase()}).
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-subtle text-left">
                <th className="py-2 pr-3">schedule</th>
                <th className="py-2 pr-3">slot</th>
                <th className="py-2 pr-3">state</th>
                <th className="py-2 pr-3">turns</th>
                <th className="py-2">cost</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.runId}
                  className={`border-b border-subtle cursor-pointer ${
                    detail?.runId === run.runId ? 'text-ok' : ''
                  }`}
                  onClick={() => void open(run.runId)()}
                >
                  <td className="py-2 pr-3">
                    <div>{run.scheduleName ?? run.scheduleId}</div>
                    <div className="text-xs text-muted font-mono">
                      {run.runId}
                      {run.attempt > 1 ? ` · attempt ${run.attempt}` : ''}
                    </div>
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs">
                    {run.slot}
                    <div className="text-muted">{new Date(run.fireAt).toLocaleString()}</div>
                  </td>
                  <td className={`py-2 pr-3 ${TONE_CLASS[runStateTone(run.state)]}`}>{runStateLabel(run.state)}</td>
                  <td className="py-2 pr-3">{num(run.numTurns)}</td>
                  {/* A NULL cost is words, never $0.00 (honesty rule 3). */}
                  <td className="py-2 text-xs">
                    {run.costUsd === null ? 'not priced' : money(run.costUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {detail !== null && (
        <section className="space-y-4">
          {/* Honesty rule 10: the finding comes before anything that could read
              as routine. */}
          {moved !== null && (
            <div className="card border-danger space-y-2">
              <h2 className="text-lg font-semibold text-danger">Read isolation broke</h2>
              <p className="text-sm">{moved}</p>
            </div>
          )}

          <div className="card space-y-2">
            <h2 className="text-lg font-semibold">{detail.scheduleName ?? detail.scheduleId}</h2>
            <div className={`text-sm ${TONE_CLASS[runStateTone(detail.state)]}`}>{runStatusLine(detail)}</div>
            <div className="text-xs text-muted font-mono">
              {detail.runId} · {detail.slot} · fired {new Date(detail.fireAt).toLocaleString()}
              {detail.startedAt === null ? '' : ` · started ${new Date(detail.startedAt).toLocaleString()}`}
              {detail.finishedAt === null ? '' : ` · finished ${new Date(detail.finishedAt).toLocaleString()}`}
            </div>
            <div className="text-xs text-muted font-mono">
              {detail.model} · harness {detail.harnessVersion}
              {detail.clientName === null ? '' : ` · via ${detail.clientName}`}
              {detail.tokenRevokedAt === null
                ? ' · run token not yet revoked'
                : ` · run token revoked ${new Date(detail.tokenRevokedAt).toLocaleString()}`}
            </div>
            {detail.failureDetail !== null && detail.failureDetail !== undefined && (
              <pre className="text-xs text-muted whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">
                {JSON.stringify(detail.failureDetail, null, 2)}
              </pre>
            )}
            {revertedLine(detail) && <div className="text-sm text-warning">{revertedLine(detail)}</div>}
          </div>

          {/* D10: nothing auto-reverts, and a refusal is a choice with its context. */}
          <div className="card space-y-2">
            <h2 className="text-lg font-semibold">Revert</h2>
            <p className="text-sm text-muted">{REVERT_DISCLOSURE}</p>
            <div className="flex flex-wrap gap-2">
              <button className="nav-item" disabled={busy} onClick={revert()}>Revert this run</button>
            </div>
            {reverted !== null && <div className="text-sm text-ok">{reverted}</div>}
            {refusal !== null && (
              <div className="card border-warning space-y-2">
                <p className="text-sm text-warning">{refusal.headline}</p>
                {refusal.context.map((line) => (
                  <p key={line} className="text-xs text-muted">{line}</p>
                ))}
                {refusal.confirmConcurrent && (
                  <div className="flex flex-wrap gap-2">
                    <button className="nav-item" disabled={busy} onClick={revert('concurrent')}>
                      Revert anyway — I understand it undoes their commits too
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="card space-y-2">
            <h2 className="text-lg font-semibold">Prompt</h2>
            <pre className="text-xs whitespace-pre-wrap font-mono max-h-64 overflow-y-auto">
              {detail.prompt ?? 'This run has no prompt recorded.'}
            </pre>
          </div>

          <div className="card space-y-2">
            <h2 className="text-lg font-semibold">Tool calls</h2>
            {calls.length === 0 ? (
              <p className="text-sm text-muted">No tool call was recorded in this run's event stream.</p>
            ) : (
              <div className="space-y-2">
                {calls.map((call) => (
                  <div key={`${call.seq}-${call.id ?? call.name}`} className="border-b border-subtle pb-2 space-y-1">
                    <div className="text-sm">
                      <span className="font-mono">{call.name}</span>
                      <span className="text-xs text-muted font-mono"> · frame {call.seq}</span>
                    </div>
                    <pre className="text-xs text-muted whitespace-pre-wrap font-mono max-h-24 overflow-y-auto">
                      {call.input}
                    </pre>
                    {call.result === null ? (
                      <div className="text-xs text-warning">
                        No result frame was recorded — the run ended between this call and its answer.
                      </div>
                    ) : (
                      <pre className={`text-xs whitespace-pre-wrap font-mono max-h-32 overflow-y-auto ${call.isError ? 'text-danger' : 'text-muted'}`}>
                        {call.isError ? `tool error: ${call.result}` : call.result}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="text-xs text-muted">
              {detail.events.length} frame(s) in the stream
              {errors > 0 ? `, ${errors} of them error frame(s)` : ', none of them an error frame'}
              {' — '}
              the run's status comes from its row, not from this transcript (honesty rule 1).
            </div>
            {detail.events.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {detail.events.map((event) => (
                  <span key={event.seq} className="text-xs text-muted">
                    {eventLabel(event.kind)}
                  </span>
                ))}
              </div>
            )}
            {selfSummary !== null && (
              <div className="space-y-1">
                <div className="text-xs text-muted">
                  The agent's own closing message — its self-report, not the run's status:
                </div>
                <pre className="text-xs whitespace-pre-wrap font-mono max-h-40 overflow-y-auto">{selfSummary}</pre>
              </div>
            )}
          </div>

          <div className="card space-y-1">
            <h2 className="text-lg font-semibold">Tokens, cost and budget</h2>
            <div className="text-sm">{tokensText(detail.usage)}</div>
            <div className="text-sm">{costText(detail)}</div>
            {note !== null && <div className="text-sm text-warning">{note}</div>}
            <div className="text-xs text-muted">{budgetText(detail)}</div>
            {detail.usage.length > 0 && (
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="border-b border-subtle text-left">
                    <th className="py-1 pr-3">call</th>
                    <th className="py-1 pr-3">model</th>
                    <th className="py-1 pr-3">in / out</th>
                    <th className="py-1 pr-3">cache r / w</th>
                    <th className="py-1">cost</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.usage.map((row) => (
                    <tr key={row.seq} className="border-b border-subtle">
                      <td className="py-1 pr-3">{row.seq}</td>
                      <td className="py-1 pr-3">{row.model}</td>
                      <td className="py-1 pr-3">{num(row.inputTokens)} / {num(row.outputTokens)}</td>
                      <td className="py-1 pr-3">{num(row.cacheReadTokens)} / {num(row.cacheWriteTokens)}</td>
                      <td className="py-1">{row.costUsd === null ? 'not priced' : money(row.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card space-y-2">
            <h2 className="text-lg font-semibold">Brain diff</h2>
            <p className="text-sm">{diffText(detail.diff)}</p>
            {detail.diff !== null && detail.diff.write.files.length > 0 && (
              <div className="space-y-1">
                {detail.diff.write.files.map((file) => (
                  <div key={`${file.status}-${file.path}`} className="text-xs font-mono">
                    {fileStatusLabel(file.status)} · {file.path}
                  </div>
                ))}
              </div>
            )}
            {detail.diff !== null && detail.diff.write.commits.length > 0 && (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-subtle text-left">
                    <th className="py-1 pr-3">commit</th>
                    <th className="py-1 pr-3">author</th>
                    <th className="py-1">subject</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.diff.write.commits.map((commit) => {
                    const foreign = isForeignCommit(commit, detail.diff!.write.foreignAuthors);
                    return (
                      <tr key={commit.sha} className="border-b border-subtle">
                        <td className="py-1 pr-3 font-mono">{short(commit.sha)}</td>
                        <td className="py-1 pr-3 font-mono">
                          {commit.author} &lt;{commit.email}&gt;
                          {foreign && <span className="text-warning"> · not written by this run</span>}
                        </td>
                        <td className="py-1">{commit.subject}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
