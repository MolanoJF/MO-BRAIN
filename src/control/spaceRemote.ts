/**
 * Creating the remote half of a Space's git repo on GitHub.
 *
 * Only the repo is created here. Wiring it to the Space (origin, token,
 * the push) is the route's job, so "add an existing repo" and "create one" end
 * in the same place. The repo is ALWAYS private: a brain is personal content,
 * and `gbrain sources push` refuses a remote it cannot verify is private anyway.
 */

const API = () => (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '');

const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export function githubRepoError(name: string, owner?: string): string | null {
  if (!REPO_NAME_RE.test(name) || name === '.' || name === '..') {
    return 'Repository name may only use letters, digits, ".", "_" and "-" (at most 100 characters).';
  }
  if (owner !== undefined && owner !== '' && !OWNER_RE.test(owner)) return 'Owner is not a valid GitHub user or organisation name.';
  return null;
}

export type CreatedRepo = { cloneUrl: string; fullName: string };

async function gh(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API()}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'mobrain',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
}

/** GitHub's own message, trimmed; never the token. */
async function failure(r: Response): Promise<string> {
  const body = await r.json().catch(() => null) as { message?: string; errors?: { message?: string }[] } | null;
  const detail = [body?.message, ...(body?.errors ?? []).map((e) => e.message)].filter(Boolean).join('; ');
  return `GitHub answered ${r.status}${detail ? `: ${detail}` : ''}`;
}

/**
 * Create a private, empty repository. `owner` defaults to the token's own
 * account; a different owner is treated as an organisation. Throws by name on
 * a bad token, a missing scope or a name that is already taken — a repo that
 * already exists is never adopted silently (use "add existing" for that).
 */
export async function createGithubRepo(args: {
  token: string; name: string; owner?: string; description?: string;
}): Promise<CreatedRepo> {
  const bad = githubRepoError(args.name, args.owner);
  if (bad) throw new Error(bad);

  const me = await gh(args.token, '/user');
  if (!me.ok) throw new Error(`Could not authenticate to GitHub. ${await failure(me)}`);
  const login = ((await me.json()) as { login?: string }).login ?? '';

  const org = args.owner && args.owner.toLowerCase() !== login.toLowerCase() ? args.owner : null;
  const r = await gh(args.token, org ? `/orgs/${encodeURIComponent(org)}/repos` : '/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name: args.name,
      private: true,
      auto_init: false,
      description: args.description ?? 'Mo-brain Space',
    }),
  });
  if (!r.ok) throw new Error(`Could not create the repository. ${await failure(r)}`);
  const repo = await r.json() as { clone_url?: string; full_name?: string; private?: boolean };
  if (!repo.clone_url || !repo.full_name) throw new Error('GitHub created a repository but returned no clone URL.');
  if (repo.private !== true) throw new Error(`GitHub created ${repo.full_name} but it is not private; refusing to use it.`);
  return { cloneUrl: repo.clone_url, fullName: repo.full_name };
}
