# Member skills — measured at gbrain 0.50.5.0

Source: `test/contract/member-skills.contract.test.ts`, run 2026-09-22.

| Fact | Result |
|---|---|
| (a) `init` leaves `mcp.publish_skills` = `true` | pass |
| (b) starter `tools/list` count; skills hidden | 23; pass |
| (c) full `tools/list` count; `list_skills` bytes; `get_skill query` ok | 93; 675; **fail** (no host skills catalog) |
| (d) `sources_add` as memory-writer on full is denied | pass; shape: `{"error":"unknown_operation","message":"Unknown: sources_add","isError":true}` (outer `result.isError: true`) |
| Rescope params that worked | `{ id, surface }` only |

Consequence: member Connections compile to `full`. Callable scope is still
bounded by the grant profile (d). The cost is tool-list size (b → c).

## Gate verdict: FAIL (assertion c)

`full` exposes the tools, but serving a catalog needs an operator-provisioned
skills directory that neither the contract test nor the repo's compose stacks
provide. This is a stop condition for Tasks 2–6.

### What passed

- (a) `gbrain init` writes `mcp.publish_skills = true`; `config.get` read it
  back as exactly `true`.
- (b) The profile-default `starter` surface lists **23** tools and contains
  neither `list_skills` nor `get_skill`.
- (d) On `full`, a `memory-writer` client calling `sources_add` is denied in
  band: `unknown_operation` (`result.isError: true`). The grant profile still
  bounds callable scope.

### What failed (c)

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
`list_skills` returns `storage_error` for every member. That prerequisite is
absent from the plan and must be designed before member skill delivery can
work.
