# Phase 5: Schema lock, schema view, admin health

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Read `00-master.md` first.

**Goal:** The core lock check (spec §6.3), the read-only schema view the UI renders (§6.4), and the owner/admin health view that includes the lock (§9.1 Health). Pack installation and editing are host operations in `bin/mobrain` (phase 7).

**Spec sections:** §6, §9.1.

**Where the pack files are, inside the `mobrain` container:** shipped copies at `/app/packs/` (with `SHA256SUMS`); installed copies at `$GBRAIN_HOME/.gbrain/schema-packs/<name>/pack.json` (`/srv/gbrain-home` is mounted read-only). Both paths come from `PACKS_DIR` (default `/app/packs`) and `GBRAIN_HOME` (default `/srv/gbrain-home`) so tests can point them at temp dirs.

---

### Task 5.1: The core lock check

**Files:**
- Create: `src/server/schema/coreLock.ts`
- Test: `test/unit/coreLock.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/coreLock.test.ts
import { describe, expect, test } from 'bun:test';
import { checkCoreLock, type PackFile } from '../../src/server/schema/coreLock.ts';

const core: PackFile = {
  name: 'mobrain-core', version: '1.1.0', extends: null,
  page_types: [{ name: 'person', primitive: 'entity', path_prefixes: ['people/'], aliases: ['human'] }],
  link_types: [{ name: 'mentions' }],
};
const personal: PackFile = {
  name: 'mobrain-personal', version: '2.0.0', extends: 'mobrain-core',
  page_types: [{ name: 'journal', primitive: 'temporal', path_prefixes: ['journal/'], aliases: [] }],
  link_types: [{ name: 'works_at' }],
};
const brain = (over: Partial<PackFile> = {}): PackFile => ({
  name: 'mobrain-brain', version: '1.0.0', extends: 'mobrain-personal', page_types: [], link_types: [], ...over,
});
const hashes = { 'mobrain-core.json': 'aa', 'mobrain-personal.json': 'bb' };
const base = { active: 'mobrain-brain', core, personal, brain: brain(), installedHashes: hashes, expectedHashes: hashes };

describe('checkCoreLock', () => {
  test('passes an intact chain with a new type', () => {
    const r = checkCoreLock({ ...base, brain: brain({ page_types: [{ name: 'deal', primitive: 'entity', path_prefixes: ['deals/'], aliases: [] }] }) });
    expect(r).toEqual({ ok: true, problems: [] });
  });

  test('flags a modified shipped pack', () => {
    const r = checkCoreLock({ ...base, installedHashes: { ...hashes, 'mobrain-core.json': 'zz' } });
    expect(r.problems).toContain('pack_modified:mobrain-core.json');
  });

  test('flags a type, alias, prefix or link type that shadows core or personal', () => {
    const r = checkCoreLock({ ...base, brain: brain({
      page_types: [
        { name: 'person', primitive: 'entity', path_prefixes: ['x/'], aliases: [] },
        { name: 'diary', primitive: 'temporal', path_prefixes: ['journal/'], aliases: ['human'] },
      ],
      link_types: [{ name: 'works_at' }],
    }) });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(expect.arrayContaining([
      'shadowed_type:person', 'shadowed_prefix:journal/', 'shadowed_alias:human', 'shadowed_link_type:works_at',
    ]));
  });

  test('flags the wrong active pack and a broken chain', () => {
    expect(checkCoreLock({ ...base, active: 'gbrain-base' }).problems).toContain('active_pack:gbrain-base');
    expect(checkCoreLock({ ...base, brain: brain({ extends: 'mobrain-core' }) }).problems).toContain('chain:mobrain-brain->mobrain-core');
    expect(checkCoreLock({ ...base, personal: { ...personal, extends: null } }).problems).toContain('chain:mobrain-personal->none');
  });

  test('a missing installed pack is reported, not thrown', () => {
    expect(checkCoreLock({ ...base, brain: null }).problems).toContain('missing_pack:mobrain-brain');
  });
});
```

Run: `bun test test/unit/coreLock.test.ts` — Expected: FAIL.

- [ ] **Step 2: Write `src/server/schema/coreLock.ts`**

```ts
export type PackFile = {
  name: string;
  version: string;
  extends: string | null;
  page_types: { name: string; primitive: string; path_prefixes?: string[]; aliases?: string[] }[];
  link_types?: { name: string }[];
};

export type CoreLockInput = {
  active: string | null;
  core: PackFile | null;
  personal: PackFile | null;
  brain: PackFile | null;
  installedHashes: Record<string, string | null>;
  expectedHashes: Record<string, string>;
};

export type CoreLockResult = { ok: boolean; problems: string[] };

/** Spec §6.3. Pure: the caller reads files and gbrain; this only judges. */
export function checkCoreLock(i: CoreLockInput): CoreLockResult {
  const problems: string[] = [];
  for (const [file, want] of Object.entries(i.expectedHashes)) {
    if (i.installedHashes[file] !== want) problems.push(`pack_modified:${file}`);
  }
  if (i.active !== 'mobrain-brain') problems.push(`active_pack:${i.active ?? 'none'}`);
  for (const [name, p] of [['mobrain-core', i.core], ['mobrain-personal', i.personal], ['mobrain-brain', i.brain]] as const) {
    if (!p) problems.push(`missing_pack:${name}`);
  }
  if (i.brain && i.brain.extends !== 'mobrain-personal') problems.push(`chain:mobrain-brain->${i.brain.extends ?? 'none'}`);
  if (i.personal && i.personal.extends !== 'mobrain-core') problems.push(`chain:mobrain-personal->${i.personal.extends ?? 'none'}`);

  if (i.brain) {
    const locked = [i.core, i.personal].filter((p): p is PackFile => p !== null);
    const types = new Set(locked.flatMap((p) => p.page_types.map((t) => t.name)));
    const aliases = new Set(locked.flatMap((p) => p.page_types.flatMap((t) => t.aliases ?? [])));
    const prefixes = new Set(locked.flatMap((p) => p.page_types.flatMap((t) => t.path_prefixes ?? [])));
    const links = new Set(locked.flatMap((p) => (p.link_types ?? []).map((l) => l.name)));
    for (const t of i.brain.page_types) {
      if (types.has(t.name)) problems.push(`shadowed_type:${t.name}`);
      for (const a of t.aliases ?? []) if (aliases.has(a) || types.has(a)) problems.push(`shadowed_alias:${a}`);
      for (const p of t.path_prefixes ?? []) if (prefixes.has(p)) problems.push(`shadowed_prefix:${p}`);
    }
    for (const l of i.brain.link_types ?? []) if (links.has(l.name)) problems.push(`shadowed_link_type:${l.name}`);
  }
  return { ok: problems.length === 0, problems };
}
```

- [ ] **Step 3: Run** — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/schema/coreLock.ts test/unit/coreLock.test.ts
git commit -m "feat(schema): core lock check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5.2: Reading packs from disk and the schema view

**Files:**
- Create: `src/server/schema/service.ts`
- Test: `test/unit/schema-service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/schema-service.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSchemaView, readLockInput } from '../../src/server/schema/service.ts';

let home: string; const packs = join(import.meta.dir, '..', '..', 'packs');
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'mb-home-'));
  for (const [name, file] of [['mobrain-core', 'mobrain-core.json'], ['mobrain-personal', 'mobrain-personal.json'], ['mobrain-brain', 'mobrain-brain.template.json']]) {
    await mkdir(join(home, '.gbrain', 'schema-packs', name!), { recursive: true });
    await cp(join(packs, file!), join(home, '.gbrain', 'schema-packs', name!, 'pack.json'));
  }
});
afterAll(async () => rm(home, { recursive: true, force: true }));

const activeCli = async () => ({ exitCode: 0, stdout: '{"name":"mobrain-brain","version":"1.0.0"}', stderr: '' });

describe('schema service', () => {
  test('a fresh install passes the lock', async () => {
    const input = await readLockInput({ packsDir: packs, gbrainHome: home, cli: activeCli });
    const { checkCoreLock } = await import('../../src/server/schema/coreLock.ts');
    expect(checkCoreLock(input)).toEqual({ ok: true, problems: [] });
  });

  test('a brain type that shadows core fails the lock', async () => {
    const p = join(home, '.gbrain', 'schema-packs', 'mobrain-brain', 'pack.json');
    const brain = await Bun.file(p).json();
    brain.page_types = [{ name: 'person', primitive: 'entity', path_prefixes: ['p2/'], aliases: [] }];
    await writeFile(p, JSON.stringify(brain));
    const view = await buildSchemaView({ packsDir: packs, gbrainHome: home, cli: activeCli, stats: null, orphans: null });
    expect(view.coreLock.ok).toBe(false);
    brain.page_types = [];
    await writeFile(p, JSON.stringify(brain));
  });

  test('the view labels each type with the layer that defines it', async () => {
    const view = await buildSchemaView({ packsDir: packs, gbrainHome: home, cli: activeCli, stats: { person: 3 }, orphans: [] });
    const person = view.types.find((t) => t.name === 'person')!;
    expect(person.layer).toBe('core');
    expect(person.count).toBe(3);
    expect(view.types.find((t) => t.name === 'journal')!.layer).toBe('personal');
    expect(view.types.find((t) => t.name === 'collector')!.prefixes).toEqual(['system/collectors/']);
    expect(view.active).toBe('mobrain-brain');
  });
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Write `src/server/schema/service.ts`**

```ts
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { lastJson, type CliResult } from '../gbrain/cli.ts';
import { checkCoreLock, type CoreLockInput, type CoreLockResult, type PackFile } from './coreLock.ts';

type Cli = (argv: string[], opts?: { timeoutMs?: number }) => Promise<CliResult>;
export type SchemaPaths = { packsDir: string; gbrainHome: string; cli: Cli };

const LAYERS = [['core', 'mobrain-core', 'mobrain-core.json'], ['personal', 'mobrain-personal', 'mobrain-personal.json'], ['brain', 'mobrain-brain', null]] as const;

async function readJson(path: string): Promise<{ text: string; json: unknown } | null> {
  const f = Bun.file(path);
  if (!(await f.exists())) return null;
  const text = await f.text();
  try { return { text, json: JSON.parse(text) }; } catch { return null; }
}

const sha = (t: string) => createHash('sha256').update(t).digest('hex');

export async function activePackName(cli: Cli): Promise<string | null> {
  const r = await cli(['schema', 'active', '--json'], { timeoutMs: 20_000 });
  if (r.exitCode !== 0) return null;
  const j = lastJson(r.stdout) as Record<string, unknown> | null;
  const pick = j?.name ?? j?.pack_name ?? (j?.pack as Record<string, unknown> | undefined)?.name;
  return typeof pick === 'string' ? pick : null;
}

export async function readLockInput(p: SchemaPaths): Promise<CoreLockInput> {
  const expectedHashes: Record<string, string> = {};
  const sums = await Bun.file(join(p.packsDir, 'SHA256SUMS')).text();
  for (const line of sums.trim().split('\n')) {
    const [hash, file] = line.trim().split(/\s+/);
    if (hash && file) expectedHashes[file] = hash;
  }
  const installed: Record<string, PackFile | null> = {};
  const installedHashes: Record<string, string | null> = {};
  for (const [, name, shipped] of LAYERS) {
    const r = await readJson(join(p.gbrainHome, '.gbrain', 'schema-packs', name, 'pack.json'));
    installed[name] = (r?.json as PackFile) ?? null;
    if (shipped) installedHashes[shipped] = r ? sha(r.text) : null;
  }
  return {
    active: await activePackName(p.cli),
    core: installed['mobrain-core'] ?? null,
    personal: installed['mobrain-personal'] ?? null,
    brain: installed['mobrain-brain'] ?? null,
    installedHashes,
    expectedHashes,
  };
}

export type SchemaType = { name: string; primitive: string; prefixes: string[]; aliases: string[]; layer: 'core' | 'personal' | 'brain'; count: number | null };
export type SchemaView = {
  active: string | null;
  layers: { layer: string; name: string; version: string | null }[];
  types: SchemaType[];
  linkTypes: { name: string; layer: string }[];
  orphans: unknown[] | null;
  coreLock: CoreLockResult;
};

export async function buildSchemaView(p: SchemaPaths & { stats: Record<string, number> | null; orphans: unknown[] | null }): Promise<SchemaView> {
  const input = await readLockInput(p);
  const packs = { core: input.core, personal: input.personal, brain: input.brain };
  const types = new Map<string, SchemaType>();
  const links = new Map<string, { name: string; layer: string }>();
  for (const [layer] of LAYERS) {
    const pack = packs[layer];
    for (const t of pack?.page_types ?? []) {
      types.set(t.name, { name: t.name, primitive: t.primitive, prefixes: t.path_prefixes ?? [], aliases: t.aliases ?? [], layer, count: p.stats?.[t.name] ?? null });
    }
    for (const l of pack?.link_types ?? []) links.set(l.name, { name: l.name, layer });
  }
  return {
    active: input.active,
    layers: LAYERS.map(([layer, name]) => ({ layer, name, version: packs[layer]?.version ?? null })),
    types: [...types.values()],
    linkTypes: [...links.values()],
    orphans: p.orphans,
    coreLock: checkCoreLock(input),
  };
}
```

- [ ] **Step 3: Run** — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/schema/service.ts test/unit/schema-service.test.ts
git commit -m "feat(schema): read installed packs, build the layered schema view

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5.3: Schema and admin-health routes

**Files:**
- Create: `src/server/routes/schema.ts`
- Modify: `src/server/env.ts` (add `packsDir`, `gbrainHome`)
- Modify: `src/server/app.ts` (mount after people)
- Modify: `test/db/app.ts` (env gets `packsDir`, `gbrainHome` pointing at a temp home built like task 5.2's `beforeAll`)
- Test: `test/db/routes-schema.test.ts`

- [ ] **Step 1: Extend `Env`**

In `src/server/env.ts` add to the type `packsDir: string; gbrainHome: string;` and to `loadEnv`:

```ts
    packsDir: src.PACKS_DIR?.trim() || '/app/packs',
    gbrainHome: src.GBRAIN_HOME?.trim() || '/srv/gbrain-home',
```

Add one assertion to `test/unit/env.test.ts` `applies defaults`: `expect(e.packsDir).toBe('/app/packs'); expect(e.gbrainHome).toBe('/srv/gbrain-home');`.

In `test/db/app.ts`, before building `deps`, create a temp home with the three packs installed (same code as task 5.2 `beforeAll`), and set `packsDir: join(import.meta.dir, '..', '..', 'packs'), gbrainHome: home` in `env`. Make the default fake `cli` answer `['schema','active','--json']` with `{"name":"mobrain-brain"}` and `['--version']` with `gbrain 0.60.230.0`:

```ts
const defaultCli = async (argv: string[]): Promise<CliResult> => {
  if (argv[0] === '--version') return { exitCode: 0, stdout: 'gbrain 0.60.230.0\n', stderr: '' };
  if (argv[0] === 'schema' && argv[1] === 'active') return { exitCode: 0, stdout: '{"name":"mobrain-brain"}', stderr: '' };
  if (argv[0] === 'autopilot') return { exitCode: 0, stdout: '{"status":"fresh"}', stderr: '' };
  return { exitCode: 0, stdout: '{}', stderr: '' };
};
```

- [ ] **Step 2: Write the failing test**

```ts
// test/db/routes-schema.test.ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { PeopleService } from '../../src/server/people/service.ts';
import type { McpCaller } from '../../src/server/gbrain/mcp.ts';

let w: TestWorld; let ownerKey: string;
const calls: string[] = [];
beforeAll(async () => {
  w = await world({
    mcp: () => (async (tool: string) => {
      calls.push(tool);
      if (tool === 'schema_stats') return { types: [{ type: 'person', count: 7 }] };
      if (tool === 'schema_review_orphans') return { pages: [{ slug: 'misc/x' }] };
      if (tool === 'run_doctor') return { ok: true, checks: [] };
      if (tool === 'get_stats') return { pages: 12 };
      return {};
    }) as McpCaller,
  });
  ({ apiKey: ownerKey } = await new PeopleService(w.deps).bootstrapOwner({ email: 'own@x.io' }));
});
afterAll(async () => w.drop());

test('GET /api/schema returns layers, typed counts, orphans and the lock', async () => {
  const r = await (await w.req('/api/schema', { as: ownerKey })).json();
  expect(r.active).toBe('mobrain-brain');
  expect(r.coreLock.ok).toBe(true);
  expect(r.types.find((t: { name: string }) => t.name === 'person').count).toBe(7);
  expect(r.orphans).toEqual([{ slug: 'misc/x' }]);
});

test('GET /api/schema needs a login', async () => {
  expect((await w.req('/api/schema')).status).toBe(401);
});

test('GET /api/admin/health is owner/admin only and includes doctor, stats, autopilot and the lock', async () => {
  const r = await (await w.req('/api/admin/health', { as: ownerKey })).json();
  expect(r).toMatchObject({ coreLock: { ok: true }, doctor: { ok: true }, stats: { pages: 12 }, autopilot: { status: 'fresh' } });
  expect(r.pin.matches).toBe(true);
});
```

Run — Expected: FAIL.

- [ ] **Step 3: Write `src/server/routes/schema.ts`**

```ts
import { Hono } from 'hono';
import type { Deps } from '../app.ts';
import { lastJson } from '../gbrain/cli.ts';
import { requireRole, requireUser, type AppEnv } from '../http.ts';
import { PeopleService } from '../people/service.ts';
import { buildSchemaView, readLockInput } from '../schema/service.ts';
import { checkCoreLock } from '../schema/coreLock.ts';

function statsMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const rows = (raw as { types?: { type?: string; name?: string; count?: number }[] })?.types ?? [];
  for (const r of rows) { const k = r.type ?? r.name; if (k && typeof r.count === 'number') out[k] = r.count; }
  return out;
}

function orphanList(raw: unknown): unknown[] {
  const o = raw as { pages?: unknown[]; orphans?: unknown[] } | unknown[];
  return Array.isArray(o) ? o : (o?.pages ?? o?.orphans ?? []);
}

export function schemaRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const people = new PeopleService(deps);
  const paths = () => ({ packsDir: deps.env.packsDir, gbrainHome: deps.env.gbrainHome, cli: deps.cli });

  r.get('/api/schema', async (c) => {
    const call = deps.mcp(await people.uiToken(requireUser(c)));
    const [stats, orphans] = await Promise.all([
      call('schema_stats', {}).then(statsMap, () => null),
      call('schema_review_orphans', { limit: 50 }).then(orphanList, () => null),
    ]);
    return c.json(await buildSchemaView({ ...paths(), stats, orphans }));
  });

  r.get('/api/admin/health', requireRole('owner', 'admin'), async (c) => {
    const call = deps.mcp(await people.instanceToken());
    const v = await deps.cli(['--version'], { timeoutMs: 10_000 });
    const running = v.exitCode === 0 ? v.stdout.trim().split(/\s+/).pop() ?? null : null;
    const ap = await deps.cli(['autopilot', '--status', '--json'], { timeoutMs: 20_000 });
    const [doctor, stats] = await Promise.all([
      call('run_doctor', {}).catch((e) => ({ error: String(e.message ?? e) })),
      call('get_stats', {}).catch((e) => ({ error: String(e.message ?? e) })),
    ]);
    return c.json({
      pin: { expected: deps.env.gbrainVersion, running, matches: running === deps.env.gbrainVersion },
      coreLock: checkCoreLock(await readLockInput(paths())),
      autopilot: lastJson(ap.stdout) ?? { exitCode: ap.exitCode },
      doctor,
      stats,
    });
  });

  return r;
}
```

- [ ] **Step 4: Mount** — in `createApp`, after `peopleRoutes`: `app.route('/', schemaRoutes(deps));`.

- [ ] **Step 5: Run** — `bun run test:unit && bun run test:db` — Expected: PASS.

- [ ] **Step 6: Live check on dev** — rebuild `mobrain`, `dc up -d --wait`, log in with the bootstrap password from task 4.9, and `curl -s http://127.0.0.1:8788/api/schema -H "authorization: Bearer <apiKey>" | head -c 600`. Expected: `"active":"mobrain-brain"` and `"coreLock":{"ok":true`. `dc down`.

- [ ] **Step 7: Commit**

```bash
git add src/server test/db test/unit/env.test.ts
git commit -m "feat(schema): schema view and admin health routes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
