import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.51.7.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. The numbered commands are the lane, a repair, paid
 * embedding, or SQL against gbrain tables.
 *
 * Lane already does it (quoted, not a step): "Run `gbrain apply-migrations
 * --yes` if upgrade reported a schema failure." "`gbrain doctor`" and
 * "Restart the upgraded resident `gbrain serve`" are the run's own steps.
 *
 * Numbered: 1 do not broaden grants; 2 a pending projection is not missing
 * content; 3 code reindex is a repair; 4 inspect readiness; 5 `embed --stale`
 * needs spend approval. The ANALYZE sentence is G3 and is a checklist quote.
 */
const UPSTREAM_SHA256 = 'c34621712c4fc8597e193c7fc44b588cab8622584204a2b6f59ffd24b9d3624c';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v5170-do-not-broaden-grants',
    prompt:
      'Confirm schema maintenance used an authorized database role. Do not broaden runtime grants ' +
      'or disable row security to make migrations 160 and 161 pass.',
    why:
      'Upstream step 1: "Schema maintenance needs an authorized database role. Do not broaden ' +
      'runtime grants or disable row security to make it pass." Apply-migrations is the lane. The ' +
      'grant decision is not.',
  },
  {
    key: 'v5170-projection-not-missing',
    prompt:
      'If doctor reports a pending projection, treat it as queued Markdown or code rebuild work, ' +
      'not as proof that source content is missing. Let the upgraded resident worker drain it. Do ' +
      'not roll the brain back to legacy writers.',
    why:
      'Upstream step 2: "A pending projection is not proof that source content is missing." ' +
      'Judging a doctor warning as data loss would invent a repair. Restart and doctor are the lane.',
  },
  {
    key: 'v5170-code-reindex',
    prompt:
      'For code metadata that still needs repair, run `gbrain reindex-code --force --no-embed ' +
      '--source <source-id>` on the brain host only after you name the source. Do not bypass the ' +
      'managed writer.',
    why:
      'Upstream step 3 names that repair command and says "Do not bypass the managed writer or roll ' +
      'the brain back to legacy writers." Which source still needs repair is operator judgement. ' +
      'The command is not a function of UpgradeContext.',
  },
  {
    key: 'v5170-inspect-readiness',
    prompt:
      'Repeat a source-scoped search and inspect readiness. `projection_pending`, ' +
      '`projection_status_unknown`, and `vector_candidates_incomplete` mean the results are not ' +
      'evidence of complete retrieval, even when they accompany hits.',
    why:
      'Upstream step 4: those three statuses "all mean the results are not evidence of complete ' +
      'retrieval." Reading them and deciding the search is trustworthy is operator judgement.',
  },
  {
    key: 'v5170-embed-stale',
    prompt:
      'If vectors remain missing after text recovery, explain that distinction and obtain ' +
      'provider-spend approval before `gbrain embed --stale`. Do not run it from this upgrade.',
    why:
      'Upstream step 5: "obtain any required provider-spend approval before `gbrain embed --stale`. ' +
      'Diagnostics and keyless rebuilds must not opt the operator into embedding." Paid work is a ' +
      'checklist item, not a step.',
  },
  {
    key: 'v5170-analyze-is-sql',
    prompt:
      'If statistics refresh fails after a batch, ask the authorized database owner to run ' +
      '`ANALYZE pages(text_projection_revision, knowledge_revision)`. Do not force a global index ' +
      'plan or raise query timeouts to hide the failure. This upgrade does not run that SQL.',
    why:
      'Upstream: "ask the authorized database owner to run `ANALYZE pages(text_projection_revision, ' +
      'knowledge_revision)`." SQL against gbrain\'s own tables is forbidden here (G3). It is quoted ' +
      'so a human can hand it to the database owner. No step executes it.',
  },
];

export const v0_51_7_0: PlaybookSpec = {
  version: '0.51.7.0',
  upstreamSkill: { path: 'skills/migrations/v0.51.7.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
