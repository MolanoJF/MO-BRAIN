import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.30.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. Frontmatter link extraction, fact relink, and the
 * contradiction re-judge are paid or operator-approved. The vector-plan
 * rollback config is only if search regresses.
 *
 * Lane already does it (quoted, not a step): "stop autopilot and workers, stop
 * each resident `gbrain serve`, run `gbrain upgrade` on each host" is the
 * image swap and this stack's restart, not a playbook command. "`gbrain doctor`"
 * and "`gbrain stats`" in the verify step are the lane's doctor plus an
 * operator read. Migrations v187 and v188 run during the lane's schema step.
 *
 * Body links re-derive on the next `extract --stale` or autopilot cycle. The
 * file says to ask before the explicit frontmatter run, not before that cycle.
 * No blocksResume.
 */
const UPSTREAM_SHA256 = '2dd24bb319cad80ae15c52fb163c704fc3adfc1182d44ab563f636f07434a9e0';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v60300-frontmatter-links',
    prompt:
      'Tell the user the link extractor version moved. Body links re-derive on the next ' +
      '`gbrain extract --stale` or autopilot cycle. Frontmatter links need one explicit run per ' +
      'source. Ask first, then for each source id from `gbrain sources list` run ' +
      '`gbrain extract links --source db --include-frontmatter --source-id <id>`. Do not disable a ' +
      'pack. Code that walked meeting-to-person `attended` edges must walk incoming edges. A ' +
      'preview-bound historical attendance repair follows the attendance guide, not this upgrade.',
    why:
      'Upstream step 2: "Ask the user first, then for each source id". The explicit extract is a ' +
      'repair the file gates on agreement. Running it for every source would invent that agreement.',
  },
  {
    key: 'v60300-facts-relink',
    prompt:
      'Read `unlinked_facts` in doctor. If it reports a backlog, show `gbrain facts relink --dry-run`. ' +
      'Apply `gbrain facts relink` only after the user agrees. The model tier is capped by `--max-usd`, ' +
      'default $1.00. If they do not want automatic entity inference on new facts, ' +
      '`gbrain config set facts.entity_inference off` does not undo earlier links. Set it only if they ask.',
    why:
      'Upstream step 3: "Only after they agree, apply it". Fact relink is paid. The config opt-out is ' +
      'named and is not applied by this playbook. No declineOp: this item does not block resume, and ' +
      'the file does not say to ask before the next maintenance run.',
  },
  {
    key: 'v60300-contradiction-rejudge',
    prompt:
      'Before the next `gbrain eval suspected-contradictions`, tell the user the judge cache was ' +
      'invalidated and the run will re-judge every pair. Show the printed cost estimate and wait for ' +
      'agreement. Do not start that eval from this upgrade.',
    why:
      'Upstream step 4: "Show the printed cost estimate and wait for agreement." That eval is paid ' +
      'and is not a default our resumed services start by themselves. It is a checklist item, not ' +
      'blocksResume, and not a step.',
  },
  {
    key: 'v60300-vector-legacy-guard',
    prompt:
      'If vector search regresses on this Postgres brain, the rollback for this release is ' +
      '`gbrain config set search.vector_legacy_guard true` on the brain host, then a restart of serve ' +
      'and autopilot. Report it as an issue. Do not set that key unless the regression is real.',
    why:
      'Upstream step 5: "If vector search regresses on a Postgres brain, the rollback for this release ' +
      'is `gbrain config set search.vector_legacy_guard true`". Setting it preemptively would invent ' +
      'a config change the file reserves for a regression. Doctor is the lane.',
  },
];

export const v0_60_30_0: PlaybookSpec = {
  version: '0.60.30.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.30.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
