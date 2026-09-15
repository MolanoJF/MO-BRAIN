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

/**
 * Plan defect (Work Item D): `gbrain sources add --path <dir>` refuses any
 * path that is not a git repository with at least one committed, tracked
 * file — gbrain walks git objects, so an empty or non-git directory is
 * invisible to sync ("is not a git repository with committed, tracked
 * files ... an empty commit is not enough"). Seed a minimal git repo before
 * registering a source under /srv/brain-repos.
 */
export async function seedGitSource(id: string): Promise<void> {
  const dir = `/srv/brain-repos/${id}`;
  await composeExec('gbrain-ops', ['sh', '-c',
    `set -e; mkdir -p ${dir}; cd ${dir}; git init -q; echo "# ${id}" > README.md; git add -A; ` +
    `git -c user.email=test@brainstand.local -c user.name=brainstand-test commit -q -m seed`,
  ]);
}
