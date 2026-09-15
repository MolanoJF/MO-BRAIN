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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('brain_mode_valid', sql`${t.brainMode} in ('personal','company')`)]);

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
