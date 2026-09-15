import type { Config } from 'drizzle-kit';

export default {
  schema: './src/control/db/schema.ts',
  out: './src/control/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.CONTROL_DATABASE_URL! },
} satisfies Config;
