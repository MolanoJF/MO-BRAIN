# Probe results, gbrain 0.60.230.0 (2026-10-14)

Stack: compose project mobrain-dev, Postgres engine. Commands are the ones that worked.

`OPENAI_API_KEY` was empty, so no embedding-model flag was passed. Host MCP for probes is `http://127.0.0.1:3139/mcp` (compose dev port). Inside the gbrain container the server listens on `http://127.0.0.1:3131/mcp`. `MOBRAIN_PUBLIC_URL` is `http://127.0.0.1:8788`, which is not reachable from inside the container.

Pre-P1: an exited v1 `mobrain-dev` project still held `mobrain-dev_pg-data` and `mobrain-dev_gbrain-home`, so initdb would not re-run and `gbrain init` would not be clean. One wipe: `docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml down -v --remove-orphans`. `--remove-orphans` was required; without it the v1 containers still held the volumes. Removed only `mobrain-dev_pg-data` and `mobrain-dev_gbrain-home`. Left `mobrain-dev_brain-repos`, `mobrain-dev_caddy-config`, and `mobrain-dev_caddy-data`. Did not touch any volume whose name does not start with `mobrain-dev`.

## P1

`gbrain init --help` accepts the brief's flags. Embedding syntax from that help:

```text
--embedding-model <PROVIDER:MODEL>
  e.g. openai:text-embedding-3-large, voyage:voyage-multimodal-3
--search-mode <conservative|balanced|tokenmax>
```

Not used (no key): `--embedding-model openai:text-embedding-3-small`. That form matches the help syntax. Keyless stderr also said semantic search later needs `gbrain init --force --embedding-model <id>`.

First init:

```bash
dc run --rm gbrain gbrain init --non-interactive --search-mode balanced --json
```

Exit 1. Flags were accepted. Migration stopped at v24:

```text
v24 rls_backfill_missing_tables: role gbrain does not have BYPASSRLS privilege — cannot enable RLS safely. Grant it (as postgres or a managed-Postgres master user): ALTER ROLE gbrain BYPASSRLS; then re-run.
```

Fallback taken: `ALTER ROLE gbrain BYPASSRLS` as the postgres superuser in the mobrain-dev postgres container. `\du gbrain` then showed `Bypass RLS`.

Second init, same flags, exit 1 at v35:

```text
v35 auto_rls_event_trigger: role gbrain may not CREATE EVENT TRIGGER (superuser-only; on managed Postgres only the master user can — rds_superuser is not enough). Pre-create the auto_enable_rls() function and the auto_rls_on_create_table event trigger as that user (SQL in src/core/schema-migrations/v035-auto-rls-event-trigger.ts), then re-run.
```

Fallback taken once, as postgres, database `gbrain` (SQL copied from that migration's create-if-absent function and trigger):

```sql
CREATE FUNCTION auto_enable_rls()
RETURNS event_trigger AS $body$
DECLARE
  obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
    WHERE object_type = 'table'
    AND schema_name = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity);
  END LOOP;
END;
$body$ LANGUAGE plpgsql;

CREATE EVENT TRIGGER auto_rls_on_create_table
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION auto_enable_rls();
```

Result of that SQL: `CREATE FUNCTION`, `CREATE EVENT TRIGGER`. Both objects present (`evtenabled = O`).

Init re-run once, same flags, exit 1. v35 then passed (create-if-absent). Migrations ran through v119. v120 failed:

```text
Error [database_error]: must be owner of function public.auto_enable_rls
```

The function is owned by `postgres` because the pre-create ran as that user. Init was not retried again. `gbrain apply-migrations --yes` (named later by write errors) was tried once and failed the same way: `Schema migration failed: must be owner of function public.auto_enable_rls`. Schema stayed at version 119, latest 243.

Pack copy, validate, and activation still ran:

```text
✓ mobrain-brain v1.0.0: valid manifest
Set schema_pack = mobrain-brain
```

`gbrain schema active --json` (no chain field):

```json
{
  "schema_version": 1,
  "pack": "mobrain-brain",
  "version": "1.0.0",
  "identity": "mobrain-brain@1.0.0+7fe9acef",
  "resolved_from": "db-config",
  "source_id": null,
  "database": "read",
  "page_types": 21,
  "link_verbs": 22,
  "takes_kinds": ["fact", "take", "bet", "hunch"]
}
```

Chain, from `gbrain schema show --json` (active, then each parent): `mobrain-brain` extends `mobrain-personal`; `mobrain-personal` extends `mobrain-core`; `mobrain-core` extends null. Core page types include `person` and `collector`.

`gbrain config show` (database URL redacted by gbrain): engine `postgres`, `schema_pack: mobrain-brain` (db plane). `gbrain config get search_mode` → `Config key not found: search_mode`. `gbrain config get embedding_model` → `voyage:voyage-4` (source: db plane). Doctor still said no explicit embedding model was configured.

`gbrain doctor --json`: exit 0, `"status":"warnings"`, `health_score` 10, `brain_checks_score` 55. 184 checks, statuses only `ok` and `warn`. No check had status `error`. Relevant warnings: `schema_version` "Version 119, latest is 243"; `embedding_provider` "This brain has no explicit embedding model"; several checks failed to read columns or functions that later migrations would add (`claim_phase`, `gbrain_fact_fingerprint`, and others). `pgvector` ok. `rls` ok, "RLS enabled on 125/125 public tables".

`dc up -d gbrain autopilot`: gbrain became healthy on the compose command with no extra flag. `GET http://127.0.0.1:3139/health` → `{"status":"ok","version":"0.60.230.0","engine":"postgres"}`. Serve logs still reported persistence errors (`column r.claim_phase does not exist`, `column e.worktree_id does not exist`) because the schema is short of 243. A 401 from MCP advertised `resource_metadata="http://127.0.0.1:8788/.well-known/oauth-protected-resource/mcp"` even though the published dev port is 3139.

Result: FAIL -> fallback taken: `ALTER ROLE gbrain BYPASSRLS`; pre-created v35 `auto_enable_rls()` and `auto_rls_on_create_table` as postgres; init retried once and stopped at v120 `must be owner of function public.auto_enable_rls`. Pack activation and a healthy serve still happened. `search_mode` was not stored.

## P5

`gbrain sources add p-probe-a --name "Probe A" --json` exit 2: `Unknown flag: --json`. `--help` does not list `--json` on `add`. It documents `add <id> --path <p>` and says `--path` must be a git repo. `--db-only` is an unknown flag (`did you mean --ff-only?`).

Working command (no `--json`, no `--path`):

```bash
dc exec -T gbrain gbrain sources add p-probe-a --name "Probe A"
dc exec -T gbrain gbrain sources add p-probe-b --name "Probe B"
dc exec -T gbrain gbrain sources add c-company --name "Company"
```

```text
Created source "p-probe-a" (name: Probe A)
  federated: false — only searched when explicitly named via --source
```

Same for `p-probe-b` and `c-company`. `sources list --json` (that flag is valid on `list`):

```json
{
  "sources": [
    {"id": "default", "name": "default", "local_path": null, "federated": true, "page_count": 0},
    {"id": "c-company", "name": "Company", "local_path": null, "federated": false, "page_count": 0},
    {"id": "p-probe-a", "name": "Probe A", "local_path": null, "federated": false, "page_count": 0},
    {"id": "p-probe-b", "name": "Probe B", "local_path": null, "federated": false, "page_count": 0}
  ]
}
```

`/srv/gbrain-home` after the adds contained only `.gbrain` (schema packs, persistence, audit, cache, run). No source checkout path was created. `find /srv -name '*probe*'` was empty.

Result: PASS. Fallback taken for the rejected flag: drop `--json` on `sources add`. DB-only sources exist with `local_path: null`. `--help` still says `--path` is required; omitting it worked.

## P2

`gbrain mcp profiles --json` does not include scopes. Names only:

```json
{
  "profiles": ["memory-reader", "memory-writer", "coding-agent", "operator", "delegating-agent", "full"],
  "default": "memory-writer",
  "delegation_spending": "unlimited",
  "concurrency": 1
}
```

Scopes applied by `resolveGrantProfile` in the installed package (`src/core/grants/profiles.ts`), then confirmed on grant receipts:

| Profile | Scopes on the grant | Extra constraint |
|---|---|---|
| memory-reader | `read` (resolver; not granted here) | |
| memory-writer | `read`, `write`, plus `skills_member_self` on the receipt | |
| coding-agent | `read`, `write` (resolver) | requires an explicit isolated write namespace (`--bound-slug-prefixes`) |
| operator | `admin`, `skills_member_self` | |
| delegating-agent | `read`, `write`, `agent` (resolver) | requires non-empty `--bound-tools` |
| full | `admin`, `agent`, `skills_member_self` | requires non-empty `--bound-tools` that are on the delegate allowlist, and the bound source in the read set |

No profile's scope list is `read,write,admin`.

`TOKEN_TTL_MIN_SECONDS` is 60 and `TOKEN_TTL_MAX_SECONDS` is 7776000 in `src/core/grants/model.ts`. `--token-ttl 7776000` was accepted (`tokenTtlSeconds: 7776000`). `--token-ttl 7776001 --dry-run` exit 1: `Invalid client grant: token_ttl_invalid`.

Brief grant URL `http://127.0.0.1:8788/mcp` from inside the container:

```json
{"status":"error","reason":"admin_unreachable","message":"The administration request failed or timed out. Check --url and that the existing server is running."}
```

Working grant (URL is the in-container listen address; `--harness` omitted, receipt harness `generic`):

```bash
dc exec -T gbrain gbrain mcp grant probe-a2 --source p-probe-a --federated-read c-company \
  --profile memory-writer --token-ttl 7776000 --credentials-out /tmp/probe-a2.json \
  --url http://127.0.0.1:3131/mcp --json
```

Receipt shape (bearer redacted). Client id field is `grant.clientId` (also copied to `credentials.client_id`):

```json
{
  "status": "granted",
  "grant": {
    "clientId": "gbrain_cl_…",
    "clientName": "probe-a2",
    "scopes": ["read", "write", "skills_member_self"],
    "sourceId": "p-probe-a",
    "federatedRead": ["c-company"],
    "boundSlugPrefixes": null,
    "profile": "memory-writer",
    "tokenTtlSeconds": 7776000
  },
  "credentials": {
    "client_id": "gbrain_cl_…",
    "mcp_url": "http://127.0.0.1:3131/mcp",
    "profile": "memory-writer",
    "harness": "generic",
    "source_id": "p-probe-a",
    "expires_at": 1799799166,
    "renewable": true,
    "credentials": "private-file"
  },
  "credential_file": "/tmp/probe-a2.json"
}
```

Credentials file shape. Bearer field is `access_token`. Expiry field is `expires_at` (unix seconds). Also holds `client_secret` (redacted, not printed):

```json
{
  "version": 1,
  "mcp_url": "http://127.0.0.1:3131/mcp",
  "issuer_url": "http://127.0.0.1:3131",
  "client_id": "gbrain_cl_…",
  "client_secret": "<redacted>",
  "access_token": "<redacted>",
  "expires_at": 1799799166,
  "profile": "memory-writer",
  "harness": "generic",
  "source_id": "p-probe-a",
  "shared_skills": {"follow": true, "source_ids": ["<one id>"]}
}
```

`whoami` before rescope, HTTP 200, SSE `tools/call`. Relevant fields: `client_name` `probe-a2`, `profile` `memory-writer`, `scopes` `["read","write","skills_member_self"]`, `source_id` `p-probe-a`, `federated_read` `["c-company"]`, `direct_write.prefixes` null, `expires_at` 1799799166. `get_health` and `list_jobs` are not in this client's `allowed_operations`.

`gbrain auth rescope-client <client-id> --federated-read '' --json` exit 1:

```json
{"error":{"code":"invalid_grant","reasons":["read_source_inactive"],"message":"Invalid client grant: read_source_inactive"}}
```

`--help` says `--federated-read <id1,id2,...>` is the new read-scope source list. It has no `none`. Working fallback:

```bash
gbrain auth rescope-client <client-id> --federated-read p-probe-a --json
```

Exit 0. Following `whoami`: `grant_revision` 2, `federated_read` `["p-probe-a"]`.

`gbrain auth revoke-client <client-id>`:

```text
OAuth client revoked: "probe-a2" (gbrain_cl_…)
Tokens and authorization codes purged via cascade.
```

Following `whoami`: HTTP 401, body `{"error":"invalid_token","error_description":"Invalid token"}`.

Admin-scope grants:

- `operator` granted with no bound tools. Scopes `["admin","skills_member_self"]`. `boundSlugPrefixes` null. `put_page`, `get_health`, `list_jobs`, `get_stats`, `sources_list` are in `allowedOperations`.
- `full` without `--bound-tools`: `Delegating profiles require explicit non-empty --bound-tools`.
- `full --bound-tools whoami`: `delegated_tools_unavailable, delegated_read_source_missing`.
- `full --bound-tools get_page,put_page --federated-read p-probe-a,c-company` granted. Scopes `["admin","agent","skills_member_self"]`. `boundSlugPrefixes` null. `boundTools` `["get_page","put_page"]`. Same admin ops present.

`put_page` of `notes/probe-admin` with both operator and full: HTTP 200, `isError` true:

```text
unavailable: column "admitter_version" of relation "persistence_requests" does not exist
reason: schema_missing
```

The slug was not rewritten and was not forced under `agents/`; the write never committed, so an unfenced write was not demonstrated. `get_health` and `list_jobs` succeeded for both (HTTP 200, `isError` absent). `get_health` returned a stats object (`page_count`, `embed_coverage`, `migrations`, …). `list_jobs` returned `[]`.

None of the profiles gives scopes `read,write,admin`. The closest unfenced admin profiles are `operator` (`admin`) and `full` (`admin`,`agent`). Both have `boundSlugPrefixes: null`. Neither write succeeded.

Harness bearer (`claude mcp add --scope local --transport http gbrain-probe http://127.0.0.1:3139/mcp --header "Authorization: Bearer <redacted>"`, then `claude mcp list`, then `claude mcp remove --scope local gbrain-probe`):

```text
Added HTTP MCP server gbrain-probe with URL: http://127.0.0.1:3139/mcp to local config
gbrain-probe: http://127.0.0.1:3139/mcp (HTTP) - ✔ Connected
Removed MCP server gbrain-probe from local config
```

Result: FAIL -> fallback taken: grant `--url http://127.0.0.1:3131/mcp` (8788 is admin-unreachable in-container); rescope `--federated-read p-probe-a` instead of `''` (`read_source_inactive`). Grant, that rescope, revoke, 401, and `claude mcp list` connected all worked. No profile is `read,write,admin` with a demonstrated unfenced write.

## P3

Clients minted with the working grant URL and `--token-ttl 7776000`:

| Client | Profile | Write source | federatedRead on the receipt |
|---|---|---|---|
| A `probe-p3-a` | memory-writer | p-probe-a | `["c-company"]` |
| B `probe-p3-b` | memory-writer | p-probe-b | `["p-probe-b"]` (flag omitted; default is the write source, not empty) |
| ADM `probe-p3-adm` | operator | p-probe-a | `["c-company"]` |
| W `probe-p3-w` | memory-writer | c-company | `["c-company"]` |

ADM is `operator`, the admin-scope profile that granted without extra flags. `full` also has `admin` but needs `--bound-tools`.

`put_page` from B (`notes/secret-b`, text `zebracorn-b only in B`) and from W (`notes/company-x`, text `zebracorn-c in company`): both `isError` true, `unavailable` / `schema_missing`, `column "admitter_version" of relation "persistence_requests" does not exist`.

A and ADM, each of `search zebracorn-b`, `list_pages limit 100`, `search zebracorn-c`: HTTP 200, result `[]`. `get_page notes/secret-b`: `page_not_found`. No slug or text from `p-probe-b` appeared, and `zebracorn-c` was not found, because neither page was stored.

ADM `get_stats`:

```json
{"page_count":0,"chunk_count":0,"embedded_count":0,"link_count":0,"tag_count":0,"timeline_entry_count":0,"pages_by_type":{}}
```

ADM `sources_list`:

```json
{"sources":[{"id":"c-company","name":"Company","local_path":null,"remote_url":null,"federated":false,"strategy":null,"page_count":0,"last_sync_at":null}]}
```

That is the federated-read source only (name and count). It did not list `p-probe-b` or page content. It also did not list the write source `p-probe-a`.

Result: FAIL -> fallback taken: none for isolation itself. Writes never committed (`schema_missing` from the stalled v120 migration), so content isolation was not observable. Empty search/list and `page_not_found` are consistent with no rows, not with a proved fence.

## P6

`put_page` of `people/ada-probe` and `notes/meets-ada` as client A: both `isError` true, same `admitter_version` / `schema_missing` error. Waited 150 seconds. `get_page people/ada-probe include_content true`: `page_not_found`. No backlink. No embedding (no provider key; doctor embedding probe already failed).

Autopilot never stayed up. `dc ps` showed `Restarting (1)`. Logs, aside from the repeated v120 ownership failure, were only:

```text
No repo path. Use --repo or run gbrain sync --repo first.
```

`gbrain put --help` also says remote callers' existing-page wikilinks become mentions, and `gbrain serve --http` does not self-sweep. The sweep was supposed to be autopilot. Autopilot exited before any tick could cover a remote write, and there was no committed remote write.

Result: FAIL -> fallback taken: none. Remote writes did not commit, and autopilot crash-loops on missing repo path plus the stalled migration.

## P7

`put_page` of `system/collectors/probe` as client A: same `schema_missing` error. `list_pages` with `{"prefix":"system/collectors/","limit":50}`: HTTP 200, `isError` absent, body `[]`. `get_page` of that slug with `include_content: true`: `page_not_found`. No successful page, so content and frontmatter were not returned.

`list_pages` input schema has no `prefix`. From `gbrain --tools-json` (`parameters`, same property names as `schema.properties`):

```text
list_pages {"type":"string?","tag":"string?","limit":"number?","offset":"number?","updated_after":"string?","updated_after_slug":"string?","sort":"string?","include_deleted":"boolean?","source_id":"string?"}
get_page {"slug":"string","fuzzy":"boolean?","include_content":"boolean?","content_only":"boolean?","include_deleted":"boolean?","include_timeline_entries":"boolean?","grammar_diagnostics":"boolean?","source_id":"string?","include_quarantined":"boolean?","min_trust":"string?"}
schema_stats {}
schema_review_orphans {"limit":"number?"}
list_jobs {"status":"string?","queue":"string?","name":"string?","limit":"number?","fields":"array?"}
run_doctor {}
get_health {}
get_stats {}
sources_status {"id":"string"}
```

Scopes on those tools: `get_page`, `list_pages`, `sources_status`, `schema_stats`, `schema_review_orphans` are `read`. `get_stats`, `get_health`, `run_doctor`, `list_jobs` are `admin`. `sources_status.id` is required. The `prefix` argument was not rejected (empty list, no error) and was not in the schema; with zero pages that does not prove a prefix filter.

`dc run --rm --no-deps -v mobrain-dev_gbrain-home:/srv/gbrain-home:ro gbrain gbrain schema show --json` exit 0. JSON starts with `name: mobrain-brain`, `extends: mobrain-personal`, `version: 1.0.0`. A read-only home mount works.

`gbrain put --help` (first 30 lines of substance): stdin is the content when `--content` is omitted. The flag that names the write source in that help is `--source-id` ("Write source."). A global `--source` also exists (scope resolution in `src/cli/main.ts`). The brief command:

```bash
printf -- '---\ntype: collector\nkind: fixture\nenabled: false\ncadence: 1h\n---\nvia cli\n' \
  | dc exec -T gbrain gbrain put system/collectors/probe-cli --source p-probe-a
```

Exit 1. `--source` was not reported as an unknown flag. Failure was the same schema error: `column "admitter_version" of relation "persistence_requests" does not exist`. The page was not written, so the follow-up `get_page` was not run as a success check.

Result: FAIL -> fallback taken: none that made the write succeed. `schema show --json` on a read-only home mount works. `list_pages` has no `prefix` (use `source_id`, `type`, `tag`, `limit`). `get_page` takes `include_content` but a live page's content and frontmatter were not observed. `gbrain put` source flag in `--help` is `--source-id`.

## P4

`loginctl show-user ubuntu -p Linger` → `Linger=yes`. `systemctl --user status` succeeded (`user-bus-ok`). `loginctl enable-linger` was not needed.

`claude mcp add --scope user --transport http gbrain-probe http://127.0.0.1:3139/mcp --header "Authorization: Bearer <redacted>"` exit 0. File modified: `/home/ubuntu/.claude.json`. Removed again at the end (`claude mcp remove --scope user gbrain-probe`).

First `systemd-run --user --unit mobrain-probe --on-active=5s --property=RuntimeMaxSec=600 /tmp/claude-probe/run.sh` (script as in the brief, `exec claude`): exit 127. `err.txt`: `/tmp/claude-probe/run.sh: line 3: exec: claude: not found`. User-manager `PATH` is `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin` and does not include `/home/ubuntu/.local/bin`. The user bus was available, so a crontab fallback was not used.

Fallback: same unit, script calls `/home/ubuntu/.local/bin/claude` (the `claude` on the interactive `PATH`). `ExecMainStatus=0`, `Result=success`, about 14 seconds. `out.json` is JSON. Fields present: `result`, `is_error` (`false`), `total_cost_usd` (`0.1115808`). Also `type` `result`, `subtype` `success`, `stop_reason` `end_turn`, `num_turns` 3, `permission_denials` `[]`. `result` includes a `whoami` JSON for client A (`client_name` `probe-p3-a`, `source_id` `p-probe-a`, `federated_read` `["c-company"]`).

Headless claude.ai connector tools were present. The model listed them without calling them:

```text
mcp__claude_ai_Claude_Docs__batch
mcp__claude_ai_Claude_Docs__guide
mcp__claude_ai_Claude_Docs__update
mcp__claude_ai_Claude_Docs__create
mcp__claude_ai_Claude_Docs__delete
mcp__claude_ai_Claude_Docs__export
mcp__claude_ai_Claude_Docs__query
mcp__claude_ai_Claude_Docs__read
```

A second headless run asked to call `mcp__claude_ai_Claude_Docs__guide` with only `--allowedTools "mcp__gbrain-probe__*"`. Exit 0, `is_error` false, `permission_denials`:

```json
[{"tool_name":"mcp__claude_ai_Claude_Docs__guide","tool_use_id":"toolu_…","tool_input":{"items":["gbrain"]}}]
```

The model reported the call was denied because that tool's permission was not granted. It did not call another tool.

Result: FAIL -> fallback taken: absolute `/home/ubuntu/.local/bin/claude` under the user timer (bare `claude` is not on the systemd user PATH). With that path, the run exited 0 and `out.json` held client A's `whoami`. Linger was already on.

## P8

Backup directory `/tmp/mobrain-probe-backup/20261015T002122Z` (not in the repo).

```bash
dc exec -T postgres pg_dump -U postgres -Fc gbrain > "$b/gbrain.dump"
dc exec -T postgres pg_dump -U postgres -Fc mobrain > "$b/mobrain.dump"
docker run --rm -v mobrain-dev_gbrain-home:/v:ro -v "$b:/b" alpine tar -C /v -czf /b/gbrain-home.tgz .
```

Tar warned and ignored two sockets under `.gbrain/run/`. Dump sizes: `gbrain.dump` 448875 bytes, `mobrain.dump` 1502 bytes, `gbrain-home.tgz` 14807 bytes.

```bash
dc down -v
dc up -d postgres
# waited until postgres was healthy (initdb recreated roles and both databases)
dc exec -T postgres pg_restore -U postgres -d gbrain --no-owner --role=gbrain < "$b/gbrain.dump"
dc exec -T postgres pg_restore -U postgres -d mobrain --no-owner --role=mobrain < "$b/mobrain.dump"
docker run --rm -v mobrain-dev_gbrain-home:/v -v "$b:/b" alpine tar -C /v -xzf /b/gbrain-home.tgz
dc up -d gbrain autopilot
```

`pg_restore` exit 1 for both databases, with errors ignored:

```text
pg_restore: error: could not execute query: ERROR:  must be owner of extension vector
Command was: COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';
pg_restore: error: could not execute query: ERROR:  permission denied to create event trigger "auto_rls_on_create_table"
HINT:  Must be superuser to create an event trigger.
pg_restore: warning: errors ignored on restore: 2
```

```text
pg_restore: error: could not execute query: ERROR:  must be owner of extension citext
Command was: COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';
pg_restore: warning: errors ignored on restore: 1
```

No other ownership errors were printed. Compose warned that `mobrain-dev_gbrain-home` already existed (created by the `docker run` tar extract, not by Compose) and suggested `external: true`. It still started. gbrain became healthy.

`get_page notes/meets-ada` with token A: `page_not_found`. That page was never written (P6), so restore did not lose it; it was not in the dump. `whoami` with the same token A after restore: HTTP 200, `client_name` `probe-p3-a`, `profile` `memory-writer`, `source_id` `p-probe-a`, `federated_read` `["c-company"]`. The client row survived.

Result: FAIL -> fallback taken: none. Restore commands are the ones above. Token A still works. The page does not survive because it was never stored. `pg_restore` reports vector-extension comment ownership and event-trigger permission on `gbrain`, and citext comment ownership on `mobrain`, then ignores those errors.

## After the probes

`dc down` (no `-v`). Dev stack stopped. Volumes `mobrain-dev_pg-data` and `mobrain-dev_gbrain-home` remain from the P8 restore.
