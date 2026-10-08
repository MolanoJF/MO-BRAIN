import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.57.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. The nightly relationship check makes small paid chat calls.
 * The file says ask whether to keep it, and to run post-upgrade's `if_no`
 * commands only after the user says no. Those commands are printed by
 * post-upgrade. This file does not name their config keys, so no declineOp
 * is invented.
 *
 * Lane already does it (quoted, not a step): "`gbrain upgrade` runs it" and
 * "`gbrain apply-migrations --yes --no-autopilot-install`". "Restart every
 * `gbrain serve`, autopilot and worker" is the lane. "`gbrain doctor --only
 * edge_validity`" is the run's doctor. Existing pages re-extract on following
 * dream cycles with no model calls; that re-extract is not the paid check.
 * Our lane does not run `gbrain upgrade`.
 *
 * blocksResume: the nightly check closes jobs and writes inferred timeline
 * lines. Resumed scheduler would start it. The admin runs the printed `if_no`
 * commands themselves if they say no, then acknowledges. Decline does not
 * apply an unnamed command. Acknowledge keeps the upstream default.
 *
 * Numbered: 1 lane schema and restart; 2 relay the notice and ask; 3 know
 * what the check writes and how to undo; 4 use the new reads; 5 doctor is
 * the lane.
 */
const UPSTREAM_SHA256 = 'b97afe1df069b14446a31b41bfd1f24fc76877c13bd2bf55bf6f6371a87e579c';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v60570-nightly-check',
    prompt:
      'Before writers resume, show the user the one-time post-upgrade [AGENT] block and ask whether ' +
      'to keep live-by-default graph reads and the nightly relationship check. The check makes small ' +
      'paid chat calls and writes an "(inferred) Ended <relation>" timeline line. Run the block\'s ' +
      '`if_no` commands only after they say no, then acknowledge this item. This file does not name ' +
      'those keys, so a decline does not apply an opt-out. Acknowledging keeps the upstream default. ' +
      '`gbrain config set dream.edge_contradictions.mode propose` makes the check ask first; set it ' +
      'only if they ask. Show `gbrain edge-proposals list --status all` and undo with ' +
      '`gbrain edge-proposals undo <id>`.',
    why:
      'Upstream step 2: "Show the user its message and ask whether to keep live-by-default graph ' +
      'reads and the nightly relationship check. Run its `if_no` commands only after they say no." ' +
      'The header says the nightly check "makes small paid chat calls". Resumed maintenance would ' +
      'start it. The `if_no` keys are not named in this file, so no declineOp is invented.',
    blocksResume: true,
  },
  {
    key: 'v60570-graph-reads',
    prompt:
      'When a graph read leaves relationships out, it returns `former_relationships_hidden` with the ' +
      'exact call that shows them. History is `get_links { slug, status: "all" }`. A past date is ' +
      '`as_of`. A period is `during`. To record that a relationship ended, write an Ended timeline ' +
      'line or call `add_link` with `valid_until`. Do not hide that notice or rewrite history to ' +
      'make a read look complete.',
    why:
      'Upstream step 4: "When a graph read leaves relationships out it returns a ' +
      '`former_relationships_hidden` notice". Telling the user how to read history is a checklist ' +
      'item. Inventing an Ended line would write a relationship the user did not record.',
  },
];

export const v0_60_57_0: PlaybookSpec = {
  version: '0.60.57.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.57.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
