# mobrain-personal Schema Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `mobrain-personal` as the default schema pack for every new brain, hide all bundled gbrain packs except `gbrain-base-v2`, and make edits to the shipped pack land in an auto-created `my-personal` layer.

**Architecture:** The manifest is checked in at `src/ops/packs/mobrain-personal.json`. The ops server (which owns the file plane) seeds it into `~/.gbrain/schema-packs/` at boot, before any `gbrain init` can run. Pack-name policy (bundled / visible / managed / layer) lives in one module, `src/contracts/packs.ts`, used by both ops and control. The control plane filters what the console sees and redirects mutations of a managed pack into the layer pack.

**Tech Stack:** Bun + TypeScript, Hono routes (`src/control/routes/*.ts`), React console (`src/console`), `bun:test`, gbrain 0.50.5.0 in Docker.

**Spec:** `docs/superpowers/specs/2026-09-27-mobrain-personal-schema-pack-design.md`

## Global Constraints

- Pack name `mobrain-personal`, version `1.0.0`, `extends: null`, `api_version: gbrain-schema-pack-v1`, `gbrain_min_version: 0.50.5`.
- Layer pack name `my-personal`, `extends: mobrain-personal`.
- Visible bundled packs: exactly `['gbrain-base-v2']`. The other six bundled names are hidden in the console, never deleted from disk.
- A brain's currently active pack is always shown, even when it is a hidden bundled pack.
- `DEFAULT_SCHEMA_PACK = 'mobrain-personal'`.
- Never reimplement gbrain's `extends` merge; effective data comes from `effectivePack()` (docs/schema-pack-findings.md S4).
- Existing brains are never auto-migrated.
- Test commands: unit `bun test test/unit/<file>`; integration needs
  `export CONTROL_DATABASE_URL=postgres://gbrain:ci-not-a-real-secret@localhost:5432/control`
  (scratch container `bs-fp-pg` is running) then `bun test test/integration/<file>`.
- Baseline has 5 pre-existing unit failures unrelated to this work: `validateRequest > returns a validated packOverride`, `validateRequest > rejects an invalid packOverride`, `registry invariants > operations.json matches registry.ts`, `scheduler service > the Postgres-backed checks are not silently skipped`, `seedSpaceRepo > seed-space tests are not silently skipped`. Do not fix them; do not add new failures.
- Commit messages end with: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (preceded by a blank line).
- Work in the worktree `C:\Users\juanp\Desktop\MO-BRAIN\.worktrees\personal-pack` on branch `feat/mobrain-personal-pack`. Never `cd` to the main checkout. Never use bare `git stash`.

---

### Task 1: The pack manifest, its structural test, and the gbrain probes

The manifest `src/ops/packs/mobrain-personal.json` is **already written** (generated from spec §3 and pre-checked: `gbrain schema validate` ✓ with 20 page types / 21 link verbs, `lint` ok with only `alias_references_undeclared_type` warnings). Do not restructure it. This task pins it with a test and records the gbrain probes.

**Files:**
- Existing: `src/ops/packs/mobrain-personal.json`
- Create: `test/unit/mobrain-pack.test.ts`
- Modify: `docs/schema-pack-findings.md` (append section `## S8 — mobrain-personal probes`)

**Interfaces:**
- Produces: the file path `src/ops/packs/mobrain-personal.json`, used by Task 2's seeder.

- [ ] **Step 1: Write the structural test**

```ts
// test/unit/mobrain-pack.test.ts
import { test, expect, describe } from 'bun:test';
import pack from '../../src/ops/packs/mobrain-personal.json';

type PT = { name: string; primitive: string; path_prefixes: string[]; aliases: string[]; extractable: boolean; expert_routing: boolean };
const types = pack.page_types as PT[];
const typeNames = types.map((t) => t.name);
const verbNames = (pack.link_types as { name: string }[]).map((l) => l.name);

describe('mobrain-personal manifest (spec §3)', () => {
  test('identity', () => {
    expect(pack.name).toBe('mobrain-personal');
    expect(pack.version).toBe('1.0.0');
    expect(pack.api_version).toBe('gbrain-schema-pack-v1');
    // A MISSING extends inherits gbrain-base (S7); it must be an explicit null.
    expect('extends' in pack && pack.extends === null).toBe(true);
  });

  test('17 user types + 3 system types', () => {
    expect(typeNames).toEqual([
      'person', 'company', 'meeting', 'conversation', 'event', 'journal',
      'area', 'goal', 'project', 'decision', 'idea', 'concept', 'note',
      'source', 'writing', 'health_record', 'finance_record',
      'atom', 'synthesis', 'extract_receipt',
    ]);
  });

  test('keeps every type name gbrain hardcodes (spec P3)', () => {
    for (const n of ['person', 'company', 'meeting', 'note', 'concept', 'atom', 'synthesis', 'extract_receipt']) {
      expect(typeNames).toContain(n);
    }
  });

  test('drops the investor-shaped types', () => {
    for (const n of ['deal', 'tweet', 'yc', 'social-digest', 'slack', 'email', 'civic', 'diary', 'media']) {
      expect(typeNames).not.toContain(n);
    }
    for (const v of ['invested_in', 'led_round', 'yc_partner', 'partner_of']) expect(verbNames).not.toContain(v);
  });

  test('21 link verbs', () => {
    expect(verbNames).toHaveLength(21);
    expect(new Set(verbNames).size).toBe(21);
  });

  test('every frontmatter link names a declared type and verb', () => {
    for (const f of pack.frontmatter_links as { page_type: string; link_type: string }[]) {
      expect(typeNames).toContain(f.page_type);
      expect(verbNames).toContain(f.link_type);
    }
  });

  test('one filing rule per user type, pointing at its primary folder', () => {
    const rules = pack.filing_rules as { kind: string; directory: string }[];
    expect(rules).toHaveLength(17);
    for (const r of rules) {
      const t = types.find((x) => x.name === r.kind)!;
      expect(t.path_prefixes[0]).toBe(r.directory);
    }
  });

  test('only person and company are enrichable and expert-routed', () => {
    expect((pack.enrichable_types as { type: string }[]).map((e) => e.type)).toEqual(['person', 'company']);
    expect(types.filter((t) => t.expert_routing).map((t) => t.name)).toEqual(['person', 'company']);
  });
});
```

- [ ] **Step 2: Run it**

Run: `bun test test/unit/mobrain-pack.test.ts`
Expected: PASS (8 tests). If one fails, the manifest disagrees with spec §3. Fix the manifest, not the test, and say so in your report.

- [ ] **Step 3: Run the gbrain probes in a scratch home (never the live brain's home)**

Run each block and keep the exact output:

```bash
docker cp src/ops/packs/mobrain-personal.json mobrain-local-gbrain-ops-1:/tmp/mp.json
docker exec mobrain-local-gbrain-ops-1 sh -c '
H=$(mktemp -d); mkdir -p $H/.gbrain/schema-packs/mobrain-personal
cp /tmp/mp.json $H/.gbrain/schema-packs/mobrain-personal/pack.json; cd /
echo "== P8.1 validate/lint"; GBRAIN_HOME=$H gbrain schema validate mobrain-personal; echo EXIT $?
GBRAIN_HOME=$H gbrain schema lint mobrain-personal --json | grep -c "\"severity\": \"error\""
echo "== P8.2 init with a user-installed pack (pglite)"; GBRAIN_HOME=$H gbrain init --help 2>&1 | head -30
echo "== P8.3 layer: child extends mobrain-personal"
mkdir -p $H/.gbrain/schema-packs/my-personal
printf "%s" "{\"api_version\":\"gbrain-schema-pack-v1\",\"name\":\"my-personal\",\"version\":\"0.1.0\",\"gbrain_min_version\":\"0.50.5\",\"extends\":\"mobrain-personal\",\"description\":\"layer\",\"page_types\":[],\"link_types\":[],\"takes_kinds\":[\"fact\",\"take\",\"bet\",\"hunch\"],\"borrow_from\":[],\"frontmatter_links\":[],\"enrichable_types\":[],\"filing_rules\":[]}" > $H/.gbrain/schema-packs/my-personal/pack.json
GBRAIN_HOME=$H GBRAIN_SCHEMA_PACK=my-personal gbrain schema show --json | grep -c "\"primitive\""
GBRAIN_HOME=$H gbrain schema list
echo "HOME=$H"'
```

Then, with the same `$H` printed above (substitute it), probe P8.2 by running `gbrain init` against that home using the PGLite engine if `init --help` lists one (for example `--pglite` or `--engine pglite`) with `--schema-pack mobrain-personal`, then `gbrain schema active`. If `init` has no DB-free engine, record P8.2 as **UNVERIFIED** (Task 6 covers it live).

Probe P8.3b: in the same home, run `gbrain call` for a mutation on the layer that removes an inherited type. Find the exact `schema.mutate` argv in `src/contracts/registry.ts` (search `'schema.mutate'`) and run it with payload `{"pack":"my-personal","mutations":[{"op":"remove_type","name":"idea"}]}`. Record the JSON answer.

Probe P8.4: `GBRAIN_HOME=$H GBRAIN_SCHEMA_PACK=mobrain-personal gbrain doctor --json 2>&1 | head -60`. Record any check that names `media`, `email`, `diary` or an unknown type. Finally `rm -rf $H` inside the container.

- [ ] **Step 4: Record the findings**

Append to `docs/schema-pack-findings.md`, in the file's house style (MEASURED / UNVERIFIED / FALSIFIED, command → exit code → output):

```markdown
## S8 — mobrain-personal probes (2026-09-27, gbrain 0.50.5.0)

- **P8.1 validate + lint** — <MEASURED result: counts, 0 errors, warning rule names>
- **P8.2 `gbrain init` with a user-installed pack** — <MEASURED / UNVERIFIED + output>
- **P8.3 layer resolution** — effective type count of `my-personal` extends `mobrain-personal`: <n> (expected 20)
- **P8.3b removing an inherited type from the layer** — <gbrain's JSON answer>. Consequence for the console: <"refuse inherited edits" confirmed / override is possible>
- **P8.4 doctor under mobrain-personal** — <checks naming dropped types, or "none">
- **Shared frontmatter field** — `area` declared on five page types validates (P8.1).
```

Fill every `<...>` from the real output. Never write a result you did not run.

- [ ] **Step 5: Commit**

```bash
git add src/ops/packs/mobrain-personal.json test/unit/mobrain-pack.test.ts docs/schema-pack-findings.md docs/superpowers/specs/2026-09-27-mobrain-personal-schema-pack-design.md docs/superpowers/plans/2026-09-27-mobrain-personal-pack.md
git commit -m "feat(schema): add the mobrain-personal pack manifest and its probes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Pack-name policy module and the boot seeder

**Files:**
- Create: `src/contracts/packs.ts`
- Modify: `src/control/schemaDraft.ts:18-21` (re-export `BUNDLED_PACKS` from the new module; refuse managed and layer names in `validateDraft` at line 46)
- Modify: `src/ops/fileplane.ts:216-224` (use the shared lists; add `seedManagedPacks`)
- Modify: `src/ops/server.ts` (call the seeder once before `Bun.serve`)
- Test: `test/unit/fileplane.test.ts`, `test/unit/packs-policy.test.ts` (create)

**Interfaces:**
- Produces (in `src/contracts/packs.ts`):
  - `export const BUNDLED_PACKS: readonly string[]` (the seven gbrain names, same order as today)
  - `export const VISIBLE_BUNDLED_PACKS = ['gbrain-base-v2'] as const`
  - `export const MANAGED_PACKS = ['mobrain-personal'] as const`
  - `export const LAYER_PACK = 'my-personal'`
  - `export const LAYER_PARENT = 'mobrain-personal'`
  - `export function isManagedPack(name: string): boolean`
  - `export function visiblePackNames(names: string[], activePack: string | null): string[]` keeps a name if it is not bundled, OR is in `VISIBLE_BUNDLED_PACKS`, OR equals `activePack`. Input order is preserved.
- Produces (in `src/ops/fileplane.ts`): `export async function seedManagedPacks(opts: { sql: SQL; sourceDir?: string }): Promise<{ name: string; action: 'written' | 'unchanged' }[]>`. `sourceDir` defaults to `join(import.meta.dir, 'packs')`.

- [ ] **Step 1: Write the failing policy test**

```ts
// test/unit/packs-policy.test.ts
import { test, expect } from 'bun:test';
import { visiblePackNames, isManagedPack, BUNDLED_PACKS, LAYER_PACK } from '../../src/contracts/packs.ts';
import { validateDraft } from '../../src/control/schemaDraft.ts';

const ALL = [...BUNDLED_PACKS, 'mobrain-personal', 'my-personal', 'legal-ops'];

test('only gbrain-base-v2 survives among bundled packs', () => {
  expect(visiblePackNames(ALL, 'mobrain-personal'))
    .toEqual(['gbrain-base-v2', 'mobrain-personal', 'my-personal', 'legal-ops']);
});

test('a legacy brain still sees its hidden active pack', () => {
  expect(visiblePackNames(ALL, 'gbrain-investor')).toContain('gbrain-investor');
});

test('managed names', () => {
  expect(isManagedPack('mobrain-personal')).toBe(true);
  expect(isManagedPack(LAYER_PACK)).toBe(false);
});

test('a draft cannot take a managed or layer name', () => {
  const draft = (name: string) => ({ name, description: 'x', extends: null, pageTypes: [
    { name: 't', primitive: 'entity', folder: 't/', description: '', extraPrefixes: [], aliases: [], extractable: false, expertRouting: false },
  ], linkVerbs: [] });
  for (const n of ['mobrain-personal', 'my-personal']) {
    const v = validateDraft(draft(n));
    expect(v.ok).toBe(false);
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test test/unit/packs-policy.test.ts`
Expected: FAIL, cannot resolve `src/contracts/packs.ts`.

- [ ] **Step 3: Implement `src/contracts/packs.ts`**

```ts
/**
 * Which schema packs Mobrain shows, ships and protects (spec P6–P8).
 *
 * gbrain's seven bundled packs stay on disk: `schema validate` with no name
 * hardcodes gbrain-base, and gbrain-everything extends gbrain-investor
 * (docs/schema-pack-findings.md S5). We only hide them.
 */
export const BUNDLED_PACKS = [
  'gbrain-base', 'gbrain-base-v2', 'gbrain-recommended',
  'gbrain-creator', 'gbrain-investor', 'gbrain-engineer', 'gbrain-everything',
] as const;

export const VISIBLE_BUNDLED_PACKS = ['gbrain-base-v2'] as const;

/** Shipped by Mobrain, seeded at ops boot, read-only to every API. */
export const MANAGED_PACKS = ['mobrain-personal'] as const;

/** Where a user's edits to the managed pack go (spec P8). */
export const LAYER_PACK = 'my-personal';
export const LAYER_PARENT = 'mobrain-personal';

export function isManagedPack(name: string): boolean {
  return (MANAGED_PACKS as readonly string[]).includes(name);
}

/** The packs the console lists. The active pack is never hidden. */
export function visiblePackNames(names: string[], activePack: string | null): string[] {
  const bundled = BUNDLED_PACKS as readonly string[];
  const visible = VISIBLE_BUNDLED_PACKS as readonly string[];
  return names.filter((n) => !bundled.includes(n) || visible.includes(n) || n === activePack);
}
```

In `src/control/schemaDraft.ts`, replace the local `BUNDLED_PACKS` declaration (lines 18-21) with
`export { BUNDLED_PACKS } from '../contracts/packs.ts';` plus a local
`import { BUNDLED_PACKS, MANAGED_PACKS, LAYER_PACK } from '../contracts/packs.ts';`, and next to the existing
bundled-name check at line 46 add:

```ts
  if ((MANAGED_PACKS as readonly string[]).includes(name) || name === LAYER_PACK) {
    errors.push(`${name} is reserved by Mobrain`);
  }
```

- [ ] **Step 4: Run the policy test**

Run: `bun test test/unit/packs-policy.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing seeder tests**

Add to `test/unit/fileplane.test.ts` (reuse its `MODULE_HOME`, `fakeSql` and `SCHEMA_PACK_DIR`; add `seedManagedPacks` to the destructured dynamic import at the top):

```ts
describe('seedManagedPacks', () => {
  const src = async (version: string) => {
    const dir = await mkdtemp(join(tmpdir(), 'bs-packs-src-'));
    await writeFile(join(dir, 'mobrain-personal.json'),
      JSON.stringify({ name: 'mobrain-personal', version, api_version: 'gbrain-schema-pack-v1' }));
    return dir;
  };
  const target = () => join(SCHEMA_PACK_DIR, 'mobrain-personal', 'pack.json');

  test('writes an absent managed pack', async () => {
    await rm(join(SCHEMA_PACK_DIR, 'mobrain-personal'), { recursive: true, force: true });
    const r = await seedManagedPacks({ sql: fakeSql, sourceDir: await src('1.0.0') });
    expect(r).toEqual([{ name: 'mobrain-personal', action: 'written' }]);
    expect(JSON.parse(await readFile(target(), 'utf8')).version).toBe('1.0.0');
  });

  test('leaves the same version untouched', async () => {
    const r = await seedManagedPacks({ sql: fakeSql, sourceDir: await src('1.0.0') });
    expect(r).toEqual([{ name: 'mobrain-personal', action: 'unchanged' }]);
  });

  test('overwrites when the shipped version moves', async () => {
    const r = await seedManagedPacks({ sql: fakeSql, sourceDir: await src('1.1.0') });
    expect(r[0]!.action).toBe('written');
    expect(JSON.parse(await readFile(target(), 'utf8')).version).toBe('1.1.0');
  });

  test('the API writers refuse a managed name', async () => {
    await expect(writeSchemaPackJson('mobrain-personal', {}, { sql: fakeSql })).rejects.toThrow(/managed/);
  });

  test('the shipped manifest is the default source', async () => {
    await rm(join(SCHEMA_PACK_DIR, 'mobrain-personal'), { recursive: true, force: true });
    await seedManagedPacks({ sql: fakeSql });
    expect(JSON.parse(await readFile(target(), 'utf8')).name).toBe('mobrain-personal');
  });
});
```

- [ ] **Step 6: Run to see them fail**

Run: `bun test test/unit/fileplane.test.ts`
Expected: FAIL, `seedManagedPacks` is not a function.

- [ ] **Step 7: Implement in `src/ops/fileplane.ts`**

Replace the local `BUNDLED` set (lines 216-217) with an import of `BUNDLED_PACKS`, `isManagedPack` from `'../contracts/packs.ts'`, and update `assertUserPackName` so it refuses bundled names (existing message) and managed names with `${name} is a Mobrain-managed pack and cannot be written`. Then add:

```ts
/**
 * Mobrain's shipped packs (spec §4.2). Written at ops boot, before any
 * `gbrain init` can name them, and rewritten only when the shipped version
 * moves, so a restart never churns the file plane. Bypasses
 * assertUserPackName on purpose: this is the only writer of managed names.
 */
export async function seedManagedPacks(
  opts: { sql: SQL; sourceDir?: string },
): Promise<{ name: string; action: 'written' | 'unchanged' }[]> {
  const sourceDir = opts.sourceDir ?? join(import.meta.dir, 'packs');
  const out: { name: string; action: 'written' | 'unchanged' }[] = [];
  for (const name of MANAGED_PACKS) {
    const shipped = JSON.parse(await readFile(join(sourceDir, `${name}.json`), 'utf8')) as { version?: string };
    const dest = join(SCHEMA_PACK_DIR, name, 'pack.json');
    const current = await readFile(dest, 'utf8')
      .then((t) => (JSON.parse(t) as { version?: string }).version ?? null)
      .catch(() => null);
    if (current === shipped.version) { out.push({ name, action: 'unchanged' }); continue; }
    await writeFilePlane(dest, () => JSON.stringify(shipped, null, 2) + '\n', { ...opts, mode: 0o644 });
    for (const sibling of ['pack.yaml', 'pack.yml']) {
      await unlink(join(SCHEMA_PACK_DIR, name, sibling)).catch((e) => { if (e.code !== 'ENOENT') throw e; });
    }
    out.push({ name, action: 'written' });
  }
  return out;
}
```

Import `MANAGED_PACKS` too. Check `writeFilePlane`'s signature at `src/ops/fileplane.ts:174` and pass the same options shape `writeSchemaPackJson` passes.

- [ ] **Step 8: Call it at ops boot**

In `src/ops/server.ts`, import `seedManagedPacks` alongside the other fileplane imports (line 13-15). Immediately before `Bun.serve({`, add:

```ts
// Spec §4.2: shipped packs must be on disk before the wizard's `gbrain init`
// can name one. A failure is loud, never fatal: the brain still serves.
try {
  for (const r of await seedManagedPacks({ sql })) console.log(`schema pack ${r.name}: ${r.action}`);
} catch (e) {
  console.error('seeding managed schema packs failed', e);
}
```

- [ ] **Step 9: Run the tests**

Run: `bun test test/unit/fileplane.test.ts test/unit/packs-policy.test.ts test/unit/mobrain-pack.test.ts && bun test test/unit 2>&1 | tail -5`
Expected: new tests PASS; full unit run shows only the 5 baseline failures.

- [ ] **Step 10: Commit**

```bash
git add src/contracts/packs.ts src/control/schemaDraft.ts src/ops/fileplane.ts src/ops/server.ts test/unit/packs-policy.test.ts test/unit/fileplane.test.ts
git commit -m "feat(schema): seed Mobrain-managed packs at ops boot" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Default pack, visible packs, and managed-pack guards in the routes

**Files:**
- Modify: `src/control/bootstrap.ts:11-13`
- Modify: `src/control/routes/wizard.ts` (`GET /wizard/schema-packs`, around line 198; stale `gbrain-base-v2` comments at ~130 and ~208)
- Modify: `src/control/routes/schema.ts` (`PackDetail` type ~line 117; `toPackDetail`; `GET /schema/packs` ~359; `GET /schema/packs/:name` ~687; `POST /schema/packs` fork branch ~725; `PUT /schema/pack` ~633; `DELETE /schema/packs/:name` ~820)
- Modify: `src/console/api.ts` (`PackDetail` gains `managed: boolean`)
- Test: `test/integration/schema-routes.test.ts`, `test/integration/wizard.test.ts`

**Interfaces:**
- Consumes: `visiblePackNames`, `isManagedPack`, `LAYER_PACK` from `src/contracts/packs.ts`.
- Produces: `PackDetail.managed: boolean` (server and console types). `GET /schema/packs/:name` answers `editable: true` for managed packs.

- [ ] **Step 1: Write the failing integration tests**

In `test/integration/schema-routes.test.ts`, add near the other constants:

```ts
const LIST_SHIPPED = 'Bundled packs:\n  gbrain-base\n  gbrain-base-v2\n  gbrain-investor\n\n' +
  'Installed packs (~/.gbrain/schema-packs/):\n  mobrain-personal\n';
```

and these tests:

```ts
test('GET /schema/packs hides every bundled pack except gbrain-base-v2', async () => {
  opsHandler = (op, _p, opts) => {
    if (op === 'schema.list') return ok(LIST_SHIPPED);
    if (op === 'schema.active') return ok(ACTIVE('mobrain-personal'));
    if (op === 'schema.show') return ok('', showJson(3, 2, opts?.packOverride));
    return ok('');
  };
  const res = await hit('GET', '/api/schema/packs', ownerCookie);
  expect(res.status).toBe(200);
  const names = (await res.json()).packs.map((p: { name: string }) => p.name);
  expect(names).toEqual(['gbrain-base-v2', 'mobrain-personal']);
});

test('GET /schema/packs keeps a legacy active pack visible', async () => {
  opsHandler = (op, _p, opts) => {
    if (op === 'schema.list') return ok(LIST_SHIPPED);
    if (op === 'schema.active') return ok(ACTIVE('gbrain-investor'));
    if (op === 'schema.show') return ok('', showJson(3, 2, opts?.packOverride));
    return ok('');
  };
  const names = (await (await hit('GET', '/api/schema/packs', ownerCookie)).json()).packs.map((p: { name: string }) => p.name);
  expect(names).toContain('gbrain-investor');
});

test('a managed pack is reported as managed, not bundled', async () => {
  opsHandler = (op, _p, opts) => {
    if (op === 'schema.list') return ok(LIST_SHIPPED);
    if (op === 'schema.active') return ok(ACTIVE('mobrain-personal'));
    if (op === 'schema.show') return ok('', showJson(3, 2, opts?.packOverride));
    return ok('');
  };
  const packs = (await (await hit('GET', '/api/schema/packs', ownerCookie)).json()).packs;
  const mp = packs.find((p: { name: string }) => p.name === 'mobrain-personal');
  expect(mp.managed).toBe(true);
  expect(mp.bundled).toBe(false);
});

test('DELETE refuses a managed pack', async () => {
  opsHandler = () => ok(LIST_SHIPPED);
  const res = await hit('DELETE', '/api/schema/packs/mobrain-personal', ownerCookie);
  expect(res.status).toBe(400);
  expect(packRemoves).toEqual([]);
});

test('PUT /schema/pack and fork refuse managed and layer names', async () => {
  opsHandler = () => ok(LIST_SHIPPED);
  const put = await hit('PUT', '/api/schema/pack', ownerCookie, { name: 'mobrain-personal', yaml: 'name: x' });
  expect(put.status).toBe(400);
  expect(packWrites).toEqual([]);
  const fork = await hit('POST', '/api/schema/packs', ownerCookie, { mode: 'fork', from: 'gbrain-base-v2', name: 'my-personal' });
  expect(fork.status).toBe(400);
});
```

If `ACTIVE(...)` / `showJson(...)` / `ok(...)` differ from what the file defines, use the file's real helpers. They are defined near the top of the file (`const ok = ...`, `const ACTIVE = ...`, `const showJson = ...`).

In `test/integration/wizard.test.ts`, add a test that `GET /api/wizard/schema-packs` (check the mount path in that file's existing tests) with `schema.list` answering `LIST_SHIPPED` returns `packs` equal to `['gbrain-base-v2', 'mobrain-personal']`. Also update any assertion there that expects the bootstrapped `schemaPack` to be `'gbrain-base-v2'` so it expects `'mobrain-personal'`. Find them with `grep -n "gbrain-base-v2" test/integration/wizard.test.ts test/integration/*.test.ts`. Only change assertions about the **bootstrap default**; leave tests that pick `gbrain-base-v2` explicitly alone.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/integration/schema-routes.test.ts test/integration/wizard.test.ts`
Expected: the new tests FAIL (all packs listed; `managed` undefined; managed delete/put accepted).

- [ ] **Step 3: Implement**

1. `bootstrap.ts`: set `DEFAULT_SCHEMA_PACK = 'mobrain-personal'` and update its doc comment to: `Spec P6: Mobrain's own personal pack, seeded at ops boot (src/ops/fileplane.ts seedManagedPacks), stored explicitly so the Schema tab shows it and diverged checks have a stored value.`
2. `schema.ts`:
   - `PackDetail` gains `managed: boolean`; both branches of `toPackDetail` set `managed: isManagedPack(name)`.
   - `GET /schema/packs`: `const active = await readActive(); const names = visiblePackNames(await listSchemaPacks(), active.pack);` then map as today.
   - `GET /schema/packs/:name`: `editable: !bundled.includes(name)` stays true for managed packs (they are "installed" in gbrain's listing). No change needed beyond confirming this.
   - `DELETE /schema/packs/:name`: extend the first guard to `if (!PACK_NAME.test(name) || isBundled(name) || isManagedPack(name)) return c.json({ error: 'only user packs can be deleted' }, 400);`
   - `PUT /schema/pack`: after the name check, `if (isManagedPack(name) || name === LAYER_PACK || isBundled(name)) return c.json({ error: `${name} is reserved` }, 400);`
   - `POST /schema/packs` fork branch: extend `if (!PACK_NAME.test(name) || isBundled(name))` to also reject `isManagedPack(name) || name === LAYER_PACK`. (The draft branch is covered by `validateDraft`, Task 2.)
3. `wizard.ts`: `GET /schema-packs` returns `visiblePackNames(await listSchemaPacks(), null)`. Update the two comments that say init defaults the brain to `gbrain-base-v2` so they say Mobrain stores `mobrain-personal` (gbrain's own init default is still `gbrain-base-v2`, which is why the pack is always passed explicitly).
4. `src/console/api.ts`: add `managed: boolean;` to `PackDetail`.

- [ ] **Step 4: Run the tests**

Run: `bun test test/integration/schema-routes.test.ts test/integration/wizard.test.ts && bun test test/unit 2>&1 | tail -5`
Expected: all PASS; unit run shows only the 5 baseline failures. `GET /schema/packs` now calls `schema.active`: any pre-existing test whose `opsHandler` throws on unexpected ops (e.g. 'GET /schema/packs reports EFFECTIVE counts…') must answer `schema.active` with `ok(ACTIVE('gbrain-base'))`. If a `test/unit/console-*.test.ts` fixture now fails to type-check because `PackDetail` needs `managed`, add `managed: false` to that fixture.

- [ ] **Step 5: Run the rest of the integration suite that touches bootstrap**

Run: `bun test test/integration/routes.test.ts test/integration/zones.test.ts test/integration/mode.test.ts`
Expected: PASS. Fix only assertions about the bootstrap default pack.

- [ ] **Step 6: Commit**

```bash
git add -A src test
git commit -m "feat(schema): default to mobrain-personal and hide the other bundled packs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Auto-layer edits of the managed pack into `my-personal`

**Files:**
- Modify: `src/control/routes/schema.ts` (`POST /schema/packs/:name/mutations`, ~line 763)
- Test: `test/integration/schema-routes.test.ts`

**Interfaces:**
- Consumes: `isManagedPack`, `LAYER_PACK`, `LAYER_PARENT` (Task 2); `draftToManifest(d: PackDraft, gbrainMinVersion: string)` from `src/control/schemaDraft.ts`; `putSchemaPackJson`, `patchFilePlaneConfig`, `callOps` from `../opsClient.ts`; `readActive()` in `schema.ts`.
- Produces: the mutation response gains `pack: string` (the pack actually mutated) and `activated: boolean` (true when the brain was switched to the layer). Refusal code `INHERITED_READONLY` (HTTP 400) for any non-add op on a type or verb the target layer does not declare itself.

Rules (spec §4.5):
1. Target `mobrain-personal` → the real target is `my-personal`. If `my-personal` is not installed, write it with `putSchemaPackJson(LAYER_PACK, draftToManifest({ name: LAYER_PACK, description: 'Your changes, layered on top of mobrain-personal.', extends: LAYER_PARENT, pageTypes: [], linkVerbs: [] }, brain.gbrainVersion ?? '0.50.5.0'))`. If it is installed but its effective `extends` is not `mobrain-personal`, answer 409 `{ error: 'my-personal exists and does not extend mobrain-personal' }`.
2. For the layer (whether reached by redirect or targeted directly), read its own declarations with `callOps<RawManifest>('schema.showRaw', { packName: LAYER_PACK }, { json: true, timeoutMs: 60_000 })`. A freshly written layer owns nothing. Any mutation whose op is not `add_type` / `add_link_type` and whose target (`name` for type/link ops, `type` for alias/prefix/set_* ops) is not in the layer's own `page_types` / `link_types` → 400 `{ error: '<target> comes from mobrain-personal and cannot be changed here. Add a new type instead.', code: 'INHERITED_READONLY' }`, before `schema.mutate` runs.
3. Run the batch against the real target exactly as today.
4. After success, if the target was redirected and `readActive().pack === LAYER_PARENT`: `patchFilePlaneConfig({ schema_pack: LAYER_PACK })`, re-read `readActive()`. If it now resolves `my-personal`, update `brains.schemaPack` to `my-personal`, `activated = true`, and audit `schema.apply` with `{ pack: LAYER_PACK, source, via: 'auto-layer' }`. Otherwise `activated = false` and include `activeError` naming the tier that won (same wording as `/schema/apply`'s divergence message).
5. Audit rows keep recording shape only (S3c). The mutate audit target is the real target pack.

- [ ] **Step 1: Write the failing tests**

```ts
const LIST_LAYERED = 'Bundled packs:\n  gbrain-base-v2\n\nInstalled packs (~/.gbrain/schema-packs/):\n  mobrain-personal\n  my-personal\n';
const layerRaw = (types: string[] = []) => ({
  name: 'my-personal', version: '0.1.0', extends: 'mobrain-personal',
  page_types: types.map((n) => ({ name: n, primitive: 'concept', path_prefixes: [`${n}s/`], aliases: [] })),
  link_types: [],
});

test('editing mobrain-personal creates my-personal, mutates it, and activates it', async () => {
  let listed = LIST_SHIPPED;
  let active = 'mobrain-personal';
  const mutated: string[] = [];
  opsHandler = (op, params, opts) => {
    if (op === 'schema.list') return ok(listed);
    if (op === 'schema.active') return ok(ACTIVE(active));
    if (op === 'schema.showRaw') return ok('', layerRaw());
    if (op === 'schema.show') return ok('', { ...showJson(3, 2, opts?.packOverride), extends: opts?.packOverride === 'my-personal' ? 'mobrain-personal' : null });
    if (op === 'schema.mutate') {
      mutated.push(JSON.parse(String(params.payload)).pack);
      return ok(JSON.stringify({ schema_version: 1, pack: 'my-personal', batch_id: 'b9', mutations_applied: 1, results: [{}] }));
    }
    if (op === 'schema.validate') return ok('✓ valid');
    if (op === 'schema.lint') return ok('', { ok: true, errors: [], warnings: [] });
    if (op === 'config.get') return fail(1, 'Config key not found');
    return ok('');
  };
  const origPush = jsonPackWrites.push.bind(jsonPackWrites);
  jsonPackWrites.push = (...w) => { listed = LIST_LAYERED; return origPush(...w); };
  const origPatch = filePlanePatches.push.bind(filePlanePatches);
  filePlanePatches.push = (...p) => { active = 'my-personal'; return origPatch(...p); };

  const res = await hit('POST', '/api/schema/packs/mobrain-personal/mutations', ownerCookie,
    { mutations: [{ op: 'add_type', name: 'recipe', primitive: 'media', prefix: 'recipes/' }] });
  jsonPackWrites.push = origPush; filePlanePatches.push = origPatch;

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.pack).toBe('my-personal');
  expect(body.activated).toBe(true);
  expect(jsonPackWrites.at(-1)!.name).toBe('my-personal');
  expect(jsonPackWrites.at(-1)!.manifest.extends).toBe('mobrain-personal');
  expect(mutated).toEqual(['my-personal']);
  expect(filePlanePatches.at(-1)).toEqual({ schema_pack: 'my-personal' });
  expect(await storedPack()).toBe('my-personal');
});

test('a second edit reuses the existing layer', async () => {
  opsHandler = (op, _p, opts) => {
    if (op === 'schema.list') return ok(LIST_LAYERED);
    if (op === 'schema.active') return ok(ACTIVE('my-personal'));
    if (op === 'schema.showRaw') return ok('', layerRaw(['recipe']));
    if (op === 'schema.show') return ok('', { ...showJson(3, 2, opts?.packOverride), extends: 'mobrain-personal' });
    if (op === 'schema.mutate') return ok(JSON.stringify({ schema_version: 1, pack: 'my-personal', batch_id: 'b10', mutations_applied: 1, results: [{}] }));
    if (op === 'schema.validate') return ok('✓ valid');
    if (op === 'schema.lint') return ok('', { ok: true, errors: [], warnings: [] });
    if (op === 'config.get') return fail(1, 'Config key not found');
    return ok('');
  };
  const res = await hit('POST', '/api/schema/packs/mobrain-personal/mutations', ownerCookie,
    { mutations: [{ op: 'add_prefix', type: 'recipe', prefix: 'cooking/' }] });
  expect(res.status).toBe(200);
  expect(jsonPackWrites).toEqual([]);
  expect((await res.json()).activated).toBe(false);
});

test('changing an inherited type is refused before gbrain runs', async () => {
  const calls: string[] = [];
  opsHandler = (op, _p, opts) => {
    calls.push(op);
    if (op === 'schema.list') return ok(LIST_LAYERED);
    if (op === 'schema.showRaw') return ok('', layerRaw());
    if (op === 'schema.show') return ok('', { ...showJson(3, 2, opts?.packOverride), extends: 'mobrain-personal' });
    return ok('');
  };
  const res = await hit('POST', '/api/schema/packs/mobrain-personal/mutations', ownerCookie,
    { mutations: [{ op: 'remove_type', name: 'idea' }] });
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe('INHERITED_READONLY');
  expect(calls).not.toContain('schema.mutate');
});

test('a foreign my-personal is never hijacked', async () => {
  opsHandler = (op, _p, opts) => {
    if (op === 'schema.list') return ok(LIST_LAYERED);
    if (op === 'schema.show') return ok('', { ...showJson(3, 2, opts?.packOverride), extends: 'gbrain-base-v2' });
    return ok('');
  };
  const res = await hit('POST', '/api/schema/packs/mobrain-personal/mutations', ownerCookie,
    { mutations: [{ op: 'add_type', name: 'recipe', primitive: 'media', prefix: 'recipes/' }] });
  expect(res.status).toBe(409);
});
```

If monkey-patching `.push` on the recorder arrays is awkward with the file's mock, change the `mock.module` recorders for `putSchemaPackJson` / `patchFilePlaneConfig` to call optional hooks (`let onJsonPackWrite = () => {}` etc.) and reset them in `beforeEach`. The test's intent stays the same: writing the layer makes it listed, and patching config makes it active.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/integration/schema-routes.test.ts`
Expected: the 4 new tests FAIL (the managed pack is currently mutated in place).

- [ ] **Step 3: Implement**

Restructure the route's opening so that after the name/bundled checks:

```ts
  let target = name;
  let redirected = false;
  const brain = await loadBrain(orgId);
  if (isManagedPack(name)) {
    if (name !== LAYER_PARENT) return c.json({ error: `${name} is read-only` , code: 'PACK_READONLY' }, 400);
    target = LAYER_PACK; redirected = true;
    const { installed: before } = await listSchemaPackSections();
    if (!before.includes(LAYER_PACK)) {
      await putSchemaPackJson(LAYER_PACK, draftToManifest({
        name: LAYER_PACK, description: 'Your changes, layered on top of mobrain-personal.',
        extends: LAYER_PARENT, pageTypes: [], linkVerbs: [],
      }, brain.gbrainVersion ?? '0.50.5.0'));
      invalidateSchemaPackCache();
    } else if ((await effectivePack(brain.gbrainVersion ?? '', LAYER_PACK)).extends !== LAYER_PARENT) {
      return c.json({ error: `${LAYER_PACK} exists and does not extend ${LAYER_PARENT}` }, 409);
    }
  }
  const { installed } = await listSchemaPackSections();
  if (!installed.includes(target)) return c.json({ error: `unknown schema pack ${target}` }, 404);
```

Then validate the body (as today). Then, when `target === LAYER_PACK`, run the inherited guard:

```ts
  if (target === LAYER_PACK) {
    const raw = await callOps<RawManifest>('schema.showRaw', { packName: LAYER_PACK }, { json: true, timeoutMs: 60_000 });
    const ownTypes = new Set((raw.json?.page_types ?? []).map((t) => t.name));
    const ownVerbs = new Set((raw.json?.link_types ?? []).map((l) => l.name));
    const inherited = v.mutations.find((m) => {
      if (m.op === 'add_type' || m.op === 'add_link_type') return false;
      if (m.op === 'remove_link_type') return !ownVerbs.has(m.name);
      const t = 'type' in m ? m.type : m.name;
      return !ownTypes.has(t);
    });
    if (inherited) {
      const t = 'type' in inherited ? inherited.type : inherited.name;
      return c.json({
        error: `${t} comes from ${LAYER_PARENT} and cannot be changed here. Add a new type instead.`,
        code: 'INHERITED_READONLY',
      }, 400);
    }
  }
```

Replace every later use of `name` inside the route (mutate payload, `checkPack`, scaffold filter, audits) with `target`, and remove the second `loadBrain` call (reuse `brain`). After the success audit, add the activation step:

```ts
  let activated = false;
  let activeError: string | null = null;
  if (redirected) {
    const before = await readActive();
    if (before.pack === LAYER_PARENT) {
      await patchFilePlaneConfig({ schema_pack: LAYER_PACK });
      const after = await readActive();
      if (after.pack === LAYER_PACK) {
        await getDb().update(schema.brains).set({ schemaPack: LAYER_PACK, updatedAt: new Date() })
          .where(eq(schema.brains.id, brain.id));
        await audit(orgId, userId, 'schema.apply', LAYER_PACK, { pack: LAYER_PACK, source: after.source, via: 'auto-layer' });
        activated = true;
      } else {
        activeError = `gbrain still resolves ${after.pack ?? 'no pack'} from the "${after.source}" tier, which outranks the config.json value just written.`;
      }
    }
  }
```

and return `{ ok, pack: target, activated, activeError, batchId, applied, error, lint, scaffolded }`. Import `isManagedPack`, `LAYER_PACK`, `LAYER_PARENT` from `'../../contracts/packs.ts'` and `draftToManifest` (already imported). Update the route's doc comment to describe the redirect in one or two sentences.

- [ ] **Step 4: Run the tests**

Run: `bun test test/integration/schema-routes.test.ts`
Expected: all PASS, including the pre-existing mutation tests (`legal-ops` paths must be unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/control/routes/schema.ts test/integration/schema-routes.test.ts
git commit -m "feat(schema): layer edits of mobrain-personal into my-personal" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Console wording and follow-the-layer navigation

**Files:**
- Modify: `src/console/api.ts` (`PackMutateResult` gains `pack: string; activated: boolean; activeError: string | null;`)
- Modify: `src/console/pages/Schema.tsx` (the Edit/Fork button label ~line 238; export a pure `editLabel`)
- Modify: `src/console/pages/SchemaBuilder.tsx` (`PackEditor`: managed note; after save, switch to the layer)
- Modify: `src/console/pages/Schema.tsx:208` (pass `onOpen` so the editor can move to `my-personal`)
- Test: `test/unit/console-schema.test.ts`

**Interfaces:**
- Consumes: `PackDetail.managed` (Task 3); mutation response `pack`, `activated`, `activeError` (Task 4).
- Produces: `export function editLabel(d: Pick<PackDetail, 'bundled' | 'managed'>): string` in `Schema.tsx`, and `export const MANAGED_EDIT_NOTE` in `SchemaBuilder.tsx`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/console-schema.test.ts` (extend its import from `Schema.tsx` with `editLabel`, and import `MANAGED_EDIT_NOTE` from `../../src/console/pages/SchemaBuilder.tsx`):

```ts
describe('edit affordances', () => {
  test('bundled packs fork, managed and user packs edit', () => {
    expect(editLabel({ bundled: true, managed: false })).toBe('Fork to edit');
    expect(editLabel({ bundled: false, managed: true })).toBe('Customize');
    expect(editLabel({ bundled: false, managed: false })).toBe('Edit');
  });

  test('the managed note says where edits go and that updates keep arriving', () => {
    expect(MANAGED_EDIT_NOTE).toContain('my-personal');
    expect(MANAGED_EDIT_NOTE).toMatch(/updates/i);
  });
});
```

Also add `managed: false` to any `PackDetail` fixture in that file that no longer type-checks.

- [ ] **Step 2: Run it to see it fail**

Run: `bun test test/unit/console-schema.test.ts`
Expected: FAIL, `editLabel` is not exported.

- [ ] **Step 3: Implement**

`Schema.tsx`:

```ts
/** Bundled packs are forked; Mobrain's own pack is customized through a layer. */
export function editLabel(d: Pick<PackDetail, 'bundled' | 'managed'>): string {
  if (d.bundled) return 'Fork to edit';
  return d.managed ? 'Customize' : 'Edit';
}
```

Use it for the button at ~line 238. Change the editor mount at ~line 208 to
`<PackEditor name={builder.name} onSaved={() => { void loadPacks(); }} onOpen={(n) => setBuilder({ mode: 'edit', name: n })} />`.

`SchemaBuilder.tsx`:

```ts
export const MANAGED_EDIT_NOTE =
  'mobrain-personal is maintained by Mobrain. Your changes go into my-personal, layered on top, ' +
  'so Mobrain updates still reach you. Types that come from mobrain-personal cannot be removed; add new ones instead.';
```

`PackEditor` accepts `onOpen?: (name: string) => void`. When `detail.effective.managed` is true, render `MANAGED_EDIT_NOTE` as muted text above the editor rows (same styling as other muted notes in the file). In `save`, after `const r = await schemaPacksApi.mutate(name, mutations);`, if `r.pack !== name`, call `onSaved()` then `onOpen?.(r.pack)` and return. If `r.activeError`, show it through the existing `setSaveError({ message: r.activeError, code: null, failedAtIndex: null, packUnchanged: false })` path after `setSaved(r)`. Add the three fields to `PackMutateResult` in `api.ts`.

- [ ] **Step 4: Run the tests**

Run: `bun test test/unit/console-schema.test.ts && bun test test/unit 2>&1 | tail -5`
Expected: PASS; only the 5 baseline failures remain.

- [ ] **Step 5: Type-check the console build**

Run: `bunx vite build 2>&1 | tail -5`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/console test/unit/console-schema.test.ts
git commit -m "feat(console): customize mobrain-personal through the my-personal layer" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Live verification on the dev stack (no brain reset)

**Files:**
- Modify: `docs/schema-pack-findings.md` (append `### S8 live` results)
- Modify: `CHANGELOG.md` (one entry under the unreleased section, matching its style)

- [ ] **Step 1: Rebuild and restart the stack from this worktree**

Read `.claude/skills/redeploy/SKILL.md` in this worktree (or the main checkout's `.claude/skills/redeploy/SKILL.md` if absent) and follow its `--full` path, because `src/ops/server.ts` changed and gbrain-ops runs the control-plane image. Run the compose commands from this worktree so the image is built from this branch.

- [ ] **Step 2: Verify seeding**

```bash
docker logs mobrain-local-gbrain-ops-1 2>&1 | grep "schema pack"
docker exec mobrain-local-gbrain-ops-1 gbrain schema list
docker exec mobrain-local-gbrain-ops-1 gbrain schema validate mobrain-personal
docker exec -e GBRAIN_SCHEMA_PACK=mobrain-personal mobrain-local-gbrain-ops-1 gbrain schema show --json | grep -c '"primitive"'
docker exec mobrain-local-gbrain-ops-1 gbrain schema active
```

Expected: a log line `schema pack mobrain-personal: written` (or `unchanged` on a second boot); `mobrain-personal` under Installed packs; validate ✓ with 20 page types and 21 link verbs; the grep count is 20. The active pack is unchanged from before the deploy (spec P9: no auto-migration). Restart gbrain-ops once more and confirm the log says `unchanged`.

- [ ] **Step 3: Verify the console API**

Sign in to the console in a browser or with curl against `/api/schema/packs` using the owner session. Confirm the pack list is `gbrain-base-v2` and `mobrain-personal`, plus the brain's active pack if it is something else. Do **not** click Customize or Apply on the live brain.

- [ ] **Step 4: Record, update the changelog, commit**

Append the observed output to `docs/schema-pack-findings.md` under `### S8 live`. Add a CHANGELOG entry: `mobrain-personal is the default schema pack for new brains; the Schema page lists only mobrain-personal and gbrain-base-v2; edits to mobrain-personal go into an auto-created my-personal layer.`

```bash
git add docs/schema-pack-findings.md CHANGELOG.md
git commit -m "docs(schema): record the mobrain-personal live verification" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
