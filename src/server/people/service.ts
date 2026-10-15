import type { Deps } from '../app.ts';
import { audit, getMode, type Sql } from '../db/index.ts';
import { newToken, open, seal, sha256Hex } from '../crypto.ts';
import { createApiKey, hashPassword } from '../auth.ts';
import { HttpError } from '../http.ts';
import type { ClientPurpose, ClientSpec, Grant, IssuedClient, Role, Source, User } from '../types.ts';
import {
  compileUserClients, companyWriterSpec, instanceSpec, narrowest, sameSpec, type AccessState,
} from './compile.ts';
import {
  assertCanInvite, assertCanOffboard, assertCanSetRole, assertCanSwitchMode, assertCompanyMode, slugFor,
} from './rules.ts';

type ClientRow = {
  id: string; userId: string | null; purpose: ClientPurpose; writeSource: string | null;
  gbrainClientId: string; tokenEnc: string | null; expiresAt: Date | null;
};

const ROTATE_STORED_MS = 7 * 86400_000;
const INVITE_MS = 24 * 3600_000;

export class PeopleService {
  constructor(private d: Deps) {}

  // ---- reads -------------------------------------------------------------

  async state(tx: Sql = this.d.sql): Promise<AccessState> {
    const sources = await tx<Source[]>`select id, kind, owner_user_id, name, status from sources`;
    const grants = await tx<Grant[]>`select user_id, source_id, agent_reads from grants`;
    return { sources, grants };
  }

  async user(id: string, tx: Sql = this.d.sql): Promise<User> {
    const [u] = await tx<User[]>`select id, email, name, role, status, created_at from users where id = ${id}`;
    if (!u) throw new HttpError(404, 'user_not_found');
    return u;
  }

  async userByEmail(email: string): Promise<User> {
    const [u] = await this.d.sql<User[]>`select id, email, name, role, status, created_at from users where email = ${email}`;
    if (!u) throw new HttpError(404, 'user_not_found');
    return u;
  }

  async owner(): Promise<User> {
    const [u] = await this.d.sql<User[]>`select id, email, name, role, status, created_at from users where role = 'owner'`;
    if (!u) throw new HttpError(409, 'not_bootstrapped');
    return u;
  }

  private async liveClients(userId: string | null, purposes: ClientPurpose[], tx: Sql = this.d.sql): Promise<ClientRow[]> {
    return tx<ClientRow[]>`
      select id, user_id, purpose, write_source, gbrain_client_id, token_enc, expires_at
      from gbrain_clients
      where revoked_at is null and purpose in ${tx(purposes)}
        and (user_id = ${userId} or (${userId}::uuid is null and user_id is null))
      order by created_at`;
  }

  // ---- client plumbing ---------------------------------------------------

  private async storeClient(spec: ClientSpec, issued: IssuedClient, keepToken: boolean, tx: Sql = this.d.sql): Promise<void> {
    const tokenEnc = keepToken ? seal(this.d.env.encryptionKey, issued.token) : null;
    await tx`insert into gbrain_clients (user_id, purpose, write_source, gbrain_client_id, token_enc, expires_at)
             values (${spec.userId}, ${spec.purpose}, ${spec.writeSource}, ${issued.clientId}, ${tokenEnc}, ${issued.expiresAt})`;
  }

  private async revokeRow(row: ClientRow, tx: Sql = this.d.sql): Promise<void> {
    await this.d.admin.revokeClient(row.gbrainClientId);
    await tx`update gbrain_clients set revoked_at = now() where id = ${row.id}`;
  }

  /** Bring a person's live agent and ui clients to their compiled specs (widening allowed). */
  async reconcile(userId: string): Promise<void> {
    const user = await this.user(userId);
    const desired = compileUserClients(user, await this.state());
    for (const purpose of ['agent', 'ui'] as const) {
      const want = desired.find((s) => s.purpose === purpose);
      const rows = await this.liveClients(userId, [purpose]);
      if (!want) { for (const r of rows) await this.revokeRow(r); continue; }
      for (const r of rows) {
        try {
          await this.d.admin.rescopeClient(r.gbrainClientId, want);
          if (r.writeSource !== want.writeSource) {
            await this.d.sql`update gbrain_clients set write_source = ${want.writeSource} where id = ${r.id}`;
          }
        } catch {
          // A client gbrain no longer knows (revoked out of band, or a crashed
          // narrow step) is replaced: ui silently, agent by the person re-issuing.
          await this.d.sql`update gbrain_clients set revoked_at = now() where id = ${r.id}`;
        }
      }
      const still = await this.liveClients(userId, [purpose]);
      if (purpose === 'ui' && still.length === 0) await this.storeClient(want, await this.d.admin.createClient(want), true);
    }
  }

  private async storedToken(purpose: 'ui' | 'instance', userId: string | null, spec: () => Promise<ClientSpec>): Promise<string> {
    const [row] = await this.liveClients(userId, [purpose]);
    const soon = this.d.now().getTime() + ROTATE_STORED_MS;
    if (row?.tokenEnc && (!row.expiresAt || row.expiresAt.getTime() > soon)) return open(this.d.env.encryptionKey, row.tokenEnc);
    const s = await spec();
    const issued = await this.d.admin.createClient(s);
    await this.storeClient(s, issued, true);
    if (row) await this.revokeRow(row);
    return issued.token;
  }

  async uiToken(user: User): Promise<string> {
    return this.storedToken('ui', user.id, async () => {
      const s = compileUserClients(user, await this.state()).find((x) => x.purpose === 'ui');
      if (!s) throw new HttpError(403, 'no_readable_sources');
      return s;
    });
  }

  async instanceToken(): Promise<string> {
    const owner = await this.owner();
    return this.storedToken('instance', null, async () => instanceSpec(owner, await this.state()));
  }

  // ---- sources -------------------------------------------------------------

  private async freeSourceId(prefix: 'p' | 'c', stem: string): Promise<string> {
    const taken = new Set((await this.d.sql<{ id: string }[]>`select id from sources`).map((r) => r.id));
    let id = `${prefix}-${stem}`;
    for (let n = 2; taken.has(id); n++) id = `${prefix}-${stem}-${n}`;
    return id;
  }

  async ensurePrivateSource(user: User): Promise<string> {
    const [have] = await this.d.sql<{ id: string }[]>`select id from sources where owner_user_id = ${user.id} and status = 'active'`;
    if (have) return have.id;
    const id = await this.freeSourceId('p', slugFor(user.email));
    await this.d.admin.addSource(id, `${user.email} (private)`);
    await this.d.sql`insert into sources (id, kind, owner_user_id, name) values (${id}, 'private', ${user.id}, ${`${user.email} (private)`})`;
    return id;
  }

  // ---- bootstrap -----------------------------------------------------------

  async bootstrapOwner(input: { email: string; name?: string; password?: string }): Promise<{ userId: string; password: string; apiKey: string }> {
    const [exists] = await this.d.sql`select 1 from users where role = 'owner'`;
    if (exists) throw new HttpError(409, 'already_bootstrapped');
    const password = input.password ?? newToken().slice(0, 24);
    const [u] = await this.d.sql<{ id: string }[]>`
      insert into users (email, name, role, status, password_hash)
      values (${input.email.toLowerCase()}, ${input.name ?? null}, 'owner', 'active', ${await hashPassword(password)})
      returning id`;
    const owner = await this.user(u!.id);
    await this.ensurePrivateSource(owner);
    await this.reconcile(owner.id);
    await this.instanceToken();
    const apiKey = await createApiKey(this.d.sql, owner.id, 'cli');
    await audit(this.d.sql, owner.id, 'bootstrap', owner.email);
    return { userId: owner.id, password, apiKey };
  }

  // ---- the one path for access changes (Review Focus #1) -------------------

  /**
   * Apply `change` inside a transaction, narrow every affected live client to
   * the intersection of its old and new access, commit, then widen.
   */
  async changeAccess(userIds: string[], change: (tx: Sql) => Promise<void>): Promise<void> {
    const state0 = await this.state();
    const before = new Map<string, ClientSpec[]>();
    for (const id of userIds) before.set(id, compileUserClients(await this.user(id), state0));
    await this.d.sql.begin(async (raw) => {
      // postgres.TransactionSql is not assignable to postgres.Sql; both are the tagged-template client.
      const tx = raw as unknown as Sql;
      await change(tx);
      const state1 = await this.state(tx);
      for (const id of userIds) {
        const after = compileUserClients(await this.user(id, tx), state1);
        for (const row of await this.liveClients(id, ['agent', 'ui'], tx)) {
          const b = before.get(id)!.find((s) => s.purpose === row.purpose);
          const a = after.find((s) => s.purpose === row.purpose);
          const narrow = narrowest(b, a);
          if (!narrow) await this.revokeRow(row, tx);
          else if (!b || !sameSpec(narrow, b)) await this.d.admin.rescopeClient(row.gbrainClientId, narrow);
        }
      }
    });
    for (const id of userIds) await this.reconcile(id);
  }

  private async activeIds(roles: Role[] | 'all'): Promise<string[]> {
    const rows = roles === 'all'
      ? await this.d.sql<{ id: string }[]>`select id from users where status = 'active'`
      : await this.d.sql<{ id: string }[]>`select id from users where status = 'active' and role in ${this.d.sql(roles)}`;
    return rows.map((r) => r.id);
  }

  // ---- mode and company sources -----------------------------------------------

  async setMode(actor: User, mode: 'personal' | 'company'): Promise<void> {
    const [row] = await this.d.sql<{ n: number }[]>`select count(*)::int as n from users where status <> 'disabled'`;
    assertCanSwitchMode(actor, mode, row!.n);
    await this.d.sql`update settings set value = ${this.d.sql.json(mode)} where key = 'mode'`;
    await audit(this.d.sql, actor.id, 'mode.set', mode);
    if (mode === 'company') {
      const [any] = await this.d.sql`select 1 from sources where kind = 'company' and status = 'active'`;
      if (!any) await this.addCompanySource(actor, 'Company');
    }
  }

  async addCompanySource(actor: User, name: string): Promise<string> {
    assertCompanyMode(await getMode(this.d.sql));
    if (actor.role !== 'owner' && actor.role !== 'admin') throw new HttpError(403, 'forbidden');
    const id = await this.freeSourceId('c', slugFor(name));
    await this.d.admin.addSource(id, name);
    await this.changeAccess(await this.activeIds(['owner', 'admin']), async (tx) => {
      await tx`insert into sources (id, kind, name) values (${id}, 'company', ${name})`;
    });
    await audit(this.d.sql, actor.id, 'source.add', id, { name });
    return id;
  }

  async archiveCompanySource(actor: User, id: string): Promise<void> {
    if (actor.role !== 'owner' && actor.role !== 'admin') throw new HttpError(403, 'forbidden');
    const [s] = await this.d.sql<Source[]>`select id, kind, owner_user_id, name, status from sources where id = ${id}`;
    if (!s || s.kind !== 'company') throw new HttpError(404, 'source_not_found');
    if (s.status === 'archived') return;
    await this.changeAccess(await this.activeIds('all'), async (tx) => {
      await tx`update sources set status = 'archived' where id = ${id}`;
      await tx`delete from grants where source_id = ${id}`;
    });
    for (const row of await this.d.sql<ClientRow[]>`
      select id, user_id, purpose, write_source, gbrain_client_id, token_enc, expires_at from gbrain_clients
      where purpose = 'company_writer' and write_source = ${id} and revoked_at is null`) await this.revokeRow(row);
    await this.d.admin.archiveSource(id);
    await audit(this.d.sql, actor.id, 'source.archive', id);
  }

  // ---- invites -------------------------------------------------------------

  async invite(actor: User, email: string, role: Role): Promise<{ userId: string; claimUrl: string }> {
    assertCompanyMode(await getMode(this.d.sql));
    assertCanInvite(actor, role);
    const lower = email.trim().toLowerCase();
    const [existing] = await this.d.sql<{ id: string; status: string }[]>`select id, status from users where email = ${lower}`;
    if (existing && existing.status !== 'invited') throw new HttpError(409, 'user_exists');
    const userId = existing?.id ?? (await this.d.sql<{ id: string }[]>`
      insert into users (email, role, status) values (${lower}, ${role}, 'invited') returning id`)[0]!.id;
    if (existing) await this.d.sql`update users set role = ${role} where id = ${userId}`;
    const token = newToken();
    await this.d.sql`insert into invites (token_hash, user_id, expires_at)
                     values (${sha256Hex(token)}, ${userId}, ${new Date(this.d.now().getTime() + INVITE_MS)})`;
    await audit(this.d.sql, actor.id, 'member.invite', lower, { role });
    return { userId, claimUrl: `${this.d.env.publicUrl}/claim/${token}` };
  }

  async inviteInfo(token: string): Promise<{ email: string; role: Role }> {
    const [row] = await this.d.sql<{ email: string; role: Role }[]>`
      select u.email, u.role from invites i join users u on u.id = i.user_id
      where i.token_hash = ${sha256Hex(token)} and i.used_at is null and i.expires_at > ${this.d.now()} and u.status = 'invited'`;
    if (!row) throw new HttpError(410, 'invite_invalid');
    return row;
  }

  async claim(token: string, password: string, name: string | null): Promise<{ user: User; joinKey: string }> {
    if (password.length < 10) throw new HttpError(400, 'password_too_short');
    const hash = await hashPassword(password);
    const userId = await this.d.sql.begin(async (tx) => {
      const [row] = await tx<{ userId: string }[]>`
        select i.user_id from invites i join users u on u.id = i.user_id
        where i.token_hash = ${sha256Hex(token)} and i.used_at is null and i.expires_at > ${this.d.now()}
          and u.status = 'invited'
        for update of i`;
      if (!row) throw new HttpError(410, 'invite_invalid');
      await tx`update users set password_hash = ${hash}, status = 'active', name = coalesce(${name}, name) where id = ${row.userId}`;
      await tx`update invites set used_at = ${this.d.now()} where token_hash = ${sha256Hex(token)}`;
      return row.userId;
    });
    const user = await this.user(userId);
    if (user.role !== 'viewer') await this.ensurePrivateSource(user);
    await this.reconcile(user.id);
    const joinKey = await createApiKey(this.d.sql, user.id, 'join');
    await audit(this.d.sql, user.id, 'member.claim', user.email);
    return { user, joinKey };
  }

  // ---- grants and roles ------------------------------------------------------

  private async companySource(id: string): Promise<Source> {
    const [s] = await this.d.sql<Source[]>`select id, kind, owner_user_id, name, status from sources where id = ${id}`;
    if (!s) throw new HttpError(404, 'source_not_found');
    if (s.kind !== 'company') throw new HttpError(400, 'not_a_company_source');
    if (s.status !== 'active') throw new HttpError(409, 'source_archived');
    return s;
  }

  private assertManager(actor: User) {
    if (actor.role !== 'owner' && actor.role !== 'admin') throw new HttpError(403, 'forbidden');
  }

  async grant(actor: User, userId: string, sourceId: string, agentReads: boolean): Promise<void> {
    assertCompanyMode(await getMode(this.d.sql));
    this.assertManager(actor);
    await this.companySource(sourceId);
    const target = await this.user(userId);
    if (target.status === 'disabled' || target.status === 'offboarding') throw new HttpError(409, 'user_inactive');
    await this.changeAccess([userId], async (tx) => {
      await tx`insert into grants (user_id, source_id, agent_reads) values (${userId}, ${sourceId}, ${agentReads})
               on conflict (user_id, source_id) do update set agent_reads = excluded.agent_reads`;
    });
    await audit(this.d.sql, actor.id, 'grant.add', `${target.email}:${sourceId}`, { agentReads });
  }

  async revokeGrant(actor: User, userId: string, sourceId: string): Promise<void> {
    this.assertManager(actor);
    const target = await this.user(userId);
    await this.changeAccess([userId], async (tx) => {
      await tx`delete from grants where user_id = ${userId} and source_id = ${sourceId}`;
    });
    await audit(this.d.sql, actor.id, 'grant.remove', `${target.email}:${sourceId}`);
  }

  async setAgentReads(self: User, sourceId: string, agentReads: boolean): Promise<void> {
    const [g] = await this.d.sql`select 1 from grants where user_id = ${self.id} and source_id = ${sourceId}`;
    if (!g) throw new HttpError(404, 'grant_not_found');
    await this.changeAccess([self.id], async (tx) => {
      await tx`update grants set agent_reads = ${agentReads} where user_id = ${self.id} and source_id = ${sourceId}`;
    });
    await audit(this.d.sql, self.id, 'grant.agent_reads', sourceId, { agentReads });
  }

  async setRole(actor: User, userId: string, role: Role): Promise<void> {
    const target = await this.user(userId);
    assertCanSetRole(actor, target, role);
    if (role !== 'viewer' && target.status === 'active') await this.ensurePrivateSource({ ...target, role });
    await this.changeAccess([userId], async (tx) => {
      await tx`update users set role = ${role} where id = ${userId}`;
    });
    await audit(this.d.sql, actor.id, 'member.role', target.email, { from: target.role, to: role });
  }
}
