/**
 * The per-run gateway token: stateless, HMAC-signed, and burned by the run row.
 *
 * **This deviates from the plan, deliberately.** D7 said "stored hashed, the same shape `claim_links`
 * already uses", but Task 4 is already committed and `agent_runs` has **no** column to store a token
 * hash in, and what honesty rule 9 actually needs is not a stored hash — it is that a token stops
 * working when the run ends. So the token is a signed value, not a row:
 *
 *   `runId.expiry.<mac>`   mac = HMAC-SHA256(key, "runId.expiry")   expiry = epoch seconds
 *
 * and "burned at run end" is enforced where the run is already looked up on every request — the
 * budget check (`assertBudget` in `meter.ts`): a token whose run has `token_revoked_at` set, or whose
 * `schedule_runs.state` is no longer live, is refused there. The scheduler's reclaimer already
 * revokes on every exit path including the one where the runner process died (honesty rule 9).
 *
 * The key is derived from `ENCRYPTION_KEY` through a fixed domain salt, so it is the control plane's
 * secret and **not** `RUNNER_TOKEN` (which the runner itself holds — a token the runner can forge is
 * not a credential).
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/** Domain separation: this key is only ever a gateway-token key. */
function tokenKey(): Buffer {
  const master = process.env.ENCRYPTION_KEY;
  if (!master || master.length < 32) throw new Error('ENCRYPTION_KEY must be at least 32 characters');
  return Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(master, 'utf8'),
    Buffer.from('brainstand-gateway-token-salt'),
    Buffer.from('brainstand-gateway-token-v1'),
    32,
  ));
}

function mac(runId: string, expiry: number): string {
  return createHmac('sha256', tokenKey()).update(`${runId}.${expiry}`).digest('base64url');
}

/** `ttlSeconds` is minutes-scale (D7): the token never outlives the run it was minted for. */
export function mintGatewayToken(runId: string, ttlSeconds: number, nowMs = Date.now()): string {
  if (!runId) throw new Error('runId is required');
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new Error('ttlSeconds must be positive');
  const expiry = Math.floor(nowMs / 1000) + Math.floor(ttlSeconds);
  return `${runId}.${expiry}.${mac(runId, expiry)}`;
}

/**
 * Stateless: signature, shape and expiry only. Whether the *run* may still spend is a row lookup —
 * `assertBudget`, which every request performs anyway. `null` on anything malformed.
 */
export function verifyGatewayToken(token: string, nowMs = Date.now()): { runId: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [runId, expiryRaw, presented] = parts as [string, string, string];
  if (!runId || !/^\d+$/.test(expiryRaw)) return null;
  const expiry = Number(expiryRaw);
  const expected = Buffer.from(mac(runId, expiry), 'utf8');
  const got = Buffer.from(presented, 'utf8');
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  if (Math.floor(nowMs / 1000) >= expiry) return null;
  return { runId };
}
