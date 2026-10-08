import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.58.0.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. The file says this release adds no schema migration and
 * authorizes no live repair, automatic backfill, or paid enrichment.
 * Question-first recall stays opt-in. Historical attendance repair is a
 * separate decision.
 *
 * Lane already does it (quoted, not a step): "GBRAIN_NO_AUTOPILOT_INSTALL=1
 * GBRAIN_NO_REEMBED=1 gbrain upgrade --no-autopilot-install" and, if an earlier
 * migration failed, "`gbrain apply-migrations --yes --no-autopilot-install`".
 * Restart and `gbrain --version` are the run. Our lane does not run
 * `gbrain upgrade`.
 *
 * Numbered: 1 drain and backup; 2 inspect a failed migration, do not rerun
 * init; 3 do not switch brain or source to make a check pass. The unnumbered
 * recall, attendance, and repair sections are checklist items.
 */
const UPSTREAM_SHA256 = 'a6ee3d3125ff1be612df776c7b8d6dfcaeb57ca073255793a67dff78a23c51cc';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v5800-drain-and-backup',
    prompt:
      'On a managed deployment, stop and drain older owners and workers before replacing them. ' +
      'Retain the original installation and a verified full database backup. A Markdown export is ' +
      'not a full backup.',
    why:
      'Upstream step 1: "Retain the original installation and a verified full database backup. A ' +
      'Markdown export is not a full backup." Our quiesce covers this stack. The backup attestation ' +
      'is operator judgement.',
  },
  {
    key: 'v5800-inspect-failed-migration',
    prompt:
      'If an earlier migration failed, inspect that failure. Do not delete its ledger, rerun ' +
      'initialization, or enable capture to bypass a refusal.',
    why:
      'Upstream step 2: "Do not delete its ledger, rerun initialization or enable capture to bypass ' +
      'a refusal." Apply-migrations is the lane. Bypassing a refusal is the judgement the file forbids ' +
      'encoding as a step.',
  },
  {
    key: 'v5800-preserve-selection',
    prompt:
      'Confirm the existing brain and source selection were retained. Do not switch them to make a ' +
      'check pass. A writer claim is not permission to activate it.',
    why:
      'Upstream step 3: "Retain the existing brain and source selection; do not switch them just to ' +
      'make a check pass. A writer claim is not permission to activate it." Restart is the lane. The ' +
      'selection check is operator judgement.',
  },
  {
    key: 'v5800-query-first-opt-in',
    prompt:
      'Leave omitted `budget_policy` as facts-first. Use `query_first` only for a question where ' +
      'matching page evidence should take priority. Do not treat a small packing win as a general ' +
      'answer-quality claim, and do not activate a native harness as part of this upgrade.',
    why:
      'Upstream: "Omitted `budget_policy` retains the existing facts-first behavior. Only use ' +
      '`query_first` for a question where matching page evidence should take priority". Changing the ' +
      'default would invent a behavior the file keeps opt-in.',
  },
  {
    key: 'v5800-attendance-rules',
    prompt:
      'Read the attendance evidence guide before extracting. Do not disable or rewrite a pack to ' +
      'force a match. Restore a missing pack before retrying refused extraction. Unresolved ' +
      'references preserve the graph for retry.',
    why:
      'Upstream: "Do not disable or rewrite a pack to force a match." Rewriting a pack is operator ' +
      'judgement and a grant-adjacent schema change. No step may do it to clear a refusal.',
  },
  {
    key: 'v5800-attendance-repair',
    prompt:
      'Do not run `gbrain extract links --repair-attendance` from this upgrade. It can preview a ' +
      'bounded window only after the operator chooses a live source. Before applying, quiesce older ' +
      'extraction writers, verify a full backup, and obtain approval for the exact saved preview ' +
      'digest. `--backup-verified` does not create or verify a backup. Reverting the binary does not ' +
      'undo a completed repair.',
    why:
      'Upstream: "Do not run repair automatically from this migration guide." And "`--backup-verified` ' +
      'acknowledges the operator\'s verification; it does not create or verify a backup." The repair ' +
      'is a checklist item. A step that passed the flag would invent the attestation.',
  },
];

export const v0_58_0_0: PlaybookSpec = {
  version: '0.58.0.0',
  upstreamSkill: { path: 'skills/migrations/v0.58.0.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
