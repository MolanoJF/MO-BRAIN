import { test, expect, describe, beforeAll } from 'bun:test';

beforeAll(() => { process.env.ENCRYPTION_KEY = 'a'.repeat(48); });

describe('envelope encryption', () => {
  test('seal then open round-trips', async () => {
    const { seal, open } = await import('../../src/control/secrets.ts');
    expect(open(seal('sk-secret-value'))).toBe('sk-secret-value');
  });

  test('the sealed form contains no plaintext', async () => {
    const { seal } = await import('../../src/control/secrets.ts');
    expect(JSON.stringify(seal('sk-secret-value'))).not.toContain('sk-secret-value');
  });

  // Per-secret DEK: two seals of the same plaintext must not be identical.
  test('each seal uses a fresh DEK and IV', async () => {
    const { seal } = await import('../../src/control/secrets.ts');
    const a = seal('same'), b = seal('same');
    expect(a.payload).not.toBe(b.payload);
    expect(a.wrappedDek).not.toBe(b.wrappedDek);
    expect(a.salt).not.toBe(b.salt);
  });

  test('a tampered payload fails authentication rather than decrypting', async () => {
    const { seal, open } = await import('../../src/control/secrets.ts');
    const s = seal('sk-secret-value');
    const buf = Buffer.from(s.payload, 'base64');
    buf[buf.length - 1]! ^= 0xff;
    expect(() => open({ ...s, payload: buf.toString('base64') })).toThrow();
  });

  test('a wrong ENCRYPTION_KEY cannot open a sealed secret', async () => {
    const { seal, open } = await import('../../src/control/secrets.ts');
    const s = seal('sk-secret-value');
    const prev = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'b'.repeat(48);
    expect(() => open(s)).toThrow();
    process.env.ENCRYPTION_KEY = prev;
  });

  test('a short ENCRYPTION_KEY is refused at seal time', async () => {
    const { seal } = await import('../../src/control/secrets.ts');
    const prev = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'tooshort';
    expect(() => seal('x')).toThrow('ENCRYPTION_KEY must be at least 32');
    process.env.ENCRYPTION_KEY = prev;
  });
});
