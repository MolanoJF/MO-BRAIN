import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.52.2.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. Reconciliation apply, backup removal, and rollback are
 * operator decisions. Choosing file-wins or database-wins is forbidden.
 *
 * Lane already does it (quoted, not a step): "Let `gbrain upgrade` apply schema
 * migration 163. If schema maintenance failed, run `gbrain apply-migrations
 * --yes`". "Restart upgraded resident writers and maintenance workers" is the
 * run's restart. Our lane does not run `gbrain upgrade`.
 *
 * Numbered: 1 lane schema; 2 do not authorize paid enrichment; 3 read-only
 * audit; 4 preview and relay conflicts; 5 apply only a reviewed artifact; 6
 * the blocked memory intent is a separate request. Backup removal and rollback
 * are unnumbered operator decisions and are checklist items.
 */
const UPSTREAM_SHA256 = '07568b099264e56f909f46eb417c4a512788e893e8ae6080423ad6ae06918076';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v5220-no-paid-enrichment',
    prompt:
      'Confirm this migration did not change providers or authorize paid enrichment. Preserve ' +
      'ownership, source roots, activation state, and checkpoints. Do not delete owner markers, ' +
      'disable guards, or run writer claim, transfer, or activate as a shortcut for a content ' +
      'disagreement.',
    why:
      'Upstream step 2: "Do not change providers or authorize paid enrichment as part of this ' +
      'migration." The header also forbids claim, transfer, and activate as a shortcut. Those are ' +
      'operator decisions. Restart is the lane.',
  },
  {
    key: 'v5220-reconcile-audit',
    prompt:
      'On the canonical host, run bounded read-only `gbrain sources reconcile <source> --audit ' +
      '--limit 25 --json` and continue with `next_after`. A sample is not proof the whole source is ' +
      'clean. A missing or invalid owner needs operator diagnosis, not automatic registration or ' +
      'activation.',
    why:
      'Upstream step 3: "A sample is not proof that the whole source is clean. A missing or invalid ' +
      'owner requires operator diagnosis, not automatic registration or activation." The audit is a ' +
      'repair preview. Naming the source is operator judgement.',
  },
  {
    key: 'v5220-reconcile-preview',
    prompt:
      'For each affected page, run an exact preview. Save an actionable artifact only to a new ' +
      'private path outside canonical repositories. Relay conflicts and the resolved result to the ' +
      'operator before applying. Never choose file wins, database wins, or timestamp wins.',
    why:
      'Upstream step 4: "Never choose file wins, database wins, or timestamp wins on the operator\'s ' +
      'behalf." That choice is the definition of operator judgement. A step that picked a winner ' +
      'would invent the decision the file forbids.',
  },
  {
    key: 'v5220-reconcile-apply',
    prompt:
      'Apply only an operator-reviewed ready artifact, with an explicit request UUID kept across a ' +
      'lost response. Changed preconditions need a new preview. A terminal conflict needs a new ' +
      'request UUID. Confirm topology was left unchanged.',
    why:
      'Upstream step 5: "Apply only an operator-reviewed ready artifact with an explicit request ' +
      'UUID." Applying a repair is a checklist item. The reviewed artifact is not in UpgradeContext.',
  },
  {
    key: 'v5220-separate-memory-intent',
    prompt:
      'After a repair commits, submit the originally blocked memory intent as a separate new ' +
      'request. Read back the fact, visibility, and provenance independently. A committed repair ' +
      'receipt alone does not prove memory was inserted.',
    why:
      'Upstream step 6: "A committed repair receipt alone does not prove that memory was inserted." ' +
      'The follow-up write is a new operator request, not a step this playbook may invent.',
  },
  {
    key: 'v5220-backup-removal',
    prompt:
      'Inspect private retained originals with `sources reconcile <source> <slug> --backups --json`. ' +
      'Remove an exact terminal backup only after explicit approval with `--remove-backup ' +
      '<reference>`. Do not remove a nonterminal or recovering backup. Forgetting active memory does ' +
      'not erase backup history.',
    why:
      'Upstream: "Remove an exact terminal backup only after explicit operator approval". Deleting a ' +
      'backup is a destructive operator decision. No step may take it.',
  },
  {
    key: 'v5220-rollback-boundary',
    prompt:
      'If rollback is necessary, stop new repair submissions and drain or recover every accepted ' +
      'request on a compatible upgraded owner before reverting the binary. Do not downgrade a live ' +
      'reconciliation queue, drop the additive table or private backups, or restore an old preimage ' +
      'over newer edits.',
    why:
      'Upstream: "Never downgrade a live reconciliation queue, remove the additive table or private ' +
      'backups, or restore an old preimage over newer edits." That is operator judgement. Inventing ' +
      'a downgrade step would violate the file.',
  },
];

export const v0_52_2_0: PlaybookSpec = {
  version: '0.52.2.0',
  upstreamSkill: { path: 'skills/migrations/v0.52.2.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
