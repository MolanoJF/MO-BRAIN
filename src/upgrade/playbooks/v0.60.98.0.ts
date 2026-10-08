import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.98.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. A fence hold is fixed by editing the user's file. The next
 * sync recovers a blocked source by itself. The file does not say to ask
 * before that sync. No blocksResume. No schema migration.
 *
 * Lane already does it (quoted, not a step): "`gbrain upgrade` runs it; no
 * schema migration is added. Restart every `gbrain serve`, autopilot and
 * worker." "`gbrain doctor --only git_held_files`" is the run's doctor. Our
 * lane does not run `gbrain upgrade`.
 *
 * Numbered: 1 lane restart; 2 unblock is the next sync, or sync now; 3 tell
 * the user and fix the named fence; 4 behavior changes; 5 doctor is the lane.
 */
const UPSTREAM_SHA256 = '006598c5fc107e1a61510a54e029059183d4f4c0879c2c86640a2988f0b2d33c';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v60980-fence-holds',
    prompt:
      'Read the post-upgrade `fence_holds:` line. The next sync recovers a blocked source in place. ' +
      'Run `gbrain sync --source <id> --no-pull` now only if the operator wants it now. No ' +
      '`--retry-failed`. Tell the user each hold: fence, section, rows, and reason. Edit only the ' +
      'named fence in the user\'s file, say what will change, commit, then sync. Do not run ' +
      '`gbrain repair frontmatter` for a fence hold. Use `remember` or `takes_add` to add rows ' +
      'without hand-editing. A `prepare_time` hold is fixed as its `fence.reason` says; after a ' +
      'database-side fix, `gbrain sources retry-held <id>`.',
    why:
      'Upstream steps 2 and 3: "The next scheduled or manual sync recovers it automatically" and ' +
      '"Edit only the named fence in the file (the user\'s file: say what you will change)". Editing ' +
      'the file is operator judgement. The file does not say to ask before the recovering sync. No ' +
      'step edits a page or syncs a source.',
  },
  {
    key: 'v60980-behavior-changes',
    prompt:
      'Tell the user coordinated writes refuse a malformed fence with `invalid_fence` and a `reason`. ' +
      'Correct the named fence and resubmit with a new request id. Legacy unmanaged sync still ' +
      'imports such a page with bad rows skipped and never holds it. Teams that want fail-closed ' +
      'blocking keep `gbrain config set sync.holds fail`. Company-brain sources always fail closed. ' +
      'Do not set `sync.holds` from this upgrade.',
    why:
      'Upstream step 4: "Know the behavior changes." `sync.holds fail` is a config change the file ' +
      'names for teams that want the old behavior, not a default this playbook sets. Doctor is the lane.',
  },
];

export const v0_60_98_0: PlaybookSpec = {
  version: '0.60.98.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.98.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
