import { Hono } from 'hono';
import { claim } from '../claim.ts';

export const claimRoutes = new Hono();

const WINDOW_MS = 15 * 60 * 1000;
const MAX_HITS = 20;
const hits = new Map<string, number[]>();

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return c.req.header('x-real-ip') ?? 'unknown';
}

function allow(ip: string): boolean {
  const now = Date.now();
  const prev = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (prev.length >= MAX_HITS) {
    hits.set(ip, prev);
    return false;
  }
  prev.push(now);
  hits.set(ip, prev);
  return true;
}

/** Unauthenticated write. Email is in the JSON body, never the query string. Do not log the body (S3c). */
claimRoutes.post('/claim/:token', async (c) => {
  if (!allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);

  const token = c.req.param('token');
  let email = '';
  let password: string | undefined;
  try {
    const body = await c.req.json();
    if (body && typeof body.email === 'string') email = body.email;
    if (body && typeof body.password === 'string') password = body.password;
  } catch { /* missing/invalid JSON */ }
  if (!email) return c.json({ error: 'email is required' }, 400);
  // Checked BEFORE `claim` burns the link: a typo must not cost the invite.
  if (password !== undefined && password.length < 12) return c.json({ error: 'password_too_short' }, 400);

  try {
    return c.json(await claim(token, email, password));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'claim_failed';
    return c.json({ error: message }, 400);
  }
});
