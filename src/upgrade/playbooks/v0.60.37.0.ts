import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.37.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. PGLite auto-analyze does not apply to this Postgres
 * deployment. Legacy grant migration, seat naming, and embed catch-up are
 * operator actions. The file says the legacy rescope changes no effective
 * grant, but also "tell them it ran". Running it is not a function of
 * UpgradeContext, and grant-shaped commands stay checklist items.
 *
 * Lane already does it (quoted, not a step): "`gbrain upgrade` runs it" and
 * "`gbrain apply-migrations --yes --no-autopilot-install`". "Restart every
 * `gbrain serve`, autopilot and worker" is the lane. "`gbrain doctor`" is the
 * run. Our lane does not run `gbrain upgrade`.
 *
 * Numbered: 1 lane schema and restart; 2 PGLite auto-analyze, checklist not
 * blocksResume; 3 new commands, including tell-them-it-ran for legacy tokens;
 * 4 name seats; 5 exit 11 and embed catch-up; 6 long syncs; 7 health memo;
 * 8 verify attribution, not a probe write invented here.
 */
const UPSTREAM_SHA256 = 'e0e9d8ab0adb14cfb55d67f821614f25e0ab2f6281a1a1bfc10faefc95312015';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v60370-pglite-analyze',
    prompt:
      'This deployment is Postgres. PGLite auto-analyze does not run here. If a PGLite brain is in ' +
      'scope, tell the user import, sync, the cycle, and the first read after a big write may pause ' +
      'to analyze. Doctor `planner_stats_stale` names stale tables. `gbrain repair planner-stats ' +
      '--apply` is free. Opt out only if they ask: `gbrain config set planner.auto_analyze false`.',
    why:
      'Upstream step 2 is "Know that PGLite now analyzes itself." On this Postgres deployment that ' +
      'is checklist text, not blocksResume, matching the PGLite-only rule. No step sets the opt-out.',
  },
  {
    key: 'v60370-legacy-grant-shape',
    prompt:
      'Tell the user `gbrain auth rescope --migrate-legacy` writes unified grant columns and changes ' +
      'no effective grant. Tokens otherwise migrate on their next grant change. Do not run it from ' +
      'this playbook. If doctor `legacy_token_grant_drift` says an older gbrain edited a migrated ' +
      'token, ask which grant is right, then `--adopt-permissions` or `--adopt-columns`. Do not pick.',
    why:
      'Upstream step 3: "It changes no effective grant, so it does not need the user\'s agreement, but ' +
      'tell them it ran." And "ask the user which grant is right". Telling them is the checklist ' +
      'item. Choosing a grant is operator judgement. No step runs rescope.',
  },
  {
    key: 'v60370-seats-and-embed',
    prompt:
      'Captured sessions record a seat. Give this agent a readable name with `gbrain bootstrap hooks ' +
      '--seat <label>` only if the user wants one. `--seat off` or `GBRAIN_SEAT=off` opts out. A ' +
      '`gbrain embed --stale` run that stops at its 30-minute budget now exits 11. Treat 11 as ' +
      'partial. Ask before `gbrain embed --stale --catch-up`. Doctor `embeddings` shows the backlog ' +
      'and says "not applicable" on a keyless brain.',
    why:
      'Upstream steps 4 and 5: "Never run `gbrain auth rescope` with a grant flag or `gbrain embed ' +
      '--stale --catch-up` on the user\'s behalf without asking." Seat naming and paid catch-up are ' +
      'checklist items. No step spends or renames a seat.',
  },
  {
    key: 'v60370-sync-and-health',
    prompt:
      'Tell the user a sync under its deadline keeps going while it makes progress and stops only ' +
      'after `GBRAIN_SYNC_STALL_ABORT_SECONDS` (900) without progress. `--hard-deadline` and ' +
      '`--timeout` stay strict. Repeat `get_health` calls within 30 seconds with no page or config ' +
      'change return memoized counters. `gbrain config set health.cache_ttl_ms 0` turns that off, ' +
      'only if the user asks. Doctor always reads fresh. If a step fails, file an issue with doctor ' +
      'output. Do not invent an attribution probe write.',
    why:
      'Upstream steps 6 through 8 are "Know about" and "Expect" instructions. Changing the health ' +
      'cache is a config default. The attribution verify is an operator read of a page written after ' +
      'the upgrade, not a step this playbook can perform.',
  },
];

export const v0_60_37_0: PlaybookSpec = {
  version: '0.60.37.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.37.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
