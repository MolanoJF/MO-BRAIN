// test/unit/gbrain-admin.test.ts
import { describe, expect, test } from 'bun:test';
import { CliGbrainAdmin, grantArgv, parseCredentials, rescopeArgv } from '../../src/server/gbrain/admin.ts';
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
    expect(calls[0]).toContain('http://gbrain:3131/mcp');
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
});
