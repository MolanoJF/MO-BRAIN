import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, openJournal, readJournal } from '../../src/upgrade/journal.ts';
import { parseArgs, resumeWriters, UsageError } from '../../scripts/upgrade.ts';

const HELD = ['agent-runner', 'scheduler', 'gbrain-worker', 'gbrain-serve'] as const;

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function holdJournal(item: Record<string, unknown>): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'resume-writers-'));
  const journal = await openJournal(dir, 'run-hold');
  await appendEvent(journal, {
    step: 'playbooks_applied',
    message: 'opened checklist',
    data: { checklist: [item] },
  });
  await appendEvent(journal, {
    step: 'gated_ok',
    message: 'writers held',
    data: { writers: 'held', reason: 'blocks_resume' },
  });
  return dir;
}

describe('resumeWriters', () => {
  test('a pending blocksResume item refuses and does not resume', async () => {
    const root = await holdJournal({
      key: 'auto-chronicle', blocksResume: true, state: 'pending',
    });
    let resumed = false;
    const resume = async () => { resumed = true; };
    await expect(resumeWriters('run-hold', { journalRoot: root, resume })).rejects.toThrow(/still pending/);
    expect(resumed).toBe(false);
  });

  test('an acknowledged blocksResume item resumes the four writers and completes', async () => {
    const root = await holdJournal({
      key: 'auto-chronicle', blocksResume: true, state: 'acknowledged',
    });
    const calls: string[][] = [];
    const resume = async (services: readonly string[]) => { calls.push([...services]); };
    await resumeWriters('run-hold', { journalRoot: root, resume });
    expect(calls).toEqual([[...HELD]]);
    const events = await readJournal(root, 'run-hold');
    expect(events.at(-1)?.step).toBe('completed');

    await resumeWriters('run-hold', { journalRoot: root, resume });
    expect(calls).toEqual([[...HELD]]);
    expect((await readJournal(root, 'run-hold')).filter((e) => e.step === 'completed')).toHaveLength(1);
  });

  test('a control-db acknowledgement settles a journaled pending item', async () => {
    const root = await holdJournal({
      key: 'auto-chronicle', blocksResume: true, state: 'pending',
    });
    const calls: string[][] = [];
    await resumeWriters('run-hold', {
      journalRoot: root,
      resume: async (services) => { calls.push([...services]); },
      decisions: async () => [{ key: 'auto-chronicle', state: 'acknowledged' }],
    });
    expect(calls).toEqual([[...HELD]]);
  });

  test('a declined blocksResume item with no opt-out still blocks resume', async () => {
    const root = await holdJournal({
      key: 'fence-rewrite', blocksResume: true, state: 'declined',
    });
    let resumed = false;
    await expect(resumeWriters('run-hold', {
      journalRoot: root,
      resume: async () => { resumed = true; },
    })).rejects.toThrow(/no opt-out/);
    expect(resumed).toBe(false);
  });

  test('a declined item applies its declineOp through the injected RPC, not a shell string', async () => {
    const root = await holdJournal({
      key: 'auto-chronicle',
      blocksResume: true,
      state: 'declined',
      declineOp: { op: 'config.set', params: { key: 'chronicle.auto', value: 'off' } },
    });
    const applied: Array<{ op: string; params: Record<string, string> }> = [];
    const calls: string[][] = [];
    await resumeWriters('run-hold', {
      journalRoot: root,
      resume: async (services) => { calls.push([...services]); },
      applyOptOut: async (op, params) => { applied.push({ op, params }); },
    });
    expect(applied).toEqual([
      { op: 'config.set', params: { key: 'chronicle.auto', value: 'off' } },
    ]);
    expect(typeof applied[0]!.op).toBe('string');
    expect(calls).toEqual([[...HELD]]);
    const steps = (await readJournal(root, 'run-hold')).map((e) => e.step);
    expect(steps).toContain('checklist_opt_out');
    expect(steps.at(-1)).toBe('completed');
  });
});

describe('parseArgs resume-writers', () => {
  test('resume-writers is accepted beside the other commands', () => {
    expect(parseArgs(['resume-writers', '--run', 'run-hold'])).toEqual({
      cmd: 'resume-writers', runId: 'run-hold',
    });
  });

  test('resume-writers without a run is a usage error', () => {
    expect(() => parseArgs(['resume-writers'])).toThrow(UsageError);
  });
});
