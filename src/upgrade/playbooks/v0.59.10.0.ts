import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.59.10.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. Embedding migration, export retry, and Gmail backfill are
 * paid or operator-approved repairs. The file does not authorize paid repair,
 * archive restoration, attachment downloads, or new background services.
 *
 * Lane already does it (quoted, not a step): "Run `gbrain upgrade
 * --no-autopilot-install`, then confirm `gbrain --version`". "If the binary
 * upgraded but its schema work did not complete, use `gbrain apply-migrations
 * --yes --no-autopilot-install`". Restart of upgraded writers is the lane.
 * Our lane does not run `gbrain upgrade`.
 *
 * Numbered: 1 maintenance window and backup; 2 unknown vector identity stays
 * unknown; 3 inspect before a live embedding migration; 4 fresh export
 * destinations; 5 Gmail backfill stays opt-in; 6 verify after any approved repair.
 */
const UPSTREAM_SHA256 = 'e0268a05ab184d5518f88747313e772629b2af91db59eacbba728f2ebd9db3cd';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v59100-maintenance-window',
    prompt:
      'Stop all old CLI, resident, sync, and worker processes for this brain. Take and verify an ' +
      'engine-appropriate full backup. A Markdown export is not a backup substitute. Do not mix old ' +
      'and new writers.',
    why:
      'Upstream step 1: "Take and verify an engine-appropriate full backup. Markdown export does not ' +
      'include the full database and is not a backup substitute." Our quiesce covers this stack. The ' +
      'backup attestation is operator judgement.',
  },
  {
    key: 'v59100-vector-identity',
    prompt:
      'Confirm installing the schema did not call an embedding provider and did not infer an old ' +
      'vector\'s model from the current configuration. Unknown legacy identity remains unknown.',
    why:
      'Upstream step 2: "The new fact identity fields do not infer an old vector\'s model from the ' +
      'current configuration. Unknown legacy identity remains unknown; installing the schema does not ' +
      'call an embedding provider." A step that guessed a model would invent that inference.',
  },
  {
    key: 'v59100-embedding-migration',
    prompt:
      'Run `gbrain migrate embeddings --status` and preview an explicitly chosen model and dimension ' +
      'with `--dry-run` before any live migration. A live migration needs an operator-approved finite ' +
      '`--max-cost-usd`. `--yes` does not waive the cap. Do not automatically restore an archived ' +
      'source, reset a cursor, or force a revision.',
    why:
      'Upstream step 3: "Any live migration requires an operator-approved finite `--max-cost-usd` ' +
      'total; `--yes` does not waive the cap." Paid repair is a checklist item. Never "automatically ' +
      'restore an archived source".',
  },
  {
    key: 'v59100-fresh-exports',
    prompt:
      'Use a fresh destination for a new export. Export now refuses collisions and occupied planned ' +
      'paths. An interrupted destination stays incomplete; retry into a fresh destination. Do not ' +
      'treat an existing export as edited by a later withdrawal.',
    why:
      'Upstream step 4: "retry into a fresh destination. Existing exports remain historical snapshots ' +
      'and are not retroactively edited by a withdrawal." Overwriting an export would invent a write ' +
      'the file now refuses.',
  },
  {
    key: 'v59100-gmail-backfill',
    prompt:
      'Keep Gmail attachment repair opt-in. Ordinary sync reports attachment inspection for that ' +
      'sweep, not historical completeness. Preview `gbrain google attachments backfill --source <id>` ' +
      'and add `--yes` only when the operator approves the bounded metadata-only batch. Do not ' +
      'download or index attachment content.',
    why:
      'Upstream step 5: "Add `--yes` only when the operator approves the bounded metadata-only batch." ' +
      'That approval is operator judgement. The file "does not authorize ... attachment downloads".',
  },
  {
    key: 'v59100-verify-after-repair',
    prompt:
      'After any approved repair, check migration status and representative authorized searches. ' +
      'Genuine misses and private-only matches remain clean misses. Do not expand a spending ' +
      'authorization to make status green. If a step fails, preserve the backup and diagnostic output. ' +
      'Do not run a destructive reset or restore over intervening writes.',
    why:
      'Upstream step 6 and the close: "Do not run a destructive reset, restore over intervening writes, ' +
      'or expand a spending authorization to make the status turn green." Doctor and restart are the ' +
      'lane. The spending expansion is the judgement a step must not make.',
  },
];

export const v0_59_10_0: PlaybookSpec = {
  version: '0.59.10.0',
  upstreamSkill: { path: 'skills/migrations/v0.59.10.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
