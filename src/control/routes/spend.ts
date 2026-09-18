/**
 * `GET /api/spend?days=30` — the org's metered spend, admin-only (D9, D13).
 *
 * The surface is additive, read-only and admin-gated. `days` is clamped 1–365
 * to mirror upstream's own `get_usage` clamp.
 *
 * `spendReport` assembles our meter's rollups and reaches for gbrain's ledger.
 * When that reach fails, the report's `brain` is null and
 * `coverage.brainReachable` is false: the page states that the brain ledger
 * could not be read rather than failing, and never reports the unread ledger as
 * zero.
 */
import { Hono, type Context } from 'hono';
import { requireRole, type Role } from '../rbac.ts';
import { spendReport } from '../spend.ts';

export const spendRoutes = new Hono();

/** Upstream's `get_usage` default is 30 days and its hard max is 365. */
export const SPEND_DEFAULT_DAYS = 30;
export const SPEND_MAX_DAYS = 365;

/** A whole number in [1, 365]; a missing or malformed value is the 30-day default. */
export function clampDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return SPEND_DEFAULT_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return SPEND_DEFAULT_DAYS;
  return Math.min(SPEND_MAX_DAYS, Math.max(1, Math.trunc(n)));
}

const guard = (
  min: Role,
  handler: (c: Context, ctx: { userId: string; orgId: string; role: Role }) => Promise<Response>,
) =>
  async (c: Context) => {
    let ctx: { userId: string; orgId: string; role: Role };
    try {
      ctx = await requireRole(c, min);
    } catch (e) {
      if (e instanceof Response) return e;
      throw e;
    }
    try {
      return await handler(c, ctx);
    } catch (e) {
      const status = e && typeof e === 'object' && 'status' in e && typeof e.status === 'number'
        ? e.status
        : 400;
      const message = e instanceof Error ? e.message : 'spend_error';
      return c.json({ error: message }, status as 400 | 401 | 403 | 500);
    }
  };

spendRoutes.get('/spend', guard('admin', async (c, { orgId }) => {
  const days = clampDays(c.req.query('days'));
  return c.json(await spendReport(orgId, days));
}));
