# Member skills — measured at gbrain 0.50.5.0

Source: `test/contract/member-skills.contract.test.ts`, run 2026-09-22, then
re-run 2026-09-22 after Task 0 provisioned the host skills catalog.

| Fact | Result |
|---|---|
| (a) `init` leaves `mcp.publish_skills` = `true` | pass |
| (b) starter `tools/list` count; skills hidden | 23; pass |
| (c) full `tools/list` count; `list_skills` bytes; `get_skill query` ok | 93; 4235; pass |
| (d) `sources_add` as memory-writer on full is denied | pass; shape: `{"error":"unknown_operation","message":"Unknown: sources_add","isError":true}` (outer `result.isError: true`) |
| Rescope params that worked | `{ id, surface }` only |

Consequence: member Connections compile to `full`. Callable scope is still
bounded by the grant profile (d). The cost is tool-list size (b → c).

## Gate verdict: PASS (assertion c)

All four assertions pass at the pin. `full` exposes `list_skills`/`get_skill`,
the member can list the Mobrain catalog (`query`) and fetch its body, and the
`memory-writer` profile is still denied an admin op. The earlier `storage_error`
was cured by provisioning a host skills catalog (Task 0), not by any change to
the test.

### Catalog provisioning (Task 0)

The catalog is **Mobrain-owned**, not gbrain's bundled dev catalog:

- Mount: `../skills:/opt/mobrain-skills:ro` (compose resolves `../skills`
  against `compose/`, i.e. repo-root `skills/`), on `gbrain-serve`
  (`compose/docker-compose.yml`) and `gbrain-ops`
  (`compose/docker-compose.slice0.yml`).
- Env: `GBRAIN_SKILLS_DIR=/opt/mobrain-skills` on the same two services.
- Contents: repo `skills/RESOLVER.md` + `skills/query/SKILL.md`, authored by
  Mobrain. gbrain deliberately never serves its own bundled catalog to remote
  MCP callers, so pointing `$GBRAIN_SKILLS_DIR` at it would be wrong.

`compose/docker-compose.dev.yml` only adds `ports:` to `gbrain-ops`; it does
not redefine either service's `volumes`/`environment`, so it needs no change.

The measured-cause analysis below is retained as history; it is now **resolved**
by the provisioning above.

### What passed

- (a) `gbrain init` writes `mcp.publish_skills = true`; `config.get` read it
  back as exactly `true`.
- (b) The profile-default `starter` surface lists **23** tools and contains
  neither `list_skills` nor `get_skill`.
- (d) On `full`, a `memory-writer` client calling `sources_add` is denied in
  band: `unknown_operation` (`result.isError: true`). The grant profile still
  bounds callable scope.

### What failed (c) — history, now resolved by Task 0

> Re-run after Task 0: `list_skills bytes=4235` and `get_skill query` succeeds;
> the `storage_error` below no longer reproduces. Retained as the measured
> record of why the catalog was needed.

The surface mechanism itself works: on `full`, `tools/list` returns **93**
tools including `list_skills` and `get_skill`. But the first catalog call
errors:

```
[member-skills] list_skills bytes=675
{"content":[{"type":"text","text":"{\n  \"error\": \"storage_error\",\n  \"message\": \"No skills directory found on the server host.\", ... }"}],"isError":true}
```

`get_skill` is never reached because the same `resolveSkillsDir` throws first.

Measured cause (gbrain `src/core/skill-catalog.ts`, `resolveSkillsDir`):
remote MCP callers use `autoDetectSkillsDir`, which deliberately has **no
install_path tier** ("a hosted gbrain must never serve its own bundled dev
skills"). The image does ship
`/root/.bun/install/global/node_modules/gbrain/skills`, but it is not in the
search order. A catalog resolves only from:

1. `--skills-dir`
2. `$GBRAIN_SKILLS_DIR`
3. `$OPENCLAW_WORKSPACE/{skills/,}{RESOLVER.md,AGENTS.md}`
4. cwd walk-up to any `skills/`
5. `~/.openclaw/workspace/{skills/,}{RESOLVER.md,AGENTS.md}`
6. repo root with `skills/RESOLVER.md` or `skills/AGENTS.md`
7. `./skills/RESOLVER.md` or `./skills/AGENTS.md`

None exist in the slice0 `gbrain-ops` container, and this repo configures no
`mcp.skills_dir`/`GBRAIN_SKILLS_DIR` anywhere (`rg` over the tree found none).
The running dev `gbrain-serve` container is in the same state:
`GBRAIN_SKILLS_DIR` empty, `mcp.skills_dir` unset ("Config key not found").

### Rescope params (measured)

The full re-statement the plan called `rescopeParams` was **rejected** by the
pin:

```
gbrain auth rescope-client <id> --source customers --federated-read  \
  --bound-slug-prefixes none --surface full --profile memory-writer --json
Error: Invalid client grant: read_source_inactive
```

Only `{ id, surface: 'full' }` succeeded. Task 3's `applySurface` must send
`{ id, surface }`, not `rescopeParams`.

### Deviations from the plan's Task 1 code (both required to measure anything)

- The plan read `grant.json.client_id`; the pin's grant receipt is
  `{ status, grant: { clientId } }` (see
  `test/contract/mcp-grant.contract.test.ts:96-98`). Corrected to
  `grant.json.grant.clientId`.
- Test (c) uses `{ id, surface: 'full' }` per the plan's own fallback, since
  the full re-statement is rejected with `read_source_inactive`.

### Implication for Tasks 2–6

Compiling to `full` is necessary but **not sufficient**: Mobrain must also
provision a host skills directory (`mcp.skills_dir` or `GBRAIN_SKILLS_DIR`, or
a repo `skills/RESOLVER.md`) on the gbrain that serves members, otherwise
`list_skills` returns `storage_error` for every member. ~~That prerequisite is
absent from the plan and must be designed before member skill delivery can
work.~~ **Resolved:** Task 0 ships repo `skills/` mounted read-only at
`/opt/mobrain-skills` and exports `GBRAIN_SKILLS_DIR=/opt/mobrain-skills` in the
services that resolve skills. Tasks 2–6 may proceed.

## Live dev-stack check and the publish-gate readback divergence (2026-09-22)

### What passed

Measured on the live dev stack after redeploy and sign-in:

- A live claim with publishing on returned `skillsPublished: true`.
- Both minted clients (`bs-…-shared` and `bs-…-shared-server`) showed
  `surface: "full"`.
- A member MCP `list_skills` call returned HTTP 200 with
  `skills_dir_source: env_explicit`, and the member fetched skill `query`.

### What failed: the off-gate readback

With the DB plane set to off, the admissibility check still reports publishing
on:

```
gbrain config set mcp.publish_skills false
# then a fresh claim returned skillsPublished: true  (wrong)
```

The MCP tools are genuinely hidden by the gate at that point, so
`skillsPublished` and the claim's wiring snippet over-report for a
DB-overridden install. State was restored (`true`) after measuring.

### Root cause

The feature reads `mcp.publish_skills` on claim via `readConfigValue`
(`src/control/configValue.ts`), which runs `gbrain config get <key>` through
`callOps`. That path resolves the **file/env plane first**
(`~/.gbrain/config.json`, written by `gbrain init`):

- gbrain `src/commands/config.ts:448-450` — the `dbAuthoritative` false branch;
  `mcp.publish_skills` is not in the dual-plane set.

gbrain's actual publish gate for `list_skills`/`get_skill` resolves the **DB
plane first, then the file plane, absent/failed = false**:

- gbrain `src/mcp/publish-gates.ts:12-14,26` (`readPublishGate`).
- gbrain `src/core/skill-catalog.ts` `readMcpPublishSkills`.

So `gbrain config set mcp.publish_skills false` writes the DB plane, the gate
honors it, but `config get` keeps printing the file plane's `true` (with the
"DB-plane value ... shadowed" note) and this readback follows it.

### Consequence

When an operator overrides the gate in the DB plane, `ClaimResult.skillsPublished`
still reports `true` and the claim snippet still advertises skills, even though
the MCP tools are hidden. The default state is correct, because only `gbrain
init` writes the file plane, and fail-closed on an unreadable value still holds.
The divergence is the over-reporting case only.

**Not fixed in this repo.** Decision: document it here and file it upstream so
gbrain exposes a supported way to read the effective gate value.

Upstream issue: https://github.com/garrytan/gbrain/issues/5358
