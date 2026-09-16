import { and, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '../control/db/client.ts';

/**
 * Release every held notification for one org into a single body, and mark
 * them released against the run that drained them. Nothing is lost and nothing
 * is released twice — the releasedAt stamp is the idempotency.
 */
export async function drainHeldNotifications(
  orgId: string, runId: string, nowMs: number,
): Promise<{ released: number; body: string }> {
  const db = getDb();
  const held = await db.select().from(schema.heldNotifications)
    .where(and(
      eq(schema.heldNotifications.organizationId, orgId),
      isNull(schema.heldNotifications.releasedAt),
    ))
    .orderBy(schema.heldNotifications.heldAt);

  if (held.length === 0) {
    return { released: 0, body: '_Nothing was held overnight._\n' };
  }

  const lines = held.map((h) => {
    const when = h.heldAt.toISOString();
    const link = h.reportPath ? ` — \`${h.reportPath}\`` : '';
    return `- **${h.scheduleName}** (${when}): ${h.headline}${link}`;
  });

  await db.update(schema.heldNotifications)
    .set({ releasedAt: new Date(nowMs), releasedIntoRunId: runId })
    .where(and(
      eq(schema.heldNotifications.organizationId, orgId),
      isNull(schema.heldNotifications.releasedAt),
    ));

  return { released: held.length, body: `## Overnight updates\n\n${lines.join('\n')}\n` };
}
