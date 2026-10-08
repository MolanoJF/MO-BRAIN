import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.77.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. The file says nothing here needs the user's consent, but
 * relay the behavior-changes notice. Quote checking is on by default and is
 * not a new paid maintenance run the file says to ask before. Accepting a
 * forget proposal is permanent and needs confirmation. No blocksResume.
 *
 * Lane already does it (quoted, not a step): "`gbrain upgrade` runs it" and
 * "`gbrain apply-migrations --yes --no-autopilot-install`". v212 adds empty
 * review tables. "`gbrain doctor`" is the run. Our lane does not run
 * `gbrain upgrade` and does not set `think.quote_verify` or
 * `dream.quote_verify`.
 *
 * Numbered: 1 lane schema; 2 relay behavior changes; 3 new calls, confirm
 * before accepting a withdrawal; 4 leave the tool list alone; 5 doctor is
 * the lane.
 */
const UPSTREAM_SHA256 = '3a588974cea1db36a9f063ed056fae155adc5cb54fb606d49f69625e94e15c9d';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v60770-behavior-changes',
    prompt:
      'Relay the one-time `behavior_changes` notice. `think` answers and dream pages check quotes: ' +
      'a quote found in no evidence loses its marks and is marked `[unverified]`. Present `answer`, ' +
      'not `answer_raw`. Do not tell the user a kept quote is proven. Opt out only if they ask: ' +
      '`gbrain config set think.quote_verify false` and `gbrain config set dream.quote_verify false`. ' +
      '`forget` responses carry `similar_active`. Ask before forgetting any of those. On a brain with ' +
      'a TypeSafe key, forgetting a fact queues an overnight review that only proposes withdrawals. ' +
      'Opt out only if they ask: `gbrain config set decide.slots.conflict.review_withdraw false`. ' +
      'Do not set those keys from this upgrade.',
    why:
      'Upstream step 2: "Nothing here needs the user\'s consent, but relay the one-time ' +
      '`behavior_changes` notice". The file names the opt-out keys and does not say to ask before the ' +
      'next maintenance run. Relaying is the checklist item. Setting the keys would invent the opt-out. ' +
      'No blocksResume.',
  },
  {
    key: 'v60770-forget-proposals',
    prompt:
      'To correct a fact, pass `replaces: <fact_id>` to `remember` instead of forgetting and ' +
      're-remembering. Review forget proposals with `gbrain decide proposals list`. Accepting a ' +
      'withdrawal is permanent: confirm with the user, then `gbrain decide proposals accept <r-id> ' +
      '--yes`. Otherwise reject it. Do not accept a withdrawal from this upgrade.',
    why:
      'Upstream step 3: "Accepting a withdrawal is permanent: confirm with the user". That is operator ' +
      'judgement. A step that accepted a proposal would invent the confirmation.',
  },
  {
    key: 'v60770-tool-list',
    prompt:
      'Leave `mcp.advertised_surface` unset. A held-out agent benchmark found shorter lists lowered ' +
      'task success by 8 to 10 points and saved no tokens. Set it only for a client that cannot hold ' +
      'the full catalog, and only if the user asks.',
    why:
      'Upstream step 4: "Leave the tool list alone." And "Set it only for a client that cannot hold ' +
      'the full catalog." Changing the advertised surface is a config decision. No step sets it. ' +
      'Doctor and `gbrain decide status` are the verify reads; doctor is the lane.',
  },
];

export const v0_60_77_0: PlaybookSpec = {
  version: '0.60.77.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.77.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
