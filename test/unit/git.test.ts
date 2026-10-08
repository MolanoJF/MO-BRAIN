import { test, expect, describe } from 'bun:test';
import {
  classifyLock, clearRemote, commitArgs, diffRange, exportRepoBundle, gitReadFile, gitTree, gitWriteFile,
  revertRange, setRemote, validateRemoteUrl,
} from '../../src/ops/git.ts';
import type { GitRange, RangeCommit, RevertRequest, TreeProbe } from '../../src/ops/git.ts';
import { attributeCommits, captureHeads, diffForRun } from '../../src/agent/diff.ts';
import { purgeCandidates, revertRun } from '../../src/agent/revert.ts';
import { buildArgv, redactArgv } from '../../src/contracts/argv.ts';
import { pageDeleteNeedsForce } from '../../src/contracts/pin.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import type { ParamValues } from '../../src/contracts/types.ts';
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
      at({ sha: SHA_B, author: 'Live Sync', email: 'sync@mobrain.test' }),
    ], MEMBER);
    expect(result.concurrentWriters).toBe(true);
    expect(result.foreignCommitCount).toBe(1);
    expect(result.foreignAuthors).toEqual(['Live Sync <sync@mobrain.test>']);
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
          at({ sha: SHA_B, author: 'Live Sync', email: 'sync@mobrain.test' }),
        ],
      }),
    });
    expect(summary.concurrentWriters).toBe(true);
    expect(summary.write.foreignCommitCount).toBe(1);
    expect(summary.write.foreignAuthors).toEqual(['Live Sync <sync@mobrain.test>']);
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

// Stage 1 read endpoints: a bad sourceId or a path that could name a file
// outside the Space must be refused BEFORE any git spawn or repo lock. The
// dummy `{} as never` sql is the proof: a read that took a lock would throw on
// it, and a read that spawned git would need a real repo.
describe('gitTree sourceId', () => {
  test('refuses a traversing sourceId before spawning git', async () => {
    await expect(gitTree('../etc', { sql: {} as never })).rejects.toThrow(/invalid sourceId/);
  });
});

describe('exportRepoBundle sourceId', () => {
  test('refuses a traversing sourceId before spawning git', async () => {
    await expect(exportRepoBundle('../etc')).rejects.toThrow(/invalid sourceId/);
  });
});

describe('gitReadFile validation', () => {
  test('refuses a traversing sourceId before spawning git', async () => {
    await expect(gitReadFile('../etc', 'page.md', { sql: {} as never }))
      .rejects.toThrow(/invalid sourceId/);
  });

  // The path never reaches git: `assertRepoRelative` refuses a `..` segment, an
  // absolute path, a backslash separator and an empty string by name.
  test('refuses a traversing or absolute path before reading anything', async () => {
    const refused = /must be repo-relative|must not contain|use '\/' as its separator|non-empty string/;
    await expect(gitReadFile('customers', '../../etc/passwd', { sql: {} as never }))
      .rejects.toThrow(refused);
    await expect(gitReadFile('customers', '/etc/passwd', { sql: {} as never }))
      .rejects.toThrow(refused);
    await expect(gitReadFile('customers', 'a/../../b.md', { sql: {} as never }))
      .rejects.toThrow(refused);
    await expect(gitReadFile('customers', 'x\\y.md', { sql: {} as never }))
      .rejects.toThrow(refused);
    await expect(gitReadFile('customers', '', { sql: {} as never }))
      .rejects.toThrow(refused);
  });
});

// Stage 2 write path: the same validation-first contract as the read side — a
// traversing sourceId or path is refused BEFORE the repo lock or any spawn, and
// the dummy `{} as never` sql is the proof: a write that reached the lock would
// throw on it, and one that reached git would need a real repo.
describe('gitWriteFile validation', () => {
  const REQ = {
    path: 'page.md', content: 'x', expectedSha: 'a'.repeat(40),
    actor: { name: 'Alice Example', email: 'alice@example.test' }, message: 'write page',
  };

  test('refuses a traversing sourceId before spawning git', async () => {
    await expect(gitWriteFile({ ...REQ, sourceId: '../etc' }, { sql: {} as never }))
      .rejects.toThrow(/invalid sourceId/);
  });

  // The path never reaches git or the filesystem: `assertRepoRelative` refuses a
  // `..` segment, an absolute path and a backslash separator by name.
  test('refuses a traversing or absolute path before writing anything', async () => {
    const refused = /must be repo-relative|must not contain|use '\/' as its separator|non-empty string/;
    for (const path of ['../../etc/passwd', '/etc/passwd', 'x\\y.md']) {
      await expect(gitWriteFile({ ...REQ, sourceId: 'customers', path }, { sql: {} as never }))
        .rejects.toThrow(refused);
    }
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
const FOREIGN = at({ sha: SHA_B, author: 'Live Sync', email: 'sync@mobrain.test' });

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

/** What the injected tree probe was asked, and what it answers. The default is
 *  "every probed path is gone", which is the reverted shape; `onDisk` names the
 *  paths the tree still holds. */
function treeProbe(probes: string[], onDisk: string[] = []) {
  return async (sourceId: string, paths: readonly string[]): Promise<TreeProbe> => {
    probes.push(`${sourceId}:${paths.join(',')}`);
    return {
      sourceId,
      root: `/srv/brain-repos/${sourceId}`,
      paths: paths.map((p) => ({ path: p, onDisk: onDisk.includes(p), inGit: onDisk.includes(p) })),
    };
  };
}

/** One fake ops reply, in the pin's own vocabulary: an exit code, stderr, and the
 *  receipt the real op printed (absent, or the parsed payload). */
type OpsReply = { exitCode?: number; stderr?: string; json?: unknown };

/**
 * A `callOps` fake. Its signature is GENERIC because the real one is
 * (`callOps<T>` returns `json: T | null`): a mock declaring a concrete receipt
 * type cannot satisfy it, so the payload is asserted once here — at the seam —
 * and every assertion below reads the value the fake actually returned.
 */
function opsFake(log: OpsCall[], handler: (op: string, params: Record<string, unknown>) => OpsReply) {
  return async <T,>(op: string, params?: Record<string, unknown>, opts?: { json?: boolean }) => {
    log.push({ op, params: params ?? {}, json: opts?.json });
    const reply = handler(op, params ?? {});
    return {
      ok: (reply.exitCode ?? 0) === 0,
      exitCode: reply.exitCode ?? 0,
      argv: ['gbrain', op],
      stdout: '',
      stderr: reply.stderr ?? '',
      json: (reply.json ?? null) as T | null,
    };
  };
}

function revertHarness(over: Partial<RevertDeps> = {}, target: RevertTarget | null = revertTarget()) {
  const ops: OpsCall[] = [];
  const ranges: string[] = [];
  const reverts: RevertRequest[] = [];
  const marked: Array<{ runId: string; at: Date; sha: string }> = [];
  const probes: string[] = [];

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
    probeTree: treeProbe(probes),
    callOps: async (op, params, opts) => {
      ops.push({ op, params: params ?? {}, json: opts?.json });
      // `json: null` for the same reason a real zero-exit op needs no receipt
      // here: exit 0 classifies as `ok` whatever the payload.
      return { ok: true, exitCode: 0, argv: ['gbrain', op], stdout: '', stderr: '', json: null };
    },
    pageDeleteNeedsForce,
    now: () => AT,
    ...over,
  };

  return { deps, ops, ranges, reverts, marked, probes };
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
      foreignAuthors: ['Live Sync <sync@mobrain.test>'],
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
        purge: [],
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

  // F15: `sync` reconciles anchor..HEAD, so a file ADDED and REMOVED inside one
  // unsynced delta nets to nothing; the page an agent run writes was created
  // brain-first by MCP put_page. The reverted page therefore has to go by name,
  // and BEFORE the sync — the sync cannot stand in for it.
  test('a page the revert REMOVED is deleted by name, before the sync', async () => {
    const ops: OpsCall[] = [];
    const h = revertHarness({
      revertRange: async () => ({
        reverted: true,
        sha: SHA_B,
        files: [
          { status: 'M', path: 'gate-c/r1/edited.md' },
          { status: 'D', path: 'gate-c/r1/Nightly Page.md' },
        ],
      }),
      callOps: opsFake(ops, (op) =>
        op === 'page.delete'
          ? { json: { status: 'purged', slug: 'gate-c/r1/nightly-page', source_id: 'customers' } }
          : {}),
    });

    const r = success(await revertRun({ runId: RUN_ID, actor: ADMIN }, h.deps));
    // Only the DELETED path: the modified file's page is re-synced from its new
    // content and is another run's page as often as this one's.
    expect(r.index.purge).toEqual([{
      slug: 'gate-c/r1/nightly-page',
      removedPath: 'gate-c/r1/Nightly Page.md',
      outcome: 'purged',
      detail: "removed from customers's index by name",
      argv: [
        'gbrain', 'delete', 'gate-c/r1/nightly-page', '--source-id', 'customers', '--purge',
        ...(pageDeleteNeedsForce() ? ['--force'] : []),
        '--json',
      ],
      exitCode: 0,
      stderr: '',
      classification: 'ok',
    }]);
    // The tree was asked BEFORE any delete, for the removed path and for the
    // slug's own file — the two files a purge would unlink.
    expect(h.probes).toEqual(['customers:gate-c/r1/Nightly Page.md,gate-c/r1/nightly-page.md']);
    // The order IS the requirement: purge, sync, embed.
    expect(ops).toEqual([
      {
        op: 'page.delete',
        params: {
          slug: 'gate-c/r1/nightly-page', sourceId: 'customers', purge: true,
          ...(pageDeleteNeedsForce() ? { force: true } : {}),
        },
        json: true,
      },
      { op: 'sync', params: { source: 'customers' }, json: true },
      { op: 'embed', params: { source: 'customers', stale: true }, json: true },
    ]);
  });

  // The controller's ruling: the recorded receipt argv must BE the command that
  // ran, `--force` included, so it is derived from the same params sent. Proven
  // at 0.51 by forcing the gate (the declared pin stays 0.50.5.0).
  test('at 0.51 the recorded purge argv carries the --force it actually sent', async () => {
    const ops: OpsCall[] = [];
    const h = revertHarness({
      pageDeleteNeedsForce: () => true,
      revertRange: async () => ({
        reverted: true,
        sha: SHA_B,
        files: [
          { status: 'M', path: 'gate-c/r1/edited.md' },
          { status: 'D', path: 'gate-c/r1/Nightly Page.md' },
        ],
      }),
      callOps: opsFake(ops, (op) =>
        op === 'page.delete'
          ? { json: { status: 'purged', slug: 'gate-c/r1/nightly-page', source_id: 'customers' } }
          : {}),
    });

    const r = success(await revertRun({ runId: RUN_ID, actor: ADMIN }, h.deps));
    expect(r.index.purge).toHaveLength(1);
    const purge = r.index.purge[0]!;
    const spec = OPERATIONS['page.delete']!;
    const sent = ops[0]!.params;
    expect(sent).toEqual({
      slug: 'gate-c/r1/nightly-page', sourceId: 'customers', purge: true, force: true,
    });
    expect(purge.argv).toContain('--force');
    // Exactly the argv those sent params describe — no second literal to drift.
    expect(purge.argv).toEqual(redactArgv(spec, ['gbrain', ...buildArgv(spec, sent as ParamValues, { json: true })]));
  });

  // The guard's whole point: `gbrain delete --purge` UNLINKS the page's markdown
  // when it is there, so a slug whose file is in the tree is LIVE work — another
  // writer re-created it, or the revert restored it. Nothing is touched, and the
  // skip is in the receipt so a git-only revert is visible as one.
  test('a slug whose file is still in the tree is skipped, with the reason recorded', async () => {
    const probes: string[] = [];
    const h = revertHarness({
      revertRange: async () => ({
        reverted: true, sha: SHA_B, files: [{ status: 'D', path: 'gate-c/r1/nightly.md' }],
      }),
      probeTree: treeProbe(probes, ['gate-c/r1/nightly.md']),
    });

    const r = success(await revertRun({ runId: RUN_ID, actor: ADMIN }, h.deps));
    expect(probes).toEqual(['customers:gate-c/r1/nightly.md']);
    expect(r.index.purge).toHaveLength(1);
    expect(r.index.purge[0]).toMatchObject({
      slug: 'gate-c/r1/nightly',
      removedPath: 'gate-c/r1/nightly.md',
      outcome: 'skipped_file_present',
      exitCode: null,
      stderr: '',
      classification: 'refused',
    });
    expect(r.index.purge[0]!.detail).toMatch(/gate-c\/r1\/nightly\.md is still in the write Space/);
    // No delete was attempted, and the sync/embed still ran: the revert is real,
    // this one page just belongs to someone else.
    expect(h.ops.map((o) => o.op)).toEqual(['sync', 'embed']);
  });

  test('a probe that cannot read the tree fails the revert rather than purging blind', async () => {
    const h = revertHarness({
      revertRange: async () => ({
        reverted: true, sha: SHA_B, files: [{ status: 'D', path: 'gate-c/r1/nightly.md' }],
      }),
      probeTree: async () => { throw new Error('ops rpc 400: git rev-parse internal failed'); },
    });

    await expect(revertRun({ runId: RUN_ID, actor: ADMIN }, h.deps))
      .rejects.toThrow(/nightly was not removed from the brain index \(refused_unreadable\)/);
    // Fail closed: no delete was attempted. The sync/embed still ran — the revert
    // commit is on the history and the rest of the Space has to move with it —
    // but the route cannot report a revert, which is what the throw is for.
    expect(h.ops.map((o) => o.op)).toEqual(['sync', 'embed']);
  });

  test('an absent page is a result, a failed delete is not: both are recorded', async () => {
    const absentOps: OpsCall[] = [];
    const absent = revertHarness({
      revertRange: async () => ({
        reverted: true, sha: SHA_B, files: [{ status: 'D', path: 'gate-c/r1/gone.md' }],
      }),
      // Measured at the pin: an unknown slug exits 1 and the code appears in the
      // STDERR prose, with no JSON receipt.
      callOps: opsFake(absentOps, (op) => (op === 'page.delete'
        ? { exitCode: 1, stderr: 'Error [page_not_found]: Page not found: gate-c/r1/gone' }
        : {})),
    });
    const r = success(await revertRun({ runId: RUN_ID, actor: ADMIN }, absent.deps));
    expect(r.index.purge[0]).toMatchObject({
      slug: 'gate-c/r1/gone', outcome: 'absent', exitCode: 1, classification: 'failed',
    });
    expect(r.index.purge[0]!.detail).toMatch(/no page at gate-c\/r1\/gone in customers/);
    // The absent page is not retried, and the scheduler steps still run.
    expect(absentOps.map((o) => o.op)).toEqual(['page.delete', 'sync', 'embed']);

    const failingOps: OpsCall[] = [];
    const failing = revertHarness({
      revertRange: async () => ({
        reverted: true, sha: SHA_B, files: [{ status: 'D', path: 'gate-c/r1/stuck.md' }],
      }),
      callOps: opsFake(failingOps, (op) => (op === 'page.delete'
        ? { exitCode: 1, stderr: 'Error [storage_error]: the page content could not be written to disk' }
        : {})),
    });
    await expect(revertRun({ runId: RUN_ID, actor: ADMIN }, failing.deps))
      .rejects.toThrow(/stuck was not removed from the brain index \(failed\):.*storage_error/s);
  });
});

/**
 * The pure half of the purge: WHICH paths become slugs, and which must not. The
 * status filter is git's own token — a revert's `D` is the only row that names a
 * file the tree no longer has.
 */
describe('purgeCandidates', () => {
  test('only the removed paths, deduped in diff order', () => {
    expect(purgeCandidates([
      { status: 'M', path: 'gate-c/r1/edited.md' },
      { status: 'D', path: 'gate-c/r1/nightly.md' },
      { status: 'D', path: 'gate-c/r1/nightly.md' },
      { status: 'A', path: 'gate-c/r1/restored.md' },
    ])).toEqual([{ path: 'gate-c/r1/nightly.md', slug: 'gate-c/r1/nightly' }]);
  });

  // The derivation mirrors gbrain's slugifyPath (src/core/sync.ts): `.md`/`.mdx`
  // stripped, then per segment lower-cased with runs of whitespace collapsed to a
  // hyphen. A guessed slug could name a DIFFERENT page, so anything else is null.
  test('the slug mirrors gbrain\'s own derivation, and only where it is certain', () => {
    expect(purgeCandidates([{ status: 'D', path: 'Notes/My  Page.mdx' }]))
      .toEqual([{ path: 'Notes/My  Page.mdx', slug: 'notes/my-page' }]);
    expect(purgeCandidates([{ status: 'D', path: 'notes/v1.0.0.md' }]))
      .toEqual([{ path: 'notes/v1.0.0.md', slug: 'notes/v1.0.0' }]);
    // A code file derives slugifyCodePath's flattened slug, and an emoji/ CJK
    // name can be imported under a frontmatter slug: neither is ours to guess.
    expect(purgeCandidates([{ status: 'D', path: 'src/core/chunkers/code.ts' }]))
      .toEqual([{ path: 'src/core/chunkers/code.ts', slug: null }]);
    expect(purgeCandidates([{ status: 'D', path: 'notes/🗂️ emoji.md' }]))
      .toEqual([{ path: 'notes/🗂️ emoji.md', slug: null }]);
  });
});

describe('validateRemoteUrl', () => {
  test('accepts an https repo URL and keeps it token-free', () => {
    expect(validateRemoteUrl('https://github.com/acme/brain.git ')).toEqual({
      url: 'https://github.com/acme/brain.git', host: 'github.com',
    });
  });

  test('refuses everything that could smuggle a credential or reach an internal host', () => {
    for (const bad of [
      'git@github.com:acme/brain.git', 'http://github.com/acme/brain.git', 'file:///srv/brain-repos/x',
      'https://user:pw@github.com/acme/brain.git', 'https://x-access-token@github.com/acme/brain.git',
      'https://github.com/acme/brain.git?token=1', 'https://github.com/acme/brain.git#x',
      'https://localhost/acme/brain.git', 'https://gbrain-ops/acme/brain.git', 'https://github.com/', 'nonsense',
    ]) {
      expect(() => validateRemoteUrl(bad), bad).toThrow();
    }
  });
});

describe('setRemote / clearRemote guards', () => {
  const REQ = { sourceId: 'my-space', url: 'https://github.com/acme/brain.git', token: 'ghp_abc123' };

  // A request that fails validation must never reach the lock: the dummy sql is the proof.
  test('refuses a bad source id, URL or token before taking the repo lock', async () => {
    const o = { sql: {} as never };
    await expect(setRemote({ ...REQ, sourceId: '../etc' }, o)).rejects.toThrow(/invalid sourceId/);
    await expect(setRemote({ ...REQ, url: 'http://github.com/a/b' }, o)).rejects.toThrow(/https/);
    await expect(setRemote({ ...REQ, token: 'has space' }, o)).rejects.toThrow(/token/);
    await expect(setRemote({ ...REQ, token: '' }, o)).rejects.toThrow(/token/);
    await expect(setRemote({ ...REQ, username: 'a b' }, o)).rejects.toThrow(/username/);
    await expect(clearRemote({ sourceId: '../etc' }, o)).rejects.toThrow(/invalid sourceId/);
  });
});
