// test/db/migrate.test.ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { freshDb, type Sql } from './helpers.ts';
import { migrate } from '../../src/server/db/migrate.ts';

let sql: Sql; let drop: () => Promise<void>;
beforeAll(async () => ({ sql, drop } = await freshDb()));
afterAll(async () => drop());

test('creates every table', async () => {
  const rows = await sql<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public' order by 1`;
  expect(rows.map((r) => r.tablename)).toEqual([
    'api_keys', 'audit_log', 'collector_runs', 'gbrain_clients', 'grants', 'invites',
    'schema_migrations', 'sessions', 'settings', 'sources', 'users',
  ]);
});

test('defaults mode to personal', async () => {
  const [row] = await sql<{ value: string }[]>`select value from settings where key = 'mode'`;
  expect(row!.value).toBe('personal');
});

test('is idempotent', async () => {
  await migrate(sql);
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from schema_migrations`;
  expect(row!.n).toBe(1);
});

test('enforces one owner', async () => {
  await sql`insert into users (email, role, status) values ('a@x.io', 'owner', 'active')`;
  await expect(sql`insert into users (email, role, status) values ('b@x.io', 'owner', 'active')`.execute()).rejects.toThrow();
});

test('a private source needs an owner and a company source must not have one', async () => {
  await expect(sql`insert into sources (id, kind, name) values ('p-x', 'private', 'x')`.execute()).rejects.toThrow();
  const [u] = await sql<{ id: string }[]>`select id from users where email = 'a@x.io'`;
  await expect(sql`insert into sources (id, kind, owner_user_id, name) values ('c-x', 'company', ${u!.id}, 'x')`.execute()).rejects.toThrow();
});
