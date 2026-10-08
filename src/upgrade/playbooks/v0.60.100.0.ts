import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.100.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. Acting on a malformed fence edits the user's file or
 * writes a page. Raising model-repair caps is the user's call. Nothing spends
 * under those caps in this release. The file does not say to ask before the
 * next maintenance run; that ask is v0.60.102.0. No blocksResume. No schema
 * migration.
 *
 * Lane already does it (quoted, not a step): "`gbrain upgrade` runs it; no
 * schema migration is added. Restart every `gbrain serve`, autopilot and
 * worker." "`gbrain doctor --only fence_integrity`" is the run's doctor. A
 * partial scan is not healthy; rerunning until `details.partial` is false is
 * the operator's reading of that doctor output, not a second doctor step this
 * playbook invents. Our lane does not run `gbrain upgrade`.
 *
 * Numbered: 1 lane restart; 2 run the check and do not report partial as
 * healthy; 3 act on what it lists; 4 tell the user about a noisy writer; 5
 * know the caps; 6 doctor is the lane.
 */
const UPSTREAM_SHA256 = '63583a73e957c5421bb826f2be48ac1aafaaa994392c1a05f26d1516b48c8573';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v601000-fence-integrity',
    prompt:
      'Read `gbrain doctor --only fence_integrity --json`. Each run scans for up to 10 seconds and ' +
      'resumes where the last run stopped. A `partial` result is not healthy: run the same command ' +
      'again until `details.partial` is false. Do not report a partial result as ok. `status: "ok"` ' +
      'means nothing is waiting, every source\'s scan is complete, and no source is at the ' +
      'repair-trend threshold.',
    why:
      'Upstream step 2: "Do not report a partial result as healthy." Doctor is the lane. Deciding ' +
      'that a partial scan is finished is operator judgement. A step that looped doctor would invent ' +
      'a host command and a completion claim UpgradeContext cannot make.',
  },
  {
    key: 'v601000-act-on-fences',
    prompt:
      'Act only on what `details.sources[]` lists. Held files: read the page, edit only that table, ' +
      'commit, then `gbrain sync --source <id> --no-pull`. Stored pages: write the page again with ' +
      '`put_page`; a fixable table reports `fences_normalized`, and an unfixable one refuses ' +
      '`invalid_fence`. Unsynced files: sync; a fixable table is committed, any other is held. Write ' +
      'facts with `remember` and takes with `takes_add`. Do not edit a table the check does not name.',
    why:
      'Upstream step 3: "Act on what it lists." Editing the user\'s file and writing a page are ' +
      'repairs. The sample never includes a cell value. No step picks a file or a rewrite.',
  },
  {
    key: 'v601000-caps-and-writers',
    prompt:
      'When a source had 20 or more tables repaired in 7 days, tell the user the top writers so the ' +
      'source of broken tables can be fixed. `fences.repair.max_usd_per_page` defaults to `0.05` and ' +
      '`fences.repair.max_usd_per_day` defaults to `1.00`. Nothing spends under them in this release. ' +
      'Raising them is the user\'s call: `gbrain config set fences.repair.max_usd_per_day <usd>`. Do ' +
      'not raise a cap from this upgrade.',
    why:
      'Upstream steps 4 and 5: "tell the user so it can be fixed at the source" and "Raising them is ' +
      'the user\'s call." Those are tell-the-user and a config change. The file says nothing spends ' +
      'in this release, so this item does not block resume. No step sets the cap.',
  },
];

export const v0_60_100_0: PlaybookSpec = {
  version: '0.60.100.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.100.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
