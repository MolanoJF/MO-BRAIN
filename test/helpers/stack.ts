import { composeUp, composeDown, composeExec } from '../../src/docker/host.ts';

export const PIN = process.env.GBRAIN_VERSION ?? '0.50.0.0';
export const PG_PASSWORD = process.env.POSTGRES_PASSWORD ?? 'change-me-in-a-real-deployment';
export const BRAIN_DB_URL =
  `postgres://gbrain:${PG_PASSWORD}@postgres:5432/${process.env.GBRAIN_DB ?? 'gbrain'}`;

export { composeUp, composeDown, composeExec };

/** Drop every gbrain table so the next test initializes a virgin brain. */
export async function resetBrain(): Promise<void> {
  await composeExec('gbrain-ops', [
    'psql', BRAIN_DB_URL, '-v', 'ON_ERROR_STOP=1', '-c',
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ' +
    'CREATE EXTENSION IF NOT EXISTS vector; ' +
    'CREATE EXTENSION IF NOT EXISTS pg_trgm; ' +
    'CREATE EXTENSION IF NOT EXISTS pgcrypto;',
  ]);
  await composeExec('gbrain-ops', ['sh', '-c', 'rm -rf /srv/gbrain-home/* /srv/gbrain-home/.[!.]* || true']);
}
