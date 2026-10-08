/**
 * Check an OpenAI key before it is stored. The key goes only into the
 * Authorization header; it is never logged, thrown, or echoed.
 */
export type KeyCheck =
  | { ok: true }
  | { ok: false; status: 400 | 502; error: 'invalid_api_key' | 'provider_unreachable' };

export const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';

export async function verifyOpenAiKey(
  apiKey: string,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = (u, i) => globalThis.fetch(u, i),
  timeoutMs = 10_000,
): Promise<KeyCheck> {
  let status: number;
  try {
    const res = await fetchImpl(OPENAI_MODELS_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
  } catch {
    return { ok: false, status: 502, error: 'provider_unreachable' };
  }
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 401 || status === 403) return { ok: false, status: 400, error: 'invalid_api_key' };
  return { ok: false, status: 502, error: 'provider_unreachable' };
}
