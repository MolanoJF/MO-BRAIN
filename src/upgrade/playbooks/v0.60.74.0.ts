import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.74.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. The file says nothing here needs the user's consent, but
 * relay the behavior-changes notice. That explicit "no consent" is why the
 * auto-drain default does not block writer resume. Opt-out keys are quoted,
 * not set.
 *
 * Lane already does it (quoted, not a step): "`gbrain upgrade` runs it" and
 * "`gbrain apply-migrations --yes --no-autopilot-install`". v209, v210, and
 * v211 run there. v210 shortens already-issued access tokens; this playbook
 * does not add a token-refresh feature. "Restart every `gbrain serve --http`,
 * autopilot daemon and `gbrain jobs work` worker" is the lane. "`gbrain doctor`"
 * is the run. Our lane does not run `gbrain upgrade`.
 *
 * Numbered: 1 lane schema; 2 restart is the lane; 3 relay behavior changes;
 * 4 update scripts and skill forks the operator maintains; 5 optional
 * follow-ups; 6 doctor is the lane, auth clients and writer status are reads.
 */
const UPSTREAM_SHA256 = 'cfd0e9fe6e7d506d60b3673cdb077b52ce292c12e74a81e8cb71c407cc926009';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v60740-behavior-changes',
    prompt:
      'Relay the one-time `behavior_changes` notice. Shell jobs terminate processes they leave ' +
      'behind. Declaring-pack brains start the daily `extract_atoms` auto-drain within ' +
      '`autopilot.auto_drain.max_usd_per_day` (opt out: `gbrain config set autopilot.auto_drain.enabled ' +
      'false`). OAuth access tokens last at most 90 days; a client without a refresh token ' +
      'reconnects. `gbrain sources writer status --json` renames `ingress` to `local_process_ingress`. ' +
      '`gbrain jobs work` exits 0 after a SIGTERM drain and 17 when work was handed back. Unextracted ' +
      'session files are kept up to 90 days. `gbrain doctor --only behavior_changes` shows it again. ' +
      'Do not set the opt-out from this upgrade: the file says nothing here needs consent.',
    why:
      'Upstream step 3: "Nothing here needs the user\'s consent, but relay the one-time ' +
      '`behavior_changes` notice". The auto-drain is a paid default the file explicitly does not ask ' +
      'before. Relaying is the checklist item. Setting `autopilot.auto_drain.enabled` would invent ' +
      'the opt-out. No blocksResume.',
  },
  {
    key: 'v60740-update-forks',
    prompt:
      'Update scripts and skill forks you maintain. Read `local_process_ingress.state` instead of ' +
      '`ingress`. `gbrain jobs supervisor stop --json` reason `timeout_40s` is now `timeout`. Cost ' +
      'caps use `--max-usd N|off`; a bare `0` is refused. A fork of `capture` uses ' +
      '`writes_pages: true` with `writes_to: [inbox/]`. The Sonar chat-completions endpoint is ' +
      'retired. Always-on capture in forked ingest skills runs only after an explicit opt-in. A ' +
      'migration playbook that forbids unattended upgrades outranks `self_upgrade.mode: auto`. Pin ' +
      'upgrades with `bun remove -g gbrain && bun add -g github:garrytan/gbrain#v<version>`, never an ' +
      'in-place tag swap. This playbook does not edit those forks.',
    why:
      'Upstream step 4: "Update scripts and skill forks you maintain." Those forks are not this repo\'s ' +
      'skill files, and a step that rewrote them would invent edits the capability diff did not ' +
      'require. The instructions are tell-the-user.',
  },
  {
    key: 'v60740-optional-follow-ups',
    prompt:
      'Offer, do not run: `gbrain transcripts recover codex` previews restoring the user side of ' +
      'sessions imported before this release; `--apply` re-imports them and extracts no facts. On an ' +
      'Anthropic-only brain, nightly quality-probe judges are three `gbrain config set ' +
      'models.eval.cross_modal.slot_*` keys, only if the user wants a verdict. Register an unpriced ' +
      'model with `gbrain pricing set` before a user-set probe cap will run it. Brains without ' +
      'managed persistence can reconcile every synced facts section with `gbrain dream --phase ' +
      'extract_facts` instead of 250 pages per cycle. Do not start that phase from this upgrade.',
    why:
      'Upstream step 5: "Optional follow-ups to offer the user." `--apply` is a repair. Config and ' +
      'pricing changes are operator decisions. No step runs them. Doctor, `gbrain auth clients`, and ' +
      'writer status are the verify reads; doctor is the lane.',
  },
];

export const v0_60_74_0: PlaybookSpec = {
  version: '0.60.74.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.74.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
