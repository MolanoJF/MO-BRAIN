import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.51.0.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. Nothing numbered is a deterministic function of
 * UpgradeContext. A run body would invent a writer claim, an activation, or
 * a grant change.
 *
 * Lane already does it (quoted, not a step): "Upgrade the host binary and
 * first-party clients using their existing installation method." Our image
 * swap is that path. "`gbrain apply-migrations --yes`" is the run's schema
 * step. "If upgrading from before v0.50.5.0, also follow that release's
 * security upgrade instructions" is the 0.50.5.0 noPlaybookRequired row, not
 * a second upgrade command.
 *
 * Numbered imperatives: 1 inventory and stop writers; 2 verify backups; 3
 * record grants and do not broaden them. The unnumbered claim, activate,
 * receipt-rescope, and rollback paragraphs are separate operator decisions
 * and are checklist items, not steps.
 */
const UPSTREAM_SHA256 = 'c1f1f6ddcea71cdcfb4d9a85200564b59cc64e7d2ec29fda8c98335a8a7afdd5';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v5100-inventory-writers',
    prompt:
      'Inventory HTTP and stdio servers, CLIs, sync workers, maintenance jobs, connectors, and ' +
      'external file editors on every host. Confirm older writers are stopped and in-flight work ' +
      'has settled. An unreachable owner needs external fencing before a verified transfer; a stale ' +
      'heartbeat is not enough.',
    why:
      'Upstream step 1: "Stop older writers and wait for in-flight work to settle. An unreachable ' +
      'owner needs external fencing before a verified transfer; a stale heartbeat is insufficient." ' +
      'Our quiesce stops this stack only. Deciding that every other host is fenced is operator ' +
      'judgement, not a function of UpgradeContext.',
  },
  {
    key: 'v5100-verify-backups',
    prompt:
      'Confirm restorable backups of the canonical worktrees, including private and gitignored ' +
      'files, and of the database. Keep them until post-upgrade verification succeeds. Withdrawal ' +
      'decisions, receipts, registrations, credentials, and intentional DB-only knowledge cannot be ' +
      'rebuilt from Markdown.',
    why:
      'Upstream step 2: "Verify restorable backups of canonical worktrees, including private/' +
      'gitignored files, and the database." The run\'s snapshot is the lane\'s backup. Whether it ' +
      'covers private files and DB-only knowledge on this install is a human attestation.',
  },
  {
    key: 'v5100-record-grants',
    prompt:
      'Record `gbrain sources list --json`, current operation/source/slug grants, and writer ' +
      'status. Keep credentials private. Confirm revoked registrations were not replaced and grants ' +
      'were not broadened to make the upgrade pass.',
    why:
      'Upstream step 3: "Do not replace revoked registrations or broaden grants to make an upgrade ' +
      'pass." A grant change is operator judgement. No step may widen access.',
  },
  {
    key: 'v5100-writer-claim',
    prompt:
      'On the designated publishing host, claim each configured filesystem source with its actual ' +
      'local path, `--admin-intent writer_claim`, and the `admin_state` fingerprint from reviewed ' +
      'writer status. Inspect again after every change. Do not activate, and do not refresh a stale ' +
      'fingerprint to dismiss a refusal.',
    why:
      'The file says "Retain the `admin_state` fingerprint from reviewed writer status" and "A stale ' +
      'fingerprint refuses rather than applying to changed topology." Choosing the path and the ' +
      'reviewed state is operator judgement. The claim is not a host function of UpgradeContext.',
  },
  {
    key: 'v5100-writer-activate',
    prompt:
      'Preview `gbrain sources writer activate --confirm-quiesced --dry-run --json`. Activate only ' +
      'after every owner is verified, with `--admin-intent writer_activate` and the reviewed ' +
      'expected state. A TTY and generic `--yes` are not authorization. Do not delete a live ' +
      'coordination file or edit SQL to bypass a refusal.',
    why:
      'Upstream: "The confirmation flag asserts that older binaries, external editors and maintenance ' +
      'writers are quiesced on every host." That attestation is the operator\'s. Editing SQL to bypass ' +
      'a refusal is forbidden here (G3) and is not a step.',
  },
  {
    key: 'v5100-receipt-grants',
    prompt:
      'Verify one committed write at its returned revision, including content, tags, and the ' +
      'receipt. If a caller needs `get_write_request`, `list_write_requests`, or `cancel_write_request`, ' +
      'preview a complete replacement operation list that preserves existing grants, then apply it ' +
      'with `auth rescope-client --if-version` using the observed revision. Do not widen older saved ' +
      'operation snapshots.',
    why:
      'Upstream: "New grants include receipt tools. Older saved operation snapshots do not widen." ' +
      'Rescoping a client is a grant change. The file says to follow the receipt-grant example only ' +
      'after a preview. That is operator judgement, not a step.',
  },
  {
    key: 'v5100-rollback-boundary',
    prompt:
      'Confirm rollback to old writers is still available only if managed activation and accepted ' +
      'managed writes have not happened. Afterwards use forward repair, or a fully drained downgrade ' +
      'with verified canonical state. Do not infer a safe rollback from a lost response, and do not ' +
      'overwrite an unexpected file change speculatively.',
    why:
      'Upstream: "Rollback to old writers is supported only before managed activation and accepted ' +
      'managed writes." Whether this database has crossed that line is not in UpgradeContext. ' +
      'Guessing a rollback would invent a destructive step.',
  },
];

export const v0_51_0_0: PlaybookSpec = {
  version: '0.51.0.0',
  upstreamSkill: { path: 'skills/migrations/v0.51.0.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
