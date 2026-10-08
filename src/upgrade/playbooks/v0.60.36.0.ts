import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.36.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. Exit-10 handling, token rescope, embed, and link re-derive
 * are tell-the-user, grant, or paid decisions.
 *
 * Lane already does it (quoted, not a step): "`gbrain upgrade` runs it" and
 * "`gbrain apply-migrations --yes --no-autopilot-install`". "`gbrain doctor`"
 * is the run. The verify `gbrain remember` write is not a lane step and is not
 * invented here.
 *
 * Takes are now embedded by the cycle's embed phase, and two dream/atom
 * defaults call models. The file says ask before `gbrain embed --stale` and
 * names the opt-out keys. It does not say to ask before the next maintenance
 * run. Those items do not block writer resume. No declineOp is attached,
 * because a declineOp is applied only to settle a blocksResume item.
 *
 * Numbered: 1 lane schema, plus revision_backfill_pending; 2 exit 10; 3 legacy
 * token grants; 4 ask before embedding takes; 5 know the other paid defaults;
 * 6 doctor warnings; 7 re-derive link types if relied on; 8 verify; 9 file an
 * issue if a step fails.
 */
const UPSTREAM_SHA256 = '8ce9aba221d24dec7f354b41c04d59fcbe947e9302a038e87e0ba807086c7ed7';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v60360-revision-backfill',
    prompt:
      'A brain created before v150 backfills page revisions in batches. Until a page\'s revision is ' +
      'backfilled, a write that names a revision for it is refused with `revision_backfill_pending`. ' +
      'Tell the user. Do not resubmit those writes with a new request id to skip the wait.',
    why:
      'Upstream step 1: "Until a page\'s revision is backfilled, a write that names a revision for it ' +
      'is refused with `revision_backfill_pending`." Apply-migrations is the lane. Treating the ' +
      'refusal as a failure to repair would invent a write.',
  },
  {
    key: 'v60360-exit-10',
    prompt:
      'Tell script owners that a CLI write accepted but not committed when the wait ends now exits ' +
      '10 and prints its receipt. Exit 0 is committed. Exit 1 is failed. Do not resubmit a pending ' +
      'write with a new request id. Replay the same `request_id`, or poll `get_write_request`. ' +
      '`--accept-pending` or `GBRAIN_ACCEPT_PENDING=1` is their choice, not this upgrade\'s.',
    why:
      'Upstream step 2: "Do not resubmit a pending write with a new request id." That is a ' +
      'tell-the-user instruction for scripts this repo does not rewrite. Inventing a resubmit would ' +
      'violate the file.',
  },
  {
    key: 'v60360-rescope-tokens',
    prompt:
      'A legacy bearer token whose stored `source_id` is an explicit empty list used to fall back to ' +
      '`default` and is now refused. Regrant with `gbrain auth rescope-token` only when the user ' +
      'agrees. Preview `--refresh-operations` and widen only by name. Do not add operations the ' +
      'rotation withheld.',
    why:
      'Upstream step 3: "Regrant explicitly when the user agrees" and "widen only by name". A grant ' +
      'change is a checklist item. No step rescopes a token.',
  },
  {
    key: 'v60360-take-embed-and-defaults',
    prompt:
      'Tell the user takes are now embedded with pages by `gbrain embed --stale` and the cycle\'s ' +
      'embed phase, and existing take vectors are re-embedded once. That can cost money. Doctor ' +
      '`fact_take_vectors` counts what is missing. Ask before `gbrain embed --stale`. The opt-out is ' +
      '`gbrain config set takes.auto_embed false`. Also tell them dream reads imported ' +
      '`type: conversation` pages when a corpus directory is set (`dream.synthesize.conversation_pages ' +
      'false` turns it off) and connector atom extraction is on again ' +
      '(`cycle.extract_atoms.connector_pages false`). Do not set those keys from this upgrade.',
    why:
      'Upstream steps 4 and 5: "Ask before embedding takes" and "Both call the configured models." ' +
      'The file names the opt-out keys and does not say to ask before the next maintenance run, so ' +
      'this item does not set blocksResume and does not invent a declineOp. Setting the keys would ' +
      'change operator defaults.',
  },
  {
    key: 'v60360-doctor-and-links',
    prompt:
      'Expect some doctor checks to warn "not verified", `sync_freshness` to say "upstream unknown", ' +
      'and `auto_chronicle` to say `auto_chronicle=true` has no effect yet. Each warning names its ' +
      'fix. Do not treat a new warning as a regression to repair. Re-derive markdown link types with ' +
      '`gbrain extract links --source db` only if you rely on them. If a step fails, file an issue ' +
      'with `gbrain doctor` and `~/.gbrain/upgrade-errors.jsonl` if it exists. Do not write a probe ' +
      '`gbrain remember` from this playbook.',
    why:
      'Upstream steps 6 through 9: "Expect some doctor checks to turn yellow" and "To redo existing ' +
      'links: `gbrain extract links --source db`." Doctor is the lane. Re-deriving links and filing ' +
      'an issue are operator actions. The remember probe is a write this playbook does not invent.',
  },
];

export const v0_60_36_0: PlaybookSpec = {
  version: '0.60.36.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.36.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
