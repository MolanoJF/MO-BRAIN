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

## S7 — Task 0 probe log (custom-pack authoring)

Task 0 of the *Custom Schema Packs* plan (`docs/superpowers/plans/2026-09-22-custom-schema-packs.md`).
All commands run **2026-09-22** against `brainstand-gbrain-ops-1` (`gbrain 0.50.5.0`) and
`brainstand-postgres-1`. Format: command → exit code → observed output. The brain was returned to
its exact baseline afterward (see “Cleanup” at the end of this section).

> **Shell note (MEASURED).** The shell here is Windows PowerShell, which strips embedded `"` inside
> single-quoted arguments before `docker exec` sees them, so the plan's literal
> `gbrain call schema_apply_mutations '{"pack":...}'` reaches gbrain as invalid JSON
> (`JSON Parse error: Expected '}'`, exit 1). Every `call` payload below was therefore written with
> backslash-escaped quotes (`'{\"pack\":...}'`), which reaches the container verbatim. This is a
> harness/quoting artifact of the probe environment, **not** gbrain behaviour — on a POSIX shell the
> plan's command is correct. It does not change any measurement.

Baseline before probing (MEASURED — note this is the S6-cleanup baseline **plus** a pre-existing
`slice3-probe` source/page added by a later slice's probe, and a small `shared` repo page set):

```
$ docker exec brainstand-gbrain-ops-1 gbrain schema active
Active pack: gbrain-base-v2 v1.2.0
Source: home-config
Pack identity: gbrain-base-v2@1.2.0+1a2aee67
Page types: 19
Link verbs: 17
Takes kinds: fact, take, bet, hunch
# exit 0

$ docker exec brainstand-gbrain-ops-1 ls -la /srv/gbrain-home/.gbrain/schema-packs
# empty (total 8, only . and ..)

$ docker exec brainstand-postgres-1 psql -U gbrain -d gbrain -c "select count(*) from config where key like 'schema_pack%'"
0
$ docker exec brainstand-postgres-1 psql -U gbrain -d gbrain -c "select id from sources order by id"
 customers | default | internal | shared | slice3-probe   # 5 rows
$ docker exec brainstand-postgres-1 psql -U gbrain -d gbrain -c "select source_id, count(*) from pages group by source_id"
 customers|1 ; internal|1 ; shared|2 ; slice3-probe|1     # 5 pages
```

### Probe 1 — `gbrain call schema_apply_mutations` at the pin

Fork first:

```
$ docker exec brainstand-gbrain-ops-1 gbrain schema fork gbrain-base-v2 zz-probe --json
{
  "schema_version": 1,
  "from": "gbrain-base-v2",
  "to": "zz-probe",
  "path": "/srv/gbrain-home/.gbrain/schema-packs/zz-probe",
  "tier": "experimental"
}
# exit 0

$ docker exec brainstand-gbrain-ops-1 ls -la /srv/gbrain-home/.gbrain/schema-packs/zz-probe
-rw-r--r-- 1 root root 17236 ... pack.json      # fork writes pack.json (not yaml)
# exit 0
```

Success batch (2 mutations, one `add_type` + one `add_link_type`):

```
$ docker exec brainstand-gbrain-ops-1 gbrain call schema_apply_mutations '{"pack":"zz-probe","mutations":[{"op":"add_type","name":"contract","primitive":"entity","prefix":"contracts/","extractable":true},{"op":"add_link_type","name":"signed","inference":{"page_type":"person","target_type":"contract"}}]}'
{
  "schema_version": 1,
  "pack": "zz-probe",
  "batch_id": "batch-1790098162715-53fq97",
  "mutations_applied": 2,
  "results": [
    {
      "index": 0,
      "op": "add_type",
      "pack": "zz-probe",
      "path": "/srv/gbrain-home/.gbrain/schema-packs/zz-probe/pack.json",
      "format": "json",
      "prev_sha8": "fe8432b6",
      "new_sha8": "869b6c98"
    },
    {
      "index": 1,
      "op": "add_link_type",
      "pack": "zz-probe",
      "path": "/srv/gbrain-home/.gbrain/schema-packs/zz-probe/pack.json",
      "format": "json",
      "prev_sha8": "869b6c98",
      "new_sha8": "8dc3521f"
    }
  ]
}
# exit 0
```

Failure batch (valid `add_type` at index 0, invalid `remove_type` at index 1):

```
$ docker exec brainstand-gbrain-ops-1 gbrain call schema_apply_mutations '{"pack":"zz-probe","mutations":[{"op":"add_type","name":"x","primitive":"entity","prefix":"x/"},{"op":"remove_type","name":"does-not-exist"}]}'
{
  "error": "mutation_failed",
  "code": "TYPE_NOT_FOUND",
  "message": "type 'does-not-exist' is not declared in pack 'zz-probe'",
  "batch_id": "batch-1790098168446-im6vow",
  "mutations_applied": 0,
  "pack_unchanged": true,
  "failed_at_index": 1
}
# exit 0        <<< THE EXIT CODE IS 0 ON A FAILED BATCH
```

**`call` exits 0 even when the handler fails.** The failure is reported *in the body*, never in the
exit code. Callers MUST parse the JSON and inspect `error` / `code` / `pack_unchanged`.

Readonly refusal (`gbrain-base-v2` is bundled):

```
$ docker exec brainstand-gbrain-ops-1 gbrain call schema_apply_mutations '{"pack":"gbrain-base-v2","mutations":[{"op":"add_type","name":"y","primitive":"entity","prefix":"y/"}]}'
{
  "error": "mutation_failed",
  "code": "PACK_READONLY",
  "message": "pack 'gbrain-base-v2' is bundled and read-only. Use 'gbrain schema fork gbrain-base-v2 <new-name>' to create a writable copy.",
  "batch_id": "batch-1790098175061-zia00l",
  "mutations_applied": 0,
  "pack_unchanged": true
}
# exit 0
```

Note the `PACK_READONLY` shape: **no `failed_at_index`** (the refusal is pre-batch, so index 0 is
never reached), same `error`/`pack_unchanged` envelope. This is the same signal the plan expects the
API to return for a bundled pack.

Atomicity readback (the failed batch's `add_type x` must be absent, the success's `contract` present):

```
$ docker exec brainstand-gbrain-ops-1 gbrain schema show zz-probe --json
page_type_count=20   names=person,company,media,tweet,social-digest,analysis,atom,concept,source,deal,email,slack,meeting,conversation,writing,project,note,event,diary,contract
has_x=False          has_contract=True
link_names=...,attributed_to,signed
# exit 0
```

**PROVEN: the batch is atomic.** 20 types = the fork's 19 raw types + the success batch's
`contract`; the failure batch's `x` never landed. `call` also runs the op without an admin MCP grant
(the trusted local lane), which is exactly what `schema.mutate` needs.

> **Gate 1 verdict: YES.** `gbrain call schema_apply_mutations` is usable at the pin. Task 1's
> `schema.mutate` entry is viable in its single-entry form; the plan's fallback (one registry entry
> per CLI verb) is **not** needed. The registry entry must still inspect the body, because exit is
> always 0 (this is already written into the Task 1/Task 5 code comments and the route's `!r.ok ||
> !out || out.error` check).

### Probe 2 — raw `schema show <pack> --json` and the `fork --json` shape

`schema show zz-probe --json` (positional, raw) on the fork lists **only the pack's own
declarations** — for a fork that happens to equal the effective set (a fork copies everything raw,
`extends: null`). MEASURED: 20 raw page types, 18 raw link types, name `zz-probe`, `extends: null`.

For a pack that *does* extend, raw lists only its own types (S4 table, unchanged): `gbrain-investor`
positional = 2 page types.

`fork --json` shape (MEASURED, above):
`{ schema_version, from, to, path, tier }` — `tier` is `"experimental"`. The exit code is 0; the
written file is `<path>/pack.json`. There is **no** content echo in the fork response (the manifest
must be read back with `schema show`).

### Probe 3 — no-`extends` vs `extends: gbrain-base-v2`

3a — `zz-noext/pack.json` with one `page_types` entry and **no `extends` key**:

```
$ docker exec brainstand-gbrain-ops-1 gbrain schema validate zz-noext
✓ zz-noext v0.0.1: valid manifest
  Path: /srv/gbrain-home/.gbrain/schema-packs/zz-noext/pack.json
  Page types: 1
  Link verbs: 0
  Takes kinds: 4
# exit 0

$ docker exec brainstand-gbrain-ops-1 gbrain schema lint zz-noext --json
{ "schema_version": 1, "pack": "zz-noext", "ok": true, "errors": [], "warnings": [] }
# exit 0

$ docker exec brainstand-gbrain-ops-1 env GBRAIN_SCHEMA_PACK=zz-noext gbrain schema show --json
name=zz-noext  version=0.0.1  extends=gbrain-base
page_type_count=28
names=widget,writing,analysis,guide,hardware,architecture,concept,person,company,deal,yc,civic,project,source,media,email,slack,calendar-event,note,meeting,conversation,atom,event,diary,code,image,synthesis,extract_receipt
link_type_count=12
# exit 0
```

**FALSIFIED (the plan's expectation).** The plan expected an omitted `extends` to be a *standalone*
ontology (effective count 1). It is not. `manifest-v1.ts:332` declares
`extends: z.string().nullable().default('gbrain-base')`, so **omitting `extends` resolves to
`gbrain-base`**, not to a standalone pack. `gbrain-base` leaks in: **28 effective page types**
(27 gbrain-base + `widget`) and 12 link types. (Note `schema validate`'s own "Page types: 1" line is
the *raw* count; the resolved count is 28.)

3b — same pack, but explicit `"extends": "gbrain-base-v2"`:

```
$ docker exec brainstand-gbrain-ops-1 gbrain schema validate zz-noext
✓ zz-noext v0.0.1: valid manifest   (Path .../zz-noext/pack.json)   Page types: 1
# exit 0

$ docker exec brainstand-gbrain-ops-1 gbrain schema lint zz-noext --json
{ "schema_version": 1, "pack": "zz-noext", "ok": true, "errors": [],
  "warnings": [ 56 × { "rule": "alias_references_undeclared_type", ... } ] }
# exit 0   (ok:true; the warnings are gbrain-base-v2's own aliases, inherited)

$ docker exec brainstand-gbrain-ops-1 env GBRAIN_SCHEMA_PACK=zz-noext gbrain schema show --json
name=zz-noext  version=0.0.1  extends=gbrain-base-v2
page_type_count=20
names=widget,person,company,media,tweet,social-digest,analysis,atom,concept,source,deal,email,slack,meeting,conversation,writing,project,note,event,diary
link_type_count=17
# exit 0
```

So an explicit `extends` works as expected (19 v2 types + `widget` = 20).

> **Verdict: a pack with no `extends` is NOT standalone.** `validate`/`lint` accept it (legal), but
> it silently *inherits `gbrain-base`*. A truly standalone ontology requires `"extends": null`
> **explicitly** (that is what `schema fork` writes — Probe 1's fork has `"extends": null`). This is a
> **plan defect** in Task 2's `draftToManifest`: it already does the right thing (it omits the key
> only when `d.extends` is falsy, and `validateDraft` maps `null`/`''`/absent to `null`), so a draft
> with `extends: null` will emit an explicit `"extends": null` and be standalone. But the plan's
> **task-0 sentence** (“Write ... with one page_types entry and no `extends` ... We expect 1”)
> is based on a wrong premise, and the Task 2 test `'omits extends entirely for a standalone
> ontology'` should be read as “emits `extends: null`”, not “omits the key”. Keep the writer at
> `"extends": null` for standalone, and never emit a manifest with the key simply missing unless the
> intent is `gbrain-base`.

### Probe 4 — loader precedence with both `pack.yaml` and `pack.json`

`pack.yaml` (`version: 9.9.9`, type `yamltype`, `extends: gbrain-base-v2`) and `pack.json`
(`version: 1.1.1`, type `jsontype`, `extends: null`) both present in `zz-noext/`:

```
$ docker exec brainstand-gbrain-ops-1 ls -la /srv/gbrain-home/.gbrain/schema-packs/zz-noext
-rwxr-xr-x 1 root root 365 ... pack.json
-rwxr-xr-x 1 root root 282 ... pack.yaml
# exit 0

$ docker exec brainstand-gbrain-ops-1 gbrain schema show zz-noext --json
{ "name": "zz-noext", "version": "9.9.9", "extends": "gbrain-base-v2",
  "page_types": [ { "name": "yamltype", ... } ] }
# exit 0
```

**`pack.yaml` wins.** The candidate order is `['pack.yaml', 'pack.yml', 'pack.json']`
(`load-active.ts:116`, `commands/schema.ts:410`, `core/ops/schema-packs.ts:79`), first existing file
taken. This confirms the writer must delete the sibling format after writing `pack.json` (Task 3),
and the reason is now measured, not assumed.

### Probe 5 — `README.md` is skipped by sync

Committed `people/README.md` into the `shared` Space repo on a fresh commit, then synced:

```
$ docker exec brainstand-gbrain-ops-1 git -C /srv/brain-repos/shared commit -m zz-probe-people-readme
[master 54e069b] zz-probe-people-readme    1 file changed, 3 insertions(+)
# exit 0

$ docker exec brainstand-gbrain-ops-1 gbrain sync --source shared
[sync.imports] 1/1 (100%) reports/live-sync/2026-09-17-0213.md
Synced 4c632c12..54e069bf:
  +1 added, ~0 modified, -0 soft-deleted (recoverable 72h), R0 renamed
# exit 0

$ docker exec brainstand-postgres-1 psql -U gbrain -d gbrain -t -c "select slug, source_path from pages where source_id='shared' order by slug"
 gate-b-seed-mu54vuc2              | gate-b-seed-mu54vuc2.md
 reports/live-sync/2026-09-17-0213 | reports/live-sync/2026-09-17-0213.md
 widget-launch                     | widget-launch.md
# exit 0
```

**`people/README.md` is skipped.** No `people/readme` or `people` page appeared (only the unrelated
`reports/...` page was added by the same sync). `README.md` really is in `SYNC_SKIP_FILES` at the
pin, so folder scaffolding never becomes a page.

### Probe 6 — file mtime and shared-volume visibility

After the Probe 1 success batch, `zz-probe/pack.json`'s mtime advanced to `2026-09-22 17:29:22`
(18:28 fork → 17:29 mutation), and the same inode/mtime is visible from every service that mounts
the `gbrain-home` volume:

```
$ docker exec brainstand-gbrain-ops-1  stat -c '%n mtime=%y size=%s' .../zz-probe/pack.json
.../zz-probe/pack.json mtime=2026-09-22 17:29:22.737097531 +0000 size=17569
$ docker exec brainstand-gbrain-serve-1 stat -c '%n mtime=%y size=%s' .../zz-probe/pack.json
.../zz-probe/pack.json mtime=2026-09-22 17:29:22.737097531 +0000 size=17569
$ docker exec brainstand-gbrain-worker-1 stat -c '%n mtime=%y size=%s' .../zz-probe/pack.json
.../zz-probe/pack.json mtime=2026-09-22 17:29:22.737097531 +0000 size=17569
# all exit 0
```

The file plane is genuinely shared across ops/serve/worker. (Whether *serve* re-reads it depends on
its stat-mtime TTL in `loadActivePack`, and only when a pack is active — this probe records
visibility, not hot-reload.)

### Probe 7 — validate / lint / show before `init` (the wizard case) — **decides Task 9**

Scratch `GBRAIN_HOME=/tmp/zz` containing **only** `.gbrain/schema-packs/zz-noext/pack.json` — no
`config.json`, no `database_url`, no DB:

```
$ docker exec brainstand-gbrain-ops-1 ls -la /tmp/zz/.gbrain
drwxr-xr-x ... schema-packs          # and nothing else; config.json absent

$ docker exec -e GBRAIN_HOME=/tmp/zz -e GBRAIN_SCHEMA_PACK=zz-noext brainstand-gbrain-ops-1 gbrain schema validate zz-noext
✓ zz-noext v0.0.1: valid manifest
  Path: /tmp/zz/.gbrain/schema-packs/zz-noext/pack.json
  Page types: 1   Link verbs: 0   Takes kinds: 4
# exit 0

$ docker exec -e GBRAIN_HOME=/tmp/zz -e GBRAIN_SCHEMA_PACK=zz-noext brainstand-gbrain-ops-1 gbrain schema lint zz-noext --json
{ "schema_version": 1, "pack": "zz-noext", "ok": true, "errors": [], "warnings": [] }
# exit 0

$ docker exec -e GBRAIN_HOME=/tmp/zz -e GBRAIN_SCHEMA_PACK=zz-noext brainstand-gbrain-ops-1 gbrain schema show --json
{ "name": "zz-noext", "extends": "gbrain-base", "page_types": [ ... 28 types ... ] }
# exit 0
```

All three **work with no DB**. `schema validate` is pure file-plane (reads the named pack path);
`schema lint --json` composes the 9 file-plane rules; `schema show --json` resolves `extends`
against bundled YAML only. Confirmed by reading the installed source (`core/ops/schema-packs.ts:105`
`schema_lint` has `scope: 'read'` and its own comment says “File-plane rules only over MCP — the
with_db option is rejected for remote callers”; `commands/schema.ts` `runValidate` never opens a DB).
Note `schema show --json` here has no positional, so `GBRAIN_SCHEMA_PACK` selects the pack — the
positional form (`schema show <pack>`, which Task 1's `schema.showRaw` uses) intersects wholly with
the same file-plane branch and is **also DB-free** (MEASURED: `schema show zz-noext --json` under
`GBRAIN_HOME=/tmp/zz` returned exit 0). The `schema.mutate` lane is the one that needs a DB (it
takes `ctx.engine` to write the audit row), but that is a *write*, not part of Task 9's pre-`init`
read path.

> **Task 9 branch: A.** `schema validate`, `schema lint --json` and `schema show --json` all answer
> with **no DB** on a scratch `GBRAIN_HOME`. The wizard's schema step can validate and preview a
> custom pack *before* `init` runs, so Task 9 implements **Branch A** (the “Design our own” option
> embedding `NewPackPanel`). Branch B (“they need a DB”, a one-line copy change only) is **not**
> selected. Task 1's `schema.showRaw` being `privilege: 'brain-db'` is over-conservative for the
> pre-init read path; if Task 9 is to call it before `init`, that entry should be `read-only`
> (a Task 1 refinement, not a blocker — `validate`/`lint`/`show` via the CLI need no DB).

### Cleanup — brain returned to baseline

MEASURED after all probes:

```
$ docker exec brainstand-gbrain-ops-1 rm -rf /srv/gbrain-home/.gbrain/schema-packs/zz-probe \
      /srv/gbrain-home/.gbrain/schema-packs/zz-noext /tmp/zz
# exit 0
$ docker exec brainstand-gbrain-ops-1 ls -la /srv/gbrain-home/.gbrain/schema-packs
# empty (total 8, only . and ..)          # .locks dir also removed
$ docker exec brainstand-gbrain-ops-1 gbrain schema list
...
No user-installed packs (~/.gbrain/schema-packs/ empty or missing).
# exit 0

$ docker exec brainstand-gbrain-ops-1 git -C /srv/brain-repos/shared status --short
# (empty)
$ docker exec brainstand-gbrain-ops-1 git -C /srv/brain-repos/shared log --oneline -3
20c2d6a Revert "zz-probe-people-readme"
54e069b zz-probe-people-readme
6325100 reports: live-sync 2026-09-17-0213
$ docker exec brainstand-gbrain-ops-1 ls -la /srv/brain-repos/shared
 README.md | gate-b-seed-mu54vuc2.md | reports/ | widget-launch.md   # people/ gone, baseline
# exit 0

$ docker exec brainstand-postgres-1 psql ... -c "select count(*) from config where key like 'schema_pack%'"
0
$ docker exec brainstand-postgres-1 psql ... -c "select key, value from config order by key"
# the same 9 rows as baseline (version = 149)
$ docker exec brainstand-postgres-1 psql ... -c "select source_id, count(*) from pages group by source_id"
 customers|1 ; internal|1 ; shared|2 ; slice3-probe|1     # baseline
$ docker exec brainstand-gbrain-ops-1 gbrain schema active
Active pack: gbrain-base-v2 v1.2.0   Source: home-config   Page types: 19   Link verbs: 17
# exit 0
```

No user packs, no `schema_pack.source.*` keys, no extra sources, no extra pages, no `people/`
directory, no scratch home. One `zz-probe-people-readme` commit plus its `Revert` remain in the
`shared` repo history (tree is baseline; the commit pair is harmless and revertable through the
product, matching Task 10's stated policy).

### Findings that change the plan (S7)

- **`call` exits 0 on a failed batch** (Probe 1) — already assumed by Task 1/Task 5; now MEASURED.
  No `okExitCodes` change is needed, but the body must be parsed (`error` present ⇒ failure).
- **`PACK_READONLY` carries no `failed_at_index`** — the API's 409 body must tolerate
  `failed_at_index: undefined` (Task 5 already reads `out?.failed_at_index ?? null`).
- **A no-`extends` pack is NOT standalone** (Probe 3). Plan defect: standalone requires
  `"extends": null` explicitly. Task 2's `draftToManifest` is safe (it keeps the key with a `null`
  value), but its test name (“omits extends entirely”) misdescribes the desired output; and any prose
  that says “omit `extends` for standalone” must say “set `extends: null`” instead.
- **`pack.yaml` beats `pack.json`** (Probe 4) — justifies Task 3's sibling deletion, now measured.
- **`README.md` skip + shared-volume visibility confirmed** (Probes 5, 6) — no change.
- **Task 9 = Branch A** (Probe 7). `validate`/`lint`/`show` are DB-free and work before `init`.
  Consider changing Task 1's `schema.showRaw` from `privilege: 'brain-db'` to `read-only` if the
  wizard must call it pre-`init`.

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

---

## S8 — mobrain-personal probes (2026-09-27, gbrain 0.50.5.0)

All commands run **2026-09-27** against `mobrain-local-gbrain-ops-1` (`gbrain 0.50.5.0`), inside
scratch `GBRAIN_HOME`s created with `mktemp -d` in the container (never `/srv/gbrain-home`, never the
live brain's Postgres). The manifest under test was copied in via `docker cp` to
`/tmp/mp.json` and installed at `$H/.gbrain/schema-packs/mobrain-personal/pack.json`. P8.1–P8.3b
used one scratch home (`/tmp/tmp.PKjSdTATnk`); P8.4 was independently re-run in a second, fresh
scratch home (`/tmp/tmp.QkEQc5zE5s`) to obtain and quote its verbatim output. Both scratch homes
were `rm -rf`'d at the end of their sessions (MEASURED: `REMOVED` both times).

- **P8.1 validate + lint** — **MEASURED**.

  ```
  $ GBRAIN_HOME=$H gbrain schema validate mobrain-personal
  ✓ mobrain-personal v1.0.0: valid manifest
    Path: $H/.gbrain/schema-packs/mobrain-personal/pack.json
    Page types: 20
    Link verbs: 21
    Takes kinds: 4
  # exit 0
  ```

  `gbrain schema lint mobrain-personal --json | grep -c '"severity": "error"'` → `0` (0 errors).
  Full lint JSON, `warnings` array quoted verbatim (re-run in a second, fresh scratch home to
  confirm reproducibility; `"ok": true`, `"errors": []`, exactly **8** entries, all rule
  `alias_references_undeclared_type`):

  ```json
  {
    "rule": "alias_references_undeclared_type", "severity": "warning",
    "message": "type 'event' aliases 'calendar-event' which is not a declared page_type in this pack",
    "pack": "mobrain-personal", "type": "event",
    "hint": "add a page_type for 'calendar-event' OR remove the alias"
  },
  {
    "rule": "alias_references_undeclared_type", "severity": "warning",
    "message": "type 'journal' aliases 'diary' which is not a declared page_type in this pack",
    "pack": "mobrain-personal", "type": "journal",
    "hint": "add a page_type for 'diary' OR remove the alias"
  },
  {
    "rule": "alias_references_undeclared_type", "severity": "warning",
    "message": "type 'source' aliases 'media' which is not a declared page_type in this pack",
    "pack": "mobrain-personal", "type": "source",
    "hint": "add a page_type for 'media' OR remove the alias"
  },
  {
    "rule": "alias_references_undeclared_type", "severity": "warning",
    "message": "type 'atom' aliases 'atom-extraction' which is not a declared page_type in this pack",
    "pack": "mobrain-personal", "type": "atom",
    "hint": "add a page_type for 'atom-extraction' OR remove the alias"
  },
  {
    "rule": "alias_references_undeclared_type", "severity": "warning",
    "message": "type 'atom' aliases 'atom-manual' which is not a declared page_type in this pack",
    "pack": "mobrain-personal", "type": "atom",
    "hint": "add a page_type for 'atom-manual' OR remove the alias"
  },
  {
    "rule": "alias_references_undeclared_type", "severity": "warning",
    "message": "type 'atom' aliases 'atom-lore' which is not a declared page_type in this pack",
    "pack": "mobrain-personal", "type": "atom",
    "hint": "add a page_type for 'atom-lore' OR remove the alias"
  },
  {
    "rule": "alias_references_undeclared_type", "severity": "warning",
    "message": "type 'atom' aliases 'content-atom' which is not a declared page_type in this pack",
    "pack": "mobrain-personal", "type": "atom",
    "hint": "add a page_type for 'content-atom' OR remove the alias"
  },
  {
    "rule": "alias_references_undeclared_type", "severity": "warning",
    "message": "type 'atom' aliases 'lore' which is not a declared page_type in this pack",
    "pack": "mobrain-personal", "type": "atom",
    "hint": "add a page_type for 'lore' OR remove the alias"
  }
  ```

  No error-severity warnings, matching the pre-check claimed in the brief.

- **P8.2 `gbrain init` with a user-installed pack** — **MEASURED**. `gbrain init --help` lists a
  DB-free engine: `--pglite` (embedded, zero-config, the default). Ran, in the same scratch
  `$H`, against the same installed `mobrain-personal` pack, never touching the live brain's
  Postgres (the container's `GBRAIN_DATABASE_URL`/`CONTROL_DATABASE_URL` env vars point at the live
  `postgres:5432` server and were never read by this init):

  ```
  $ GBRAIN_HOME=$H gbrain init --pglite --schema-pack mobrain-personal --non-interactive --no-embedding
  ... (skill/memory-writeback onboarding prose) ...
  # exit 0

  $ cat $H/.gbrain/config.json
  { "engine": "pglite", "database_path": "$H/.gbrain/brain.pglite",
    "embedding_disabled": true, "schema_pack": "mobrain-personal", ... }

  $ GBRAIN_HOME=$H gbrain schema active
  Active pack: mobrain-personal v1.0.0
  Source: home-config
  Pack identity: mobrain-personal@1.0.0+1cd16fde
  Page types: 20
  Link verbs: 21
  Takes kinds: fact, take, bet, hunch
  # exit 0
  ```

  `config.json`'s `"engine": "pglite"` with a local `database_path` under `$H` confirms the init used
  the embedded PGLite engine, not the live Postgres — this is the MEASURED fact.

  **Reasoning, not measurement:** `gbrain doctor --json`'s top-level `"engine":"postgres"` field
  (quoted verbatim under P8.4 below, alongside `"db_url_source":null`) looks like it names the live
  Postgres server, but it does not — PGLite's own wire-protocol/dialect is Postgres-compatible, so
  gbrain's generic `engine` label reads `"postgres"` even when the backing store is the embedded
  PGLite file at `$H/.gbrain/brain.pglite`, which is what `config.json` (quoted above) actually
  points at. `db_url_source: null` and the absence of any `database_url` key in `config.json` are
  the corroborating measured facts for this inference.

- **P8.3 layer resolution** — **MEASURED**. Child pack `my-personal` (`extends: "mobrain-personal"`,
  empty own `page_types`/`link_types`) installed at
  `$H/.gbrain/schema-packs/my-personal/pack.json`:

  ```
  $ GBRAIN_HOME=$H GBRAIN_SCHEMA_PACK=my-personal gbrain schema show --json | grep -c '"primitive"'
  20
  ```

  Effective type count of `my-personal` extends `mobrain-personal`: **20** (expected 20 — matches).

- **P8.3b removing an inherited type from the layer** — **MEASURED**. Exact `schema.mutate` argv
  from `src/contracts/registry.ts` (`'schema.mutate'`: `argv: ['call', 'schema_apply_mutations']`),
  run against the layer with the brief's payload:

  ```
  $ GBRAIN_HOME=$H gbrain call schema_apply_mutations \
      '{"pack":"my-personal","mutations":[{"op":"remove_type","name":"idea"}]}'
  {
    "error": "mutation_failed",
    "code": "TYPE_NOT_FOUND",
    "message": "type 'idea' is not declared in pack 'my-personal'",
    "batch_id": "batch-1790538860050-bbtcok",
    "mutations_applied": 0,
    "pack_unchanged": true,
    "failed_at_index": 0
  }
  # exit 0
  ```

  gbrain's JSON answer is `TYPE_NOT_FOUND`, not a permission/authorization error: `remove_type`
  operates only on the pack's own *raw* declarations, and `idea` isn't declared in `my-personal`
  raw (it's inherited from `mobrain-personal`), so the mutation is rejected before it can touch
  anything. **Consequence for the console: "refuse inherited edits" confirmed** — a layer's
  `schema.mutate` can never remove (or otherwise target) a type it only sees through `extends`; the
  console must not offer "remove/edit inherited type" as an action on a layer pack, and any UI that
  surfaces this error should say the type belongs to the parent pack, not "type not found."

- **P8.4 doctor under mobrain-personal** — **MEASURED: none.** Re-run in a **second, fresh scratch
  `GBRAIN_HOME`** (`/tmp/tmp.QkEQc5zE5s`, `mktemp -d` inside `mobrain-local-gbrain-ops-1`, distinct
  from P8.1–P8.3's home) after installing the same manifest and running the same
  `gbrain init --pglite --schema-pack mobrain-personal --non-interactive --no-embedding` (exit 0):

  ```
  $ GBRAIN_HOME=$H GBRAIN_SCHEMA_PACK=mobrain-personal gbrain doctor --json 2>&1 | head -60
  # exit 0   (30163-byte JSON body written to /tmp/doctor.out)
  ```

  Grepped the full JSON body verbatim for the specific claims below (exact commands and output):

  ```
  $ grep -o '{"name":"type_proliferation"[^}]*}' doctor.out
  {"name":"type_proliferation","status":"ok","message":"0 distinct typed values (pack declares 20)","category":"meta"}

  $ grep -o '.\{60\}media-ingest.\{60\}' doctor.out
  idea-lineage","ingest","maintain","measure-before-you-fix","media-ingest","meeting-ingestion","minion-orchestrator","perplexity-rese

  $ grep -o '.\{60\}bare-tweet.\{60\}' doctor.out
  e":"integrity","status":"ok","message":"Sampled 0 pages; no bare-tweet phrases or external links.","category":"brain"},{"name":"js

  $ grep -oE '\b(media|email|diary|deal|yc|tweet|slack|civic|social-digest)\b' doctor.out | sort | uniq -c
        1 media
        1 tweet

  $ grep -o '"engine":"[a-z]*","db_url_source":[a-z]*' doctor.out
  "engine":"postgres","db_url_source":null
  ```

  This confirms, byte-for-byte: `type_proliferation` really does say
  `"0 distinct typed values (pack declares 20)"`; the whole-word scan for every dropped/investor
  type name across the entire doctor payload turns up exactly two hits (`media`, `tweet`), and both
  are the named false positives — `media` only inside the built-in skill id `media-ingest` (a
  "not yet installed" skill suggestion, `skill_currency` check), and `tweet` only inside the
  hardcoded, pack-agnostic `integrity` check's message "no bare-tweet phrases or external links".
  Neither is a check naming a page type. No check named `email`, `diary`, `deal`, `yc`, `slack`,
  `civic`, or `social-digest` at all. **No check named a dropped type as unknown/orphaned.**

- **Shared frontmatter field** — `area` declared on five page types (`goal`, `project`, `event`,
  `health_record`, `finance_record`) validates (P8.1: exit 0, 0 errors).
