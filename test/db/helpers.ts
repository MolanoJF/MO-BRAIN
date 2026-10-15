// test/db/helpers.ts
import postgres from 'postgres';
import { migrate } from '../../src/server/db/migrate.ts';

export type Sql = postgres.Sql;

/** A fresh, migrated database per test file. */
export async function freshDb(): Promise<{ sql: Sql; drop: () => Promise<void> }> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set; run `bun run test:db`');
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const name = `t_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await admin.unsafe(`create database ${name}`);
  const sql = postgres(url.replace(/\/[^/]*$/, `/${name}`), { max: 4, transform: postgres.camel, onnotice: () => {} });
  await migrate(sql);
  return {
    sql,
    drop: async () => {
      await sql.end();
      await admin.unsafe(`drop database ${name} with (force)`);
      await admin.end();
    },
  };
}
