import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.47.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. Frontmatter repair rewrites the user's files. The hook
 * refresh and an immediate sync are operator choices. The next scheduled sync
 * recovers a blocked source by itself; the file does not say to ask before
 * that sync. No blocksResume.
 *
 * Lane already does it (quoted, not a step): "`gbrain upgrade` runs it" and
 * "`gbrain apply-migrations --yes --no-autopilot-install`". "Restart every
 * `gbrain serve`, autopilot and worker" is the lane. "`gbrain doctor --only
 * git_held_files,frontmatter_repairable,frontmatter_hook`" is the run's doctor.
 * Our lane does not run `gbrain upgrade`.
 *
 * Numbered: 1 lane schema and restart; 2 unblock is the next sync, or sync
 * now if the operator wants it; 3 tell the user and preview the repair; 4
 * refresh the hook only as the user's earlier decision; 5 behavior changes;
 * 6 doctor is the lane, sources status is the checklist read.
 */
const UPSTREAM_SHA256 = '91a6015e3b85c6f2c8048680ee5873895ae2b1948bad8ba6cebce679c3ec7085';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v60470-held-recovery',
    prompt:
      'Read the post-upgrade `frontmatter_holds:` line. The next scheduled or manual sync recovers a ' +
      'blocked source in place (`converted_from_failed`): the broken file is held and everything else ' +
      'imports. Run `gbrain sync --source <id> --no-pull` now only if the operator wants it now. No ' +
      '`--retry-failed` and no ledger edits.',
    why:
      'Upstream step 2: "The next scheduled or manual sync recovers a blocked source automatically; ' +
      'to do it now run `gbrain sync`". The file does not say to ask before that sync. Running it ' +
      'now is optional and is not a function of UpgradeContext. No step syncs a source.',
  },
  {
    key: 'v60470-frontmatter-repair',
    prompt:
      'Tell the user what is held (`gbrain sources status <id>`). Preview `gbrain repair frontmatter ' +
      '--source <id>`. Show `--include-ambiguous --diff` before any ambiguous interpretation. Apply ' +
      'only the printed `--apply --expect <hash> --yes` after they agree. Holds with ' +
      '`ambiguous_identity_key` or `ambiguous_protected_key` are never guessed: show the line and let ' +
      'them decide. Do not retry a refused `put_page` while the newer file is held.',
    why:
      'Upstream step 3: "Never run `gbrain repair frontmatter --apply` ... without the user\'s ' +
      'agreement, and never apply an `--include-ambiguous` interpretation the user has not seen." ' +
      'Repair apply rewrites files. No step runs it.',
  },
  {
    key: 'v60470-hook-and-holds',
    prompt:
      'If doctor `frontmatter_hook` warns, or post-upgrade says an older hook is installed, mention ' +
      'it. The user installed the hook, so refreshing it carries their decision forward: ' +
      '`gbrain frontmatter install-hook --force` only after that mention. Teams that want the old ' +
      'fail-closed sync set `gbrain config set sync.holds fail` only if they ask. `gbrain frontmatter ' +
      'validate --fix` now exits 1 when errors remain.',
    why:
      'Upstream step 4: "mention it, then run `gbrain frontmatter install-hook --force`". The hook ' +
      'rewrites the user\'s repository. That is operator judgement, not a host function. Step 5\'s ' +
      '`sync.holds fail` is a config change the file does not tell us to set.',
  },
];

export const v0_60_47_0: PlaybookSpec = {
  version: '0.60.47.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.47.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
