// test/unit/fakes.ts
import type { GbrainAdmin } from '../../src/server/gbrain/admin.ts';
import type { ClientSpec, IssuedClient } from '../../src/server/types.ts';

export class FakeGbrainAdmin implements GbrainAdmin {
  clients = new Map<string, { spec: ClientSpec; token: string; revoked: boolean }>();
  sources = new Map<string, { name: string; archived: boolean }>();
  calls: string[] = [];
  failNext: string | null = null;
  private n = 0;

  private maybeFail(op: string) {
    this.calls.push(op);
    if (this.failNext === op) { this.failNext = null; throw new Error(`fake ${op} failure`); }
  }
  async createClient(spec: ClientSpec): Promise<IssuedClient> {
    this.maybeFail('createClient');
    const clientId = `c${++this.n}`;
    const token = `tok-${clientId}`;
    this.clients.set(clientId, { spec, token, revoked: false });
    return { clientId, token, expiresAt: new Date(Date.now() + 90 * 86400_000) };
  }
  async rescopeClient(clientId: string, spec: ClientSpec): Promise<void> {
    this.maybeFail('rescopeClient');
    const c = this.clients.get(clientId);
    if (!c) throw new Error(`no client ${clientId}`);
    c.spec = spec;
  }
  async revokeClient(clientId: string): Promise<void> {
    this.maybeFail('revokeClient');
    const c = this.clients.get(clientId);
    if (c) c.revoked = true;
  }
  async addSource(id: string, name: string): Promise<void> {
    this.maybeFail('addSource');
    this.sources.set(id, { name, archived: false });
  }
  async archiveSource(id: string): Promise<void> {
    this.maybeFail('archiveSource');
    const s = this.sources.get(id);
    if (s) s.archived = true;
  }
  /** Live (not revoked) specs for one user, for assertions. */
  live(userId: string | null): ClientSpec[] {
    return [...this.clients.values()].filter((c) => !c.revoked && c.spec.userId === userId).map((c) => c.spec);
  }
}
