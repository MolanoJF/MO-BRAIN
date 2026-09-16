import { scrubOutput } from '../docker/host.ts';
import type { CommandScope } from './commands.ts';

/** Per-stream cap. A single pathological run must not bloat the Space repo. */
const STREAM_CAP = 3000;

/**
 * One command inside a multi-step run. `live-sync` is the only multi-step
 * command (sync, then embed --stale), and it must still produce ONE report —
 * so the headline facts stay the run's, and the per-step truth lands here.
 */
export type ReportStep = {
  /** ALREADY redacted by redactArgv before it gets here. */
  argv: string[];
  exitCode: number;
  classification: string;
};

export type ReportInput = {
  job: string;
  scheduleId: string;
  runId: string;
  slot: string;
  stamp: string;
  timezone: string;
  fireAt: Date;
  startedAt: Date;
  finishedAt: Date;
  connection: { id: string; clientName: string; writeSpace: string };
  scope: CommandScope;
  /** ALREADY redacted by redactArgv before it gets here. */
  argv: string[];
  exitCode: number;
  classification: string;
  payload: unknown;
  stdout: string;
  stderr: string;
  /** Set only by a multi-step run; the headline facts then describe the step that decided. */
  steps?: ReportStep[];
};

/**
 * scrubOutput (src/docker/host.ts) strips postgres URLs, client_secret values
 * and sk- keys. Reports are committed into a Space repo and then imported by
 * sync, so an unredacted one is a credential published into the brain (S3c).
 */
function block(label: string, text: string): string {
  const clean = scrubOutput(text ?? '').trimEnd();
  if (clean.length === 0) return '';
  const capped = clean.length > STREAM_CAP
    ? `${clean.slice(0, STREAM_CAP)}\n… truncated (${clean.length - STREAM_CAP} more characters)`
    : clean;
  return `\n## ${label}\n\n\`\`\`\n${capped}\n\`\`\`\n`;
}

const commandLine = (argv: string[]): string => scrubOutput(argv.join(' '));

export function renderReport(input: ReportInput): string {
  // Honesty rule 1, in the artifact the member actually reads: the Connection is
  // a control-plane argv fence, NOT a gbrain-enforced OAuth scope. The report is
  // committed into the member's own Space, so it must say so in plain words. A
  // brain-wide run swaps the disclosure for the whole-brain warning rather than
  // adding to it: the warning is strictly the stronger statement.
  const banner = input.scope === 'brain-wide'
    ? `\n> **This job reads the whole brain, not just \`${input.connection.writeSpace}\`.**\n`
    : "\n> Runs on gbrain's control lane as the ops service account — the Connection decides the"
      + ' Space, the report location and the commit identity; it is not a permission gbrain'
      + ' enforces for this command.\n';

  // A two-step run shows BOTH commands on the Command line: a report that names
  // only the step that happened to fail hides half of what ran.
  const steps = input.steps ?? [];
  const multi = steps.length > 1;
  const command = multi ? steps.map((s) => commandLine(s.argv)).join(' && ') : commandLine(input.argv);

  const payloadText = input.payload === null || input.payload === undefined
    ? ''
    : block('Result payload', JSON.stringify(input.payload, null, 2));

  const stepsText = multi
    ? `\n## Steps\n\n${steps
      .map((s, i) => `${i + 1}. \`${commandLine(s.argv)}\` — exit \`${s.exitCode}\`, \`${s.classification}\``)
      .join('\n')}\n`
    : '';

  return [
    `# ${input.job} — ${input.stamp}`,
    banner,
    '',
    `- Slot: \`${input.slot}\``,
    `- Timezone: \`${input.timezone}\``,
    `- Scheduled for: \`${input.fireAt.toISOString()}\``,
    `- Ran: \`${input.startedAt.toISOString()}\` → \`${input.finishedAt.toISOString()}\``,
    `- Connection: \`${input.connection.clientName}\``,
    `- Write Space: \`${input.connection.writeSpace}\``,
    `- Command: \`${command}\``,
    `- Exit code: \`${input.exitCode}\``,
    `- Result: \`${input.classification}\``,
    `- Run id: \`${input.runId}\``,
    '',
    stepsText,
    payloadText,
    block('stdout', input.stdout),
    block('stderr', input.stderr),
  ].join('\n');
}
