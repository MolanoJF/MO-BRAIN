import { test, expect, describe } from 'bun:test';
import { syncAndEmbed, type CallOps } from '../../src/agent/reindex.ts';

/** One recorded op call: the op, the FENCED params, and the --json the scheduler
 *  path asked for. `null` params is impossible here — syncAndEmbed always fences. */
type Call = { op: string; params: Record<string, string | boolean>; json: boolean | undefined };

type Reply = { exitCode?: number; stderr?: string; json?: unknown };

/**
 * A minimal `CallOps` fake that records every call. The signature is the real
 * one, so a compile failure here would mean the extracted seam drifted from the
 * ops client the scheduler path actually uses.
 */
function recordingOps(recorded: Call[], reply: (op: string) => Reply = () => ({})): CallOps {
  return async (op, params, opts) => {
    recorded.push({ op, params, json: opts.json });
    const r = reply(op);
    return { exitCode: r.exitCode ?? 0, stderr: r.stderr ?? '', json: r.json ?? null };
  };
}

describe('syncAndEmbed', () => {
  // The whole point of the extraction: the caller cannot supply `--source` (it
  // is fenced from the Connection's write Space) and stage 3's embed always
  // carries `--stale` — a page that still answers searches is not re-indexed.
  // The argv is the allowlist's own output, so it is asserted verbatim.
  test('runs sync then embed --stale with the source fenced from the Connection', async () => {
    const recorded: Call[] = [];
    const result = await syncAndEmbed('customers', { callOps: recordingOps(recorded) });

    expect(recorded).toEqual([
      { op: 'sync', params: { source: 'customers', noPull: true, noEmbed: true }, json: true },
      { op: 'embed', params: { source: 'customers', stale: true, maxUsd: '1' }, json: true },
    ]);
    expect(result.sync).toEqual({
      argv: ['gbrain', 'sync', '--source', 'customers', '--no-pull', '--no-embed', '--json'],
      exitCode: 0, stderr: '', classification: 'ok',
    });
    expect(result.embed).toEqual({
      argv: ['gbrain', 'embed', '--stale', '--source', 'customers', '--max-usd', '1', '--json'],
      exitCode: 0, stderr: '', classification: 'ok',
    });
  });

  // Honesty rule 7 / live-sync step 2: embedding a half-imported Space commits
  // chunks of a state sync never reached, so a non-ok sync must short-circuit
  // BEFORE the embed is ever attempted, and the result says so with embed: null.
  test('a failed sync never attempts the embed, and returns embed: null', async () => {
    const recorded: Call[] = [];
    const result = await syncAndEmbed('customers', {
      callOps: recordingOps(recorded, (op) => (op === 'sync' ? { exitCode: 4, stderr: 'lock lost' } : {})),
    });

    expect(recorded.map((c) => c.op)).toEqual(['sync']);
    expect(result.sync.classification).toBe('lock_lost');
    expect(result.sync.stderr).toBe('lock lost');
    expect(result.embed).toBeNull();
  });

  // A thrown op has NO exit code: -1 classifies as a plain failure, the same
  // line the scheduler's own runStep holds — and it is still not permission to
  // embed over the Space that never imported.
  test('an op that throws is a failed sync, and the embed is never attempted', async () => {
    const recorded: Call[] = [];
    const result = await syncAndEmbed('customers', {
      callOps: async (op, params, opts) => {
        recorded.push({ op, params, json: opts.json });
        throw new Error('ops rpc unavailable');
      },
    });

    expect(recorded.map((c) => c.op)).toEqual(['sync']);
    expect(result.sync).toMatchObject({ exitCode: -1, classification: 'failed' });
    expect(result.sync.stderr).toBe('ops rpc unavailable');
    expect(result.embed).toBeNull();
  });
});
