import { test, expect, describe } from 'bun:test';
import { classifyLock, commitArgs, diffRange, revertRange } from '../../src/ops/git.ts';
import type { GitRange, RangeCommit, RevertRequest } from '../../src/ops/git.ts';
import { attributeCommits, captureHeads, diffForRun } from '../../src/agent/diff.ts';
import { revertRun } from '../../src/agent/revert.ts';
import type {
  RevertDeps, RevertRefusal, RevertResult, RevertSuccess, RevertTarget,
} from '../../src/agent/revert.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const at = (over: Partial<RangeCommit> = {}): RangeCommit => ({
  sha: SHA_A,
  author: 'Alice Example',
  email: 'alice@example.test',
  subject: 'add page',
  at: '2026-09-17T10:00:00+00:00',
  ...over,
});

const range = (over: Partial<GitRange> = {}): GitRange => ({
  sourceId: 'customers',
  before: SHA_A,
  after: SHA_B,
  commits: [],
  files: [],
  ...over,
});

const MEMBER = { name: 'Alice Example', email: 'alice@example.test' };

describe('classifyLock', () => {
  // A lock held for seconds is a healthy concurrent write. One held for
  // minutes is a crashed process, and the difference is the whole signal.
  test('a fresh lock is not stale', () => {
    expect(classifyLock(5).staleLock).toBe(false);
  });

  test('a lock older than the threshold is stale', () => {
    expect(classifyLock(600).staleLock).toBe(true);
  });

  test('no lock at all is not stale', () => {
    expect(classifyLock(null)).toEqual({ staleLock: false, lockAgeSeconds: null });
  });
});

describe('commitArgs', () => {
  // Commit as the member, not as "the agent". This is what makes the audit
  // story real rather than "agent-runner did everything".
  test('sets author identity per invocation rather than globally', () => {
    const argv = commitArgs({ name: 'Alice Example', email: 'alice@example.test' }, 'add page');
    expect(argv.slice(0, 6)).toEqual([
      '-c', 'user.name=Alice Example', '-c', 'user.email=alice@example.test', 'commit', '-m',
    ]);
    expect(argv.at(-1)).toBe('add page');
  });

  test('keeps a message with shell metacharacters in one argv element', () => {
    const argv = commitArgs({ name: 'A', email: 'a@b.test' }, 'fix; rm -rf / #');
    expect(argv.at(-1)).toBe('fix; rm -rf / #');
    expect(argv.filter((a) => a.includes('rm -rf'))).toHaveLength(1);
  });

  test('refuses an identity containing a newline', () => {
    expect(() => commitArgs({ name: 'A\nB', email: 'a@b.test' }, 'm'))
      .toThrow('invalid git identity');
  });
});

describe('commitAs sourceId', () => {
  test('refuses a traversing sourceId before spawning git', async () => {
    const { commitAs } = await import('../../src/ops/git.ts');
    await expect(commitAs('../etc', { name: 'A', email: 'a@b.test' }, 'm', {
      sql: {} as never,
    })).rejects.toThrow(/invalid sourceId/);
  });
});

// D9: gbrain commits inside upstream code (G3), so a range's authorship is not
// ours to control. We report the foreign commits; we never hide them.
describe('attributeCommits', () => {
  test('a range written only by the member has no concurrent writers', () => {
    expect(attributeCommits([at(), at({ sha: SHA_B })], MEMBER)).toEqual({
      concurrentWriters: false,
      foreignCommitCount: 0,
      foreignAuthors: [],
    });
  });

  test('a foreign author is counted, named, and never hidden', () => {
    const result = attributeCommits([
      at(),
      at({ sha: SHA_B, author: 'Live Sync', email: 'sync@brainstand.test' }),
    ], MEMBER);
    expect(result.concurrentWriters).toBe(true);
    expect(result.foreignCommitCount).toBe(1);
    expect(result.foreignAuthors).toEqual(['Live Sync <sync@brainstand.test>']);
  });

  test('the member email matches case-insensitively', () => {
    const result = attributeCommits([at({ email: 'ALICE@example.test' })], MEMBER);
    expect(result.concurrentWriters).toBe(false);
  });
});

describe('captureHeads', () => {
  // The caller owns the Space list: ops holds the repo plane, the control plane
  // holds the Connection's compiled federatedRead. This function resolves nothing.
  test('probes every Space it is given and keys the map by Space id', async () => {
    const asked: string[] = [];
    const heads = await captureHeads(['customers', 'shared'], async (sourceId, before, after) => {
      asked.push(`${sourceId}:${before}..${after}`);
      return range({ sourceId, after: `${sourceId}-sha` });
    });
    expect(heads).toEqual({ customers: 'customers-sha', shared: 'shared-sha' });
    expect(asked).toEqual(['customers:HEAD..HEAD', 'shared:HEAD..HEAD']);
  });
});

describe('diffForRun', () => {
  test('lists the write range commits and files', async () => {
    const summary = await diffForRun({
      writeSpace: 'customers',
      readSpaces: [],
      before: { customers: SHA_A },
      after: { customers: SHA_B },
      member: MEMBER,
      fetchRange: async () => range({
        commits: [at({ subject: 'write the page' })],
        files: [{ status: 'M', path: 'page.md' }],
      }),
    });
    expect(summary.write.sourceId).toBe('customers');
    expect(summary.write.commits.map((c) => c.subject)).toEqual(['write the page']);
    expect(summary.write.files).toEqual([{ status: 'M', path: 'page.md' }]);
    expect(summary.readSpaceMoves).toEqual([]);
    expect(summary.concurrentWriters).toBe(false);
  });

  test('a moved read Space is an alert, and never a diff row', async () => {
    const asked: string[] = [];
    const summary = await diffForRun({
      writeSpace: 'customers',
      readSpaces: ['shared'],
      before: { customers: SHA_A, shared: SHA_A },
      after: { customers: SHA_B, shared: SHA_B },
      member: MEMBER,
      fetchRange: async (sourceId) => { asked.push(sourceId); return range({ sourceId }); },
    });
    // Not asking git about the read Space is the assertion: there is no diff
    // row to build, and a moved read Space is a finding for the caller to alert on.
    expect(asked).toEqual(['customers']);
    expect(summary.readSpaceMoves).toEqual([
      { sourceId: 'shared', before: SHA_A, after: SHA_B },
    ]);
  });

  test('a read Space that did not move is not a finding', async () => {
    const summary = await diffForRun({
      writeSpace: 'customers',
      readSpaces: ['shared'],
      before: { customers: SHA_A, shared: SHA_B },
      after: { customers: SHA_B, shared: SHA_B },
      member: MEMBER,
      fetchRange: async (sourceId) => range({ sourceId }),
    });
    expect(summary.readSpaceMoves).toEqual([]);
  });

  test('flags concurrent writers from the range authorship (honesty rule 6)', async () => {
    const summary = await diffForRun({
      writeSpace: 'customers',
      readSpaces: [],
      before: { customers: SHA_A },
      after: { customers: SHA_B },
      member: MEMBER,
      fetchRange: async () => range({
        commits: [
          at(),
          at({ sha: SHA_B, author: 'Live Sync', email: 'sync@brainstand.test' }),
        ],
      }),
    });
    expect(summary.concurrentWriters).toBe(true);
    expect(summary.write.foreignCommitCount).toBe(1);
    expect(summary.write.foreignAuthors).toEqual(['Live Sync <sync@brainstand.test>']);
  });

  test('identical heads are an empty range, and ask git nothing', async () => {
    const summary = await diffForRun({
      writeSpace: 'customers',
      readSpaces: [],
      before: { customers: SHA_A },
      after: { customers: SHA_A },
      member: MEMBER,
      fetchRange: async () => { throw new Error('must not be called'); },
    });
    expect(summary.write).toMatchObject({ before: SHA_A, after: SHA_A, commits: [], files: [] });
  });

  // Absence of evidence is never a pass: an uncaptured head is a caller bug,
  // not an empty diff.
  test('refuses when a Space has no captured head', async () => {
    await expect(diffForRun({
      writeSpace: 'customers',
      readSpaces: [],
      before: {},
      after: { customers: SHA_B },
      member: MEMBER,
      fetchRange: async () => range(),
    })).rejects.toThrow(/no captured head/);
  });
});

describe('diffRange sourceId', () => {
  test('refuses a traversing sourceId before spawning git', async () => {
    await expect(diffRange('../etc', 'HEAD', 'HEAD', { sql: {} as never }))
      .rejects.toThrow(/invalid sourceId/);
  });
});

// D10: revert is a NEW commit and a re-index, never a history rewrite. The ops
// half (git revert --no-commit + the commit that signs it) is one locked
// function; these are its caller's contracts.
describe('revertRange sourceId', () => {
  test('refuses a traversing sourceId before spawning git', async () => {
    await expect(revertRange({
      sourceId: '../etc', before: SHA_A, after: SHA_B,
      actor: { name: 'Admin Human', email: 'admin@example.test' },
      message: 'revert: agent run r1',
    }, { sql: {} as never })).rejects.toThrow(/invalid sourceId/);
  });
});

const ADMIN = { name: 'Admin Human', email: 'admin@example.test' };
const RUN_ID = 'run-revert-1';
const AT = Date.parse('2026-09-17T12:00:00.000Z');
const FOREIGN = at({ sha: SHA_B, author: 'Live Sync', email: 'sync@brainstand.test' });

const revertTarget = (over: Partial<RevertTarget> = {}): RevertTarget => ({
  runId: RUN_ID,
  sourceId: 'customers',
  member: MEMBER,
  before: SHA_A,
  after: SHA_B,
  revertedAt: null,
  revertCommit: null,
  ...over,
});

/** One recorded op call: op, the FENCED params, and the --json the scheduler path asks for. */
type OpsCall = { op: string; params: Record<string, unknown>; json: boolean | undefined };

function revertHarness(over: Partial<RevertDeps> = {}, target: RevertTarget | null = revertTarget()) {
  const ops: OpsCall[] = [];
  const ranges: string[] = [];
  const reverts: RevertRequest[] = [];
  const marked: Array<{ runId: string; at: Date; sha: string }> = [];

  const deps: RevertDeps = {
    loadTarget: async () => target,
    markReverted: async (runId, at, sha) => { marked.push({ runId, at, sha }); },
    fetchRange: async (sourceId, before, after) => {
      ranges.push(`${sourceId}:${before}..${after}`);
      return range({ sourceId, before, after, commits: [at()] });
    },
    revertRange: async (req) => {
      reverts.push(req);
      return { reverted: true, sha: SHA_B, files: [{ status: 'M', path: 'page.md' }] };
    },
    callOps: async (op, params, opts) => {
      ops.push({ op, params: params ?? {}, json: opts?.json });
      // `json: null` for the same reason a real zero-exit op needs no receipt
      // here: exit 0 classifies as `ok` whatever the payload.
      return { ok: true, exitCode: 0, argv: ['gbrain', op], stdout: '', stderr: '', json: null };
    },
    now: () => AT,
    ...over,
  };

  return { deps, ops, ranges, reverts, marked };
}

/** Narrow a revert result to its refusal arm, or fail the test by name. */
function refusal(r: RevertResult): RevertRefusal {
  if (!('error' in r)) throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
  return r;
}

/** Narrow a revert result to its success arm, or fail the test by name. */
function success(r: RevertResult): RevertSuccess {
  if (!('reverted' in r)) throw new Error(`expected a revert, got ${JSON.stringify(r)}`);
  return r;
}

describe('revertRun', () => {
  test('an unknown run throws — it is not a refusal code', async () => {
    const h = revertHarness({}, null);
    await expect(revertRun({ runId: RUN_ID, actor: ADMIN }, h.deps)).rejects.toThrow(/not found/);
  });

  test('a row that already carries reverted_at is already_reverted, repo untouched', async () => {
    const h = revertHarness({}, revertTarget({
      revertedAt: new Date('2026-09-16T00:00:00.000Z'), revertCommit: 'f'.repeat(40),
    }));
    expect(await revertRun({ runId: RUN_ID, actor: ADMIN }, h.deps)).toEqual({
      error: 'already_reverted',
      runId: RUN_ID,
      reason: 'recorded',
      revertedAt: '2026-09-16T00:00:00.000Z',
      revertCommit: 'f'.repeat(40),
      detail: `run ${RUN_ID} was already reverted by commit ${'f'.repeat(40)}`,
    });
    expect(h.ranges).toEqual([]);
    expect(h.reverts).toEqual([]);
    expect(h.ops).toEqual([]);
  });

  // P8: an MCP write lands as an untracked file, so an empty recorded range is
  // the normal shape, not an exotic one — and it must not read as a conflict.
  test('an empty recorded range is already_reverted, never a conflict', async () => {
    const h = revertHarness({
      fetchRange: async (sourceId, before, after) => range({ sourceId, before, after, commits: [] }),
    });
    const r = refusal(await revertRun({ runId: RUN_ID, actor: ADMIN }, h.deps));
    expect(r).toMatchObject({
      error: 'already_reverted', reason: 'empty_range', revertedAt: null, revertCommit: null,
    });
    expect(r.detail).toMatch(/never committed anything/);
    expect(h.reverts).toEqual([]);
  });

  test('an inverse diff git finds nothing to do in is already_reverted too', async () => {
    const h = revertHarness({
      revertRange: async () => ({ reverted: false, reason: 'nothing_to_revert' }),
    });
    const r = refusal(await revertRun({ runId: RUN_ID, actor: ADMIN }, h.deps));
    expect(r).toMatchObject({
      error: 'already_reverted', reason: 'nothing_to_revert', revertedAt: null, revertCommit: null,
    });
    expect(r.detail).toMatch(/inverse diff of aaaaaaa\.\.bbbbbbb in customers is empty/);
    expect(h.marked).toEqual([]);
    expect(h.ops).toEqual([]);
  });

  test('a foreign commit in the range refuses and names it (honesty rule 6)', async () => {
    const h = revertHarness({
      fetchRange: async (sourceId, before, after) => range({
        sourceId, before, after, commits: [at(), FOREIGN],
      }),
    });
    const r = refusal(await revertRun({ runId: RUN_ID, actor: ADMIN }, h.deps));
    expect(r).toMatchObject({
      error: 'revert_concurrent_writers',
      runId: RUN_ID,
      sourceId: 'customers',
      foreignCommitCount: 1,
      foreignAuthors: ['Live Sync <sync@brainstand.test>'],
      commitCount: 2,
    });
    expect(r.detail).toMatch(/1 of 2 commits .* were not written by alice@example.test/);
    // Never forced: nothing moved without the second confirmation.
    expect(h.reverts).toEqual([]);
  });

  test('confirm=concurrent proceeds, and the revert is signed by the acting admin', async () => {
    const h = revertHarness({
      fetchRange: async (sourceId, before, after) => range({
        sourceId, before, after, commits: [at(), FOREIGN],
      }),
    });
    const r = await revertRun({ runId: RUN_ID, actor: ADMIN, confirm: 'concurrent' }, h.deps);
    expect(success(r).reverted).toBe(true);
    expect(h.reverts).toEqual([{
      sourceId: 'customers', before: SHA_A, after: SHA_B, actor: ADMIN,
      message: `revert: agent run ${RUN_ID}`,
    }]);
  });

  test("a git conflict is surfaced with git's own words, and nothing is stamped", async () => {
    const conflict = 'error: could not revert c0ffee... agent edit\nCONFLICT (content): Merge conflict in page.md';
    const h = revertHarness({
      revertRange: async () => ({ reverted: false, reason: 'conflict', detail: conflict }),
    });
    expect(await revertRun({ runId: RUN_ID, actor: ADMIN }, h.deps)).toEqual({
      error: 'revert_conflict', runId: RUN_ID, sourceId: 'customers', detail: conflict,
    });
    expect(h.marked).toEqual([]);
    expect(h.ops).toEqual([]);
  });

  test('a clean revert stamps the row, then syncs and embeds through the scheduler path', async () => {
    const h = revertHarness();
    expect(await revertRun({ runId: RUN_ID, actor: ADMIN }, h.deps)).toEqual({
      reverted: true,
      runId: RUN_ID,
      sourceId: 'customers',
      revertedAt: '2026-09-17T12:00:00.000Z',
      revertCommit: SHA_B,
      files: [{ status: 'M', path: 'page.md' }],
      index: {
        sync: { argv: ['gbrain', 'sync', '--source', 'customers', '--json'], exitCode: 0, stderr: '', classification: 'ok' },
        embed: { argv: ['gbrain', 'embed', '--stale', '--source', 'customers', '--json'], exitCode: 0, stderr: '', classification: 'ok' },
      },
    });
    // The git fact is on the row before the index moves.
    expect(h.marked).toEqual([{ runId: RUN_ID, at: new Date(AT), sha: SHA_B }]);
    // `source` is fenced from the Connection's write Space, and `--stale` is the
    // whole point of step 3: a reverted page that still answers searches is not
    // reverted (honesty rule 7).
    expect(h.ops).toEqual([
      { op: 'sync', params: { source: 'customers' }, json: true },
      { op: 'embed', params: { source: 'customers', stale: true }, json: true },
    ]);
  });

  test('a failed re-index throws instead of reporting a revert (honesty rule 7)', async () => {
    const h = revertHarness({
      callOps: async (op, params, opts) => {
        h.ops.push({ op, params: params ?? {}, json: opts?.json });
        return {
          ok: false, exitCode: 4, argv: ['gbrain', op],
          stdout: '', stderr: 'lock lost', json: null,
        };
      },
    });
    await expect(revertRun({ runId: RUN_ID, actor: ADMIN }, h.deps))
      .rejects.toThrow(/index did not move/);
    // The commit landed, so the row says so; the embed is never attempted over a
    // half-imported Space.
    expect(h.marked).toHaveLength(1);
    expect(h.ops.map((o) => o.op)).toEqual(['sync']);
  });
});
