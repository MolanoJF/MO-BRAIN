import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
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

export const auth = betterAuth({
  database: drizzleAdapter(db, {
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
  // Organization plugin dropped (plan ruling / Group 1): it always mounts
  // invitation endpoints and wants an unmapped `invitation` table. We own
  // claim links (A3). RBAC is hand-rolled in rbac.ts.
});
