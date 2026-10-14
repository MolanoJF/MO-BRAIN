# Phase 4: People and company mode

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Read `00-master.md` first.

**Goal:** Everything in spec §5: the compile function from people and grants to gbrain client specs, the rules, the people service that applies changes to gbrain in a narrow-then-widen order, bootstrap of the owner, invites and claim, client issue and rotation, offboarding, and the HTTP routes and container admin CLI over them.

**Spec sections:** §5 (all), §7.3, §9.2.

**The ordering rule (Review Focus #1).** Every access change runs through `changeAccess`: inside one DB transaction it applies the change, computes each affected person's new specs, and **narrows** their live gbrain clients to the intersection of old and new access; then it commits; then `reconcile` **widens** each client to the new spec. A gbrain failure before commit rolls back the DB (nothing changed). A failure after commit leaves access narrower than the DB says, never wider, and the next `reconcile` converges.

---

### Task 4.1: Compile

**Files:**
- Create: `src/server/people/compile.ts`
- Test: `test/unit/compile.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/compile.test.ts
import { describe, expect, test } from 'bun:test';
import {
  ADMIN_AGENT_PROFILE, PROFILE_READER, PROFILE_WRITER, compileUserClients, companyWriterSpec,
  instanceSpec, narrowest,
} from '../../src/server/people/compile.ts';
import type { Grant, Source, User } from '../../src/server/types.ts';

const u = (id: string, role: User['role'], status: User['status'] = 'active'): User =>
  ({ id, email: `${id}@x.io`, name: null, role, status, createdAt: new Date() });
const priv = (id: string, owner: string): Source => ({ id, kind: 'private', ownerUserId: owner, name: id, status: 'active' });
const comp = (id: string, status: Source['status'] = 'active'): Source => ({ id, kind: 'company', ownerUserId: null, name: id, status });
const g = (userId: string, sourceId: string, agentReads = true): Grant => ({ userId, sourceId, agentReads });

const sources = [priv('p-own', 'own'), priv('p-mem', 'mem'), comp('c-a'), comp('c-b'), comp('c-old', 'archived')];

describe('compileUserClients', () => {
  test('owner: writes own private, reads every active company source, never another private', () => {
    const specs = compileUserClients(u('own', 'owner'), { sources, grants: [] });
    expect(specs.map((s) => [s.purpose, s.profile, s.writeSource, s.readSources])).toEqual([
      ['agent', ADMIN_AGENT_PROFILE, 'p-own', ['c-a', 'c-b']],
      ['ui', PROFILE_READER, 'p-own', ['c-a', 'c-b']],
    ]);
  });

  test('member: agent reads only granted sources with agentReads; ui reads every granted source', () => {
    const specs = compileUserClients(u('mem', 'member'), { sources, grants: [g('mem', 'c-a'), g('mem', 'c-b', false), g('mem', 'c-old')] });
    expect(specs.map((s) => [s.purpose, s.profile, s.writeSource, s.readSources])).toEqual([
      ['agent', PROFILE_WRITER, 'p-mem', ['c-a']],
      ['ui', PROFILE_READER, 'p-mem', ['c-a', 'c-b']],
    ]);
  });

  test('viewer: read-only clients over granted sources, none without grants', () => {
    expect(compileUserClients(u('v', 'viewer'), { sources, grants: [] })).toEqual([]);
    const specs = compileUserClients(u('v', 'viewer'), { sources, grants: [g('v', 'c-b'), g('v', 'c-a', false)] });
    expect(specs.map((s) => [s.purpose, s.profile, s.writeSource, s.readSources])).toEqual([
      ['agent', PROFILE_READER, 'c-b', []],
      ['ui', PROFILE_READER, 'c-a', ['c-b']],
    ]);
  });

  test('anyone not active gets nothing', () => {
    for (const status of ['invited', 'offboarding', 'disabled'] as const) {
      expect(compileUserClients(u('mem', 'member', status), { sources, grants: [g('mem', 'c-a')] })).toEqual([]);
    }
  });

  test('a member without a private source gets nothing', () => {
    expect(compileUserClients(u('zz', 'member'), { sources, grants: [g('zz', 'c-a')] })).toEqual([]);
  });

  test('names are deterministic', () => {
    const [agent] = compileUserClients(u('0123456789ab-cdef', 'owner'), { sources: [priv('p-x', '0123456789ab-cdef')], grants: [] });
    expect(agent!.name).toBe('mb-agent-01234567');
  });
});

describe('instance and company writer', () => {
  test('instance reads company sources from the owner private source', () => {
    const s = instanceSpec(u('own', 'owner'), { sources, grants: [] });
    expect([s.purpose, s.name, s.writeSource, s.readSources]).toEqual(['instance', 'mb-instance', 'p-own', ['c-a', 'c-b']]);
  });
  test('company writer writes one company source', () => {
    const s = companyWriterSpec(u('own', 'owner'), 'c-a');
    expect([s.purpose, s.profile, s.writeSource, s.readSources]).toEqual(['company_writer', PROFILE_WRITER, 'c-a', []]);
  });
});

describe('narrowest', () => {
  const base = compileUserClients(u('mem', 'member'), { sources, grants: [g('mem', 'c-a'), g('mem', 'c-b')] })[1]!;
  test('intersects reads', () => {
    const after = { ...base, readSources: ['c-b'] };
    expect(narrowest(base, after)!.readSources).toEqual(['c-b']);
    const wider = { ...base, readSources: ['c-a', 'c-b', 'c-c'] };
    expect(narrowest(base, wider)!.readSources).toEqual(['c-a', 'c-b']);
  });
  test('null when either side is missing or the write source changes', () => {
    expect(narrowest(base, undefined)).toBeNull();
    expect(narrowest(undefined, base)).toBeNull();
    expect(narrowest(base, { ...base, writeSource: 'c-a' })).toBeNull();
  });
  test('takes the less privileged profile', () => {
    expect(narrowest({ ...base, profile: PROFILE_WRITER }, { ...base, profile: PROFILE_READER })!.profile).toBe(PROFILE_READER);
  });
});
```

Run: `bun test test/unit/compile.test.ts` — Expected: FAIL.

- [ ] **Step 2: Write `src/server/people/compile.ts`**

```ts
import type { ClientPurpose, ClientSpec, Grant, Source, User } from '../types.ts';

// gbrain grant profiles (confirmed by probe P2; see the probes file).
export const PROFILE_READER = 'memory-reader';
export const PROFILE_WRITER = 'memory-writer';
export const PROFILE_INSTANCE = 'coding-agent';
/** Owner and admin agents. memory-writer unless P2 found an unfenced admin profile. */
export const ADMIN_AGENT_PROFILE: string = PROFILE_WRITER;

const RANK: Record<string, number> = { [PROFILE_READER]: 0, [PROFILE_WRITER]: 1, [ADMIN_AGENT_PROFILE]: 2, [PROFILE_INSTANCE]: 3 };

export type AccessState = { sources: Source[]; grants: Grant[] };

const short = (id: string) => id.replaceAll('-', '').slice(0, 8);
export const clientName = {
  agent: (userId: string) => `mb-agent-${short(userId)}`,
  ui: (userId: string) => `mb-ui-${short(userId)}`,
  companyWriter: (userId: string, sourceId: string) => `mb-cw-${short(userId)}-${sourceId}`,
  instance: () => 'mb-instance',
};

const uniqSorted = (xs: string[]) => [...new Set(xs)].sort();

function make(purpose: ClientPurpose, userId: string | null, name: string, profile: string, write: string, reads: string[]): ClientSpec {
  return { purpose, userId, name, profile, writeSource: write, readSources: uniqSorted(reads.filter((r) => r !== write)) };
}

function activeCompany(state: AccessState): string[] {
  return state.sources.filter((s) => s.status === 'active' && s.kind === 'company').map((s) => s.id).sort();
}

function privateOf(userId: string, state: AccessState): Source | undefined {
  return state.sources.find((s) => s.status === 'active' && s.kind === 'private' && s.ownerUserId === userId);
}

/** The agent and ui clients a person should hold right now (spec §5.2). */
export function compileUserClients(user: User, state: AccessState): ClientSpec[] {
  if (user.status !== 'active') return [];
  const company = activeCompany(state);
  const mine = state.grants.filter((g) => g.userId === user.id && company.includes(g.sourceId));
  const granted = uniqSorted(mine.map((g) => g.sourceId));
  const agentGranted = uniqSorted(mine.filter((g) => g.agentReads).map((g) => g.sourceId));
  const agent = (profile: string, write: string, reads: string[]) => make('agent', user.id, clientName.agent(user.id), profile, write, reads);
  const ui = (write: string, reads: string[]) => make('ui', user.id, clientName.ui(user.id), PROFILE_READER, write, reads);

  if (user.role === 'owner' || user.role === 'admin') {
    const p = privateOf(user.id, state);
    return p ? [agent(ADMIN_AGENT_PROFILE, p.id, company), ui(p.id, company)] : [];
  }
  if (user.role === 'member') {
    const p = privateOf(user.id, state);
    return p ? [agent(PROFILE_WRITER, p.id, agentGranted), ui(p.id, granted)] : [];
  }
  const out: ClientSpec[] = [];
  if (agentGranted.length) out.push(agent(PROFILE_READER, agentGranted[0]!, agentGranted));
  if (granted.length) out.push(ui(granted[0]!, granted));
  return out;
}

export function instanceSpec(owner: User, state: AccessState): ClientSpec {
  const p = privateOf(owner.id, state);
  if (!p) throw new Error('owner has no private source');
  return make('instance', null, clientName.instance(), PROFILE_INSTANCE, p.id, activeCompany(state));
}

export function companyWriterSpec(user: User, sourceId: string): ClientSpec {
  return make('company_writer', user.id, clientName.companyWriter(user.id, sourceId), PROFILE_WRITER, sourceId, []);
}

/** The least access that both specs allow, or null when the client must be revoked. */
export function narrowest(before: ClientSpec | undefined, after: ClientSpec | undefined): ClientSpec | null {
  if (!before || !after || before.writeSource !== after.writeSource) return null;
  const keep = new Set(after.readSources);
  const profile = (RANK[before.profile] ?? 9) <= (RANK[after.profile] ?? 9) ? before.profile : after.profile;
  return { ...after, profile, readSources: before.readSources.filter((r) => keep.has(r)) };
}

export function sameSpec(a: ClientSpec, b: ClientSpec): boolean {
  return a.profile === b.profile && a.writeSource === b.writeSource && a.readSources.join(',') === b.readSources.join(',');
}
```

- [ ] **Step 3: Run** — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/people/compile.ts test/unit/compile.test.ts
git commit -m "feat(people): compile people and grants into gbrain client specs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4.2: Rules

**Files:**
- Create: `src/server/people/rules.ts`
- Test: `test/unit/rules.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/rules.test.ts
import { describe, expect, test } from 'bun:test';
import {
  assertCanInvite, assertCanOffboard, assertCanSetRole, assertCanSwitchMode, assertCompanyMode, slugFor,
} from '../../src/server/people/rules.ts';
import type { User } from '../../src/server/types.ts';

const u = (id: string, role: User['role']): User => ({ id, email: `${id}@x.io`, name: null, role, status: 'active', createdAt: new Date() });
const code = (f: () => void) => { try { f(); return 'ok'; } catch (e) { return (e as { code: string }).code; } };

describe('rules', () => {
  test('company-only operations refuse in personal mode (rule 4)', () => {
    expect(code(() => assertCompanyMode('personal'))).toBe('company_mode_required');
    expect(code(() => assertCompanyMode('company'))).toBe('ok');
  });

  test('only the owner switches mode; back to personal only as the sole active user (rules 2, 3)', () => {
    expect(code(() => assertCanSwitchMode(u('a', 'admin'), 'company', 1))).toBe('forbidden');
    expect(code(() => assertCanSwitchMode(u('o', 'owner'), 'company', 3))).toBe('ok');
    expect(code(() => assertCanSwitchMode(u('o', 'owner'), 'personal', 2))).toBe('not_sole_member');
    expect(code(() => assertCanSwitchMode(u('o', 'owner'), 'personal', 1))).toBe('ok');
  });

  test('invites: owner any non-owner role, admin only member or viewer, nobody invites an owner', () => {
    expect(code(() => assertCanInvite(u('o', 'owner'), 'admin'))).toBe('ok');
    expect(code(() => assertCanInvite(u('a', 'admin'), 'admin'))).toBe('forbidden');
    expect(code(() => assertCanInvite(u('a', 'admin'), 'member'))).toBe('ok');
    expect(code(() => assertCanInvite(u('o', 'owner'), 'owner'))).toBe('invalid_role');
    expect(code(() => assertCanInvite(u('m', 'member'), 'viewer'))).toBe('forbidden');
  });

  test('roles: the owner is untouchable, only the owner moves admins, nobody changes their own role (rule 10)', () => {
    expect(code(() => assertCanSetRole(u('o', 'owner'), u('o2', 'owner'), 'member'))).toBe('owner_is_fixed');
    expect(code(() => assertCanSetRole(u('a', 'admin'), u('m', 'member'), 'admin'))).toBe('forbidden');
    expect(code(() => assertCanSetRole(u('a', 'admin'), u('b', 'admin'), 'member'))).toBe('forbidden');
    expect(code(() => assertCanSetRole(u('o', 'owner'), u('b', 'admin'), 'member'))).toBe('ok');
    expect(code(() => assertCanSetRole(u('a', 'admin'), u('a', 'admin'), 'member'))).toBe('cannot_change_self');
    expect(code(() => assertCanSetRole(u('o', 'owner'), u('m', 'member'), 'owner'))).toBe('invalid_role');
  });

  test('offboarding: never the owner; admins only offboard members and viewers', () => {
    expect(code(() => assertCanOffboard(u('a', 'admin'), u('o', 'owner')))).toBe('owner_is_fixed');
    expect(code(() => assertCanOffboard(u('a', 'admin'), u('b', 'admin')))).toBe('forbidden');
    expect(code(() => assertCanOffboard(u('o', 'owner'), u('b', 'admin')))).toBe('ok');
    expect(code(() => assertCanOffboard(u('m', 'member'), u('v', 'viewer')))).toBe('forbidden');
  });

  test('slugFor makes a gbrain-safe id stem', () => {
    expect(slugFor('Ada.Lovelace+work@X.io')).toBe('ada-lovelace-work');
    expect(slugFor('Engineering & Ops')).toBe('engineering-ops');
    expect(slugFor('***')).toBe('x');
  });
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Write `src/server/people/rules.ts`**

```ts
import { HttpError } from '../http.ts';
import type { Mode, Role, User } from '../types.ts';

const fail = (status: number, code: string): never => { throw new HttpError(status, code); };
const isAdminish = (r: Role) => r === 'owner' || r === 'admin';

export function assertCompanyMode(mode: Mode): void {
  if (mode !== 'company') fail(403, 'company_mode_required');
}

export function assertCanSwitchMode(actor: User, to: Mode, nonDisabledUsers: number): void {
  if (actor.role !== 'owner') fail(403, 'forbidden');
  if (to === 'personal' && nonDisabledUsers > 1) fail(409, 'not_sole_member');
}

export function assertCanInvite(actor: User, role: Role): void {
  if (role === 'owner') fail(400, 'invalid_role');
  if (!isAdminish(actor.role)) fail(403, 'forbidden');
  if (role === 'admin' && actor.role !== 'owner') fail(403, 'forbidden');
}

export function assertCanSetRole(actor: User, target: User, role: Role): void {
  if (target.role === 'owner') fail(409, 'owner_is_fixed');
  if (role === 'owner') fail(400, 'invalid_role');
  if (actor.id === target.id) fail(409, 'cannot_change_self');
  if (!isAdminish(actor.role)) fail(403, 'forbidden');
  if ((role === 'admin' || target.role === 'admin') && actor.role !== 'owner') fail(403, 'forbidden');
}

export function assertCanOffboard(actor: User, target: User): void {
  if (target.role === 'owner') fail(409, 'owner_is_fixed');
  if (!isAdminish(actor.role)) fail(403, 'forbidden');
  if (target.role === 'admin' && actor.role !== 'owner') fail(403, 'forbidden');
}

export function slugFor(text: string): string {
  const local = text.includes('@') ? text.split('@')[0]! : text;
  const s = local.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'x';
}
```

- [ ] **Step 3: Run** — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/people/rules.ts test/unit/rules.test.ts
git commit -m "feat(people): access rules as pure guards

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4.3: People service — state, reconcile, bootstrap, instance

**Files:**
- Create: `src/server/people/service.ts`
- Test: `test/db/people-bootstrap.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/db/people-bootstrap.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { PeopleService } from '../../src/server/people/service.ts';

let w: TestWorld; let people: PeopleService;
beforeAll(async () => { w = await world(); people = new PeopleService(w.deps); });
afterAll(async () => w.drop());

describe('bootstrapOwner', () => {
  test('creates the owner, a private source, ui and instance clients, and an API key', async () => {
    const r = await people.bootstrapOwner({ email: 'Ada.L@x.io', name: 'Ada' });
    expect(r.password.length).toBeGreaterThanOrEqual(16);
    expect(r.apiKey.startsWith('mbk_')).toBe(true);
    const [src] = await w.sql`select id, kind from sources`;
    expect(src).toMatchObject({ id: 'p-ada-l', kind: 'private' });
    expect(w.admin.sources.get('p-ada-l')).toBeDefined();
    const clients = await w.sql`select purpose, token_enc from gbrain_clients where revoked_at is null order by purpose`;
    expect(clients.map((c) => c.purpose)).toEqual(['instance', 'ui']);
    expect(clients.every((c) => typeof c.tokenEnc === 'string' && c.tokenEnc.startsWith('v1:'))).toBe(true);
  });

  test('refuses a second bootstrap', async () => {
    await expect(people.bootstrapOwner({ email: 'b@x.io' })).rejects.toMatchObject({ code: 'already_bootstrapped' });
  });
});

describe('tokens', () => {
  test('uiToken and instanceToken open the stored tokens', async () => {
    const owner = await people.userByEmail('ada.l@x.io');
    expect((await people.uiToken(owner)).startsWith('tok-')).toBe(true);
    expect((await people.instanceToken()).startsWith('tok-')).toBe(true);
  });

  test('a ui token within 7 days of expiry is rotated and the old client revoked', async () => {
    const owner = await people.userByEmail('ada.l@x.io');
    const before = await people.uiToken(owner);
    await w.sql`update gbrain_clients set expires_at = ${new Date(w.deps.now().getTime() + 3 * 86400_000)} where purpose = 'ui'`;
    const after = await people.uiToken(owner);
    expect(after).not.toBe(before);
    const live = await w.sql`select count(*)::int as n from gbrain_clients where purpose = 'ui' and revoked_at is null`;
    expect(live[0]!.n).toBe(1);
  });
});
```

Run: `bun run test:db` — Expected: FAIL.

- [ ] **Step 2: Write `src/server/people/service.ts` (first part; tasks 4.4–4.7 add methods to the same class)**

```ts
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
```

- [ ] **Step 3: Run** — `bun run test:db` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/people/service.ts test/db/people-bootstrap.test.ts
git commit -m "feat(people): service core, reconcile, owner bootstrap, stored-token rotation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4.4: Mode switching and company sources

**Files:**
- Modify: `src/server/people/service.ts` (add methods)
- Test: `test/db/people-mode.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/db/people-mode.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { PeopleService } from '../../src/server/people/service.ts';
import type { User } from '../../src/server/types.ts';

let w: TestWorld; let people: PeopleService; let owner: User;
beforeAll(async () => {
  w = await world(); people = new PeopleService(w.deps);
  await people.bootstrapOwner({ email: 'own@x.io' });
  owner = await people.userByEmail('own@x.io');
});
afterAll(async () => w.drop());

describe('mode', () => {
  test('a fresh install is personal and refuses company operations (rules 1, 4)', async () => {
    await expect(people.addCompanySource(owner, 'Eng')).rejects.toMatchObject({ code: 'company_mode_required' });
    await expect(people.invite(owner, 'm@x.io', 'member')).rejects.toMatchObject({ code: 'company_mode_required' });
  });

  test('switching to company creates c-company and widens the owner to read it', async () => {
    await people.setMode(owner, 'company');
    const [s] = await w.sql`select id, kind from sources where kind = 'company'`;
    expect(s).toMatchObject({ id: 'c-company' });
    const ui = w.admin.live(owner.id).find((c) => c.purpose === 'ui')!;
    expect(ui.readSources).toEqual(['c-company']);
  });

  test('a second company source gets its own id and every admin reads it', async () => {
    const id = await people.addCompanySource(owner, 'Engineering & Ops');
    expect(id).toBe('c-engineering-ops');
    expect(w.admin.live(owner.id).find((c) => c.purpose === 'ui')!.readSources).toEqual(['c-company', 'c-engineering-ops']);
  });

  test('switching back is refused while anyone else is not disabled (rule 3)', async () => {
    await people.invite(owner, 'm@x.io', 'member');
    await expect(people.setMode(owner, 'personal')).rejects.toMatchObject({ code: 'not_sole_member' });
  });

  test('archiving a company source narrows clients and archives it in gbrain', async () => {
    await people.archiveCompanySource(owner, 'c-engineering-ops');
    expect(w.admin.live(owner.id).find((c) => c.purpose === 'ui')!.readSources).toEqual(['c-company']);
    expect(w.admin.sources.get('c-engineering-ops')!.archived).toBe(true);
  });
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Add `changeAccess`, `setMode`, `addCompanySource`, `archiveCompanySource` to `PeopleService`**

```ts
  // ---- the one path for access changes (Review Focus #1) -------------------

  /**
   * Apply `change` inside a transaction, narrow every affected live client to
   * the intersection of its old and new access, commit, then widen.
   */
  async changeAccess(userIds: string[], change: (tx: Sql) => Promise<void>): Promise<void> {
    const state0 = await this.state();
    const before = new Map<string, ClientSpec[]>();
    for (const id of userIds) before.set(id, compileUserClients(await this.user(id), state0));
    await this.d.sql.begin(async (tx) => {
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
```

- [ ] **Step 3: Run** — `bun run test:db` — Expected: typecheck of `people-mode.test.ts` fails only because `invite` does not exist yet. Go straight to task 4.5; both test files pass at the end of it.

- [ ] **Step 4: Commit after task 4.5 passes** (the next task completes this test file).

---

### Task 4.5: Invites, claim, grants, roles

**Files:**
- Modify: `src/server/people/service.ts`
- Test: `test/db/people-access.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/db/people-access.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { PeopleService } from '../../src/server/people/service.ts';
import type { User } from '../../src/server/types.ts';

let w: TestWorld; let people: PeopleService; let owner: User;
beforeAll(async () => {
  w = await world(); people = new PeopleService(w.deps);
  await people.bootstrapOwner({ email: 'own@x.io' });
  owner = await people.userByEmail('own@x.io');
  await people.setMode(owner, 'company');
  await people.addCompanySource(owner, 'Secret');
});
afterAll(async () => w.drop());

const tokenFrom = (url: string) => url.split('/claim/')[1]!;

describe('invite and claim (rule 8)', () => {
  test('an invite makes an invited user with no password and a 24h link', async () => {
    const { claimUrl } = await people.invite(owner, 'Mem@X.io', 'member');
    expect(claimUrl).toStartWith('http://127.0.0.1:8787/claim/');
    const [u] = await w.sql`select status, password_hash from users where email = 'mem@x.io'`;
    expect(u).toMatchObject({ status: 'invited', passwordHash: null });
  });

  test('claim sets the password once, activates, creates the private source and a ui client', async () => {
    const { claimUrl } = await people.invite(owner, 'm2@x.io', 'member');
    const r = await people.claim(tokenFrom(claimUrl), 'a-long-password', 'Mo');
    expect(r.user.status).toBe('active');
    expect(r.joinKey.startsWith('mbk_')).toBe(true);
    const [src] = await w.sql`select id from sources where owner_user_id = ${r.user.id}`;
    expect(src!.id).toBe('p-m2');
    expect(w.admin.live(r.user.id).map((c) => c.purpose)).toEqual(['ui']);
    await expect(people.claim(tokenFrom(claimUrl), 'again-password', null)).rejects.toMatchObject({ code: 'invite_invalid' });
  });

  test('an expired invite is refused', async () => {
    const { claimUrl } = await people.invite(owner, 'late@x.io', 'viewer');
    w.setNow(new Date(w.deps.now().getTime() + 25 * 3600_000));
    await expect(people.claim(tokenFrom(claimUrl), 'a-long-password', null)).rejects.toMatchObject({ code: 'invite_invalid' });
    w.setNow(new Date('2026-10-14T12:00:00Z'));
  });

  test('a short password is refused', async () => {
    const { claimUrl } = await people.invite(owner, 'short@x.io', 'member');
    await expect(people.claim(tokenFrom(claimUrl), 'short', null)).rejects.toMatchObject({ code: 'password_too_short' });
  });
});

describe('grants (rules 5, 6, 7)', () => {
  test('a member reads only granted company sources, never the owner private source', async () => {
    const m = await people.userByEmail('m2@x.io');
    expect(w.admin.live(m.id).find((c) => c.purpose === 'ui')!.readSources).toEqual([]);
    await people.grant(owner, m.id, 'c-company', true);
    const ui = w.admin.live(m.id).find((c) => c.purpose === 'ui')!;
    expect(ui.readSources).toEqual(['c-company']);
    expect(ui.readSources).not.toContain('p-own');
  });

  test('revoking a grant narrows before the DB row goes, and a gbrain failure changes nothing', async () => {
    const m = await people.userByEmail('m2@x.io');
    w.admin.failNext = 'rescopeClient';
    await expect(people.revokeGrant(owner, m.id, 'c-company')).rejects.toThrow();
    const [still] = await w.sql`select 1 from grants where user_id = ${m.id} and source_id = 'c-company'`;
    expect(still).toBeDefined();
    expect(w.admin.live(m.id).find((c) => c.purpose === 'ui')!.readSources).toEqual(['c-company']);
    await people.revokeGrant(owner, m.id, 'c-company');
    expect(w.admin.live(m.id).find((c) => c.purpose === 'ui')!.readSources).toEqual([]);
  });

  test('reconcile narrows before it widens', async () => {
    const m = await people.userByEmail('m2@x.io');
    await people.grant(owner, m.id, 'c-company', true);
    w.admin.calls = [];
    await people.changeAccess([m.id], async (tx) => {
      await tx`delete from grants where user_id = ${m.id} and source_id = 'c-company'`;
      await tx`insert into grants (user_id, source_id) values (${m.id}, 'c-secret')`;
    });
    // The first rescope is the intersection: neither the old nor the new source.
    const ui = w.admin.live(m.id).find((c) => c.purpose === 'ui')!;
    expect(ui.readSources).toEqual(['c-secret']);
    expect(w.admin.calls.filter((c) => c === 'rescopeClient').length).toBeGreaterThanOrEqual(2);
  });

  test('grants on a private source are refused', async () => {
    const m = await people.userByEmail('m2@x.io');
    await expect(people.grant(owner, m.id, 'p-own', true)).rejects.toMatchObject({ code: 'not_a_company_source' });
  });

  test('a member turns agent reads off for one source; only the agent client narrows', async () => {
    const m = await people.userByEmail('m2@x.io');
    await people.setAgentReads(m, 'c-secret', false);
    const live = w.admin.live(m.id);
    expect(live.find((c) => c.purpose === 'ui')!.readSources).toEqual(['c-secret']);
    expect(live.find((c) => c.purpose === 'agent')).toBeUndefined(); // no agent client issued yet
  });
});

describe('roles', () => {
  test('the owner promotes a member to admin; the admin then reads every company source', async () => {
    const m = await people.userByEmail('m2@x.io');
    await people.setRole(owner, m.id, 'admin');
    expect(w.admin.live(m.id).find((c) => c.purpose === 'ui')!.readSources.sort()).toEqual(['c-company', 'c-secret']);
  });

  test('a viewer promoted to member gets a private source', async () => {
    const { claimUrl } = await people.invite(owner, 'v@x.io', 'viewer');
    const { user } = await people.claim(tokenFrom(claimUrl), 'viewer-password', null);
    const [none] = await w.sql`select 1 from sources where owner_user_id = ${user.id}`;
    expect(none).toBeUndefined();
    await people.setRole(owner, user.id, 'member');
    const [src] = await w.sql`select id from sources where owner_user_id = ${user.id}`;
    expect(src!.id).toBe('p-v');
  });
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Add the methods to `PeopleService`**

```ts
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
```

- [ ] **Step 3: Run** — `bun run test:db` — Expected: PASS (including `people-mode.test.ts`).

- [ ] **Step 4: Commit**

```bash
git add src/server/people/service.ts test/db/people-mode.test.ts test/db/people-access.test.ts
git commit -m "feat(people): company mode, company sources, invites, claim, grants, roles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4.6: Offboarding

**Files:**
- Modify: `src/server/people/service.ts`
- Test: `test/db/people-offboard.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/db/people-offboard.test.ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { PeopleService } from '../../src/server/people/service.ts';
import type { User } from '../../src/server/types.ts';
import { createSession } from '../../src/server/auth.ts';

let w: TestWorld; let people: PeopleService; let owner: User; let m: User;
beforeAll(async () => {
  w = await world(); people = new PeopleService(w.deps);
  await people.bootstrapOwner({ email: 'own@x.io' });
  owner = await people.userByEmail('own@x.io');
  await people.setMode(owner, 'company');
  const { claimUrl } = await people.invite(owner, 'm@x.io', 'member');
  ({ user: m } = await people.claim(claimUrl.split('/claim/')[1]!, 'member-password', null));
  await people.grant(owner, m.id, 'c-company', true);
  await people.issueAgent(m);
  await createSession(w.sql, m.id, w.deps.now());
});
afterAll(async () => w.drop());

test('offboarding is resumable after a failure and ends fully disabled (rule 9)', async () => {
  w.admin.failNext = 'archiveSource';
  await expect(people.offboard(owner, m.id)).rejects.toThrow();
  const [mid] = await w.sql`select status from users where id = ${m.id}`;
  expect(mid!.status).toBe('offboarding');
  expect(w.admin.live(m.id)).toEqual([]);            // clients were revoked before the failure

  await people.offboard(owner, m.id);                 // second run finishes
  const [u] = await w.sql`select status from users where id = ${m.id}`;
  expect(u!.status).toBe('disabled');
  expect(w.admin.sources.get('p-m')!.archived).toBe(true);
  expect((await w.sql`select count(*)::int as n from grants where user_id = ${m.id}`)[0]!.n).toBe(0);
  expect((await w.sql`select count(*)::int as n from sessions where user_id = ${m.id}`)[0]!.n).toBe(0);
  expect((await w.sql`select count(*)::int as n from api_keys where user_id = ${m.id} and revoked_at is null`)[0]!.n).toBe(0);
});

test('offboarding the owner is refused', async () => {
  await expect(people.offboard(owner, owner.id)).rejects.toMatchObject({ code: 'owner_is_fixed' });
});

test('after offboarding, switching back to personal is allowed', async () => {
  await people.setMode(owner, 'personal');
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Add `offboard` to `PeopleService`**

```ts
  /** Idempotent and resumable: each step acts only on what is left (rule 9). */
  async offboard(actor: User, userId: string): Promise<void> {
    const target = await this.user(userId);
    assertCanOffboard(actor, target);
    if (target.status === 'disabled') return;
    await this.d.sql`update users set status = 'offboarding' where id = ${userId}`;
    await audit(this.d.sql, actor.id, 'member.offboard.start', target.email);

    for (const row of await this.liveClients(userId, ['agent', 'ui', 'company_writer'])) await this.revokeRow(row);
    for (const s of await this.d.sql<{ id: string }[]>`select id from sources where owner_user_id = ${userId} and status = 'active'`) {
      await this.d.admin.archiveSource(s.id);
      await this.d.sql`update sources set status = 'archived' where id = ${s.id}`;
    }
    await this.d.sql.begin(async (tx) => {
      await tx`delete from grants where user_id = ${userId}`;
      await tx`delete from sessions where user_id = ${userId}`;
      await tx`update api_keys set revoked_at = now() where user_id = ${userId} and revoked_at is null`;
      await tx`update users set status = 'disabled' where id = ${userId}`;
    });
    await audit(this.d.sql, actor.id, 'member.offboard.done', target.email);
  }
```

- [ ] **Step 3: Run** — Expected: PASS after task 4.7 adds `issueAgent` (used in `beforeAll`). Implement 4.7, then run both.

---

### Task 4.7: Client issue and rotation

**Files:**
- Modify: `src/server/people/service.ts`
- Test: `test/db/people-clients.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/db/people-clients.test.ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { PeopleService } from '../../src/server/people/service.ts';
import type { User } from '../../src/server/types.ts';

let w: TestWorld; let people: PeopleService; let owner: User;
beforeAll(async () => {
  w = await world(); people = new PeopleService(w.deps);
  await people.bootstrapOwner({ email: 'own@x.io' });
  owner = await people.userByEmail('own@x.io');
});
afterAll(async () => w.drop());

test('issueAgent returns the token once, stores only the expiry, and rotates the previous agent client', async () => {
  const a = await people.issueAgent(owner);
  expect(a.token.startsWith('tok-')).toBe(true);
  expect(a.mcpUrl).toBe('http://127.0.0.1:8787/mcp');
  const [row] = await w.sql`select token_enc, expires_at from gbrain_clients where purpose = 'agent' and revoked_at is null`;
  expect(row!.tokenEnc).toBeNull();
  expect(row!.expiresAt).toBeInstanceOf(Date);
  const b = await people.issueAgent(owner);
  expect(b.token).not.toBe(a.token);
  expect((await w.sql`select count(*)::int as n from gbrain_clients where purpose = 'agent' and revoked_at is null`)[0]!.n).toBe(1);
});

test('myClients lists purpose and expiry, never tokens', async () => {
  const list = await people.myClients(owner);
  expect(list.map((c) => c.purpose).sort()).toEqual(['agent', 'ui']);
  expect(JSON.stringify(list)).not.toContain('tok-');
});

test('a company writer needs company mode and an admin', async () => {
  await expect(people.issueCompanyWriter(owner, 'c-company')).rejects.toMatchObject({ code: 'company_mode_required' });
  await people.setMode(owner, 'company');
  const cw = await people.issueCompanyWriter(owner, 'c-company');
  expect(w.admin.live(owner.id).find((s) => s.purpose === 'company_writer')!.writeSource).toBe('c-company');
  expect(cw.registrationName).toBe('gbrain-company-c-company');
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Add the methods**

```ts
  // ---- issuing clients to people ---------------------------------------------

  private mcpUrl(): string { return `${this.d.env.publicUrl}/mcp`; }

  async issueAgent(user: User): Promise<{ token: string; mcpUrl: string; expiresAt: Date | null; registrationName: string }> {
    const want = compileUserClients(user, await this.state()).find((s) => s.purpose === 'agent');
    if (!want) throw new HttpError(409, 'no_agent_access');
    const old = await this.liveClients(user.id, ['agent']);
    const issued = await this.d.admin.createClient(want);
    await this.storeClient(want, issued, false);
    for (const r of old) await this.revokeRow(r);
    await audit(this.d.sql, user.id, 'client.issue', 'agent');
    return { token: issued.token, mcpUrl: this.mcpUrl(), expiresAt: issued.expiresAt, registrationName: 'gbrain' };
  }

  async issueCompanyWriter(user: User, sourceId: string) {
    assertCompanyMode(await getMode(this.d.sql));
    this.assertManager(user);
    await this.companySource(sourceId);
    const spec = companyWriterSpec(user, sourceId);
    const old = (await this.liveClients(user.id, ['company_writer'])).filter((r) => r.writeSource === sourceId);
    const issued = await this.d.admin.createClient(spec);
    await this.storeClient(spec, issued, false);
    for (const r of old) await this.revokeRow(r);
    await audit(this.d.sql, user.id, 'client.issue', `company_writer:${sourceId}`);
    return { token: issued.token, mcpUrl: this.mcpUrl(), expiresAt: issued.expiresAt, registrationName: `gbrain-company-${sourceId}` };
  }

  async myClients(user: User): Promise<{ purpose: ClientPurpose; writeSource: string | null; expiresAt: Date | null }[]> {
    return (await this.liveClients(user.id, ['agent', 'ui', 'company_writer']))
      .map(({ purpose, writeSource, expiresAt }) => ({ purpose, writeSource, expiresAt }));
  }
```

- [ ] **Step 3: Run** — `bun run test:db` — Expected: PASS (clients and offboard tests).

- [ ] **Step 4: Commit**

```bash
git add src/server/people/service.ts test/db/people-offboard.test.ts test/db/people-clients.test.ts
git commit -m "feat(people): resumable offboarding, agent and company-writer issue with rotation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4.8: People, claim and client routes

**Files:**
- Create: `src/server/routes/people.ts`
- Modify: `src/server/app.ts` (mount after `authRoutes`)
- Test: `test/db/routes-people.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/db/routes-people.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { PeopleService } from '../../src/server/people/service.ts';

let w: TestWorld; let ownerKey: string; let memberKey: string; let memberId: string;
beforeAll(async () => {
  w = await world();
  const people = new PeopleService(w.deps);
  ({ apiKey: ownerKey } = await people.bootstrapOwner({ email: 'own@x.io' }));
});
afterAll(async () => w.drop());

const post = (path: string, body: unknown, as?: string) => w.req(path, { method: 'POST', body: JSON.stringify(body), as });

describe('people routes', () => {
  test('mode switch is owner only and turns on company mode', async () => {
    expect((await post('/api/people/mode', { mode: 'company' })).status).toBe(401);
    expect((await post('/api/people/mode', { mode: 'company' }, ownerKey)).status).toBe(200);
  });

  test('invite returns a claim URL; claim info and claim are public', async () => {
    const r = await (await post('/api/people/invite', { email: 'm@x.io', role: 'member' }, ownerKey)).json();
    const token = r.claimUrl.split('/claim/')[1];
    expect(await (await w.req(`/api/claim/${token}`)).json()).toEqual({ email: 'm@x.io', role: 'member' });
    const c = await post(`/api/claim/${token}`, { password: 'member-password', name: 'M' });
    expect(c.status).toBe(200);
    expect(c.headers.get('set-cookie')).toContain('mobrain_session=');
    const body = await c.json();
    memberKey = body.joinKey; memberId = body.user.id;
  });

  test('members cannot list or manage people', async () => {
    expect((await w.req('/api/people', { as: memberKey })).status).toBe(403);
    expect((await post('/api/people/invite', { email: 'z@x.io', role: 'member' }, memberKey)).status).toBe(403);
  });

  test('owner lists people with grants and sources', async () => {
    await w.req(`/api/people/${memberId}/grants/c-company`, { method: 'PUT', body: JSON.stringify({ agentReads: true }), as: ownerKey });
    const r = await (await w.req('/api/people', { as: ownerKey })).json();
    expect(r.mode).toBe('company');
    const m = r.users.find((u: { id: string }) => u.id === memberId);
    expect(m.grants).toEqual([{ sourceId: 'c-company', agentReads: true }]);
    expect(r.sources.map((s: { id: string }) => s.id)).toContain('c-company');
    expect(JSON.stringify(r)).not.toContain('passwordHash');
  });

  test('a member issues their own agent client and sees it listed', async () => {
    const r = await (await post('/api/clients/issue', { purpose: 'agent' }, memberKey)).json();
    expect(r.token.startsWith('tok-')).toBe(true);
    const list = await (await w.req('/api/clients/me', { as: memberKey })).json();
    expect(list.clients.map((c: { purpose: string }) => c.purpose).sort()).toEqual(['agent', 'ui']);
  });

  test('a member flips agent reads on their own grant', async () => {
    const r = await w.req('/api/me/grants/c-company', { method: 'PATCH', body: JSON.stringify({ agentReads: false }), as: memberKey });
    expect(r.status).toBe(200);
  });

  test('offboard via route', async () => {
    expect((await post(`/api/people/${memberId}/offboard`, {}, ownerKey)).status).toBe(200);
    expect((await w.req('/api/me', { as: memberKey })).status).toBe(401);
  });

  test('every mutation was audited', async () => {
    const actions = (await w.sql`select action from audit_log order by id`).map((r) => r.action);
    for (const a of ['bootstrap', 'mode.set', 'member.invite', 'member.claim', 'grant.add', 'client.issue', 'grant.agent_reads', 'member.offboard.done']) {
      expect(actions).toContain(a);
    }
  });
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Write `src/server/routes/people.ts`**

```ts
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Deps } from '../app.ts';
import { createSession } from '../auth.ts';
import { getMode } from '../db/index.ts';
import { HttpError, jsonBody, requireRole, requireUser, SESSION_COOKIE, type AppEnv } from '../http.ts';
import { PeopleService } from '../people/service.ts';
import type { Role } from '../types.ts';

const ROLES: Role[] = ['admin', 'member', 'viewer'];

export function peopleRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const people = new PeopleService(deps);
  const managers = requireRole('owner', 'admin');

  r.get('/api/people', managers, async (c) => {
    const users = await deps.sql`select id, email, name, role, status, created_at from users order by created_at`;
    const grants = await deps.sql<{ userId: string; sourceId: string; agentReads: boolean }[]>`select user_id, source_id, agent_reads from grants`;
    const sources = await deps.sql`select id, kind, owner_user_id, name, status from sources order by kind, id`;
    return c.json({
      mode: await getMode(deps.sql),
      users: users.map((u) => ({ ...u, grants: grants.filter((g) => g.userId === u.id).map(({ sourceId, agentReads }) => ({ sourceId, agentReads })) })),
      sources,
    });
  });

  r.post('/api/people/mode', requireRole('owner'), async (c) => {
    const { mode } = await jsonBody<{ mode?: string }>(c);
    if (mode !== 'company' && mode !== 'personal') throw new HttpError(400, 'invalid_mode');
    await people.setMode(requireUser(c), mode);
    return c.json({ ok: true, mode });
  });

  r.post('/api/people/invite', managers, async (c) => {
    const { email, role } = await jsonBody<{ email?: string; role?: Role }>(c);
    if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, 'invalid_email');
    if (!role || !ROLES.includes(role)) throw new HttpError(400, 'invalid_role');
    return c.json(await people.invite(requireUser(c), email, role));
  });

  r.post('/api/people/:id/role', managers, async (c) => {
    const { role } = await jsonBody<{ role?: Role }>(c);
    if (!role || !ROLES.includes(role)) throw new HttpError(400, 'invalid_role');
    await people.setRole(requireUser(c), c.req.param('id'), role);
    return c.json({ ok: true });
  });

  r.post('/api/people/:id/offboard', managers, async (c) => {
    await people.offboard(requireUser(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  r.put('/api/people/:id/grants/:sourceId', managers, async (c) => {
    const { agentReads } = await jsonBody<{ agentReads?: boolean }>(c);
    await people.grant(requireUser(c), c.req.param('id'), c.req.param('sourceId'), agentReads !== false);
    return c.json({ ok: true });
  });

  r.delete('/api/people/:id/grants/:sourceId', managers, async (c) => {
    await people.revokeGrant(requireUser(c), c.req.param('id'), c.req.param('sourceId'));
    return c.json({ ok: true });
  });

  r.post('/api/sources/company', managers, async (c) => {
    const { name } = await jsonBody<{ name?: string }>(c);
    if (!name?.trim()) throw new HttpError(400, 'name_required');
    return c.json({ id: await people.addCompanySource(requireUser(c), name.trim()) });
  });

  r.post('/api/sources/:id/archive', managers, async (c) => {
    await people.archiveCompanySource(requireUser(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  r.patch('/api/me/grants/:sourceId', async (c) => {
    const { agentReads } = await jsonBody<{ agentReads?: boolean }>(c);
    if (typeof agentReads !== 'boolean') throw new HttpError(400, 'agentReads_required');
    await people.setAgentReads(requireUser(c), c.req.param('sourceId'), agentReads);
    return c.json({ ok: true });
  });

  r.get('/api/claim/:token', async (c) => c.json(await people.inviteInfo(c.req.param('token'))));

  r.post('/api/claim/:token', async (c) => {
    const { password, name } = await jsonBody<{ password?: string; name?: string }>(c);
    if (!password) throw new HttpError(400, 'password_required');
    const result = await people.claim(c.req.param('token'), password, name ?? null);
    const session = await createSession(deps.sql, result.user.id, deps.now());
    setCookie(c, SESSION_COOKIE, session, { httpOnly: true, sameSite: 'Lax', secure: deps.env.secureCookies, path: '/', maxAge: 30 * 86400 });
    return c.json(result);
  });

  r.post('/api/clients/issue', async (c) => {
    const user = requireUser(c);
    const { purpose, sourceId } = await jsonBody<{ purpose?: string; sourceId?: string }>(c);
    if (purpose === 'agent') return c.json(await people.issueAgent(user));
    if (purpose === 'company_writer' && sourceId) return c.json(await people.issueCompanyWriter(user, sourceId));
    throw new HttpError(400, 'invalid_purpose');
  });

  r.get('/api/clients/me', async (c) => c.json({ clients: await people.myClients(requireUser(c)) }));

  return r;
}
```

- [ ] **Step 3: Mount it** — in `createApp`, after `app.route('/', authRoutes(deps));` add `app.route('/', peopleRoutes(deps));` and the import.

- [ ] **Step 4: Run** — `bun run test:db` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/people.ts src/server/app.ts test/db/routes-people.test.ts
git commit -m "feat(people): people, claim and client routes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4.9: Container admin CLI (bootstrap, password reset)

**Files:**
- Create: `src/server/admin-cli.ts`
- Test: `test/db/admin-cli.test.ts`

`bin/mobrain install` runs this inside the `mobrain` container: `docker compose exec -T mobrain bun src/server/admin-cli.ts bootstrap --email <e> [--name <n>]`. It prints one JSON line.

- [ ] **Step 1: Write the failing test**

```ts
// test/db/admin-cli.test.ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { runAdminCli } from '../../src/server/admin-cli.ts';

let w: TestWorld;
beforeAll(async () => { w = await world(); });
afterAll(async () => w.drop());

test('bootstrap prints userId, password and apiKey as JSON', async () => {
  const out = await runAdminCli(['bootstrap', '--email', 'own@x.io', '--name', 'Own'], w.deps);
  const j = JSON.parse(out);
  expect(Object.keys(j).sort()).toEqual(['apiKey', 'password', 'userId']);
});

test('reset-password prints a new password that logs in', async () => {
  const j = JSON.parse(await runAdminCli(['reset-password', '--email', 'own@x.io'], w.deps));
  const r = await w.req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'own@x.io', password: j.password }) });
  expect(r.status).toBe(200);
});

test('unknown command is an error', async () => {
  await expect(runAdminCli(['nope'], w.deps)).rejects.toThrow(/usage/);
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Write `src/server/admin-cli.ts`**

```ts
import type { Deps } from './app.ts';
import { hashPassword } from './auth.ts';
import { newToken } from './crypto.ts';
import { PeopleService } from './people/service.ts';

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function runAdminCli(argv: string[], deps: Deps): Promise<string> {
  const people = new PeopleService(deps);
  const [cmd] = argv;
  if (cmd === 'bootstrap') {
    const email = flag(argv, 'email');
    if (!email) throw new Error('usage: bootstrap --email <e> [--name <n>]');
    return JSON.stringify(await people.bootstrapOwner({ email, name: flag(argv, 'name') }));
  }
  if (cmd === 'reset-password') {
    const email = flag(argv, 'email');
    if (!email) throw new Error('usage: reset-password --email <e>');
    const user = await people.userByEmail(email.toLowerCase());
    const password = newToken().slice(0, 24);
    await deps.sql`update users set password_hash = ${await hashPassword(password)} where id = ${user.id}`;
    await deps.sql`delete from sessions where user_id = ${user.id}`;
    return JSON.stringify({ email: user.email, password });
  }
  throw new Error('usage: admin-cli.ts bootstrap|reset-password ...');
}

if (import.meta.main) {
  const { loadEnv } = await import('./env.ts');
  const { connect } = await import('./db/index.ts');
  const { migrate } = await import('./db/migrate.ts');
  const { CliGbrainAdmin } = await import('./gbrain/admin.ts');
  const { runGbrain } = await import('./gbrain/cli.ts');
  const { mcpCaller } = await import('./gbrain/mcp.ts');
  const env = loadEnv();
  const sql = connect(env.databaseUrl);
  await migrate(sql);
  try {
    console.log(await runAdminCli(process.argv.slice(2), {
      sql, env, admin: new CliGbrainAdmin(runGbrain, env.publicUrl),
      mcp: (t) => mcpCaller(`${env.gbrainUrl}/mcp`, t), cli: runGbrain, fetch, now: () => new Date(),
    }));
  } catch (e) {
    console.error(String((e as Error).message ?? e));
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
```

- [ ] **Step 3: Run** — `bun run test:db` — Expected: PASS.

- [ ] **Step 4: Live check on dev**

```bash
cd ~/MO-BRAIN
dc() { docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml "$@"; }
dc build mobrain && dc up -d --wait
dc exec -T mobrain bun src/server/admin-cli.ts bootstrap --email dev@local.test
curl -s -X POST http://127.0.0.1:8788/api/clients/issue -H "authorization: Bearer <apiKey from above>" \
  -H 'content-type: application/json' -d '{"purpose":"agent"}'
```

Expected: bootstrap JSON; the issue call returns a real gbrain token and `mcpUrl`. Then call `whoami` through the proxy with that token:

```bash
curl -s http://127.0.0.1:8788/mcp -H "authorization: Bearer <token>" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
dc down
```

Expected: a `whoami` result naming client `mb-agent-…` and source `p-dev`. If the stack was bootstrapped already, wipe dev first with `dc down -v` (dev only).

- [ ] **Step 5: Commit**

```bash
git add src/server/admin-cli.ts test/db/admin-cli.test.ts
git commit -m "feat(server): in-container admin CLI for bootstrap and password reset

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
