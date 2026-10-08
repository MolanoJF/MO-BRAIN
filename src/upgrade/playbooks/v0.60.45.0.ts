import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.45.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. Auto-chronicle is a paid default. The file says tell the
 * user before anything else and record the answer. Reading doctor numbers and
 * deciding keep-or-opt-out is not a function of UpgradeContext.
 *
 * Lane already does it (quoted, not a step): "`gbrain upgrade` runs it" and
 * "`gbrain apply-migrations --yes --no-autopilot-install`". "Restart every
 * `gbrain serve`, autopilot and worker" is the lane. Our lane does not run
 * `gbrain upgrade`. Schema v199 creates empty ledger tables; it does not
 * itself spend.
 *
 * blocksResume: the chronicle phase of the maintenance cycle extracts pending
 * pages, one paid chat call each, once writers resume. The file says ask
 * first, including a brain that already had `auto_chronicle true` because that
 * setting had no effect before this release. declineOp is the file's opt-out,
 * `config.set` of `auto_chronicle` to `false`. Acknowledging keeps the default,
 * which is on. Unsetting the key also restores on; this decline sets false.
 *
 * Numbered: 1 lane schema and restart; 2 relay the cost and ask; 3 do not run
 * `dream --phase chronicle` without asking; 4 check one page after a write;
 * 5 backfill only after a dry-run and agreement.
 */
const UPSTREAM_SHA256 = 'ed92f7b642f1e84e6381ef9e7e855db1ac7d20abd9b79a7bb359c707a04b8b9d';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v60450-auto-chronicle',
    prompt:
      'Before writers resume, tell the user automatic event extraction is on. Use the real numbers ' +
      'from doctor `auto_chronicle_default_on`. Each new or changed meeting, conversation, or ' +
      'calendar page dated within the last 30 days gets one chat call, capped at ' +
      '`chronicle.job_budget_usd` ($0.25 by default) per page, and at most ' +
      '`chronicle.auto_daily_limit` calls per rolling day (200 by default). Page text is sent to the ' +
      'configured chat provider. Pages already in the brain are not swept. A brain that already had ' +
      '`auto_chronicle true` must be asked too: that setting had no effect before this release. ' +
      'Acknowledge to keep it. Decline applies `gbrain config set auto_chronicle false`.',
    why:
      'Upstream step 2: "Relay the cost and ask." And "Tell the user before anything else in this ' +
      'file." The maintenance cycle runs the chronicle phase when autopilot is up, so resumed ' +
      'services would start the paid default. The file names `gbrain config set auto_chronicle false` ' +
      'as the opt-out. That is allowlisted `config.set`. No other key is invented.',
    blocksResume: true,
    declineOp: { op: 'config.set', params: { key: 'auto_chronicle', value: 'false' } },
  },
  {
    key: 'v60450-chronicle-now',
    prompt:
      'Do not run `gbrain dream --phase chronicle` or `gbrain chronicle-backfill` without a dry-run ' +
      'and agreement. With autopilot, pending pages wait for the cycle after this item is decided. ' +
      'No chat provider configured means nothing runs; doctor names the missing provider. Backfill ' +
      'spends money: preview `--since <date> --limit 50 --dry-run`, show the count, and run it only ' +
      'if the user agrees.',
    why:
      'Upstream steps 3 and 5: "Never run `gbrain chronicle-backfill` without `--dry-run`, or ' +
      '`gbrain dream --phase chronicle`, on the user\'s behalf without asking." Those are paid. The ' +
      'hold above covers the automatic cycle. These commands are separate and are not steps.',
  },
  {
    key: 'v60450-check-one-page',
    prompt:
      'After a meeting page is written, its receipt carries `chronicle_backstop` pending the next ' +
      'cycle, or a skip code. After the phase runs, `gbrain day <date>` shows the events. Every code ' +
      'and its fix are in `docs/guides/life-chronicle.md`. Do not treat a skip as a failure to repair ' +
      'from this upgrade.',
    why:
      'Upstream step 4: "Check one page." That check happens after a user write and a later cycle. ' +
      'It is an observation, not a function of UpgradeContext. No step writes a meeting page to test it.',
  },
];

export const v0_60_45_0: PlaybookSpec = {
  version: '0.60.45.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.45.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
