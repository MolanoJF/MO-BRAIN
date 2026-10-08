import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.28.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. Job cancel, legacy authorize, projection drain, and the
 * two preview-bound repairs need agreement. Autopilot `--install` is forbidden
 * in this lane and is not a step.
 *
 * Lane already does it (quoted, not a step): "Run `gbrain upgrade` on each
 * host" is the image swap, not a playbook command. Restart of this stack and
 * "`gbrain doctor`" are the run. There is no schema migration.
 *
 * The file says preview first and apply only after the user agrees. It does
 * not say to ask before the next sync or before a paid default starts. Letting
 * an upgraded resident drain projections is an operator choice named in the
 * file, not a hold. No blocksResume.
 *
 * Numbered clusters: step 1 restart and confirm binaries, including the
 * GBRAIN_HOOKS workaround; step 2 doctor findings in order; step 3 per-brain
 * autopilot reinstall, key warning, and exposed inline token.
 */
const UPSTREAM_SHA256 = 'f7fa936066fb188f6f3f54bb6c720f57743792e4371d0b98dd3cb5a57d1bd9c9';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v60280-confirm-binaries',
    prompt:
      'Tell the user, then with their agreement stop autopilot and workers and each resident ' +
      '`gbrain serve` on hosts this stack does not own. Confirm `gbrain --version` prints 0.60.28.0 ' +
      'through each launcher\'s own binary path. Make one write from each host and check that host\'s ' +
      '`last_seen` in writer status. That list is history, not proof every process upgraded. If ' +
      '`GBRAIN_HOOKS=0` was set to work around the session-start leak, ask the user to remove it ' +
      'from the harness environment and restart the harness.',
    why:
      'Upstream step 1: "Tell the user, then, with their agreement" and "If the user set ' +
      '`GBRAIN_HOOKS=0` ... ask them to remove it". This stack\'s restart is the lane. Other hosts ' +
      'and the hook workaround are operator decisions. No step edits a harness environment.',
  },
  {
    key: 'v60280-legacy-jobs',
    prompt:
      'If doctor reports `legacy_job_authority`, stop serve, autopilot, and workers. Cancel each ' +
      'active job doctor lists. Preview `gbrain jobs authorize-legacy` with the printed select, show ' +
      'the counts and any paid job names, then apply only with the printed `--expect <hash> --yes`. ' +
      'To drop the work instead, use the printed cancel apply. Do not authorize or cancel jobs yourself.',
    why:
      'Upstream step 2.1: "show the user the counts and any paid job names, then apply with the ' +
      'printed `--expect <hash> --yes`". Authorizing legacy jobs can spend money. The hash is not in ' +
      'UpgradeContext. No step runs it.',
  },
  {
    key: 'v60280-projection-drain',
    prompt:
      'If doctor reports `text_projection_readiness`, run `gbrain projections drain` on Postgres, or ' +
      'on PGLite when no resident holds the brain. If it refuses with `projection_owner_resident`, ' +
      'either let the upgraded resident drain it or, with agreement, run the stop, drain, and restart ' +
      'commands it prints. Do not invent a second drain.',
    why:
      'Upstream step 2.2: "with the user\'s agreement, run the stop, drain and restart commands it ' +
      'prints." The drain is a repair. Choosing to stop a resident owner is operator judgement.',
  },
  {
    key: 'v60280-stale-atoms-and-facts',
    prompt:
      'Preview `gbrain repair stale-atoms --source <id>` and `gbrain repair extractor-facts`. Apply ' +
      'only after the user reviews the preview, with the printed `--apply --expect <hash>`. Add ' +
      '`--include-ambiguous` only if the user asks, on both the preview and the apply. Retired atoms ' +
      'are soft-deleted and recoverable with `restore_page` for 72 hours.',
    why:
      'Upstream step 2.3 and 2.4: "after the user reviews it" and "Ambiguous facts restore only if ' +
      'the user asks". Those are preview-bound repairs. A step that applied them would invent the review.',
  },
  {
    key: 'v60280-other-actions',
    prompt:
      'Several brains on one host need `gbrain autopilot --install` per brain, default brain last, ' +
      'until `job.needs_reinstall` is null. This lane does not install autopilot. For a provider-key ' +
      'warning, either remove the environment variable and restart that process, or `gbrain config ' +
      'unset` the config key if the environment key is intended. If an inline harness token was ' +
      'exposed, follow the receipt\'s `if_exposed` command, then reconnect with `--fresh-token`.',
    why:
      'Upstream step 3 names `gbrain autopilot --install`, which this product must not run in a ' +
      'container, and an exposed-token reconnect. Both are operator actions on hosts and secrets ' +
      'UpgradeContext does not hold. No step installs autopilot or unsets a key.',
  },
];

export const v0_60_28_0: PlaybookSpec = {
  version: '0.60.28.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.28.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
