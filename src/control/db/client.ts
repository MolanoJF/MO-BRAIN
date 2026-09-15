import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema.ts';

let client: ReturnType<typeof postgres> | null = null;
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;
/** Suites that share this process-wide pool; closeDb only ends at zero. */
let pins = 0;

export function getDb() {
  if (!db) {
    const url = process.env.CONTROL_DATABASE_URL;
    if (!url) throw new Error('CONTROL_DATABASE_URL is required');
    client = postgres(url, { max: 10 });
    db = drizzle(client, { schema });
  }
  return db;
}

/**
 * Pin the shared pool for one test suite (call from beforeAll). Paired with
 * closeDb in afterAll so a sibling file's teardown cannot CONNECTION_ENDED
 * another file's in-flight queries when bun runs integration tests together.
 */
export function pinDb(): void {
  getDb();
  pins += 1;
}

export async function runMigrations(): Promise<void> {
  await migrate(getDb(), { migrationsFolder: 'src/control/db/migrations' });
}

export async function closeDb(): Promise<void> {
  if (pins > 0) pins -= 1;
  if (pins > 0) return;
  await client?.end();
  client = null; db = null;
}

export { schema };
