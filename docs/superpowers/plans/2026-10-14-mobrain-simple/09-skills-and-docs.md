# Phase 9: Skills, install assets, docs

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Read `00-master.md` first.

**Goal:** The five Mo-brain skills an agent follows; the assets the instance serves (`/install/mobrain`, `/install/skills.tar.gz` with gbrain's skills and a merged resolver); a way to create collector pages before the agent's session has the gbrain MCP loaded; and the docs for the new shape.

**Spec sections:** §7, §8.4, §10, §15.

**Skill rule (from the user's standing feedback):** a Mo-brain skill that wraps a gbrain procedure mirrors that gbrain skill's phases in the same order, tells the agent to read the installed gbrain copy as the authority, and marks its own changes in `**Mo-brain:**` blocks. If the installed gbrain skill's phases differ from what the Mo-brain skill expects, the agent stops and reports version drift.

---

### Task 9.1: Collector pages, search and brain passes without the MCP

At install time the installing session has not loaded the gbrain MCP yet (that needs a harness restart), so `bin/mobrain` creates and edits collector pages through the server, which writes them with gbrain's trusted local `gbrain put` (probe P7 recorded its syntax).

**Files:**
- Create: `src/server/collectors/pages.ts`
- Modify: `src/server/routes/runner.ts` (`POST /api/collectors`, `PATCH /api/collectors/:source/*`)
- Modify: `bin/mobrain` (`collector add|set|list`, `search`, `brain exec`)
- Test: `test/unit/collector-pages.test.ts`, `test/db/collectors-write.test.ts`, `test/unit/cli/collector.test.ts`

- [ ] **Step 1: Write the failing unit test**

```ts
// test/unit/collector-pages.test.ts
import { expect, test } from 'bun:test';
import { collectorMarkdown, collectorSlug, putPageArgv } from '../../src/server/collectors/pages.ts';
import { frontmatterOf } from '../../src/server/gbrain/pages.ts';

test('slug comes from the title', () => {
  expect(collectorSlug('Work email (Gmail)')).toBe('system/collectors/work-email-gmail');
});

test('markdown round-trips through frontmatterOf', () => {
  const md = collectorMarkdown({ title: 'Mail', kind: 'email', enabled: true, cadence: '2h', harness: 'claude-code',
    allowed_tools: ['mcp__claude_ai_Gmail__*'], target_source: 'p-ada', backfill_days: 90, tool_hint: 'claude.ai Gmail' }, 'Skip newsletters.');
  const { frontmatter, body } = frontmatterOf(md);
  expect(frontmatter).toMatchObject({ type: 'collector', kind: 'email', cadence: '2h', allowed_tools: ['mcp__claude_ai_Gmail__*'] });
  expect(body.trim()).toBe('Skip newsletters.');
});

test('put argv names the slug and the source; content goes on stdin', () => {
  expect(putPageArgv('system/collectors/mail', 'p-ada')).toEqual(['put', 'system/collectors/mail', '--source', 'p-ada']);
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Write `src/server/collectors/pages.ts`**

```ts
import { stringify } from 'yaml';
import { slugFor } from '../people/rules.ts';
import { PREFIX } from './service.ts';

export function collectorSlug(title: string): string {
  return `${PREFIX}${slugFor(title)}`;
}

export function collectorMarkdown(fields: Record<string, unknown>, notes: string): string {
  return `---\n${stringify({ type: 'collector', ...fields }).trimEnd()}\n---\n${notes.trim()}\n`;
}

/** Trusted local write (probe P7). The page text is passed on stdin. */
export function putPageArgv(slug: string, source: string): string[] {
  return ['put', slug, '--source', source];
}
```

Extend `runGbrain` in `src/server/gbrain/cli.ts` to accept `stdin?: string` in `opts`, passed as `stdin: opts.stdin === undefined ? 'ignore' : new TextEncoder().encode(opts.stdin)` to `Bun.spawn`. Add a unit test in `test/unit/gbrain-cli.test.ts`:

```ts
  test('passes stdin', async () => {
    const r = await runGbrain([], { bin: 'cat', stdin: 'hello' });
    expect(r.stdout).toBe('hello');
  });
```

- [ ] **Step 3: Write the failing DB test**

```ts
// test/db/collectors-write.test.ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { PeopleService } from '../../src/server/people/service.ts';
import type { CliResult } from '../../src/server/gbrain/cli.ts';
import type { McpCaller } from '../../src/server/gbrain/mcp.ts';

const writes: { argv: string[]; stdin?: string }[] = [];
let w: TestWorld; let key: string;
beforeAll(async () => {
  w = await world({
    cli: async (argv: string[], opts?: { stdin?: string }): Promise<CliResult> => {
      if (argv[0] === 'put') writes.push({ argv, stdin: opts?.stdin });
      if (argv[0] === '--version') return { exitCode: 0, stdout: 'gbrain 0.60.230.0', stderr: '' };
      return { exitCode: 0, stdout: '{}', stderr: '' };
    },
    mcp: () => (async (tool: string) => tool === 'get_page'
      ? { slug: 'system/collectors/mail', source_id: 'p-own', content: '---\ntype: collector\ntitle: Mail\nkind: email\nenabled: true\ncadence: 2h\nallowed_tools: [t]\ntarget_source: p-own\n---\nnotes' }
      : {}) as McpCaller,
  });
  ({ apiKey: key } = await new PeopleService(w.deps).bootstrapOwner({ email: 'own@x.io' }));
});
afterAll(async () => w.drop());

test('creating a collector validates it and writes the page into my private source', async () => {
  const r = await w.req('/api/collectors', { method: 'POST', as: key, body: JSON.stringify({
    title: 'Mail', kind: 'email', cadence: '2h', allowedTools: ['mcp__claude_ai_Gmail__*'], notes: 'Skip newsletters.' }) });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ slug: 'system/collectors/mail', source: 'p-own' });
  expect(writes[0]!.argv).toEqual(['put', 'system/collectors/mail', '--source', 'p-own']);
  expect(writes[0]!.stdin).toContain('target_source: p-own');
});

test('an invalid collector is refused with its errors', async () => {
  const r = await w.req('/api/collectors', { method: 'POST', as: key, body: JSON.stringify({ title: 'X', kind: 'fax', cadence: '1m', allowedTools: [] }) });
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: 'invalid_collector', detail: ['kind', 'cadence', 'allowed_tools'] });
});

test('a source I cannot write is refused', async () => {
  const r = await w.req('/api/collectors', { method: 'POST', as: key, body: JSON.stringify({ title: 'X', kind: 'email', cadence: '2h', allowedTools: ['t'], source: 'c-nope' }) });
  expect(r.status).toBe(403);
});

test('patch pauses a collector, keeping its notes', async () => {
  const r = await w.req('/api/collectors/p-own/system/collectors/mail', { method: 'PATCH', as: key, body: JSON.stringify({ enabled: false }) });
  expect(r.status).toBe(200);
  const last = writes.at(-1)!;
  expect(last.stdin).toContain('enabled: false');
  expect(last.stdin).toContain('notes');
});
```

Run — Expected: FAIL.

- [ ] **Step 4: Add the routes to `runner.ts`**

```ts
import { collectorMarkdown, collectorSlug, putPageArgv } from '../collectors/pages.ts';
import { parseCollector } from '../collectors/model.ts';
import { getPage } from '../gbrain/pages.ts';
import { PeopleService } from '../people/service.ts';
import { assertOk } from '../gbrain/cli.ts';

  // inside runnerRoutes:
  const people = new PeopleService(deps);

  async function writePage(source: string, slug: string, fm: Record<string, unknown>, notes: string) {
    const parsed = parseCollector(slug, source, { type: 'collector', ...fm });
    if (!parsed.ok) throw new HttpError(400, 'invalid_collector', parsed.errors);
    assertOk('gbrain put', await deps.cli(putPageArgv(slug, source), { timeoutMs: 30_000, stdin: collectorMarkdown(fm, notes) }));
  }

  r.post('/api/collectors', async (c) => {
    const user = requireUser(c);
    const b = await jsonBody<{ title?: string; kind?: string; cadence?: string; allowedTools?: string[]; model?: string;
      backfillDays?: number; source?: string; notes?: string; toolHint?: string }>(c);
    if (!b.title) throw new HttpError(400, 'title_required');
    const mine = await svc.runnableSources(user);
    const source = b.source ?? mine.find((s) => s.startsWith('p-'));
    if (!source || !mine.includes(source)) throw new HttpError(403, 'not_your_source');
    const slug = collectorSlug(b.title);
    const fm: Record<string, unknown> = {
      title: b.title, kind: b.kind, enabled: true, cadence: b.cadence, harness: 'claude-code',
      allowed_tools: b.allowedTools ?? [], target_source: source, backfill_days: b.backfillDays ?? 90,
    };
    if (b.model) fm.model = b.model;
    if (b.toolHint) fm.tool_hint = b.toolHint;
    await writePage(source, slug, fm, b.notes ?? '');
    return c.json({ slug, source });
  });

  r.patch('/api/collectors/:source/*', async (c) => {
    const user = requireUser(c);
    const source = c.req.param('source');
    if (!(await svc.runnableSources(user)).includes(source)) throw new HttpError(403, 'not_your_source');
    const slug = c.req.path.slice(`/api/collectors/${source}/`.length);
    const b = await jsonBody<{ enabled?: boolean; cadence?: string }>(c);
    const page = await getPage(deps.mcp(await people.uiToken(user)), source, slug);
    const { type: _t, ...fm } = page.frontmatter;
    if (typeof b.enabled === 'boolean') fm.enabled = b.enabled;
    if (b.cadence) fm.cadence = b.cadence;
    await writePage(source, slug, fm, page.body);
    return c.json({ ok: true });
  });
```

Add `stdin?: string` to the `cli` option type in `Deps` (it is `typeof runGbrain`, so the change in step 2 carries through) and to the test world's `cli` signature in `test/db/app.ts`.

- [ ] **Step 5: Add the CLI commands to `bin/mobrain`**

```bash
# ---- collectors, search, brain passes --------------------------------------------------

cmd_collector() {
  need_runner
  local sub=${1:-}; shift || true
  case "$sub" in
    add)
      local title="" kind="" cadence="" tools="" model="" days=90 source="" notes=""
      while [ $# -gt 0 ]; do
        case "$1" in
          --title) title=$2 ;; --kind) kind=$2 ;; --cadence) cadence=$2 ;; --tools) tools=$2 ;; --model) model=$2 ;;
          --backfill-days) days=$2 ;; --source) source=$2 ;; --notes) notes=$2 ;; *) usage ;;
        esac; shift 2
      done
      [ -n "$title" ] && [ -n "$kind" ] && [ -n "$cadence" ] || usage
      local arr="[]"
      if [ -n "$tools" ]; then arr="["; local t first=1; IFS=',' read -ra parts <<< "$tools"
        for t in "${parts[@]}"; do [ $first = 1 ] || arr+=","; arr+="$(json_str "$t")"; first=0; done; arr+="]"; fi
      local body="{\"title\":$(json_str "$title"),\"kind\":$(json_str "$kind"),\"cadence\":$(json_str "$cadence"),\"allowedTools\":$arr,\"backfillDays\":$days,\"notes\":$(json_str "$notes")"
      [ -n "$model" ] && body+=",\"model\":$(json_str "$model")"
      [ -n "$source" ] && body+=",\"source\":$(json_str "$source")"
      api POST /api/collectors "$body}" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p' ;;
    set)
      local slug=${1:-} source="" enabled="" cadence=""; shift || true
      while [ $# -gt 0 ]; do case "$1" in --source) source=$2 ;; --enabled) enabled=$2 ;; --cadence) cadence=$2 ;; *) usage ;; esac; shift 2; done
      [ -n "$slug" ] || usage
      [ -n "$source" ] || source="$(api GET "/api/runner/due?slug=$(urlenc "$slug")" | cut -f2)"
      local body="{"; [ -n "$enabled" ] && body+="\"enabled\":$enabled"
      [ -n "$cadence" ] && { [ "$body" = "{" ] || body+=","; body+="\"cadence\":$(json_str "$cadence")"; }
      api PATCH "/api/collectors/$source/$slug" "$body}" >/dev/null && echo "updated $slug" ;;
    list)
      local source=${2:-}; [ "${1:-}" = --source ] || source="$(api GET /api/sources | sed -n 's/.*"id":"\(p-[^"]*\)".*/\1/p' | head -1)"
      api GET "/api/sources/$source/collectors"; echo ;;
    *) usage ;;
  esac
}

cmd_search() {
  need_runner
  [ $# -ge 1 ] || usage
  local q=$1 source=""; [ "${2:-}" = --source ] && source=${3:-}
  [ -n "$source" ] || source="$(api GET /api/sources | sed -n 's/.*"id":"\(p-[^"]*\)".*/\1/p' | head -1)"
  api GET "/api/pages?source=$source&q=$(urlenc "$q")"; echo
}

BRAIN_EXEC_ALLOWED=" extract embed doctor stats sync "
cmd_brain() {
  need_stack
  [ "${1:-}" = exec ] || usage; shift; [ "${1:-}" = -- ] && shift
  [ $# -ge 1 ] && [[ "$BRAIN_EXEC_ALLOWED" == *" $1 "* ]] || { echo "allowed: $BRAIN_EXEC_ALLOWED" >&2; exit 64; }
  dc exec -T gbrain gbrain "$@"
}
```

Add `collector add|set|list`, `search <q> [--source s]` and `brain exec -- <args>` to the `usage` text.

- [ ] **Step 6: Write the CLI test**

```ts
// test/unit/cli/collector.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { cliWorld, curlRoutes, type Cli } from './harness.ts';

let c: Cli;
beforeEach(async () => {
  c = await cliWorld(); await c.runnerEnv();
  await c.stub('curl', curlRoutes([['/api/collectors', 200, '{"slug":"system/collectors/work-email","source":"p-own"}']]));
});
afterEach(async () => rm(c.root, { recursive: true, force: true }));

test('collector add builds the JSON body, including a tools array', async () => {
  const r = await c.run(['collector', 'add', '--title', 'Work email', '--kind', 'email', '--cadence', '2h',
    '--tools', 'mcp__claude_ai_Gmail__*,mcp__x__y', '--notes', 'Skip "promo" mail']);
  expect(r.stdout.trim()).toBe('system/collectors/work-email');
  const call = (await c.calls('curl'))[0]!;
  expect(JSON.parse(call[call.indexOf('--data-binary') + 1]!)).toEqual({
    title: 'Work email', kind: 'email', cadence: '2h', allowedTools: ['mcp__claude_ai_Gmail__*', 'mcp__x__y'],
    backfillDays: 90, notes: 'Skip "promo" mail' });
});

test('brain exec allows only listed passes', async () => {
  expect((await c.run(['brain', 'exec', '--', 'drop-everything'])).code).not.toBe(0);
});
```

- [ ] **Step 7: Amend the spec** — in §11's command table add rows for `collector add|set|list` (any host), `search <q>` (any host), `brain exec -- <extract|embed|doctor|stats|sync ...>` (stack host) and `join --url --key` (member machines); in §6.2 and §11 replace `schema edit` with the two-step `schema edit --out <file>` / `schema apply <file>`; in §9.2 add `POST /api/collectors` and `PATCH /api/collectors/:source/*`. In §11 and §13, say `selftest` uses its own project `mobrain-selftest`, env file `.env.selftest` and port 8790, and that `down -v` is allowed only for `mobrain-dev` and `mobrain-selftest`.

- [ ] **Step 8: Run** — `bun run test:unit && bun run test:db` — Expected: PASS. **Commit:**

```bash
git add src/server bin/mobrain test docs/superpowers/specs/2026-10-14-mobrain-simple-design.md
git commit -m "feat(collectors): create and edit collector pages without MCP; search; brain passes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9.2: Install assets and the merged resolver

**Files:**
- Create: `src/server/install.ts`, `src/server/routes/install.ts`
- Modify: `src/server/env.ts` (`gbrainSkillsDir` from `GBRAIN_SKILLS_DIR`, default `/opt/gbrain/skills`; `appDir` from `MOBRAIN_APP_DIR`, default `/app`)
- Modify: `src/server/app.ts` (mount before static)
- Modify: `test/db/app.ts` (the test world's `env` gains `gbrainSkillsDir: '/nonexistent'` and `appDir: '/nonexistent'`; tests that need them set real temp paths)
- Modify: `test/unit/env.test.ts` (`applies defaults` also asserts `gbrainSkillsDir` is `/opt/gbrain/skills` and `appDir` is `/app`)
- Test: `test/unit/install.test.ts`, `test/db/routes-install.test.ts`

- [ ] **Step 1: Write the failing unit test**

```ts
// test/unit/install.test.ts
import { expect, test } from 'bun:test';
import { mergeResolver } from '../../src/server/install.ts';

const block = '| mobrain-collect | run a collector |';

test('appends a marked Mo-brain block to gbrain\'s resolver', () => {
  const out = mergeResolver('# RESOLVER\n| ingest | x |\n', block);
  expect(out).toBe('# RESOLVER\n| ingest | x |\n\n<!-- mobrain:begin -->\n| mobrain-collect | run a collector |\n<!-- mobrain:end -->\n');
});

test('replaces an existing block instead of adding a second one', () => {
  const once = mergeResolver('# R\n', 'old');
  expect(mergeResolver(once, block).match(/mobrain:begin/g)!.length).toBe(1);
  expect(mergeResolver(once, block)).toContain(block);
  expect(mergeResolver(once, block)).not.toContain('old');
});
```

- [ ] **Step 2: Write `src/server/install.ts`**

```ts
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BEGIN = '<!-- mobrain:begin -->';
const END = '<!-- mobrain:end -->';

export function mergeResolver(gbrain: string, mobrainBlock: string): string {
  const stripped = gbrain.replace(new RegExp(`\\n*${BEGIN}[\\s\\S]*?${END}\\n?`), '\n').replace(/\n+$/, '\n');
  return `${stripped}\n${BEGIN}\n${mobrainBlock.trim()}\n${END}\n`;
}

let cached: Uint8Array | null = null;

/** gbrain's pinned skills + Mo-brain's skills, one resolver, as a .tar.gz. Built once per process. */
export async function skillsBundle(gbrainSkillsDir: string, mobrainSkillsDir: string): Promise<Uint8Array> {
  if (cached) return cached;
  const work = await mkdtemp(join(tmpdir(), 'mb-skills-'));
  try {
    const out = join(work, 'out');
    await mkdir(out);
    await cp(gbrainSkillsDir, out, { recursive: true });
    await cp(mobrainSkillsDir, out, { recursive: true, filter: (src) => !src.endsWith('RESOLVER.mobrain.md') });
    const merged = mergeResolver(
      await readFile(join(gbrainSkillsDir, 'RESOLVER.md'), 'utf8'),
      await readFile(join(mobrainSkillsDir, 'RESOLVER.mobrain.md'), 'utf8'),
    );
    await writeFile(join(out, 'RESOLVER.md'), merged);
    const tgz = join(work, 'skills.tar.gz');
    const p = Bun.spawn(['tar', '-czf', tgz, '-C', out, '.']);
    if ((await p.exited) !== 0) throw new Error('tar failed');
    cached = new Uint8Array(await Bun.file(tgz).arrayBuffer());
    return cached;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
```

- [ ] **Step 3: Write `src/server/routes/install.ts`**

```ts
import { Hono } from 'hono';
import { join } from 'node:path';
import type { Deps } from '../app.ts';
import { requireUser, type AppEnv } from '../http.ts';
import { skillsBundle } from '../install.ts';

export function installRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  // The CLI is not a secret; a member downloads it before they have a key.
  r.get('/install/mobrain', () => new Response(Bun.file(join(deps.env.appDir, 'bin', 'mobrain')), {
    headers: { 'content-type': 'text/x-shellscript; charset=utf-8' } }));
  r.get('/install/skills.tar.gz', async (c) => {
    requireUser(c);
    const body = await skillsBundle(deps.env.gbrainSkillsDir, join(deps.env.appDir, 'skills'));
    return new Response(body, { headers: { 'content-type': 'application/gzip' } });
  });
  return r;
}
```

`authenticate` is mounted on `/api/*` only; add `app.use('/install/*', authenticate(deps.sql, deps.now));` in `createApp` before mounting `installRoutes`.

- [ ] **Step 4: Write the DB test**

```ts
// test/db/routes-install.test.ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { world, type TestWorld } from './app.ts';
import { PeopleService } from '../../src/server/people/service.ts';

let w: TestWorld; let key: string; let tmp: string;
beforeAll(async () => {
  w = await world();
  tmp = await mkdtemp(join(tmpdir(), 'mb-inst-'));
  await mkdir(join(tmp, 'gskills', 'ingest'), { recursive: true });
  await writeFile(join(tmp, 'gskills', 'RESOLVER.md'), '# RESOLVER\n');
  await writeFile(join(tmp, 'gskills', 'ingest', 'SKILL.md'), 'ingest');
  await mkdir(join(tmp, 'app', 'skills', 'mobrain-collect'), { recursive: true });
  await mkdir(join(tmp, 'app', 'bin'), { recursive: true });
  await writeFile(join(tmp, 'app', 'skills', 'RESOLVER.mobrain.md'), '| mobrain-collect | x |');
  await writeFile(join(tmp, 'app', 'skills', 'mobrain-collect', 'SKILL.md'), 'collect');
  await writeFile(join(tmp, 'app', 'bin', 'mobrain'), '#!/usr/bin/env bash\n');
  w.deps.env.gbrainSkillsDir = join(tmp, 'gskills'); w.deps.env.appDir = join(tmp, 'app');
  ({ apiKey: key } = await new PeopleService(w.deps).bootstrapOwner({ email: 'own@x.io' }));
});
afterAll(async () => { await w.drop(); await rm(tmp, { recursive: true, force: true }); });

test('the CLI downloads without a key', async () => {
  expect(await (await w.req('/install/mobrain')).text()).toStartWith('#!/usr/bin/env bash');
});

test('the skills bundle needs a key and holds both skill sets and one merged resolver', async () => {
  expect((await w.req('/install/skills.tar.gz')).status).toBe(401);
  const r = await w.req('/install/skills.tar.gz', { as: key });
  const out = join(tmp, 'x'); await mkdir(out);
  await Bun.write(join(tmp, 's.tgz'), await r.arrayBuffer());
  await Bun.spawn(['tar', '-xzf', join(tmp, 's.tgz'), '-C', out]).exited;
  expect(await Bun.file(join(out, 'ingest', 'SKILL.md')).text()).toBe('ingest');
  expect(await Bun.file(join(out, 'mobrain-collect', 'SKILL.md')).text()).toBe('collect');
  expect(await Bun.file(join(out, 'RESOLVER.md')).text()).toContain('<!-- mobrain:begin -->\n| mobrain-collect | x |');
  expect(await Bun.file(join(out, 'RESOLVER.mobrain.md')).exists()).toBe(false);
});
```

`createApp` reads `deps.env` at request time for these paths (the routes close over `deps`, not copied values), so mutating `w.deps.env` after `world()` works.

- [ ] **Step 5: Run** — Expected: PASS. **Commit:**

```bash
git add src/server test
git commit -m "feat(server): serve the CLI and a skills bundle with a merged resolver

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9.3: Resolver block and the skill lint

**Files:**
- Create: `skills/RESOLVER.mobrain.md`
- Delete: `skills/RESOLVER.md`
- Test: `test/unit/skills.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/skills.test.ts
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = join(import.meta.dir, '..', '..');
const skillsDir = join(root, 'skills');
const skills = readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory());
const usage = readFileSync(join(root, 'bin', 'mobrain'), 'utf8').split('cat >&2 <<\'EOF\'')[1]!.split('EOF')[0]!;

describe('Mo-brain skills', () => {
  test('exactly the five shipped skills', () => {
    expect(skills.sort()).toEqual(['mobrain-collect', 'mobrain-import', 'mobrain-install', 'mobrain-join', 'mobrain-schema']);
  });

  for (const s of skills) {
    const text = readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8');
    const fm = parse(/^---\n([\s\S]*?)\n---/.exec(text)![1]!) as { name: string; description: string; triggers?: string[] };

    test(`${s}: frontmatter name matches the folder and has a description and triggers`, () => {
      expect(fm.name).toBe(s);
      expect(fm.description.length).toBeGreaterThan(40);
      expect(fm.triggers?.length).toBeGreaterThan(0);
    });

    test(`${s}: every \`mobrain <command>\` it names exists in the CLI usage`, () => {
      const cmds = [...text.matchAll(/`mobrain ([a-z-]+)(?: ([a-z-]+))?/g)].map((m) => m[1]!);
      for (const c of new Set(cmds)) expect(usage).toContain(c);
    });
  }

  test('the resolver block routes to every skill', () => {
    const block = readFileSync(join(skillsDir, 'RESOLVER.mobrain.md'), 'utf8');
    for (const s of skills) expect(block).toContain(s);
  });
});
```

- [ ] **Step 2: Write `skills/RESOLVER.mobrain.md`**

```markdown
## Mo-brain

This brain is a Mo-brain install: gbrain behind a small service. These routes come first; everything else routes through gbrain's table above.

| When the person says or needs | Read |
|---|---|
| "install mobrain", "set up my brain", first contact with a Mo-brain repo | `mobrain-install/SKILL.md` |
| "join mobrain", a join line with a URL and a key | `mobrain-join/SKILL.md` |
| connect, pause, or change a source; "collect my email now"; a timer woke you to run a collector | `mobrain-collect/SKILL.md` |
| add or change a page type, link type or folder; "the schema doesn't fit" | `mobrain-schema/SKILL.md` |
| "import my old brain / notes / vault", a `notes-import` collector | `mobrain-import/SKILL.md` |

Mo-brain rules that win over any skill:
- Brain writes go through the gbrain MCP server (`gbrain`, or `gbrain-company-<source>` for a company source). People, access, timers and the stack go through `mobrain` commands.
- Never redefine a `mobrain-core` or `mobrain-personal` type; extend `mobrain-brain` only (`mobrain-schema`).
- Never copy files into the brain raw; ingestion goes through gbrain (`brain-ingest-gate`).
```

Run: `git rm -q skills/RESOLVER.md`

- [ ] **Step 3: Run** — Expected: FAIL until tasks 9.4–9.8 add the five skills. Commit after 9.8.

---

### Task 9.4: `mobrain-install`

**Files:**
- Create: `skills/mobrain-install/SKILL.md`

- [ ] **Step 1: Write the skill**

````markdown
---
name: mobrain-install
description: Install Mo-brain end to end for the person - the Docker stack with gbrain, their sources, recurring collectors and timers - so they finish with a populated brain and a review UI. The person only asks, answers one batch of questions, and connects any source tool you do not already have. Use when the person says "install mobrain", "set up mobrain", "set up my brain", or shares the Mo-brain repository.
triggers:
  - "install mobrain"
  - "set up mobrain"
  - "set up my brain"
  - "install my brain"
---

# Install Mo-brain

## Contract

The person does three things: asks for the install, answers **one** batch of questions, and connects a source tool if you lack one. You do everything else, report once at the end, and never leave a step half-done without saying so.

Done means all of these are true, and you have checked each:
- `mobrain status` exits 0.
- `mobrain schema check` prints `core lock ok`.
- Every chosen source has a collector whose last run is `ok` or `partial` (`mobrain collector list`).
- `mobrain search "<a term you saw in a source>"` returns a page.
- `mobrain timers status` shows the collector timer.

## Before you start

- Work from a checkout of `https://github.com/MoliorOS/MO-BRAIN` on the machine that will host the brain. Run every command as `bin/mobrain` from the checkout root (or put it on `PATH`). If the person wants the brain on another machine (a VPS), stop and ask; this skill installs where you run.
- Requirements: Docker Compose 2.20 or newer, 2 CPUs, 4 GB RAM, a free loopback port (default 8787). `install` checks them and refuses with exit 17 and a reason.
- Read `INSTALL_FOR_AGENTS.md` at the checkout root once.

## Phase 1: Find the tools you already have

Look at your own tool list. For each source kind, note the tools that could read it:

| Kind | Looks like |
|---|---|
| `email` | Gmail or Outlook tools: `mcp__claude_ai_Gmail__*`, names containing `gmail`, `outlook`, `mail`; gateway tools (Composio `GMAIL_*`, executor) |
| `calendar` | `*calendar*`, Google Calendar, Outlook calendar, gateway calendar tools |
| `meetings` | Granola, Fireflies, Circleback, Otter, Fathom, tl;dv, or Meet notes in Drive |
| `docs` | Google Drive or Docs (`*drive*`), Notion (`*notion*`), Confluence, any knowledge base tool |
| `notes-import` | a local folder you can read: an Obsidian vault, an old gbrain brain, Markdown, a Notion export |

Do not ask the person to authenticate anything to Mo-brain. Source access stays in their harness or gateway.

## Phase 2: Ask once

Send one message, in this shape, filled in from Phase 1:

> I'll install Mo-brain here and set everything up. I need:
> 1. An OpenAI API key (it powers search and extraction), or say "keyless" for keyword search only. Paste it and I'll store it privately.
> 2. The email for your login to the review UI.
> 3. What to connect: email, calendar, meeting notes, Drive/Docs, Notion or another knowledge base, an existing notes folder or old brain. I can already reach: <list>. For <missing kinds> I'd need you to add a connector to me first (<exact suggestion, e.g. "add the Notion connector in claude.ai settings" or "add your Composio MCP server">).

Accept "skip" for any source. Write the key to a temporary file with mode 0600 (`umask 077; printf '%s' "$KEY" > /tmp/mobrain-key`), never into chat logs you keep or any repo file, and delete it after install.

## Phase 3: Install the stack

```bash
bin/mobrain install --owner-email <email> --openai-key-file /tmp/mobrain-key   # or --keyless
rm -f /tmp/mobrain-key
```

It prints `ui_url`, `owner_password`, `local_url` and `runner_env`. Keep the password for the final report. On exit 17, read the reason and fix the cause; never delete `.env`, volumes or another compose project to get past it. Ask the person if the fix touches anything you did not create.

## Phase 4: Connect yourself and install skills

```bash
bin/mobrain client issue agent --register
bin/mobrain skills install --dir ~/.claude/skills
```

The registration adds an MCP server named `gbrain` to your harness. This interactive session will not see it until a restart; headless runs do, which is why backfills below run headless. The skills bundle is gbrain's pinned skills plus Mo-brain's, with one resolver; read its `RESOLVER.md` once.

## Phase 5: Create the collectors

For each source the person chose:

```bash
bin/mobrain collector add --title "<human title>" --kind <kind> --cadence <cadence> \
  --tools '<tool patterns from Phase 1, comma-separated>' --notes "<what to include or skip, in the person's words>"
```

Default cadences: email `2h`, calendar `daily@06:30` plus `6h`, meetings `3h`, docs `1d`, notes-import `once`. Default backfill: email and meetings 90 days, calendar 30 days back, docs all (the collect skill samples first).

For `notes-import`, put the folder's absolute path in `--notes`.

## Phase 6: Backfill

For each collector, one at a time:

```bash
bin/mobrain collect system/collectors/<slug> --backfill
```

Each run prints `<slug>: <status> (<summary>)`. On `error`, read the newest log in `~/.local/state/mobrain/collect/<slug>/`, fix the cause (usually a tool missing from `--tools`, which `mobrain collector set` cannot change; re-create the collector with `mobrain collector add` and the same title), and run it again. A `partial` backfill is fine; the timer finishes it.

## Phase 7: Timers and verification

```bash
bin/mobrain timers install
bin/mobrain status && bin/mobrain schema check && bin/mobrain collector list
bin/mobrain search "<a real term from a source>"
```

Fix anything that fails before reporting. gbrain's own maintenance (sync, embeddings, links, nightly cycle) runs in the `autopilot` container; you do not schedule it.

## Phase 8: Report

One message:

> Mo-brain is running.
> - Review it at <ui_url> (sign in as <email>, password `<owner_password>`; change it any time by asking me).
> - Ingested: <per source: N pages, time range>.
> - Collectors: <title, cadence> each. They run on this machine every 15 minutes when due, using my connections.
> - Search mode is balanced. <If keyless: semantic search and extraction are off until you give me an OpenAI key.>
> - To change anything (a source, a schedule, the schema, inviting people), just ask me.
> - Restart this session once so I can use the brain directly.

If the person wants to reach the UI from other devices, offer `tailscale serve` and ask before running it:
`tailscale serve --bg --https=8443 http://127.0.0.1:<port>`, then `bin/mobrain` needs no change except that new clients use that URL; re-run `client issue agent --register` on other machines through `mobrain join`.

## Anti-patterns

- Asking more than one batch of questions, or asking for things you can find yourself.
- Building an OAuth flow, storing a source credential in Mo-brain, or asking the person to paste a source password.
- Writing collector pages or brain pages by copying files into a volume.
- Running `docker compose down -v`, `mobrain restore`, or editing `.env` to recover from an install error.
- Reporting "done" before every check in the contract passed.
````

- [ ] **Step 2: Commit after 9.8.**

---

### Task 9.5: `mobrain-join`

**Files:**
- Create: `skills/mobrain-join/SKILL.md`

- [ ] **Step 1: Write the skill**

````markdown
---
name: mobrain-join
description: Connect this machine's agent to an existing Mo-brain as an invited person - download the CLI, register the gbrain MCP server, install skills, connect the person's own sources and start their collectors. Use when the person pastes a line like "Join Mo-brain at <url> with key <key>", or says "join mobrain" or "connect me to the company brain".
triggers:
  - "join mobrain"
  - "join Mo-brain at"
  - "connect me to the company brain"
---

# Join a Mo-brain

## Contract

Same as `mobrain-install`, without the stack: the person pasted one line and answers one batch. You finish with their agent connected, their sources collecting into their private space, and timers running. No Docker is needed on this machine.

## Phase 1: Get the CLI and join

The pasted line holds a URL and a one-time key. Run:

```bash
mkdir -p ~/.local/bin
curl -fsSL <url>/install/mobrain -o ~/.local/bin/mobrain && chmod +x ~/.local/bin/mobrain
~/.local/bin/mobrain join --url <url> --key <key>
```

`join` registers the `gbrain` MCP server in your harness, installs the skills bundle in `~/.claude/skills`, and installs the collector timer. If the key was already used, ask the person to create a new one under **Connect your agent** in the UI.

## Phase 2: Ask once, then connect sources

Follow `mobrain-install` Phases 1, 2 (without the OpenAI key and email questions; the brain already has them), 5, 6 and 7, using `~/.local/bin/mobrain` instead of `bin/mobrain`. Collectors write into the person's private source. Company sources are shared by an admin's grant; you read them, you do not write them.

## Phase 3: Report

> You're connected to Mo-brain at <url>.
> - Your private space: <source id>. Shared with you: <granted company sources>.
> - Ingested: <per source>. Collectors: <list>.
> - Restart this session once so I can use the brain directly.
````

---

### Task 9.6: `mobrain-collect` and its kind references

**Files:**
- Create: `skills/mobrain-collect/SKILL.md`
- Create: `skills/mobrain-collect/kinds/email.md`, `calendar.md`, `meetings.md`, `docs.md`, `notes-import.md`, `fixture.md`

- [ ] **Step 1: Write `skills/mobrain-collect/SKILL.md`**

````markdown
---
name: mobrain-collect
description: Run one Mo-brain collector - read new items from a source with the person's own tools, ingest them into the brain through gbrain's MCP following gbrain's ingestion skills, and advance the collector's watermark only after a clean batch. Also covers adding, pausing and rescheduling collectors. Use when a timer prompt says "Use the mobrain-collect skill to run collector ...", or the person says "collect my email now", "connect my calendar", "pause the Notion collector", "check my sources more often".
triggers:
  - "mobrain-collect"
  - "run collector"
  - "collect my email now"
  - "pause the collector"
  - "connect my calendar"
---

# Run a Mo-brain collector

## Contract

One run handles one collector page, `system/collectors/<id>`, in one source. It:
- reads only items newer than the page's `watermark` (or within `backfill_days` in backfill mode);
- writes every item through gbrain's MCP, via the skill gbrain names for that content;
- moves `watermark` forward only past items that were written;
- ends its final message with exactly two lines:

```
MOBRAIN_STATUS: ok|partial|error
MOBRAIN_SUMMARY: <one line: read N, created N, updated N, skipped N, errors N>
```

`partial` means some items remain (cap reached) or some failed and were left behind the watermark. The runner records these lines; a run without them counts as `error`.

## Phase 1: Read the collector

`get_page` the collector slug, in the source named by the prompt, with `include_content: true`. Read `kind`, `enabled`, `allowed_tools`, `watermark`, `backfill_days` and the body notes. If `enabled` is false, stop with `MOBRAIN_STATUS: ok` and `MOBRAIN_SUMMARY: disabled`.

Read the kind reference next to this file: `kinds/<kind>.md`.

## Phase 2: Fetch

Use only the tools in `allowed_tools` to list items newer than the watermark, oldest first, at most 200 in incremental mode and at most 500 per run in backfill mode. In backfill mode, follow gbrain's `bulk-ingestion` discipline inside the run: process 5 to 10 items, check their pages against the filing rules below, fix your approach, then continue.

## Phase 3: Ingest each item through gbrain

Read the installed gbrain skills named here as the authority; do not restate them from memory:
- Before creating any page: `brain-ingest-gate` (resolve entities, deduplicate).
- Meetings and transcripts: `meeting-ingestion`, end to end, including its verification checklist.
- Documents and articles: `idea-ingest` or `media-ingest` as gbrain's resolver routes them.
- Every person and company touched: `enrich`.
- Where a page goes: `brain-taxonomist`, against the active schema (`mobrain-brain`, which extends `mobrain-core`).

**Mo-brain:** write through the MCP server the prompt names (`gbrain`, or `gbrain-company-<source>` for a company source). Give every page from an external item a stable `source_ref` in its frontmatter (`gmail:<threadId>`, `gcal:<eventId>`, `drive:<fileId>`, `notion:<pageId>`, `granola:<id>`), and look it up before writing so a re-run updates instead of duplicating. Cite the item's link in the page.

## Phase 4: Advance the watermark

Only after every item up to a point is written, set the collector page's `watermark` to that point (`put_page` with the page's current revision as `expected_revision`, everything else unchanged). Never move it past a failed item. On a revision conflict, re-read the page and retry once.

## Phase 5: Report

End with the two lines from the contract.

## Managing collectors (interactive, when the person asks)

- Add: `mobrain collector add` (see `mobrain-install` Phase 5), then `mobrain collect system/collectors/<slug> --backfill`.
- Pause or resume: `mobrain collector set system/collectors/<slug> --enabled false|true`, or edit the page's `enabled` through gbrain MCP.
- Change cadence: `mobrain collector set system/collectors/<slug> --cadence <cadence>`. Allowed: `<n>m` (15 or more), `<n>h`, `<n>d`, `daily@HH:MM`, `once`.
- Run now: `mobrain collect system/collectors/<slug>`.

## Anti-patterns

- Fetching with a tool not in `allowed_tools`, or calling a source API directly with a credential.
- Copying a whole email body, document or transcript into a page instead of following the ingestion skill.
- Advancing the watermark at the start of a run, or past a failure.
- Omitting the two closing lines.
````

- [ ] **Step 2: Write the kind references**

`skills/mobrain-collect/kinds/email.md`:

```markdown
# Kind: email

- Fetch threads with new messages since the watermark (an ISO timestamp of the newest message processed). Newest-first listing is fine; process oldest first.
- Skip without writing: newsletters and marketing (List-Unsubscribe header, bulk senders), automated notifications, no-reply senders, calendar invites (the calendar collector owns those), and anything the collector notes say to skip.
- One `conversation` page per meaningful thread under `emails/`: who, what was asked or promised, decisions, dates; quote sparingly; link to the thread.
- Enrich every person and company with a real role in the thread.
- Note open loops (someone waiting on the person, or the person promised something) in the page body under `## Open loops`.
- Watermark: the newest message timestamp written.
```

`skills/mobrain-collect/kinds/calendar.md`:

```markdown
# Kind: calendar

- Each run reads events from 7 days back to 14 days ahead; backfill reads `backfill_days` back and 60 days ahead.
- One `event` page per event under `calendar/YYYY/`, with time, attendees, location or link, and the agenda if any. Update the page when the event changes; mark cancelled events `status: cancelled`, never delete.
- Enrich attendees who are not the person.
- Recurring events: one page per series under `calendar/series/`, plus pages only for occurrences with notes or changes.
- Watermark: the run time (calendar windows are re-read each run, so the watermark only records the last successful run).
```

`skills/mobrain-collect/kinds/meetings.md`:

```markdown
# Kind: meetings

- Fetch transcripts and recorder notes created since the watermark.
- Follow gbrain's `meeting-ingestion` skill for each one, end to end, including speaker resolution, entity propagation and its verification checklist. Recorder summaries are claims, not facts.
- Link the meeting page to the matching calendar `event` page when one exists.
- Watermark: the newest transcript creation time written.
```

`skills/mobrain-collect/kinds/docs.md`:

```markdown
# Kind: docs (Drive, Docs, Notion, other knowledge bases)

- Fetch documents created or modified since the watermark, within the folders, spaces or databases the collector notes name (ask the person once if the notes name none; never crawl everything silently).
- One `source` page per document under `sources/`: a summary, key points, the link, and the last-modified time. Not a raw copy.
- Then the concepts, projects, decisions and people the document establishes, through `idea-ingest` and `brain-ingest-gate`.
- A changed document updates its existing `source` page (same `source_ref`).
- Watermark: the newest modified time written.
```

`skills/mobrain-collect/kinds/notes-import.md`:

```markdown
# Kind: notes-import

- One-time import of a folder, an old brain or an export. Cadence `once`.
- Follow the `mobrain-import` skill end to end. The folder path is in the collector notes.
- On success, set `enabled: false` on the collector page.
```

`skills/mobrain-collect/kinds/fixture.md`:

```markdown
# Kind: fixture

Used only by `mobrain selftest`. Read the Markdown files in the folder named in the notes and write one `note` page per file under `notes/fixture/`, then report.
```

- [ ] **Step 3: Commit after 9.8.**

---

### Task 9.7: `mobrain-schema`

**Files:**
- Create: `skills/mobrain-schema/SKILL.md`

- [ ] **Step 1: Write the skill**

````markdown
---
name: mobrain-schema
description: Extend or change this brain's schema the gbrain way - mirror gbrain's schema-author procedure, change only the mobrain-brain layer, and never redefine a mobrain-core or mobrain-personal entry. Use when the person says "add a type", "track deals as their own pages", "the schema doesn't fit", "rename this type", or when ingestion keeps producing untyped pages.
triggers:
  - "add a page type"
  - "change the schema"
  - "the schema doesn't fit"
  - "track * as their own pages"
---

# Change the Mo-brain schema

## Authority

Read the installed gbrain skill `schema-author/SKILL.md` and follow its phases in its order (at gbrain 0.60.230.0: Brain, Assess, Propose, Apply, Sync, Verify, Commit). If its phases differ from that list, stop and tell the person the gbrain version drifted from what this skill expects.

## Mo-brain deltas

**Mo-brain (Brain):** the active pack is always `mobrain-brain`, which extends `mobrain-personal`, which extends `mobrain-core`. Confirm with `get_active_schema_pack` or `mobrain schema show`.

**Mo-brain (Propose):** a proposal may only add to `mobrain-brain`. It may not reuse a type name, alias, folder prefix or link type name already defined by `mobrain-core` or `mobrain-personal` (`mobrain schema show` lists each with its layer). Show the person the proposal and wait for a yes.

**Mo-brain (Apply):**
- Types, aliases, prefixes and link types: `schema_apply_mutations` through gbrain MCP, against pack `mobrain-brain` (owners and admins only).
- Anything gbrain accepts only as a file edit (frontmatter links, enrichable types, filing rules, subtypes, mapping rules, cardinality, temporal): on the stack host,
  `mobrain schema edit --out /tmp/mobrain-brain.json`, edit that file, then `mobrain schema apply /tmp/mobrain-brain.json`. `apply` validates, lints, checks the core lock, and rolls back on any failure.

**Mo-brain (Sync):** backfills use gbrain's own flows through `mobrain schema exec -- sync|review-orphans|unify-types ...` on the stack host.

**Mo-brain (Verify):** `mobrain schema check` must print `core lock ok`. The UI's Schema page shows the new type with layer `brain`.

**Mo-brain (Commit):** there is no separate repo to commit; the pack lives with the brain and is in every `mobrain backup`.

## Anti-patterns

- Editing `mobrain-core` or `mobrain-personal`, or activating another pack.
- Renaming a core type to fit a habit; add an alias in `mobrain-brain` only if it does not collide.
- Applying without the person's yes on the proposal.
````

---

### Task 9.8: `mobrain-import` (from the v1 stage-4 skill)

**Files:**
- Modify: `skills/mobrain-import/SKILL.md` (moved in phase 1)

- [ ] **Step 1: Apply these edits**

1. Frontmatter: `name: mobrain-import`; description: "Import a folder - an earlier gbrain brain, an Obsidian vault, a Notion export or any Markdown repo - into the person's private source by following gbrain's own `migrate` skill, refiling every page into the mobrain-core schema so gbrain types, links and indexes it. Runs as a `notes-import` collector or when the person asks." Keep the triggers; remove `onboarding stage 4`.
2. Title: `# Import notes into Mo-brain`. Remove every reference to onboarding stages, the console, "Sources → Import notes", lane A, `gbrain-ops`, `./molior.sh`, Spaces and Connections. Use "source" for Space and "agent client" for Connection.
3. Replace the "Lanes" section with one lane: **write through gbrain MCP with `put_pages`** (at most 50 pages and 8 MB per call, one `request_id` UUID per batch), reading and checking over MCP.
4. Replace the Phase 6 host commands with: "autopilot extracts links, timeline and embeddings for remote writes within a few minutes. Check with `get_backlinks` on two pages you know link to each other. If they are missing after 15 minutes, on the stack host run `mobrain brain exec -- extract links --source db --source-id <id> --include-frontmatter` and `mobrain brain exec -- extract timeline --source db --source-id <id>`."
5. In "Tools Used", replace the `sync_brain` row with: "not needed; autopilot syncs."
6. Keep everything else (assess, plan the mapping, merges shown first, sample of 5 to 10, ramp, verify, anti-patterns, output format) as written; it already mirrors gbrain `migrate`.
7. Add at the end of the Output Format: the two `MOBRAIN_STATUS` / `MOBRAIN_SUMMARY` lines from `mobrain-collect` when the run came from a collector.

- [ ] **Step 2: Run the skills test** — `bun test test/unit/skills.test.ts` — Expected: PASS.

- [ ] **Step 3: Commit the skills**

```bash
git add skills test/unit/skills.test.ts
git commit -m "feat(skills): install, join, collect (with kinds), schema, import; resolver block

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9.9: Docs

**Files:**
- Rewrite: `README.md`, `HANDOFF.md`, `CLAUDE.md`
- Create: `INSTALL_FOR_AGENTS.md`
- Create: `docs/runbooks/operate.md`, `collectors.md`, `company.md`, `backup-restore.md`, `upgrade.md`, `ci.md`

- [ ] **Step 1: Write `README.md`**

````markdown
# Mo-brain

A personal or company brain your coding agent installs and runs for you. Mo-brain is [gbrain](https://github.com/garrytan/gbrain), packaged: four containers, a set of agent skills, and a small review UI.

## Install

Tell your coding agent:

> Install Mo-brain from https://github.com/MoliorOS/MO-BRAIN

It asks you one batch of questions (an OpenAI key, your email, which sources to connect), then installs the stack, ingests your sources, and schedules collectors that run with your agent's own connections. You review everything at the URL it gives you. To change anything, ask your agent.

## What runs

| Container | Does |
|---|---|
| `postgres` | the brain and Mo-brain's small people database |
| `gbrain` | gbrain's MCP server |
| `autopilot` | gbrain's own sync, embedding, linking and nightly maintenance |
| `mobrain` | the review UI, people and access, the collector API, and the `/mcp` proxy |

Collectors run on the host from a timer: `bin/mobrain collect --due` wakes your agent headless with the `mobrain-collect` skill.

## Docs

- [`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md): what an installing agent reads first.
- [`docs/runbooks/`](docs/runbooks/): operate, collectors, company mode, backup and restore, upgrade, CI.
- [`HANDOFF.md`](HANDOFF.md): state of the project for the next developer.
````

- [ ] **Step 2: Write `INSTALL_FOR_AGENTS.md`**

````markdown
# Installing Mo-brain (for agents)

Follow `skills/mobrain-install/SKILL.md` in this repository. It is the whole procedure. These are the traps:

1. **One batch of questions.** Ask for the OpenAI key (or keyless), the owner email, and the sources, together. Find the person's existing tools yourself first.
2. **Never authenticate sources in Mo-brain.** Collectors use your harness's own MCP connections or the person's gateway. Mo-brain stores no source credential.
3. **`install` refuses rather than reuses** (exit 17): an existing `.env`, an existing compose project of that name, a busy port, too little RAM or CPU, or an old Docker Compose. Fix the cause; never delete someone else's stack or volumes to get past it.
4. **Your interactive session cannot see the gbrain MCP until it restarts.** That is expected. Backfills run headless (`bin/mobrain collect <slug> --backfill`) and pick it up.
5. **Never `docker compose down -v`** outside the `mobrain-dev` project, never edit or regenerate `.env` after install (`ENCRYPTION_KEY` seals stored tokens), and never copy files into the brain's volumes.
6. **The schema base is locked.** Extend only `mobrain-brain` (`skills/mobrain-schema`).
7. **gbrain is pinned** (`0.60.230.0`). Upgrades go through `bin/mobrain upgrade --gbrain <version>`, which backs up first.
````

- [ ] **Step 3: Write `HANDOFF.md`**

````markdown
# Handoff — read this first

**Mo-brain 2 (simplified)** replaced v1 on 2026-10-14. v1 is frozen at tag `v1-final` (control plane, ops sidecar, scheduler, agent runner, control MCP, zones). Nothing from v1 runs any more.

- Design: `docs/superpowers/specs/2026-10-14-mobrain-simple-design.md`. Probe results: `docs/superpowers/specs/2026-10-14-mobrain-simple-probes.md`.
- Build plan: `docs/superpowers/plans/2026-10-14-mobrain-simple/`.

## Shape

Four containers (`postgres`, `gbrain`, `autopilot`, `mobrain`), one bash CLI (`bin/mobrain`), five skills (`skills/`). gbrain is driven only through its CLI (argv arrays), its HTTP MCP, and `mcp grant` / `auth` commands. Mo-brain owns people, invites, grants, collector run history and the UI; every access decision is enforced by re-granting gbrain clients.

## Pins

| | |
|---|---|
| gbrain | `0.60.230.0` (`bin/mobrain` `PIN`, `.env` `GBRAIN_VERSION`) |
| Bun | `1.4.2` (images and CI) |
| App | `2.0.0-dev`, unreleased; images are built locally |

## Settled, do not re-argue

- No separate Mo-brain MCP. Brain work goes through gbrain's MCP; people and stack work through `bin/mobrain`.
- Collectors run in the person's own harness on a host timer. gbrain's subagents cannot reach external tools, so nothing server-side runs collectors.
- One schema per brain: `mobrain-core` ← `mobrain-personal` ← `mobrain-brain`. Only the last is edited.
- The UI is read-only except People & access.

## Known gaps

- Harness adapters: Claude Code only. `codex exec` and others are a new `harness_run` branch in `bin/mobrain`.
- Agent tokens last at most 90 days; `collect --due` rotates them when the harness was registered by `mobrain`.
- Isolation is gbrain's application-level source scoping, not database row-level security; the host operator can read everything.
- No public-domain TLS; use `tailscale serve`.

## How to run (dev)

```bash
bin/mobrain install --owner-email dev@local.test --keyless --project mobrain-dev --port 8788
bin/mobrain status
bin/mobrain down          # stop when not in use: the VPS has 2 vCPUs
```

Tests: `bun run test:unit` (CI), `bun run test:db` (local), `bin/mobrain selftest` (local, dev project only).
````

- [ ] **Step 4: Update `CLAUDE.md`**

Keep the CI rules section verbatim. Replace the first paragraph with: "Start with `HANDOFF.md`. Procedures: `docs/runbooks/`. Do not read `docs/archive/` unless asked." Replace the Docker-suites rule with: "`stack.yml` runs `bin/mobrain selftest` by hand only (`gh workflow run stack.yml`). Dispatch at most once per finished change, never on a schedule." Remove references to `test:contract:isolated`.

- [ ] **Step 5: Write the runbooks**

`docs/runbooks/operate.md`: status (`mobrain status [--detail]`, exit codes 0/1/2), logs (`mobrain logs <svc>`), restart (`mobrain up`), stopping (`mobrain down`, never `-v` outside `mobrain-dev`), resetting the owner password (`docker compose ... exec -T mobrain bun src/server/admin-cli.ts reset-password --email <e>` via `bin/mobrain`'s compose files), remote access with `tailscale serve`.

`docs/runbooks/collectors.md`: what a collector page holds (spec §8.1 block), cadences, `mobrain collector add|set|list`, `mobrain collect`, where logs live (`~/.local/state/mobrain/collect/<slug>/`), timers (`mobrain timers install|remove|status`, systemd user units or crontab), token rotation, what `partial`, `error` and `timeout` mean and what to do for each.

`docs/runbooks/company.md`: switching modes and its rule; invites (24-hour single-use links, shown to the inviter); roles table (spec §5.2); grants and `agent_reads`; company sources; company collectors with `mobrain client issue company-writer <source> --register`; offboarding and that it can be re-run; that isolation is gbrain source scoping and the host operator sees everything.

`docs/runbooks/backup-restore.md`: `mobrain backup` (what is in it, where, the daily timer keeping 7, `.env` is not in it and must be kept separately), `mobrain restore <dir> --yes` (stops services, version check, `--allow-version-change`), testing a restore on `mobrain-dev` first.

`docs/runbooks/upgrade.md`: `mobrain upgrade --gbrain <v>` steps and its rollback line; read gbrain's `skills/migrations/v<version>.md` for every version crossed; re-run `mobrain skills install`; Mo-brain's own updates (`git pull` or `git merge --ff-only`, then `mobrain up --build`); live host procedure from `CLAUDE.local.md` (fast-forward `molior`, back up, update, confirm health).

`docs/runbooks/ci.md`: `git show v1-final:docs/runbooks/ci.md > docs/runbooks/ci.md`, then replace its suite list with: `ci.yml` (lint, typecheck, unit, on push and PR), `stack.yml` (selftest, manual), and delete every reference to integration, contract, e2e, release and runner suites.

- [ ] **Step 6: Lint and commit**

Run: `bun run lint:forbidden && bun run test:unit`

```bash
git add README.md INSTALL_FOR_AGENTS.md HANDOFF.md CLAUDE.md docs/runbooks
git commit -m "docs: README, agent install guide, handoff, runbooks for the new shape

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
