import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.62.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. The first mention pass is free and resumable. Without it,
 * autopilot cycles do the same work. The file does not say to ask before that
 * work. Turning linking off is a config change and needs a question. No
 * blocksResume.
 *
 * Lane already does it (quoted, not a step): "`gbrain upgrade` runs it" and
 * "`gbrain apply-migrations --yes --no-autopilot-install`". "Restart every
 * `gbrain serve`, autopilot and worker" is the lane. Our lane does not run
 * `gbrain upgrade`. Migration v206 adds columns and empty tables; it rewrites
 * no existing row.
 *
 * Numbered: 1 lane schema and restart; 2 run the mention pass now or let
 * autopilot do it; 3 verify; 4 off switch only if asked or a name links
 * wrongly; 5 behavior changes.
 */
const UPSTREAM_SHA256 = 'e91c9b8caee58f6cfa519177ba2b0625b73cf26756a28a451003d78646a5eacf';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v60620-mention-pass',
    prompt:
      'Post-upgrade prints an [AGENT] line with the page count while mention pages are due. ' +
      '`gbrain extract --stale --catch-up` is free and resumable. Without it, autopilot cycles do ' +
      'the same work and entity cards report `coverage.state: "pending"` until then. Run it now only ' +
      'if the operator wants it now. Verify with `gbrain extract --stale --dry-run --json` ' +
      '(`mention_due_pages: 0`) and `gbrain entity` for a known name. Do not treat pending coverage ' +
      'as a failed upgrade.',
    why:
      'Upstream step 2: "Without it, autopilot cycles do the same work over several runs". The pass ' +
      'is free and the file does not say to ask before it. Running it immediately is optional. A ' +
      'step that shelled out to extract would invent a host command UpgradeContext does not provide.',
  },
  {
    key: 'v60620-mention-off-switch',
    prompt:
      'Tell the user about the off switch only if they ask, or if a name links wrongly. ' +
      '`gbrain extract mentions --explain <name> --page <slug>` says why. A wrong link is fixed by ' +
      '`mentions.ignore` or frontmatter `mention_ignore`. `gbrain config set mentions.auto_link false` ' +
      'turns linking off and removes mention links on the next sweep. Ask before setting it. Do not ' +
      'set it from this upgrade.',
    why:
      'Upstream step 4: "Tell the user about the off switch only if they ask, or if a name links ' +
      'wrongly" and "These change the user\'s brain: ask before setting them." That config change is ' +
      'operator judgement. No step sets `mentions.auto_link`.',
  },
];

export const v0_60_62_0: PlaybookSpec = {
  version: '0.60.62.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.62.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
