import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { getDb, schema } from './db/client.ts';

type Db = ReturnType<typeof getDb>;

/**
 * Resolve the live pool on every access. better-auth binds its drizzle handle
 * at module load; if a sibling integration suite's afterAll ends the singleton
 * postgres client, a captured getDb() snapshot would CONNECTION_ENDED every
 * later auth call in the same bun test process. A proxy always follows getDb().
 */
const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = getDb() as object;
    const value = Reflect.get(real, prop, real);
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
});

// Custom AC carries all four of our roles. Plugin defaultRoles has no viewer.
const ac = createAccessControl({
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  team: ['create', 'update', 'delete'],
  ac: ['create', 'read', 'update', 'delete'],
} as const);

const owner = ac.newRole({
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  team: ['create', 'update', 'delete'],
  ac: ['create', 'read', 'update', 'delete'],
});
const admin = ac.newRole({
  organization: ['update'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  team: ['create', 'update', 'delete'],
  ac: ['create', 'read', 'update', 'delete'],
});
const member = ac.newRole({
  organization: [],
  member: [],
  invitation: [],
  team: [],
  ac: ['read'],
});
const viewer = ac.newRole({
  organization: [],
  member: [],
  invitation: [],
  team: [],
  ac: ['read'],
});

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
      // Plugin models mapped onto our canonical tables (A5).
      organizations: schema.organizations,
      memberships: schema.memberships,
    },
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.PUBLIC_URL ?? 'http://localhost:3150',
  basePath: '/api/auth',
  emailAndPassword: { enabled: true, minPasswordLength: 12 },
  // Invitation is unmapped on purpose — we own claim links (A3). Skip the
  // adapter's schema check so it does not demand a table we do not have.
  advanced: { database: { validateSchema: false } },
  plugins: [
    organization({
      ac,
      roles: { owner, admin, member, viewer },
      schema: {
        organization: { modelName: 'organizations' },
        member: { modelName: 'memberships' },
      },
      allowUserToCreateOrganization: false,
    }),
  ],
});
