import {
  pgTable, text, timestamp, boolean, integer, jsonb, uniqueIndex, index, check, primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// --- Better Auth core tables ------------------------------------------------
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name'),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  /** Zones plan 3: true only for an account an INVITE created, whose password
   *  is random and unusable. A claim may set a real password on such an
   *  account, and on no other. Cleared the moment one is set. */
  invitePlaceholder: boolean('invite_placeholder').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Better Auth 1.7.5 — required on createSession (Ruling 26).
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // Better Auth organization plugin — active org for the session.
  activeOrganizationId: text('active_organization_id'),
});

export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  // Better Auth 1.7.5 OAuth fields (nullable) + updatedAt (Ruling 26).
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  // Better Auth 1.7.5 timestamps (Ruling 26).
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// --- Product tables ---------------------------------------------------------
export const organizations = pgTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  plan: text('plan').notNull().default('self-host'),
  // Personal and company are the same deployment with a flag: one org, one
  // membership, one compiled grant, so promoting is a settings change.
  brainMode: text('brain_mode').notNull().default('company'),
  privateSpacesEnabled: boolean('private_spaces_enabled').notNull().default(true),
  timezone: text('timezone').notNull().default('UTC'),
  // Quiet hours, org-local, wrapping midnight. Upstream's default gate is
  // 23:00-08:00 (docs/guides/quiet-hours.md). Notification jobs HOLD their
  // output inside this window; they are not cancelled.
  quietHoursStart: integer('quiet_hours_start').notNull().default(23),
  quietHoursEnd: integer('quiet_hours_end').notNull().default(8),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('brain_mode_valid', sql`${t.brainMode} in ('personal','company')`),
  check('quiet_hours_range', sql`${t.quietHoursStart} between 0 and 23
    and ${t.quietHoursEnd} between 0 and 23`),
]);

export const memberships = pgTable('memberships', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('memberships_user_org_uq').on(t.userId, t.organizationId),
  check('role_valid', sql`${t.role} in ('owner','admin','member','viewer')`),
]);

export const brains = pgTable('brains', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  gbrainHome: text('gbrain_home').notNull(),
  engine: text('engine').notNull().default('postgres'),
  gbrainVersion: text('gbrain_version'),
  embeddingModel: text('embedding_model'),
  searchMode: text('search_mode'),
  /**
   * The schema pack the admin chose: what kinds of pages the brain
   * recognizes. Stored the same way searchMode is, and passed to
   * `gbrain init --schema-pack` at /wizard/finish.
   *
   * This is INTENT, not resolved truth. gbrain resolves the active pack
   * through a 7-tier chain in which a brain-DB-plane value (tier 4) silently
   * outranks the ~/.gbrain/config.json value we write (tier 6). Always read
   * the truth back with `gbrain schema active` and surface any divergence
   * rather than trusting this column — see docs/archive/schema-pack-findings.md S2.
   */
  schemaPack: text('schema_pack'),
  lifecycle: text('lifecycle').notNull().default('uninitialized'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('lifecycle_valid', sql`${t.lifecycle} in (
  'uninitialized','provider-configured','mode-selected','schema-selected','sources-added','ready')`)]);

/** A Space IS a gbrain source. Hard rule (S4b) — enforced by the unique index. */
export const spaces = pgTable('spaces', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  sourceId: text('source_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  kind: text('kind').notNull().default('local-git'),
  localPath: text('local_path'),
  gitRemote: text('git_remote'),
  deployKeySecretId: text('deploy_key_secret_id'),
  ownerMembershipId: text('owner_membership_id').references(() => memberships.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('spaces_org_source_id_uq').on(t.organizationId, t.sourceId),
  check('kind_valid', sql`${t.kind} in ('local-git','remote-git','db-only','github','google')`),
  uniqueIndex('spaces_owner_membership_uq').on(t.organizationId, t.ownerMembershipId)
    .where(sql`${t.ownerMembershipId} is not null`),
]);

/**
 * D7 (zones spec): explicit access to COMPANY Spaces. A personal Space is never
 * granted — its owner reaches it by ownership and nobody else reaches it at
 * all — so every row here points at a Space whose `owner_membership_id` is null.
 * Admin/owner reach every company Space without a row.
 */
export const spaceGrants = pgTable('space_grants', {
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  membershipId: text('membership_id').notNull()
    .references(() => memberships.id, { onDelete: 'cascade' }),
  spaceId: text('space_id').notNull()
    .references(() => spaces.id, { onDelete: 'cascade' }),
  access: text('access').notNull(),
  grantedBy: text('granted_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.membershipId, t.spaceId], name: 'space_grants_pk' }),
  index('space_grants_org_idx').on(t.organizationId),
  check('space_grant_access_valid', sql`${t.access} in ('read','write')`),
]);

/** Envelope-encrypted. A pg_dump of this table is not a credential dump (S3b). */
export const secrets = pgTable('secrets', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  version: integer('version').notNull().default(1),
  salt: text('salt').notNull(),
  wrappedDek: text('wrapped_dek').notNull(),
  payload: text('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
}, (t) => [uniqueIndex('secrets_org_name_version_uq').on(t.organizationId, t.name, t.version)]);

export const capabilitySnapshots = pgTable('capability_snapshots', {
  id: text('id').primaryKey(),
  gbrainVersion: text('gbrain_version').notNull(),
  toolsJson: jsonb('tools_json'),
  harnesses: jsonb('harnesses'),
  profiles: jsonb('profiles'),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('capability_snapshots_version_idx').on(t.gbrainVersion)]);

/** Per-version migration playbook state. Nobody upstream has this. */
export const playbookLedger = pgTable('playbook_ledger', {
  id: text('id').primaryKey(),
  gbrainVersion: text('gbrain_version').notNull().unique(),
  state: text('state').notNull().default('pending'),
  notes: text('notes'),
  decidedBy: text('decided_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('playbook_state_valid', sql`${t.state} in (
  'pending','applied','skipped','awaiting_admin_decision')`)]);

export const auditLog = pgTable('audit_log', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id'),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  target: text('target'),
  // S3c: before/after are REDACTED summaries, never raw request bodies.
  before: jsonb('before'),
  after: jsonb('after'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('audit_log_at_idx').on(t.at)]);

/** S4: a Connection is the unit of access. Exactly one write Space, N read Spaces. */
export const connections = pgTable('connections', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  membershipId: text('membership_id').notNull().references(() => memberships.id, { onDelete: 'cascade' }),
  // Singular and NOT NULL. Two write Spaces means two Connections — structurally,
  // not by convention. This column is the enforcement of S4.
  writeSpaceId: text('write_space_id').notNull().references(() => spaces.id),
  readSpaceIds: jsonb('read_space_ids').notNull().default(sql`'[]'::jsonb`),
  harness: text('harness').notNull(),
  // A4: deterministic bs-<memberId8>-<spaceSlug>. Upstream refuses duplicate client
  // names, so mirror that here and fail fast before the CLI does.
  clientName: text('client_name').notNull(),
  // Null until provisioned. A3 provisions at claim time, so an unclaimed invite
  // never corresponds to a live OAuth client.
  gbrainClientId: text('gbrain_client_id'),
  // Slice 4 (D8): the server-side client this deployment mints per-run gbrain
  // tokens as — a SECOND client beside the member's own. Its secret lives in
  // `secrets` under `connection:<id>:server_client`, never here. Null until
  // provisioned, and the runner refuses a Connection that has no value.
  serverClientId: text('server_client_id'),
  profile: text('profile').notNull(),
  tokenTtl: integer('token_ttl').notNull(),
  budgetUsdPerDay: text('budget_usd_per_day'),
  boundSlugPrefixes: jsonb('bound_slug_prefixes'),
  state: text('state').notNull().default('pending'),
  provisionedAt: timestamp('provisioned_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  verifyStatus: text('verify_status'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verifyMessage: text('verify_message'),
  // Spec agent-control-mcp §7: an admin can make a Connection data-only. The
  // control MCP refuses it; the data lane (/mcp) is untouched.
  controlEnabled: boolean('control_enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('connections_org_client_name_uq').on(t.organizationId, t.clientName),
  index('connections_membership_idx').on(t.membershipId),
  check('connection_state_valid', sql`${t.state} in ('pending','active','revoked')`),
  check('connection_verify_status_valid', sql`${t.verifyStatus} in ('ok','partial','failed') or ${t.verifyStatus} is null`),
]);

/** A3: one link per member. Hash only — the token itself is never stored. */
export const claimLinks = pgTable('claim_links', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  membershipId: text('membership_id').notNull().references(() => memberships.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('claim_links_membership_idx').on(t.membershipId)]);

/**
 * A schedule runs allowlisted gbrain CLI commands as a scoped Connection.
 * The Connection supplies the --source fence, the write Space the report lands
 * in, the git identity of the report commit, and the audit subject. It does
 * NOT make gbrain enforce the scope: V1 established that the control surface is
 * CLI-only and absent from the MCP operation registry, so these commands run as
 * gbrain-ops's local admin identity. The fence is ours. Say so in the UI.
 */
export const schedules = pgTable('schedules', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  // Nullable so revoking a Connection disables a schedule instead of deleting
  // the operator's configuration. The executor refuses a null connection.
  connectionId: text('connection_id').references(() => connections.id, { onDelete: 'set null' }),
  /** Slug-shaped: it becomes the reports/<job-name>/ directory. */
  name: text('name').notNull(),
  preset: text('preset'),
  /**
   * Slice 4 (D2): ONE queue, two consumers. `schedule_runs` stays the single
   * run ledger; `jobType` decides who claims the row — the scheduler claims
   * 'gbrain_command', `POST /api/runs/claim` claims 'agent_prompt'. The filter
   * is applied inside the FOR UPDATE SKIP LOCKED select, so neither consumer
   * can starve the other.
   */
  jobType: text('job_type').notNull().default('gbrain_command'),
  /** A key of SCHEDULER_COMMANDS, not a raw gbrain argv. NULL on an
   * agent_prompt row: `shape_matches_job_type` below allows exactly one
   * payload shape per row. */
  operation: text('operation'),
  /** Tunable params only. Fenced params (source) are never stored here. */
  params: jsonb('params').notNull().default(sql`'{}'::jsonb`),
  // --- Slice 4 agent payload (D2) -------------------------------------------
  // All five are NULL on a gbrain_command row and required on an agent_prompt
  // row — enforced by shape_matches_job_type, not by convention.
  /** Thin on purpose: a pointer at a skill, not an inlined essay. */
  agentPrompt: text('agent_prompt'),
  agentModel: text('agent_model'),
  agentMaxTokens: integer('agent_max_tokens'),
  /** Text, exactly like connections.budget_usd_per_day: money never becomes a
   * float on its way to the database or back out of it. */
  agentBudgetUsd: text('agent_budget_usd'),
  /** The harness pin the schedule was written against. A runner whose own pin
   * differs refuses the claim rather than running an unknown binary. */
  agentHarnessVersion: text('agent_harness_version'),
  kind: text('kind').notNull(),
  // kind = 'interval'
  intervalSeconds: integer('interval_seconds'),
  anchorAt: timestamp('anchor_at', { withTimezone: true }),
  // kind = 'calendar'
  calendarHour: integer('calendar_hour'),
  calendarMinute: integer('calendar_minute'),
  /** 0=Sunday..6=Saturday, org-local. null = every day. */
  calendarDaysOfWeek: jsonb('calendar_days_of_week'),
  /** The assigned :05..:50 stagger slot. Calendar schedules only. */
  slotMinute: integer('slot_minute'),
  gapPolicy: text('gap_policy').notNull().default('shift'),
  ambiguousPolicy: text('ambiguous_policy').notNull().default('first'),
  catchupPolicy: text('catchup_policy').notNull().default('skip'),
  overlapPolicy: text('overlap_policy').notNull().default('skip'),
  misfireGraceSeconds: integer('misfire_grace_seconds').notNull().default(120),
  reportPolicy: text('report_policy').notNull().default('always'),
  /** Output is HELD during quiet hours and drained by the briefing. */
  notifies: boolean('notifies').notNull().default(false),
  timeoutSeconds: integer('timeout_seconds').notNull().default(900),
  enabled: boolean('enabled').notNull().default(true),
  disabledReason: text('disabled_reason'),
  lastMaterializedAt: timestamp('last_materialized_at', { withTimezone: true }),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('schedules_org_name_uq').on(t.organizationId, t.name),
  index('schedules_enabled_idx').on(t.enabled),
  check('schedule_kind_valid', sql`${t.kind} in ('interval','calendar')`),
  check('gap_policy_valid', sql`${t.gapPolicy} in ('shift','skip')`),
  check('ambiguous_policy_valid', sql`${t.ambiguousPolicy} in ('first','second','both')`),
  check('catchup_policy_valid', sql`${t.catchupPolicy} in ('skip','run_latest','run_all')`),
  check('overlap_policy_valid', sql`${t.overlapPolicy} in ('skip','queue','kill_previous')`),
  check('report_policy_valid', sql`${t.reportPolicy} in ('always','on_change_or_failure','never')`),
  check('job_type_valid', sql`${t.jobType} in ('gbrain_command','agent_prompt')`),
  // Orthogonal to shape_matches_kind below: `kind` is the TIMING shape (interval
  // vs calendar), `jobType` is the PAYLOAD shape (argv vs prompt). A schedule has
  // both, so both CHECKs apply, and neither one subsumes the other.
  check('shape_matches_job_type', sql`(
    ${t.jobType} = 'agent_prompt' and ${t.operation} is null
      and ${t.agentPrompt} is not null and ${t.agentModel} is not null
      and ${t.agentMaxTokens} is not null and ${t.agentBudgetUsd} is not null
      and ${t.agentHarnessVersion} is not null
  ) or (
    ${t.jobType} = 'gbrain_command' and ${t.operation} is not null
      and ${t.agentPrompt} is null and ${t.agentModel} is null
      and ${t.agentMaxTokens} is null and ${t.agentBudgetUsd} is null
      and ${t.agentHarnessVersion} is null
  )`),
  // A calendar schedule must be staggered; an interval schedule must not be.
  check('shape_matches_kind', sql`(
    ${t.kind} = 'interval' and ${t.intervalSeconds} is not null and ${t.anchorAt} is not null
      and ${t.slotMinute} is null
  ) or (
    ${t.kind} = 'calendar' and ${t.calendarHour} is not null and ${t.calendarMinute} is not null
      and ${t.slotMinute} is not null
  )`),
  check('slot_minute_assignable', sql`${t.slotMinute} is null
    or ${t.slotMinute} in (5,10,15,20,25,30,35,40,45,50)`),
  check('timeout_bounded', sql`${t.timeoutSeconds} between 30 and 21600`),
]);

/**
 * One row per scheduled occurrence. UNIQUE (schedule_id, slot) IS the
 * idempotency key from the roadmap — a double tick, a leader failover mid-tick
 * and a restart all converge on the same row.
 */
export const scheduleRuns = pgTable('schedule_runs', {
  id: text('id').primaryKey(),
  scheduleId: text('schedule_id').notNull()
    .references(() => schedules.id, { onDelete: 'cascade' }),
  organizationId: text('organization_id').notNull(),
  /** Org-local wall stamp; '#2' marks the second pass of a DST-ambiguous hour. */
  slot: text('slot').notNull(),
  fireAt: timestamp('fire_at', { withTimezone: true }).notNull(),
  state: text('state').notNull().default('pending'),
  attempt: integer('attempt').notNull().default(1),
  claimedBy: text('claimed_by'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  cancelRequested: boolean('cancel_requested').notNull().default(false),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  exitCode: integer('exit_code'),
  classification: text('classification'),
  reportPath: text('report_path'),
  /** S3c: counts and status only. Never stdout, never argv values. */
  summary: jsonb('summary'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('schedule_runs_schedule_slot_uq').on(t.scheduleId, t.slot),
  index('schedule_runs_claimable_idx').on(t.state, t.fireAt),
  index('schedule_runs_lease_idx').on(t.leaseExpiresAt),
  check('run_state_valid', sql`${t.state} in (
    'pending','running','succeeded','failed','blocked','cancelled',
    'lease_expired','skipped_overlap','skipped_catchup','held')`),
  // Slice 4 (D11) appended budget_exceeded / agent_failed / infra_failed: an
  // agent run classifies into this SAME column, so the vocabulary is one
  // vocabulary. Nothing in the gbrain_command path emits the new three.
  check('run_classification_valid', sql`${t.classification} is null or ${t.classification} in (
    'ok','failed','blocked','conflict','lock_lost','timeout','cancelled','refused',
    'budget_exceeded','agent_failed','infra_failed')`),
]);

/** Never swallowed. A rejected push, a revoked Connection, an expired lease. */
export const scheduleAlerts = pgTable('schedule_alerts', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  // set null, not cascade: the alert outlives the schedule it is about.
  scheduleId: text('schedule_id').references(() => schedules.id, { onDelete: 'set null' }),
  runId: text('run_id'),
  kind: text('kind').notNull(),
  /** S3c: a redacted summary, never raw stdout. */
  detail: jsonb('detail'),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  acknowledgedBy: text('acknowledged_by'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('schedule_alerts_open_idx').on(t.organizationId, t.acknowledgedAt),
]);

/**
 * Quiet hours hold output; they never drop it. The briefing drain releases
 * these ("Held messages MUST be picked up" — docs/guides/cron-schedule.md).
 */
export const heldNotifications = pgTable('held_notifications', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  scheduleId: text('schedule_id').references(() => schedules.id, { onDelete: 'set null' }),
  runId: text('run_id').notNull(),
  scheduleName: text('schedule_name').notNull(),
  /** The report is already on disk; hold the pointer, not a second copy. */
  reportPath: text('report_path'),
  headline: text('headline').notNull(),
  heldAt: timestamp('held_at', { withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  releasedIntoRunId: text('released_into_run_id'),
}, (t) => [
  index('held_notifications_pending_idx').on(t.organizationId, t.releasedAt),
]);

/**
 * D2: the journal (Task 4) is the authority while the control plane is
 * down; `src/upgrade/reconcile.ts` (Task 13) upserts it into these three
 * tables once the control plane is back — idempotent on `(runId, seq)` for
 * events, on the row identity for the rest.
 */
export const upgradeRuns = pgTable('upgrade_runs', {
  id: text('id').primaryKey(),
  // Audit-shaped, like audit_log.organizationId: nullable, no FK, so run
  // history survives an org being deleted and a single-org deployment
  // never has to invent one.
  organizationId: text('organization_id'),
  fromVersion: text('from_version').notNull(),
  toVersion: text('to_version').notNull(),
  state: text('state').notNull().default('planned'),
  snapshotId: text('snapshot_id'),
  journalPath: text('journal_path'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  doctorBaseline: jsonb('doctor_baseline'),
  doctorAfter: jsonb('doctor_after'),
  failureReason: text('failure_reason'),
  createdBy: text('created_by'),
}, (t) => [check('upgrade_run_state_valid', sql`${t.state} in (
  'planned','preflight_ok','quiesced','snapshot_taken','swapped','migrated',
  'playbooks_applied','gated_ok','completed','failed',
  'rolling_back','rolled_back','rollback_failed')`)]);

/** UNIQUE (run_id, seq) is what makes reconciliation idempotent (D2): a
 * reconcile pass that reruns after a crash re-upserts the same rows instead
 * of duplicating them. */
export const upgradeEvents = pgTable('upgrade_events', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => upgradeRuns.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  step: text('step').notNull(),
  level: text('level').notNull().default('info'),
  message: text('message').notNull(),
  data: jsonb('data'),
}, (t) => [
  uniqueIndex('upgrade_events_run_seq_uq').on(t.runId, t.seq),
  check('upgrade_event_level_valid', sql`${t.level} in ('info','warn','error')`),
]);

/** G5: an LLM may PROPOSE a checklist item; only a human acknowledges one.
 * Honesty rule 8: a pending item survives a control-plane restart because
 * it lives here, not in memory. */
export const upgradeChecklistItems = pgTable('upgrade_checklist_items', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => upgradeRuns.id, { onDelete: 'cascade' }),
  gbrainVersion: text('gbrain_version').notNull(),
  itemKey: text('item_key').notNull(),
  prompt: text('prompt').notNull(),
  why: text('why'),
  state: text('state').notNull().default('pending'),
  decidedBy: text('decided_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('upgrade_checklist_run_key_uq').on(t.runId, t.itemKey),
  check('upgrade_checklist_state_valid', sql`${t.state} in ('pending','acknowledged','declined')`),
]);

// --- Slice 4: the agent runner (D2) ------------------------------------------
// One row per claimed `agent_prompt` occurrence. The run ledger stays
// `schedule_runs` — this table carries only what an agent run adds: the meter,
// the failure class and the brain diff. Writer: `finishAgentRun` /
// `claimAgentRun` in `src/agent/claim.ts` (Task 6).

/**
 * L14: the failure class lives ON THIS ROW (`failure_class` + `failure_detail`),
 * never reconstructed by a renderer. D11's five classes are the whole
 * vocabulary; a successful run leaves both NULL.
 */
export const agentRuns = pgTable('agent_runs', {
  runId: text('run_id').primaryKey().references(() => scheduleRuns.id, { onDelete: 'cascade' }),
  // Audit-shaped, like schedule_runs.organization_id: denormalised, no FK, so
  // run history survives an org being deleted.
  organizationId: text('organization_id').notNull(),
  // set null, not cascade: deleting a Connection must not delete the record of
  // what it authorized (honesty rule 11 — a run we cannot show is not auditable).
  connectionId: text('connection_id').references(() => connections.id, { onDelete: 'set null' }),
  model: text('model').notNull(),
  harnessVersion: text('harness_version').notNull(),
  /** The cap this run was claimed under, not a re-derivation at display time. */
  budgetUsd: text('budget_usd').notNull(),
  /** NULL when the model could not be priced — never 0 (honesty rule 3). This
   * is a rollup of agent_run_usage.cost_usd and must equal its SUM at finish. */
  costUsd: text('cost_usd'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  numTurns: integer('num_turns').notNull().default(0),
  /** NULL on a successful run; a ref or a command line never lands here. */
  failureClass: text('failure_class'),
  /** S3c: a redacted summary, never a raw model request body. */
  failureDetail: jsonb('failure_detail'),
  /** D9: `{ commits, files, concurrentWriters }`, attribution included. */
  diffSummary: jsonb('diff_summary'),
  /** D9: sourceId -> git HEAD, captured at claim (before) and at finish (after).
   * A read Space whose head moved is a finding, not a diff row (honesty rule 10). */
  headsBefore: jsonb('heads_before'),
  headsAfter: jsonb('heads_after'),
  revertedAt: timestamp('reverted_at', { withTimezone: true }),
  revertCommit: text('revert_commit'),
  /** Set by the finish path AND by the reclaimer; whichever wins the race. An
   * already-revoked token still stamps this (honesty rule 9). */
  tokenRevokedAt: timestamp('token_revoked_at', { withTimezone: true }),
  /** D8 (Task 5): the per-run gbrain OAuth client this run's token was minted
   * as. Non-secret — the token itself is never stored here. It is the ONLY
   * handle the reclaimer has on a run whose runner is gone: revocation of a
   * run needs this id, so the claim inserts it in the same row as the run.
   * Null on a run whose mint never returned. */
  gbrainClientId: text('gbrain_client_id'),
}, (t) => [
  check('agent_failure_class_valid', sql`${t.failureClass} is null or ${t.failureClass} in (
    'budget_exceeded','agent_failed','infra_failed','timeout','refused')`),
  index('agent_runs_org_idx').on(t.organizationId),
]);

/**
 * The harness event stream, appended as it arrives. UNIQUE (run_id, seq) is the
 * same idempotent-replay key as upgrade_events (D2): `POST /api/runs/:id/events`
 * is retried after a blip and must re-upsert, never duplicate.
 * Writer: `recordEvents` in `src/agent/claim.ts` (Task 6).
 */
export const agentRunEvents = pgTable('agent_run_events', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => agentRuns.runId, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  kind: text('kind').notNull(),
  /** S3c: REDACTED. Tool arguments and brain content never land here raw. */
  data: jsonb('data'),
}, (t) => [uniqueIndex('agent_run_events_run_seq_uq').on(t.runId, t.seq)]);

/**
 * One row per metered model call. This table is the budget's authority;
 * `agent_runs.cost_usd` is its rollup. UNIQUE (run_id, seq) makes the gateway's
 * retried write idempotent.
 * Writer: `recordUsage` / the streaming meter in `src/gateway/meter.ts` (Task 7).
 */
export const agentRunUsage = pgTable('agent_run_usage', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => agentRuns.runId, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  /** NULL when priceUsage could not price the model — never 0 (honesty rule 3). */
  costUsd: text('cost_usd'),
  /** The upstream stop_reason, kept verbatim: 'max_tokens' is a truncation the
   * operator must see, and it is not the same thing as our own cap firing. */
  stopReason: text('stop_reason'),
  httpStatus: integer('http_status'),
}, (t) => [uniqueIndex('agent_run_usage_run_seq_uq').on(t.runId, t.seq)]);

/**
 * D2's seen-record: one row per runner that has announced itself on the claim
 * route. `runner_id` is the runner's own `${HOSTNAME}-${uuid8}` (`RUNNER_ID`),
 * the same id that lands in `schedule_runs.claimed_by`; `harness_version` is
 * what that SAME request reported, so `/api/health` stops answering `null` about
 * a version it is being told on every poll.
 *
 * It is **not** org-scoped, and cannot be: the sighting is the claim request,
 * which names a runner but no organization — one runner container serves the
 * whole deployment and consumes whichever org's run is next — and `/api/health`
 * reads this table WITHOUT a session. So the row carries the runner's identity
 * and nothing else: no token, no client id, no connection detail, no org.
 * Writer: `recordRunnerSeen` in `src/agent/runners.ts`.
 */
export const runnerPresence = pgTable('runner_presence', {
  runnerId: text('runner_id').primaryKey(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  harnessVersion: text('harness_version').notNull(),
});
