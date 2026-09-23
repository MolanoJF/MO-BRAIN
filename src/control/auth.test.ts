import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { getDb, schema } from './db/client.ts';

type Db = ReturnType<typeof getDb>;

const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = getDb() as object;
    const value = Reflect.get(real, prop, real);
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
});

/**
 * D6: used ONLY by tests that need a session for a Google-style sign-in
 * without a real OAuth round trip (bootstrap-google.test.ts). Never
 * imported by production code. Better Auth's own testUtils plugin doc
 * comment (node_modules/better-auth/dist/plugins/test-utils/index.mjs)
 * recommends exactly this: a separate instance, not a flag on the real one.
 */
export const testAuth = betterAuth({
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
  plugins: [testUtils()],
});
