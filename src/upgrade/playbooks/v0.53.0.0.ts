import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.53.0.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. Shared-skill activation, DB-only export, grant changes,
 * and client reconnect are operator decisions. The lock-table SELECT is G3.
 *
 * Lane already does it (quoted, not a step): "`gbrain apply-migrations
 * --dry-run --json`" is inspection the operator reads; the run's schema step
 * is `apply-migrations`, not a second playbook call. "`gbrain apply-migrations
 * --migration 0.53.0 --yes`" is that same lane, not a step that may also pass
 * `--acknowledge-no-backup`. Restart is the lane.
 *
 * Numbered sections: 1 inventory and backup; 2 stop writers and activate the
 * host protocol; 3 DB-only export; 4 adoption and consent; 5 reconnect each
 * client; 6 verify and keep rollback honest.
 */
const UPSTREAM_SHA256 = '14440e9aa189d2f751fcd7aa0077b95156d85b145ba04111520d69bf4b9f76e4';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v5300-inventory-and-backup',
    prompt:
      'Read `gbrain apply-migrations --dry-run --json` (`database`, `plan`, `previews`). A preview ' +
      'error is not an empty inventory. Back up canonical files and operational database state, and ' +
      'verify recovery before calling the backups protected. Do not open a running PGLite owner from ' +
      'a second process. If a source reports `Files changed since migration inventory`, show the ' +
      'listed paths and accept them only with agreement, using the printed `--accept-reviewed-inventory` ' +
      'command. Never delete the checkpoint by hand.',
    why:
      'Upstream section 1: "If a source reports `Files changed since migration inventory`, show the ' +
      'user the listed paths. Accept them only with their agreement". Accepting changed files is ' +
      'operator judgement. The dry-run is not a step this playbook runs.',
  },
  {
    key: 'v5300-shared-skills-activation',
    prompt:
      'Stop old servers, workers, sync jobs, and direct filesystem writers. Drain outstanding ' +
      'durable writes. Claim each existing canonical root only with the reviewed `--admin-intent` and ' +
      '`admin_state`. Activate shared skills only after the base protocol is enabled, using the ' +
      'printed dry-run and then the reviewed activate command. If quiescence or ownership cannot be ' +
      'established, leave shared publication pending. Do not simulate activation by editing config or SQL.',
    why:
      'Upstream section 2: "This is an operator action; `--confirm-quiesced` records your attestation, ' +
      'not process isolation performed by the command." And "do not simulate activation by editing ' +
      'config or SQL." Claim and activate are operator decisions. The SQL bypass is forbidden (G3).',
  },
  {
    key: 'v5300-db-only-export',
    prompt:
      'Skip the existing-root claim for a database-only source. Preview a destination that does not ' +
      'exist, then export only after writers are stopped and an operational backup is verified. Do ' +
      'not pass `--acknowledge-no-backup` for the user. Do not overwrite an existing destination, ' +
      'clear a conflict, or fabricate empty replacement pages. The Postgres lock inspection ' +
      '(`SELECT id, holder_host, holder_pid FROM gbrain_cycle_locks`) is the operator\'s, not this playbook\'s.',
    why:
      'Upstream section 3: "`--acknowledge-no-backup` is the explicit alternative to ' +
      '`--backup-confirmed`, not an equivalent safety claim. An agent must not choose it for the ' +
      'user." The quoted SELECT is SQL against gbrain\'s own tables and is forbidden here (G3).',
  },
  {
    key: 'v5300-adoption-consent',
    prompt:
      'Review source adoption after the host preview. Leave unmanifested skills, malformed manifests, ' +
      'changed hashes, and ambiguous roots as conflicts. Do not copy a host-global catalog to every ' +
      'source. Preserve `mcp.publish_skills=false`. Do not add `skill_editor` or `skill_publisher` to ' +
      'make onboarding pass. Report `pending_host_work` and `action_required`; do not claim fleet completion.',
    why:
      'Upstream section 4: "Never add `skill_editor` or `skill_publisher` merely to make onboarding ' +
      'pass." Grant changes are checklist items. Completion is an operator report, not a step that ' +
      'can declare the fleet done.',
  },
  {
    key: 'v5300-reconnect-clients',
    prompt:
      'Reconnect the parent and each client separately. Omit `--profile` when preserving the existing ' +
      'permission snapshot. Offer `--skills memory-only` without changing other choices. Deliver a ' +
      'current private handoff only when scopes expand. Preserve edited copies as explicit conflicts. ' +
      'Do not scan an arbitrary home directory, edit a remote device, or delete a native shadow copy ' +
      'without authorization.',
    why:
      'Upstream section 5: "No arbitrary home-directory scan, remote-device edit, or automatic ' +
      'deletion is part of migration." Regranting and deleting shadow copies are operator ' +
      'authorizations. A step that guessed the harness would invent them.',
  },
  {
    key: 'v5300-verify-and-rollback',
    prompt:
      'Separate protocol retrieval, installed files, and actual native use. Do not manufacture a ' +
      'harness result. Rollback means publishing reviewed prior content as a new revision, or leaving ' +
      'following while preserving files. There is no automatic content rollback. A Git reset does not ' +
      'roll back permissions. Do not lower the writer floor. PGLite archive restore, if used, makes a ' +
      'new unpublished brain; read the receipts before serving.',
    why:
      'Upstream section 6: "There is no automatic content rollback command. A Git reset does not roll ' +
      'back permissions or operational state." Inventing a rollback or a same-identity restore would ' +
      'contradict the file. Native use is an observation only a human can make.',
  },
];

export const v0_53_0_0: PlaybookSpec = {
  version: '0.53.0.0',
  upstreamSkill: { path: 'skills/migrations/v0.53.0.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
