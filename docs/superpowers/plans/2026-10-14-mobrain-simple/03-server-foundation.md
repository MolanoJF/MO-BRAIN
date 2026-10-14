# Phase 3: Server foundation

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Read `00-master.md` first, and the probe results file from phase 2.

**Goal:** A running `mobrain` service with configuration, its own database and migrations, token sealing, password and session auth, API keys, the three gbrain adapters (CLI, MCP, admin), the HTTP error and role machinery, the public health route, and the reverse proxy to gbrain.

**Spec sections:** §4, §5.1, §9.2.

**Conventions for every file in `src/server/`:** ESM TypeScript run directly by Bun; import siblings with the `.ts` extension; no default exports except `main.ts`; a function takes its dependencies as parameters (no module-level singletons besides constants), so tests pass fakes.

---

### Task 3.1: Shared types and environment

**Files:**
- Create: `src/server/types.ts`
- Create: `src/server/env.ts`
- Test: `test/unit/env.test.ts`
- Modify: `package.json` (add `"version": "2.0.0-dev"` after `"name"`)

- [ ] **Step 1: Write `src/server/types.ts`** exactly as in `00-master.md` "Shared interfaces", first block.

- [ ] **Step 2: Write the failing test**

```ts
// test/unit/env.test.ts
import { describe, expect, test } from 'bun:test';
import { loadEnv } from '../../src/server/env.ts';

const base = {
  DATABASE_URL: 'postgres://mobrain:x@postgres:5432/mobrain',
  ENCRYPTION_KEY: 'k'.repeat(44),
  GBRAIN_VERSION: '0.60.230.0',
};

describe('loadEnv', () => {
  test('applies defaults', () => {
    const e = loadEnv(base);
    expect(e.port).toBe(3000);
    expect(e.gbrainUrl).toBe('http://gbrain:3131');
    expect(e.publicUrl).toBe('http://127.0.0.1:8787');
    expect(e.uiDir).toBe('dist/ui');
    expect(e.secureCookies).toBe(false);
  });

  test('https public url turns on secure cookies and strips a trailing slash', () => {
    const e = loadEnv({ ...base, MOBRAIN_PUBLIC_URL: 'https://brain.example.ts.net:8443/' });
    expect(e.publicUrl).toBe('https://brain.example.ts.net:8443');
    expect(e.secureCookies).toBe(true);
  });

  test('refuses a missing or short encryption key', () => {
    expect(() => loadEnv({ ...base, ENCRYPTION_KEY: 'short' })).toThrow(/ENCRYPTION_KEY/);
    const { ENCRYPTION_KEY: _, ...rest } = base;
    expect(() => loadEnv(rest)).toThrow(/ENCRYPTION_KEY/);
  });

  test('refuses a missing database url or pin', () => {
    const { DATABASE_URL: _, ...noDb } = base;
    expect(() => loadEnv(noDb)).toThrow(/DATABASE_URL/);
    const { GBRAIN_VERSION: __, ...noPin } = base;
    expect(() => loadEnv(noPin)).toThrow(/GBRAIN_VERSION/);
  });
});
```

Run: `bun test test/unit/env.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/server/env.ts`**

```ts
export type Env = {
  port: number;
  databaseUrl: string;
  gbrainUrl: string;
  publicUrl: string;
  encryptionKey: string;
  gbrainVersion: string;
  uiDir: string;
  secureCookies: boolean;
};

type Source = Record<string, string | undefined>;

function required(src: Source, key: string): string {
  const v = src[key]?.trim();
  if (!v) throw new Error(`${key} is required`);
  return v;
}

export function loadEnv(src: Source = process.env): Env {
  const encryptionKey = required(src, 'ENCRYPTION_KEY');
  if (encryptionKey.length < 32) throw new Error('ENCRYPTION_KEY must be at least 32 characters');
  const publicUrl = (src.MOBRAIN_PUBLIC_URL?.trim() || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  return {
    port: Number(src.PORT ?? 3000),
    databaseUrl: required(src, 'DATABASE_URL'),
    gbrainUrl: (src.GBRAIN_URL?.trim() || 'http://gbrain:3131').replace(/\/+$/, ''),
    publicUrl,
    encryptionKey,
    gbrainVersion: required(src, 'GBRAIN_VERSION'),
    uiDir: src.MOBRAIN_UI_DIR?.trim() || 'dist/ui',
    secureCookies: publicUrl.startsWith('https://'),
  };
}
```

- [ ] **Step 4: Run the test** — `bun test test/unit/env.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/types.ts src/server/env.ts test/unit/env.test.ts package.json
git commit -m "feat(server): shared types and environment loading

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3.2: Database client, migrations, schema

**Files:**
- Create: `src/server/db/index.ts`
- Create: `src/server/db/migrate.ts`
- Create: `src/server/db/migrations/001_init.sql`
- Create: `test/db/helpers.ts`
- Test: `test/db/migrate.test.ts`

- [ ] **Step 1: Write the DB test helper**

```ts
// test/db/helpers.ts
import postgres from 'postgres';
import { migrate } from '../../src/server/db/migrate.ts';

export type Sql = postgres.Sql;

/** A fresh, migrated database per test file. */
export async function freshDb(): Promise<{ sql: Sql; drop: () => Promise<void> }> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set; run `bun run test:db`');
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const name = `t_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await admin.unsafe(`create database ${name}`);
  const sql = postgres(url.replace(/\/[^/]*$/, `/${name}`), { max: 4, transform: postgres.camel, onnotice: () => {} });
  await migrate(sql);
  return {
    sql,
    drop: async () => {
      await sql.end();
      await admin.unsafe(`drop database ${name} with (force)`);
      await admin.end();
    },
  };
}
```

- [ ] **Step 2: Write the failing test**

```ts
// test/db/migrate.test.ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { freshDb, type Sql } from './helpers.ts';
import { migrate } from '../../src/server/db/migrate.ts';

let sql: Sql; let drop: () => Promise<void>;
beforeAll(async () => ({ sql, drop } = await freshDb()));
afterAll(async () => drop());

test('creates every table', async () => {
  const rows = await sql<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public' order by 1`;
  expect(rows.map((r) => r.tablename)).toEqual([
    'api_keys', 'audit_log', 'collector_runs', 'gbrain_clients', 'grants', 'invites',
    'schema_migrations', 'sessions', 'settings', 'sources', 'users',
  ]);
});

test('defaults mode to personal', async () => {
  const [row] = await sql<{ value: string }[]>`select value from settings where key = 'mode'`;
  expect(row!.value).toBe('personal');
});

test('is idempotent', async () => {
  await migrate(sql);
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from schema_migrations`;
  expect(row!.n).toBe(1);
});

test('enforces one owner', async () => {
  await sql`insert into users (email, role, status) values ('a@x.io', 'owner', 'active')`;
  await expect(sql`insert into users (email, role, status) values ('b@x.io', 'owner', 'active')`).rejects.toThrow();
});

test('a private source needs an owner and a company source must not have one', async () => {
  await expect(sql`insert into sources (id, kind, name) values ('p-x', 'private', 'x')`).rejects.toThrow();
  const [u] = await sql<{ id: string }[]>`select id from users where email = 'a@x.io'`;
  await expect(sql`insert into sources (id, kind, owner_user_id, name) values ('c-x', 'company', ${u!.id}, 'x')`).rejects.toThrow();
});
```

Run: `bun run test:db` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/server/db/migrations/001_init.sql`**

```sql
create extension if not exists citext;

create table settings (key text primary key, value jsonb not null);
insert into settings (key, value) values ('mode', '"personal"');

create table users (
  id uuid primary key default gen_random_uuid(),
  email citext unique not null,
  name text,
  role text not null check (role in ('owner','admin','member','viewer')),
  status text not null check (status in ('invited','active','offboarding','disabled')),
  password_hash text,
  created_at timestamptz not null default now()
);
create unique index users_one_owner on users ((true)) where role = 'owner';

create table sessions (
  id_hash text primary key,
  user_id uuid not null references users on delete cascade,
  expires_at timestamptz not null
);

create table invites (
  token_hash text primary key,
  user_id uuid not null references users on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table sources (
  id text primary key,
  kind text not null check (kind in ('private','company')),
  owner_user_id uuid references users,
  name text not null,
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  check ((kind = 'private') = (owner_user_id is not null))
);

create table grants (
  user_id uuid not null references users on delete cascade,
  source_id text not null references sources,
  agent_reads boolean not null default true,
  primary key (user_id, source_id)
);

create table gbrain_clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users,
  purpose text not null check (purpose in ('agent','ui','company_writer','instance')),
  write_source text references sources,
  gbrain_client_id text not null,
  token_enc text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index gbrain_clients_live on gbrain_clients (user_id, purpose) where revoked_at is null;

create table api_keys (
  key_hash text primary key,
  user_id uuid not null references users on delete cascade,
  label text not null default 'cli',
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table collector_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users,
  source_id text not null,
  collector text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('running','ok','partial','error','timeout')),
  exit_code int,
  timeout_s int not null default 1200,
  summary text,
  log_tail text
);
create index collector_runs_recent on collector_runs (source_id, collector, started_at desc);

create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor_user_id uuid,
  action text not null,
  target text,
  detail jsonb
);
```

Note the two columns added to spec §5.1 for implementation: `gbrain_clients.expires_at` (token rotation, Review Focus #2) and `collector_runs.timeout_s` and `summary` (Review Focus #3 and the run summary line). Add them to the spec's §5.1 block in this task's commit.

- [ ] **Step 4: Write `src/server/db/migrate.ts`**

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';

const DIR = join(import.meta.dir, 'migrations');

/** Apply every migrations/NNN_*.sql not yet recorded, each in its own transaction. */
export async function migrate(sql: postgres.Sql): Promise<string[]> {
  await sql`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
  const done = new Set((await sql<{ version: string }[]>`select version from schema_migrations`).map((r) => r.version));
  const applied: string[] = [];
  for (const file of readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort()) {
    const version = file.slice(0, 3);
    if (done.has(version)) continue;
    const text = readFileSync(join(DIR, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (version) values (${version})`;
    });
    applied.push(file);
  }
  return applied;
}
```

- [ ] **Step 5: Write `src/server/db/index.ts`**

```ts
import postgres from 'postgres';

export type Sql = postgres.Sql;

export function connect(url: string): Sql {
  return postgres(url, { max: 8, transform: postgres.camel, onnotice: () => {} });
}

export async function audit(
  sql: Sql,
  actorUserId: string | null,
  action: string,
  target: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await sql`insert into audit_log (actor_user_id, action, target, detail)
            values (${actorUserId}, ${action}, ${target}, ${sql.json(detail)})`;
}

export async function getMode(sql: Sql): Promise<'personal' | 'company'> {
  const [row] = await sql<{ value: 'personal' | 'company' }[]>`select value from settings where key = 'mode'`;
  return row?.value ?? 'personal';
}
```

- [ ] **Step 6: Run the tests** — `bun run test:db` — Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add src/server/db test/db docs/superpowers/specs/2026-10-14-mobrain-simple-design.md
git commit -m "feat(server): mobrain database schema and migration runner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3.3: Token sealing and random tokens

**Files:**
- Create: `src/server/crypto.ts` (ported from `v1-final:src/control/secrets.ts`, storage functions dropped)
- Test: `test/unit/crypto.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/crypto.test.ts
import { describe, expect, test } from 'bun:test';
import { newToken, open, seal, sha256Hex } from '../../src/server/crypto.ts';

const KEY = 'x'.repeat(44);

describe('crypto', () => {
  test('seal and open round-trip', () => {
    const s = seal(KEY, 'gbrain-token-123');
    expect(s.startsWith('v1:')).toBe(true);
    expect(s).not.toContain('gbrain-token-123');
    expect(open(KEY, s)).toBe('gbrain-token-123');
  });

  test('two seals of the same text differ', () => {
    expect(seal(KEY, 'a')).not.toBe(seal(KEY, 'a'));
  });

  test('a different key cannot open', () => {
    expect(() => open('y'.repeat(44), seal(KEY, 'a'))).toThrow();
  });

  test('a tampered payload cannot open', () => {
    const parts = seal(KEY, 'abc').split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => open(KEY, parts.join(':'))).toThrow();
  });

  test('newToken is 43 url-safe chars and sha256Hex is stable', () => {
    const t = newToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
```

Run: `bun test test/unit/crypto.test.ts` — Expected: FAIL.

- [ ] **Step 2: Write `src/server/crypto.ts`**

```ts
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function kek(master: string, salt: Buffer): Buffer {
  // FROZEN FOREVER: an HKDF domain separator, not a product name. Changing it
  // makes every sealed token undecryptable. lint:forbidden guards it.
  return Buffer.from(hkdfSync('sha256', Buffer.from(master, 'utf8'), salt, Buffer.from('mobrain-kek-v1'), 32));
}

function encrypt(key: Buffer, plain: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv(ALG, key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

function decrypt(key: Buffer, blob: string): Buffer {
  const raw = Buffer.from(blob, 'base64');
  const d = createDecipheriv(ALG, key, raw.subarray(0, IV_LEN));
  d.setAuthTag(raw.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([d.update(raw.subarray(IV_LEN + TAG_LEN)), d.final()]);
}

/** Envelope seal: a random DEK encrypts the text; a per-value KEK wraps the DEK. */
export function seal(master: string, plaintext: string): string {
  const salt = randomBytes(16);
  const dek = randomBytes(32);
  return ['v1', salt.toString('base64'), encrypt(kek(master, salt), dek), encrypt(dek, Buffer.from(plaintext, 'utf8'))].join(':');
}

export function open(master: string, sealed: string): string {
  const [v, salt, wrapped, payload] = sealed.split(':');
  if (v !== 'v1' || !salt || !wrapped || !payload) throw new Error('not a sealed value');
  const dek = decrypt(kek(master, Buffer.from(salt, 'base64')), wrapped);
  return decrypt(dek, payload).toString('utf8');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
```

- [ ] **Step 3: Run** — `bun test test/unit/crypto.test.ts` — Expected: PASS. Also `bun run lint:forbidden` — clean.

- [ ] **Step 4: Commit**

```bash
git add src/server/crypto.ts test/unit/crypto.test.ts
git commit -m "feat(server): envelope sealing for stored client tokens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3.4: gbrain CLI runner

**Files:**
- Create: `src/server/gbrain/cli.ts`
- Test: `test/unit/gbrain-cli.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

Run: `bun test test/unit/gbrain-cli.test.ts` — Expected: FAIL.

- [ ] **Step 2: Write `src/server/gbrain/cli.ts`**

```ts
export type CliResult = { exitCode: number; stdout: string; stderr: string };

/** Run gbrain with an argv array. Never a shell string. */
export async function runGbrain(
  argv: string[],
  opts: { timeoutMs?: number; env?: Record<string, string>; bin?: string } = {},
): Promise<CliResult> {
  const proc = Bun.spawn([opts.bin ?? process.env.GBRAIN_BIN ?? 'gbrain', ...argv], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...opts.env },
  });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 120_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

const R = '[REDACTED]';

export function scrub(text: string): string {
  return text
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, `$1${R}@`)
    .replace(/("?(?:client_secret|access_token|refresh_token|token)"?\s*[:=]\s*"?)[^",\s]+/gi, `$1${R}`)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, `$1${R}`)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, R);
}

/** The last balanced top-level JSON object or array in stdout, or null. */
export function lastJson(stdout: string): unknown {
  for (let end = stdout.length - 1; end >= 0; end--) {
    const close = stdout[end];
    if (close !== '}' && close !== ']') continue;
    const open = close === '}' ? '{' : '[';
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      if (stdout[i] === close) depth++;
      else if (stdout[i] === open) depth--;
      if (depth === 0) {
        try { return JSON.parse(stdout.slice(i, end + 1)); } catch { break; }
      }
    }
  }
  return null;
}

/** Throw a scrubbed error unless the exit code is 0. */
export function assertOk(label: string, r: CliResult): CliResult {
  if (r.exitCode !== 0) throw new Error(`${label} exited ${r.exitCode}: ${scrub(r.stderr || r.stdout).slice(0, 800)}`);
  return r;
}
```

- [ ] **Step 3: Run** — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/gbrain/cli.ts test/unit/gbrain-cli.test.ts
git commit -m "feat(server): argv-only gbrain CLI runner with output scrubbing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3.5: gbrain MCP caller

**Files:**
- Create: `src/server/gbrain/mcp.ts` (parsers ported from `v1-final:src/ops/mcpLane.ts`)
- Test: `test/unit/gbrain-mcp.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/gbrain-mcp.test.ts
import { describe, expect, test } from 'bun:test';
import { McpError, mcpCaller } from '../../src/server/gbrain/mcp.ts';

function fakeFetch(reply: { status?: number; body: string; type?: string }, seen: Request[] = []) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(input, init));
    return new Response(reply.body, { status: reply.status ?? 200, headers: { 'content-type': reply.type ?? 'application/json' } });
  }) as typeof fetch;
}
const ok = (payload: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });

describe('mcpCaller', () => {
  test('posts a tools/call with the bearer and returns the parsed tool JSON', async () => {
    const seen: Request[] = [];
    const call = mcpCaller('http://gbrain:3131/mcp', 'tok', fakeFetch({ body: ok({ pages: [1] }) }, seen));
    expect(await call('list_pages', { limit: 1 })).toEqual({ pages: [1] });
    const req = seen[0]!;
    expect(req.headers.get('authorization')).toBe('Bearer tok');
    expect(await req.json()).toMatchObject({ method: 'tools/call', params: { name: 'list_pages', arguments: { limit: 1 } } });
  });

  test('reads an SSE-framed reply', async () => {
    const call = mcpCaller('http://x/mcp', 't', fakeFetch({ body: `event: message\ndata: ${ok({ a: 1 })}\n\n`, type: 'text/event-stream' }));
    expect(await call('x', {})).toEqual({ a: 1 });
  });

  test('a 401 is an McpError with status 401', async () => {
    const call = mcpCaller('http://x/mcp', 't', fakeFetch({ status: 401, body: '{}' }));
    await expect(call('x', {})).rejects.toMatchObject({ status: 401 });
  });

  test('an isError tool result is an McpError carrying the text', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'source_not_readable' }] } });
    const call = mcpCaller('http://x/mcp', 't', fakeFetch({ body }));
    const err = await call('get_page', {}).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(String(err.message)).toContain('source_not_readable');
  });

  test('a non-JSON text block is returned as a string', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'plain words' }] } });
    expect(await mcpCaller('http://x/mcp', 't', fakeFetch({ body }))('x', {})).toBe('plain words');
  });
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Write `src/server/gbrain/mcp.ts`**

```ts
export type McpCaller = <T = unknown>(tool: string, args: Record<string, unknown>) => Promise<T>;

export class McpError extends Error {
  constructor(message: string, readonly status: number, readonly tool: string) { super(message); }
}

function parseMessage(text: string, contentType: string): Record<string, unknown> {
  const frames: unknown[] = [];
  if (contentType.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      try { frames.push(JSON.parse(t.slice(5).trim())); } catch { /* not JSON */ }
    }
  } else {
    try { frames.push(JSON.parse(text)); } catch { /* fall through */ }
  }
  for (const f of frames) {
    if (f && typeof f === 'object' && ('result' in f || 'error' in f)) return f as Record<string, unknown>;
  }
  throw new Error('MCP reply carried no JSON-RPC message');
}

export function mcpCaller(url: string, token: string, fetchImpl: typeof fetch = fetch): McpCaller {
  let id = 0;
  return async <T>(tool: string, args: Record<string, unknown>): Promise<T> => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: tool, arguments: args } }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new McpError(`${tool}: HTTP ${res.status}`, res.status, tool);
    const msg = parseMessage(await res.text(), res.headers.get('content-type') ?? '');
    if ('error' in msg) {
      const e = msg.error as { message?: string };
      throw new McpError(`${tool}: ${e?.message ?? 'error'}`, 502, tool);
    }
    const result = msg.result as { isError?: boolean; content?: { type?: string; text?: string }[] };
    const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
    if (result.isError) throw new McpError(`${tool}: ${text}`, 422, tool);
    try { return JSON.parse(text) as T; } catch { return text as T; }
  };
}
```

- [ ] **Step 3: Run** — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/gbrain/mcp.ts test/unit/gbrain-mcp.test.ts
git commit -m "feat(server): stateless gbrain MCP caller

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3.6: gbrain admin adapter

**Files:**
- Create: `src/server/gbrain/admin.ts`
- Create: `test/unit/fakes.ts`
- Test: `test/unit/gbrain-admin.test.ts`

The argv below is what v1 used at 0.60.115 and phase 2 confirmed (or replaced) at 0.60.230. If the probes file records different flags or credential fields, use those.

- [ ] **Step 1: Write the fake used by every later test**

```ts
// test/unit/fakes.ts
import type { GbrainAdmin } from '../../src/server/gbrain/admin.ts';
import type { ClientSpec, IssuedClient } from '../../src/server/types.ts';

export class FakeGbrainAdmin implements GbrainAdmin {
  clients = new Map<string, { spec: ClientSpec; token: string; revoked: boolean }>();
  sources = new Map<string, { name: string; archived: boolean }>();
  calls: string[] = [];
  failNext: string | null = null;
  private n = 0;

  private maybeFail(op: string) {
    this.calls.push(op);
    if (this.failNext === op) { this.failNext = null; throw new Error(`fake ${op} failure`); }
  }
  async createClient(spec: ClientSpec): Promise<IssuedClient> {
    this.maybeFail('createClient');
    const clientId = `c${++this.n}`;
    const token = `tok-${clientId}`;
    this.clients.set(clientId, { spec, token, revoked: false });
    return { clientId, token, expiresAt: new Date(Date.now() + 90 * 86400_000) };
  }
  async rescopeClient(clientId: string, spec: ClientSpec): Promise<void> {
    this.maybeFail('rescopeClient');
    const c = this.clients.get(clientId);
    if (!c) throw new Error(`no client ${clientId}`);
    c.spec = spec;
  }
  async revokeClient(clientId: string): Promise<void> {
    this.maybeFail('revokeClient');
    const c = this.clients.get(clientId);
    if (c) c.revoked = true;
  }
  async addSource(id: string, name: string): Promise<void> {
    this.maybeFail('addSource');
    this.sources.set(id, { name, archived: false });
  }
  async archiveSource(id: string): Promise<void> {
    this.maybeFail('archiveSource');
    const s = this.sources.get(id);
    if (s) s.archived = true;
  }
  /** Live (not revoked) specs for one user, for assertions. */
  live(userId: string | null): ClientSpec[] {
    return [...this.clients.values()].filter((c) => !c.revoked && c.spec.userId === userId).map((c) => c.spec);
  }
}
```

- [ ] **Step 2: Write the failing test**

```ts
// test/unit/gbrain-admin.test.ts
import { describe, expect, test } from 'bun:test';
import { CliGbrainAdmin, grantArgv, parseCredentials, rescopeArgv } from '../../src/server/gbrain/admin.ts';
import type { CliResult } from '../../src/server/gbrain/cli.ts';
import type { ClientSpec } from '../../src/server/types.ts';

const spec: ClientSpec = {
  purpose: 'agent', userId: 'u1', name: 'mb-agent-u1', profile: 'memory-writer',
  writeSource: 'p-ada', readSources: ['c-company', 'c-eng'],
};

describe('argv builders', () => {
  test('grant argv names source, federated read, profile, ttl, credentials file and url', () => {
    expect(grantArgv(spec, '/tmp/c.json', 'https://b.ts.net/mcp')).toEqual([
      'mcp', 'grant', 'mb-agent-u1',
      '--profile', 'memory-writer',
      '--source', 'p-ada',
      '--federated-read', 'c-company,c-eng',
      '--token-ttl', '7776000',
      '--credentials-out', '/tmp/c.json',
      '--url', 'https://b.ts.net/mcp',
      '--json',
    ]);
  });

  test('grant argv omits federated read when empty', () => {
    expect(grantArgv({ ...spec, readSources: [] }, '/tmp/c.json', 'u')).not.toContain('--federated-read');
  });

  test('rescope argv always states federated read, clearing it with an empty value', () => {
    expect(rescopeArgv('cid', { ...spec, readSources: [] })).toEqual([
      'auth', 'rescope-client', 'cid', '--source', 'p-ada', '--profile', 'memory-writer', '--federated-read', '', '--json',
    ]);
  });
});

describe('parseCredentials', () => {
  test('reads token and expiry', () => {
    const c = parseCredentials({ client_id: 'abc', access_token: 'tok', expires_at: '2027-01-01T00:00:00Z' });
    expect(c).toEqual({ clientId: 'abc', token: 'tok', expiresAt: new Date('2027-01-01T00:00:00Z') });
  });
  test('refuses a file without a token', () => {
    expect(() => parseCredentials({ client_id: 'abc' })).toThrow(/token/);
  });
});

describe('CliGbrainAdmin', () => {
  test('createClient grants, reads then deletes the credentials file', async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]): Promise<CliResult> => {
      calls.push(argv);
      const out = argv[argv.indexOf('--credentials-out') + 1]!;
      await Bun.write(out, JSON.stringify({ client_id: 'cid-1', access_token: 'secret', expires_at: '2027-01-01T00:00:00Z' }));
      return { exitCode: 0, stdout: '{"client_id":"cid-1"}', stderr: '' };
    };
    const admin = new CliGbrainAdmin(run, 'http://127.0.0.1:8787');
    const issued = await admin.createClient(spec);
    expect(issued.clientId).toBe('cid-1');
    expect(issued.token).toBe('secret');
    const file = calls[0]![calls[0]!.indexOf('--credentials-out') + 1]!;
    expect(await Bun.file(file).exists()).toBe(false);
  });

  test('a failed grant throws a scrubbed error', async () => {
    const run = async (): Promise<CliResult> => ({ exitCode: 2, stdout: '', stderr: 'bad postgres://g:pw@h/db' });
    const err = await new CliGbrainAdmin(run, 'u').createClient(spec).catch((e) => e);
    expect(String(err)).not.toContain('pw@');
  });
});
```

Run — Expected: FAIL.

- [ ] **Step 3: Write `src/server/gbrain/admin.ts`**

```ts
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { assertOk, runGbrain, type CliResult } from './cli.ts';
import type { ClientSpec, IssuedClient } from '../types.ts';

export interface GbrainAdmin {
  createClient(spec: ClientSpec): Promise<IssuedClient>;
  rescopeClient(clientId: string, spec: ClientSpec): Promise<void>;
  revokeClient(clientId: string): Promise<void>;
  addSource(id: string, name: string): Promise<void>;
  archiveSource(id: string): Promise<void>;
}

/** gbrain caps grant tokens at 90 days (P2). Rotation handles the rest. */
export const CLIENT_TTL_SECONDS = 7_776_000;

type Run = (argv: string[], opts?: { timeoutMs?: number }) => Promise<CliResult>;

export function grantArgv(spec: ClientSpec, credentialsOut: string, mcpUrl: string): string[] {
  const argv = ['mcp', 'grant', spec.name, '--profile', spec.profile, '--source', spec.writeSource];
  if (spec.readSources.length > 0) argv.push('--federated-read', spec.readSources.join(','));
  argv.push('--token-ttl', String(CLIENT_TTL_SECONDS), '--credentials-out', credentialsOut, '--url', mcpUrl, '--json');
  return argv;
}

export function rescopeArgv(clientId: string, spec: ClientSpec): string[] {
  return ['auth', 'rescope-client', clientId, '--source', spec.writeSource, '--profile', spec.profile,
    '--federated-read', spec.readSources.join(','), '--json'];
}

export function parseCredentials(json: unknown): IssuedClient {
  const o = (json ?? {}) as Record<string, unknown>;
  const nested = (o.credentials && typeof o.credentials === 'object' ? o.credentials : {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) for (const src of [o, nested]) if (typeof src[k] === 'string' && src[k]) return src[k] as string;
    return null;
  };
  const token = pick('access_token', 'accessToken', 'token', 'bearer');
  const clientId = pick('client_id', 'clientId');
  if (!token) throw new Error('credentials file has no token');
  if (!clientId) throw new Error('credentials file has no client id');
  const exp = pick('expires_at', 'expiresAt');
  return { clientId, token, expiresAt: exp ? new Date(exp) : null };
}

export class CliGbrainAdmin implements GbrainAdmin {
  constructor(private run: Run = runGbrain, private publicUrl: string) {}

  private mcpUrl(): string {
    return this.publicUrl.endsWith('/mcp') ? this.publicUrl : `${this.publicUrl}/mcp`;
  }

  async createClient(spec: ClientSpec): Promise<IssuedClient> {
    const file = join(tmpdir(), `mb-cred-${crypto.randomUUID()}.json`);
    try {
      assertOk('mcp grant', await this.run(grantArgv(spec, file, this.mcpUrl()), { timeoutMs: 60_000 }));
      return parseCredentials(await Bun.file(file).json());
    } finally {
      await rm(file, { force: true });
    }
  }

  async rescopeClient(clientId: string, spec: ClientSpec): Promise<void> {
    assertOk('auth rescope-client', await this.run(rescopeArgv(clientId, spec)));
  }

  async revokeClient(clientId: string): Promise<void> {
    const r = await this.run(['auth', 'revoke-client', clientId]);
    // Revoking an already-revoked client is success for our purposes.
    if (r.exitCode !== 0 && !/not found|already revoked/i.test(r.stderr + r.stdout)) assertOk('auth revoke-client', r);
  }

  async addSource(id: string, name: string): Promise<void> {
    const r = await this.run(['sources', 'add', id, '--name', name, '--json']);
    if (r.exitCode !== 0 && !/already exists/i.test(r.stderr + r.stdout)) assertOk('sources add', r);
  }

  async archiveSource(id: string): Promise<void> {
    const r = await this.run(['sources', 'archive', id, '--yes']);
    if (r.exitCode !== 0 && !/already archived|not found/i.test(r.stderr + r.stdout)) assertOk('sources archive', r);
  }
}
```

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/gbrain/admin.ts test/unit/fakes.ts test/unit/gbrain-admin.test.ts
git commit -m "feat(server): gbrain admin adapter (grant, rescope, revoke, sources)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3.7: Passwords, sessions, API keys

**Files:**
- Create: `src/server/auth.ts`
- Test: `test/db/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/db/auth.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { freshDb, type Sql } from './helpers.ts';
import {
  createApiKey, createSession, deleteSession, hashPassword, loginWithPassword,
  userForApiKey, userForSession, LoginThrottle,
} from '../../src/server/auth.ts';

let sql: Sql; let drop: () => Promise<void>; let userId: string;
beforeAll(async () => {
  ({ sql, drop } = await freshDb());
  const [u] = await sql<{ id: string }[]>`insert into users (email, role, status, password_hash)
    values ('Ada@X.io', 'owner', 'active', ${await hashPassword('correct horse')}) returning id`;
  userId = u!.id;
});
afterAll(async () => drop());

describe('password login', () => {
  test('accepts the right password, case-insensitive email', async () => {
    const u = await loginWithPassword(sql, 'ada@x.io', 'correct horse');
    expect(u?.id).toBe(userId);
  });
  test('rejects a wrong password', async () => {
    expect(await loginWithPassword(sql, 'ada@x.io', 'nope')).toBeNull();
  });
  test('rejects a disabled user', async () => {
    await sql`update users set status = 'disabled' where id = ${userId}`;
    expect(await loginWithPassword(sql, 'ada@x.io', 'correct horse')).toBeNull();
    await sql`update users set status = 'active' where id = ${userId}`;
  });
});

describe('sessions', () => {
  test('create, look up, delete', async () => {
    const token = await createSession(sql, userId, new Date());
    expect((await userForSession(sql, token, new Date()))?.id).toBe(userId);
    await deleteSession(sql, token);
    expect(await userForSession(sql, token, new Date())).toBeNull();
  });
  test('an expired session is not valid', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const token = await createSession(sql, userId, t0);
    expect(await userForSession(sql, token, new Date('2026-03-01T00:00:00Z'))).toBeNull();
  });
  test('only the hash is stored', async () => {
    const token = await createSession(sql, userId, new Date());
    const rows = await sql`select id_hash from sessions`;
    expect(rows.some((r) => r.idHash === token)).toBe(false);
  });
});

describe('api keys', () => {
  test('create and resolve; revoked keys do not resolve', async () => {
    const key = await createApiKey(sql, userId, 'cli');
    expect(key.startsWith('mbk_')).toBe(true);
    expect((await userForApiKey(sql, key))?.id).toBe(userId);
    await sql`update api_keys set revoked_at = now()`;
    expect(await userForApiKey(sql, key)).toBeNull();
  });
});

describe('LoginThrottle', () => {
  test('locks an email after 10 failures in 15 minutes', () => {
    const t = new LoginThrottle();
    const now = Date.now();
    for (let i = 0; i < 10; i++) t.fail('a@x.io', now);
    expect(t.locked('a@x.io', now)).toBe(true);
    expect(t.locked('a@x.io', now + 16 * 60_000)).toBe(false);
  });
});
```

Run: `bun run test:db` — Expected: FAIL.

- [ ] **Step 2: Write `src/server/auth.ts`**

```ts
import type { Sql } from './db/index.ts';
import { newToken, sha256Hex } from './crypto.ts';
import type { User } from './types.ts';

const SESSION_DAYS = 30;

export const hashPassword = (pw: string) => Bun.password.hash(pw, { algorithm: 'argon2id' });

export async function loginWithPassword(sql: Sql, email: string, password: string): Promise<User | null> {
  const [row] = await sql<(User & { passwordHash: string | null })[]>`
    select id, email, name, role, status, created_at, password_hash from users where email = ${email}`;
  if (!row || row.status !== 'active' || !row.passwordHash) return null;
  if (!(await Bun.password.verify(password, row.passwordHash))) return null;
  const { passwordHash: _, ...user } = row;
  return user;
}

export async function createSession(sql: Sql, userId: string, now: Date): Promise<string> {
  const token = newToken();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400_000);
  await sql`insert into sessions (id_hash, user_id, expires_at) values (${sha256Hex(token)}, ${userId}, ${expires})`;
  return token;
}

export async function userForSession(sql: Sql, token: string, now: Date): Promise<User | null> {
  const [row] = await sql<User[]>`
    select u.id, u.email, u.name, u.role, u.status, u.created_at
    from sessions s join users u on u.id = s.user_id
    where s.id_hash = ${sha256Hex(token)} and s.expires_at > ${now} and u.status = 'active'`;
  return row ?? null;
}

export async function deleteSession(sql: Sql, token: string): Promise<void> {
  await sql`delete from sessions where id_hash = ${sha256Hex(token)}`;
}

export async function createApiKey(sql: Sql, userId: string, label: string): Promise<string> {
  const key = `mbk_${newToken()}`;
  await sql`insert into api_keys (key_hash, user_id, label) values (${sha256Hex(key)}, ${userId}, ${label})`;
  return key;
}

export async function userForApiKey(sql: Sql, key: string): Promise<User | null> {
  const [row] = await sql<User[]>`
    select u.id, u.email, u.name, u.role, u.status, u.created_at
    from api_keys k join users u on u.id = k.user_id
    where k.key_hash = ${sha256Hex(key)} and k.revoked_at is null and u.status = 'active'`;
  return row ?? null;
}

/** In-memory failed-login counter: 10 failures per email per 15 minutes. */
export class LoginThrottle {
  private fails = new Map<string, number[]>();
  private window = 15 * 60_000;
  fail(email: string, now: number) {
    const k = email.toLowerCase();
    this.fails.set(k, [...(this.fails.get(k) ?? []).filter((t) => now - t < this.window), now]);
  }
  locked(email: string, now: number): boolean {
    return (this.fails.get(email.toLowerCase()) ?? []).filter((t) => now - t < this.window).length >= 10;
  }
  clear(email: string) { this.fails.delete(email.toLowerCase()); }
}
```

- [ ] **Step 3: Run** — `bun run test:db` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/auth.ts test/db/auth.test.ts
git commit -m "feat(server): argon2id passwords, hashed sessions and API keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3.8: HTTP errors, authentication middleware, role guard

**Files:**
- Create: `src/server/http.ts`
- Test: `test/unit/http.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/http.test.ts
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { HttpError, onError, requireRole, type AppEnv } from '../../src/server/http.ts';
import type { User } from '../../src/server/types.ts';

const user = (role: User['role']): User => ({ id: 'u', email: 'a@x.io', name: null, role, status: 'active', createdAt: new Date() });

function app(u: User | null) {
  const a = new Hono<AppEnv>();
  a.onError(onError);
  a.use('*', async (c, next) => { c.set('user', u); await next(); });
  a.get('/admins', requireRole('owner', 'admin'), (c) => c.json({ ok: true }));
  a.get('/boom', () => { throw new HttpError(409, 'conflict_thing', { a: 1 }); });
  return a;
}

describe('requireRole', () => {
  test('401 without a user', async () => {
    const r = await app(null).request('/admins');
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'unauthenticated' });
  });
  test('403 for a member', async () => {
    expect((await app(user('member')).request('/admins')).status).toBe(403);
  });
  test('200 for an admin', async () => {
    expect((await app(user('admin')).request('/admins')).status).toBe(200);
  });
});

describe('onError', () => {
  test('renders an HttpError as JSON with its code and detail', async () => {
    const r = await app(null).request('/boom');
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'conflict_thing', detail: { a: 1 } });
  });
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Write `src/server/http.ts`**

```ts
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Role, User } from './types.ts';
import type { Sql } from './db/index.ts';
import { userForApiKey, userForSession } from './auth.ts';
import { scrub } from './gbrain/cli.ts';

export type AppEnv = { Variables: { user: User | null } };

export const SESSION_COOKIE = 'mobrain_session';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail?: unknown) { super(code); }
}

export function onError(err: Error, c: Context): Response {
  if (err instanceof HttpError) {
    const body: Record<string, unknown> = { error: err.code };
    if (err.detail !== undefined) body.detail = err.detail;
    return c.json(body, err.status as 400);
  }
  console.error(scrub(String(err.stack ?? err)));
  return c.json({ error: 'internal' }, 500);
}

/** Resolve the caller from the session cookie or a Bearer API key. */
export function authenticate(sql: Sql, now: () => Date): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    let user: User | null = null;
    const auth = c.req.header('authorization');
    if (auth?.startsWith('Bearer mbk_')) user = await userForApiKey(sql, auth.slice(7));
    else {
      const token = getCookie(c, SESSION_COOKIE);
      if (token) user = await userForSession(sql, token, now());
    }
    c.set('user', user);
    await next();
  };
}

export function requireUser(c: Context<AppEnv>): User {
  const u = c.get('user');
  if (!u) throw new HttpError(401, 'unauthenticated');
  return u;
}

export function requireRole(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const u = requireUser(c);
    if (!roles.includes(u.role)) throw new HttpError(403, 'forbidden');
    await next();
  };
}

export async function jsonBody<T>(c: Context): Promise<T> {
  try { return (await c.req.json()) as T; } catch { throw new HttpError(400, 'invalid_json'); }
}
```

- [ ] **Step 3: Run** — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/http.ts test/unit/http.test.ts
git commit -m "feat(server): HTTP errors, caller resolution, role guard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3.9: App, auth routes, health, proxy, main

**Files:**
- Create: `src/server/app.ts`
- Create: `src/server/routes/auth.ts`
- Create: `src/server/routes/health.ts`
- Create: `src/server/routes/proxy.ts`
- Create: `src/server/main.ts`
- Create: `test/db/app.ts` (helper building an app over a fresh DB with fakes)
- Test: `test/db/routes-auth.test.ts`, `test/unit/proxy.test.ts`

- [ ] **Step 1: Write the test app helper**

```ts
// test/db/app.ts
import { createApp, type Deps } from '../../src/server/app.ts';
import { FakeGbrainAdmin } from '../unit/fakes.ts';
import { freshDb } from './helpers.ts';
import type { McpCaller } from '../../src/server/gbrain/mcp.ts';
import type { CliResult } from '../../src/server/gbrain/cli.ts';

export type TestWorld = Awaited<ReturnType<typeof world>>;

/** A full app over a fresh DB, a fake gbrain admin, a scriptable MCP and CLI. */
export async function world(opts: { mcp?: (token: string) => McpCaller; cli?: (argv: string[]) => Promise<CliResult> } = {}) {
  const { sql, drop } = await freshDb();
  const admin = new FakeGbrainAdmin();
  let clock = new Date('2026-10-14T12:00:00Z');
  const deps: Deps = {
    sql,
    env: {
      port: 0, databaseUrl: '', gbrainUrl: 'http://gbrain.test', publicUrl: 'http://127.0.0.1:8787',
      encryptionKey: 'e'.repeat(44), gbrainVersion: '0.60.230.0', uiDir: '/nonexistent', secureCookies: false,
    },
    admin,
    mcp: opts.mcp ?? (() => (async () => ({})) as McpCaller),
    cli: (opts.cli ?? (async () => ({ exitCode: 0, stdout: 'gbrain 0.60.230.0\n', stderr: '' }))) as Deps['cli'],
    fetch: (async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
    now: () => clock,
  };
  const app = createApp(deps);
  return {
    sql, admin, app, deps, drop,
    setNow: (d: Date) => { clock = d; },
    /** Request helper that carries a session cookie or API key. */
    req: (path: string, init: RequestInit & { as?: string } = {}) => {
      const headers = new Headers(init.headers);
      if (init.as?.startsWith('mbk_')) headers.set('authorization', `Bearer ${init.as}`);
      else if (init.as) headers.set('cookie', `mobrain_session=${init.as}`);
      if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
      return app.request(path, { ...init, headers });
    },
  };
}
```

- [ ] **Step 2: Write the failing route test**

```ts
// test/db/routes-auth.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { hashPassword } from '../../src/server/auth.ts';

let w: TestWorld;
beforeAll(async () => {
  w = await world();
  await w.sql`insert into users (email, role, status, password_hash) values ('ada@x.io', 'owner', 'active', ${await hashPassword('pw-123456')})`;
});
afterAll(async () => w.drop());

describe('auth routes', () => {
  test('login sets an HttpOnly session cookie and /api/me returns the user', async () => {
    const r = await w.req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'ada@x.io', password: 'pw-123456' }) });
    expect(r.status).toBe(200);
    const cookie = r.headers.get('set-cookie')!;
    expect(cookie).toContain('mobrain_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    const token = /mobrain_session=([^;]+)/.exec(cookie)![1]!;
    const me = await (await w.req('/api/me', { as: token })).json();
    expect(me).toMatchObject({ user: { email: 'ada@x.io', role: 'owner' }, mode: 'personal' });
  });

  test('a wrong password is 401 with a generic error', async () => {
    const r = await w.req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'ada@x.io', password: 'x' }) });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'invalid_credentials' });
  });

  test('/api/me without a session is 401', async () => {
    expect((await w.req('/api/me')).status).toBe(401);
  });

  test('logout clears the session', async () => {
    const r = await w.req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'ada@x.io', password: 'pw-123456' }) });
    const token = /mobrain_session=([^;]+)/.exec(r.headers.get('set-cookie')!)![1]!;
    await w.req('/api/auth/logout', { method: 'POST', as: token });
    expect((await w.req('/api/me', { as: token })).status).toBe(401);
  });
});

describe('health', () => {
  test('public health reports ok and the pin match without auth', async () => {
    const r = await w.req('/api/health');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, db: true, pin: { expected: '0.60.230.0', running: '0.60.230.0', matches: true } });
  });
});
```

- [ ] **Step 3: Write the failing proxy test**

```ts
// test/unit/proxy.test.ts
import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { proxyRoutes, PROXIED } from '../../src/server/routes/proxy.ts';

test('forwards MCP and OAuth paths to gbrain with method, body, auth and forwarded headers', async () => {
  const seen: Request[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(input, init));
    return new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const app = new Hono();
  app.route('/', proxyRoutes('http://gbrain:3131', fetchImpl));
  const r = await app.request('http://127.0.0.1:8787/mcp?x=1', {
    method: 'POST', body: '{"a":1}', headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
  });
  expect(r.status).toBe(200);
  const req = seen[0]!;
  expect(req.url).toBe('http://gbrain:3131/mcp?x=1');
  expect(req.method).toBe('POST');
  expect(req.headers.get('authorization')).toBe('Bearer t');
  expect(req.headers.get('x-forwarded-host')).toBe('127.0.0.1:8787');
  expect(await req.text()).toBe('{"a":1}');
  expect(PROXIED).toContain('/.well-known/*');
  expect(PROXIED).not.toContain('/admin');
});
```

Run: `bun run test:db && bun test test/unit/proxy.test.ts` — Expected: FAIL.

- [ ] **Step 4: Write `src/server/routes/proxy.ts`**

```ts
import { Hono } from 'hono';

/** Paths served by gbrain. gbrain's /admin dashboard is deliberately absent. */
export const PROXIED = ['/mcp', '/mcp/*', '/authorize', '/token', '/register', '/revoke', '/.well-known/*', '/health'];

export function proxyRoutes(gbrainUrl: string, fetchImpl: typeof fetch = fetch): Hono {
  const r = new Hono();
  const handler = async (c: import('hono').Context) => {
    const url = new URL(c.req.url);
    const headers = new Headers(c.req.raw.headers);
    headers.delete('host');
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
    const hasBody = !['GET', 'HEAD'].includes(c.req.method);
    const res = await fetchImpl(`${gbrainUrl}${url.pathname}${url.search}`, {
      method: c.req.method,
      headers,
      body: hasBody ? await c.req.raw.arrayBuffer() : undefined,
      redirect: 'manual',
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  };
  for (const p of PROXIED) r.all(p, handler);
  return r;
}
```

(The body is buffered, not streamed: MCP requests are small, and buffering avoids Bun's half-duplex request-stream caveats. Responses stream.)

- [ ] **Step 5: Write `src/server/routes/auth.ts`**

```ts
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createSession, deleteSession, LoginThrottle, loginWithPassword } from '../auth.ts';
import { getMode } from '../db/index.ts';
import { HttpError, jsonBody, requireUser, SESSION_COOKIE, type AppEnv } from '../http.ts';
import type { Deps } from '../app.ts';

export function authRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const throttle = new LoginThrottle();

  r.post('/api/auth/login', async (c) => {
    const { email, password } = await jsonBody<{ email?: string; password?: string }>(c);
    if (!email || !password) throw new HttpError(400, 'email_and_password_required');
    const now = deps.now();
    if (throttle.locked(email, now.getTime())) throw new HttpError(429, 'too_many_attempts');
    const user = await loginWithPassword(deps.sql, email, password);
    if (!user) { throttle.fail(email, now.getTime()); throw new HttpError(401, 'invalid_credentials'); }
    throttle.clear(email);
    const token = await createSession(deps.sql, user.id, now);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'Lax', secure: deps.env.secureCookies, path: '/', maxAge: 30 * 86400,
    });
    return c.json({ user });
  });

  r.post('/api/auth/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await deleteSession(deps.sql, token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  r.get('/api/me', async (c) => {
    const user = requireUser(c);
    return c.json({ user, mode: await getMode(deps.sql) });
  });

  return r;
}
```

- [ ] **Step 6: Write `src/server/routes/health.ts`**

```ts
import { Hono } from 'hono';
import type { AppEnv } from '../http.ts';
import type { Deps } from '../app.ts';

/** Unauthenticated liveness: DB reachable, gbrain reachable, pin matches. */
export function healthRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get('/api/health', async (c) => {
    const db = await deps.sql`select 1`.then(() => true, () => false);
    const v = await deps.cli(['--version'], { timeoutMs: 10_000 });
    const running = v.exitCode === 0 ? v.stdout.trim().split(/\s+/).pop() ?? null : null;
    const gbrain = await deps.fetch(`${deps.env.gbrainUrl}/health`, { signal: AbortSignal.timeout(5000) })
      .then((x) => x.ok, () => false);
    const pin = { expected: deps.env.gbrainVersion, running, matches: running === deps.env.gbrainVersion };
    const ok = db && gbrain && pin.matches;
    return c.json({ ok, db, gbrain, pin }, ok ? 200 : 503);
  });
  return r;
}
```

- [ ] **Step 7: Write `src/server/app.ts`**

```ts
import { Hono } from 'hono';
import type { Sql } from './db/index.ts';
import type { Env } from './env.ts';
import type { GbrainAdmin } from './gbrain/admin.ts';
import type { McpCaller } from './gbrain/mcp.ts';
import type { runGbrain } from './gbrain/cli.ts';
import { authenticate, onError, type AppEnv } from './http.ts';
import { authRoutes } from './routes/auth.ts';
import { healthRoutes } from './routes/health.ts';
import { proxyRoutes } from './routes/proxy.ts';

export type Deps = {
  sql: Sql;
  env: Env;
  admin: GbrainAdmin;
  mcp: (token: string) => McpCaller;
  cli: typeof runGbrain;
  fetch: typeof fetch;
  now: () => Date;
};

export function createApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.route('/', proxyRoutes(deps.env.gbrainUrl, deps.fetch));
  app.use('/api/*', authenticate(deps.sql, deps.now));
  app.route('/', healthRoutes(deps));
  app.route('/', authRoutes(deps));
  return app;
}
```

Later phases add their routers to `createApp` in the order: people, clients, sources and pages, collectors and runner, schema, activity, install assets, static UI (last).

- [ ] **Step 8: Write `src/server/main.ts`**

```ts
import { createApp } from './app.ts';
import { connect } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { loadEnv } from './env.ts';
import { CliGbrainAdmin } from './gbrain/admin.ts';
import { runGbrain } from './gbrain/cli.ts';
import { mcpCaller } from './gbrain/mcp.ts';

const env = loadEnv();
const sql = connect(env.databaseUrl);
const applied = await migrate(sql);
if (applied.length) console.log(`migrations applied: ${applied.join(', ')}`);

const app = createApp({
  sql,
  env,
  admin: new CliGbrainAdmin(runGbrain, env.publicUrl),
  mcp: (token) => mcpCaller(`${env.gbrainUrl}/mcp`, token),
  cli: runGbrain,
  fetch,
  now: () => new Date(),
});

export default { port: env.port, fetch: app.fetch, idleTimeout: 120 };
console.log(`mobrain listening on :${env.port}`);
```

- [ ] **Step 9: Run** — `bun run test:db && bun test test/unit/proxy.test.ts` — Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/server test/db test/unit/proxy.test.ts
git commit -m "feat(server): app wiring, login/logout/me, health, gbrain proxy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3.10: The `mobrain` image and compose service

**Files:**
- Create: `docker/mobrain.Dockerfile`
- Create: `.dockerignore`
- Modify: `compose/docker-compose.yml` (add `mobrain`)

- [ ] **Step 1: Write `.dockerignore`**

```
node_modules
dist
.git
.env
.env.*
.superpowers
.worktrees
docs/archive
```

- [ ] **Step 2: Write `docker/mobrain.Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
# Built FROM the pinned gbrain image so the server can run gbrain's CLI.
# bin/mobrain builds the gbrain image first; compose builds are not ordered.
ARG GBRAIN_VERSION
FROM mobrain-gbrain:${GBRAIN_VERSION}

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src/server src/server
COPY packs packs
COPY skills skills
COPY bin bin

ENV PORT=3000 MOBRAIN_UI_DIR=/app/dist/ui
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --retries=30 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:3000/api/health'); process.exit(r.status < 500 ? 0 : 1)"
CMD ["bun", "src/server/main.ts"]
```

- [ ] **Step 3: Add the service to `compose/docker-compose.yml`** (under `services:`, after `autopilot`)

```yaml
  mobrain:
    image: mobrain-app:${GBRAIN_VERSION:?required}
    build:
      context: ..
      dockerfile: docker/mobrain.Dockerfile
      args:
        GBRAIN_VERSION: ${GBRAIN_VERSION:?required}
    restart: unless-stopped
    environment:
      <<: *gbrain-env
      DATABASE_URL: postgres://mobrain:${POSTGRES_PASSWORD:?required}@postgres:5432/mobrain
      GBRAIN_URL: http://gbrain:3131
      GBRAIN_VERSION: ${GBRAIN_VERSION:?required}
      MOBRAIN_PUBLIC_URL: ${MOBRAIN_PUBLIC_URL:-http://127.0.0.1:8787}
      ENCRYPTION_KEY: ${ENCRYPTION_KEY:?required}
    ports:
      - "127.0.0.1:${MOBRAIN_PORT:-8787}:3000"
    volumes:
      - gbrain-home:/srv/gbrain-home:ro
    depends_on:
      postgres: { condition: service_healthy }
      gbrain: { condition: service_healthy }
    mem_limit: 512m
    networks: [internal]
```

If probe P5 recorded that sources need a path under `GBRAIN_HOME`, drop `:ro` here and say so in a comment.

- [ ] **Step 4: Build and start on dev, check health**

```bash
cd ~/MO-BRAIN
dc() { docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml "$@"; }
dc build gbrain && dc build mobrain
dc up -d --wait
curl -s http://127.0.0.1:8788/api/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/.well-known/oauth-authorization-server
dc down
```

Expected: health JSON with `"ok":true` and `"matches":true`; the well-known path answers from gbrain (200, or whatever gbrain returns; not the Hono 404 `{"error":...}` page).

- [ ] **Step 5: Run every suite** — `bun run lint:forbidden && bun run typecheck && bun run test:unit && bun run test:db` — Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add docker/mobrain.Dockerfile .dockerignore compose/docker-compose.yml
git commit -m "build: mobrain service image and compose service

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
