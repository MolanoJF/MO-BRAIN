import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';

const DIR = join(import.meta.dir, 'migrations');

/** Apply every migrations/NNN_*.sql not yet recorded, each in its own transaction. */
export async function migrate(sql: postgres.Sql): Promise<string[]> {
  await sql`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
  const done = new Set((await sql<{ version: string }[]>`select version from schema_migrations`).map((r) => r.version));
  const applied: string[] = [];
  for (const file of readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort()) {
    const version = file.slice(0, 3);
    if (done.has(version)) continue;
    const text = readFileSync(join(DIR, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (version) values (${version})`;
    });
    applied.push(file);
  }
  return applied;
}
