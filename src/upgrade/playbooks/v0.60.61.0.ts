import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.61.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. Queued paid jobs from before the upgrade run as
 * `legacy_default` under a $5 cap. The file says tell the user and cancel
 * only with agreement. It does not say to ask before the worker claims them.
 * The default is that they run. No blocksResume.
 *
 * Lane already does it (quoted, not a step): "`gbrain upgrade` runs it" and
 * "`gbrain apply-migrations --yes --no-autopilot-install`". "Restart every
 * worker, `gbrain serve` and autopilot" is the lane. "`gbrain doctor --only
 * legacy_job_authority`" is the run's doctor. Our lane does not run
 * `gbrain upgrade`.
 *
 * Numbered: 1 lane schema; 2 restart is the lane; 3 tell the user about
 * queued paid jobs; 4 expect consent prompts; 5 starter surface; 6 HTTP
 * status-only mode.
 */
const UPSTREAM_SHA256 = '7071a52b954f42d18bcf73e115926ba77025e0fc35640ba84d2eb5d048105af7';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v60610-legacy-queued-jobs',
    prompt:
      'Tell the user a `book-mirror` or `enrich` job queued before this release runs as ' +
      '`legacy_default` under a $5 cap (enrich: its own `--max-usd` when set). A chapter on an ' +
      'expensive model can stop with `derived_cap_exhausted`; rerunning skips completed chapters. ' +
      'List them with `gbrain jobs list --json`. Cancel a group only with agreement: ' +
      '`gbrain jobs cancel --group <id>`. Rolling the binary back leaves spend-authorized jobs ' +
      'unclaimable; cancel them first if rolling back.',
    why:
      'Upstream step 3: "Tell the user about queued paid jobs from before the upgrade" and "Cancel a ' +
      'group only with the user\'s agreement". The file says those jobs run. It does not say to ask ' +
      'before the worker claims them, so this item does not block resume. Cancelling is a checklist ' +
      'decision, not a step.',
  },
  {
    key: 'v60610-consent-and-surface',
    prompt:
      'Expect `gbrain enrich --background` and `gbrain jobs submit enrich|subagent` to exit 3 with a ' +
      'consent payload unless the user already authorized the spend. Relay the estimate and rerun ' +
      '`fix.argv` only after they agree. New stdio registrations pin `--surface starter`. Existing ' +
      'registrations keep their surface. A hidden tool is requested with `request_tools` ' +
      '`{ "surface": "full" }` unless `mcp.allow_session_widen=false`. Do not widen a registration ' +
      'from this upgrade.',
    why:
      'Upstream steps 4 and 5: "Relay the estimate to the user and rerun `fix.argv` after they agree." ' +
      'Consent and a surface change are operator decisions. No step queues paid work or widens tools.',
  },
  {
    key: 'v60610-http-status-mode',
    prompt:
      'Tell the user a `gbrain serve --http` that cannot open its brain stays up and answers ' +
      '`/health` with 503 and `Retry-After: 5`, then recovers on the same port. Container health ' +
      'checks that need the old exit use `--fail-fast` or `GBRAIN_SERVE_FAIL_FAST=1`. After recovery, ' +
      'clients re-list tools or reconnect. Do not treat "HTTP listens" as "the brain is up".',
    why:
      'Upstream step 6: "A `gbrain serve --http` whose brain is locked, missing or unconfigured ' +
      'answers `/health` with 503". That is tell-the-user. Changing this stack\'s health probe is not ' +
      'a playbook step and is not invented here.',
  },
];

export const v0_60_61_0: PlaybookSpec = {
  version: '0.60.61.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.61.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
