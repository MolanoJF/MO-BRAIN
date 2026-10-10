import { describe, expect, test } from 'bun:test';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(48);
const { canonical, checkConfirm, CONFIRM_TTL_MS, mintConfirm } = await import('../../src/control/mcp/confirm.ts');

const subject = { tool: 'schema_apply', membershipId: 'm1', args: { pack: 'hr', extra: { b: 1, a: [2, 3] } }, fingerprint: 'gbrain-base-v2' };
const NOW = 1_800_000_000_000;

describe('confirm tokens', () => {
  test('canonical is key-order independent', () => {
    expect(canonical({ b: 1, a: { d: 2, c: 3 } })).toBe(canonical({ a: { c: 3, d: 2 }, b: 1 }));
  });

  test('a minted token checks out for the same subject', () => {
    const { token, expiresAt } = mintConfirm(subject, NOW);
    expect(new Date(expiresAt).getTime()).toBe(NOW + CONFIRM_TTL_MS);
    expect(checkConfirm(token, { ...subject, args: { extra: { a: [2, 3], b: 1 }, pack: 'hr' } }, NOW + 1000)).toEqual({ ok: true });
  });

  test('changed args, tool, member or fingerprint are a mismatch', () => {
    const { token } = mintConfirm(subject, NOW);
    expect(checkConfirm(token, { ...subject, args: { pack: 'other' } }, NOW)).toEqual({ ok: false, error: 'confirm_mismatch' });
    expect(checkConfirm(token, { ...subject, tool: 'org_set_mode' }, NOW)).toEqual({ ok: false, error: 'confirm_mismatch' });
    expect(checkConfirm(token, { ...subject, membershipId: 'm2' }, NOW)).toEqual({ ok: false, error: 'confirm_mismatch' });
    expect(checkConfirm(token, { ...subject, fingerprint: 'hr' }, NOW)).toEqual({ ok: false, error: 'confirm_mismatch' });
  });

  test('an expired token is expired; a far-future one is a mismatch', () => {
    const { token } = mintConfirm(subject, NOW);
    expect(checkConfirm(token, subject, NOW + CONFIRM_TTL_MS + 1)).toEqual({ ok: false, error: 'confirm_expired' });
    const [exp, mac] = token.split('.');
    expect(checkConfirm(`${Number(exp) + 3_600_000}.${mac}`, subject, NOW)).toEqual({ ok: false, error: 'confirm_mismatch' });
  });

  test('garbage is malformed', () => {
    for (const bad of [undefined, 42, '', 'abc', '123.xyz', `${NOW}.${'a'.repeat(10)}`]) {
      expect(checkConfirm(bad, subject, NOW)).toEqual({ ok: false, error: 'confirm_malformed' });
    }
  });
});
