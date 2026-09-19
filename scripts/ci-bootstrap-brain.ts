#!/usr/bin/env bun
/**
 * F31 (docs/slice-5-findings.md) — bootstrap the MAIN stack's brain the way an
 * operator does, before the contract suite runs.
 *
 * A fresh `docker compose up` leaves gbrain-worker/serve to cold-start
 * `content_chunks.embedding` at upstream's default width (1280) with no
 * provider key in `config.json`. The pinned binary refuses a headless
 * 1280 -> 1536 re-template even with `--force`, and clearing the table from a
 * separate command does not close the window — the worker recreates the
 * template before `init` runs. The product's own wizard `/finish` closes it:
 * `resetBrainSchema` and `gbrain init` happen back to back inside one
 * control-plane request, so nothing can re-template in between (see
 * `src/control/routes/wizard.ts`). The slice3/slice3.5 seam legs and the
 * ops-backed usage read assume exactly the brain that sequence produces.
 *
 * So this script drives the PRODUCT's bootstrap path over the control-plane
 * HTTP API — first admin, provider-configured, mode-selected, schema-selected,
 * sources-added, ready — instead of hand-rolling `gbrain init` or writing to
 * gbrain's tables. It is idempotent: a `409 already_bootstrapped` signs in to
 * the existing admin, and a brain already `ready` exits 0 without touching it.
 *
 * Env (all optional; defaults match the dev override the CI job brings up):
 *   BOOTSTRAP_BASE_URL        https://localhost:8443
 *   BOOTSTRAP_TLS_INSECURE    '1' to accept the local Caddy CA (dev only)
 *   BOOTSTRAP_ADMIN_EMAIL     admin@example.test
 *   BOOTSTRAP_ADMIN_PASSWORD  a-long-enough-password
 *   BOOTSTRAP_ORG             Acme
 *   BOOTSTRAP_EMBEDDING_MODEL openai:text-embedding-3-small
 *   BOOTSTRAP_SEARCH_MODE     conservative
 *   BOOTSTRAP_SCHEMA_PACK     gbrain-base-v2
 *   BOOTSTRAP_SOURCES         comma-separated source ids (default: shared)
 *   OPENAI_API_KEY            provider key written through the wizard (/provider)
 */

const BASE = (process.env.BOOTSTRAP_BASE_URL ?? 'https://localhost:8443').replace(/\/$/, '');
const INSECURE = process.env.BOOTSTRAP_TLS_INSECURE === '1' || /^https:\/\/localhost\b/.test(BASE);
const EMAIL = process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@example.test';
const PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'a-long-enough-password';
const ORG = process.env.BOOTSTRAP_ORG ?? 'Acme';
const EMBEDDING_MODEL = process.env.BOOTSTRAP_EMBEDDING_MODEL ?? 'openai:text-embedding-3-small';
const SEARCH_MODE = process.env.BOOTSTRAP_SEARCH_MODE ?? 'conservative';
const SCHEMA_PACK = process.env.BOOTSTRAP_SCHEMA_PACK ?? 'gbrain-base-v2';
const SOURCES = (process.env.BOOTSTRAP_SOURCES ?? 'shared')
  .split(',').map((s) => s.trim()).filter(Boolean);
const API_KEY = process.env.OPENAI_API_KEY ?? '';

if (!API_KEY) {
  throw new Error('OPENAI_API_KEY is required: the wizard /provider step stores it for the init/sync/embed legs');
}

type Json = Record<string, unknown>;
type ApiResponse = { status: number; body: Json; cookie: string };

async function request(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  cookie = '',
): Promise<ApiResponse> {
  const init = {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(INSECURE ? { tls: { rejectUnauthorized: false } } : {}),
    signal: AbortSignal.timeout(15 * 60_000),
  } as RequestInit;
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let parsed: Json = {};
  try { parsed = JSON.parse(text) as Json; } catch { parsed = { raw: text }; }
  const setCookies = typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
    ? (res.headers as { getSetCookie: () => string[] }).getSetCookie()
    : [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  const nextCookie = setCookies.filter(Boolean).map((c) => c.split(';')[0]!).join('; ');
  return { status: res.status, body: parsed, cookie: nextCookie || cookie };
}

async function signIn(): Promise<string> {
  const res = await request('POST', '/api/auth/sign-in/email', { email: EMAIL, password: PASSWORD });
  if (res.status !== 200 || !res.cookie) {
    throw new Error(`sign-in failed (${res.status}); check BOOTSTRAP_ADMIN_EMAIL/PASSWORD: ${JSON.stringify(res.body)}`);
  }
  return res.cookie;
}

function lifecycleIndex(lifecycle: unknown): number {
  return ['uninitialized', 'provider-configured', 'mode-selected', 'schema-selected', 'sources-added', 'ready']
    .indexOf(String(lifecycle));
}

async function state(cookie: string): Promise<Json> {
  const res = await request('GET', '/api/wizard/state', undefined, cookie);
  if (res.status !== 200) throw new Error(`GET /api/wizard/state -> ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

const boot = await request('POST', '/api/bootstrap', { email: EMAIL, password: PASSWORD, orgName: ORG });
if (boot.status === 200) {
  console.log(`bootstrap: created first admin ${EMAIL} (${ORG})`);
} else if (boot.status === 409) {
  console.log('bootstrap: already bootstrapped; signing in to the existing admin');
} else {
  throw new Error(`POST /api/bootstrap -> ${boot.status}: ${JSON.stringify(boot.body)}`);
}

const cookie = await signIn();
let current = await state(cookie);
console.log(`wizard: lifecycle=${String(current.lifecycle)}`);

if (current.lifecycle === 'ready') {
  console.log('wizard: brain already ready — nothing to do');
  process.exit(0);
}

// Walk the wizard in order. Each transition is idempotent at the same step
// (canAdvance allows from===to), so a partially-advanced brain resumes rather
// than restarting. Steps whose target the brain has already passed are skipped.
if (lifecycleIndex(current.lifecycle) < 1) {
  const r = await request('POST', '/api/wizard/provider',
    { provider: 'openai', apiKey: API_KEY, embeddingModel: EMBEDDING_MODEL }, cookie);
  if (r.status !== 200) throw new Error(`/wizard/provider -> ${r.status}: ${JSON.stringify(r.body)}`);
  console.log(`wizard: provider configured (${EMBEDDING_MODEL})`);
}

if (lifecycleIndex(current.lifecycle) < 2) {
  const r = await request('POST', '/api/wizard/search-mode', { mode: SEARCH_MODE }, cookie);
  if (r.status !== 200) throw new Error(`/wizard/search-mode -> ${r.status}: ${JSON.stringify(r.body)}`);
  console.log(`wizard: search mode ${SEARCH_MODE}`);
}

if (lifecycleIndex(current.lifecycle) < 3) {
  const r = await request('POST', '/api/wizard/schema', { pack: SCHEMA_PACK }, cookie);
  if (r.status !== 200) throw new Error(`/wizard/schema -> ${r.status}: ${JSON.stringify(r.body)}`);
  console.log(`wizard: schema pack ${SCHEMA_PACK}`);
}

if (lifecycleIndex(current.lifecycle) < 4) {
  for (const sourceId of SOURCES) {
    const r = await request('POST', '/api/wizard/space', { sourceId, name: sourceId }, cookie);
    if (r.status !== 200) throw new Error(`/wizard/space ${sourceId} -> ${r.status}: ${JSON.stringify(r.body)}`);
    console.log(`wizard: Space ${sourceId}`);
  }
}

if (lifecycleIndex(current.lifecycle) < 5) {
  console.log('wizard: /finish (reset-brain-schema -> init -> sources -> sync -> embed -> doctor)…');
  const r = await request('POST', '/api/wizard/finish', {}, cookie);
  if (r.status !== 200) throw new Error(`/wizard/finish -> ${r.status}: ${JSON.stringify(r.body)}`);
  const finishLifecycle = String(r.body.lifecycle);
  const finishOk = String(r.body.ok);
  console.log(`wizard: /finish ok=${finishOk} lifecycle=${finishLifecycle}`);
}

current = await state(cookie);
if (current.lifecycle !== 'ready') {
  throw new Error(`brain did not reach ready: lifecycle=${String(current.lifecycle)}`);
}
console.log('wizard: brain ready — the seam legs have an operator-initialized brain');

export {};
