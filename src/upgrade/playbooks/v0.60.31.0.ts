import type { ChecklistItemSpec, PlaybookSpec } from './types.ts';

/**
 * Hand-translated from `skills/migrations/v0.60.31.0.md` at tag v0.60.104.0,
 * read in full. Digest below is `sha256sum` of that exact file.
 *
 * No PlaybookStep. `embed --stale`, Google file-mode repair, and push
 * allowlisting need agreement. Re-chunking withheld pages is part of the
 * lane's schema step and makes no provider calls.
 *
 * Lane already does it (quoted, not a step): "`gbrain upgrade` runs it. If
 * `gbrain doctor` reports a partial migration ... `gbrain apply-migrations
 * --yes --no-autopilot-install`". Restart of serve, the jobs supervisor, and
 * autopilot is the lane. "`gbrain doctor`" is the run. Our lane does not run
 * `gbrain upgrade`.
 *
 * The file says a non-interactive upgrade does not re-embed without consent.
 * Resumed services do not start that embed. No blocksResume.
 *
 * Numbered: 1 lane schema; 2 doctor credential projection, sync only if named;
 * 3 ask before embed --stale; 4 Google file modes; 5 push blocked; 6 explain
 * redaction; 7 restart is the lane; 8 doctor is the lane.
 */
const UPSTREAM_SHA256 = 'fb8c0a98451a6f7826413ee7463421612511986252f6b803d91a26da94d378bf';

const checklist: ChecklistItemSpec[] = [
  {
    key: 'v60310-credential-sync',
    prompt:
      'Read `credential_projection_pending` in doctor. When it is ok, withheld pages are searchable ' +
      'again. If it names code pages without a recorded source path, they stay withheld until that ' +
      'source is synced: `gbrain sync --source <id>`. Do not sync a source the check does not name.',
    why:
      'Upstream step 2: "If it names code pages without a recorded source path, they stay withheld ' +
      'until their source is synced again". Which source to sync is the check\'s output, read by the ' +
      'operator. Doctor is the lane. A step that synced every source would invent the repair.',
  },
  {
    key: 'v60310-embed-stale',
    prompt:
      'Tell the user re-chunked pages have no vectors until they are embedded. Keyword search finds ' +
      'them; vector search does not. Embedding calls the configured provider and can cost money. Run ' +
      '`gbrain embed --stale` only after they agree. If the upgrade printed `[chunker-bump] Not ' +
      're-embedding without your consent`, relay the printed commands and let the user choose.',
    why:
      'Upstream step 3: "Tell the user, and only after they agree: `gbrain embed --stale`." Paid ' +
      'embed is a checklist item. The file says the non-interactive path does not re-embed. No step runs it.',
  },
  {
    key: 'v60310-google-file-modes',
    prompt:
      'If apply-migrations printed a `[google]` line, or doctor warns `google_file_modes`, show the ' +
      'preview of `gbrain repair google-file-modes --source <id>`. Explain that it clears group and ' +
      'other bits on gbrain\'s own files only. Apply only after the user agrees. A looser mode set by ' +
      'hand is reverted the next time gbrain rewrites the file.',
    why:
      'Upstream step 4: "apply after they agree". Repair `--apply` is a checklist item. The source id ' +
      'comes from the doctor warning, not from UpgradeContext.',
  },
  {
    key: 'v60310-push-blocked',
    prompt:
      'If `gbrain sources push` stops with `PUSH BLOCKED`, show each finding. A real credential must ' +
      'be removed and rotated before pushing again. Allowlist a value only when the user confirms it ' +
      'is not a credential, using the printed command, then the printed retry. Replace a stale ' +
      'allowlist entry only if the user confirms the old private-key finding is a false positive.',
    why:
      'Upstream step 5: "Only a value the user confirms is not a credential may be allowlisted". ' +
      'Allowlisting is a judgement call. A step that added an entry would invent that confirmation.',
  },
  {
    key: 'v60310-explain-redaction',
    prompt:
      'When a result carries `<REDACTED:pattern>`, tell the user the brain holds a value of that kind ' +
      'and withheld it. Do not try other operations to recover it. A credential the user asked the ' +
      'brain to remember is readable with `gbrain recall` on the brain host only. Full page reads are ' +
      'not redacted.',
    why:
      'Upstream step 6: "tell the user the brain holds a value of that kind and withheld it; do not ' +
      'try other operations to recover it." Recovering a redacted secret is not a step. Telling the ' +
      'user is the checklist item.',
  },
];

export const v0_60_31_0: PlaybookSpec = {
  version: '0.60.31.0',
  upstreamSkill: { path: 'skills/migrations/v0.60.31.0.md', sha256: UPSTREAM_SHA256 },
  steps: [],
  checklist,
};
