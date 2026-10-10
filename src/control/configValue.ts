import { callOps } from './opsClient.ts';

/**
 * Reads one key with `gbrain config get`. It prints the value on the first line
 * then a `[config] source: ...` note; a missing key exits 1 with
 * `Config key not found`. `callOps` returns `{ ok: false }` on that — it does
 * NOT throw on a non-zero op exit. Parse the first non-`[config]` line.
 * MEASURED; docs/archive/schema-pack-findings.md S1 and S6 probe 1.
 */
export async function readConfigValue(key: string): Promise<string | null> {
  const r = await callOps<never>('config.get', { key }, { timeoutMs: 60_000 });
  if (!r.ok) return null;
  const line = (r.stdout ?? '').split('\n').map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('[config]'));
  return line ?? null;
}
