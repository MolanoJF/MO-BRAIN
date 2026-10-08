import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.26.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. Whether a TypeSafe key is present, and whether to keep the
 * two default-on slots, is operator judgement. UpgradeContext has no key and
 * no config read. Inventing `gbrain decide disable` would both shell out and
 * opt out for the user, which the file forbids.
 *
 * Lane already does it (quoted, not a step): "Run `gbrain upgrade`, then
 * `gbrain doctor`." "If schema work did not complete, run `gbrain
 * apply-migrations --yes --no-autopilot-install`". Our lane does not run
 * `gbrain upgrade`.
 *
 * blocksResume: with a TypeSafe key, dream triage and contradiction proposals
 * turn on by default and the next dream cycle sends transcript windows and
 * fact text. The file says tell the user and do not opt out for them. Resumed
 * scheduler and worker would start that paid default. The named opt-out
 * commands are `gbrain decide disable triage`, `gbrain decide disable conflict`,
 * and `gbrain decide disable --all`. None is an allowlisted op, so this item
 * has no declineOp. Decline does not apply an opt-out; the admin runs the
 * quoted command, then acknowledges. Acknowledge keeps the upstream default.
 *
 * Numbered: 1 lane upgrade and doctor; 2 tell the user and, if a key is
 * present, tell them the defaults are on; 3 quickstart only if they want it;
 * 4 relay enable refusals; 5 do not adopt a newer calibration without asking;
 * 6 the kill switch is the quoted disable command, not a step.
 */
const UPSTREAM_SHA256 = '30d761ef5a2361bad66053f97b7b659304a591274be33e281f4f6df0d7d5566e';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v60260-typesafe-defaults',
    prompt:
      'Before writers resume, tell the user what System One is. Without a TypeSafe key ' +
      '(`TYPESAFE_API_KEY` or `JEV_TYPESAFE_API_KEY`), every slot is off and nothing is sent. If a ' +
      'key is present, dream triage and contradiction proposals are on by default: triage sends ' +
      'transcript windows, conflict sends fact text, and the measured run raised dream spend by ' +
      'about 73%. Do not opt out for them. If they do not want those slots, they run ' +
      '`gbrain decide disable triage`, `gbrain decide disable conflict`, or `gbrain decide disable ' +
      '--all` themselves, then acknowledge this item. A decline here does not apply that command: ' +
      'it is not an allowlisted op. Acknowledging keeps the upstream default.',
    why:
      'Upstream step 2: "If a TypeSafe key is present, also tell the user that dream triage and ' +
      'contradiction proposals are now on by default ... Do not opt out for them." Those slots are ' +
      'a paid default resumed dream and maintenance would start. The file says to ask. ' +
      '`gbrain decide disable` is not an allowlisted ops RPC, so no declineOp is invented.',
    blocksResume: true,
  },
  {
    key: 'v60260-quickstart',
    prompt:
      'Run the quickstart only if the user wants to try System One. Never ask for the key in chat. ' +
      '`gbrain decide probe` sends a fixed sentence. A query probe needs the user to see the egress ' +
      'line before `--yes`. `enable --recommended` writes config only when an explicit setting turned ' +
      'a default off; confirm before `--yes`. If it prints that no slot has a recorded win, relay ' +
      'that and change nothing.',
    why:
      'Upstream step 3: "If the user wants to try it, run the quickstart" and "never ask for the key ' +
      'in chat". Enabling a slot and confirming `--yes` are operator decisions. No step runs them.',
  },
  {
    key: 'v60260-relay-refusals',
    prompt:
      'Relay a refused `enable` as written: reason code, fix command, and the docs anchor. Read that ' +
      'row before running the fix. Slots that send private content need `decide.egress.private allow` ' +
      'on Jev, or an `llm:` route. Ask the user which. Do not set `decide.egress.private allow`, ' +
      'raise `decide.budget.daily_usd`, or set a `force_on` key without asking.',
    why:
      'Upstream step 4: "Relay refusals as written." And the header: "Never turn a slot on, set ' +
      '`decide.egress.private allow`, raise `decide.budget.daily_usd` or set a `force_on` key on the ' +
      'user\'s behalf without asking." Those config changes are not steps.',
  },
  {
    key: 'v60260-calibration',
    prompt:
      'When `gbrain decide status` shows `newer reference available`, show the threshold change ' +
      'before `gbrain decide calibrations adopt <id>`. Relay `on (inactive: <reason>)` with the ' +
      'printed fix. To pin a key-aware default slot, ask before `gbrain config set ' +
      'decide.slots.<slot>.calibration ref:<id>`. Do not switch an enabled slot to a newer ' +
      'calibration yourself.',
    why:
      'Upstream step 5: "a new binary never switches an enabled slot to a newer reference calibration ' +
      'by itself" and "ask the user before running `gbrain config set decide.slots.<slot>.calibration ' +
      'ref:<id>`". Adopting a calibration is operator judgement. The calibration id is not a declineOp.',
  },
];

export const v0_60_26_0: PlaybookSpec = {
  version: '0.60.26.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.26.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
