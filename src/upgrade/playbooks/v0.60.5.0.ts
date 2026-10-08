import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.5.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. Backup confirmation, loss disclosure, doctor-signal
 * repairs, and `gbrain repair --apply` are operator decisions. `embed --stale`
 * is paid. None of them is a function of UpgradeContext.
 *
 * Lane already does it (quoted, not a step): "If schema work did not complete,
 * run `gbrain apply-migrations --yes --no-autopilot-install`". "`gbrain doctor
 * --json`" and restart of this stack's writers are the run. Our lane does not
 * run `gbrain upgrade` on other machines. The file does not say to ask before
 * the next sync or before a paid default our resumed services would start:
 * repairs stay dry-run until `--apply`. No blocksResume.
 *
 * Numbered: 1 ask about a database backup; 2 upgrade every writer; 3 tell the
 * user what was lost; 4 relay doctor signals and do not reset a dream key;
 * 5 preview repairs, then apply only with agreement; 6 tell the user what
 * changes; 7 verify after repairs.
 */
const UPSTREAM_SHA256 = '0d3ee19359a2740de08ac9ec388ddc15e7c72d663afe33832e1e54170528acab';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v6050-confirm-backup',
    prompt:
      'Ask whether a recent backup of the database itself exists: `pg_dump` for Postgres, or a ' +
      'PGLite data-directory copy made while gbrain was stopped. A Markdown export does not include ' +
      'database-only timeline entries. If there is no backup, say so and recommend making one. Do ' +
      'not make it for them without asking.',
    why:
      'Upstream step 1: "Ask the user whether they have a recent backup of the database itself" and ' +
      '"Do not make it for them without asking." The run\'s snapshot is the lane\'s backup. Attesting ' +
      'that it covers database-only timeline entries is the operator\'s.',
  },
  {
    key: 'v6050-every-writer',
    prompt:
      'List every process that writes this brain with the user: `gbrain serve`, autopilot and job ' +
      'supervisors, session hooks, and any other machine or global CLI install. Each must be on ' +
      '0.60.5.0 or newer and restarted. An older process keeps deleting database-only timeline ' +
      'history when it republishes a page. Do not change the operator\'s search mode or engine.',
    why:
      'Upstream step 2: "An older gbrain process keeps deleting database-only timeline history every ' +
      'time it republishes a page." Our image swap covers this stack. Other installs are operator ' +
      'judgement. Apply-migrations is the lane.',
  },
  {
    key: 'v6050-timeline-loss',
    prompt:
      'Tell the user, plainly, that timeline entries with no Markdown bullet may be gone if pages ' +
      'were edited, synced, imported, reconciled, or refreshed by a connector while an older writer ' +
      'ran. This release cannot restore them. Do not promise recovery without a database backup taken ' +
      'before the loss.',
    why:
      'Upstream step 3: "Tell the user what was lost, plainly." And "Do not promise recovery without ' +
      'one." That disclosure is a checklist item. A step cannot know whether those edits happened.',
  },
  {
    key: 'v6050-relay-doctor',
    prompt:
      'Relay a full (not `--fast`) doctor pass. Show `timeline_history`, `derived_visibility`, ' +
      '`contextual_retrieval_coverage`, `persistence_capacity`, `parked_effects`, and `dream_paid_loop`. ' +
      'Raise a persistence limit only after the user agrees. Do not reset a dream key yourself: the ' +
      'operator fixes why the jobs die, then runs `gbrain dream reset-key`. Preview parked effects ' +
      'before authorizing one more attempt.',
    why:
      'Upstream step 4: "Do not reset a key on your own" and "Run the `gbrain config set ' +
      'persistence.limits.<key> <value>` command the check prints ... after the user agrees." Doctor ' +
      'is the lane. The repairs and the limit raise are operator decisions.',
  },
  {
    key: 'v6050-repair-apply',
    prompt:
      'Preview `gbrain repair` and show the pages, request-id cost, and any embedding estimate. ' +
      'Apply `timeline`, `visibility`, or `safe-chunks` only after the user agrees. Ask before ' +
      'raising a journal limit. Ask before `gbrain embed --stale`. A thin client cannot run repair; ' +
      'the brain-host operator does.',
    why:
      'Upstream step 5: "Show the user the preview first" and "With `--no-embed`, run `gbrain embed ' +
      '--stale` later (ask the user first; it calls the embedding provider)." Repair `--apply` and ' +
      'paid embed are checklist items, not steps.',
  },
  {
    key: 'v6050-behavior-changes',
    prompt:
      'Tell the user about materialized timeline bullets, `take_row_collision`, private atoms, the ' +
      'named write-refusal codes, and that `persistence.receipt_retention_days` changes only when ' +
      'they ask. Do not set `search.remote_private_pages` to restore remote access. A stuck ' +
      'claude.ai connector needs to be removed and re-added; a looping ChatGPT connector needs to ' +
      'be reconnected. Do not delete receipts, counters, effect rows, or dead jobs to clear a warning.',
    why:
      'Upstream step 6: "Do not set `search.remote_private_pages` to restore remote access; that ' +
      'exposes every private page." And "Only change it when the user asks." Those are tell-the-user ' +
      'and config decisions. No step sets them.',
  },
];

export const v0_60_5_0: PlaybookSpec = {
  version: '0.60.5.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.5.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
