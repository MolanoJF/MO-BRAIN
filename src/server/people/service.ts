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
}
