export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'ApiError'; }
}

async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((payload as { error?: string }).error ?? `HTTP ${res.status}`, res.status);
  return payload as T;
}

export const api = {
  get: <T = unknown>(path: string): Promise<T> => request<T>(path, 'GET'),
  post: <T = unknown>(path: string, body?: unknown): Promise<T> => request<T>(path, 'POST', body ?? {}),
  delete: <T = unknown>(path: string): Promise<T> => request<T>(path, 'DELETE'),
};
