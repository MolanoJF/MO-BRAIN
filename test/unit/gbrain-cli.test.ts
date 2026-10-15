// test/unit/gbrain-cli.test.ts
import { describe, expect, test } from 'bun:test';
import { lastJson, runGbrain, scrub } from '../../src/server/gbrain/cli.ts';

describe('scrub', () => {
  test('redacts postgres passwords, client secrets, bearer tokens and sk- keys', () => {
    const s = scrub('postgres://gbrain:hunter2@postgres:5432/gbrain client_secret="abc123" Bearer eyJabc.def sk-proj-ABCDEFGH12345');
    expect(s).not.toContain('hunter2');
    expect(s).not.toContain('abc123');
    expect(s).not.toContain('eyJabc.def');
    expect(s).not.toContain('sk-proj-ABCDEFGH12345');
  });
});

describe('lastJson', () => {
  test('returns the last balanced JSON value after noise', () => {
    expect(lastJson('progress {not json}\n[1,2]\n{"ok":true,"n":{"a":1}}\n')).toEqual({ ok: true, n: { a: 1 } });
  });
  test('returns null when there is none', () => {
    expect(lastJson('nothing here')).toBeNull();
  });
});

describe('runGbrain', () => {
  test('runs the configured binary with an argv array and captures output', async () => {
    const r = await runGbrain(['hello', 'world; rm -rf /'], { bin: 'echo' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('hello world; rm -rf /');
  });
  test('kills a command past its timeout', async () => {
    const r = await runGbrain(['5'], { bin: 'sleep', timeoutMs: 200 });
    expect(r.exitCode).not.toBe(0);
  });
});
