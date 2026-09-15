import { SQL } from 'bun';

/** Statements issued in order by `resetBrainSchema`. Exported for tests. */
export const RESET_BRAIN_SCHEMA_SQL = [
  'DROP SCHEMA IF EXISTS public CASCADE',
  'CREATE SCHEMA public',
  'CREATE EXTENSION IF NOT EXISTS vector',
  'CREATE EXTENSION IF NOT EXISTS pg_trgm',
  'CREATE EXTENSION IF NOT EXISTS pgcrypto',
] as const;

/** Minimal SQL surface used by reset — injectable in unit tests. */
export type BrainSql = {
  unsafe: (query: string) => Promise<unknown>;
  end: () => Promise<unknown>;
};

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
export async function resetBrainSchema(opts?: {
  connect?: (url: string) => BrainSql;
}): Promise<void> {
  const url = process.env.GBRAIN_DATABASE_URL;
  if (!url) throw new Error('GBRAIN_DATABASE_URL is required to reset the brain schema');

  const brain = opts?.connect?.(url) ?? new SQL(url, { max: 1 });
  try {
    for (const q of RESET_BRAIN_SCHEMA_SQL) {
      await brain.unsafe(q);
    }
  } finally {
    await brain.end().catch(() => {});
  }
}
