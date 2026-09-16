import {
  pgTable, text, timestamp, boolean, integer, jsonb, uniqueIndex, index, check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// --- Better Auth core tables ------------------------------------------------
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name'),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('spaces_org_source_id_uq').on(t.organizationId, t.sourceId),
  check('kind_valid', sql`${t.kind} in ('local-git','remote-git','db-only','github','google')`),
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
  profile: text('profile').notNull(),
  tokenTtl: integer('token_ttl').notNull(),
  budgetUsdPerDay: text('budget_usd_per_day'),
  boundSlugPrefixes: jsonb('bound_slug_prefixes'),
  state: text('state').notNull().default('pending'),
  provisionedAt: timestamp('provisioned_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('connections_org_client_name_uq').on(t.organizationId, t.clientName),
  index('connections_membership_idx').on(t.membershipId),
  check('connection_state_valid', sql`${t.state} in ('pending','active','revoked')`),
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
  /** A key of SCHEDULER_COMMANDS, not a raw gbrain argv. */
  operation: text('operation').notNull(),
  /** Tunable params only. Fenced params (source) are never stored here. */
  params: jsonb('params').notNull().default(sql`'{}'::jsonb`),
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
  check('run_classification_valid', sql`${t.classification} is null or ${t.classification} in (
    'ok','failed','blocked','conflict','lock_lost','timeout','cancelled','refused')`),
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
