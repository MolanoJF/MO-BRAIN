/**
 * Spec agent-control-mcp D6: a gated tool acts only on a token minted by its
 * own preview, for the same tool, arguments, member and state fingerprint,
 * within 5 minutes. Stateless: an HMAC under a key derived from ENCRYPTION_KEY.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

// FROZEN (HANDOFF D3 rule for HKDF separators). Not a product name.
const SEPARATOR = 'mobrain-control-confirm-v1';
export const CONFIRM_TTL_MS = 5 * 60_000;

function key(): Buffer {
  const master = process.env.ENCRYPTION_KEY;
  if (!master) throw new Error('ENCRYPTION_KEY is required');
  return Buffer.from(hkdfSync('sha256', Buffer.from(master, 'utf8'), Buffer.alloc(0), Buffer.from(SEPARATOR), 32));
}

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export type ConfirmSubject = { tool: string; membershipId: string; args: Record<string, unknown>; fingerprint?: string };

function mac(subject: ConfirmSubject, exp: number): string {
  return createHmac('sha256', key())
    .update(canonical([subject.tool, subject.membershipId, exp, subject.fingerprint ?? null, subject.args]))
    .digest('base64url');
}

export function mintConfirm(subject: ConfirmSubject, now = Date.now()): { token: string; expiresAt: string } {
  const exp = now + CONFIRM_TTL_MS;
  return { token: `${exp}.${mac(subject, exp)}`, expiresAt: new Date(exp).toISOString() };
}

export function checkConfirm(
  token: unknown, subject: ConfirmSubject, now = Date.now(),
): { ok: true } | { ok: false; error: 'confirm_malformed' | 'confirm_expired' | 'confirm_mismatch' } {
  if (typeof token !== 'string') return { ok: false, error: 'confirm_malformed' };
  const m = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return { ok: false, error: 'confirm_malformed' };
  const exp = Number(m[1]);
  if (exp < now) return { ok: false, error: 'confirm_expired' };
  if (exp > now + CONFIRM_TTL_MS) return { ok: false, error: 'confirm_mismatch' };
  const want = Buffer.from(mac(subject, exp));
  const got = Buffer.from(m[2]!);
  return want.length === got.length && timingSafeEqual(want, got) ? { ok: true } : { ok: false, error: 'confirm_mismatch' };
}
