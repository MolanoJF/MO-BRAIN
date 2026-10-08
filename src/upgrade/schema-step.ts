/**
 * The schema step's two decisions, isolated from scripts/upgrade.ts so both
 * can be pinned by a unit test without a container.
 *
 * 0.60.104.0 changed the meaning of `apply-migrations --yes`: at this target
 * it AUTHORIZES upstream's Phase F autopilot install (a crontab line, written
 * from inside a container where it is a silent no-op or a duplicate
 * scheduler). `--no-autopilot-install` is the skip, not an install — that is
 * why it is passed on every call and why GBRAIN_NO_AUTOPILOT_INSTALL=1 sits
 * beside GBRAIN_SELF_UPGRADE_MODE in compose.
 *
 * The journal event records the exit code ONLY. apply-migrations has no
 * --json (supportsJson stays false) and its prose is not ours to parse
 * (U3/G3), so nothing here claims a migration count — a zero exit is
 * recorded as "exited 0", never as "nothing was pending on this delta",
 * which was a claim about upstream's migration files this run never read.
 */
export function schemaStepParams(): { yes: true; nonInteractive: true; noAutopilotInstall: true } {
  return { yes: true, nonInteractive: true, noAutopilotInstall: true };
}

export function schemaStepJournal(exitCode: number): {
  message: string;
  data: { exitCode: number; outcome: 'exited_0' | 'failed' };
} {
  return {
    message: `apply-migrations exited ${exitCode}; exit code only, no migration count is claimed`,
    data: { exitCode, outcome: exitCode === 0 ? 'exited_0' : 'failed' },
  };
}
