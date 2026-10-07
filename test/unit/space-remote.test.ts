import { afterEach, describe, expect, test } from 'bun:test';
import { createGithubRepo, githubRepoError } from '../../src/control/spaceRemote.ts';
import { canSetRemote, pushText, remoteError } from '../../src/console/pages/Sources.tsx';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Call = { url: string; method: string; auth: string | null; body: unknown };

/** Answer GitHub from a script, recording what was asked. */
function fakeGithub(answers: Record<string, { status: number; body: unknown }>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({
      url, method, auth: headers.get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    const a = answers[`${method} ${new URL(url).pathname}`];
    if (!a) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(a.body), { status: a.status });
  }) as typeof fetch;
  return calls;
}

describe('createGithubRepo', () => {
  test('creates a PRIVATE repo under the token\'s own account', async () => {
    const calls = fakeGithub({
      'GET /user': { status: 200, body: { login: 'felipe' } },
      'POST /user/repos': { status: 201, body: { clone_url: 'https://github.com/felipe/brain.git', full_name: 'felipe/brain', private: true } },
    });
    const r = await createGithubRepo({ token: 'tok', name: 'brain' });
    expect(r).toEqual({ cloneUrl: 'https://github.com/felipe/brain.git', fullName: 'felipe/brain' });
    const create = calls.find((c) => c.method === 'POST')!;
    expect(create.body).toMatchObject({ name: 'brain', private: true, auto_init: false });
    expect(create.auth).toBe('Bearer tok');
  });

  test('a different owner is created as an organisation repo', async () => {
    const calls = fakeGithub({
      'GET /user': { status: 200, body: { login: 'felipe' } },
      'POST /orgs/MoliorOS/repos': { status: 201, body: { clone_url: 'https://github.com/MoliorOS/b.git', full_name: 'MoliorOS/b', private: true } },
    });
    await createGithubRepo({ token: 'tok', name: 'b', owner: 'MoliorOS' });
    expect(calls.some((c) => c.url.endsWith('/orgs/MoliorOS/repos'))).toBe(true);
  });

  test('says why when GitHub refuses, and never adopts an existing repo', async () => {
    fakeGithub({
      'GET /user': { status: 200, body: { login: 'felipe' } },
      'POST /user/repos': { status: 422, body: { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] } },
    });
    await expect(createGithubRepo({ token: 'tok', name: 'brain' })).rejects.toThrow(/422.*already exists/);
  });

  test('a bad token fails at authentication', async () => {
    fakeGithub({ 'GET /user': { status: 401, body: { message: 'Bad credentials' } } });
    await expect(createGithubRepo({ token: 'nope', name: 'brain' })).rejects.toThrow(/authenticate.*Bad credentials/);
  });

  test('refuses a repo GitHub reports as public', async () => {
    fakeGithub({
      'GET /user': { status: 200, body: { login: 'felipe' } },
      'POST /user/repos': { status: 201, body: { clone_url: 'https://github.com/felipe/brain.git', full_name: 'felipe/brain', private: false } },
    });
    await expect(createGithubRepo({ token: 'tok', name: 'brain' })).rejects.toThrow(/not private/);
  });

  test('names are validated before any request', () => {
    expect(githubRepoError('brain')).toBeNull();
    expect(githubRepoError('bad name')).not.toBeNull();
    expect(githubRepoError('..')).not.toBeNull();
    expect(githubRepoError('ok', 'bad owner!')).not.toBeNull();
  });
});

describe('console remote form', () => {
  const f = { url: '', name: 'brain', token: 't' };

  test('github mode needs a token and a valid name', () => {
    expect(canSetRemote('github', f)).toBe(true);
    expect(canSetRemote('github', { ...f, token: ' ' })).toBe(false);
    expect(canSetRemote('github', { ...f, name: 'a b' })).toBe(false);
  });

  test('url mode refuses non-https and credentials in the URL', () => {
    expect(remoteError('url', { ...f, url: 'https://github.com/a/b.git' })).toBeNull();
    expect(remoteError('url', { ...f, url: 'git@github.com:a/b.git' })).not.toBeNull();
    expect(remoteError('url', { ...f, url: 'https://u:p@github.com/a/b.git' })).toMatch(/token in its own field/);
    expect(remoteError('url', { ...f, url: 'https://github.com/' })).toMatch(/name a repository/);
  });

  test('a refused push is reported with gbrain\'s words, not as success', () => {
    expect(pushText(null)).toMatch(/Not pushed/);
    expect(pushText({ pushed: true, exitCode: 0 })).toBe('Pushed.');
    expect(pushText({ pushed: false, exitCode: 5, detail: 'remote not verifiably private' }))
      .toMatch(/did not go through \(exit 5\).*not verifiably private/);
  });
});
