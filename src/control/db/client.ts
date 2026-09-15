import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema.ts';

let client: ReturnType<typeof postgres> | null = null;
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!db) {
    const url = process.env.CONTROL_DATABASE_URL;
    if (!url) throw new Error('CONTROL_DATABASE_URL is required');
    client = postgres(url, { max: 10 });
    db = drizzle(client, { schema });
  }
  return db;
}

export async function runMigrations(): Promise<void> {
  await migrate(getDb(), { migrationsFolder: 'src/control/db/migrations' });
}

export async function closeDb(): Promise<void> {
  await client?.end();
  client = null; db = null;
}

export { schema };
