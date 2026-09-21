# Schema Pack Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the admin's schema-pack choice real — persisted in the control DB, applied to gbrain at init, and editable after setup through a Schema admin page that lints, previews and applies pack changes with audit logging.

**Architecture:** Three seams, each already established in this repo. (1) The pack *file* is written through the existing lock-serialized file-plane writer in `src/ops/fileplane.ts` — fixed to emit gbrain's real `<name>/pack.yaml` directory shape. (2) The pack *selection* is written as tier-6 `schema_pack` in `config.json` through `patchFilePlaneConfig`, never through `gbrain schema use` (which is a second unserialized writer to that file), and every apply ends with a `gbrain schema active` readback that must agree or the route reports divergence instead of success. (3) Two new allowlisted operations (`schema.active`, `schema.validate`) plus a `schemaPack` param on the existing `init` entry, each with a contract test, per G4.

**Tech Stack:** Bun, TypeScript, Hono (control routes), Drizzle ORM + Postgres (control DB), React 19 + Tailwind 4 (console), `bun test`, Docker Compose.

**Spec:** `docs/schema-pack-findings.md` — the empirical investigation this plan implements. Read it first; it records what was MEASURED against the live pinned container and why several obvious-looking approaches are wrong.

## Global Constraints

- **Pinned gbrain version is `0.50.5.0`.** Every CLI claim in this plan was verified against it. Do not assume any other version's behavior.
- **S2 — the control plane never holds brain DB credentials.** It reaches gbrain only through `callOps` / the `/fileplane/*` RPCs in `src/control/opsClient.ts`. Never add a direct `gbrain` invocation or a `GBRAIN_DATABASE_URL` to control-plane code.
- **S3 — `writeFilePlane` in `src/ops/fileplane.ts` is the single serialized writer to the file plane.** Every `config.json` and schema-pack write goes through it, under the control-DB advisory lock. Do not add `gbrain schema use` as an operation; it is an unlocked read-modify-write of the same file.
- **S3c — never log or echo a raw request body.** `audit()`'s `after` argument is a redacted summary. Never put a pack's YAML body, or an API key, into an audit row or a response.
- **G4 — every new entry in `src/contracts/registry.ts` needs a contract test** asserting flag acceptance, `--json` shape and exit codes at the pinned version. Adding an entry without one is not allowed.
- **Honesty rule 5 — never render a partial success green.** If `schema active` reports a pack or tier other than the one we asked for, that is a divergence to surface, not a success to round up.
- **`--json` support, verified per command:** `schema.lint` and `schema.sync` DO support it. `schema.list`, `schema.active` and `schema.validate` DO NOT — they accept the flag and ignore it, and for `validate` a *leading* `--json` is misparsed as the pack name. Positional pack names must be emitted before any flag; `buildArgv` emits params in array order and appends `--json` last.
- **Pack name shape:** `/^[a-z0-9][a-z0-9-]{0,63}$/` for names we accept from an admin (the existing `writeSchemaPack` guard). gbrain's own manifest regex is the looser `/^[a-z0-9._-]+$/`; keep ours stricter — it is also the directory name.
- **Do not edit `C:\Users\juanp\Desktop\gbrain`.** It is a read-only reference checkout.

---

## File Structure

**Created:**
- `src/control/db/migrations/0009_brain_schema_pack.sql` — adds `brains.schema_pack`.
- `src/control/routes/schema.ts` — the Schema admin API (list / validate / lint / preview / apply / sync / upload).
- `src/console/pages/Schema.tsx` — the Schema admin console page.
- `test/unit/schema-active.test.ts` — unit tests for the `schema active` prose parser.
- `test/unit/console-schema.test.ts` — unit tests for the console page.
- `test/integration/schema-routes.test.ts` — integration tests for the new routes.
- `test/contract/schema.contract.test.ts` — contract tests for `schema.active`, `schema.validate` and `init --schema-pack` at the pin.

**Modified:**
- `src/ops/fileplane.ts:191-194` — fix `writeSchemaPack` to the `<name>/pack.yaml` directory shape.
- `src/control/db/schema.ts:91-102` — add the `schemaPack` column.
- `src/contracts/registry.ts` — add `schema.active`, `schema.validate`; add the `schemaPack` param to `init`.
- `src/contracts/capability.ts` — add `parseSchemaActiveProse`.
- `src/control/routes/wizard.ts:161-169, 207-255` — persist the pack, pass it to `init`.
- `src/control/app.ts` — mount the schema routes.
- `src/console/App.tsx` — add the Schema nav entry and page.
- `test/unit/fileplane.test.ts` — assert the new pack path shape.
- `test/unit/wizard-finish.test.ts` — assert the pack reaches `init`.

---

### Task 1: Fix the schema-pack file-plane write shape

`writeSchemaPack` writes `<dir>/<name>.yaml`. gbrain only discovers
`<dir>/<name>/pack.yaml`. MEASURED: the flat form is invisible to
`schema list`, `schema validate` and `schema lint` (see findings S1).
This helper has no production callers yet, so this is a prerequisite fix,
not a regression repair.

**Files:**
- Modify: `src/ops/fileplane.ts:190-194`
- Test: `test/unit/fileplane.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `writeSchemaPack(name: string, yaml: string, opts: { sql: SQL }): Promise<void>` — unchanged signature, corrected path. Also exports `packPath(name: string): string`, the absolute `pack.yaml` path, which exists so the unit test can assert the shape without duplicating the join. No later task imports it.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/fileplane.test.ts`:

```ts
import { packPath, SCHEMA_PACK_DIR } from '../../src/ops/fileplane.ts';
import { join } from 'node:path';

test('a user pack is written as <name>/pack.yaml, the only shape gbrain discovers', () => {
  // gbrain's defaultPackLocator probes pack.yaml/pack.yml/pack.json INSIDE a
  // directory named after the pack (src/core/schema-pack/load-active.ts).
  // A flat <name>.yaml is never listed and never loadable — MEASURED against
  // the pinned container; see docs/schema-pack-findings.md S1.
  expect(packPath('hr-policies')).toBe(join(SCHEMA_PACK_DIR, 'hr-policies', 'pack.yaml'));
  expect(packPath('hr-policies')).not.toBe(join(SCHEMA_PACK_DIR, 'hr-policies.yaml'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/fileplane.test.ts`
Expected: FAIL — `export named 'packPath' not found in module` (or similar import error).

- [ ] **Step 3: Write the implementation**

Replace `src/ops/fileplane.ts:190-194` with:

```ts
/**
 * Absolute path of a user pack's manifest.
 *
 * gbrain discovers a user pack ONLY as a directory named after the pack with
 * `pack.yaml` / `pack.yml` / `pack.json` inside it (`defaultPackLocator`,
 * src/core/schema-pack/load-active.ts; `runList` enumerates subdirectories the
 * same way). MEASURED against the pinned 0.50.5.0 container: a flat
 * `<name>.yaml` written here is invisible to `schema list` and answers
 * `Pack not found: <name>` from `schema lint`. See
 * docs/schema-pack-findings.md S1.
 */
export function packPath(name: string): string {
  return join(SCHEMA_PACK_DIR, name, 'pack.yaml');
}

/** Write a user schema pack manifest. 0644: gbrain reads it as another user. */
export async function writeSchemaPack(name: string, yaml: string, opts: { sql: SQL }): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error(`invalid schema pack name: ${name}`);
  await writeFilePlane(packPath(name), () => yaml, { ...opts, mode: 0o644 });
}
```

`atomicWrite` already does `mkdir(dirname(path), { recursive: true })`
(`fileplane.ts:113`), so the per-pack directory is created for free.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/fileplane.test.ts`
Expected: PASS, including the existing path-traversal test (`writeSchemaPack('../../etc/passwd', …)` still rejects on the name guard, which runs before `packPath`).

- [ ] **Step 5: Commit**

```bash
git add src/ops/fileplane.ts test/unit/fileplane.test.ts
git commit -m "$(cat <<'EOF'
fix(ops): user schema packs need <name>/pack.yaml, not <name>.yaml

gbrain's defaultPackLocator only probes pack.yaml/pack.yml/pack.json inside a
directory named after the pack. Measured against the pinned 0.50.5.0 container:
the flat shape this wrote is invisible to `schema list` and answers
`Pack not found` from `schema lint`. No production callers yet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Persist the chosen pack on `schema.brains`

Mirrors how `searchMode` and `embeddingModel` are already stored.

**Files:**
- Modify: `src/control/db/schema.ts:91-102`
- Create: `src/control/db/migrations/0009_brain_schema_pack.sql`
- Modify: `src/control/db/migrations/meta/_journal.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `schema.brains.schemaPack` — a nullable `text` column named `schema_pack`. Read as `brain.schemaPack: string | null`.

- [ ] **Step 1: Add the column to the Drizzle schema**

In `src/control/db/schema.ts`, inside the `brains` table definition, add
after the `searchMode` line:

```ts
  searchMode: text('search_mode'),
  /**
   * The schema pack the admin chose: what kinds of pages the brain
   * recognizes. Stored the same way searchMode is, and passed to
   * `gbrain init --schema-pack` at /wizard/finish.
   *
   * This is INTENT, not resolved truth. gbrain resolves the active pack
   * through a 7-tier chain in which a brain-DB-plane value (tier 4) silently
   * outranks the ~/.gbrain/config.json value we write (tier 6). Always read
   * the truth back with `gbrain schema active` and surface any divergence
   * rather than trusting this column — see docs/schema-pack-findings.md S2.
   */
  schemaPack: text('schema_pack'),
```

- [ ] **Step 2: Write the migration**

Create `src/control/db/migrations/0009_brain_schema_pack.sql`:

```sql
-- The wizard's schema-pack step accepted a pack name and threw it away: no
-- column, no gbrain call. This is the column half of closing that no-op.
-- Nullable and un-backfilled on purpose: an existing brain's real active pack
-- is whatever `gbrain schema active` resolves (gbrain init defaults new brains
-- to gbrain-base-v2), and inventing a value here would assert something we
-- have not read. The Schema page adopts the resolved pack into this column the
-- first time an admin applies one.
ALTER TABLE "brains" ADD COLUMN "schema_pack" text;
```

- [ ] **Step 3: Register the migration in the journal**

In `src/control/db/migrations/meta/_journal.json`, append to the `entries`
array (after the `0008_search_mode_vocabulary` entry):

```json
    {
      "idx": 9,
      "version": "7",
      "when": 1790000000000,
      "tag": "0009_brain_schema_pack",
      "breakpoints": true
    }
```

- [ ] **Step 4: Verify the migration applies**

Run: `bun test test/integration/schema.test.ts`
Expected: PASS. If that suite does not exercise migrations, verify directly:

```bash
docker exec brainstand-postgres-1 psql -U gbrain -d control -c '\d brains'
```
Expected: after the stack applies migrations, a `schema_pack | text` row appears.

- [ ] **Step 5: Commit**

```bash
git add src/control/db/schema.ts src/control/db/migrations/
git commit -m "$(cat <<'EOF'
feat(db): persist the chosen schema pack on brains

Mirrors search_mode/embedding_model. Nullable and un-backfilled: the resolved
active pack is what `gbrain schema active` says, not something to invent here.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Register `schema.active`, `schema.validate` and `init --schema-pack`

Three additions to the ops contract layer, plus the prose parser
`schema active` needs because it ignores `--json`.

**Files:**
- Modify: `src/contracts/registry.ts`
- Modify: `src/contracts/capability.ts`
- Create: `test/unit/schema-active.test.ts`
- Create: `test/contract/schema.contract.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `OPERATIONS['schema.active']` — `gbrain schema active`, no params, `supportsJson: false`.
  - `OPERATIONS['schema.validate']` — `gbrain schema validate [PACK_NAME]`, one optional positional `packName`, `supportsJson: false`.
  - `OPERATIONS.init` gains a `schemaPack` param mapping to `--schema-pack`.
  - `parseSchemaActiveProse(raw: string): SchemaActive` where
    `type SchemaActive = { pack: string | null; version: string | null; source: string | null; identity: string | null; pageTypes: number | null; linkVerbs: number | null; raw: string }`.

- [ ] **Step 1: Write the failing parser test**

Create `test/unit/schema-active.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { parseSchemaActiveProse } from '../../src/contracts/capability.ts';

// Verbatim stdout from `gbrain schema active` on the pinned 0.50.5.0
// container. `--json` is accepted and IGNORED (byte-identical output), so
// this prose is the only machine-readable surface there is.
const REAL = `Active pack: gbrain-base-v2 v1.2.0
Source: home-config
Pack identity: gbrain-base-v2@1.2.0+1a2aee67
Page types: 19
Link verbs: 17
Takes kinds: fact, take, bet, hunch

14-type DRY/MECE canonical taxonomy + \`note\` catch-all (15 total).
`;

test('parses the real schema active prose', () => {
  const a = parseSchemaActiveProse(REAL);
  expect(a.pack).toBe('gbrain-base-v2');
  expect(a.version).toBe('1.2.0');
  expect(a.source).toBe('home-config');
  expect(a.identity).toBe('gbrain-base-v2@1.2.0+1a2aee67');
  expect(a.pageTypes).toBe(19);
  expect(a.linkVerbs).toBe(17);
});

test('parses a db-config tier, which is the one that shadows our write', () => {
  const a = parseSchemaActiveProse('Active pack: dirpack v1.0.0\nSource: db-config\n');
  expect(a.pack).toBe('dirpack');
  expect(a.source).toBe('db-config');
});

test('a user pack name with hyphens and digits survives', () => {
  const a = parseSchemaActiveProse('Active pack: hr-policies-2 v0.3.1\nSource: home-config\n');
  expect(a.pack).toBe('hr-policies-2');
  expect(a.version).toBe('0.3.1');
});

test('unparseable output yields nulls and keeps the raw text, never throws', () => {
  const a = parseSchemaActiveProse('Error: no brain configured\n');
  expect(a.pack).toBeNull();
  expect(a.source).toBeNull();
  expect(a.raw).toContain('no brain configured');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/schema-active.test.ts`
Expected: FAIL — `parseSchemaActiveProse` is not exported.

- [ ] **Step 3: Write the parser**

Append to `src/contracts/capability.ts`, after `parseSchemaPacksProse`:

```ts
/**
 * `gbrain schema active` — the ONLY honest readback of which pack the engine
 * will actually query with.
 *
 * Two reasons this is prose-parsed rather than JSON. (1) `schema active`
 * ignores `--json` exactly the way `schema list` does — MEASURED at the pin,
 * `gbrain schema active` and `gbrain schema active --json` emit byte-identical
 * stdout, despite `schema --help` claiming "All new verbs accept --json".
 * (2) `gbrain config get schema_pack` is NOT a substitute: with a DB-plane
 * value set it prints the FILE value plus the note "a DB-plane value also
 * exists and is shadowed at runtime", which is backwards — tier 4 (DB) OUTRANKS
 * tier 6 (file) in resolveActivePackName. See docs/schema-pack-findings.md S2.
 *
 * `source` is the resolution tier, one of: per-call, env, per-source-db,
 * db-config, gbrain-yml, home-config, default. We write home-config, so any
 * other value on an apply is a divergence to surface, never to round up.
 *
 * Never throws: an unparseable response yields nulls and keeps `raw`.
 */
export type SchemaActive = {
  pack: string | null;
  version: string | null;
  source: string | null;
  identity: string | null;
  pageTypes: number | null;
  linkVerbs: number | null;
  raw: string;
};

export function parseSchemaActiveProse(raw: string): SchemaActive {
  const text = raw ?? '';
  const num = (re: RegExp): number | null => {
    const m = text.match(re);
    if (!m) return null;
    const n = Number.parseInt(m[1]!, 10);
    return Number.isFinite(n) ? n : null;
  };
  const activeLine = text.match(/^\s*Active pack:\s*(\S+)\s+v(\S+)\s*$/m);
  return {
    pack: activeLine?.[1] ?? null,
    version: activeLine?.[2] ?? null,
    source: text.match(/^\s*Source:\s*(\S+)\s*$/m)?.[1] ?? null,
    identity: text.match(/^\s*Pack identity:\s*(\S+)\s*$/m)?.[1] ?? null,
    pageTypes: num(/^\s*Page types:\s*(\d+)\s*$/m),
    linkVerbs: num(/^\s*Link verbs:\s*(\d+)\s*$/m),
    raw: text,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/schema-active.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the two registry entries**

In `src/contracts/registry.ts`, immediately after the `schema.list` entry, add:

```ts
  /**
   * The honest readback for which pack the engine actually resolves. Prose
   * only: MEASURED at 0.50.5.0, `gbrain schema active` and
   * `gbrain schema active --json` emit byte-identical stdout — `runActive`
   * takes `_args` and never reads it, the same defect shape as `schema list`
   * (Work Item K). `schema --help`'s blanket "All new verbs accept --json" is
   * wrong. supportsJson is false so a caller cannot ask for a structured reply
   * this command will never give; parse it with `parseSchemaActiveProse`.
   *
   * This is the ONLY command that reports the resolution TIER, which is what
   * makes it load-bearing: a brain-DB-plane `schema_pack` (tier 4) silently
   * outranks the ~/.gbrain/config.json value we write (tier 6), and
   * `gbrain schema use` will report success while changing nothing in that
   * state (MEASURED). `gbrain config get schema_pack` cannot be used instead —
   * its shadowing note is inverted. See docs/schema-pack-findings.md S2.
   *
   * Reads DB config for tier 4, so: brain-db.
   */
  'schema.active': {
    id: 'schema.active',
    argv: ['schema', 'active'],
    params: [],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * Manifest-shape validation for one pack. The companion to `schema.lint`,
   * and NOT redundant with it: MEASURED at the pin, `schema lint <name>` on a
   * pack that exists but fails to parse answers the misleading
   * `Pack not found: <name>` — `runLintCmd` swallows the loader exception
   * (`catch { raw = null; }`) — while `schema validate <name>` gives the real
   * diagnosis, e.g. `manifest validation failed: page_types.0.primitive:
   * Invalid option: expected one of "entity"|"media"|...`. An admin needs the
   * second message, so the console runs both.
   *
   * Grammar: the pack name is a POSITIONAL and optional (absent falls back to
   * gbrain-base, NOT to the active pack — `runValidate` hardcodes
   * `packPathByName('gbrain-base')`, schema.ts:329). supportsJson is false for
   * two compounding reasons: `runValidate` reads `args[0]` raw and never calls
   * `parseFlags`, so a LEADING `--json` is misparsed as the pack name and exits
   * 1 (MEASURED: `schema validate --json dirpack` → exit 1), while a TRAILING
   * `--json` is silently ignored and prose is printed anyway (MEASURED:
   * `schema validate dirpack --json` → exit 0, prose). Exit 0 = valid,
   * 1 = unknown pack or invalid manifest; the caller reads stdout/stderr for
   * the reason.
   */
  'schema.validate': {
    id: 'schema.validate',
    argv: ['schema', 'validate'],
    params: [
      { name: 'packName', flag: '', kind: 'value' },
    ],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'read-only',
    okExitCodes: [0],
  },
```

- [ ] **Step 6: Add the `schemaPack` param to `init`**

In `src/contracts/registry.ts`, in the `init` entry's `params` array, append
after `embeddingDimensions`:

```ts
      /**
       * UNDOCUMENTED but allowlisted and honored. `gbrain init --help` does
       * not list it, but it is in the per-command flag allowlist — MEASURED at
       * 0.50.5.0: `gbrain init --schema-pack` (no value) answers
       * `--schema-pack requires a value`, whereas `gbrain init --bogus-flag`
       * answers `unknown flag --bogus-flag for 'gbrain init'`. Run with a value
       * it prints `[init] Using schema pack: <name>` and the choice takes
       * effect (src/commands/init.ts:53-56, 1346, 1687).
       *
       * This is where the wizard's pack choice has to land, not a post-init
       * `config set`: init WRITES config.json's schema_pack itself, defaulting
       * new brains to `gbrain-base-v2`, so anything written beforehand is
       * stamped over — and the pack must already be active when `sync` runs
       * for imported pages to be typed by it.
       */
      { name: 'schemaPack', flag: '--schema-pack', kind: 'value' },
```

- [ ] **Step 7: Write the contract test**

Create `test/contract/schema.contract.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { execOperation, assertOk } from '../../src/contracts/exec.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { buildArgv } from '../../src/contracts/argv.ts';
import { parseSchemaActiveProse } from '../../src/contracts/capability.ts';
import { composeUp, composeDown, resetBrain, BRAIN_DB_URL } from '../helpers/stack.ts';

beforeAll(async () => {
  await composeUp();
  await resetBrain();
  // Pin the pack at init: this is both the setup AND the assertion target for
  // the `--schema-pack` contract test below.
  const r = await execOperation(OPERATIONS.init!, {
    nonInteractive: true, force: true, url: BRAIN_DB_URL,
    embeddingModel: 'openai:text-embedding-3-small',
    schemaPack: 'gbrain-base',
  }, { timeoutMs: 600_000 });
  assertOk(OPERATIONS.init!, r);
}, 900_000);
afterAll(async () => { await composeDown(); }, 120_000);

test('init --schema-pack is accepted and actually selects the pack', async () => {
  // The flag is undocumented in `gbrain init --help` but allowlisted. If a
  // version bump ever drops it, init would exit 2 on an unknown flag and
  // beforeAll's assertOk would have already failed — this asserts the EFFECT.
  const active = await execOperation(OPERATIONS['schema.active']!, {});
  assertOk(OPERATIONS['schema.active']!, active);
  expect(parseSchemaActiveProse(active.stdout).pack).toBe('gbrain-base');
});

test('schema active reports the resolution tier, and ignores --json', async () => {
  const r = await execOperation(OPERATIONS['schema.active']!, {});
  assertOk(OPERATIONS['schema.active']!, r);
  const a = parseSchemaActiveProse(r.stdout);
  expect(a.pack).toBeTruthy();
  // init writes ~/.gbrain/config.json, which is tier 6.
  expect(a.source).toBe('home-config');
  expect(a.pageTypes).toBeGreaterThan(0);

  // The registry must keep refusing --json: the command accepts and ignores it.
  expect(() => buildArgv(OPERATIONS['schema.active']!, {}, { json: true }))
    .toThrow(/does not support --json/);
});

test('schema validate accepts a bundled pack name as a positional', async () => {
  const r = await execOperation(OPERATIONS['schema.validate']!, { packName: 'gbrain-recommended' });
  assertOk(OPERATIONS['schema.validate']!, r);
  expect(r.stdout).toContain('valid manifest');
});

test('schema validate exits 1 on an unknown pack', async () => {
  const r = await execOperation(OPERATIONS['schema.validate']!, { packName: 'no-such-pack-xyz' });
  expect(r.exitCode).toBe(1);
  expect(r.stdout + r.stderr).toMatch(/Unknown pack/i);
});

test('schema lint still needs the pack name BEFORE --with-db', async () => {
  // Regression fence for Work Item S: `--with-db` with no positional is
  // swallowed as positional[0] and answers `Pack not found: --with-db`.
  // buildArgv emits params in array order, so packName must stay listed first.
  const argv = buildArgv(OPERATIONS['schema.lint']!, { packName: 'gbrain-base', withDb: true }, { json: true });
  expect(argv).toEqual(['schema', 'lint', 'gbrain-base', '--with-db', '--json']);
});

test('schema sync previews without --apply and still refuses --dry-run', async () => {
  const r = await execOperation(OPERATIONS['schema.sync']!, {}, { json: true });
  assertOk(OPERATIONS['schema.sync']!, r);
  const body = r.json as { apply: boolean; total_applied: number } | null;
  expect(body?.apply).toBe(false);
  expect(body?.total_applied).toBe(0);

  expect(() => buildArgv(OPERATIONS['schema.sync']!, {}, { dryRun: true }))
    .toThrow(/does not support --dry-run/);
});
```

- [ ] **Step 8: Run the contract test**

Run: `bun run test:contract:isolated test/contract/schema.contract.test.ts`
Expected: PASS (6 tests). This brings the stack up and tears it down; allow several minutes.

- [ ] **Step 9: Commit**

```bash
git add src/contracts/ test/unit/schema-active.test.ts test/contract/schema.contract.test.ts
git commit -m "$(cat <<'EOF'
feat(contracts): add schema.active, schema.validate and init --schema-pack

schema.active is the only honest readback of the resolved pack and its tier;
a DB-plane value silently outranks the file-plane one we write, and both
`schema use` and `config get schema_pack` misreport that state. Both new verbs
ignore --json (validate misparses a leading one as the pack name), so they are
registered supportsJson:false and prose-parsed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Close the wizard's no-op

`wizard.post('/schema')` accepts a pack name, audits it and discards it.
`/finish` never mentions a pack. Two lines of real change, plus tests.

**Files:**
- Modify: `src/control/routes/wizard.ts:161-169` (the `/schema` handler)
- Modify: `src/control/routes/wizard.ts:207-255` (the `/finish` handler)
- Modify: `src/control/routes/wizard.ts:69-82` (the `/state` handler)
- Test: `test/unit/wizard-finish.test.ts`, `test/integration/wizard.test.ts`

**Interfaces:**
- Consumes: `schema.brains.schemaPack` (Task 2); `OPERATIONS.init.params.schemaPack` (Task 3).
- Produces: `/api/wizard/state` response gains `schemaPack: string | null`. `/finish`'s `init` step passes `schemaPack`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/wizard-finish.test.ts`:

```ts
test('finish passes the stored schema pack to init', () => {
  // The pack has to reach `init`, not a later `config set`: init writes
  // config.json's schema_pack itself (defaulting to gbrain-base-v2) and would
  // stamp over anything written first, and the pack must already be active
  // when `sync` runs for imported pages to be typed by it.
  const argv = buildArgv(OPERATIONS.init!, {
    nonInteractive: true,
    force: true,
    embeddingModel: 'openai:text-embedding-3-small',
    schemaPack: 'gbrain-recommended',
  });
  expect(argv).toContain('--schema-pack');
  expect(argv[argv.indexOf('--schema-pack') + 1]).toBe('gbrain-recommended');
});

test('finish omits --schema-pack entirely when no pack was chosen', () => {
  // An absent value must not become an empty string: `gbrain init
  // --schema-pack ""` would set a pack name of "" rather than fall back to
  // init's own default.
  const argv = buildArgv(OPERATIONS.init!, {
    nonInteractive: true, force: true, embeddingModel: 'openai:text-embedding-3-small',
  });
  expect(argv).not.toContain('--schema-pack');
});
```

Ensure the file imports `buildArgv` from `../../src/contracts/argv.ts` and
`OPERATIONS` from `../../src/contracts/registry.ts`; add the imports if absent.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/wizard-finish.test.ts`
Expected: FAIL — `unknown param schemaPack for init` (thrown by `buildArgv`) if Task 3 is not yet merged; if Task 3 is merged, this pair passes immediately and serves as the fence for Step 3.

- [ ] **Step 3: Persist the pack in the `/schema` handler**

Replace the `/schema` handler at `src/control/routes/wizard.ts:161-169`:

```ts
/**
 * Step 3 — schema pack.
 *
 * The pack is PERSISTED here and APPLIED at /finish via
 * `gbrain init --schema-pack`. It deliberately is not applied here: at this
 * point in the wizard the brain has not been init'd, and `init` writes
 * config.json's `schema_pack` itself (defaulting to `gbrain-base-v2`), so a
 * pre-init write would simply be stamped over. See
 * docs/schema-pack-findings.md S2.
 *
 * Validated against gbrain's own pack list rather than a hardcoded set, so a
 * user-installed pack is selectable the moment it is on disk.
 */
wizard.post('/schema', guard(async (c, { userId, orgId }) => {
  const { pack } = await c.req.json();
  if (!pack || typeof pack !== 'string') return c.json({ error: 'pack is required' }, 400);

  const known = await listSchemaPacks();
  if (!known.includes(pack)) {
    return c.json({ error: `unknown schema pack ${pack}`, packs: known }, 400);
  }

  const brain = await loadBrain(orgId);
  await advance(brain.id, brain.lifecycle as Lifecycle, 'schema-selected', { schemaPack: pack });
  await audit(orgId, userId, 'wizard.schema', pack, { pack });
  return c.json({ ok: true, lifecycle: 'schema-selected', pack });
}));
```

- [ ] **Step 4: Extract the pack-list parser so both routes share it**

Replace the body of the `/schema-packs` handler
(`src/control/routes/wizard.ts:146-159`) with a call to a shared helper, and
define the helper above it. Keep the existing doc comment on the route.

```ts
/**
 * Every pack gbrain will accept: bundled plus user-installed. Prose-parsed
 * because `schema list` ignores `--json` (Work Item K) — asking for it throws
 * in buildArgv. Both the wizard step and the Schema admin page validate
 * against this, so an unknown name is refused before it reaches gbrain.
 */
export async function listSchemaPacks(): Promise<string[]> {
  const r = await callOps<never>('schema.list', {}, { timeoutMs: 60_000 });
  const packs: string[] = [];
  let section: 'none' | 'bundled' | 'installed' = 'none';
  for (const line of (r.stdout ?? '').split('\n')) {
    if (/^\s*Bundled packs:\s*$/.test(line)) { section = 'bundled'; continue; }
    if (/^\s*Installed packs\b/.test(line)) { section = 'installed'; continue; }
    if (section === 'none') continue;
    const t = line.trim();
    // A blank line ends a block; the "No user-installed packs" sentence is
    // prose, not a pack name.
    if (t === '') { section = 'none'; continue; }
    if (/^No user-installed packs/.test(t)) { section = 'none'; continue; }
    packs.push(t);
  }
  return packs;
}
```

Then the route becomes:

```ts
wizard.get('/schema-packs', guard(async (c) => {
  return c.json({ packs: await listSchemaPacks() });
}));
```

- [ ] **Step 5: Surface the stored pack in `/state`**

In the `/state` handler (`src/control/routes/wizard.ts:69-82`), add to the
returned object, after `embeddingModel`:

```ts
    schemaPack: brain.schemaPack,
```

- [ ] **Step 6: Pass the pack to init in `/finish`**

In the `/finish` handler, replace the `init` call
(`src/control/routes/wizard.ts:~228`) with:

```ts
  await run('init', 'init', {
    nonInteractive: true,
    force: true,
    embeddingModel: brain.embeddingModel ?? 'openai:text-embedding-3-small',
    // Undocumented but allowlisted (see the registry entry). Omitted entirely
    // when unset so init falls back to its own gbrain-base-v2 default rather
    // than being handed an empty pack name.
    ...(brain.schemaPack ? { schemaPack: brain.schemaPack } : {}),
  });
```

- [ ] **Step 7: Record the resolved pack in the finish audit**

In `/finish`, after the `doctor` step and before computing `ok`, add:

```ts
  // Honesty: report the pack the engine actually RESOLVED, not the one we
  // asked for. A brain-DB-plane schema_pack (tier 4) outranks the
  // config.json value init writes (tier 6), so these can legitimately differ.
  const activeRaw = await callOps<never>('schema.active', {}, { timeoutMs: 60_000 });
  const active = parseSchemaActiveProse(activeRaw.stdout ?? '');
```

and change the audit call to:

```ts
  await audit(orgId, userId, 'wizard.finish', brain.id, {
    steps,
    doctorExit: doctor.exitCode,
    schemaPackRequested: brain.schemaPack ?? null,
    schemaPackResolved: active.pack,
    schemaPackSource: active.source,
  });
```

and the response to:

```ts
  return c.json({
    ok, lifecycle: ok ? 'ready' : brain.lifecycle, steps,
    schemaPack: { requested: brain.schemaPack ?? null, resolved: active.pack, source: active.source },
  }, ok ? 200 : 500);
```

Add the import at the top of the file:

```ts
import { parseSchemaActiveProse } from '../../contracts/capability.ts';
```

- [ ] **Step 8: Run the tests**

Run: `bun test test/unit/wizard-finish.test.ts test/integration/wizard.test.ts`
Expected: PASS. `test/integration/wizard.test.ts` stubs `callOps`; if its stub does not answer `schema.active` or `schema.list`, extend the stub so `schema.list` returns the bundled-pack prose and `schema.active` returns the `Active pack: … / Source: home-config` prose, rather than loosening the route.

- [ ] **Step 9: Commit**

```bash
git add src/control/routes/wizard.ts test/unit/wizard-finish.test.ts test/integration/wizard.test.ts
git commit -m "$(cat <<'EOF'
fix(wizard): the schema-pack step was a no-op

/schema accepted a pack name, audited it and discarded it; /finish never
mentioned a pack, so every brain silently got init's gbrain-base-v2 default.
Now the choice is validated against gbrain's own pack list, stored on
brains.schema_pack, and applied via `gbrain init --schema-pack` — before sync,
so imported pages are typed by it. /finish reports the RESOLVED pack and its
tier, which can differ from the requested one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The Schema admin API

Post-setup pack management: inspect, upload a custom pack, validate, lint,
preview a sync, apply a pack, run the sync.

**Files:**
- Create: `src/control/routes/schema.ts`
- Modify: `src/control/app.ts`
- Modify: `src/control/opsClient.ts` (no change needed to `putSchemaPack`; verify its shape)
- Test: `test/integration/schema-routes.test.ts`

**Interfaces:**
- Consumes: `listSchemaPacks()` from `src/control/routes/wizard.ts` (Task 4); `parseSchemaActiveProse` / `SchemaActive` (Task 3); `schema.brains.schemaPack` (Task 2); `putSchemaPack` and `patchFilePlaneConfig` from `src/control/opsClient.ts`.
- Produces: `export const schemaRoutes: Hono`, mounted at `/api`, exposing
  `GET /schema`, `POST /schema/validate`, `POST /schema/lint`,
  `POST /schema/preview`, `POST /schema/apply`, `POST /schema/sync`,
  `PUT /schema/pack`.

- [ ] **Step 1: Write the failing integration test**

Create `test/integration/schema-routes.test.ts`. The header below copies the
harness `test/integration/routes.test.ts` already uses: a `mock.module` of
`src/control/opsClient.ts` declared BEFORE the dynamic `import` of the app, a
`signIn` that reads the `set-cookie` header, and a `hit(method, path, cookie,
body)` request helper.

**Critical**, and the reason the mock below lists exports it does not use:
under per-file isolation `mock.module` REPLACES the module, so every export the
app graph imports must exist here or the graph fails to load (the Slice 4
hazard called out at `test/integration/routes.test.ts:80-86`). Copy the full
export list from that file verbatim and override only `callOps`,
`patchFilePlaneConfig` and `putSchemaPack`.

```ts
import { test, expect, beforeAll, beforeEach, mock } from 'bun:test';

const PASS = 'correct-horse-battery-staple-1';

// The ops seam. Each test sets `opsHandler` to decide what gbrain "answers".
type OpsReply = { ok: boolean; exitCode: number; stdout: string; stderr: string; json: unknown };
let opsHandler: (op: string, params: Record<string, unknown>) => OpsReply;
const filePlanePatches: Record<string, unknown>[] = [];
const packWrites: { name: string; yaml: string }[] = [];

mock.module('../../src/control/opsClient.ts', () => ({
  // --- the three this suite drives ---
  callOps: async (op: string, params: Record<string, unknown> = {}) => opsHandler(op, params),
  patchFilePlaneConfig: async (patch: Record<string, unknown>) => { filePlanePatches.push(patch); },
  putSchemaPack: async (name: string, yaml: string) => { packWrites.push({ name, yaml }); },
  // --- the rest of the module's real exports, required for the app graph to
  //     load at all under per-file isolation. Copy verbatim from
  //     test/integration/routes.test.ts and keep in sync with opsClient.ts. ---
  brainUsage: async () => { throw new Error('ops unreachable'); },
  seedSpace: async () => {},
  resetBrainSchema: async () => {},
  takeGrantCredentials: async () => ({}),
  opsHealthy: async () => true,
  commitAsMember: async () => ({ committed: true, sha: 'abc123' }),
  inspectRepos: async () => [],
  writeReport: async () => ({ relPath: '', committed: false, sha: null }),
  cancelRun: async () => ({ cancelled: false }),
  deleteCredentialJournal: async () => ({ deleted: true }),
  gitRange: async () => ({ commits: [], files: [] }),
  gitPathExists: async () => ({ paths: [] }),
  gitRevertRange: async () => ({ outcome: 'nothing_to_revert' }),
  auditTail: async () => [],
  gitTree: async () => ({ sourceId: '', root: '', entries: [] }),
  gitReadFile: async () => ({ content: '', sha: '', size: 0 }),
  gitWriteFile: async () => ({ committed: true, sha: 'written-sha' }),
}));

const { default: app } = await import('../../src/control/app.ts');
const { runMigrations, getDb, schema, pinDb } = await import('../../src/control/db/client.ts');
const { bootstrapFirstAdmin } = await import('../../src/control/bootstrap.ts');
const { eq, desc } = await import('drizzle-orm');

pinDb();

let orgId = '';
let brainId = '';
let ownerCookie = '';
let memberCookie = '';

async function signIn(email: string, password: string): Promise<string> {
  const res = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie') ?? '';
}

async function hit(method: string, path: string, cookie?: string, body?: unknown) {
  const headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.10' };
  if (cookie) headers.cookie = cookie;
  const hasBody = method !== 'GET' && method !== 'DELETE';
  if (hasBody) headers['content-type'] = 'application/json';
  return app.request(path, { method, headers, body: hasBody ? JSON.stringify(body ?? {}) : undefined });
}

const storedPack = async (): Promise<string | null> => {
  const [b] = await getDb().select().from(schema.brains).where(eq(schema.brains.id, brainId));
  return b?.schemaPack ?? null;
};
const setStoredPack = async (pack: string | null) => {
  await getDb().update(schema.brains).set({ schemaPack: pack }).where(eq(schema.brains.id, brainId));
};
const lastAudit = async () => {
  // The timestamp column is `at`, not `created_at` (src/control/db/schema.ts:164).
  const [row] = await getDb().select().from(schema.auditLog)
    .where(eq(schema.auditLog.organizationId, orgId))
    .orderBy(desc(schema.auditLog.at)).limit(1);
  return row;
};

const ok = (stdout: string, json: unknown = null): OpsReply =>
  ({ ok: true, exitCode: 0, stdout, stderr: '', json });
const fail = (exitCode: number, stdout: string, stderr = ''): OpsReply =>
  ({ ok: false, exitCode, stdout, stderr, json: null });

// Verbatim shapes from the pinned 0.50.5.0 container.
const LIST = 'Bundled packs:\n  gbrain-base\n  gbrain-base-v2\n\nInstalled packs (~/.gbrain/schema-packs/):\n  hr-policies\n';
const ACTIVE = (pack: string, source = 'home-config') =>
  `Active pack: ${pack} v1.0.0\nSource: ${source}\nPack identity: ${pack}@1.0.0+deadbeef\nPage types: 3\nLink verbs: 2\n`;

beforeAll(async () => {
  await runMigrations();
  for (const t of [
    schema.claimLinks, schema.connections, schema.spaces, schema.secrets, schema.auditLog,
    schema.sessions, schema.accounts, schema.verifications,
    schema.memberships, schema.brains, schema.organizations, schema.users,
  ]) {
    await getDb().delete(t);
  }
  const boot = await bootstrapFirstAdmin('schema-owner@example.test', PASS, 'SchemaCo');
  orgId = boot.orgId;
  ownerCookie = await signIn('schema-owner@example.test', PASS);
  const [brain] = await getDb().select().from(schema.brains).where(eq(schema.brains.organizationId, orgId));
  brainId = brain!.id;

  // A plain member, to prove the guard. Mint via the same path routes.test.ts
  // uses (bootstrapFirstAdmin + a membership row + sign-in).
  memberCookie = await makeMember('schema-member@example.test');
});

beforeEach(async () => {
  filePlanePatches.length = 0;
  packWrites.length = 0;
  await setStoredPack(null);
  await getDb().delete(schema.auditLog);
});

test('GET /schema reports the stored pack, the resolved pack and the tier', async () => {
  opsHandler = (op) => {
    if (op === 'schema.list') return ok(LIST);
    if (op === 'schema.active') return ok(ACTIVE('gbrain-base-v2'));
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('GET', '/api/schema', ownerCookie);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.packs).toEqual(['gbrain-base', 'gbrain-base-v2', 'hr-policies']);
  expect(body.active.pack).toBe('gbrain-base-v2');
  expect(body.active.source).toBe('home-config');
  expect(body.diverged).toBe(false);
});

test('GET /schema flags divergence when a DB-plane value shadows our write', async () => {
  // MEASURED trap: tier 4 outranks the tier 6 we write, and `schema use`
  // reports success while changing nothing. The page must say so.
  opsHandler = (op) => {
    if (op === 'schema.list') return ok(LIST);
    if (op === 'schema.active') return ok(ACTIVE('other-pack', 'db-config'));
    throw new Error(`unexpected op ${op}`);
  };
  await setStoredPack('hr-policies');
  const body = await (await hit('GET', '/api/schema', ownerCookie)).json();
  expect(body.diverged).toBe(true);
  expect(body.active.source).toBe('db-config');
});

test('GET /schema does not call a brain with no stored pack diverged', async () => {
  // A brain that never chose a pack is not "diverged" just because init
  // picked gbrain-base-v2 for it.
  opsHandler = (op) => {
    if (op === 'schema.list') return ok(LIST);
    if (op === 'schema.active') return ok(ACTIVE('gbrain-base-v2'));
    throw new Error(`unexpected op ${op}`);
  };
  const body = await (await hit('GET', '/api/schema', ownerCookie)).json();
  expect(body.stored).toBeNull();
  expect(body.diverged).toBe(false);
});

test('POST /schema/apply refuses an invalid pack and writes nothing', async () => {
  opsHandler = (op) => {
    if (op === 'schema.list') return ok(LIST);
    if (op === 'schema.validate') return fail(1, '', 'manifest validation failed: page_types.0.primitive');
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('POST', '/api/schema/apply', ownerCookie, { pack: 'hr-policies' });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/manifest validation failed/);
  expect(filePlanePatches).toEqual([]);
});

test('POST /schema/apply refuses an unknown pack before calling gbrain', async () => {
  opsHandler = (op) => {
    if (op === 'schema.list') return ok(LIST);
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('POST', '/api/schema/apply', ownerCookie, { pack: 'not-installed' });
  expect(res.status).toBe(400);
  expect(filePlanePatches).toEqual([]);
});

test('POST /schema/apply writes tier 6 and verifies with schema active', async () => {
  opsHandler = (op) => {
    if (op === 'schema.list') return ok(LIST);
    if (op === 'schema.validate') return ok('✓ hr-policies v1.0.0: valid manifest');
    if (op === 'schema.lint') return ok('', { ok: true, errors: [], warnings: [] });
    if (op === 'schema.active') return ok(ACTIVE('hr-policies'));
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('POST', '/api/schema/apply', ownerCookie, { pack: 'hr-policies' });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.active.pack).toBe('hr-policies');
  // Written through the lock-serialized file-plane writer, NOT `schema use`.
  expect(filePlanePatches).toEqual([{ schema_pack: 'hr-policies' }]);
  expect(await storedPack()).toBe('hr-policies');
});

test('POST /schema/apply reports divergence instead of success', async () => {
  opsHandler = (op) => {
    if (op === 'schema.list') return ok(LIST);
    if (op === 'schema.validate') return ok('✓ hr-policies v1.0.0: valid manifest');
    if (op === 'schema.lint') return ok('', { ok: true, errors: [], warnings: [] });
    // We wrote tier 6, but a tier-4 value wins. Never render this green.
    if (op === 'schema.active') return ok(ACTIVE('other-pack', 'db-config'));
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('POST', '/api/schema/apply', ownerCookie, { pack: 'hr-policies' });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.error).toMatch(/db-config/);
  // The stored column must NOT claim a pack the engine did not adopt.
  expect(await storedPack()).toBeNull();
});

test('POST /schema/apply refuses a pack whose lint has errors', async () => {
  opsHandler = (op) => {
    if (op === 'schema.list') return ok(LIST);
    if (op === 'schema.validate') return ok('✓ hr-policies v1.0.0: valid manifest');
    if (op === 'schema.lint') {
      return fail(1, JSON.stringify({ ok: false, errors: [{ rule: 'duplicate_type', message: 'x' }], warnings: [] }));
    }
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('POST', '/api/schema/apply', ownerCookie, { pack: 'hr-policies' });
  expect(res.status).toBe(400);
  expect(filePlanePatches).toEqual([]);
});

test('POST /schema/preview never applies', async () => {
  opsHandler = (op, params) => {
    if (op === 'schema.sync') {
      expect(params.apply).toBeUndefined();
      return ok('', { apply: false, total_would_apply: 4, total_applied: 0, per_prefix: [] });
    }
    throw new Error(`unexpected op ${op}`);
  };
  const body = await (await hit('POST', '/api/schema/preview', ownerCookie, {})).json();
  expect(body.apply).toBe(false);
  expect(body.total_applied).toBe(0);
});

test('POST /schema/sync applies and audits', async () => {
  opsHandler = (op, params) => {
    if (op === 'schema.sync') {
      expect(params.apply).toBe(true);
      return ok('', { apply: true, total_would_apply: 4, total_applied: 4, per_prefix: [] });
    }
    throw new Error(`unexpected op ${op}`);
  };
  const body = await (await hit('POST', '/api/schema/sync', ownerCookie, {})).json();
  expect(body.total_applied).toBe(4);
  expect(await lastAudit()).toMatchObject({ action: 'schema.sync' });
});

test('PUT /schema/pack writes the manifest then validates it', async () => {
  opsHandler = (op) => {
    if (op === 'schema.validate') return ok('✓ hr-policies v1.0.0: valid manifest');
    if (op === 'schema.lint') return ok('', { ok: true, errors: [], warnings: [] });
    throw new Error(`unexpected op ${op}`);
  };
  const res = await hit('PUT', '/api/schema/pack', ownerCookie,
    { name: 'hr-policies', yaml: 'api_version: gbrain-schema-pack-v1\n' });
  expect(res.status).toBe(200);
  expect(packWrites).toEqual([{ name: 'hr-policies', yaml: 'api_version: gbrain-schema-pack-v1\n' }]);
});

test('PUT /schema/pack rejects a name that is not a safe directory name', async () => {
  opsHandler = () => { throw new Error('must not reach gbrain'); };
  const res = await hit('PUT', '/api/schema/pack', ownerCookie, { name: '../etc', yaml: 'x: 1' });
  expect(res.status).toBe(400);
  expect(packWrites).toEqual([]);
});

test('the audit row never carries the pack YAML body', async () => {
  // S3c: `after` is a redacted summary, never a raw request body.
  opsHandler = (op) => {
    if (op === 'schema.validate') return ok('✓ hr-policies v1.0.0: valid manifest');
    if (op === 'schema.lint') return ok('', { ok: true, errors: [], warnings: [] });
    throw new Error(`unexpected op ${op}`);
  };
  await hit('PUT', '/api/schema/pack', ownerCookie, { name: 'hr-policies', yaml: 'secret-marker-do-not-log' });
  expect(JSON.stringify(await lastAudit())).not.toContain('secret-marker-do-not-log');
});

test('a non-admin cannot reach any schema route', async () => {
  opsHandler = () => { throw new Error('must not reach gbrain'); };
  expect((await hit('GET', '/api/schema', memberCookie)).status).toBe(403);
  expect((await hit('POST', '/api/schema/apply', memberCookie, { pack: 'gbrain-base' })).status).toBe(403);
});
```

Copy `makeMember` from the `freshMember` helper in
`test/integration/routes.test.ts` (it signs a user up through Better Auth and
inserts a `memberships` row with the given role, then signs in). Do not invent
a different mechanism.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/integration/schema-routes.test.ts`
Expected: FAIL — `Cannot find module '../../src/control/routes/schema.ts'` (once the route is imported) or 404s on every request.

- [ ] **Step 3: Write the routes**

Create `src/control/routes/schema.ts`:

```ts
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { requireRole, type Role } from '../rbac.ts';
import { callOps, patchFilePlaneConfig, putSchemaPack } from '../opsClient.ts';
import { listSchemaPacks } from './wizard.ts';
import { parseSchemaActiveProse, type SchemaActive } from '../../contracts/capability.ts';

export const schemaRoutes = new Hono();

/** Same guard as the pack directory name in src/ops/fileplane.ts. */
const PACK_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** gbrain's own manifest cap is generous; ours is a sanity bound, not policy. */
const MAX_PACK_BYTES = 512 * 1024;

async function audit(orgId: string, actor: string, action: string, target: string, after: unknown) {
  // S3c: `after` is a redacted summary — never a raw request body, and never
  // a pack's YAML.
  await getDb().insert(schema.auditLog)
    .values({ id: randomUUID(), organizationId: orgId, actor, action, target, before: null, after: after as object });
}

const guard = (min: Role, handler: (c: any, ctx: { userId: string; orgId: string; role: Role }) => Promise<Response>) =>
  async (c: any) => {
    let ctx;
    try { ctx = await requireRole(c, min); } catch (r) { return r as Response; }
    try { return await handler(c, ctx); }
    catch (e: any) { return c.json({ error: e?.message ?? 'schema_error' }, e?.status ?? 400); }
  };

async function loadBrain(orgId: string) {
  const [brain] = await getDb().select().from(schema.brains)
    .where(eq(schema.brains.organizationId, orgId));
  if (!brain) throw new Error('no brain for organization');
  return brain;
}

/** The resolved truth, never our stored intent. */
async function readActive(): Promise<SchemaActive> {
  const r = await callOps<never>('schema.active', {}, { timeoutMs: 60_000 });
  return parseSchemaActiveProse(r.stdout ?? '');
}

/**
 * gbrain's manifest-shape check. Not redundant with lint: `schema lint <name>`
 * answers the misleading `Pack not found` when a pack exists but fails to
 * parse, while `validate` gives the real diagnosis (MEASURED; see
 * docs/schema-pack-findings.md S5). Returns null when the pack is fine.
 */
async function validationError(pack: string): Promise<string | null> {
  const r = await callOps<never>('schema.validate', { packName: pack }, { timeoutMs: 60_000 });
  if (r.ok) return null;
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
  return text || `schema validate exited ${r.exitCode}`;
}

type LintReport = {
  ok: boolean;
  errors: { rule: string; message: string; hint?: string }[];
  warnings: { rule: string; message: string; hint?: string }[];
};

async function lint(pack: string | undefined, withDb: boolean): Promise<LintReport> {
  // packName MUST precede --with-db: a bare `--with-db` is swallowed as the
  // positional pack name and answers `Pack not found: --with-db` (Work Item S).
  // buildArgv emits params in array order, so this is handled by the registry
  // entry's param ordering — pass them as named params and do not reorder.
  const r = await callOps<LintReport>('schema.lint',
    { ...(pack ? { packName: pack } : {}), ...(withDb ? { withDb: true } : {}) },
    { json: true, timeoutMs: 300_000 });
  if (r.json) return r.json;
  // A malformed pack makes lint print prose, not JSON. Surface that honestly
  // rather than reporting an empty clean report.
  return {
    ok: false,
    errors: [{ rule: 'lint_unavailable', message: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() || `schema lint exited ${r.exitCode}` }],
    warnings: [],
  };
}

/**
 * Current state: what we stored, what gbrain actually resolves, and whether
 * those disagree.
 *
 * `diverged` is the load-bearing field. A brain-DB-plane `schema_pack`
 * (tier 4) outranks the ~/.gbrain/config.json value we write (tier 6), and in
 * that state `gbrain schema use` reports success while changing nothing
 * (MEASURED). The page shows the tier so an admin can see WHY.
 */
schemaRoutes.get('/schema', guard('admin', async (c, { orgId }) => {
  const brain = await loadBrain(orgId);
  const [packs, active] = await Promise.all([listSchemaPacks(), readActive()]);
  const stored = brain.schemaPack ?? null;
  return c.json({
    stored,
    active: {
      pack: active.pack, version: active.version, source: active.source,
      identity: active.identity, pageTypes: active.pageTypes, linkVerbs: active.linkVerbs,
    },
    packs,
    // Only a stored intent can diverge; a brain that never chose one is not
    // "diverged" just because init picked gbrain-base-v2.
    diverged: stored !== null && active.pack !== null && active.pack !== stored,
  });
}));

schemaRoutes.post('/schema/validate', guard('admin', async (c) => {
  const { pack } = await c.req.json();
  if (typeof pack !== 'string' || !PACK_NAME.test(pack)) return c.json({ error: 'pack is required' }, 400);
  const err = await validationError(pack);
  return c.json({ ok: err === null, error: err });
}));

schemaRoutes.post('/schema/lint', guard('admin', async (c) => {
  const body = await c.req.json();
  const pack = typeof body?.pack === 'string' ? body.pack : undefined;
  if (pack !== undefined && !PACK_NAME.test(pack)) return c.json({ error: `invalid pack name ${pack}` }, 400);
  return c.json(await lint(pack, body?.withDb === true));
}));

/**
 * `gbrain schema sync` with no `--apply` — the preview. There is no
 * `--dry-run` here: the flag is rejected before dispatch
 * (`unknown flag --dry-run for 'gbrain schema'`), and preview IS the default
 * mode. Reads the whole brain; no source fence, because a pack is brain-wide.
 */
schemaRoutes.post('/schema/preview', guard('admin', async (c) => {
  const r = await callOps<unknown>('schema.sync', {}, { json: true, timeoutMs: 300_000 });
  if (!r.json) return c.json({ error: `schema sync exited ${r.exitCode}`, detail: r.stderr }, 400);
  return c.json(r.json);
}));

/**
 * Activate a pack.
 *
 * Deliberately NOT `gbrain schema use`: that does an unlocked
 * read-modify-write of the whole config.json, a second unserialized writer to
 * the file S3's advisory lock exists to protect. `patchFilePlaneConfig` writes
 * the same tier-6 field through the one serialized writer and merges instead
 * of rewriting. We give up `schema use`'s built-in validation and buy it back
 * with the explicit validate + lint gate above it.
 *
 * Every apply ends with a `schema active` readback. If the engine resolved a
 * different pack — which happens whenever a tier above 6 is set — this
 * answers 409 and leaves the stored column alone. Reporting that as success
 * would be exactly the false green honesty rule 5 forbids.
 */
schemaRoutes.post('/schema/apply', guard('admin', async (c, { userId, orgId }) => {
  const { pack } = await c.req.json();
  if (typeof pack !== 'string' || !PACK_NAME.test(pack)) return c.json({ error: 'pack is required' }, 400);

  const known = await listSchemaPacks();
  if (!known.includes(pack)) return c.json({ error: `unknown schema pack ${pack}`, packs: known }, 400);

  const invalid = await validationError(pack);
  if (invalid) return c.json({ error: invalid }, 400);

  const report = await lint(pack, false);
  if (!report.ok) return c.json({ error: 'pack lint failed', lint: report }, 400);

  const brain = await loadBrain(orgId);
  await patchFilePlaneConfig({ schema_pack: pack });
  const active = await readActive();

  if (active.pack !== pack) {
    await audit(orgId, userId, 'schema.apply.diverged', pack, {
      requested: pack, resolved: active.pack, source: active.source,
    });
    return c.json({
      ok: false,
      error:
        `gbrain still resolves ${active.pack ?? 'no pack'} from the "${active.source}" tier, ` +
        `which outranks the config.json value just written. ` +
        (active.source === 'db-config' || active.source === 'per-source-db'
          ? 'Clear the brain-DB-plane schema_pack to let this choice take effect.'
          : 'Clear the higher-priority source to let this choice take effect.'),
      requested: pack,
      active: { pack: active.pack, source: active.source },
    }, 409);
  }

  await getDb().update(schema.brains)
    .set({ schemaPack: pack, updatedAt: new Date() })
    .where(eq(schema.brains.id, brain.id));
  await audit(orgId, userId, 'schema.apply', pack, {
    pack, source: active.source, warnings: report.warnings.length,
  });

  return c.json({
    ok: true,
    active: { pack: active.pack, version: active.version, source: active.source, identity: active.identity },
    lint: report,
  });
}));

/**
 * `gbrain schema sync --apply`.
 *
 * Additive only, and that is a measured property, not an assumption: both the
 * probe and the chunked UPDATE are fenced by
 * `(type IS NULL OR type = '')`, so it fills blank types and cannot
 * reclassify, delete or unembed anything. Verified against the pinned
 * container with a pack whose prefixes deliberately targeted already-typed
 * pages — zero rows changed. See docs/schema-pack-findings.md S3.
 */
schemaRoutes.post('/schema/sync', guard('admin', async (c, { userId, orgId }) => {
  const r = await callOps<{ total_applied: number; total_would_apply: number }>(
    'schema.sync', { apply: true }, { json: true, timeoutMs: 900_000 },
  );
  if (!r.json) return c.json({ error: `schema sync exited ${r.exitCode}`, detail: r.stderr }, 400);
  await audit(orgId, userId, 'schema.sync', 'brain', {
    applied: r.json.total_applied, wouldApply: r.json.total_would_apply,
  });
  return c.json(r.json);
}));

/**
 * Install or replace a custom pack.
 *
 * The YAML goes to the FILE plane, never gbrain's DB plane — gbrain only ever
 * reads packs from `~/.gbrain/schema-packs/<name>/pack.yaml`, and that path is
 * on the shared `gbrain-home` volume, so the write survives restarts and is
 * visible to gbrain-serve and gbrain-worker too (MEASURED).
 *
 * Writing does not activate. The response carries validate + lint so the admin
 * sees whether the pack is usable before choosing to apply it.
 */
schemaRoutes.put('/schema/pack', guard('admin', async (c, { userId, orgId }) => {
  const { name, yaml } = await c.req.json();
  if (typeof name !== 'string' || !PACK_NAME.test(name)) {
    return c.json({ error: 'name must be lowercase letters, digits and hyphens' }, 400);
  }
  if (typeof yaml !== 'string' || yaml.trim() === '') return c.json({ error: 'yaml is required' }, 400);
  if (Buffer.byteLength(yaml, 'utf8') > MAX_PACK_BYTES) {
    return c.json({ error: `pack manifest exceeds ${MAX_PACK_BYTES} bytes` }, 400);
  }

  await putSchemaPack(name, yaml);
  const invalid = await validationError(name);
  const report = invalid ? null : await lint(name, false);

  // S3c: the audit row records SHAPE, never the manifest body.
  await audit(orgId, userId, 'schema.pack.write', name, {
    name, bytes: Buffer.byteLength(yaml, 'utf8'), valid: invalid === null,
  });

  return c.json({ ok: invalid === null, name, error: invalid, lint: report });
}));
```

- [ ] **Step 4: Mount the routes**

In `src/control/app.ts`, add the import alongside the other route imports:

```ts
import { schemaRoutes } from './routes/schema.ts';
```

and mount it next to the other `/api` routes (after the `connectionRoutes` line):

```ts
app.route('/api', schemaRoutes);
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/integration/schema-routes.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 6: Run the forbidden-pattern lint**

Run: `bun run lint:forbidden`
Expected: PASS — no direct `gbrain` invocation or brain DB reference added to control-plane code.

- [ ] **Step 7: Commit**

```bash
git add src/control/routes/schema.ts src/control/app.ts test/integration/schema-routes.test.ts
git commit -m "$(cat <<'EOF'
feat(control): Schema admin API — validate, lint, preview, apply, sync

Activation writes tier-6 schema_pack through the lock-serialized file-plane
writer rather than `gbrain schema use`, which is an unlocked read-modify-write
of the same file. Every apply ends with a `schema active` readback and answers
409 on divergence instead of reporting a false green: a brain-DB-plane value
outranks the one we write, and `schema use` claims success in that state.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The Schema console page

**Files:**
- Create: `src/console/pages/Schema.tsx`
- Modify: `src/console/App.tsx`
- Test: `test/unit/console-schema.test.ts`

**Interfaces:**
- Consumes: the `/api/schema*` routes from Task 5; `api` from `src/console/api.ts`.
- Produces: `export function Schema(): JSX.Element`, rendered when `page === 'schema'`.

- [ ] **Step 1: Write the failing test**

**This repo does not render React in unit tests.** `test/unit/console-upgrades.test.ts`
imports *pure functions* exported from `src/console/pages/Upgrades.tsx`
(`bannerFor`, `stepStatus`, `rolledBack`, …) and asserts on their return
values. Follow that convention exactly: the decision logic lives in exported
functions, and the component only arranges them. Do not add a DOM, a render
helper or a testing-library dependency.

Create `test/unit/console-schema.test.ts`:

```ts
import { test, expect, describe } from 'bun:test';
import {
  activeSummary, divergenceWarning, canApply, syncSummary, ADDITIVE_NOTICE,
} from '../../src/console/pages/Schema.tsx';

const ACTIVE = {
  pack: 'gbrain-base-v2', version: '1.2.0', source: 'home-config',
  identity: 'gbrain-base-v2@1.2.0+1a2aee67', pageTypes: 19, linkVerbs: 17,
};

describe('the active summary', () => {
  test('names the pack and the tier it was resolved from', () => {
    const s = activeSummary(ACTIVE);
    expect(s).toContain('gbrain-base-v2');
    expect(s).toContain('1.2.0');
    expect(s).toContain('home-config');
  });

  test('an unresolvable pack never reads as a healthy default', () => {
    const s = activeSummary({ pack: null, version: null, source: null, identity: null, pageTypes: null, linkVerbs: null });
    expect(s).toMatch(/could not|unknown|no pack/i);
    expect(s).not.toMatch(/gbrain-base/);
  });
});

describe('divergence — honesty rule 5', () => {
  test('a matching pack produces no warning', () => {
    expect(divergenceWarning({ stored: 'gbrain-base-v2', active: ACTIVE, diverged: false })).toBeNull();
  });

  test('a db-config tier names the tier and says it outranks this page', () => {
    // MEASURED trap: tier 4 outranks the tier 6 this page writes, and
    // `gbrain schema use` reports success while changing nothing.
    const w = divergenceWarning({
      stored: 'hr-policies',
      active: { ...ACTIVE, pack: 'gbrain-base-v2', source: 'db-config' },
      diverged: true,
    });
    expect(w).toContain('db-config');
    expect(w).toContain('hr-policies');
    expect(w).toMatch(/outranks/i);
  });

  test('a brain that never chose a pack is not diverged', () => {
    expect(divergenceWarning({ stored: null, active: ACTIVE, diverged: false })).toBeNull();
  });
});

describe('the apply gate', () => {
  const clean = { ok: true, errors: [], warnings: [] };
  const preview = { apply: false, pack_identity: null, per_prefix: [], total_would_apply: 0, total_applied: 0 };

  test('apply needs a clean lint AND a seen preview', () => {
    expect(canApply({ busy: false, pack: 'hr-policies', lint: clean, preview })).toBe(true);
  });

  test('no preview means no apply', () => {
    expect(canApply({ busy: false, pack: 'hr-policies', lint: clean, preview: null })).toBe(false);
  });

  test('a lint with errors blocks apply even with a preview', () => {
    const bad = { ok: false, errors: [{ rule: 'duplicate_type', message: 'x' }], warnings: [] };
    expect(canApply({ busy: false, pack: 'hr-policies', lint: bad, preview })).toBe(false);
  });

  test('warnings alone do not block apply', () => {
    // gbrain-base-v2 itself lints with warnings; blocking on those would make
    // the shipped default unselectable.
    const warned = { ok: true, errors: [], warnings: [{ rule: 'alias_references_undeclared_type', message: 'x' }] };
    expect(canApply({ busy: false, pack: 'hr-policies', lint: warned, preview })).toBe(true);
  });

  test('a busy page cannot apply', () => {
    expect(canApply({ busy: true, pack: 'hr-policies', lint: clean, preview })).toBe(false);
  });

  test('no pack selected cannot apply', () => {
    expect(canApply({ busy: false, pack: '', lint: clean, preview })).toBe(false);
  });
});

describe('the sync summary', () => {
  test('zero matches is explained, not reported as a failure', () => {
    // The normal result on a brain whose pages are already typed. An admin who
    // reads "0 applied" as breakage will go looking for a bug that is not there.
    const s = syncSummary({
      apply: false, pack_identity: 'p@1.0.0+aa',
      per_prefix: [{ type: 'policy', prefix: 'policies/', would_apply: 0, applied: 0, dead_prefix: true, sample_slugs: [] }],
      total_would_apply: 0, total_applied: 0,
    });
    expect(s).toMatch(/no untyped pages/i);
    expect(s).not.toMatch(/error|failed/i);
  });

  test('a real backfill reports the count', () => {
    const s = syncSummary({
      apply: true, pack_identity: 'p@1.0.0+aa',
      per_prefix: [{ type: 'policy', prefix: 'policies/', would_apply: 4, applied: 4, dead_prefix: false, sample_slugs: [] }],
      total_would_apply: 4, total_applied: 4,
    });
    expect(s).toContain('4');
  });
});

test('the page states plainly that a switch does not re-type existing pages', () => {
  // The single most important sentence on this page: `schema sync` only fills
  // a blank type, so pages typed under the old pack keep their old type.
  expect(ADDITIVE_NOTICE).toMatch(/does not re-type/i);
  expect(ADDITIVE_NOTICE).toMatch(/keep the type/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/console-schema.test.ts`
Expected: FAIL — `Cannot find module '../../src/console/pages/Schema.tsx'`.

- [ ] **Step 3: Write the page**

Create `src/console/pages/Schema.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { api } from '../api.ts';

type Active = {
  pack: string | null; version: string | null; source: string | null;
  identity: string | null; pageTypes: number | null; linkVerbs: number | null;
};
type State = { stored: string | null; active: Active; packs: string[]; diverged: boolean };
type LintRule = { rule: string; message: string; hint?: string };
type Lint = { ok: boolean; errors: LintRule[]; warnings: LintRule[] };
type PerPrefix = { type: string; prefix: string; would_apply: number; applied: number; dead_prefix: boolean; sample_slugs: string[] };
type Sync = { apply: boolean; pack_identity: string | null; per_prefix: PerPrefix[]; total_would_apply: number; total_applied: number };

/**
 * A pack switch is additive: `gbrain schema sync` only fills a blank `type`,
 * so pages typed under the old pack keep their old type. Saying so is the
 * single most important thing this page does — an admin who expects a switch
 * to reclassify the corpus will otherwise read "0 applied" as a failure.
 */
export const ADDITIVE_NOTICE =
  'Switching packs does not re-type existing pages. Sync only fills in pages that have no type yet — ' +
  'already-typed pages keep the type they were given under the previous pack.';

/**
 * The decision logic below is exported as pure functions because that is how
 * this console is tested (see test/unit/console-upgrades.test.ts): no DOM, no
 * render harness — the component arranges these and nothing more.
 */
export function activeSummary(active: Active): string {
  if (!active.pack) return 'Could not resolve an active pack.';
  const v = active.version ? ` v${active.version}` : '';
  return `${active.pack}${v} — resolved from ${active.source ?? 'an unknown source'}`;
}

/** Null when there is nothing to warn about. Never rounds a mismatch up. */
export function divergenceWarning(s: { stored: string | null; active: Active; diverged: boolean }): string | null {
  if (!s.diverged || !s.stored) return null;
  return (
    `This brain is set to ${s.stored} here, but gbrain resolves ` +
    `${s.active.pack ?? 'no pack'} from the ${s.active.source} tier, which outranks the ` +
    `setting this page writes. Clear that source for the choice to take effect.`
  );
}

/**
 * Apply needs a clean lint AND a seen preview. Warnings do not block —
 * gbrain-base-v2 itself lints with warnings, so blocking on those would make
 * the shipped default unselectable.
 */
export function canApply(s: { busy: boolean; pack: string; lint: Lint | null; preview: Sync | null }): boolean {
  return !s.busy && s.pack !== '' && s.preview !== null && s.lint !== null && s.lint.ok;
}

export function syncSummary(report: Sync): string {
  const live = report.per_prefix.filter((p) => !p.dead_prefix);
  if (live.length === 0) {
    return (
      "No untyped pages match this pack's prefixes. That is the normal result on a brain whose " +
      'pages are already typed — it does not mean the pack is wrong.'
    );
  }
  return `${report.total_would_apply} page(s) would be typed · ${report.total_applied} applied`;
}

export function Schema() {
  const [state, setState] = useState<State | null>(null);
  const [pack, setPack] = useState('');
  const [lint, setLint] = useState<Lint | null>(null);
  const [preview, setPreview] = useState<Sync | null>(null);
  const [applied, setApplied] = useState<Sync | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const s = await api.get<State>('/schema');
    setState(s);
    setPack((current) => current || s.stored || s.active.pack || '');
  };
  useEffect(() => { void load().catch((e) => setError(e instanceof Error ? e.message : 'Load failed')); }, []);

  const step = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Step failed'); }
    finally { setBusy(false); }
  };

  // Any change to the candidate invalidates the gate: a preview of the old
  // pack must never authorize applying a different one.
  const choose = (name: string) => { setPack(name); setLint(null); setPreview(null); setApplied(null); };

  const runLint = () => step(async () => setLint(await api.post<Lint>('/schema/lint', { pack, withDb: true })));
  const runPreview = () => step(async () => setPreview(await api.post<Sync>('/schema/preview', {})));
  const runApply = () => step(async () => {
    await api.post('/schema/apply', { pack });
    setPreview(null);
    await load();
  });
  const runSync = () => step(async () => { setApplied(await api.post<Sync>('/schema/sync', {})); await load(); });

  if (!state) return <div className="text-muted">Loading…</div>;

  const changing = pack !== state.active.pack;
  // Preview before apply. A pack change is cheap to reverse but expensive to
  // explain, and the preview is where "0 would apply" gets seen up front.
  const applyEnabled = canApply({ busy, pack, lint, preview });
  const warning = divergenceWarning(state);

  return (
    <div className="max-w-3xl space-y-8">
      <header>
        <h1 className="text-xl font-semibold">Schema</h1>
        <p className="text-sm text-muted">
          The schema pack decides what kinds of pages the brain recognizes.
        </p>
      </header>

      {error && <div className="text-danger text-sm">{error}</div>}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Active</h2>
        <div className="text-sm">
          <div>{activeSummary(state.active)}</div>
          {state.active.identity && <div><span className="text-muted">Identity:</span> <code>{state.active.identity}</code></div>}
          {state.active.pageTypes !== null && (
            <div><span className="text-muted">Page types:</span> {state.active.pageTypes} · <span className="text-muted">Link verbs:</span> {state.active.linkVerbs}</div>
          )}
        </div>
        {warning && (
          // Never round this up to a checkmark: the brain is running a pack
          // nobody here chose, because a higher-priority tier outranks ours.
          <div className="text-danger text-sm">{warning}</div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Change pack</h2>
        <p className="text-sm text-muted">{ADDITIVE_NOTICE}</p>
        <select
          className="w-full" value={pack} disabled={busy}
          onChange={(e) => choose(e.currentTarget.value)}
        >
          {state.packs.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>

        <div className="flex gap-2">
          <button disabled={busy || pack === ''} onClick={runLint}>Lint</button>
          <button disabled={busy} onClick={runPreview}>Preview sync</button>
          <button disabled={!applyEnabled} onClick={runApply}>
            {changing ? `Apply ${pack}` : 'Apply'}
          </button>
        </div>
        {!applyEnabled && pack !== '' && (
          <p className="text-xs text-muted">Lint clean and a sync preview are both required before applying.</p>
        )}
      </section>

      {lint && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Lint — {lint.ok ? 'clean' : 'errors'}</h2>
          {lint.errors.map((e, i) => (
            <div key={`e${i}`} className="text-danger text-sm">
              <code>{e.rule}</code>: {e.message}{e.hint ? ` — ${e.hint}` : ''}
            </div>
          ))}
          {lint.warnings.map((w, i) => (
            <div key={`w${i}`} className="text-muted text-sm">
              <code>{w.rule}</code>: {w.message}{w.hint ? ` — ${w.hint}` : ''}
            </div>
          ))}
          {lint.ok && lint.warnings.length === 0 && <div className="text-sm text-muted">No findings.</div>}
        </section>
      )}

      {preview && <SyncTable title="Preview — nothing written" report={preview} />}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Backfill types</h2>
        <p className="text-sm text-muted">
          Fills in pages that have no type yet, using the active pack's path prefixes. {ADDITIVE_NOTICE}
        </p>
        <button disabled={busy} onClick={runSync}>Run sync</button>
        {applied && <SyncTable title={`Applied — ${applied.total_applied} page(s) typed`} report={applied} />}
      </section>
    </div>
  );
}

function SyncTable({ title, report }: { title: string; report: Sync }) {
  const live = report.per_prefix.filter((p) => !p.dead_prefix);
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="text-sm text-muted">
        {syncSummary(report)}
        {report.pack_identity ? ` · ${report.pack_identity}` : ''}
      </div>
      {live.length > 0 && (
        <table className="w-full text-sm">
          <thead><tr><th className="text-left">Type</th><th className="text-left">Prefix</th><th className="text-right">Would apply</th><th className="text-right">Applied</th></tr></thead>
          <tbody>
            {live.map((p) => (
              <tr key={`${p.type}:${p.prefix}`}>
                <td><code>{p.type}</code></td>
                <td><code>{p.prefix}</code></td>
                <td className="text-right">{p.would_apply}</td>
                <td className="text-right">{p.applied}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Wire the page into the console**

In `src/console/App.tsx`, add the import beside the others:

```tsx
import { Schema } from './pages/Schema.tsx';
```

add the nav button inside the `phase === 'ready'` fragment, after the
Connection button:

```tsx
            <button className="nav-item" onClick={() => setPage('schema')}>Schema</button>
```

and add the render line in `<main>`, after the Connection line:

```tsx
        {page === 'schema' && <Schema />}
```

If `App.tsx` declares a union type for `page`, add `'schema'` to it.

- [ ] **Step 5: Run the tests**

Run: `bun test test/unit/console-schema.test.ts test/unit/console-app.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole unit + integration suite**

Run: `bun run test:unit && bun run test:integration`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/console/pages/Schema.tsx src/console/App.tsx test/unit/console-schema.test.ts test/unit/helpers/
git commit -m "$(cat <<'EOF'
feat(console): Schema admin page

Lint, preview and apply a pack, and backfill page types. Apply is gated on a
clean lint plus a seen preview. The page shows the resolution tier and warns
loudly when gbrain resolves a pack other than the one set here, and states
plainly that a switch does not re-type existing pages — otherwise "0 applied"
reads as a failure.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Verification

After all six tasks, verify against the live stack rather than the mocks:

- [ ] `bun run test:unit`
- [ ] `bun run test:integration`
- [ ] `bun run test:contract:isolated test/contract/schema.contract.test.ts`
- [ ] `bun run lint:forbidden`
- [ ] Manual end-to-end against the running stack, which is the only thing that proves the directory-shape fix in a real container:

```bash
# 1. Upload a custom pack through the API and confirm gbrain discovers it.
#    (Use the console's Schema page, or curl with an admin session cookie.)
docker exec brainstand-gbrain-ops-1 sh -lc \
  'ls -R /srv/gbrain-home/.gbrain/schema-packs/ && gbrain schema list | tail -4'
# Expected: schema-packs/<name>/pack.yaml, and <name> under "Installed packs".

# 2. Apply it from the console, then confirm the engine agrees.
docker exec brainstand-gbrain-ops-1 gbrain schema active
# Expected: Active pack: <name>, Source: home-config

# 3. Confirm the tier-4 divergence path renders honestly.
docker exec brainstand-gbrain-ops-1 gbrain config set schema_pack gbrain-base
# Expected: the Schema page now shows diverged, source db-config, and an apply
#           answers 409 rather than a green checkmark.
docker exec brainstand-gbrain-ops-1 gbrain config unset schema_pack   # clean up
```

---

## Out of scope, and why

- **`gbrain schema use` as a registry operation.** It is a second unlocked
  writer to `config.json` (S3), and it silently no-ops under a tier-4 value
  while reporting success. `patchFilePlaneConfig` + a `schema active` readback
  does the same job honestly.
- **`schema retype` / `unify-types` / pack `mapping_rules`.** These are the
  genuinely reclassifying paths (`UPDATE pages SET type = …` over already-typed
  rows). They are reversible via `frontmatter.legacy_type` but they are a
  different feature — "migrate my corpus to a new taxonomy" — and deserve their
  own plan with its own preview and confirmation design.
- **The pack authoring verbs** (`schema init` / `fork` / `add-type` /
  `update-type` / …). This plan installs and activates whole manifests; an
  in-console pack editor is a separate feature.
- **Per-source packs (tier 3).** gbrain supports `schema_pack.source.<id>`,
  which would let one Space use a different taxonomy. Nothing in the product
  asks for it yet, and it multiplies the divergence surface this plan already
  has to explain.
- **Clearing a higher-priority tier automatically.** The apply route detects
  and reports a tier-4 override; it does not silently unset it. gbrain's own
  `unify-types` writes that value, so clearing it unasked would be destroying
  state the engine set for a reason.
