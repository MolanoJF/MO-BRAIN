import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.27.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. `bun --version` and `bun upgrade` are not fields of
 * UpgradeContext. The file says ask before running `bun upgrade` because it
 * changes the runtime for every Bun program on the machine. Our container
 * image carries Bun; a source-installed thin client is a separate host.
 *
 * Lane already does it (quoted, not a step): "If `gbrain upgrade` ran on the
 * old Bun, its migrations stopped at the runtime check. Run `gbrain
 * post-upgrade`." "`gbrain doctor`" and "If `upgrade_errors` still points at
 * a post-upgrade failure ... run `gbrain apply-migrations --yes
 * --no-autopilot-install`". Restart of this stack's serve, supervisor, and
 * autopilot is the lane. Our lane does not run `gbrain upgrade` or
 * `bun upgrade`.
 *
 * The file does not say resumed services start a paid default. No blocksResume.
 *
 * Numbered: 1 check the runtime; 2 upgrade Bun only with agreement; 3
 * post-upgrade is the lane; 4 restart long-running processes (lane for this
 * stack, checklist for harnesses and other machines); 5 doctor is the lane.
 */
const UPSTREAM_SHA256 = '1c3ac6a23ccfce8ad299457799b02958f7d21fcd967c471634f73bdb66f2b603';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v60270-bun-runtime',
    prompt:
      'On the brain host and on any machine running a source-installed thin client, check ' +
      '`bun --version`. Compiled `gbrain` binaries carry Bun 1.4.2 and need nothing. If a source ' +
      'install is older than 1.4.0, ask before `bun upgrade` (or the package-manager equivalent). ' +
      'Upgrading Bun changes the runtime for every Bun program on that machine. If `bun --version` ' +
      'stays old, an older `bun` is first on `PATH` (`which -a bun`).',
    why:
      'Upstream steps 1 and 2: "ask before running `bun upgrade` on their behalf." And "Upgrading Bun ' +
      'changes the user\'s runtime for every Bun program on the machine". That is operator judgement. ' +
      'A step that ran `bun upgrade` would invent the agreement and touch a runtime UpgradeContext ' +
      'does not name.',
  },
  {
    key: 'v60270-external-restarts',
    prompt:
      'Restart long-running GBrain processes that this stack does not own: a stdio `gbrain serve` by ' +
      'restarting the agent harness, and any host `gbrain jobs supervisor` or autopilot outside ' +
      'compose. Services managed by launchd, systemd, or cron retry on their own once Bun is ' +
      'upgraded. Their refusal lines are in `~/.gbrain/autopilot.log` and `~/.gbrain/autopilot.err`.',
    why:
      'Upstream step 4: "Restart long-running GBrain processes so they pick up the new runtime", ' +
      'including "stdio MCP: restart the agent harness". This stack\'s restart is the lane. Other ' +
      'harnesses are operator actions. No step restarts them.',
  },
];

export const v0_60_27_0: PlaybookSpec = {
  version: '0.60.27.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.27.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
