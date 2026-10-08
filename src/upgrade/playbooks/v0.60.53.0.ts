import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.53.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. The facts drain is PGLite-only. This deployment is
 * Postgres, so that notice is checklist text, not blocksResume. Narrowing API
 * keys and take-supersession apply are grant and repair decisions.
 *
 * Lane already does it (quoted, not a step): "`gbrain upgrade` runs it" and
 * "`gbrain apply-migrations --yes --no-autopilot-install`". "Restart every
 * `gbrain serve`, autopilot and worker" is the lane. Doctor `--only` reads
 * are the run's doctor, not a second doctor step. Our lane does not run
 * `gbrain upgrade`.
 *
 * Numbered: 1 lane schema and restart; 2 tell the user about the PGLite facts
 * drain; 3 show full-access keys and do not narrow without agreement; 4
 * repairs; 5 know the new rescope options.
 */
const UPSTREAM_SHA256 = '0c43dffb7926703d024b4dbe6ed84a87b630b587c84b42c84f931f13f9c089cf';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v60530-pglite-facts-drain',
    prompt:
      'Tell the user the automatic facts drain is PGLite-only and is on by default there. Each ' +
      'extracted page is one paid chat call, capped at $1 per run and $5 per rolling day. This ' +
      'Postgres deployment does not start that drain. If a PGLite brain is in scope and the user ' +
      'does not want it, `gbrain config set facts.extraction_enabled false` only after they say so. ' +
      'Raise `facts.drain_budget_usd` or `facts.drain_daily_budget_usd` only with agreement. Do not ' +
      'set those keys from this upgrade.',
    why:
      'Upstream step 2: "Tell the user about the automatic facts drain (PGLite only)." The spec says ' +
      'this notice is checklist text, not blocksResume, on this Postgres deployment. The opt-out key ' +
      'is named and is not applied here. No declineOp, because this item does not block resume.',
  },
  {
    key: 'v60530-narrow-api-keys',
    prompt:
      'Show doctor `legacy_token_null_scope`. Each listed key can do everything, including admin. ' +
      'New admin-dashboard keys get read and write, not admin, unless the user ticks admin. Ask ' +
      'which existing keys need admin. Narrow the rest with the printed `gbrain auth rescope --id ' +
      '<token-id> --scopes read,write` only after they agree. Never narrow a key without agreement: ' +
      'an agent using it may lose access.',
    why:
      'Upstream step 3: "Never narrow a key without the user\'s agreement: an agent using it may lose ' +
      'access." A grant change is a checklist item. No step rescopes a token.',
  },
  {
    key: 'v60530-repairs-and-options',
    prompt:
      'Follow `revision_backfill`\'s printed command if doctor warns. Show the `gbrain repair ' +
      'take-supersession` preview before `--apply`. Tell the user `gbrain auth rescope --client <id> ' +
      '--sources none` and `--takes-holders` exist. Do not change a client\'s sources or takes holders ' +
      'from this upgrade.',
    why:
      'Upstream step 4: "Show the user the take-supersession preview before running it with `--apply`." ' +
      'Repair apply is a checklist item. Step 5\'s rescope flags are grant changes the file says to ' +
      'know, not to run.',
  },
];

export const v0_60_53_0: PlaybookSpec = {
  version: '0.60.53.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.53.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
