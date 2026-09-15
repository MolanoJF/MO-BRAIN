import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { getDb, schema } from './db/client.ts';

export const auth = betterAuth({
  database: drizzleAdapter(getDb(), {
    provider: 'pg',
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
    },
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.PUBLIC_URL ?? 'http://localhost:3150',
  basePath: '/api/auth',
  emailAndPassword: { enabled: true, minPasswordLength: 12 },
  // Slice 2 adds the organization + RBAC plugins and OIDC providers. Keeping
  // memberships in our own table now means that is a feature, not a migration.
});
