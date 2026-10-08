# Fixture upgrade 0.50.5.0 → 0.60.104.0

Scratch project `gbrain-upgrade-fixture` only. `.env` was written from `.env.example`, not from a real secrets file. `docker compose --env-file .env -f compose/docker-compose.yml config` reported project name `gbrain-upgrade-fixture`. `mobrain-dev`, `mobrain-molior`, and project `brainstand` were not compose-cycled.

`bun run scripts/upgrade.ts plan --to 0.60.104.0` exited 0. It listed 104 playbook rows, from `0.51.0.0` through `0.60.104.0`. It did not list `0.60.105.0`. The pin file was unchanged.

## Ordering bug, then the recorded run

Run `run-6c03a910-563b-4954-81f0-d1ad3fb163c0` applied migrations (exit 0, `GBRAIN_SELF_UPGRADE_MODE=off`) and then auto-rolled back. Doctor parity failed because `supervisor` was `ok` at baseline and `warn` after the swap: the six `blocksResume` items had already stopped `gbrain-worker`. `schemaVersionOk` was true. That run is not the recorded success. The gate now resumes the baseline writers, scores `compareDoctor` unchanged, and only then stops `agent-runner`, `scheduler`, `gbrain-worker`, and `gbrain-serve`.

Recorded run: `run-e5782832-82df-440d-937d-2ccc7d289a60`.

`bun run scripts/upgrade.ts run --to 0.60.104.0 --yes` printed `ok: true`, `state: gated_ok`, `writers: held`, and:

```text
bun run scripts/upgrade.ts resume-writers --run run-e5782832-82df-440d-937d-2ccc7d289a60
```

`apply-migrations` exit 0. `post-upgrade` exit 0. `GBRAIN_SELF_UPGRADE_MODE` inside the run was `off`. `gbrain-ops` logs contained no autopilot install. Doctor parity: `regressed: []`, `schemaVersionOk: true`, status `warnings`, health score 85. Resolved check: `takes_count`.

Journal durations:

| Phase | Duration |
|---|---|
| Quiesce (`quiesced.drainMs`) | 15169 ms |
| Snapshot (`snapshot_taken.snapshotMs`) | 1621 ms |
| Swap (`snapshot_taken` 2026-10-08T02:53:26.834Z → `swapped` 2026-10-08T02:54:21.361Z) | 54527 ms |

Doctor `newChecks`: `dream_paid_loop`, `bun_runtime`, `embedding_key_source`, `harness_wiring`, `agent_contract`, `postgres_cancellation_driver`, `text_projection_readiness`, `persistence_capacity`, `parked_effects`, `worktree_refresh_stuck`, `managed_guard_schema_drift`, `publication_refusals`, `chat_fallback_chain`, `behavior_changes`, `timeline_orphans`, `slug_collisions`, `timeline_history`, `derived_visibility`, `safe_index_pending`, `credential_projection_pending`, `connector_checkpoints`, `persistence_request_indexes`, `persistence_request_growth`, `connector_held_items`, `git_held_files`, `frontmatter_hook`, `orphan_persistence_bindings`, `unbound_source`, `writer_version`, `self_capture`, `vector_plan`, `stale_embedding_effects`, `google_file_modes`, `extractor_facts_expired`, `captured_facts_active`, `loop_facts_drift`, `ontology_facts_fenced`, `extraction_date_grounding`, `frontmatter_repairable`, `global_maintenance_timeouts`, `legacy_job_authority`, `legacy_token_grant_shape`, `legacy_token_grant_drift`, `legacy_token_null_scope`, `decide_health`, `unlinked_facts`, `edge_validity`, `auto_chronicle`, `chronicle_config_invalid`, `auto_chronicle_default_on`, `facts_drain`, `fact_take_vectors`, `planner_stats_stale`, `retrieval_feedback_health`, `revision_backfill`, `core_memory`, `fence_integrity`.

## Checklist decisions

Each `blocksResume` item was decided through `POST /api/upgrades/checklist/:itemId/ack` or `.../decline`.

| Item | Decision | Why, for this empty fixture |
|---|---|---|
| `v60260-typesafe-defaults` | acknowledged | No TypeSafe key, so the slots stay off. Decline has no opt-out and would refuse resume. |
| `v60570-nightly-check` | acknowledged | No chat provider key, so the nightly check cannot spend. Decline has no opt-out. |
| `v60360-take-embed` | declined | Opt-out `takes.auto_embed=false`. Do not start paid take embed. |
| `v60450-auto-chronicle` | declined | Opt-out `auto_chronicle=false`. Do not start paid chronicle. |
| `v60990-fence-normalize` | declined | Opt-out `fences.normalize=false`. Do not rewrite fences on sync. |
| `v601020-fence-repair` | declined | Opt-out `fences.repair.enabled=false`. Do not rewrite fences on maintenance. |

`resume-writers` exited 0, state `completed`, and applied those four opt-outs. A second call exited 0 with `alreadyCompleted: true` and `resumed: []`. The journal has one `schema` event and one `completed` event.

## Rollback

```text
bun run scripts/upgrade.ts rollback --run run-e5782832-82df-440d-937d-2ccc7d289a60
```

Exit **4**. The report was `method: snapshot-restore`, `ranUpstreamDownMigrations: false`, `pin: 0.50.5.0`, `pinVerified: true`, `ok: true`. The running `gbrain --version` last token is `0.50.5.0`. The pin file is `0.50.5.0`.

Digest parity was not equal. The only differing part was `filePlane`: 4 items before, 7 after. The snapshot tar's counted files are `.gbrain/.gitignore`, `.gbrain/config.json`, `.gbrain/notices/behavior-changes/host-875521aaee63.baseline`, and `.gbrain/schema-packs/mobrain-personal/pack.json`. After restore the volume also had three files the 0.60 pin wrote and `tar xf` does not delete:

- `.gbrain/persistence/host.json`
- `.gbrain/persistence/fc528619-3cb7-4d1c-b57f-b7cccd70881c.cli.json`
- `.gbrain/persistence/fc528619-3cb7-4d1c-b57f-b7cccd70881c.stdio.json`

No `--force`, no `--acknowledge-no-backup`, and no SQL fix were used. The upgrade was not run a third time.
