import postgres from 'postgres';

export type Sql = postgres.Sql;

export function connect(url: string): Sql {
  return postgres(url, { max: 8, transform: postgres.camel, onnotice: () => {} });
}

export async function audit(
  sql: Sql,
  actorUserId: string | null,
  action: string,
  target: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await sql`insert into audit_log (actor_user_id, action, target, detail)
            values (${actorUserId}, ${action}, ${target}, ${sql.json(detail as postgres.JSONValue)})`;
}

export async function getMode(sql: Sql): Promise<'personal' | 'company'> {
  const [row] = await sql<{ value: 'personal' | 'company' }[]>`select value from settings where key = 'mode'`;
  return row?.value ?? 'personal';
}
