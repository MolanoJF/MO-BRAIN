import { SQL } from 'bun';

/**
 * Drop and recreate the brain public schema so the first intentional
 * `gbrain init` is not blocked by the worker's cold-start migration.
 *
 * On a virgin `compose up`, `gbrain-worker` connects to an empty Postgres
 * and applies migrations that template `content_chunks.embedding` at the
 * upstream default width (1280). Wizard finish then asks for
 * `openai:text-embedding-3-small` (1536) and gbrain refuses to re-template
 * ("Refusing to silently re-template existing brain"). Ops holds
 * GBRAIN_DATABASE_URL (S2); the control plane never does.
 *
 * Safe only before the brain is `ready` — wizard `/finish` gates on
 * lifecycle === `sources-added`.
 */
export async function resetBrainSchema(): Promise<void> {
  const url = process.env.GBRAIN_DATABASE_URL;
  if (!url) throw new Error('GBRAIN_DATABASE_URL is required to reset the brain schema');

  const brain = new SQL(url, { max: 1 });
  try {
    await brain.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await brain.unsafe('CREATE SCHEMA public');
    await brain.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
    await brain.unsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await brain.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  } finally {
    await brain.end().catch(() => {});
  }
}
