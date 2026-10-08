import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.99.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. Fence normalization rewrites the user's files on the next
 * managed sync. Previewing that sync and deciding to keep or refuse it is
 * operator judgement. UpgradeContext cannot see the checkout.
 *
 * Lane already does it (quoted, not a step): "`gbrain upgrade` runs it; no
 * schema migration is added. Restart every `gbrain serve`, autopilot and
 * worker." "`gbrain doctor --only git_held_files`" is the run's doctor. Our
 * lane does not run `gbrain upgrade` or `gbrain sync`.
 *
 * blocksResume: step 2 says tell the user what will be rewritten before the
 * next sync. Normalization is on by default and managed sync commits each
 * rewritten file. Resumed sync workers would start that rewrite. declineOp is
 * the finding-confirmed command: `config.set` of `fences.normalize` to
 * `false`. The file names that command. Acknowledging lets the next sync
 * normalize. Declining holds such fences instead.
 *
 * Numbered: 1 lane restart; 2 tell the user before the next sync; 3 held
 * fences re-screen on that sync; 4 behavior changes; 5 verify.
 */
const UPSTREAM_SHA256 = 'f56aeec78556eed9cc789ba5cca12c0953c1888368fee0b462cb72581dd8c5a8';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v60990-fence-normalize',
    prompt:
      'Before the next sync, tell the user normalization is on by default. Managed sync commits each ' +
      'rewritten file with `gbrain: persist canonical memory update`. Preview with ' +
      '`gbrain sync --source <id> --dry-run` (`would_normalize`: path and fix classes). Claims, ' +
      'existing row numbers, and valid cells do not change, and a row never becomes more visible. ' +
      'Acknowledge to allow that rewrite. Decline applies `gbrain config set fences.normalize false`; ' +
      'such fences are then held or refused as in v0.60.98.0. A read-only mirror keeps the fix in ' +
      'the database and never rewrites its checkout. A company-brain source never rewrites repository ' +
      'files. Held fences from v0.60.98.0 are re-screened on the next sync: a fixable one is ' +
      'normalized, the rest stay held. The sync reports `fences_normalized`; tell the user the top ' +
      'directories so the writer can be fixed at the source.',
    why:
      'Upstream step 2: "Tell the user what will be rewritten before the next sync." And "If the user ' +
      'does not want gbrain to rewrite fences ... `gbrain config set fences.normalize false`". ' +
      'Resumed sync would commit those rewrites. The opt-out is allowlisted `config.set` of ' +
      '`fences.normalize` to `false`. No other key is invented.',
    blocksResume: true,
    declineOp: { op: 'config.set', params: { key: 'fences.normalize', value: 'false' } },
  },
  {
    key: 'v60990-behavior-changes',
    prompt:
      'Tell the user `put_page`, `capture`, `remember`, `extract_facts`, takes writes, and facts ' +
      'relink normalize a fixable fence and report `fences_normalized`. Read the stored page with ' +
      '`get_page` before editing it. A fence that cannot be fixed exactly refuses `invalid_fence` ' +
      'with `fence_issues`; correct all of them and resubmit with a new request id. Legacy sync ' +
      'stores the normalized fence in the database and does not rewrite the file. Write facts with ' +
      '`remember` and takes with `takes_add`. Fence holds left after the sync need a person.',
    why:
      'Upstream step 4: "Know the behavior changes." And step 5: "Fence holds left after the sync are ' +
      'the tables that need a person". Those are tell-the-user. Doctor and sources status are the ' +
      'verify reads; doctor is the lane. No step rewrites a fence.',
  },
];

export const v0_60_99_0: PlaybookSpec = {
  version: '0.60.99.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.99.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
