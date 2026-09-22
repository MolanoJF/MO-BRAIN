# Custom Schema Packs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An org admin can design their own ontology (page types, link verbs, folders) as a custom schema pack, from the console, from an imported draft, or with help from their own agent. When a brain is created, or a pack is applied, every Space's folder structure is scaffolded from the pack automatically.

**Architecture:** The console and the REST API are the only writers. Underneath, every change goes through gbrain's own published surfaces: pack creation writes a `pack.json` to the file plane, edits run through `gbrain call schema_apply_mutations` (gbrain's atomic, lint-gated, audited batch mutator), and reads go through the existing `packOverride` resolver seam. Folder scaffolding is a create-only git commit of one `README.md` per page type. gbrain skips `README.md` during sync (`SYNC_SKIP_FILES`), so the scaffold never becomes a page. The agent skill drafts a pack, and a human imports and applies it. The skill never mutates anything.

**Tech Stack:** Bun, TypeScript, Hono (control plane), React 19 (console), drizzle, gbrain 0.50.5.0 (pinned, never forked).

**Spec:** The "Research" and "Design decisions" sections below are the spec. Also read `docs/schema-pack-findings.md` (S1–S6) and `docs/superpowers/plans/2026-09-21-schema-pack-management.md`. This plan builds on both.

## Global Constraints

- gbrain is a pinned upstream dependency, driven only through its CLI (ops registry), its HTTP MCP, and the file plane. Never edit `C:\Users\juanp\Desktop\gbrain`. Never read gbrain's tables from the control plane.
- Every new ops registry entry needs a contract test in `test/contract/` (G4, which `test/unit/registry.test.ts` enforces).
- Never reimplement gbrain's `extends` / `borrow_from` merge in TypeScript. Effective manifests come only from `callOps('schema.show', {}, { packOverride })`.
- Pack names match `/^[a-z0-9][a-z0-9-]{0,63}$/`. Source ids match `/^[a-z0-9][a-z0-9-]{0,62}$/`.
- Bundled packs (`gbrain-base`, `gbrain-base-v2`, `gbrain-recommended`, `gbrain-creator`, `gbrain-investor`, `gbrain-engineer`, `gbrain-everything`) are read-only. gbrain refuses to mutate them with `PACK_READONLY`, so edit only a fork or a new pack.
- Honesty rule: never report a write as applied without a readback. Mutations are read back via `schema.show`, and applies via `schema.active`.
- Audit rows record shape, never manifest bodies (S3c).
- Schema admin routes require the `admin` role.
- Scaffolding is create-only. It never overwrites or deletes a file, and it makes one commit per Space.
- UI copy: sync "fills blank types" and never "reclassifies" (S3).

---

## Research: how gbrain handles schema creation (0.50.x, read from `C:\Users\juanp\Desktop\gbrain`)

**Where packs live.** Seven bundled packs ship in `src/core/schema-pack/base/*.yaml`. User packs are directories at `~/.gbrain/schema-packs/<name>/pack.{yaml,yml,json}`. On this stack that path is `/srv/gbrain-home/.gbrain/schema-packs`, on the shared `gbrain-home` volume, so ops, serve and worker all see the same packs. `gbrain-serve` notices on-disk changes within about 1s (stat-mtime TTL in `loadActivePack`).

**Manifest shape** (`src/core/schema-pack/manifest-v1.ts`, zod `.strict()`):
`api_version: gbrain-schema-pack-v1`, `name`, `version`, `gbrain_min_version`, optional `extends`, `description`, `page_types[]` (`name`, `primitive` ∈ `entity|media|temporal|annotation|concept`, `path_prefixes[]`, `aliases[]`, `extractable`, `expert_routing`), `link_types[]` (`name`, optional `inverse`, optional `inference {regex?, page_type?, target_type?}`), `takes_kinds`, `borrow_from`, `frontmatter_links`, `enrichable_types`, `filing_rules[]` (`kind`, `directory`, `examples[]`, `description?`), `phases`, `calibration_domains`.

**Merge contract.** Six fields inherit with child-wins semantics. `takes_kinds` is a union and cannot be narrowed. `phases` and `calibration_domains` are not inherited. `borrow_from` is selective. This is why effective counts differ from raw ones (S4).

**Authoring surfaces gbrain offers:**

| Surface | What it does | Fit for us |
|---|---|---|
| `schema init <name>` | Writes a stub `pack.yaml` that always has `extends: gbrain-base` (not v2) | Poor: hardcodes the base |
| `schema fork <from> <to>` | Copies the source's **raw** manifest to `<to>/pack.json` | Good for "start from a template" |
| `schema add-type` / `remove-type` / `update-type` / `add-alias` / `add-prefix` / `add-link-type` / `set-extractable` / `set-expert-routing` | One mutation per process, lint-gated, per-pack lock, audited | Usable, but a multi-step edit can half-apply; `--pack <name>` is also caught by the positional filter (`args.filter(a => !a.startsWith('--'))`), so only `--pack=<name>` is safe |
| MCP `schema_apply_mutations` (admin scope) | **Atomic batch.** Validates every mutation in memory, writes the file once, emits one `batch_id` | Best mutation primitive |
| `gbrain call <op> '<json>'` | Trusted local dispatch of any operation, including `schema_apply_mutations` | **Our lane.** It is atomic and needs no admin MCP client |
| `schema detect` / `schema suggest` | Cluster the existing corpus by path; LLM-refined | Useless on a brand-new, empty brain; useful later |
| `skills/schema-author/SKILL.md` | Agent workflow: active → stats → orphans → detect/suggest → fork → mutate → lint `--with-db` → sync preview → sync `--apply` | The model for our skill, but it assumes local admin trust |

**What gbrain does not do.** It never creates directories from a pack. `filing_rules[].directory` and `path_prefixes` are only used for type inference and agent guidance. Folder scaffolding is ours to build. gbrain does give us the right primitive, though: `SYNC_SKIP_FILES = ['schema.md','index.md','log.md','README.md','RESOLVER.md']` (`src/core/sync.ts:540`), and bulk import excludes the same list (`src/commands/import.ts:1126`). A `people/README.md` is directory scaffolding, not a page typed `person`.

## Design decisions

1. **The API is the product surface, the gbrain CLI is the engine, and the skill only drafts.**
   - *CLI alone* doesn't fit this product. Users never get a shell on the ops container, and a raw CLI passthrough violates G2.
   - *MCP `schema_apply_mutations` from user agents* would mean handing out admin-scope grants. The admin role maps to the `coding-agent` profile (no `cap:admin`, `src/contracts/compile.ts`), and `PRODUCT_TOOL_ALLOWLIST` excludes the admin lane on purpose. Opening it would let any connected agent silently retype a whole brain.
   - *So:* the REST API (admin-gated, audited, read-back) is the only writer. It calls gbrain's atomic batch mutator through the ops registry. The skill turns requirements into a **PackDraft JSON**, and the admin imports it in the console, reviews validate/lint/preview, and creates it. A human always holds the key.
2. **Two write shapes.** A new pack is a whole document, written once as `pack.json` through the file plane: there is no concurrency, and our draft validation runs first. Edits to an existing pack are mutation batches through gbrain, so they are atomic, gbrain-linted and gbrain-audited. The existing raw-YAML `PUT /schema/pack` stays as the "Advanced" escape hatch.
3. **Why JSON, not YAML, for created packs.** `yaml` is only a devDependency, so it isn't in the control-plane image. gbrain's `parseYamlMini` is not a general YAML parser. `schema fork` itself writes `pack.json`. Task 0 measures loader precedence when both files exist, and the writer always removes the other format.
4. **Ontology scope is per brain, with per-Space override.** "Each user defines their own ontology" maps to each org's brain. Different teams can already get different packs per Space (`schema_pack.source.<id>`, tier 3). A per-*person* pack doesn't fit, because pages are shared.
5. **Folders are one directory per page type.** The directory is the `filing_rules` entry whose `kind` matches the type, falling back to the type's first `path_prefix` that ends in `/`. That gives 19 folders for `gbrain-base-v2`, not every alias prefix. Each folder gets a `README.md` naming the type, its primitive, its description, its link verbs and its prefixes. The README is also useful filing guidance for agents that read the repo.
6. **When scaffolding runs:**
   - wizard `/finish`, after `sources.add`, before `sync`
   - a new Space on a `ready` brain
   - `/schema/apply`, for Spaces inheriting the brain pack
   - a per-Space override
   - a mutation batch that adds a type to a pack some Space resolves
   - a manual "Create folders" button
   
   Scaffolding is always create-only and idempotent.

## File structure

| File | Responsibility |
|---|---|
| `docs/schema-pack-findings.md` (modify, add S7) | Task 0 measurements |
| `src/contracts/registry.ts` (modify) | `schema.fork`, `schema.showRaw`, `schema.mutate` entries |
| `test/contract/schema-authoring.contract.test.ts` (create) | Contract tests for the three entries |
| `src/control/schemaDraft.ts` (create) | Pure: `PackDraft` type, `validateDraft`, `draftToManifest`, mutation types |
| `test/unit/schema-draft.test.ts` (create) | |
| `src/ops/fileplane.ts` (modify) | `writeSchemaPackJson`, `removeSchemaPack` |
| `src/ops/server.ts` (modify) | `/fileplane/schema-pack-json`, `/fileplane/schema-pack-remove`, `/git/scaffold` |
| `src/control/opsClient.ts` (modify) | `putSchemaPackJson`, `removeSchemaPack`, `gitScaffold` |
| `src/control/scaffold.ts` (create) | Pure `scaffoldEntries(detail)` plus `scaffoldSpaces(orgId, sourceIds?)` orchestration |
| `src/ops/git.ts` (modify) | `scaffoldFolders` (create-only, one commit, under the repo lock) |
| `src/control/routes/schema.ts` (modify) | Pack CRUD, mutations, scaffold routes; richer `PackDetail` |
| `src/control/routes/wizard.ts` (modify) | Scaffold in `/finish`, and on `addSpaceSource` when ready |
| `src/console/api.ts` (modify) | Client types and calls |
| `src/console/pages/SchemaBuilder.tsx` (create) | Create/edit UI and pure helpers |
| `src/console/pages/Schema.tsx` (modify) | Entry points: New pack, Edit, Import draft, Create folders |
| `skills/mobrain-schema-designer/SKILL.md` (create) | Agent skill: requirements → PackDraft JSON |
| `skills/mobrain-schema-designer/pack-draft.schema.json` (create) | JSON Schema for PackDraft, shared by the skill and the import route |

---

### Task 0: Measure the authoring surface at the pin

No code. Write each probe's command, exit code and output into a new **S7** section of `docs/schema-pack-findings.md`, using the S6 format. Run everything against `brainstand-gbrain-ops-1` and return the brain to baseline afterwards.

- [ ] **Step 1: `gbrain call schema_apply_mutations` at 0.50.5.0**

```bash
docker exec brainstand-gbrain-ops-1 gbrain schema fork gbrain-base-v2 zz-probe --json
docker exec brainstand-gbrain-ops-1 gbrain call schema_apply_mutations \
  '{"pack":"zz-probe","mutations":[{"op":"add_type","name":"contract","primitive":"entity","prefix":"contracts/","extractable":true},{"op":"add_link_type","name":"signed","inference":{"page_type":"person","target_type":"contract"}}]}'
echo "exit $?"
docker exec brainstand-gbrain-ops-1 gbrain call schema_apply_mutations \
  '{"pack":"zz-probe","mutations":[{"op":"add_type","name":"x","primitive":"entity","prefix":"x/"},{"op":"remove_type","name":"does-not-exist"}]}'
echo "exit $?"
docker exec brainstand-gbrain-ops-1 gbrain call schema_apply_mutations '{"pack":"gbrain-base-v2","mutations":[{"op":"add_type","name":"y","primitive":"entity","prefix":"y/"}]}'
echo "exit $?"
```

Record the success JSON (`mutations_applied`, `results[]`, `batch_id`) and the failure JSON (`error: mutation_failed`, `code`, `failed_at_index`, `pack_unchanged`). **The exit code on failure matters most:** gbrain returns an error object from the handler, so `call` may exit 0. Also record the `PACK_READONLY` shape. Then confirm `type x` is absent from `gbrain schema show zz-probe --json`, which proves the batch is atomic.

- [ ] **Step 2: raw `schema show <pack> --json` on a fork, and `fork --json` shape**

Record whether `schema show zz-probe --json` (positional, raw) lists only own declarations. A fork copies everything raw, so for a fork raw equals effective. For an `extends` pack, raw lists only its own types.

- [ ] **Step 3: a pack with no `extends` and a pack with `extends: gbrain-base-v2`**

Write `/srv/gbrain-home/.gbrain/schema-packs/zz-noext/pack.json` with one `page_types` entry and no `extends`. Then run `schema validate zz-noext`, `schema lint zz-noext --json`, and `env GBRAIN_SCHEMA_PACK=zz-noext gbrain schema show --json`. Record whether a standalone ontology is legal, and what the effective page-type count is. We expect 1; if gbrain-base leaks in, record that. Repeat with `"extends":"gbrain-base-v2"`.

- [ ] **Step 4: loader precedence with both `pack.yaml` and `pack.json` present**

Write different `version` values into each file, then run `schema show zz-noext --json`. Record which file wins. This justifies the writer deleting the sibling file.

- [ ] **Step 5: README.md is skipped at the pin**

Commit `people/README.md` into the `shared` Space repo. Then run `gbrain sync --source shared` and `gbrain schema stats --json`, and check `list_pages` for a slug `people/readme` or `people`. We expect no page. Remove the file and commit again afterwards.

- [ ] **Step 6: serve picks up a mutation**

After Step 1, with `zz-probe` set as the env-override pack in ops only, confirm the file mtime changed. Also note that serve reads packs only when a pack is active; this probe just records that the shared volume makes the file visible from `brainstand-gbrain-serve-1` (`ls -la`).

- [ ] **Step 7: validate/lint before `init` (the wizard case)**

On a scratch GBRAIN_HOME with no DB (`docker exec -e GBRAIN_HOME=/tmp/zz brainstand-gbrain-ops-1 ...`), run `schema validate`, `schema lint --json` and `schema show --json` with `GBRAIN_SCHEMA_PACK` pointing at a copied pack. Record whether they need a DB (`privilege: brain-db`). This decides Task 9's branch.

- [ ] **Step 8: Cleanup and commit**

Remove `zz-probe` and `zz-noext` and restore the Space repo, then verify the baseline as in S6's Cleanup.

```bash
git add docs/schema-pack-findings.md
git commit -m "docs(schema): S7, the custom-pack authoring probes at 0.50.5.0"
```

**Gate:** if Step 1 shows `gbrain call` cannot run `schema_apply_mutations` at the pin, Task 1's `schema.mutate` falls back to one registry entry per CLI verb, always with `--pack=<name>` in `=` form. Write that branch into S7 and continue.

---

### Task 1: Registry entries for fork, raw show, and atomic mutate

**Files:**
- Modify: `src/contracts/registry.ts` (after `schema.sync`)
- Create: `test/contract/schema-authoring.contract.test.ts`
- Test: `test/unit/registry.test.ts` (existing invariants cover the shape)

**Interfaces:**
- Produces: `callOps('schema.fork', { from, to }, { json: true })`, `callOps('schema.showRaw', { packName }, { json: true })`, `callOps('schema.mutate', { payload: string })`, where `payload` is `JSON.stringify({ pack, mutations })`.

- [ ] **Step 1: Write the failing contract test**

Use the same harness as `test/contract/schema.contract.test.ts`: `execOperation` builds argv and runs it in `gbrain-ops`, and `composeExec` runs raw commands for cleanup.

```ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { execOperation, assertOk } from '../../src/contracts/exec.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { buildArgv } from '../../src/contracts/argv.ts';
import { composeUp, composeDown, composeExec, resetBrain, BRAIN_DB_URL } from '../helpers/stack.ts';

const PACK = `zz-contract-${Date.now().toString(36)}`;

beforeAll(async () => {
  // Copy schema.contract.test.ts's beforeAll verbatim: the fork and mutate
  // verbs need an initialized brain.
  await composeUp();
  await resetBrain();
  assertOk(OPERATIONS.init!, await execOperation(OPERATIONS.init!, {
    nonInteractive: true, force: true, url: BRAIN_DB_URL,
    embeddingModel: 'openai:text-embedding-3-small', schemaPack: 'gbrain-base-v2',
  }, { timeoutMs: 600_000 }));
}, 900_000);

afterAll(async () => {
  await composeExec('gbrain-ops', ['sh', '-c', `rm -rf /srv/gbrain-home/.gbrain/schema-packs/${PACK}`]);
  await composeDown();
}, 120_000);

test("'schema.fork' copies a bundled pack under a new name", async () => {
  expect(buildArgv(OPERATIONS['schema.fork']!, { from: 'gbrain-base-v2', to: PACK }, { json: true }))
    .toEqual(['schema', 'fork', 'gbrain-base-v2', PACK, '--json']);
  const r = await execOperation(OPERATIONS['schema.fork']!, { from: 'gbrain-base-v2', to: PACK }, { json: true });
  assertOk(OPERATIONS['schema.fork']!, r);
  expect(JSON.parse(r.stdout).to).toBe(PACK);
});

test("'schema.showRaw' prints the pack's own declarations", async () => {
  const r = await execOperation(OPERATIONS['schema.showRaw']!, { packName: PACK }, { json: true });
  assertOk(OPERATIONS['schema.showRaw']!, r);
  expect(JSON.parse(r.stdout).name).toBe(PACK);
});

test("'schema.mutate' applies a batch atomically, and a failed batch changes nothing", async () => {
  const ok = JSON.stringify({ pack: PACK, mutations: [
    { op: 'add_type', name: 'contract', primitive: 'entity', prefix: 'contracts/' },
  ] });
  const r = await execOperation(OPERATIONS['schema.mutate']!, { payload: ok });
  assertOk(OPERATIONS['schema.mutate']!, r);
  expect(JSON.parse(r.stdout).mutations_applied).toBe(1);

  const bad = JSON.stringify({ pack: PACK, mutations: [
    { op: 'add_type', name: 'x', primitive: 'entity', prefix: 'x/' },
    { op: 'remove_type', name: 'does-not-exist' },
  ] });
  const f = await execOperation(OPERATIONS['schema.mutate']!, { payload: bad });
  const body = JSON.parse(f.stdout);
  expect(body.error).toBe('mutation_failed');
  expect(body.pack_unchanged).toBe(true);
  const show = await execOperation(OPERATIONS['schema.showRaw']!, { packName: PACK }, { json: true });
  expect(JSON.parse(show.stdout).page_types.some((t: { name: string }) => t.name === 'x')).toBe(false);
});
```

If S7 step 1 measured a non-zero exit for a failed batch, add that code to `schema.mutate`'s `okExitCodes` so the body can still be read, and assert it here.

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test test/contract/schema-authoring.contract.test.ts`
Expected: FAIL, `OPERATIONS['schema.fork']` is undefined.

- [ ] **Step 3: Add the entries**

In `src/contracts/registry.ts`, after `'schema.sync'`:

```ts
  /**
   * Copies a pack's RAW manifest to `~/.gbrain/schema-packs/<to>/pack.json`
   * at version 0.0.1 (runForkCmd). The one way to make a bundled pack
   * editable: mutations refuse bundled packs with PACK_READONLY. MEASURED,
   * docs/schema-pack-findings.md S7.
   */
  'schema.fork': {
    id: 'schema.fork',
    argv: ['schema', 'fork'],
    params: [
      { name: 'from', flag: '', kind: 'value', required: true },
      { name: 'to', flag: '', kind: 'value', required: true },
    ],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'read-only',
    okExitCodes: [0],
  },

  /**
   * The UNRESOLVED manifest: a pack's own declarations only. The editor needs
   * it to tell "own" from "inherited". Never use it for counts; those come
   * from 'schema.show' + packOverride (S4).
   */
  'schema.showRaw': {
    id: 'schema.showRaw',
    argv: ['schema', 'show'],
    params: [{ name: 'packName', flag: '', kind: 'value', required: true }],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * gbrain's ATOMIC batch mutator, through the trusted local `call` lane:
   * every mutation is validated in memory and the pack file is written at
   * most once (applyMutationsAtomic). A failed batch returns
   * `{error:'mutation_failed', code, failed_at_index, pack_unchanged:true}`,
   * and `call` still exits 0 (S7 step 1), so callers MUST inspect the body.
   * Not the admin MCP lane: no agent grant ever carries this.
   */
  'schema.mutate': {
    id: 'schema.mutate',
    argv: ['call', 'schema_apply_mutations'],
    params: [{ name: 'payload', flag: '', kind: 'value', required: true }],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },
```

If S7 recorded a different fork `privilege` requirement or exit code, use the measured values.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test test/unit/registry.test.ts && bun test test/contract/schema-authoring.contract.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/registry.ts test/contract/schema-authoring.contract.test.ts
git commit -m "feat(contracts): schema fork, raw show and atomic mutate at the pin"
```

---

### Task 2: PackDraft, the one shape humans, agents and the console share

**Files:**
- Create: `src/control/schemaDraft.ts`
- Create: `skills/mobrain-schema-designer/pack-draft.schema.json`
- Test: `test/unit/schema-draft.test.ts`

**Interfaces:**
- Produces:
  - `type PackDraft`
  - `validateDraft(d: unknown): { ok: true; draft: PackDraft } | { ok: false; errors: string[] }`
  - `draftToManifest(d: PackDraft, gbrainMinVersion: string): Record<string, unknown>`
  - `type PackMutation`
  - `validateMutations(m: unknown): { ok: true; mutations: PackMutation[] } | { ok: false; errors: string[] }`
  - `PRIMITIVES`, `BUNDLED_PACKS`, `PACK_NAME`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, describe } from 'bun:test';
import { validateDraft, draftToManifest, validateMutations } from '../../src/control/schemaDraft.ts';

const good = {
  name: 'legal-ops',
  description: 'Contracts and counterparties',
  extends: 'gbrain-base-v2',
  pageTypes: [
    { name: 'contract', primitive: 'entity', folder: 'contracts/', description: 'A signed agreement',
      extraPrefixes: ['legal/contracts/'], aliases: [], extractable: true, expertRouting: false },
    { name: 'matter', primitive: 'temporal', folder: 'matters/', description: 'A legal matter',
      extraPrefixes: [], aliases: [], extractable: false, expertRouting: false },
  ],
  linkVerbs: [{ name: 'governs', inverse: 'governed_by', fromType: 'contract', toType: 'matter' }],
};

describe('validateDraft', () => {
  test('accepts a well-formed draft', () => {
    expect(validateDraft(good).ok).toBe(true);
  });
  test('rejects a bundled name', () => {
    const r = validateDraft({ ...good, name: 'gbrain-base-v2' });
    expect(r.ok).toBe(false);
  });
  test('rejects an unknown primitive, a traversing folder and a folder without a trailing slash', () => {
    const r = validateDraft({ ...good, pageTypes: [
      { ...good.pageTypes[0], primitive: 'thing' },
      { ...good.pageTypes[1], folder: '../etc/' },
      { ...good.pageTypes[1], name: 'memo', folder: 'memos' },
    ] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBe(3);
  });
  test('rejects duplicate type names and two types claiming one folder', () => {
    const r = validateDraft({ ...good, pageTypes: [good.pageTypes[0], { ...good.pageTypes[0] }] });
    expect(r.ok).toBe(false);
  });
  test('rejects a link verb naming a type the draft does not declare, when there is no extends', () => {
    const r = validateDraft({ ...good, extends: null,
      linkVerbs: [{ name: 'employs', fromType: 'company', toType: 'person' }] });
    expect(r.ok).toBe(false);
  });
  test('allows a link verb to a type the parent may provide when extends is set', () => {
    const r = validateDraft({ ...good, linkVerbs: [{ name: 'signed', fromType: 'person', toType: 'contract' }] });
    expect(r.ok).toBe(true);
  });
});

describe('draftToManifest', () => {
  test('emits gbrain snake_case with folder as the first prefix and a filing rule', () => {
    const r = validateDraft(good);
    if (!r.ok) throw new Error('fixture');
    const m = draftToManifest(r.draft, '0.50.5.0') as any;
    expect(m.api_version).toBe('gbrain-schema-pack-v1');
    expect(m.version).toBe('0.1.0');
    expect(m.extends).toBe('gbrain-base-v2');
    expect(m.page_types[0]).toEqual({
      name: 'contract', primitive: 'entity',
      path_prefixes: ['contracts/', 'legal/contracts/'], aliases: [],
      extractable: true, expert_routing: false,
    });
    expect(m.link_types[0]).toEqual({
      name: 'governs', inverse: 'governed_by', inference: { page_type: 'contract', target_type: 'matter' },
    });
    expect(m.filing_rules[0]).toEqual({
      kind: 'contract', directory: 'contracts/', examples: [], description: 'A signed agreement',
    });
  });
  test('omits extends entirely for a standalone ontology', () => {
    const r = validateDraft({ ...good, extends: null, linkVerbs: [] });
    if (!r.ok) throw new Error('fixture');
    expect('extends' in draftToManifest(r.draft, '0.50.5.0')).toBe(false);
  });
});

describe('validateMutations', () => {
  test('accepts the gbrain op vocabulary and rejects anything else', () => {
    expect(validateMutations([{ op: 'add_type', name: 'memo', primitive: 'annotation', prefix: 'memos/' }]).ok).toBe(true);
    expect(validateMutations([{ op: 'drop_table' }]).ok).toBe(false);
    expect(validateMutations([]).ok).toBe(false);
  });
  test('rejects a traversing prefix inside a mutation', () => {
    expect(validateMutations([{ op: 'add_prefix', type: 'memo', prefix: '../x/' }]).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test test/unit/schema-draft.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Implement `src/control/schemaDraft.ts`**

```ts
/**
 * PackDraft: the ONE shape a custom ontology travels in, whether an admin
 * builds it in the console, an agent drafts it with the mobrain-schema-designer
 * skill, or someone pastes it into "Import draft". camelCase on our side; only
 * draftToManifest speaks gbrain's snake_case (S4 field names).
 *
 * Validation here is a FRONT gate for good error messages. gbrain's own
 * `schema validate` + `schema lint` still run after every write and remain
 * the authority. We never reimplement the extends merge, which is why link
 * verbs that name a type the parent might provide are allowed when `extends`
 * is set.
 */
export const PACK_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TYPE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const VERB_NAME = /^[a-z][a-z0-9_]{0,63}$/;
export const PRIMITIVES = ['entity', 'media', 'temporal', 'annotation', 'concept'] as const;
export type Primitive = typeof PRIMITIVES[number];
export const BUNDLED_PACKS = [
  'gbrain-base', 'gbrain-base-v2', 'gbrain-recommended',
  'gbrain-creator', 'gbrain-investor', 'gbrain-engineer', 'gbrain-everything',
] as const;

export type DraftPageType = {
  name: string; primitive: Primitive; folder: string; description: string;
  extraPrefixes: string[]; aliases: string[]; extractable: boolean; expertRouting: boolean;
};
export type DraftLinkVerb = { name: string; inverse?: string; fromType?: string; toType?: string };
export type PackDraft = {
  name: string; description: string; extends: string | null;
  pageTypes: DraftPageType[]; linkVerbs: DraftLinkVerb[];
};

/** A repo-relative directory: segments of [a-z0-9_-], trailing slash, no traversal. */
export function isFolder(p: unknown): p is string {
  return typeof p === 'string' && /^([a-z0-9][a-z0-9_-]*\/)+$/.test(p) && p.length <= 200;
}

const str = (v: unknown, d = '') => (typeof v === 'string' ? v.trim() : d);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function validateDraft(input: unknown): { ok: true; draft: PackDraft } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const o = (input ?? {}) as Record<string, unknown>;
  const name = str(o.name);
  if (!PACK_NAME.test(name)) errors.push('name must be lowercase letters, digits and hyphens');
  if ((BUNDLED_PACKS as readonly string[]).includes(name)) errors.push(`${name} is a bundled pack name`);
  const ext = o.extends === null || o.extends === undefined || o.extends === '' ? null : str(o.extends);
  if (ext !== null && !PACK_NAME.test(ext)) errors.push(`extends ${ext} is not a pack name`);
  if (ext === name) errors.push('a pack cannot extend itself');

  const rawTypes = Array.isArray(o.pageTypes) ? o.pageTypes : [];
  if (rawTypes.length === 0 && ext === null) errors.push('a standalone pack needs at least one page type');
  const seenTypes = new Set<string>();
  const seenFolders = new Set<string>();
  const pageTypes: DraftPageType[] = rawTypes.map((raw, i) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    const tn = str(t.name);
    const label = `pageTypes[${i}] (${tn || 'unnamed'})`;
    if (!TYPE_NAME.test(tn)) errors.push(`${label}: name must start with a letter; lowercase, digits, - or _`);
    if (seenTypes.has(tn)) errors.push(`${label}: duplicate type name`);
    seenTypes.add(tn);
    const primitive = str(t.primitive) as Primitive;
    if (!(PRIMITIVES as readonly string[]).includes(primitive)) {
      errors.push(`${label}: primitive must be one of ${PRIMITIVES.join(', ')}`);
    }
    const folder = str(t.folder);
    if (!isFolder(folder)) errors.push(`${label}: folder must look like "contracts/" (lowercase, trailing slash, no ..)`);
    const extra = strs(t.extraPrefixes);
    for (const p of [folder, ...extra]) {
      if (p && !isFolder(p)) { if (p !== folder) errors.push(`${label}: prefix ${p} is not a folder path`); continue; }
      if (seenFolders.has(p)) errors.push(`${label}: ${p} is already claimed by another type`);
      seenFolders.add(p);
    }
    return {
      name: tn, primitive, folder, description: str(t.description), extraPrefixes: extra,
      aliases: strs(t.aliases), extractable: t.extractable === true, expertRouting: t.expertRouting === true,
    };
  });

  const rawVerbs = Array.isArray(o.linkVerbs) ? o.linkVerbs : [];
  const seenVerbs = new Set<string>();
  const linkVerbs: DraftLinkVerb[] = rawVerbs.map((raw, i) => {
    const v = (raw ?? {}) as Record<string, unknown>;
    const vn = str(v.name);
    if (!VERB_NAME.test(vn)) errors.push(`linkVerbs[${i}]: name must be snake_case`);
    if (seenVerbs.has(vn)) errors.push(`linkVerbs[${i}]: duplicate verb ${vn}`);
    seenVerbs.add(vn);
    const inverse = str(v.inverse) || undefined;
    if (inverse && !VERB_NAME.test(inverse)) errors.push(`linkVerbs[${i}]: inverse must be snake_case`);
    const fromType = str(v.fromType) || undefined;
    const toType = str(v.toType) || undefined;
    // Only a standalone pack can be checked here; with `extends`, the parent's
    // types are gbrain's to resolve, and lint catches a dangling reference.
    if (ext === null) {
      for (const [k, t] of [['fromType', fromType], ['toType', toType]] as const) {
        if (t && !seenTypes.has(t)) errors.push(`linkVerbs[${i}]: ${k} ${t} is not a type in this pack`);
      }
    }
    return { name: vn, inverse, fromType, toType };
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, draft: { name, description: str(o.description), extends: ext, pageTypes, linkVerbs } };
}

export function draftToManifest(d: PackDraft, gbrainMinVersion: string): Record<string, unknown> {
  return {
    api_version: 'gbrain-schema-pack-v1',
    name: d.name,
    version: '0.1.0',
    gbrain_min_version: gbrainMinVersion.split('.').slice(0, 3).join('.'),
    ...(d.extends ? { extends: d.extends } : {}),
    description: d.description,
    page_types: d.pageTypes.map((t) => ({
      name: t.name, primitive: t.primitive,
      path_prefixes: [t.folder, ...t.extraPrefixes], aliases: t.aliases,
      extractable: t.extractable, expert_routing: t.expertRouting,
    })),
    link_types: d.linkVerbs.map((v) => ({
      name: v.name,
      ...(v.inverse ? { inverse: v.inverse } : {}),
      ...(v.fromType || v.toType
        ? { inference: { ...(v.fromType ? { page_type: v.fromType } : {}), ...(v.toType ? { target_type: v.toType } : {}) } }
        : {}),
    })),
    takes_kinds: ['fact', 'take', 'bet', 'hunch'],
    borrow_from: [],
    frontmatter_links: [],
    enrichable_types: [],
    filing_rules: d.pageTypes.map((t) => ({
      kind: t.name, directory: t.folder, examples: [], ...(t.description ? { description: t.description } : {}),
    })),
  };
}

/** gbrain's applyMutationsAtomic vocabulary (src/core/schema-pack/mutate.ts). */
export type PackMutation =
  | { op: 'add_type'; name: string; primitive: Primitive; prefix: string; extractable?: boolean; expert_routing?: boolean; aliases?: string[] }
  | { op: 'remove_type'; name: string }
  | { op: 'update_type'; name: string; patch: { primitive?: Primitive; extractable?: boolean; expert_routing?: boolean } }
  | { op: 'add_alias' | 'remove_alias'; type: string; alias: string }
  | { op: 'add_prefix' | 'remove_prefix'; type: string; prefix: string }
  | { op: 'add_link_type'; name: string; inverse?: string; inference?: { page_type?: string; target_type?: string } }
  | { op: 'remove_link_type'; name: string }
  | { op: 'set_extractable' | 'set_expert_routing'; type: string; value: boolean };

const OPS = new Set(['add_type', 'remove_type', 'update_type', 'add_alias', 'remove_alias', 'add_prefix',
  'remove_prefix', 'add_link_type', 'remove_link_type', 'set_extractable', 'set_expert_routing']);

export function validateMutations(input: unknown): { ok: true; mutations: PackMutation[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, errors: ['mutations must be a non-empty array'] };
  if (input.length > 200) return { ok: false, errors: ['at most 200 mutations per batch'] };
  const errors: string[] = [];
  input.forEach((m, i) => {
    const o = (m ?? {}) as Record<string, unknown>;
    if (typeof o.op !== 'string' || !OPS.has(o.op)) { errors.push(`[${i}]: unknown op ${String(o.op)}`); return; }
    if ('prefix' in o && !isFolder(o.prefix)) errors.push(`[${i}]: prefix must be a folder path like "memos/"`);
    if ('primitive' in o && !(PRIMITIVES as readonly string[]).includes(String(o.primitive))) errors.push(`[${i}]: bad primitive`);
    for (const k of ['name', 'type', 'alias'] as const) {
      if (k in o && (typeof o[k] !== 'string' || !TYPE_NAME.test(o[k] as string) && !VERB_NAME.test(o[k] as string))) {
        errors.push(`[${i}]: ${k} is not a valid identifier`);
      }
    }
  });
  return errors.length ? { ok: false, errors } : { ok: true, mutations: input as PackMutation[] };
}
```

- [ ] **Step 4: Write `skills/mobrain-schema-designer/pack-draft.schema.json`**

This is a JSON Schema (draft 2020-12) mirroring `PackDraft`, with the same regexes, `primitive` as an enum, and `folder` pattern `^([a-z0-9][a-z0-9_-]*/)+$`. Give every property a `description` written for an agent, because the skill reads it. The file is documentation for agents; `validateDraft` is the enforcement.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `bun test test/unit/schema-draft.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/control/schemaDraft.ts test/unit/schema-draft.test.ts skills/mobrain-schema-designer/pack-draft.schema.json
git commit -m "feat(schema): PackDraft, the shared shape for a custom ontology"
```

---

### Task 3: File plane — write a JSON pack, remove a pack

**Files:**
- Modify: `src/ops/fileplane.ts`, `src/ops/server.ts`, `src/control/opsClient.ts`
- Test: `test/unit/fileplane.test.ts`

**Interfaces:**
- Produces:
  - ops `writeSchemaPackJson(name, json, { sql })` and `removeSchemaPack(name, { sql })`
  - control `putSchemaPackJson(name: string, manifest: object): Promise<void>` and `removeSchemaPack(name: string): Promise<{ removed: boolean }>`

- [ ] **Step 1: Write the failing test**

Append this to `test/unit/fileplane.test.ts`. Follow that file's existing temp-`GBRAIN_HOME` and fake-`sql` setup; read its top first and reuse its helpers.

```ts
describe('schema pack json', () => {
  test('writes pack.json and removes a stale pack.yaml sibling', async () => {
    const dir = join(SCHEMA_PACK_DIR, 'legal-ops');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'pack.yaml'), 'stale: true\n');
    await writeSchemaPackJson('legal-ops', { name: 'legal-ops' }, { sql: fakeSql });
    expect(JSON.parse(await readFile(join(dir, 'pack.json'), 'utf8')).name).toBe('legal-ops');
    expect(existsSync(join(dir, 'pack.yaml'))).toBe(false);
  });
  test('refuses a bundled name and a traversing name', async () => {
    await expect(writeSchemaPackJson('gbrain-base-v2', {}, { sql: fakeSql })).rejects.toThrow();
    await expect(writeSchemaPackJson('../x', {}, { sql: fakeSql })).rejects.toThrow();
  });
  test('removeSchemaPack deletes only the named pack directory', async () => {
    await writeSchemaPackJson('zz-gone', { name: 'zz-gone' }, { sql: fakeSql });
    expect((await removeSchemaPack('zz-gone', { sql: fakeSql })).removed).toBe(true);
    expect(existsSync(join(SCHEMA_PACK_DIR, 'zz-gone'))).toBe(false);
    expect((await removeSchemaPack('zz-gone', { sql: fakeSql })).removed).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test test/unit/fileplane.test.ts`
Expected: FAIL, `writeSchemaPackJson` is not exported.

- [ ] **Step 3: Implement in `src/ops/fileplane.ts`**

Add `rm` to the `node:fs/promises` import, then add:

```ts
const BUNDLED = new Set(['gbrain-base', 'gbrain-base-v2', 'gbrain-recommended',
  'gbrain-creator', 'gbrain-investor', 'gbrain-engineer', 'gbrain-everything']);
const PACK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function assertUserPackName(name: string): void {
  if (!PACK_NAME_RE.test(name)) throw new Error(`invalid schema pack name: ${name}`);
  if (BUNDLED.has(name)) throw new Error(`${name} is a bundled pack and cannot be written`);
}

/**
 * A created pack is written as pack.json: gbrain's `schema fork` writes the
 * same format, gbrain's mutations preserve it, and the control plane has no
 * YAML serializer at runtime. Any pack.yaml / pack.yml sibling is removed,
 * because the loader's precedence between two formats is exactly the kind of
 * silent ambiguity S7 step 4 measured.
 */
export async function writeSchemaPackJson(name: string, manifest: unknown, opts: { sql: SQL }): Promise<void> {
  assertUserPackName(name);
  const dir = join(SCHEMA_PACK_DIR, name);
  await writeFilePlane(join(dir, 'pack.json'), () => JSON.stringify(manifest, null, 2) + '\n', { ...opts, mode: 0o644 });
  for (const sibling of ['pack.yaml', 'pack.yml']) {
    await unlink(join(dir, sibling)).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  }
}

/** Delete one user pack's directory. The path is computed, never accepted. */
export async function removeSchemaPack(name: string, opts: { sql: SQL }): Promise<{ removed: boolean }> {
  assertUserPackName(name);
  const dir = join(SCHEMA_PACK_DIR, name);
  return withAdvisoryLock(opts.sql, `fileplane:${dir}`, async () => {
    const existed = await readdir(dir).then(() => true, () => false);
    await rm(dir, { recursive: true, force: true });
    return { removed: existed };
  });
}
```

Also make the existing `writeSchemaPack` (YAML) remove a `pack.json` sibling the same way, so the Advanced path cannot leave two formats behind. Add `readdir` to the imports.

- [ ] **Step 4: Wire ops routes and the control client**

In `src/ops/server.ts`, next to `/fileplane/schema-pack`:

```ts
      if (url.pathname === '/fileplane/schema-pack-json') {
        const { name, manifest } = body as { name?: string; manifest?: unknown };
        if (!name || typeof manifest !== 'object' || manifest === null) return json({ error: 'name and manifest required' }, 400);
        await writeSchemaPackJson(name, manifest, { sql });
        return json({ ok: true, name });
      }

      if (url.pathname === '/fileplane/schema-pack-remove') {
        const { name } = body as { name?: string };
        if (!name) return json({ error: 'name required' }, 400);
        return json(await removeSchemaPack(name, { sql }));
      }
```

In `src/control/opsClient.ts`:

```ts
export async function putSchemaPackJson(name: string, manifest: object): Promise<void> {
  await post('/fileplane/schema-pack-json', { name, manifest }, 60_000);
}

export async function removeSchemaPack(name: string): Promise<{ removed: boolean }> {
  return post('/fileplane/schema-pack-remove', { name }, 60_000);
}
```

Add both to **every** `mock.module('../../src/control/opsClient.ts', ...)` block in `test/integration/*.test.ts`. The comment in those files says to keep them in sync. Use `grep -l "mock.module('../../src/control/opsClient.ts'" test -r` to find them.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `bun test test/unit/fileplane.test.ts && bun run test:integration`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ops src/control/opsClient.ts test
git commit -m "feat(fileplane): write a pack as json, remove a user pack"
```

---

### Task 4: Folder scaffolding in the ops git lane

**Files:**
- Create: `src/control/scaffold.ts` (the pure half: `scaffoldEntries`)
- Modify: `src/ops/git.ts`, `src/ops/server.ts`, `src/control/opsClient.ts`
- Test: `test/unit/scaffold.test.ts`, `test/unit/git.test.ts`

**Interfaces:**
- Consumes: the richer `PackDetail` from Task 5, Step 3. Define the input type locally here as `ScaffoldSource`, so this task stands alone.
- Produces:
  - `scaffoldEntries(src: ScaffoldSource): ScaffoldEntry[]`, where `ScaffoldEntry = { dir: string; readme: string }`
  - ops `scaffoldFolders({ sourceId, entries, actor, message }, { sql, root? }): Promise<{ created: string[]; skipped: string[]; sha: string | null }>`
  - control `gitScaffold(req): Promise<same>`

- [ ] **Step 1: Write the failing pure test**

```ts
import { test, expect } from 'bun:test';
import { scaffoldEntries } from '../../src/control/scaffold.ts';

const src = {
  pack: 'legal-ops',
  pageTypes: [
    { name: 'contract', primitive: 'entity', pathPrefixes: ['legal/contracts/', 'contracts/'], aliases: ['agreement'], extractable: true },
    { name: 'matter', primitive: 'temporal', pathPrefixes: ['matters/'], aliases: [], extractable: false },
    { name: 'inbox', primitive: 'annotation', pathPrefixes: ['inbox'], aliases: [], extractable: false },
    { name: 'bad', primitive: 'entity', pathPrefixes: ['../etc/'], aliases: [], extractable: false },
  ],
  filingRules: [{ kind: 'contract', directory: 'contracts/', description: 'A signed agreement' }],
  linkTypes: [{ name: 'governs', inverse: 'governed_by', pageType: 'contract', targetType: 'matter' }],
};

test('one folder per type: filing rule first, else first folder-shaped prefix', () => {
  expect(scaffoldEntries(src).map((e) => e.dir)).toEqual(['contracts/', 'matters/']);
});

test('the README names the type, primitive, description, prefixes and verbs', () => {
  const readme = scaffoldEntries(src)[0]!.readme;
  expect(readme).toContain('# Contract');
  expect(readme).toContain('`contract`');
  expect(readme).toContain('entity');
  expect(readme).toContain('A signed agreement');
  expect(readme).toContain('legal/contracts/');
  expect(readme).toContain('governs');
  expect(readme).toContain('legal-ops');
});

test('never emits a traversing, absolute or non-directory path', () => {
  for (const e of scaffoldEntries(src)) expect(e.dir).toMatch(/^([a-z0-9][a-z0-9_-]*\/)+$/);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test test/unit/scaffold.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Implement the pure half in `src/control/scaffold.ts`**

```ts
import { isFolder } from './schemaDraft.ts';

export type ScaffoldSource = {
  pack: string;
  pageTypes: { name: string; primitive: string; pathPrefixes: string[]; aliases: string[]; extractable: boolean }[];
  filingRules: { kind: string; directory: string; description?: string | null }[];
  linkTypes: { name: string; inverse?: string | null; pageType?: string | null; targetType?: string | null }[];
};
export type ScaffoldEntry = { dir: string; readme: string };

const title = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * One folder per page type, from the EFFECTIVE manifest. The filing rule's
 * directory wins because that is where gbrain's own filing guidance tells
 * agents to put the type; otherwise it is the first folder-shaped prefix. A type
 * with neither gets no folder rather than a guessed one. Only paths matching
 * isFolder survive, so nothing a pack declares can steer a write outside the repo.
 *
 * README.md is in gbrain's SYNC_SKIP_FILES (S7 step 5), so the scaffold is
 * never imported as a page.
 */
export function scaffoldEntries(src: ScaffoldSource): ScaffoldEntry[] {
  const out: ScaffoldEntry[] = [];
  const seen = new Set<string>();
  for (const t of src.pageTypes) {
    const rule = src.filingRules.find((r) => r.kind === t.name && isFolder(r.directory));
    const dir = rule?.directory ?? t.pathPrefixes.find(isFolder);
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const verbs = src.linkTypes.filter((l) => l.pageType === t.name || l.targetType === t.name);
    const lines = [
      `# ${title(t.name)}`,
      '',
      rule?.description ? `${rule.description}\n` : '',
      `Pages filed in this folder are typed \`${t.name}\` (primitive: ${t.primitive}) by the \`${src.pack}\` schema pack.`,
      t.pathPrefixes.length > 1 ? `\nAlso typed \`${t.name}\`: ${t.pathPrefixes.filter((p) => p !== dir).map((p) => `\`${p}\``).join(', ')}.` : '',
      t.aliases.length ? `\nAliases: ${t.aliases.join(', ')}.` : '',
      t.extractable ? '\nFacts are extracted from these pages.' : '',
      verbs.length ? `\n## Links\n\n${verbs.map((v) => `- \`${v.name}\`${v.pageType ? ` from ${v.pageType}` : ''}${v.targetType ? ` to ${v.targetType}` : ''}${v.inverse ? ` (inverse: \`${v.inverse}\`)` : ''}`).join('\n')}` : '',
      '',
      '_This README is folder scaffolding. gbrain does not index it as a page._',
      '',
    ];
    out.push({ dir, readme: lines.filter((l) => l !== '').join('\n') + '\n' });
  }
  return out;
}
```

- [ ] **Step 4: Write the failing git test**

Append this to `test/unit/git.test.ts`. Reuse its temp-repo helpers (search the file for how `gitWriteFile` tests init a repo).

```ts
describe('scaffoldFolders', () => {
  test('creates missing READMEs in one commit and never overwrites', async () => {
    const root = await tempReposRoot();          // existing helper pattern in this file
    await initRepo(root, 'customers');           // with a committed README.md at the root
    await mkdir(join(root, 'customers', 'contracts'), { recursive: true });
    await writeFile(join(root, 'customers', 'contracts', 'README.md'), 'mine\n');
    await gitCommitAll(root, 'customers');

    const r = await scaffoldFolders({
      sourceId: 'customers', actor: MEMBER, message: 'scaffold: legal-ops folders',
      entries: [{ dir: 'contracts/', readme: 'x' }, { dir: 'matters/', readme: '# Matter\n' }],
    }, { sql: fakeSql, root });

    expect(r.created).toEqual(['matters/README.md']);
    expect(r.skipped).toEqual(['contracts/README.md']);
    expect(await readFile(join(root, 'customers', 'contracts', 'README.md'), 'utf8')).toBe('mine\n');
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
  });
  test('nothing to create is not a commit', async () => {
    const root = await tempReposRoot();
    await initRepo(root, 'customers');
    const r = await scaffoldFolders({ sourceId: 'customers', actor: MEMBER, message: 'm', entries: [] }, { sql: fakeSql, root });
    expect(r).toEqual({ created: [], skipped: [], sha: null });
  });
  test('refuses a traversing dir before touching the repo', async () => {
    const root = await tempReposRoot();
    await initRepo(root, 'customers');
    await expect(scaffoldFolders({ sourceId: 'customers', actor: MEMBER, message: 'm',
      entries: [{ dir: '../x/', readme: '' }] }, { sql: fakeSql, root })).rejects.toThrow();
  });
});
```

If `test/unit/git.test.ts` has no real-repo helpers, which is possible because it tests pure functions, put these tests in `test/integration/scaffold-git.test.ts` next to the existing real-git integration tests. Find them with `grep -rl "gitWriteFile(" test/integration`.

- [ ] **Step 5: Implement `scaffoldFolders` in `src/ops/git.ts`**

Add `mkdir` and `access` to the `node:fs/promises` import, then add:

```ts
export type ScaffoldRequest = {
  sourceId: string;
  entries: { dir: string; readme: string }[];
  actor: { name: string; email: string };
  message: string;
};

const SCAFFOLD_DIR = /^([a-z0-9][a-z0-9_-]*\/)+$/;

/**
 * Create-only folder scaffolding: for each entry, write `<dir>README.md` IF
 * AND ONLY IF git does not already know that path and it is not on disk. One
 * commit for everything created, as the actor. Never overwrites, never deletes,
 * idempotent on re-run. Validates every dir before the lock, and the commit
 * logic is inlined over `git()` (nesting commitAs would deadlock the pool, see
 * revertRange).
 */
export async function scaffoldFolders(
  req: ScaffoldRequest,
  opts: { sql: SQL; root?: string },
): Promise<{ created: string[]; skipped: string[]; sha: string | null }> {
  if (!SOURCE_ID_RE.test(req.sourceId)) throw new Error(`invalid sourceId: ${req.sourceId}`);
  if (req.entries.length > 500) throw new Error('too many folders');
  for (const e of req.entries) {
    if (!SCAFFOLD_DIR.test(e.dir)) throw new Error(`invalid scaffold dir: ${e.dir}`);
    assertRepoRelative(`${e.dir}README.md`);
  }
  const cwd = join(opts.root ?? REPOS_ROOT, req.sourceId);

  return withRepoLock(opts.sql, req.sourceId, async () => {
    const created: string[] = [];
    const skipped: string[] = [];
    for (const e of req.entries) {
      const rel = `${e.dir}README.md`;
      const exists = await access(join(cwd, rel)).then(() => true, () => false);
      if (exists) { skipped.push(rel); continue; }
      await mkdir(join(cwd, e.dir), { recursive: true });
      await writeFile(join(cwd, rel), e.readme, { encoding: 'utf8', flag: 'wx' });
      created.push(rel);
    }
    if (created.length === 0) return { created, skipped, sha: null };
    await git(cwd, ['add', '--', ...created]);
    const commit = await git(cwd, commitArgs(req.actor, req.message));
    if (commit.exitCode !== 0) throw new Error(`git commit failed for ${req.sourceId}: ${gitFailure(commit)}`);
    return { created, skipped, sha: await resolveCommit(cwd, 'HEAD') };
  });
}
```

`flag: 'wx'` makes the create-only rule hold even if a file appears between the check and the write.

- [ ] **Step 6: Wire ops and the control client**

In `src/ops/server.ts`, next to `/git/write-file`:

```ts
      if (url.pathname === '/git/scaffold') {
        return json(await scaffoldFolders(body as ScaffoldRequest, { sql }));
      }
```

In `src/control/opsClient.ts`:

```ts
export async function gitScaffold(req: {
  sourceId: string; entries: { dir: string; readme: string }[];
  actor: { name: string; email: string }; message: string;
}): Promise<{ created: string[]; skipped: string[]; sha: string | null }> {
  return post('/git/scaffold', req, 120_000);
}
```

Add `gitScaffold: async () => ({ created: [], skipped: [], sha: null })` to every integration `opsClient` mock.

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `bun test test/unit/scaffold.test.ts test/unit/git.test.ts && bun run test:integration`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/control/scaffold.ts src/ops/git.ts src/ops/server.ts src/control/opsClient.ts test
git commit -m "feat(git): create-only folder scaffolding from a pack's page types"
```

---

### Task 5: The authoring API

**Files:**
- Modify: `src/control/routes/schema.ts`, `src/control/routes/wizard.ts` (`listSchemaPacks` sections)
- Modify: `src/control/scaffold.ts` (add the orchestration half: `scaffoldSpaces`)
- Test: `test/integration/schema-routes.test.ts`

**Interfaces:**
- Consumes: Task 1's ops ids, Task 2's `validateDraft` / `draftToManifest` / `validateMutations` / `BUNDLED_PACKS`, Task 3's `putSchemaPackJson` / `removeSchemaPack`, Task 4's `scaffoldEntries` / `gitScaffold`.
- Produces:
  - `GET /api/schema/packs` → `PackDetail[]` with `bundled`, `filingRules` and `linkTypes`
  - `GET /api/schema/packs/:name` → `{ effective: PackDetail, own: { pageTypes: string[]; linkVerbs: string[] } | null, editable: boolean, usedBy: { brain: boolean; sources: string[] } }`
  - `POST /api/schema/packs` with body `{ mode: 'draft', draft: PackDraft } | { mode: 'fork', from: string, name: string }` → `{ ok, name, error, lint }`
  - `POST /api/schema/packs/:name/mutations` with body `{ mutations: PackMutation[] }` → `{ ok, batchId, applied, lint, scaffolded }`, or 400/409
  - `DELETE /api/schema/packs/:name` → `{ ok }`, 409 if used
  - `POST /api/schema/scaffold` with body `{ source?: string }` → `{ ok, results: { sourceId, pack, created, skipped }[] }`
  - `export async function scaffoldSpaces(orgId: string, userId: string, sourceIds?: string[]): Promise<ScaffoldResult[]>`

- [ ] **Step 1: Write the failing integration tests**

Add these to `test/integration/schema-routes.test.ts`, reusing its `opsHandler`, `packWrites`, owner/member cookies and `invalidateSchemaPackCache()`. Extend the mock with `putSchemaPackJson` (record into a `jsonPackWrites` array), `removeSchemaPack`, and `gitScaffold` (record into `scaffolds`).

```ts
const draft = {
  name: 'legal-ops', description: 'Contracts', extends: 'gbrain-base-v2',
  pageTypes: [{ name: 'contract', primitive: 'entity', folder: 'contracts/', description: 'Signed',
    extraPrefixes: [], aliases: [], extractable: true, expertRouting: false }],
  linkVerbs: [],
};

test('POST /schema/packs (draft) writes pack.json, then validates and lints', async () => {
  opsHandler = (op) => {
    if (op === 'schema.list') return reply(0, 'Bundled packs:\n  gbrain-base-v2\n\n');
    if (op === 'schema.validate') return reply(0, '✓ valid');
    if (op === 'schema.lint') return { ...reply(0, ''), json: { ok: true, errors: [], warnings: [] } };
    return reply(0, '');
  };
  const res = await post('/api/schema/packs', { mode: 'draft', draft }, ownerCookie);
  expect(res.status).toBe(200);
  expect(jsonPackWrites.at(-1)!.name).toBe('legal-ops');
  expect((jsonPackWrites.at(-1)!.manifest as any).page_types[0].path_prefixes).toEqual(['contracts/']);
});

test('POST /schema/packs refuses a name that already exists', async () => {
  opsHandler = (op) => op === 'schema.list'
    ? reply(0, 'Bundled packs:\n  gbrain-base-v2\n\nInstalled packs (1):\n  legal-ops\n\n') : reply(0, '');
  const res = await post('/api/schema/packs', { mode: 'draft', draft }, ownerCookie);
  expect(res.status).toBe(409);
});

test('POST /schema/packs rejects an invalid draft with every error', async () => {
  const res = await post('/api/schema/packs', { mode: 'draft', draft: { ...draft, name: 'Bad Name' } }, ownerCookie);
  expect(res.status).toBe(400);
  expect((await res.json()).errors.length).toBeGreaterThan(0);
});

test('POST /schema/packs/:name/mutations refuses a bundled pack before calling gbrain', async () => {
  const calls: string[] = [];
  opsHandler = (op) => { calls.push(op); return reply(0, ''); };
  const res = await post('/api/schema/packs/gbrain-base-v2/mutations',
    { mutations: [{ op: 'add_type', name: 'x', primitive: 'entity', prefix: 'x/' }] }, ownerCookie);
  expect(res.status).toBe(400);
  expect(calls).not.toContain('schema.mutate');
});

test('a failed batch answers 409 with gbrain\'s code and index, even though call exited 0', async () => {
  opsHandler = (op) => {
    if (op === 'schema.list') return reply(0, 'Bundled packs:\n  gbrain-base-v2\n\nInstalled packs (1):\n  legal-ops\n\n');
    if (op === 'schema.mutate') return reply(0, JSON.stringify({
      error: 'mutation_failed', code: 'TYPE_NOT_FOUND', message: 'no such type', failed_at_index: 1,
      mutations_applied: 0, pack_unchanged: true }));
    return reply(0, '');
  };
  const res = await post('/api/schema/packs/legal-ops/mutations', { mutations: [
    { op: 'add_type', name: 'memo', primitive: 'annotation', prefix: 'memos/' },
    { op: 'remove_type', name: 'ghost' },
  ] }, ownerCookie);
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.code).toBe('TYPE_NOT_FOUND');
  expect(body.failedAtIndex).toBe(1);
  expect(body.packUnchanged).toBe(true);
});

test('a successful batch on the ACTIVE pack scaffolds new folders into inheriting Spaces', async () => {
  // opsHandler: schema.list lists legal-ops installed; schema.active → legal-ops;
  // schema.mutate → {mutations_applied:1,batch_id:'b1',results:[{}]};
  // schema.show (packOverride legal-ops) → manifest containing memo with prefix memos/;
  // config.get → exit 1 (no per-source override).
  // Expect 200, body.applied === 1, and scaffolds.at(-1).entries to include { dir: 'memos/' }.
});

test('DELETE /schema/packs/:name refuses the active pack and any overridden Space', async () => {
  // schema.active → legal-ops; expect 409 and no removeSchemaPack call.
});

test('member gets 403 on every authoring route', async () => {
  for (const [m, p] of [['POST', '/api/schema/packs'], ['POST', '/api/schema/packs/x/mutations'],
    ['DELETE', '/api/schema/packs/x'], ['POST', '/api/schema/scaffold']] as const) {
    const res = await app.request(p, { method: m, headers: { cookie: memberCookie, 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(403);
  }
});
```

Fill in the two sketched tests with the same `opsHandler` style as the ones above; the comments list every op each one must answer. If `reply` and `post` don't already exist in the file, define `reply(exit, stdout)` → `{ ok: exit === 0, exitCode: exit, stdout, stderr: '', json: null }` and `post(path, body, cookie)` → `app.request(...)`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test test/integration/schema-routes.test.ts`
Expected: FAIL, 404 on the new routes.

- [ ] **Step 3: Enrich `PackDetail` and split bundled from installed**

In `src/control/routes/wizard.ts`, refactor `listSchemaPacks` into `listSchemaPackSections(): Promise<{ bundled: string[]; installed: string[] }>`, using the same parsing loop and pushing into the current section. Keep `listSchemaPacks()` as `[...bundled, ...installed]`, so existing callers are unchanged.

In `src/control/routes/schema.ts`, extend the types and `toPackDetail`:

```ts
export type PackDetail = {
  name: string; version: string | null; description: string | null; extends: string | null;
  bundled: boolean;
  pageTypes: PackPageType[];
  linkVerbs: string[];
  linkTypes: { name: string; inverse: string | null; pageType: string | null; targetType: string | null }[];
  filingRules: { kind: string; directory: string; description: string | null }[];
  takesKinds: string[];
  error: string | null;
};
```

Add `expertRouting: p.expert_routing === true` to `PackPageType`. Extend `RawManifest` with `link_types[].inverse`, `link_types[].inference.{page_type,target_type}`, `page_types[].expert_routing`, and `filing_rules[]`. Map `bundled` from `BUNDLED_PACKS.includes(name)`. Mirror the new fields in `src/console/api.ts`'s `PackDetail` / `PackPageType`. Existing console tests construct `PackDetail` literals, so add the new fields to their fixtures (`test/unit/console-schema.test.ts`).

- [ ] **Step 4: Add `scaffoldSpaces` to `src/control/scaffold.ts`**

`resolveSourcePacks` and `packDetail` live in `routes/schema.ts`. Export `packDetail` from there (rename it to `effectivePack`, since it is now public) and import both here. `schema.ts` imports `scaffoldSpaces` from here, so keep the import one-directional by passing `effectivePack` and `resolveSourcePacks` in as dependencies:

```ts
import { actorIdentity } from './actor.ts';
import { gitScaffold } from './opsClient.ts';

export type ScaffoldResult = { sourceId: string; pack: string | null; created: string[]; skipped: string[]; error: string | null };

type Deps = {
  resolveSourcePacks: (orgId: string) => Promise<{ sourceId: string; pack: string | null }[]>;
  effectivePack: (pack: string) => Promise<{ error: string | null } & Omit<ScaffoldSource, 'pack'>>;
};

/**
 * Scaffold every (or the named) Space from the pack THAT Space resolves: its
 * per-source stored intent, else the brain-wide pack (the same resolution the
 * Sources page shows). A Space whose pack failed to resolve reports the error
 * and is skipped, never scaffolded from a guess. Per-Space failures do not
 * abort the others.
 */
export async function scaffoldSpaces(orgId: string, userId: string, deps: Deps, sourceIds?: string[]): Promise<ScaffoldResult[]> {
  const actor = await actorIdentity(userId);
  const spaces = (await deps.resolveSourcePacks(orgId))
    .filter((s) => !sourceIds || sourceIds.includes(s.sourceId));
  const results: ScaffoldResult[] = [];
  for (const s of spaces) {
    if (!s.pack) { results.push({ sourceId: s.sourceId, pack: null, created: [], skipped: [], error: 'no resolved pack' }); continue; }
    const detail = await deps.effectivePack(s.pack);
    if (detail.error) { results.push({ sourceId: s.sourceId, pack: s.pack, created: [], skipped: [], error: detail.error }); continue; }
    try {
      const r = await gitScaffold({
        sourceId: s.sourceId, actor, message: `scaffold: ${s.pack} folders`,
        entries: scaffoldEntries({ pack: s.pack, ...detail }),
      });
      results.push({ sourceId: s.sourceId, pack: s.pack, created: r.created, skipped: r.skipped, error: null });
    } catch (e) {
      results.push({ sourceId: s.sourceId, pack: s.pack, created: [], skipped: [], error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
```

`resolveSourcePacks` returns `SourcePackResolution[]`, which already has `sourceId` and `pack`. Scaffolded READMEs are skipped by sync, so no reindex is needed; don't call `syncAndEmbed`.

- [ ] **Step 5: Implement the routes in `src/control/routes/schema.ts`**

```ts
import { BUNDLED_PACKS, draftToManifest, validateDraft, validateMutations } from '../schemaDraft.ts';
import { scaffoldSpaces } from '../scaffold.ts';
import { putSchemaPackJson, removeSchemaPack } from '../opsClient.ts';
import { listSchemaPackSections } from './wizard.ts';

const isBundled = (n: string) => (BUNDLED_PACKS as readonly string[]).includes(n);
const deps = (version: string) => ({
  resolveSourcePacks,
  effectivePack: (pack: string) => effectivePack(version, pack),
});

/** After any write: gbrain's validate + lint are the authority, not ours. */
async function checkPack(name: string) {
  const invalid = await validationError(name);
  return { invalid, lint: invalid ? null : await lint(name, false) };
}

schemaRoutes.get('/schema/packs/:name', guard('admin', async (c, { orgId }) => {
  const name = c.req.param('name') ?? '';
  if (!PACK_NAME.test(name)) return c.json({ error: 'invalid pack name' }, 400);
  const brain = await loadBrain(orgId);
  const { bundled, installed } = await listSchemaPackSections();
  if (![...bundled, ...installed].includes(name)) return c.json({ error: `unknown schema pack ${name}` }, 404);
  const effective = await effectivePack(brain.gbrainVersion ?? '', name);
  const raw = await callOps<RawManifest>('schema.showRaw', { packName: name }, { json: true, timeoutMs: 60_000 });
  const own = raw.json ? {
    pageTypes: (raw.json.page_types ?? []).map((t) => t.name ?? '').filter(Boolean),
    linkVerbs: (raw.json.link_types ?? []).map((l) => l.name ?? '').filter(Boolean),
  } : null;
  const active = await readActive();
  const sources = (await resolveSourcePacks(orgId)).filter((s) => !s.inherited && s.pack === name).map((s) => s.sourceId);
  return c.json({ effective, own, editable: !bundled.includes(name), usedBy: { brain: active.pack === name, sources } });
}));

schemaRoutes.post('/schema/packs', guard('admin', async (c, { userId, orgId }) => {
  const body = await c.req.json().catch(() => ({}));
  const brain = await loadBrain(orgId);
  const { bundled, installed } = await listSchemaPackSections();
  const known = [...bundled, ...installed];

  let name: string;
  if (body?.mode === 'fork') {
    const from = String(body.from ?? ''); name = String(body.name ?? '');
    if (!known.includes(from)) return c.json({ error: `unknown schema pack ${from}` }, 400);
    if (!PACK_NAME.test(name) || isBundled(name)) return c.json({ error: 'invalid pack name' }, 400);
    if (known.includes(name)) return c.json({ error: `${name} already exists` }, 409);
    const r = await callOps('schema.fork', { from, to: name }, { json: true, timeoutMs: 60_000 });
    if (!r.ok) return c.json({ error: `schema fork failed (exit ${r.exitCode})`, detail: r.stderr }, 400);
  } else if (body?.mode === 'draft') {
    const v = validateDraft(body.draft);
    if (!v.ok) return c.json({ error: 'invalid draft', errors: v.errors }, 400);
    name = v.draft.name;
    if (known.includes(name)) return c.json({ error: `${name} already exists` }, 409);
    if (v.draft.extends && !known.includes(v.draft.extends)) return c.json({ error: `unknown parent pack ${v.draft.extends}` }, 400);
    await putSchemaPackJson(name, draftToManifest(v.draft, brain.gbrainVersion ?? '0.50.5.0'));
  } else {
    return c.json({ error: "mode must be 'draft' or 'fork'" }, 400);
  }

  invalidateSchemaPackCache();
  const { invalid, lint: report } = await checkPack(name);
  await audit(orgId, userId, 'schema.pack.create', name, { name, mode: body.mode, valid: invalid === null });
  // Created, not activated. A pack that fails gbrain's gate stays on disk so the
  // admin can fix it in the editor; the response says so, it is never a green.
  return c.json({ ok: invalid === null && (report?.ok ?? false), name, error: invalid, lint: report });
}));

schemaRoutes.post('/schema/packs/:name/mutations', guard('admin', async (c, { userId, orgId }) => {
  const name = c.req.param('name') ?? '';
  if (!PACK_NAME.test(name)) return c.json({ error: 'invalid pack name' }, 400);
  if (isBundled(name)) return c.json({ error: `${name} is bundled and read-only. Fork it first.`, code: 'PACK_READONLY' }, 400);
  const { installed } = await listSchemaPackSections();
  if (!installed.includes(name)) return c.json({ error: `unknown schema pack ${name}` }, 404);

  const body = await c.req.json().catch(() => ({}));
  const v = validateMutations(body?.mutations);
  if (!v.ok) return c.json({ error: 'invalid mutations', errors: v.errors }, 400);

  const r = await callOps<never>('schema.mutate',
    { payload: JSON.stringify({ pack: name, mutations: v.mutations }) }, { timeoutMs: 120_000 });
  let out: any = null;
  try { out = JSON.parse(r.stdout ?? ''); } catch { /* prose or empty: handled below */ }
  // `call` exits 0 on a handler-level failure (S7 step 1), so the BODY decides.
  if (!r.ok || !out || out.error) {
    await audit(orgId, userId, 'schema.pack.mutate.failed', name, {
      count: v.mutations.length, code: out?.code ?? null, index: out?.failed_at_index ?? null,
    });
    return c.json({
      ok: false, error: out?.message ?? (`${r.stdout ?? ''}${r.stderr ?? ''}`.trim() || `exit ${r.exitCode}`),
      code: out?.code ?? null, failedAtIndex: out?.failed_at_index ?? null, packUnchanged: out?.pack_unchanged ?? null,
    }, 409);
  }

  invalidateSchemaPackCache();
  const { invalid, lint: report } = await checkPack(name);
  // New types need folders wherever this pack is in effect. Folders are
  // create-only, so re-running for existing types is a no-op.
  const brain = await loadBrain(orgId);
  const using = (await resolveSourcePacks(orgId)).filter((s) => s.pack === name).map((s) => s.sourceId);
  const scaffolded = using.length ? await scaffoldSpaces(orgId, userId, deps(brain.gbrainVersion ?? ''), using) : [];

  await audit(orgId, userId, 'schema.pack.mutate', name, {
    count: v.mutations.length, ops: [...new Set(v.mutations.map((m) => m.op))], batchId: out.batch_id,
  });
  return c.json({ ok: invalid === null, batchId: out.batch_id, applied: out.mutations_applied, error: invalid, lint: report, scaffolded });
}));

schemaRoutes.delete('/schema/packs/:name', guard('admin', async (c, { userId, orgId }) => {
  const name = c.req.param('name') ?? '';
  if (!PACK_NAME.test(name) || isBundled(name)) return c.json({ error: 'only user packs can be deleted' }, 400);
  const active = await readActive();
  const sources = (await resolveSourcePacks(orgId)).filter((s) => !s.inherited && s.pack === name).map((s) => s.sourceId);
  if (active.pack === name || sources.length) {
    return c.json({ error: `${name} is in use`, usedBy: { brain: active.pack === name, sources } }, 409);
  }
  // Another pack may extend this one; gbrain would then fail to resolve it.
  const brain = await loadBrain(orgId);
  const { installed } = await listSchemaPackSections();
  const children: string[] = [];
  for (const other of installed.filter((n) => n !== name)) {
    const d = await effectivePack(brain.gbrainVersion ?? '', other);
    if (d.extends === name) children.push(other);
  }
  if (children.length) return c.json({ error: `${children.join(', ')} extend ${name}`, children }, 409);
  const r = await removeSchemaPack(name);
  invalidateSchemaPackCache();
  await audit(orgId, userId, 'schema.pack.delete', name, { removed: r.removed });
  return c.json({ ok: true, removed: r.removed });
}));

schemaRoutes.post('/schema/scaffold', guard('admin', async (c, { userId, orgId }) => {
  const body = await c.req.json().catch(() => ({}));
  const source = typeof body?.source === 'string' ? body.source : undefined;
  if (source !== undefined && !(await spaceExists(orgId, source))) return c.json({ error: `unknown source ${source}` }, 400);
  const brain = await loadBrain(orgId);
  const results = await scaffoldSpaces(orgId, userId, deps(brain.gbrainVersion ?? ''), source ? [source] : undefined);
  await audit(orgId, userId, 'schema.scaffold', source ?? 'brain', {
    spaces: results.length, created: results.reduce((n, r) => n + r.created.length, 0),
  });
  return c.json({ ok: results.every((r) => r.error === null), results });
}));
```

Also call `scaffoldSpaces` in two existing handlers:
- At the end of a successful `/schema/apply`, for Spaces whose resolution is `inherited`. Add the result as `scaffolded` in the response.
- In `POST /schema/sources/:sourceId` after its readback succeeds, scoped to `[sourceId]`.

The delete route's child check reads `extends` from the effective detail. That works because the resolved `schema show` manifest keeps `extends` (S4 table), and `toPackDetail` already maps it.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `bun test test/integration/schema-routes.test.ts && bun test test/unit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/control test
git commit -m "feat(schema): create, fork, mutate, delete and scaffold custom packs"
```

---

### Task 6: A new brain gets its folders

**Files:**
- Modify: `src/control/routes/wizard.ts` (`/finish`, `addSpaceSource`)
- Test: `test/unit/wizard-finish.test.ts`, `test/integration/schema-routes.test.ts` (or the wizard integration test that covers `/finish`; find it with `grep -rl "wizard/finish" test`)

**Interfaces:**
- Consumes: `scaffoldSpaces` and its deps from Task 5.
- Produces: `/finish` response gains `scaffold: ScaffoldResult[]`, and `addSpaceSource` returns `scaffold?: ScaffoldResult[]` on a ready brain.

- [ ] **Step 1: Write the failing test**

In the integration test that drives `/api/wizard/finish`, drive a brain to `sources-added` using that file's existing setup. Answer `schema.active` with `gbrain-base-v2`, and `schema.show` (packOverride) with a manifest containing `page_types: [{ name: 'person', primitive: 'entity', path_prefixes: ['people/'] }]`. Then assert:

```ts
const res = await post('/api/wizard/finish', {}, ownerCookie);
const body = await res.json();
expect(scaffolds.map((s) => s.sourceId)).toEqual(spaceIds);          // every Space
expect(scaffolds[0]!.entries.map((e) => e.dir)).toContain('people/');
// Ordering: scaffold happens after every sources.add and BEFORE sync.
expect(opsOrder.indexOf('sync')).toBeGreaterThan(opsOrder.lastIndexOf('sources.add'));
expect(scaffoldAt).toBeLessThan(opsOrder.indexOf('sync'));
expect(body.scaffold.every((r: any) => r.error === null)).toBe(true);
```

Record `opsOrder` (op ids in call order) and `scaffoldAt = opsOrder.length` inside the `gitScaffold` mock.

A second test: `POST /api/sources` on a `ready` brain calls `gitScaffold` once for the new `sourceId`.

- [ ] **Step 2: Run it and confirm it fails**

Expected: FAIL, `gitScaffold` is never called.

- [ ] **Step 3: Implement**

In `/finish`, after the `sources.add` loop and before `search-mode` / `sync`:

```ts
  // The chosen pack's folders, one README per page type, before the first
  // sync so a teammate's first page lands in a folder that already explains
  // itself. README.md is a gbrain metafile, so sync never imports it (S7).
  // A scaffold failure is reported, never fatal: the brain is still usable.
  const scaffold = await scaffoldSpaces(orgId, userId, {
    resolveSourcePacks, effectivePack: (p) => effectivePack(brain.gbrainVersion ?? '', p),
  }).catch((e) => [{ sourceId: '*', pack: null, created: [], skipped: [], error: String(e?.message ?? e) }]);
```

Add `scaffold` to the JSON response. `brain.gbrainVersion` may still be null here; `effectivePack` keys its cache on `''` in that case, which is correct because only the key is affected.

In `addSpaceSource`, after the insert and only when `brain.lifecycle === 'ready'`, call `scaffoldSpaces(orgId, userId, deps, [sourceId])` and include the result. During the wizard, `/finish` does it instead.

Import `resolveSourcePacks` and `effectivePack` from `./schema.ts`. If this creates an import cycle (schema.ts already imports `listSchemaPacks` from wizard.ts), move `listSchemaPacks` / `listSchemaPackSections` into a new `src/control/schemaPacks.ts` and import it from both files. Do that move first, as its own commit, if the cycle breaks module loading under `bun test`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun run test:unit && bun run test:integration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/control test
git commit -m "feat(wizard): a new brain's Spaces are scaffolded from its pack"
```

---

### Task 7: Console — pack builder and editor

**Files:**
- Create: `src/console/pages/SchemaBuilder.tsx`
- Modify: `src/console/pages/Schema.tsx`, `src/console/api.ts`
- Test: `test/unit/console-schema-builder.test.ts`

**Interfaces:**
- Consumes: the Task 5 routes; `PackDraft` (import the type from `../../control/schemaDraft.ts`, because the console already type-imports across `src/`; confirm with `grep -rn "from '../../control" src/console`, and if none exist, copy the type into `api.ts`).
- Produces:
  - `schemaPacksApi.get(name)`, `.create(body)`, `.mutate(name, mutations)`, `.remove(name)`, `.scaffold(source?)`
  - Pure helpers: `emptyDraft()`, `draftFromJson(text)`, `editsToMutations(before, after)`, `folderFor(typeName)`

This console is tested through pure functions (see `Schema.tsx`'s comment and `test/unit/console-upgrades.test.ts`). The component only arranges them.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from 'bun:test';
import { emptyDraft, draftFromJson, editsToMutations, folderFor } from '../../src/console/pages/SchemaBuilder.tsx';

test('folderFor turns a type name into its default folder', () => {
  expect(folderFor('contract')).toBe('contracts/');
  expect(folderFor('matter_note')).toBe('matter-notes/');
  expect(folderFor('person')).toBe('people/');
  expect(folderFor('')).toBe('');
});

test('draftFromJson accepts a skill-produced draft and reports parse errors plainly', () => {
  expect(draftFromJson('{"name":"x","pageTypes":[],"linkVerbs":[]}').ok).toBe(true);
  const bad = draftFromJson('{nope');
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.error).toMatch(/JSON/);
});

test('editsToMutations: add, remove, flag flips, prefix and verb changes, in gbrain op vocabulary', () => {
  const before = { pageTypes: [
    { name: 'contract', primitive: 'entity', pathPrefixes: ['contracts/'], aliases: [], extractable: false, expertRouting: false },
    { name: 'memo', primitive: 'annotation', pathPrefixes: ['memos/'], aliases: [], extractable: false, expertRouting: false },
  ], linkTypes: [{ name: 'governs', inverse: null, pageType: 'contract', targetType: null }] };
  const after = { pageTypes: [
    { name: 'contract', primitive: 'entity', pathPrefixes: ['contracts/', 'legal/'], aliases: ['agreement'], extractable: true, expertRouting: false },
    { name: 'matter', primitive: 'temporal', pathPrefixes: ['matters/'], aliases: [], extractable: false, expertRouting: true },
  ], linkTypes: [{ name: 'about', inverse: null, pageType: 'memo', targetType: 'matter' }] };
  expect(editsToMutations(before, after)).toEqual([
    { op: 'remove_link_type', name: 'governs' },
    { op: 'remove_type', name: 'memo' },
    { op: 'add_type', name: 'matter', primitive: 'temporal', prefix: 'matters/', extractable: false, expert_routing: true, aliases: [] },
    { op: 'add_prefix', type: 'contract', prefix: 'legal/' },
    { op: 'add_alias', type: 'contract', alias: 'agreement' },
    { op: 'set_extractable', type: 'contract', value: true },
    { op: 'add_link_type', name: 'about', inference: { page_type: 'memo', target_type: 'matter' } },
  ]);
});

test('emptyDraft extends the brain default so a first custom pack keeps the base types', () => {
  expect(emptyDraft('gbrain-base-v2').extends).toBe('gbrain-base-v2');
});
```

The ordering in `editsToMutations` is deliberate: removals first (link verbs, then types, because gbrain refuses `STILL_REFERENCED`), then adds, then per-type edits, then new link verbs, which can reference new types. Extra prefixes of an added type become `add_prefix` mutations after the `add_type`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test test/unit/console-schema-builder.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Implement the pure helpers at the top of `SchemaBuilder.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { schemaPacksApi, type PackDetail } from '../api.ts';
import { Badge, Button, Card, Empty, Table, TableWrap } from '../ui/index.tsx';
import type { PackDraft, PackMutation } from '../../control/schemaDraft.ts';

const IRREGULAR: Record<string, string> = { person: 'people', company: 'companies', media: 'media', analysis: 'analyses' };

export function folderFor(type: string): string {
  const t = type.trim().toLowerCase().replace(/_/g, '-');
  if (!t) return '';
  const parts = t.split('-');
  const last = parts.pop()!;
  const plural = IRREGULAR[last] ?? (/(s|x|ch|sh)$/.test(last) ? `${last}es` : /[^aeiou]y$/.test(last) ? `${last.slice(0, -1)}ies` : `${last}s`);
  return `${[...parts, plural].join('-')}/`;
}

export function emptyDraft(parent: string | null): PackDraft {
  return { name: '', description: '', extends: parent, pageTypes: [], linkVerbs: [] };
}

export function draftFromJson(text: string): { ok: true; draft: PackDraft } | { ok: false; error: string } {
  try { return { ok: true, draft: JSON.parse(text) as PackDraft }; }
  catch (e) { return { ok: false, error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` }; }
}

type EditType = { name: string; primitive: string; pathPrefixes: string[]; aliases: string[]; extractable: boolean; expertRouting: boolean };
type EditLink = { name: string; inverse: string | null; pageType: string | null; targetType: string | null };
type EditState = { pageTypes: EditType[]; linkTypes: EditLink[] };

/**
 * The editor holds the pack's OWN declarations as local state; Save diffs
 * that against what was loaded and sends ONE batch, which gbrain applies
 * atomically or not at all. Order matters to gbrain's reference checks:
 * removals first, then adds, then per-type edits, then new verbs.
 */
export function editsToMutations(before: EditState, after: EditState): PackMutation[] {
  const out: PackMutation[] = [];
  const b = new Map(before.pageTypes.map((t) => [t.name, t]));
  const a = new Map(after.pageTypes.map((t) => [t.name, t]));
  const bl = new Map(before.linkTypes.map((l) => [l.name, l]));
  const al = new Map(after.linkTypes.map((l) => [l.name, l]));
  const sameLink = (x: EditLink, y: EditLink) => x.inverse === y.inverse && x.pageType === y.pageType && x.targetType === y.targetType;

  for (const [n, l] of bl) if (!al.has(n) || !sameLink(l, al.get(n)!)) out.push({ op: 'remove_link_type', name: n });
  for (const n of b.keys()) if (!a.has(n)) out.push({ op: 'remove_type', name: n });
  for (const [n, t] of a) {
    if (b.has(n)) continue;
    out.push({ op: 'add_type', name: n, primitive: t.primitive as never, prefix: t.pathPrefixes[0]!,
      extractable: t.extractable, expert_routing: t.expertRouting, aliases: t.aliases });
    for (const p of t.pathPrefixes.slice(1)) out.push({ op: 'add_prefix', type: n, prefix: p });
  }
  for (const [n, t] of a) {
    const old = b.get(n);
    if (!old) continue;
    for (const p of t.pathPrefixes) if (!old.pathPrefixes.includes(p)) out.push({ op: 'add_prefix', type: n, prefix: p });
    for (const p of old.pathPrefixes) if (!t.pathPrefixes.includes(p)) out.push({ op: 'remove_prefix', type: n, prefix: p });
    for (const x of t.aliases) if (!old.aliases.includes(x)) out.push({ op: 'add_alias', type: n, alias: x });
    for (const x of old.aliases) if (!t.aliases.includes(x)) out.push({ op: 'remove_alias', type: n, alias: x });
    if (t.primitive !== old.primitive) out.push({ op: 'update_type', name: n, patch: { primitive: t.primitive as never } });
    if (t.extractable !== old.extractable) out.push({ op: 'set_extractable', type: n, value: t.extractable });
    if (t.expertRouting !== old.expertRouting) out.push({ op: 'set_expert_routing', type: n, value: t.expertRouting });
  }
  for (const [n, l] of al) {
    const old = bl.get(n);
    if (old && sameLink(old, l)) continue;
    const inference = l.pageType || l.targetType
      ? { ...(l.pageType ? { page_type: l.pageType } : {}), ...(l.targetType ? { target_type: l.targetType } : {}) } : undefined;
    out.push({ op: 'add_link_type', name: n, ...(l.inverse ? { inverse: l.inverse } : {}), ...(inference ? { inference } : {}) });
  }
  return out;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test test/unit/console-schema-builder.test.ts`
Expected: PASS.

- [ ] **Step 5: Build the components**

Build these in `SchemaBuilder.tsx`, using only the existing primitives `Card`, `Table`, `TableWrap`, `Button`, `Badge` and `Empty` from `../ui/index.tsx`. Follow the design-system spec in `docs/superpowers/specs/2026-09-22-console-design-system-design.md`, with no new CSS classes.

- `NewPackPanel({ parent, packs, onCreated })` has three tabs:
  - **Design**: a name, a description, and "Builds on" (select: any known pack, or "Nothing — standalone"). Below it is a page-type table where each row has name, primitive (select), folder (prefilled with `folderFor(name)` until the user edits it), description, and extractable / expert checkboxes. A link-verb table has name, from type, to type, and inverse.
  - **From template**: pick a pack and name the copy, then `create({ mode: 'fork' })`.
  - **Import draft**: a textarea plus `draftFromJson`. It fills the Design tab so the admin reviews before creating.
  
  Submit calls `schemaPacksApi.create({ mode: 'draft', draft })`. Render `errors[]` as a list, then gbrain's `error` and `lint` exactly as the existing apply flow does.
- `PackEditor({ name, onSaved })` loads `schemaPacksApi.get(name)` and shows **own** types editable and **inherited** types read-only, marked with a `Badge` "from <extends>". Save calls `schemaPacksApi.mutate(name, editsToMutations(loaded, current))`. A 409 shows `error`, `code` and "row N" from `failedAtIndex`, and says "Nothing was changed" when `packUnchanged`. On success, show `scaffolded` as "Created N folders in <Space>". If `editable` is false, render a single "Fork to edit" button instead of the editor.
- Delete lives in the editor. It is disabled with the reason when `usedBy.brain` is true or `usedBy.sources` isn't empty.

In `Schema.tsx`:
- Add a "New pack" button that opens `NewPackPanel` with `parent = state.active.pack`.
- Add an "Edit" action on every pack row. For a bundled pack it reads "Fork to edit".
- Add a "Create folders" button beside Sync that calls `schemaPacksApi.scaffold()` and lists the per-Space results. Show errors per Space, and never show one green summary.
- Keep `ADDITIVE_NOTICE`. Add a sentence to the builder: *"Adding a type creates its folder in every Space using this pack. Existing pages keep their type; Sync fills in pages that have none."*

In `src/console/api.ts`, add the five calls to `schemaPacksApi`, with types matching the Task 5 response shapes exactly.

- [ ] **Step 6: Verify in the running app**

Run the `redeploy` skill (console fast path). Then, in the browser:
1. On Schema, click New pack → Design. Enter `legal-ops`, builds on the brain default, types `contract` and `matter`, and verb `governs`. Create it, and expect a clean lint.
2. Apply `legal-ops`. The response lists scaffolded folders, and Files shows `contracts/README.md` and `matters/README.md` in each inheriting Space.
3. Edit `legal-ops`: add type `memo`, then Save. Files shows `memos/README.md`.
4. Import draft: paste a draft with an invalid folder `memos` (no slash), and expect the error list without a request to gbrain.
5. Delete `legal-ops` while it is active, and expect a disabled button with the reason.

Take a screenshot of each step's result.

- [ ] **Step 7: Commit**

```bash
git add src/console test/unit/console-schema-builder.test.ts
git commit -m "feat(console): build, import and edit custom schema packs"
```

---

### Task 8: The `mobrain-schema-designer` skill

**Files:**
- Create: `skills/mobrain-schema-designer/SKILL.md`
- Create: `skills/mobrain-schema-designer/examples/legal-ops.json`, `examples/research-lab.json`
- Modify: `src/control/routes/schema.ts` (`GET /schema/skill` serves the bundle), `src/console/pages/Schema.tsx` ("Use your agent" link)
- Test: `test/unit/schema-skill.test.ts`

**Interfaces:**
- Consumes: `validateDraft` (Task 2), which the test runs on every example.
- Produces: a skill any agent (Claude Code, OpenClaw, etc.) can load. Its only output is a PackDraft JSON block.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { validateDraft } from '../../src/control/schemaDraft.ts';

test('every example draft passes the same gate the import route uses', () => {
  for (const f of readdirSync('skills/mobrain-schema-designer/examples')) {
    const r = validateDraft(JSON.parse(readFileSync(`skills/mobrain-schema-designer/examples/${f}`, 'utf8')));
    expect({ f, ok: r.ok, errors: r.ok ? [] : r.errors }).toEqual({ f, ok: true, errors: [] });
  }
});

test('the skill never instructs a mutation', () => {
  const skill = readFileSync('skills/mobrain-schema-designer/SKILL.md', 'utf8');
  for (const forbidden of ['schema_apply_mutations', 'add-type', 'schema use', 'config set', 'put_page']) {
    expect(skill).not.toContain(forbidden);
  }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Expected: FAIL, the directory doesn't exist.

- [ ] **Step 3: Write the skill**

`skills/mobrain-schema-designer/SKILL.md`:

````markdown
---
name: mobrain-schema-designer
description: Design a custom Mobrain schema pack (the brain's ontology: page types, their folders, and the link verbs between them) from a team's requirements. Use when someone says "design our schema", "set up types for our brain", "what page types should we have", "custom ontology", or describes their domain (legal, research, sales, hiring) and wants the brain shaped around it. Produces a PackDraft JSON for an admin to import in the Mobrain console; it never changes the brain itself.
---

# Mobrain schema designer

You turn a team's requirements into a **PackDraft**: a JSON document an admin
pastes into **Console → Schema → New pack → Import draft**. The console
validates it, runs gbrain's own lint, and the admin decides whether to create and
apply it. You never create, apply or edit a pack yourself, and you never write
pages while doing this.

## 1. Understand the domain (ask, don't assume)

Ask at most five questions, one at a time, and stop early when you have enough:
1. What does the team do, and what decisions should the brain help with?
2. What are the *things* you keep track of? (people, clients, contracts, experiments…)
3. What *happens* over time? (meetings, matters, sprints, trials…)
4. How do those things relate? Phrase it as "a ___ ___ a ___", for example "a contract governs a matter".
5. Which things should the brain know *experts* on, and which pages hold facts worth extracting?

## 2. Look at what already exists (read-only, if you are connected)

If you have the gbrain MCP tools, use only `list_pages`, `search` and `get_page`
to see existing folders and page names. Reuse a folder the team already uses
instead of inventing a parallel one.

## 3. Choose types

- Keep it to 3–12 types. Every type must earn its place: fewer than ~20 pages
  expected in its first quarter means it's probably a tag, not a type.
- Pick one **primitive** per type:
  - `entity`: a durable thing with an identity (person, company, contract, product)
  - `temporal`: something anchored in time (meeting, matter, sprint, trial)
  - `concept`: an idea or topic (thesis, framework, technique)
  - `annotation`: a note *about* other pages (memo, review, decision)
  - `media`: a captured artifact (paper, recording, deck)
- `folder` is lowercase, plural, and ends with `/` (`contracts/`, `matters/`). Nested is fine (`legal/contracts/`).
- `extractable: true` only where facts should be pulled out of pages (contracts, people).
- `expertRouting: true` only for types that represent people or teams who *know* things.
- `extends`: use `"gbrain-base-v2"` unless the team explicitly wants *only* their
  types. It keeps people, companies, meetings and the other basics. Set it to `null` for a
  standalone ontology, and then declare every type your link verbs mention.

## 4. Choose link verbs

`snake_case` verbs read left to right: `fromType` `name` `toType`
(`contract governs matter`). Add `inverse` when the reverse reads naturally
(`governed_by`). Prefer 3–10 verbs.

## 5. Output

Show a short table of types (name, primitive, folder, why), then the verbs, then
**one** fenced `json` block containing the PackDraft and nothing else. It must
satisfy `pack-draft.schema.json` next to this file. See `examples/` for two
complete drafts. End with: "Paste this into Console → Schema → New pack → Import
draft. Creating it adds a README to each folder in every Space that uses it;
existing pages keep their types."
````

Write `examples/legal-ops.json` (contract, matter, counterparty, memo, with verbs governs, party_to, about) and `examples/research-lab.json` (researcher (expertRouting), experiment, paper (media, extractable), dataset, with verbs authored, uses, cites), both `extends: "gbrain-base-v2"`.

- [ ] **Step 4: Serve the skill from the console**

Add `GET /api/schema/skill` (admin) to `src/control/routes/schema.ts`. It returns `{ files: { 'SKILL.md': string, 'pack-draft.schema.json': string, 'examples/legal-ops.json': string, 'examples/research-lab.json': string } }`, read at module load from `skills/mobrain-schema-designer/`. Check that `docker/control-plane.Dockerfile` copies `skills/` into the image; add a `COPY skills ./skills` if not, and update `test/unit/control-plane-dockerfile.test.ts` if it pins the COPY lines.

In `Schema.tsx`, under New pack, add a "Design with your agent" card. It explains the skill in one sentence and offers a "Download skill" button that zips nothing: it saves `SKILL.md` and the schema as two files through `Blob` downloads. It also tells the admin where to put them, for example `~/.claude/skills/mobrain-schema-designer/` for Claude Code.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `bun test test/unit/schema-skill.test.ts test/unit/control-plane-dockerfile.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add skills src/control/routes/schema.ts src/console/pages/Schema.tsx docker test/unit
git commit -m "feat(skill): mobrain-schema-designer drafts an ontology for an admin to import"
```

---

### Task 9: Custom pack in the wizard (gated on S7 step 7)

**Files:**
- Modify: `src/control/routes/wizard.ts` (`POST /wizard/schema`), `src/console/pages/Wizard.tsx` (schema step)
- Test: `test/unit/wizard-space-step.test.ts` style, plus the wizard integration test

**Branch A: S7 step 7 showed validate/lint/show work before `init`.** The schema step gets a third option, "Design our own", which embeds `NewPackPanel` (Design / Import draft tabs, parent `gbrain-base-v2`). `POST /wizard/schema` accepts `{ pack }` as today, or `{ draft }`. For a draft, it runs `validateDraft`, then `putSchemaPackJson`, then `validationError`, and stores `brain.schemaPack = draft.name`. `/finish` already passes `--schema-pack` to `init` and, since Task 6, scaffolds from it.

**Branch B: they need a DB.** The wizard keeps the template choice and adds one line under it: *"Want your own types? After setup, open Schema → New pack, or use the schema-designer skill with your agent."* No other change.

- [ ] **Step 1:** Write a test for the branch S7 selected. For Branch A: `POST /api/wizard/schema` with `{ draft }` writes `pack.json`, stores `schemaPack`, and a later `/finish` passes `schemaPack: draft.name` to `init`. For Branch B: a unit test that the step's helper copy includes "Schema → New pack".
- [ ] **Step 2:** Run it and confirm it fails.
- [ ] **Step 3:** Implement the selected branch.
- [ ] **Step 4:** Run it and confirm it passes. Then check it in the browser on a fresh stack (`bun run test:e2e` family, or a `down -v` + wizard): the Files page lists one README per type in every Space right after `/finish`.
- [ ] **Step 5: Commit** with `git commit -m "feat(wizard): start a brain on your own schema pack"`.

---

### Task 10: Docs and verification

**Files:**
- Modify: `docs/product-overview.md` (Schema section), `CHANGELOG.md`, `README.md` (feature list, if it enumerates features)
- Create: nothing else

- [ ] **Step 1:** Add a "Custom schema packs" subsection to `docs/product-overview.md`. It should cover the three paths (design in the console, import a draft, use the agent skill), the rule that only admins write, the automatic folder scaffolding, and additive sync.
- [ ] **Step 2:** Add an `Unreleased` entry to `CHANGELOG.md`.
- [ ] **Step 3: Run every verification suite**

```bash
bun run test:unit
bun run test:integration
bun run test:contract
bun run lint:forbidden
bun x tsc --noEmit
```

All five must pass. Paste the tails into `docs/superpowers/plans/PROGRESS.md` in the house format.

- [ ] **Step 4: Live check against the dev stack**

```bash
docker exec brainstand-gbrain-ops-1 gbrain schema list          # legal-ops under Installed packs
docker exec brainstand-gbrain-ops-1 gbrain schema active        # after apply: Active pack: legal-ops
docker exec brainstand-gbrain-ops-1 sh -c 'ls /srv/brain-repos/*/contracts/README.md'
docker exec brainstand-gbrain-ops-1 gbrain schema stats --json  # no page typed from a README
```

Then return the stack to its baseline: apply `gbrain-base-v2`, delete `legal-ops`, and leave the README commits, which are harmless and revertable through the product.

- [ ] **Step 5: Commit**

```bash
git add docs CHANGELOG.md README.md
git commit -m "docs: custom schema packs and folder scaffolding"
```

---

## Out of scope, and why

- **Agents mutating packs over MCP (`schema_apply_mutations` with admin scope).** The console's grant model deliberately keeps the admin lane out of agents' hands. The skill drafts and a human applies. We can revisit this if a "schema-steward" Connection profile is ever designed on purpose.
- **In-console "Draft with AI"** through the model gateway. It's a natural follow-up, because the gateway and the Anthropic key already exist, and it would reuse the skill's instructions as its system prompt and `validateDraft` as its output gate. It's left out to keep this slice about the authoring surface itself.
- **Editing `filing_rules`, `frontmatter_links`, `enrichable_types`, `takes_kinds`, `phases` after creation.** gbrain has no mutation verb for these. The existing Advanced YAML `PUT /schema/pack` remains the path.
- **Reclassifying already-typed pages after a pack change.** `schema sync` is additive by gbrain's design (S3), so this is not ours to override.
- **Per-person ontologies.** Pages are shared within a brain, so the ontology is per brain with per-Space overrides (tier 3).
