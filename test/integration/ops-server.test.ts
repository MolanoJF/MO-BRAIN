import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Not 3140: the production compose.dev override publishes gbrain-ops there,
// and hitting the stack's server with this test token yields false 401s.
const PORT = '13140';
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'integration-token-not-a-real-secret';
const CONTROL_DATABASE_URL =
  process.env.CONTROL_DATABASE_URL ?? 'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';

let server: ReturnType<typeof Bun.spawn>;
let homeDir: string;
let reposDir: string;

beforeAll(async () => {
  // Ruling 14: fileplane binds CONFIG_PATH from GBRAIN_HOME at module load.
  // Without a temp dir here the server would write to /srv/gbrain-home.
  homeDir = await mkdtemp(join(tmpdir(), 'bs-ops-'));
  reposDir = await mkdtemp(join(tmpdir(), 'bs-repos-'));
  server = Bun.spawn(['bun', 'run', 'src/ops/server.ts'], {
    env: {
      ...process.env,
      OPS_RPC_TOKEN: TOKEN,
      OPS_RPC_PORT: PORT,
      CONTROL_DATABASE_URL,
      GBRAIN_HOME: homeDir,
      BRAIN_REPOS: reposDir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch {}
    await Bun.sleep(200);
  }
  throw new Error('ops server did not start');
}, 30_000);

afterAll(async () => {
  server?.kill();
  if (homeDir) await rm(homeDir, { recursive: true, force: true });
  if (reposDir) await rm(reposDir, { recursive: true, force: true });
});

const rpc = (body: unknown, token = TOKEN) =>
  fetch(`${BASE}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

describe('ops rpc', () => {
  test('healthz needs no token', async () => {
    expect((await fetch(`${BASE}/healthz`)).ok).toBe(true);
  });

  test('rpc without a token is 401', async () => {
    const r = await fetch(`${BASE}/rpc`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(401);
  });

  test('rpc with the wrong token is 401', async () => {
    expect((await rpc({ op: 'sources.list', params: {} }, 'wrong')).status).toBe(401);
  });

  // S2: there is no passthrough. An unlisted operation is unreachable.
  test('an unregistered operation is 400, not executed', async () => {
    const r = await rpc({ op: 'serve; rm -rf /', params: {} });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/unknown operation/);
  });

  test('a smuggled argv param is rejected', async () => {
    const r = await rpc({ op: 'sources.list', params: { _argv: ['x'] } });
    expect(r.status).toBe(400);
  });

  test('the fileplane config route never echoes the patch back', async () => {
    const r = await fetch(`${BASE}/fileplane/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ patch: { openai_api_key: 'sk-should-not-appear' } }),
    });
    const text = await r.text();
    expect(text).not.toContain('sk-should-not-appear');
    expect(text).toContain('openai_api_key'); // the key NAME is fine
  });

  test('seed-space rejects an invalid sourceId', async () => {
    const r = await fetch(`${BASE}/fileplane/seed-space`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sourceId: '../etc' }),
    });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toMatch(/invalid sourceId/);
  });

  test('take-grant-credentials reads then deletes a .creds file under GBRAIN_HOME', async () => {
    const credsPath = join(homeDir, '.creds-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json');
    const secret = { client_id: 'gbrain_cl_ops', client_secret: 'sk-ops-once' };
    await Bun.write(credsPath, JSON.stringify(secret));

    const r = await fetch(`${BASE}/fileplane/take-grant-credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ path: credsPath }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { credentials?: unknown };
    expect(body.credentials).toEqual(secret);
    expect(await Bun.file(credsPath).exists()).toBe(false);
  });

  test('take-grant-credentials rejects path traversal', async () => {
    const r = await fetch(`${BASE}/fileplane/take-grant-credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ path: join(homeDir, '..', 'etc', 'passwd') }),
    });
    expect(r.status).toBe(400);
    const body = await r.json() as { error: string };
    expect(body.error).toMatch(/invalid path|not under GBRAIN_HOME/i);
  });

  // F7: `mcp grant` retains a private credential journal per client, and
  // revoking the client does not remove it. This route is how a revoke deletes
  // the last copy of a dead secret.
  test('delete-credential-journal deletes the retained journal, and an absent one is not an error', async () => {
    const clientId = 'gbrain_cl_f7delete';
    const dir = join(homeDir, '.gbrain', 'credential-deliveries');
    await mkdir(dir, { recursive: true });
    const journal = join(dir, `${clientId}.json`);
    await Bun.write(journal, JSON.stringify({ client_secret: 'sk-journal-once' }));

    const del = async (id: string) => fetch(`${BASE}/fileplane/delete-credential-journal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ clientId: id }),
    });

    const first = await del(clientId);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ deleted: true });
    expect(await Bun.file(journal).exists()).toBe(false);

    const again = await del(clientId);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ deleted: false });
  });

  test('delete-credential-journal refuses an id that could name a path', async () => {
    const r = await fetch(`${BASE}/fileplane/delete-credential-journal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ clientId: '../../etc/passwd' }),
    });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toMatch(/invalid client id/);
  });
});

const gitPost = (path: string, body: unknown, token = TOKEN) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

describe('git commit as member', () => {
  test('commit without a token is 401', async () => {
    const r = await fetch(`${BASE}/git/commit`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(401);
  });

  test('an invalid sourceId is 400, not executed', async () => {
    const r = await gitPost('/git/commit', {
      sourceId: '../etc',
      actor: { name: 'Alice Example', email: 'alice@example.test' },
      message: 'nope',
    });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toMatch(/invalid sourceId/);
  });

  test('a commit lands with the member name and email in git log', async () => {
    const sourceId = 'customers';
    const repo = join(reposDir, sourceId);
    await mkdir(repo, { recursive: true });
    expect(await Bun.spawn(['git', 'init', '-q'], { cwd: repo }).exited).toBe(0);
    await writeFile(join(repo, 'page.md'), '# hello\n');

    const r = await gitPost('/git/commit', {
      sourceId,
      actor: { name: 'Alice Example', email: 'alice@example.test' },
      message: 'add page',
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { committed: boolean; sha: string | null };
    expect(body.committed).toBe(true);
    expect(body.sha).toBeTruthy();

    const log = Bun.spawn(['git', 'log', '-1', '--format=%an%n%ae%n%s'], { cwd: repo, stdout: 'pipe' });
    const text = await new Response(log.stdout).text();
    expect(await log.exited).toBe(0);
    expect(text).toContain('Alice Example');
    expect(text).toContain('alice@example.test');
    expect(text).toContain('add page');
  });
});

describe('git inspect', () => {
  test('reports uncommitted drift and lock fields', async () => {
    const sourceId = 'shared';
    const repo = join(reposDir, sourceId);
    await mkdir(repo, { recursive: true });
    expect(await Bun.spawn(['git', 'init', '-q'], { cwd: repo }).exited).toBe(0);
    await writeFile(join(repo, 'draft.md'), '# draft\n');

    const r = await gitPost('/git/inspect', {});
    expect(r.status).toBe(200);
    const body = await r.json() as {
      repos: Array<{
        sourceId: string;
        staleLock: boolean;
        uncommittedFiles: number;
        unpushedCommits: number;
      }>;
    };
    const row = body.repos.find((x) => x.sourceId === sourceId);
    expect(row).toBeTruthy();
    expect(row?.staleLock).toBe(false);
    expect(row?.uncommittedFiles).toBeGreaterThan(0);
    expect(typeof row?.unpushedCommits).toBe('number');
  });
});

// D9: the brain diff IS the git range. A real two-commit range, with the
// second commit authored by someone other than the run's member — the mixed
// authorship D9 has to report rather than assume away.
let rangeFixture: Promise<{ sourceId: string; before: string; mid: string; after: string }> | null = null;
function rangeRepo() {
  rangeFixture ??= (async () => {
    const sourceId = 'range-fixture';
    const repo = join(reposDir, sourceId);
    await mkdir(repo, { recursive: true });
    const run = async (argv: string[]) => {
      const p = Bun.spawn(['git', ...argv], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
      ]);
      if (code !== 0) throw new Error(`git ${argv.join(' ')}: ${err.trim() || out.trim()}`);
      return out.trim();
    };
    const commit = (name: string, email: string, message: string) =>
      run(['-c', `user.name=${name}`, `-c`, `user.email=${email}`, 'commit', '-m', message]);

    await run(['init', '-q']);
    await writeFile(join(repo, 'page.md'), '# hello\n');
    await run(['add', '-A']);
    await commit('Alice Example', 'alice@example.test', 'seed');
    const before = await run(['rev-parse', 'HEAD']);

    await writeFile(join(repo, 'page.md'), '# hello\n\nagent wrote this\n');
    await run(['add', '-A']);
    await commit('Alice Example', 'alice@example.test', 'write the page');
    const mid = await run(['rev-parse', 'HEAD']);

    await writeFile(join(repo, 'extra.md'), '# extra\n');
    await run(['add', '-A']);
    await commit('Live Sync', 'sync@brainstand.test', 'sync import');
    const after = await run(['rev-parse', 'HEAD']);

    return { sourceId, before, mid, after };
  })();
  return rangeFixture;
}

const HEAD_RE = /^[0-9a-f]{40}$/;

describe('git range', () => {
  test('an invalid sourceId is 400, not executed', async () => {
    const r = await gitPost('/git/range', { sourceId: '../etc', before: 'HEAD', after: 'HEAD' });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toMatch(/invalid sourceId/);
  });

  test('a missing ref field is 400', async () => {
    const r = await gitPost('/git/range', { sourceId: 'range-fixture' });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toMatch(/before required/);
  });

  // An unknown ref exits 128 with empty stdout, which is indistinguishable from
  // "no changes" unless the exit code is checked. Absence of evidence is never a pass.
  test('an unknown ref is an explicit error, not an empty range', async () => {
    const { sourceId, after } = await rangeRepo();
    const r = await gitPost('/git/range', { sourceId, before: 'nosuchref', after });
    expect(r.status).toBe(400);
    const body = await r.json() as { error: string; commits?: unknown };
    expect(body.error).toMatch(/unknown ref/);
    expect(body.commits).toBeUndefined();
  });

  test('a two-commit range returns the real commits and the changed files', async () => {
    const { sourceId, before, mid, after } = await rangeRepo();
    const r = await gitPost('/git/range', { sourceId, before, after });
    expect(r.status).toBe(200);
    const body = await r.json() as {
      sourceId: string;
      before: string;
      after: string;
      commits: Array<{ sha: string; author: string; email: string; subject: string; at: string }>;
      files: Array<{ status: string; path: string }>;
    };

    // The endpoints are the resolved shas — `before` is excluded from the range.
    expect(body.before).toBe(before);
    expect(body.after).toBe(after);
    expect(body.commits.map((c) => c.subject)).toEqual(['write the page', 'sync import']);
    expect(body.commits.map((c) => c.sha)).toEqual([mid, after]);
    expect(body.commits.every((c) => HEAD_RE.test(c.sha))).toBe(true);
    expect(body.commits[0]).toMatchObject({ author: 'Alice Example', email: 'alice@example.test' });
    // The second commit is not ours — the range's authorship is reported as-is.
    expect(body.commits[1]).toMatchObject({ author: 'Live Sync', email: 'sync@brainstand.test' });
    expect(body.commits[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual(['A extra.md', 'M page.md']);
  });

  // captureHeads probes each Space through this exact call: the range is empty,
  // but the resolved head is the answer.
  test('the degenerate HEAD..HEAD probe resolves the head and returns no rows', async () => {
    const { sourceId, after } = await rangeRepo();
    const r = await gitPost('/git/range', { sourceId, before: 'HEAD', after: 'HEAD' });
    expect(r.status).toBe(200);
    const body = await r.json() as { before: string; after: string; commits: unknown[]; files: unknown[] };
    expect(body.after).toBe(after);
    expect(body.before).toBe(after);
    expect(body.commits).toEqual([]);
    expect(body.files).toEqual([]);
  });
});

// D10: revert is a NEW commit plus a re-index, never a history rewrite. This is
// the ops half — `git revert --no-commit <before>..<after>` and the commit that
// signs it — including the promise that a REFUSED revert leaves the repo exactly
// as it was found. A half-reverted brain is worse than a failed revert.
const ADMIN = { name: 'Admin Human', email: 'admin@example.test' };

function gitRunner(repo: string) {
  return async (argv: string[]): Promise<string> => {
    const p = Bun.spawn(['git', ...argv], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
    ]);
    if (code !== 0) throw new Error(`git ${argv.join(' ')}: ${err.trim() || out.trim()}`);
    return out.trim();
  };
}
/**
 * One Space repo whose `before..after` range is a single agent commit:
 * seed -> agent writes the page -> (optionally) a later human rewrites it.
 * `dirty` leaves a TRACKED modification uncommitted, which is what gbrain
 * editing a page without committing looks like.
 *
 * `preRunPage` is the page read from GIT at `before` — the content a revert has
 * to put back — not the worktree, which later commits may have moved on. Reading
 * content through git keeps the comparison out of core.autocrlf's way: git's own
 * checkout respells line endings on this platform, the blobs do not.
 */
async function revertRepo(name: string, opts: { later?: boolean; dirty?: boolean } = {}) {
  const repo = join(reposDir, name);
  await mkdir(repo, { recursive: true });
  const run = gitRunner(repo);
  const commit = (n: string, e: string, m: string) =>
    run(['-c', `user.name=${n}`, '-c', `user.email=${e}`, 'commit', '-m', m]);

  await run(['init', '-q']);
  await writeFile(join(repo, 'page.md'), '# hello\n');
  await run(['add', '-A']);
  await commit('Seed Human', 'seed@example.test', 'seed the page');
  const before = await run(['rev-parse', 'HEAD']);

  await writeFile(join(repo, 'page.md'), '# hello\n\nagent wrote this\n');
  await run(['add', '-A']);
  await commit('Alice Example', 'alice@example.test', 'write the page');
  const after = await run(['rev-parse', 'HEAD']);

  if (opts.later) {
    await writeFile(join(repo, 'page.md'), '# hello\n\nhuman rewrote it\n');
    await run(['add', '-A']);
    await commit('Later Human', 'later@example.test', 'human rewrote the page');
  }
  if (opts.dirty) await writeFile(join(repo, 'page.md'), '# hello\n\nuncommitted edit\n');

  return {
    repo, run, sourceId: name, before, after,
    preRunPage: await run(['show', `${before}:page.md`]),
  };
}

describe('git revert-range', () => {
  test('an invalid sourceId is 400, not executed', async () => {
    const r = await gitPost('/git/revert-range', {
      sourceId: '../etc', before: 'HEAD', after: 'HEAD', actor: ADMIN, message: 'revert: agent run r1',
    });
    expect(r.status).toBe(400);
    const body = await r.json() as { error: string };
    expect(body.error).toMatch(/invalid sourceId/);
  });

  test('a missing field is 400 with the field named', async () => {
    const noBefore = await gitPost('/git/revert-range', {
      sourceId: 'customers', after: 'HEAD', actor: ADMIN, message: 'm',
    });
    expect(noBefore.status).toBe(400);
    expect((await noBefore.json() as { error: string }).error).toMatch(/before required/);

    const noActor = await gitPost('/git/revert-range', {
      sourceId: 'customers', before: 'HEAD', after: 'HEAD', message: 'm',
    });
    expect(noActor.status).toBe(400);
    expect((await noActor.json() as { error: string }).error).toMatch(/actor name and email required/);
  });

  test('a clean revert restores the page and commits as the acting admin', async () => {
    const { repo, run, sourceId, before, after, preRunPage } = await revertRepo('revert-clean');
    const commitsBefore = Number(await run(['rev-list', '--count', 'HEAD']));

    const r = await gitPost('/git/revert-range', {
      sourceId, before, after, actor: ADMIN, message: 'revert: agent run run-clean-1',
    });
    expect(r.status).toBe(200);
    const body = await r.json() as {
      reverted: boolean; sha?: string; files?: Array<{ status: string; path: string }>;
    };
    expect(body.reverted).toBe(true);
    expect(body.sha).toMatch(HEAD_RE);
    expect(body.files).toEqual([{ status: 'M', path: 'page.md' }]);

    // The page is back where it was before the run: HEAD's blob is the pre-run
    // content, and a clean status is what ties the worktree to it.
    expect(await run(['status', '--porcelain'])).toBe('');
    expect(await run(['show', 'HEAD:page.md'])).toBe(preRunPage);

    // A NAMED HUMAN signed it — author and committer — and the subject carries
    // the run id, not "the system" (D10 step 2).
    expect(await run(['log', '-1', '--format=%an|%ae|%cn|%ce|%s']))
      .toBe('Admin Human|admin@example.test|Admin Human|admin@example.test|revert: agent run run-clean-1');

    // A new commit on top: the agent's commit is still in history and the count
    // grew by exactly one — never a rewrite.
    expect(Number(await run(['rev-list', '--count', 'HEAD']))).toBe(commitsBefore + 1);
    expect(await run(['log', '--format=%s'])).toContain('write the page');
  });

  test('reverting the same range again is nothing_to_revert, and adds no commit', async () => {
    const { run, sourceId, before, after } = await revertRepo('revert-twice');
    const first = await gitPost('/git/revert-range', {
      sourceId, before, after, actor: ADMIN, message: 'revert: agent run run-twice-1',
    });
    expect((await first.json() as { reverted: boolean }).reverted).toBe(true);
    const afterFirst = await run(['rev-parse', 'HEAD']);

    const second = await gitPost('/git/revert-range', {
      sourceId, before, after, actor: ADMIN, message: 'revert: agent run run-twice-1',
    });
    expect(second.status).toBe(200);
    // An empty inverse diff is reported as a fact, not an error and not a
    // second empty commit.
    expect(await second.json()).toEqual({ reverted: false, reason: 'nothing_to_revert' });
    expect(await run(['rev-parse', 'HEAD'])).toBe(afterFirst);
    expect(await run(['status', '--porcelain'])).toBe('');
  });

  test('a conflicting range is refused, and the repo is left byte-identical', async () => {
    const { repo, run, sourceId, before, after } = await revertRepo('revert-conflict', { later: true });

    const headBefore = await run(['rev-parse', 'HEAD']);
    const logBefore = await run(['log', '--format=%H']);
    const pageBefore = await run(['show', 'HEAD:page.md']);
    expect(await run(['status', '--porcelain'])).toBe('');

    const r = await gitPost('/git/revert-range', {
      sourceId, before, after, actor: ADMIN, message: 'revert: agent run run-conflict-1',
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { reverted: boolean; reason?: string; detail?: string };
    expect(body.reverted).toBe(false);
    expect(body.reason).toBe('conflict');
    // git's own words, never a bare "it failed".
    expect(body.detail).toMatch(/could not revert/);

    // Surface it, never force it: HEAD, history, the index and the file are all
    // exactly what they were before the attempt.
    expect(await run(['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(await run(['log', '--format=%H'])).toBe(logBefore);
    expect(await run(['status', '--porcelain'])).toBe('');
    expect(await run(['show', 'HEAD:page.md'])).toBe(pageBefore);
  });

  test('an uncommitted tree is refused before anything moves', async () => {
    const { repo, run, sourceId, before, after } = await revertRepo('revert-dirty', { dirty: true });
    const headBefore = await run(['rev-parse', 'HEAD']);

    const r = await gitPost('/git/revert-range', {
      sourceId, before, after, actor: ADMIN, message: 'revert: agent run run-dirty-1',
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { reverted: boolean; reason?: string; detail?: string };
    expect(body.reverted).toBe(false);
    expect(body.reason).toBe('conflict');
    expect(body.detail).toMatch(/uncommitted changes in revert-dirty/);

    // Someone's uncommitted work is not ours to discard.
    expect(await Bun.file(join(repo, 'page.md')).text()).toContain('uncommitted edit');
    expect(await run(['rev-parse', 'HEAD'])).toBe(headBefore);
  });
});
