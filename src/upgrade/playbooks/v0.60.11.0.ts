import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.11.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. Host order, checkpoint reset, remediation apply, unbound
 * sources, and embed --stale are operator decisions. The post-upgrade banner
 * is preview-only and "never applies anything".
 *
 * Lane already does it (quoted, not a step): "`gbrain upgrade`" on this stack
 * is the image swap, not a playbook command. "`gbrain apply-migrations --yes
 * --no-autopilot-install`" and "`gbrain doctor --remediation-plan`" as a doctor
 * read are the lane. Our lane does not pause or resume autopilot and does not
 * apply `--remediate`.
 *
 * The file says never apply a repair without asking. It does not say resumed
 * services will apply one. No blocksResume.
 *
 * Numbered: 1 upgrade hosts in order; 2 expect one re-walk; 3 verify
 * connectors; 4 relay the banner and ask; 5 apply only what was agreed; 6
 * report what is left; 7 unbound sources; 8 other behavior changes; 9 verify.
 */
const UPSTREAM_SHA256 = '1e503113f591c5cd142b78ab4472bbdbceb890c6cbac2fbdf8aa61cd087200b8';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v60110-upgrade-order',
    prompt:
      'List every host that uses this brain. Pause autopilot on each connector host before upgrading. ' +
      'Upgrade persistence-consumer and worktree-owner hosts before connector hosts, then resume only ' +
      'the hosts you paused. Mixed versions refuse with `unsupported_mutation_protocol` or ' +
      '`connector_intent_outdated` instead of losing data. Do not change that order to force a pass.',
    why:
      'Upstream step 1: "pause autopilot first; upgrade the hosts that run the persistence consumer ' +
      'or own a worktree before the connector hosts; then resume". Our lane swaps this stack\'s ' +
      'image. Other hosts and autopilot pause are operator actions. The lane does not run ' +
      '`gbrain upgrade`.',
  },
  {
    key: 'v60110-connector-rewalk',
    prompt:
      'Tell the user to expect one connector re-walk. Writes queued before the upgrade fail once ' +
      'with `connector_intent_outdated` (detail `pre_upgrade`) and are fetched again. A source marked ' +
      'to re-walk re-admits its window once. That first spike is expected. The post-upgrade banner ' +
      'prints the count as `connector_rewalk`.',
    why:
      'Upstream step 2: "Tell the user to expect one connector re-walk, once." That is a tell-the-user ' +
      'item. Treating the spike as a failure and resetting a cursor would invent a repair.',
  },
  {
    key: 'v60110-connector-status',
    prompt:
      'Read `gbrain sources status --json`. After the second run, a quiet source shows ' +
      '`last_run.page_admissions: 0`. Run `gbrain sync --source <id> --reset-checkpoint` only if the ' +
      'user changed a content setting such as `g_history_days` since the resumed checkpoint. If a run ' +
      'refuses `connector_account_changed`, relay both branches: restore the pinned account, or add a ' +
      'new source and archive the old one. No reset flag changes the account.',
    why:
      'Upstream step 3: "if the user changed a content setting ... run `gbrain sync --source <id> ' +
      '--reset-checkpoint`". Resetting a checkpoint and choosing an account branch are operator ' +
      'decisions. No step may pick one.',
  },
  {
    key: 'v60110-remediation-ask',
    prompt:
      'When post-upgrade prints an `[AGENT] Relay this to your operator` block, show it as-is. Then ' +
      'show `gbrain doctor --remediation-plan`: each repair marked as requiring agreement, the ' +
      'estimated cost, and the combined command. Ask which kinds to apply and what spending cap they ' +
      'accept. Do not apply a repair, raise a limit, lock, unlock, or resume on their behalf.',
    why:
      'Upstream step 4: "Show the user the repair steps (each marked "requires user agreement"), ' +
      'their estimated cost, and the combined command". And the header: "Never apply a repair ... ' +
      'without asking." Post-upgrade and doctor are the lane. Applying the plan is not.',
  },
  {
    key: 'v60110-remediate-agreed',
    prompt:
      'Apply only the kinds and cap the user agreed to: `gbrain doctor --remediate --yes ' +
      '--include-repairs --expect <plan_hash> --max-usd <n>`. Pass `--no-embed` if they want no paid ' +
      'embeddings, then ask again before `gbrain embed --stale`. If the run stops budget-exhausted, ' +
      'ask again before the printed resume command.',
    why:
      'Upstream step 5: "Apply only what the user agreed to, with their cap." Repair apply and ' +
      '`embed --stale` are checklist items. The plan hash is not in UpgradeContext.',
  },
  {
    key: 'v60110-report-remaining',
    prompt:
      'Report each remaining finding and its class. For `operator_required`, relay the printed ' +
      'instruction, including quarantine commands, a host `gbrain upgrade`, or the `dream_paid_loop` ' +
      'reset. For `unsupported`, say it is known and cannot be cleared yet. Do not clear it by hand.',
    why:
      'Upstream step 6: "For `operator_required`, relay the instruction ... For `unsupported`, tell ' +
      'the user it is known and cannot be cleared yet." Relaying is tell-the-user. Inventing a clear ' +
      'would hide an unsupported finding.',
  },
  {
    key: 'v60110-unbound-source',
    prompt:
      'For a Postgres source with a checkout folder but no owner, ask which fix the user wants. Do ' +
      'not pick. Either bind it with the printed writer claim, or allow database-only saves with ' +
      '`gbrain config set persistence.unbound_write database_only`. When a canonical file later ' +
      'appears, preview both sides and apply only the resolution the user chose.',
    why:
      'Upstream step 7: "Ask the user which fix they want; do not pick for them." Binding a writer ' +
      'or setting `persistence.unbound_write` is a config and topology decision, not a step.',
  },
  {
    key: 'v60110-behavior-changes',
    prompt:
      'Tell the user: global maintenance keeps running when one phase fails and `gbrain dream` then ' +
      'exits non-zero; an all-zero embedding chunk is refused with `embedding_zero_norm`; ' +
      '`gbrain migrate embeddings` stops before changing anything when the cap is below the worst ' +
      'case. Rerun that migration only with agreement. If the user saw an in-place PGLite WAL repair ' +
      'message, `gbrain reindex --vectors` is free and re-embeds nothing. Writer lock and unlock are ' +
      'optional and only if the user asks.',
    why:
      'Upstream step 8: "Rerun only with the user\'s agreement." The optional lock is "only if the ' +
      'user asks". Those are tell-the-user and paid-repair decisions. No step runs them.',
  },
];

export const v0_60_11_0: PlaybookSpec = {
  version: '0.60.11.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.11.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
