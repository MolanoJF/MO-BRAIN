import { callOps } from './opsClient.ts';

/**
 * `gbrain config get <key>` reads the DB plane, which is the truth for a
 * per-source override. It prints the value on the first line then a
 * `[config] source: ...` note; a missing key exits 1 with
 * `Config key not found`. `callOps` returns `{ ok: false }` on that — it does
 * NOT throw on a non-zero op exit. Parse the first non-`[config]` line.
 * MEASURED; docs/schema-pack-findings.md S1 and S6 probe 1.
 */
export async function readConfigValue(key: string): Promise<string | null> {
  const r = await callOps<never>('config.get', { key }, { timeoutMs: 60_000 });
  if (!r.ok) return null;
  const line = (r.stdout ?? '').split('\n').map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('[config]'));
  return line ?? null;
}

/**
 * Whether gbrain serves list_skills/get_skill. Never assumed from `init`'s
 * default: read back live, and anything but exactly 'true' — absent,
 * unreadable, ops down — is off.
 */
export async function skillsPublished(): Promise<boolean> {
  try {
    return (await readConfigValue('mcp.publish_skills')) === 'true';
  } catch {
    return false;
  }
}
