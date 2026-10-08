import { callOps } from './opsClient.ts';

/**
 * `gbrain config get <key>` is file-plane-first for `mcp.publish_skills`
 * (`~/.gbrain/config.json`, written by `gbrain init`), not DB-first: the key is
 * not in gbrain's dual-plane set (gbrain `src/commands/config.ts:448-450`). So a
 * `gbrain config set mcp.publish_skills false` DB override is NOT reflected
 * here. gbrain's own publish gate is DB-plane-first with a file-plane fallback
 * (gbrain `src/mcp/publish-gates.ts:12-14,26`; `src/core/skill-catalog.ts`
 * `readMcpPublishSkills`), so the readback can over-report against the gate.
 * The default is accurate because only `gbrain init` writes the file plane.
 * Divergence tracked upstream (docs/archive/member-skills-findings.md). It prints the
 * value on the first line then a `[config] source: ...` note; a missing key
 * exits 1 with `Config key not found`. `callOps` returns `{ ok: false }` on
 * that — it does NOT throw on a non-zero op exit. Parse the first non-`[config]`
 * line. MEASURED; docs/archive/schema-pack-findings.md S1 and S6 probe 1.
 */
export async function readConfigValue(key: string): Promise<string | null> {
  const r = await callOps<never>('config.get', { key }, { timeoutMs: 60_000 });
  if (!r.ok) return null;
  const line = (r.stdout ?? '').split('\n').map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('[config]'));
  return line ?? null;
}

/**
 * Whether gbrain serves list_skills/get_skill, as read from the file-plane-first
 * `config get` above. Never assumed from `init`'s default: read back live, and
 * anything but exactly 'true' — absent, unreadable, ops down — is off. Note the
 * divergence from gbrain's DB-first publish gate: a DB-plane override is not
 * seen here, so this can report true while the gate hides the tools. Tracked
 * upstream; see readConfigValue.
 */
export async function skillsPublished(): Promise<boolean> {
  try {
    return (await readConfigValue('mcp.publish_skills')) === 'true';
  } catch {
    return false;
  }
}
