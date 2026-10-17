// test/unit/gbrain-admin.test.ts
import { describe, expect, test } from 'bun:test';
import { CliGbrainAdmin, HttpGbrainAdmin, grantArgv, parseCredentials, rescopeArgv } from '../../src/server/gbrain/admin.ts';
import type { CliResult } from '../../src/server/gbrain/cli.ts';
import type { ClientSpec } from '../../src/server/types.ts';

const spec: ClientSpec = {
  purpose: 'agent', userId: 'u1', name: 'mb-agent-u1', profile: 'memory-writer',
  writeSource: 'p-ada', readSources: ['c-company', 'c-eng'],
};

describe('argv builders', () => {
  test('grant argv names source, federated read including the write source, profile, ttl, credentials file and url', () => {
    expect(grantArgv(spec, '/tmp/c.json', 'https://b.ts.net/mcp')).toEqual([
      'mcp', 'grant', 'mb-agent-u1',
      '--profile', 'memory-writer',
      '--source', 'p-ada',
      '--federated-read', 'c-company,c-eng,p-ada',
      '--token-ttl', '7776000',
      '--credentials-out', '/tmp/c.json',
      '--url', 'https://b.ts.net/mcp',
      '--json',
    ]);
  });

  test('grant argv still names the write source when there are no extra reads', () => {
    const argv = grantArgv({ ...spec, readSources: [] }, '/tmp/c.json', 'u');
    expect(argv[argv.indexOf('--federated-read') + 1]).toBe('p-ada');
  });

  test('rescope argv names the write source; an empty string is read_source_inactive', () => {
    expect(rescopeArgv('cid', { ...spec, readSources: [] })).toEqual([
      'auth', 'rescope-client', 'cid', '--source', 'p-ada', '--profile', 'memory-writer', '--federated-read', 'p-ada', '--json',
    ]);
  });
});

describe('parseCredentials', () => {
  test('reads token and unix-seconds expiry from the credentials file', () => {
    const c = parseCredentials({ client_id: 'abc', access_token: 'tok', expires_at: 1799799166 });
    expect(c).toEqual({ clientId: 'abc', token: 'tok', expiresAt: new Date('2027-01-13T00:12:46Z') });
  });
  test('refuses a file without a token', () => {
    expect(() => parseCredentials({ client_id: 'abc' })).toThrow(/token/);
  });
});

describe('CliGbrainAdmin', () => {
  test('createClient grants, reads then deletes the credentials file', async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]): Promise<CliResult> => {
      calls.push(argv);
      const out = argv[argv.indexOf('--credentials-out') + 1]!;
      await Bun.write(out, JSON.stringify({ client_id: 'cid-1', access_token: 'secret', expires_at: '2027-01-01T00:00:00Z' }));
      return { exitCode: 0, stdout: '{"client_id":"cid-1"}', stderr: '' };
    };
    const admin = new CliGbrainAdmin(run, 'http://gbrain:3131');
    const issued = await admin.createClient(spec);
    // The CLI lane is retained for source ops; its grant argv still targets the
    // gbrain origin this process can reach, never the public URL or host port.
    expect(calls[0]).toContain('http://gbrain:3131/mcp');
    expect(calls[0]).not.toContain('http://127.0.0.1:3000/mcp');
    expect(calls[0]).not.toContain('8788');
    expect(issued.clientId).toBe('cid-1');
    expect(issued.token).toBe('secret');
    const file = calls[0]![calls[0]!.indexOf('--credentials-out') + 1]!;
    expect(await Bun.file(file).exists()).toBe(false);
  });

  test('a failed grant throws a scrubbed error', async () => {
    const run = async (): Promise<CliResult> => ({ exitCode: 2, stdout: '', stderr: 'bad postgres://g:pw@h/db' });
    const err = await new CliGbrainAdmin(run, 'u').createClient(spec).catch((e) => e);
    expect(String(err)).not.toContain('pw@');
  });

  test('archiveSource passes no --yes: gbrain 0.60.230.0 rejects it as invalid_params', async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]): Promise<CliResult> => { calls.push(argv); return { exitCode: 0, stdout: '', stderr: '' }; };
    await new CliGbrainAdmin(run, 'http://gbrain:3131').archiveSource('p-ada');
    expect(calls).toEqual([['sources', 'archive', 'p-ada']]);
  });

  test('an already archived source is not an error', async () => {
    const run = async (): Promise<CliResult> => ({ exitCode: 1, stdout: '', stderr: 'already archived: p-ada' });
    await new CliGbrainAdmin(run, 'u').archiveSource('p-ada');
  });
});

// ---- HttpGbrainAdmin (gbrain's owner admin HTTP API) -----------------------

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Handler = { match: (url: string, method: string) => boolean; respond: (body: unknown) => Response };

/** A fetch that records exact paths, headers and bodies. */
function fakeFetch(handlers: Handler[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers as HeadersInit).forEach((value, key) => { headers[key] = value; });
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, headers, body });
    const handler = handlers.find((h) => h.match(url, method));
    if (!handler) throw new Error(`unexpected fetch ${method} ${url}`);
    return handler.respond(body);
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

const login = (respond?: (body: unknown) => Response): Handler => ({
  match: (url, method) => url.endsWith('/admin/login') && method === 'POST',
  respond: (body) => {
    const res = respond ? respond(body) : json({ status: 'authenticated' });
    if (!res.headers.get('set-cookie')) res.headers.set('set-cookie', 'gbrain_admin=SESS; Path=/; HttpOnly');
    return res;
  },
});
const authed = (path: string, respond: (body: unknown) => Response): Handler => ({
  match: (url, method) => url.endsWith(path) && method === 'POST', respond,
});
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('HttpGbrainAdmin.createClient', () => {
  test('logs in with the bootstrap token, then grants with the public MCP url and a token TTL', async () => {
    const { fetch, calls } = fakeFetch([
      login(() => new Response('{"status":"authenticated"}', { status: 200, headers: { 'set-cookie': 'gbrain_admin=SESS; Path=/; HttpOnly' } })),
      authed('/admin/api/grants', () => json({ grant: { clientId: 'cid-1' }, credentials: { client_id: 'cid-1', access_token: 'tok', expires_at: 1799799166 } })),
    ]);
    const admin = new HttpGbrainAdmin(fetch, 'http://gbrain:3131', 'http://127.0.0.1:8788', 'bootstrap-secret');
    const issued = await admin.createClient(spec);
    expect(issued).toEqual({ clientId: 'cid-1', token: 'tok', expiresAt: new Date('2027-01-13T00:12:46Z') });
    expect(calls.map((c) => c.url)).toEqual(['http://gbrain:3131/admin/login', 'http://gbrain:3131/admin/api/grants']);
    expect(calls[0]!.body).toEqual({ token: 'bootstrap-secret' });
    expect(calls[1]!.headers.cookie).toBe('gbrain_admin=SESS');
    expect(calls[1]!.body).toEqual({
      name: 'mb-agent-u1', harness: 'generic', profile: 'memory-writer', sourceId: 'p-ada',
      url: 'http://127.0.0.1:8788/mcp',
      patch: { federatedRead: ['c-company', 'c-eng', 'p-ada'], tokenTtlSeconds: 7_776_000 },
    });
  });

  test('a rejected login fails before any admin call', async () => {
    const { fetch, calls } = fakeFetch([login(() => json({ error: 'Owner credential rejected' }, 401))]);
    const err = await new HttpGbrainAdmin(fetch, 'http://gbrain:3131', 'http://p', 'bad').createClient(spec).catch((e) => e);
    expect(String(err)).toContain('login failed: HTTP 401');
    expect(calls).toHaveLength(1);
  });

  test('a rejected grant throws a scrubbed error without leaking credentials', async () => {
    const { fetch } = fakeFetch([
      login(() => json({ status: 'authenticated' }, 200)),
      authed('/admin/api/grants', () => json({ error: 'invalid_grant', message: 'bad postgres://g:pw@h/db' }, 400)),
    ]);
    const err = await new HttpGbrainAdmin(fetch, 'http://gbrain:3131', 'http://p', 't').createClient(spec).catch((e) => e);
    expect(String(err)).toContain('mcp grant failed: HTTP 400');
    expect(String(err)).not.toContain('pw@');
  });

  test('re-authenticates once when gbrain drops the admin session', async () => {
    let logins = 0;
    const { fetch, calls } = fakeFetch([
      login(() => { logins++; return new Response('{}', { status: 200, headers: { 'set-cookie': `gbrain_admin=S${logins}; Path=/` } }); }),
      authed('/admin/api/grants', () => logins === 1
        ? json({ error: 'Admin authentication required' }, 401)
        : json({ credentials: { client_id: 'cid', access_token: 'tok' } })),
    ]);
    const issued = await new HttpGbrainAdmin(fetch, 'http://gbrain:3131', 'http://p', 't').createClient(spec);
    expect(issued.clientId).toBe('cid');
    expect(calls.filter((c) => c.url.endsWith('/admin/login'))).toHaveLength(2);
  });
});

describe('HttpGbrainAdmin edits', () => {
  test('rescopeClient sends the extended edit body, profile included', async () => {
    const { fetch, calls } = fakeFetch([
      login(() => json({ status: 'authenticated' }, 200)),
      authed('/admin/api/rescope-client', () => json({ after: {} })),
    ]);
    await new HttpGbrainAdmin(fetch, 'http://gbrain:3131', 'http://p', 't').rescopeClient('cid-1', spec);
    expect(calls.at(-1)!.url).toBe('http://gbrain:3131/admin/api/rescope-client');
    expect(calls.at(-1)!.body).toEqual({
      clientId: 'cid-1', sourceId: 'p-ada', federatedRead: ['c-company', 'c-eng', 'p-ada'], profile: 'memory-writer',
    });
  });

  test('revokeClient uses the idempotent legacy revoke-client route', async () => {
    const { fetch, calls } = fakeFetch([
      login(() => json({ status: 'authenticated' }, 200)),
      authed('/admin/api/revoke-client', () => json({ revoked: true })),
    ]);
    await new HttpGbrainAdmin(fetch, 'http://gbrain:3131', 'http://p', 't').revokeClient('cid-1');
    expect(calls.at(-1)!.url).toBe('http://gbrain:3131/admin/api/revoke-client');
    expect(calls.at(-1)!.body).toEqual({ clientId: 'cid-1' });
  });

  test('revokeClient tolerates an unknown client (404) and an already-revoked one (409)', async () => {
    for (const status of [404, 409]) {
      const { fetch } = fakeFetch([
        login(() => json({ status: 'authenticated' }, 200)),
        authed('/admin/api/revoke-client', () => json({ error: 'client_not_found' }, status)),
      ]);
      await new HttpGbrainAdmin(fetch, 'http://gbrain:3131', 'http://p', 't').revokeClient('cid-1');
    }
    const { fetch } = fakeFetch([
      login(() => json({ status: 'authenticated' }, 200)),
      authed('/admin/api/revoke-client', () => json({ error: 'boom' }, 500)),
    ]);
    await expect(new HttpGbrainAdmin(fetch, 'http://gbrain:3131', 'http://p', 't').revokeClient('cid-1'))
      .rejects.toThrow(/HTTP 500/);
  });

  test('a failed rescope is an error, not a silent no-op', async () => {
    const { fetch } = fakeFetch([
      login(() => json({ status: 'authenticated' }, 200)),
      authed('/admin/api/rescope-client', () => json({ error: 'client_not_found', message: 'gone' }, 404)),
    ]);
    await expect(new HttpGbrainAdmin(fetch, 'http://gbrain:3131', 'http://p', 't').rescopeClient('cid-1', spec))
      .rejects.toThrow(/HTTP 404/);
  });

  test('sources keep using the CLI runner (no admin parity)', async () => {
    const calls: string[][] = [];
    const sourceAdmin = {
      addSource: async () => { calls.push(['add']); },
      archiveSource: async () => { calls.push(['archive']); },
    };
    const admin = new HttpGbrainAdmin(fetch, 'http://gbrain:3131', 'http://p', 't', sourceAdmin);
    await admin.addSource('p-x', 'X (private)');
    await admin.archiveSource('p-x');
    expect(calls).toEqual([['add'], ['archive']]);
  });
});
