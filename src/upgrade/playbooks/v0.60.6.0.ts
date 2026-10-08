import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.6.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. Pruning timeline orphans and settling slug collisions
 * rewrite user data and need agreement. Changing the dream budget is opt-in.
 *
 * Lane already does it (quoted, not a step): "`gbrain --version`" and, if
 * doctor reports a partial migration, "`gbrain apply-migrations --yes
 * --no-autopilot-install`". "`gbrain doctor --json`" is the run's doctor.
 * "Do not change the operator's search mode or engine."
 *
 * The new $5 dream-synthesis cap is a ceiling, not a paid default the file
 * says to ask about before the next maintenance run. "Only change it when the
 * user asks." No blocksResume.
 *
 * Numbered: 1 lane version and schema; 2 tell the user about fact expiry and
 * the dream budget; 3 relay the two new doctor checks; 4 prune orphans only
 * after agreement; 5 settle slug collisions; 6 verify.
 */
const UPSTREAM_SHA256 = '1cbfca2c899e1348acbd61f0baa4c8e723b5283ff868c710c74e116c0cb6726e';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v6060-behavior-changes',
    prompt:
      'Tell the user two behavior changes. v174 expires an active fact that differs from a forgotten ' +
      'fact only by case, spacing, or sentence punctuation. Dream synthesis now stops at $5 per run ' +
      '(`dream.synthesize.budget_usd`); a transcript that does not fit is deferred, not dropped. ' +
      'Change that cap only when the user asks (`gbrain config set dream.synthesize.budget_usd 20`).',
    why:
      'Upstream step 2: "Tell the user about two upgrade-time behavior changes" and "Only change it ' +
      'when the user asks". Telling the user is a checklist item. Setting the budget would change an ' +
      'operator default the file leaves alone.',
  },
  {
    key: 'v6060-relay-doctor',
    prompt:
      'Relay a full doctor pass, not `--fast`. `timeline_orphans` counts rows an earlier stored ' +
      'version produced that the current text no longer has. `slug_collisions` names files that map ' +
      'to the same page slug. Both checks are read-only until the user agrees to a cleanup.',
    why:
      'Upstream step 3: "Run one full doctor pass (not `--fast`) and look for the two new checks." ' +
      'Doctor is the lane. Relaying the two checks and not treating them as automatic repairs is the ' +
      'operator\'s reading.',
  },
  {
    key: 'v6060-prune-orphans',
    prompt:
      'Preview `gbrain extract timeline --prune-orphans --dry-run` and show the count and example ' +
      'rows. Remove them only after the user agrees. Do not try to restore those rows with ' +
      '`gbrain repair timeline`. The command calls no model provider and is safe to rerun.',
    why:
      'Upstream step 4: "Preview the orphaned timeline rows, then prune them after the user agrees." ' +
      'Pruning is a repair. A step that ran it without agreement would invent the approval.',
  },
  {
    key: 'v6060-slug-collisions',
    prompt:
      'For every `slug_collisions` group, ask which file should keep the page. Rename the others so ' +
      'each maps to its own slug, commit, then `gbrain sync --source <id> --no-pull`. Do not delete ' +
      'or merge the user\'s files yourself.',
    why:
      'Upstream step 5: "ask which file should keep the page" and "Do not delete or merge the user\'s ' +
      'files on your own; renaming is their decision." That is operator judgement, not a step.',
  },
  {
    key: 'v6060-verify-cleanup',
    prompt:
      'After any agreed cleanup, confirm the dry-run would remove 0 orphan rows and that doctor ' +
      'reports `timeline_orphans` and `slug_collisions` ok. If a step fails, keep the doctor output ' +
      'and the dry-run JSON. Do not delete timeline rows, pages, or files by hand to clear a warning.',
    why:
      'Upstream step 6 and the close: "do not delete timeline rows, pages or files by hand to make a ' +
      'warning disappear." Doctor is the lane. Hand-deletion is the destructive act a step must not take.',
  },
];

export const v0_60_6_0: PlaybookSpec = {
  version: '0.60.6.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.6.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
