import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.102.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. The first maintenance run rewrites the user's files. What
 * it will change, and whether to pause it, is operator judgement.
 * UpgradeContext has no fence preview.
 *
 * Lane already does it (quoted, not a step): "`gbrain upgrade` runs it" and
 * "`gbrain apply-migrations --yes --no-autopilot-install`". "No schema
 * migration and no rows are rewritten by the upgrade itself." "Restart every
 * `gbrain serve`, autopilot and worker so the maintenance run picks up the
 * `fence_repair` phase" is the lane's restart. The hold below is why that
 * restart does not start the phase before the ask. "`gbrain doctor --only
 * fence_integrity,git_held_files`" is the run's doctor. Our lane does not run
 * `gbrain upgrade` or `gbrain repair fences --apply`.
 *
 * blocksResume: the header says tell the user what the first maintenance run
 * will change before it runs. Resumed scheduler would start `fence_repair`.
 * declineOp is the file's pause: `config.set` of `fences.repair.enabled` to
 * `false`. Inline sync rewrites are the v0.60.99.0 decision
 * (`fences.normalize`), not a second key invented here. Acknowledging lets
 * the maintenance run repair. Declining pauses it.
 *
 * Numbered: 1 lane schema and restart; 2 tell the user before the maintenance
 * run; 3 spend and what leaves the machine; 4 what stays held; 5 inspect or
 * undo; 6 which steps need the user (quoted here: repairs need no extra
 * consent, pausing is their choice, caps and manual edits and undoing are
 * their calls, relay behavior_changes); 7 doctor is the lane.
 */
const UPSTREAM_SHA256 = 'be46986da0334071931b5a285a532335af92e50dee6559899ea07bb9cd03615e';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v601020-fence-repair',
    prompt:
      'Before writers resume, tell the user what the first maintenance run rewrites. It repairs every ' +
      'malformed fence it finds, rewriting those files and committing each one. A legacy source\'s ' +
      'files are backed up and left for the user to commit. Show `gbrain doctor --only fence_integrity` ' +
      'and `gbrain repair fences --source <id>` (preview, no model call). Acknowledge to let that run ' +
      'proceed. Decline applies `gbrain config set fences.repair.enabled false`. After a decline, ' +
      'apply only what they approve with the preview\'s printed `--apply --expect <hash>`, then resume ' +
      'with `gbrain config set fences.repair.enabled true` if they want the phase back. Inline sync ' +
      'rewrites are decided by the v0.60.99.0 item (`fences.normalize`), not by this pause.',
    why:
      'Upstream step 2: "tell the user what the first maintenance run will change (step 2) before it ' +
      'runs". And "If the user wants to review before anything is rewritten, pause the automatic ' +
      'repair first: `gbrain config set fences.repair.enabled false`". Resumed maintenance would start ' +
      'that rewrite. The pause is allowlisted `config.set`. No other key is invented.',
    blocksResume: true,
    declineOp: { op: 'config.set', params: { key: 'fences.repair.enabled', value: 'false' } },
  },
  {
    key: 'v601020-model-spend',
    prompt:
      'Tell the user most repairs are free rules. A fence only a rewrite can realign goes to the ' +
      'repair model: only the fence header and the rows it must realign are sent. With ' +
      '`models.fence_repair` unset, the model is `openai:gpt-6.1-sol` if an OpenAI key is present, ' +
      'else `anthropic:claude-opus-5-5` if an Anthropic key is present, else model repair stays off. ' +
      'Spend is capped at $0.30 per page and $1.00 per UTC day. To keep fence rows away from the ' +
      'model, `gbrain config set fences.repair.llm false`. Raising a cap, turning model repair back ' +
      'on, choosing `models.fence_repair`, or registering a price is the user\'s call. Do not set ' +
      'those keys from this upgrade.',
    why:
      'Upstream step 3: "leave spend decisions to them" and "Raising a cap or turning model repair ' +
      'back on is the user\'s call." Those config keys are named. They are not this item\'s declineOp: ' +
      'the hold is the maintenance-run pause, which is `fences.repair.enabled`. Setting the spend ' +
      'keys here would invent a second opt-out.',
  },
  {
    key: 'v601020-manual-and-undo',
    prompt:
      'Tell the user what stays held. A `manual` hold is something gbrain never guesses. Show the ' +
      'location, edit only that fence, commit, then sync. A `budget_exhausted` hold resumes after ' +
      '00:00 UTC. To undo a managed repair, `git revert` the `gbrain: repair fence in` commit, or ' +
      'restore a database-only page from `gbrain history` / `gbrain revert`. A legacy original is ' +
      'under `~/.gbrain/backups/`. Turning the settings off does not undo past repairs. Pause ' +
      '`fences.repair.enabled` first if the user wants to keep a restored original. Relay ' +
      '`behavior_changes` when doctor prints it.',
    why:
      'Upstream steps 4 through 6: "Tell the user what stays held" and "undoing a repair" and "the ' +
      'content of every `manual` edit ... are the user\'s calls." Editing and reverting are operator ' +
      'decisions. No step reverts a commit or writes a fence. Doctor is the lane.',
  },
];

export const v0_60_102_0: PlaybookSpec = {
  version: '0.60.102.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.102.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
