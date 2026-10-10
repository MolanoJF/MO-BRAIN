import { describe, expect, test } from 'bun:test';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(48);
process.env.BETTER_AUTH_SECRET ??= 'b'.repeat(48);
process.env.CONTROL_DATABASE_URL ??= 'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control';

const { clientIdFromWhoami, tokenKey } = await import('../../src/control/mcp/caller.ts');

describe('clientIdFromWhoami', () => {
  test('reads the OAuth client id in each documented shape', () => {
    expect(clientIdFromWhoami({ transport: 'oauth', client_id: 'a' })).toBe('a');
    expect(clientIdFromWhoami({ transport: 'oauth', clientId: 'b' })).toBe('b');
    expect(clientIdFromWhoami({ transport: 'oauth', client: 'c' })).toBe('c');
    expect(clientIdFromWhoami({ transport: 'oauth', client: { id: 'd' } })).toBe('d');
    expect(clientIdFromWhoami({ transport: 'oauth', client: { client_id: 'e' } })).toBe('e');
  });

  test('refuses anything that is not an OAuth identity with a client', () => {
    expect(clientIdFromWhoami({ transport: 'local', client_id: 'a' })).toBeNull();
    expect(clientIdFromWhoami({ transport: 'oauth' })).toBeNull();
    expect(clientIdFromWhoami({ transport: 'oauth', client_id: '' })).toBeNull();
    expect(clientIdFromWhoami({ transport: 'oauth', client_id: 42 })).toBeNull();
  });
});

test('tokenKey is a sha256 hex digest, never the token', () => {
  const key = tokenKey('gbrain_at_secret_value_123456');
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  expect(key).not.toContain('secret');
});
