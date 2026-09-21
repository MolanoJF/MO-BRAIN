# Schema-pack findings — resolution tiers, raw vs effective, and the per-source probe

> Task 0 of the *Per-source schema packs + informative pack browsing* plan. Every fact below was
> measured against the live dev stack on **2026-09-21**, `gbrain 0.50.5.0`, containers
> `brainstand-gbrain-ops-1` (the CLI target), `brainstand-postgres-1` (the brain DB), and
> `brainstand-gbrain-serve-1` / `-worker-1`. Where a command was run, the exact command, exit code
> and observed output are quoted in S6.
>
> This file has been cited ~12 times across `src/contracts/registry.ts`, `src/contracts/capability.ts`,
> `src/control/routes/schema.ts`, `src/control/routes/wizard.ts`, `src/control/db/schema.ts` and
> `src/ops/fileplane.ts` while never existing. The section numbers below are load-bearing — the
> citations point at S1, S2, S3, S5 by number and expect the semantics stated there.
>
> Status labels used in this house style: **MEASURED** (ran it, output quoted), **UNVERIFIED** (not
> run here; do not present as fact), **FALSIFIED** (measured and the assumed claim is wrong).

---

## S1 — the resolution chain

gbrain resolves the active schema pack through a **7-tier** chain. Tier order is
highest-priority-first; gbrain's own `gbrain schema --help` prints it verbatim (MEASURED, S6):

```
1. Per-call --schema-pack flag (CLI only)
2. GBRAIN_SCHEMA_PACK env var
3. Per-source DB config schema_pack.source.<id>
4. Brain-wide DB config schema_pack
5. gbrain.yml schema: section
6. ~/.gbrain/config.json schema_pack
7. Default: gbrain-base
```

Source of truth: `src/core/schema-pack/registry.ts`'s `resolveActivePackName`, whose
`ResolutionResult.source` union is exactly
`'per-call' | 'env' | 'per-source-db' | 'db-config' | 'gbrain-yml' | 'home-config' | 'default'`
(MEASURED by reading the installed source at
`/root/.bun/install/global/node_modules/gbrain/src/core/schema-pack/registry.ts:113-121` in the
ops container).

**Tier 3 is `schema_pack.source.<id>` in the brain DB `config` table.** The table is
`public.config (key text, value text)`. Per-source packs are **natively supported by gbrain's
resolver** — `resolveActivePackName` checks `input.sourceId && input.perSourceDb?.has(input.sourceId)`
before the brain-wide `dbConfig` tier. The tier-3 read is threaded by callers that pass a
`sourceId` and a `perSourceDb` map (`src/core/schema-pack/per-source.ts` builds per-source closure
CTEs for federated search; `src/core/skillpack/brain-resident-locate.ts:91` reads
`schema_pack.source.${sourceId}` directly).

**Important grammar caveat (MEASURED, see S6 probe 1):** `gbrain config set` has a strict
unknown-key gate (`src/commands/config.ts`), and `schema_pack.source.` is **not** in
`KNOWN_CONFIG_KEY_PREFIXES` (`src/core/config.ts:1616`). Writing the tier-3 key therefore
**requires `--force`**:

```
$ gbrain config set schema_pack.source.customers gbrain-investor
[config] Unknown config key "schema_pack.source.customers".
[config] No similar known key. Run `gbrain config show` to see currently-set keys.
[config] If this is intentional (downstream tooling, forward-compat), re-run with --force.
# exit 1
```

With `--force` it is accepted, and it **lands in the DB `config` table, not the file plane**
(MEASURED, S6 probe 1):

```
$ gbrain config set schema_pack.source.customers gbrain-investor --force
[config] WARN: writing unknown key "schema_pack.source.customers" with --force. Nothing in gbrain reads this.
Set schema_pack.source.customers = gbrain-investor
# exit 0
```

The `WARN ... Nothing in gbrain reads this` line is **inaccurate for this key** — the tier-3
resolvers above do read it. It is a false negative of the `KNOWN_CONFIG_KEY_PREFIXES` allowlist,
not evidence the key is inert.

The existing registry entry `config.set` (`src/contracts/registry.ts:79`) has `params [key, value]`
and **no `--force` flag**. As written, `callOps('config.set', { key: 'schema_pack.source.<id>', value: pack })`
would exit 1 on the unknown-key gate and never write tier 3. Any Task 4 write path must add the
`--force` flag to that operation (or a dedicated one) — this is a **plan defect**, not an
implementation detail. See S6 probe 1.

---

## S2 — `schema active` and the tiers

**`schema active` is prose-only and ignores `--json`.** MEASURED: `gbrain schema active` and
`gbrain schema active --json` emit byte-identical stdout. The handler signature is
`runActive(_args: string[])` (`src/commands/schema.ts:190`) — the leading underscore marks the
argument as deliberately unused, the same defect shape as `schema list` (Slice 0 V2 / Work Item K).
`gbrain schema --help`'s blanket line *"All new verbs accept --json"* is wrong for `active`.
`supportsJson: false` on the registry entry is correct; parse the prose with
`parseSchemaActiveProse` (`src/contracts/capability.ts:121`).

`schema active` is **the only command that reports the resolution TIER** (`Source: <tier>`). That
is what makes it load-bearing.

**Tier 4 (db-config) outranks tier 6 (home-config), and `/schema/apply` writes tier 6.** This is
the heart of the shadowing hazard: this repo's `/schema/apply` writes `~/.gbrain/config.json`'s
`schema_pack` field (tier 6), but a brain-DB-plane `schema_pack` key (tier 4) **silently outranks
it**. MEASURED: with a tier-4 value set, `gbrain schema use <pack>` reports success while changing
nothing in that state, because tier 4 wins. Always read the truth back with `gbrain schema active`
and surface divergence rather than trusting the column / file you wrote. Cited by
`src/control/db/schema.ts:105-108`, `src/control/routes/wizard.ts:182-185`,
`src/control/routes/schema.ts`, `src/contracts/registry.ts:433-438`, `src/contracts/capability.ts:100`.

**`config get schema_pack`'s shadowing note is inverted.** MEASURED: with a DB-plane value set,
`gbrain config get schema_pack` prints the **file value** plus a note saying the DB value *"also
exists and is shadowed at runtime"*. That is backwards — tier 4 (DB) OUTRANKS tier 6 (file) in
`resolveActivePackName`, so the DB value is the one that wins and the file value is the one being
shadowed. `config get` therefore **cannot** be used to read the effective pack. This is cited by
`src/contracts/registry.ts:438` and `src/contracts/capability.ts:100-103`.

**`config show` prints the FILE plane only.** MEASURED: `gbrain config show` lists
`openai_api_key`, `engine`, `database_url`, `embedding_model`, `embedding_dimensions`, `schema_pack`,
`mcp`, `self_upgrade`, `protocol_installed_at`, `database_path` — and **omits** `chunk_strategy`,
`search.mode`, `search.reranker.enabled`, `sync.last_run`, which all live in the DB `config` table
(MEASURED via `psql`). `config show` is not a DB-aware read; `config get <key>` is.

---

## S3 — `schema sync` is additive-only

**The sync probe and the chunked UPDATE are both fenced by `(type IS NULL OR type = '')`.** Sync
fills blank types; it cannot reclassify, delete or unembed anything. Source of truth:
`src/core/schema-pack/sync.ts` — `probePrefix` builds
`WHERE deleted_at IS NULL AND (type IS NULL OR type = '') AND source_path LIKE $1`, and
`applyTypeAssignment`'s `WITH win AS (...) UPDATE pages SET type = $1 WHERE id IN (SELECT id FROM win)`
repeats the same `(type IS NULL OR type = '')` predicate.

Consequence: a page that already has a non-empty `type` is invisible to sync, even when its
`source_path` matches a different declared prefix. Sync is a **one-way backfill of blanks**, not a
reclassifier. Cited by `src/control/routes/schema.ts:203-206`.

**Preview is the default; there is no `--dry-run` flag.** MEASURED: `gbrain schema sync --dry-run --json`
(both flag orders) is rejected *before dispatch*:

```
{"status":"error","reason":"invalid_flag","message":"unknown flag --dry-run for 'gbrain schema'"}
# exit 1
```

`supportsDryRun: false` on the registry entry is correct. Preview is `apply: false` (the absence of
`--apply`), confirmed by `gbrain schema sync --json` returning `"apply": false`,
`per_prefix[]` with `applied: 0`, and a populated `total_would_apply`. `--apply` is the only
mutating switch.

**`--source <id>` is accepted and, on a non-empty brain, provably fences** — see S6 probe 4 and the
Gate-4 verdict below. The registry's `schema.sync` entry **does not currently expose a `--source`
param**; Task 4/5 need to add one if the per-source backfill button ships.

---

## S4 — raw vs effective manifests

**`gbrain schema show <pack> --json` prints the *unresolved* manifest.** With a positional pack
name, `runShow` loads the raw file via `loadPackFromFile(path)` and prints its own `page_types` /
`link_types` — it does **not** walk `extends` or `borrow_from`. MEASURED table (commands exactly as
in S6 evidence; `raw` = positional form, `effective` = `GBRAIN_SCHEMA_PACK=<pack> gbrain schema show --json`
with **no positional**):

| pack | raw page types | effective | raw link types | effective |
|---|---|---|---|---|
| gbrain-base | 27 | 27 | 12 | 12 |
| gbrain-base-v2 | 19 | 19 | 17 | 17 |
| gbrain-recommended | 12 | **32** | 0 | **12** |
| gbrain-creator | 1 | **27** | 0 | **12** |
| gbrain-investor | 2 | **29** | 0 | **12** |
| gbrain-engineer | 1 | **28** | 0 | **12** |
| gbrain-everything | 0 | **30** | 0 | **12** |

(Effective `name`/`version`/`extends` for the seven: `gbrain-base@1.0.0` (no extends),
`gbrain-base-v2@1.2.0` (no extends), `gbrain-recommended@1.0.0` extends `gbrain-base`,
`gbrain-creator@1.0.0` extends `gbrain-base`, `gbrain-investor@1.0.0` extends `gbrain-base`,
`gbrain-engineer@1.0.0` extends `gbrain-base`, `gbrain-everything@1.0.0` extends `gbrain-investor`.
MEASURED — full command in S6.)

**The one call that resolves a pack correctly is the env-var tier with no positional argument.**
`show` with no arg means "the active pack", and `GBRAIN_SCHEMA_PACK=<pack>` makes any pack active
for that call. This uses gbrain's own resolver (`loadActivePack` → `resolvePack` → `mergeInheritedManifest`).
Example, `gbrain-investor` effective (MEASURED):

```
$ env GBRAIN_SCHEMA_PACK=gbrain-investor gbrain schema show --json
# name: gbrain-investor  version: 1.0.0  extends: gbrain-base
# page_types: 29   link_types: 12
```

**Never reimplement the `extends`/`borrow_from` merge.** It is not a union: `gbrain-creator` is
27 effective from 27 base + 1 own, and `gbrain-investor` is 29 effective from 27 base + 2 own —
child-wins de-duplication over a base-first merge, not concatenation (`mergeInheritedManifest` in
`src/core/schema-pack/merge.ts`). Guessing it in TypeScript would produce a false claim. Task 1's
`packOverride` seam and Task 3's `/api/schema/packs` exist precisely to route through gbrain's own
resolver.

**Exact JSON field names** (MEASURED, top level of `schema show --json`):
`schema_version`, `api_version`, `name`, `version`, `description`, `gbrain_min_version`, `extends`,
`borrow_from`, `page_types`, `link_types`, `frontmatter_links`, `takes_kinds`, `enrichable_types`,
`filing_rules`, `phases`, `calibration_domains`.

**Page-type entry field names** (MEASURED, the real keys — no camelCase variants):
`name`, `primitive`, `path_prefixes`, `aliases`, `extractable`, `expert_routing`.

**Link-type entry field names** (MEASURED): `name`, optional `inverse`, optional `inference`
(object, e.g. `{"page_type":"meeting"}`), plus other optional fields. Example effective
`link_types[0]` for `gbrain-investor`:

```json
{ "name": "attended", "inference": { "page_type": "meeting" } }
```

**Full raw example — `gbrain-investor`** (MEASURED, so the doc records the exact shape):

```json
{
  "name": "gbrain-investor",
  "version": "1.0.0",
  "extends": "gbrain-base",
  "borrow_from": [
    { "pack": "gbrain-base", "types": ["deal", "person", "company", "yc"] }
  ],
  "page_types": [
    {
      "name": "thesis",
      "primitive": "concept",
      "path_prefixes": ["investing/theses/", "theses/"],
      "aliases": [],
      "extractable": true,
      "expert_routing": false
    },
    {
      "name": "bet_resolution_log",
      "primitive": "temporal",
      "path_prefixes": ["investing/bets/", "bets/"],
      "aliases": [],
      "extractable": false,
      "expert_routing": false
    }
  ],
  "link_types": [],
  "takes_kinds": ["fact", "take", "bet", "hunch"]
}
```

`filing_rules` is an array of `{ kind, directory, examples[], description }` (MEASURED; e.g.
`{ "kind": "deal", "directory": "investing/deals/", ... }`).

---

## S5 — validate vs lint

**`schema lint <name>` on a pack that exists but fails to parse answers the misleading
`Pack not found: <name>`.** `runLintCmd` swallows the loader exception (`catch { raw = null; }`) and
then reports the pack as missing. MEASURED with a user pack at
`~/.gbrain/schema-packs/zz-broken-probe/pack.yaml` containing invalid content:

```
$ gbrain schema lint zz-broken-probe
Pack not found: zz-broken-probe
# exit 1

$ gbrain schema validate zz-broken-probe
✗ Invalid manifest at /srv/gbrain-home/.gbrain/schema-packs/zz-broken-probe/pack.yaml
  Code: INVALID_API_VERSION
  unsupported api_version: undefined; expected gbrain-schema-pack-v1
# exit 1
```

An admin needs the **second** message, so the console runs both (`validationError` in
`src/control/routes/schema.ts:52`). Cited by `src/contracts/registry.ts:453-471` and
`src/control/routes/schema.ts:47-50`.

**Grammar quirks.**

- `schema lint` grammar: `gbrain schema lint [PACK_NAME] [--with-db] [--json]`. `runLintCmd`'s
  `parseFlags()` recognizes only `--json`/`--source`/`--source-id`; every other token (including
  `--with-db`, `--pack`, `--help`) falls through into its `positional` array, and `name = positional[0]`.
  MEASURED: `gbrain schema lint --json <pack>` and `gbrain schema lint <pack> --json` both work
  (the positional is optional and falls back to the active pack), but
  `gbrain schema lint --with-db --json` exits 1 with `Pack not found: --with-db`.
- `schema validate` grammar: `gbrain schema validate [PACK_NAME]`. `runValidate` reads `args[0]` raw
  and **never calls `parseFlags`**:
  - A **LEADING** `--json` is misparsed as the pack name: MEASURED
    `gbrain schema validate --json gbrain-investor` → `Unknown pack: --json`, exit 1.
  - A **TRAILING** `--json` is silently ignored and prose is printed anyway: MEASURED
    `gbrain schema validate gbrain-investor --json` → the same `✓ ... valid manifest` prose, exit 0.
  - `schema validate --help` → `Unknown pack: --help`, exit 1.
- Because of the above, `schema.validate` has `supportsJson: false` (both flag orders are useless).
  The pack name is a POSITIONAL and optional; **absent falls back to `gbrain-base`**, NOT to the
  active pack (`runValidate` hardcodes `packPathByName('gbrain-base')`).
- `schema show` **does** skip flags when finding the positional (`args.find(a => !a.startsWith('--'))`),
  so `gbrain schema show --json <pack>` and `gbrain schema show <pack> --json` both work (MEASURED).

---

## S6 — Task 0 probe log (per-source packs)

All commands run **2026-09-21** against `brainstand-gbrain-ops-1` (`gbrain 0.50.5.0`) and
`brainstand-postgres-1`. Format: command → exit code → observed output. The brain was returned to
its exact baseline afterward (see “Cleanup” at the end of this section).

Baseline before probing (MEASURED):

```
$ docker exec brainstand-gbrain-ops-1 gbrain config get schema_pack.source.customers
Config key not found: schema_pack.source.customers
# exit 1

$ docker exec brainstand-gbrain-ops-1 gbrain schema active
Active pack: gbrain-base-v2 v1.2.0
Source: home-config
Pack identity: gbrain-base-v2@1.2.0+1a2aee67
Page types: 19
Link verbs: 17
Takes kinds: fact, take, bet, hunch
# exit 0

$ docker exec brainstand-postgres-1 psql -U gbrain -d gbrain -c "select key, value from config order by key"
 chunk_strategy | embedding_dimensions | embedding_model | memory.auto_writeback_notice_shown |
 minions.ttl_notice_shown | search.mode | search.reranker.enabled | sync.last_run | version
# 9 rows; no schema_pack* key
```

### Probe 1 — does `config set schema_pack.source.customers` work, and where does it land?

```
$ docker exec brainstand-gbrain-ops-1 gbrain config set schema_pack.source.customers gbrain-investor
[config] Unknown config key "schema_pack.source.customers".
[config] No similar known key. Run `gbrain config show` to see currently-set keys.
[config] If this is intentional (downstream tooling, forward-compat), re-run with --force.
# exit 1
```

Rejected without `--force`. Re-run with `--force`:

```
$ docker exec brainstand-gbrain-ops-1 gbrain config set schema_pack.source.customers gbrain-investor --force
[config] WARN: writing unknown key "schema_pack.source.customers" with --force. Nothing in gbrain reads this.
Set schema_pack.source.customers = gbrain-investor
# exit 0
```

Where it landed:

```
$ docker exec brainstand-postgres-1 psql -U gbrain -d gbrain -c "select key, value from config where key like 'schema_pack%'"
             key              |      value
------------------------------+-----------------
 schema_pack.source.customers | gbrain-investor
(1 row)
# exit 0

$ docker exec brainstand-gbrain-ops-1 sh -c 'cat /srv/gbrain-home/.gbrain/config.json'
{ ... "schema_pack": "gbrain-base-v2" ... }   # unchanged — the new key is NOT here
```

**Tier-3 key = the DB `config` table, NOT the file plane.** The `--force` requirement is a real
precondition (S1).

### Probe 2 — GATE: does `schema active --source customers` report the per-source pack?

With the key set:

```
$ docker exec brainstand-gbrain-ops-1 gbrain schema active --source customers
Active pack: gbrain-base-v2 v1.2.0
Source: home-config
Pack identity: gbrain-base-v2@1.2.0+1a2aee67
Page types: 19
Link verbs: 17
Takes kinds: fact, take, bet, hunch
# exit 0
```

**GATE 2 FAILS.** It reports the brain-wide pack (`home-config`), **not** `gbrain-investor`, and
**never** `Source: per-source-db`. Cross-checks (all MEASURED):

```
$ gbrain schema active --source internal       # same output, home-config
$ gbrain schema active --source customers --json
Active pack: gbrain-base-v2 v1.2.0
Source: home-config                            # --json ignored, prose only
$ gbrain config get schema_pack.source.customers
gbrain-investor
[config] source: db plane                      # the key IS there; active just ignores it
```

Root cause (MEASURED in the installed source): `async function runActive(_args: string[])` —
`_args` is never read; it calls `resolveActivePackNameOnly({ cfg, remote: false, dbConfig })` with
**no `sourceId` and no `perSourceDb`**. The tier-3 branch in `resolveActivePackName` therefore never
sees a source. `schema active` cannot truthfully read back a per-source pack at this pin.
`schema stats --source <id>` also reports a single brain-wide `pack_identity` (MEASURED) and is not
a per-source readback either.

> **Gate 2 verdict: NO.** `schema active --source <id>` does NOT read back a per-source pack and
> never emits `Source: per-source-db`. The tier-3 key is stored and readable by `config get`, but
> gbrain's CLI offers **no per-source resolution readback at 0.50.5.0**. Per the plan's branch, the
> Sources page must show the *stored intent* and state plainly that there is no per-source readback
> at this pin — never a resolved-looking green state that was not read back.

### Probe 3 — does tier 3 leak into brain-wide resolution?

With the tier-3 key still set:

```
$ docker exec brainstand-gbrain-ops-1 gbrain schema active
Active pack: gbrain-base-v2 v1.2.0
Source: home-config
Pack identity: gbrain-base-v2@1.2.0+1a2aee67
Page types: 19
Link verbs: 17
# exit 0
```

Unchanged from baseline. **Confirmed: tier 3 does not leak into brain-wide resolution** (the
per-source branch is gated on `input.sourceId`, which the brain-wide call never supplies).

### Probe 4 — GATE: does `schema sync --source <id>` fence?

Seeded 2 untyped pages in two different sources (DB-level, matching a real declared prefix
`people/`, then deleted afterward):

```sql
INSERT INTO pages (source_id, slug, type, title, source_path) VALUES
  ('customers','zz-probe-people-a','','ZZ probe A','people/zz-probe-a.md'),
  ('internal', 'zz-probe-people-b','','ZZ probe B','people/zz-probe-b.md');
```

Fenced run:

```
$ docker exec brainstand-gbrain-ops-1 gbrain schema sync --source customers --json
{ "schema_version": 1, "apply": false, "pack_identity": "gbrain-base-v2@1.2.0+1a2aee67",
  "per_prefix": [ { "type": "person", "prefix": "people/", "would_apply": 1,
                    "sample_slugs": ["zz-probe-people-a"], "dead_prefix": false, "applied": 0 }, ... ],
  "total_would_apply": 1, "total_applied": 0 }
# exit 0
```

Brain-wide run:

```
$ docker exec brainstand-gbrain-ops-1 gbrain schema sync --json
{ ... "per_prefix": [ { "type": "person", "prefix": "people/", "would_apply": 2,
                        "sample_slugs": ["zz-probe-people-a","zz-probe-people-b"], ... }, ... ],
  "total_would_apply": 2, "total_applied": 0 }
# exit 0
```

**Differential observed: fenced = 1 (`customers` only); brain-wide = 2 (`customers` + `internal`).**
The `--source` filter is real. Root cause (MEASURED in `src/core/schema-pack/sync.ts`): both
`probePrefix` and `applyTypeAssignment` append `AND source_id = $N` when `sourceId` is set, so the
fence applies to the count, the sample, **and the UPDATE**.

> **Gate 4 verdict: YES (PROVEN).** `schema sync --source <id>` provably fences by `source_id`,
> count/sample/apply alike. The plan's original note that "the fence is unproven on the near-empty
> brain" is **superseded**: seeding one untyped page per source produced a clean 1-vs-2 differential.
> The per-source backfill button **may** ship, provided Task 4/5 add a `--source` param to the
> `schema.sync` registry entry (it has none today) and keep gbrain's `(type IS NULL OR type = '')`
> additive-only semantics (S3).

### Probe 5 — `config unset`, then fallback

```
$ docker exec brainstand-gbrain-ops-1 gbrain config unset schema_pack.source.customers
Unset schema_pack.source.customers
# exit 0

$ docker exec brainstand-postgres-1 psql -U gbrain -d gbrain -c "select key, value from config where key like 'schema_pack%'"
 key | value
-----+-------
(0 rows)
# exit 0

$ docker exec brainstand-gbrain-ops-1 gbrain config get schema_pack.source.customers
Config key not found: schema_pack.source.customers
# exit 1

$ docker exec brainstand-gbrain-ops-1 gbrain schema active --source customers
Active pack: gbrain-base-v2 v1.2.0
Source: home-config
# exit 0
```

Cleared from the DB plane; re-resolution falls back to the brain-wide pack (`home-config`), not
`per-source-db`. `gbrain config unset` grammar: `gbrain config unset <key> | --pattern <prefix>`;
no-arg exits 1 with that usage line (MEASURED).

### Probe 6 — `sources remove` grammar and cleanup

`gbrain sources remove --help` and every sibling subcommand's `--help` print the **top-level**
`sources` help (there is no per-subcommand help screen). The authoritative grammar comes from the
top-level help and from a no-arg invocation:

```
$ docker exec brainstand-gbrain-ops-1 gbrain sources remove
Usage: gbrain sources remove <id> [--yes] [--confirm-destructive] [--dry-run] [--keep-storage]
# exit 2
```

Top-level help (MEASURED, verbatim key lines):

```
  remove <id> [--confirm-destructive] [--dry-run]
      Permanently delete a source and all its data. Shows impact preview.
      Requires --confirm-destructive when the source has data (pages/chunks/embeddings).
  archive <id>            Soft-delete: hide from search, preserve data for 72h.
  rename <id> <new-name>  Rename display name (id is immutable).
  list [--json]           List registered sources with page counts.
```

Throwaway source seeded per the `test/helpers/stack.ts` `seedGitSource` pattern (git repo with a
committed README), then registered:

```
$ gbrain sources add zz-probe-throwaway --path /srv/brain-repos/zz-probe-throwaway --name "ZZ Probe"
Created source "zz-probe-throwaway" (name: ZZ Probe) → /srv/brain-repos/zz-probe-throwaway
  federated: false — only searched when explicitly named via --source
# exit 0
```

`remove --dry-run` (0-page source, then with 1 page):

```
$ gbrain sources remove zz-probe-throwaway --dry-run
╔══ DESTRUCTIVE OPERATION — Impact Preview ══╗
║  Source ID:  zz-probe-throwaway            ║
║  Pages: 0  Chunks: 0  Embeddings: 0  Files: 0  Facts: 0
║  Source "zz-probe-throwaway" has no data (safe to remove).
╚════════════════════════════════════════════╝
(dry-run; no side effects)
# exit 0
```

`--json` is **accepted but ignored** — `remove ... --dry-run --json` prints the same box-drawing
prose (MEASURED). `sources.remove` should therefore be `supportsJson: false`.

Real remove without confirmation (source had 1 page):

```
$ gbrain sources remove zz-probe-throwaway
# (prints the impact preview) then:
⚠️  This will permanently delete: 1 pages
To proceed, pass --confirm-destructive (or use soft-delete: gbrain sources archive zz-probe-throwaway).
To preview without side effects: --dry-run
# exit 5
```

So `--confirm-destructive` is **required when the source has data**, and the refusal exit code is
**5** (not 1). A missing source exits **4** (`Source "zz-does-not-exist" not found.`, MEASURED).

`archive` / `rename` (MEASURED):

```
$ gbrain sources archive zz-probe-throwaway
Source "zz-probe-throwaway" archived (soft-deleted).
  1 pages preserved for 72h.
  Expires: 2026-09-24T18:54:37.492Z (~72h from now)
  Removed from search. Data intact.
# exit 0

$ gbrain sources rename zz-probe-throwaway "ZZ Probe Renamed"
Renamed source "zz-probe-throwaway" display: ZZ Probe → ZZ Probe Renamed (id is immutable).
# exit 0
```

`sources list --json` shape (MEASURED — needed by Task 5):

```json
{
  "sources": [
    { "id": "customers", "name": "Customers",
      "local_path": "/srv/brain-repos/customers",
      "federated": true, "page_count": 1,
      "last_sync_at": "2026-09-17T06:12:52.152Z" }
  ]
}
```

Fields per entry: `id`, `name`, `local_path` (string or `null`), `federated` (bool), `page_count`
(int), `last_sync_at` (ISO string or `null`). Top-level wrapper key is `sources`; there is **no**
`schema_version` wrapper on `sources list --json` (unlike `sources status --json`, which the help
says emits `{schema_version:1, ...}`).

### Cleanup — brain returned to baseline

MEASURED after all probes:

```
$ docker exec brainstand-postgres-1 psql ... -c "select count(*) from config where key like 'schema_pack%'"
0
$ docker exec brainstand-postgres-1 psql ... -c "select key, value from config order by key"
# the same 9 rows as baseline
$ docker exec brainstand-postgres-1 psql ... -c "select id from sources order by id"
 customers | default | internal | shared     # 4 rows, baseline
$ docker exec brainstand-postgres-1 psql ... -c "select source_id, count(*) from pages group by source_id"
 customers | 1 ; internal | 1 ; shared | 2   # baseline
$ docker exec brainstand-gbrain-ops-1 ls /srv/brain-repos
 customers | internal | shared                # no throwaway dir
$ docker exec brainstand-gbrain-ops-1 ls -la /srv/gbrain-home/.gbrain/schema-packs
 # empty (broken probe pack removed)
```

No `schema_pack.source.*` keys, no throwaway sources or pages, no probe repo, no user packs. The
throwaway source was removed with `--confirm-destructive` (cascading its page), and its repo dir
deleted.

---

## Findings that change the plan

- **Gate 2 (per-source readback) FAILS.** The Sources page (Task 8) cannot show a resolved pack
  with tier `per-source-db` at this pin — `schema active --source` ignores its argument. Render the
  *stored intent* (`config get schema_pack.source.<id>` → db plane) and say plainly there is no
  per-source readback, mirroring the honesty rule that already makes `/schema/apply` answer 409.
  Task 4's "resolve via `schema.active --source` reparsed with `parseSchemaActiveProse`" branch is
  **not viable**; use the `config.get` fallback branch instead.
- **Gate 4 (sync fence) PASSES.** The per-source backfill button may ship. Task 4/5 must add a
  `--source` param to the `schema.sync` registry entry (absent today), and the UI copy must respect
  additive-only semantics (S3): "fills blank types", never "reclassifies".
- **`config.set` needs `--force` for the tier-3 key.** The existing `config.set` registry entry has
  no `--force` flag and the key is not in gbrain's `KNOWN_CONFIG_KEY_PREFIXES` — the write exits 1
  without it. Task 4 cannot reuse `config.set` unchanged.
- **Never render the raw manifest.** `/api/schema/packs` (Task 3) must use the `packOverride`
  env-var seam (Task 1), not a positional `schema show <pack>` — `gbrain-creator` would otherwise
  show 1 page type instead of 27.
- **`config get schema_pack` is not a readback** (inverted shadowing note, S2) — read the tier with
  `schema active`, and the per-source *intent* with `config get schema_pack.source.<id>`.
