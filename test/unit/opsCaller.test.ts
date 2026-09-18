import { describe, expect, test } from 'bun:test';
import { relayArgv, defaultOpsCaller, httpOpsCaller } from '../../src/control/opsCaller.ts';

const COMPOSE = ['docker', 'compose', '-f', 'compose/docker-compose.yml'] as const;

describe('relayArgv', () => {
  test('reaches ops through compose exec, never a host fetch', () => {
    const argv = relayArgv(COMPOSE);
    expect(argv.slice(0, 4)).toEqual([...COMPOSE]);
    expect(argv).toContain('exec');
    expect(argv).toContain('-T');
    expect(argv).toContain('gbrain-ops');
    // G2: argv array, never a shell string.
    expect(argv).not.toContain('-c');
    expect(argv.some((a) => a === 'sh' || a === 'bash')).toBe(false);
  });
});

describe('defaultOpsCaller', () => {
  test('falls back to the relay when no ops port answers', async () => {
    const caller = await defaultOpsCaller(COMPOSE, { probe: async () => false });
    expect(caller.kind).toBe('relay');
  });

  test('prefers HTTP when an ops port answers', async () => {
    const caller = await defaultOpsCaller(COMPOSE, { probe: async () => true });
    expect(caller.kind).toBe('http');
  });
});

describe('httpOpsCaller', () => {
  test('is tagged so a manifest can record which lane proved the quiesce', () => {
    expect(httpOpsCaller().kind).toBe('http');
  });
});
