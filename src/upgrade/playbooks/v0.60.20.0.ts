import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.20.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. Index rebuild, checkpoint retry, limit raises, held-item
 * retry, fence repair, `--force-retry`, and frontmatter reindex are repairs
 * or config changes. The file says never apply them without asking.
 *
 * Lane already does it (quoted, not a step): "Five schema migrations run on
 * `gbrain upgrade` (or `gbrain apply-migrations --yes`)." "`gbrain apply-migrations
 * --yes`" in the managed-migration section is that same lane, not `--force-retry`.
 * "`gbrain doctor`" and restart are the run. Our lane does not run
 * `gbrain upgrade`. "`gbrain upgrade` now ends with a `Binary:` line and a
 * separate `Migrations:` line" is observed by the lane's version check, not a
 * second upgrade.
 *
 * A next sync or autopilot cycle re-extracts links. The file says to let that
 * run, or to run extract now with agreement. It does not say to ask before the
 * next sync. No blocksResume.
 *
 * "Long sessions ... No action." Quoted here, not a step.
 */
const UPSTREAM_SHA256 = '9266863a9f76164c64a72b1be17b8ddb3bb97e1c3c5db9f666b69ebc7a228fdd';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v60200-request-indexes',
    prompt:
      'Read `persistence_request_indexes` in doctor. If it names `gbrain repair request-indexes ' +
      '--apply`, show the preview and apply only after the user agrees. If an index is still ' +
      'building, leave it running. If a sync printed `checkpoint_validation_timeout`, run the ' +
      'printed commands in order. Do not cancel the checkpoint request.',
    why:
      'Upstream managed-sync steps 1 and 2: "show the user `gbrain repair request-indexes` (preview), ' +
      'then apply it after they agree" and "Do not cancel the checkpoint request". Repair apply is ' +
      'a checklist item. Doctor is the lane.',
  },
  {
    key: 'v60200-request-growth',
    prompt:
      'When `persistence_request_growth` warns, tell the user which writer runs out of lifetime ' +
      'request ids and when, and offer the printed `gbrain config set persistence.limits.<limit> ' +
      '<value>`. Raise it only after they agree. Request ids are permanent.',
    why:
      'Upstream managed-sync step 3: "tell the user which writer runs out of lifetime request IDs ' +
      'and when, and offer the printed `gbrain config set`". Raising a limit is a config change. ' +
      'No step sets it.',
  },
  {
    key: 'v60200-working-tree-and-held',
    prompt:
      'If a working-tree sync skips legacy files for lack of a contextual retrieval mode, preview ' +
      '`gbrain repair contextual-mode` and apply only after agreement. If it skips non-UTF-8 files, ' +
      'list them and ask whether to re-save them as UTF-8. For held connector items, retry only ' +
      'after the user agrees and the cause is fixed. A connector that has never synced stays idle ' +
      'until `gbrain sync --source <id>` runs once. Preview `gbrain repair connector-fences` and ' +
      'apply only after agreement. Present a partial `gbrain waiting` answer as partial.',
    why:
      'Upstream: "preview `gbrain repair contextual-mode` with the user and apply it after they ' +
      'agree" and "After the user agrees and the cause is fixed" for `sources retry-held`. Those ' +
      'are repairs. Asking which file to re-save is operator judgement.',
  },
  {
    key: 'v60200-unwedge-chain',
    prompt:
      'Check `gbrain apply-migrations --list`. A `wedged` status on `0.28.0` means a pre-upgrade run ' +
      'gave up. Clear that marker with `--force-retry 0.28.0` only after the user agrees, once. If ' +
      'a migration refuses with `queue_capacity`, show the printed `gbrain config set ' +
      'persistence.limits...` command and run it only after they agree, then repeat the lane schema ' +
      'step. Do not clear a wedged marker yourself. `0.14.0` and `0.53.0` may still list host work.',
    why:
      'Upstream: "After the user agrees, clear that marker once" and "Never raise a limit or clear ' +
      'a wedged marker on the user\'s behalf without asking." `--force-retry` is not the lane\'s ' +
      'apply-migrations. It is operator judgement.',
  },
  {
    key: 'v60200-orphan-and-effects',
    prompt:
      'Preview and, only after the user agrees, apply `gbrain repair orphan-bindings` and ' +
      '`gbrain repair embedding-effects --source <id>`. A connector autopilot never synced stays ' +
      'idle until one `gbrain sync --source <id>`. Clear a stale folder with `gbrain sources ' +
      'set-path <id> --clear` only when that is the intended fix. To leave managed mode, follow the ' +
      'deactivate runbook, then run writer status once on every other host before an older binary writes.',
    why:
      'Upstream lifecycle step 2: "Preview and, after the user agrees, apply what it names". ' +
      'Deactivate is "follow `docs/architecture/topologies.md#deactivate-runbook`". Those are ' +
      'repairs and topology changes, not steps.',
  },
  {
    key: 'v60200-links-and-defaults',
    prompt:
      'On brains with `link_resolution.global_basename=true`, the next sync or autopilot cycle ' +
      're-extracts links once. Run `gbrain extract --stale --catch-up --include-frontmatter` now ' +
      'only with agreement. If doctor reports `embedding_query_prefix`, run the printed command ' +
      'only if the user agrees. If `memory_writeback` warns that private facts are invisible to MCP ' +
      'or HTTP agents, ask before `gbrain config set facts.default_visibility world` and ' +
      '`gbrain bootstrap harness --yes`. Historical dates before 1990 need ' +
      '`gbrain reindex-frontmatter` only after a dry-run and agreement. Meeting `**Attendees:**` ' +
      'lines gain edges on the next extract. Do not set a query prefix or widen fact visibility yourself.',
    why:
      'Upstream: "with the user\'s agreement, run it now" and "If yes: `gbrain config set ' +
      'facts.default_visibility world`". Those are repairs and a visibility grant. The file says ' +
      '"No step here changes the brain without the user\'s agreement." No step does.',
  },
];

export const v0_60_20_0: PlaybookSpec = {
  version: '0.60.20.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.20.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
