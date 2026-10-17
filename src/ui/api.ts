export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export async function api<T>(path: string, opts: { method?: string; json?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.json === undefined ? 'GET' : 'POST'),
    headers: opts.json === undefined ? {} : { 'content-type': 'application/json' },
    body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
    credentials: 'same-origin',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? `http_${res.status}`);
  return body as T;
}

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export type Me = {
  user: { id: string; email: string; name: string | null; role: Role };
  mode: 'personal' | 'company';
  grants: { sourceId: string; name: string; agentReads: boolean }[];
  publicUrl: string;
};
export type Source = { id: string; kind: 'private' | 'company'; name: string; status: string };
