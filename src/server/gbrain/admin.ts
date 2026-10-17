import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { assertOk, runGbrain, scrub, type CliResult } from './cli.ts';
import type { ClientSpec, IssuedClient } from '../types.ts';

export interface GbrainAdmin {
  createClient(spec: ClientSpec): Promise<IssuedClient>;
  rescopeClient(clientId: string, spec: ClientSpec): Promise<void>;
  revokeClient(clientId: string): Promise<void>;
  addSource(id: string, name: string): Promise<void>;
  archiveSource(id: string): Promise<void>;
}

/** gbrain caps grant tokens at 90 days (P2). Rotation handles the rest. */
export const CLIENT_TTL_SECONDS = 7_776_000;

type Run = (argv: string[], opts?: { timeoutMs?: number }) => Promise<CliResult>;

/** Write source plus extra reads. Probe P7: without the write source the client cannot read its own write. Probe P2: `--federated-read ''` is `read_source_inactive`. */
export function federatedReadIds(spec: ClientSpec): string[] {
  return [...new Set([spec.writeSource, ...spec.readSources])].filter((id) => id.length > 0).sort();
}

export function grantArgv(spec: ClientSpec, credentialsOut: string, mcpUrl: string): string[] {
  const argv = ['mcp', 'grant', spec.name, '--profile', spec.profile, '--source', spec.writeSource];
  const reads = federatedReadIds(spec);
  if (reads.length > 0) argv.push('--federated-read', reads.join(','));
  argv.push('--token-ttl', String(CLIENT_TTL_SECONDS), '--credentials-out', credentialsOut, '--url', mcpUrl, '--json');
  return argv;
}

export function rescopeArgv(clientId: string, spec: ClientSpec): string[] {
  return ['auth', 'rescope-client', clientId, '--source', spec.writeSource, '--profile', spec.profile,
    '--federated-read', federatedReadIds(spec).join(','), '--json'];
}

export function parseCredentials(json: unknown): IssuedClient {
  const o = (json ?? {}) as Record<string, unknown>;
  const nested = (o.credentials && typeof o.credentials === 'object' ? o.credentials : {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) for (const src of [o, nested]) if (typeof src[k] === 'string' && src[k]) return src[k] as string;
    return null;
  };
  const token = pick('access_token', 'accessToken', 'token', 'bearer');
  const clientId = pick('client_id', 'clientId');
  if (!token) throw new Error('credentials file has no token');
  if (!clientId) throw new Error('credentials file has no client id');
  const exp = [o, nested].map((src) => src.expires_at ?? src.expiresAt).find((v) => v != null);
  let expiresAt: Date | null = null;
  if (typeof exp === 'number') expiresAt = new Date(exp * 1000);
  else if (typeof exp === 'string' && exp) expiresAt = /^\d+$/.test(exp) ? new Date(Number(exp) * 1000) : new Date(exp);
  return { clientId, token, expiresAt };
}

/** The MCP URL an issued client stores. gbrain requires https or loopback http
 * (assertSecureEndpoint, mcp-provision.ts:31); the operator's public URL is the
 * only endpoint the eventual agent can reach, so it — not the container-internal
 * gbrain origin — is what the credential carries. */
export function clientMcpUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/mcp`;
}

/**
 * Issuance over gbrain's owner admin HTTP API (serve-http-grants.ts,
 * serve-http-clients.ts). The loopback/HTTPS credential rule is client-side in
 * the CLI (mcp-admin-http.ts); a plain HTTP client on the compose network
 * decouples the admin base URL from the credential's public URL, so the rule
 * stays satisfied by construction: we POST to env.gbrainUrl and deliver
 * env.publicUrl. addSource/archiveSource have no admin endpoint; they keep
 * using the CLI.
 */
export class HttpGbrainAdmin implements GbrainAdmin {
  private cookie: string | null = null;

  constructor(
    private fetchImpl: typeof fetch,
    private gbrainUrl: string,
    private publicUrl: string,
    private adminToken: string,
    private sourceAdmin: Pick<GbrainAdmin, 'addSource' | 'archiveSource'> = new CliGbrainAdmin(runGbrain, gbrainUrl),
  ) {}

  private async session(): Promise<string> {
    if (this.cookie) return this.cookie;
    const res = await this.fetchImpl(`${this.gbrainUrl}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: this.adminToken }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`gbrain admin login failed: HTTP ${res.status}`);
    const cookie = res.headers.get('set-cookie')?.match(/(gbrain_admin=[^;,\s]+)/)?.[1];
    if (!cookie) throw new Error('gbrain admin login returned no session cookie');
    this.cookie = cookie;
    return cookie;
  }

  private async request(path: string, label: string, body: unknown): Promise<Record<string, unknown>> {
    let res = await this.send(path, body);
    // A restarted gbrain drops its in-memory admin sessions; re-authenticate once.
    if (res.status === 401) { this.cookie = null; res = await this.send(path, body); }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail = json && (json.message ?? json.error);
      throw new Error(`${label} failed: HTTP ${res.status}${detail ? ` ${scrub(String(detail))}` : ''}`);
    }
    if (!json || typeof json !== 'object') throw new Error(`${label} returned no JSON`);
    return json;
  }

  private async send(path: string, body: unknown): Promise<Response> {
    const cookie = await this.session();
    return this.fetchImpl(`${this.gbrainUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
  }

  async createClient(spec: ClientSpec): Promise<IssuedClient> {
    const json = await this.request('/admin/api/grants', 'mcp grant', {
      name: spec.name, harness: 'generic', profile: spec.profile,
      sourceId: spec.writeSource, url: clientMcpUrl(this.publicUrl),
      patch: { federatedRead: federatedReadIds(spec), tokenTtlSeconds: CLIENT_TTL_SECONDS },
    });
    return parseCredentials(json);
  }

  async rescopeClient(clientId: string, spec: ClientSpec): Promise<void> {
    // profile is an extra key, so gbrain takes the extended edit path and
    // re-resolves the grant the way the CLI's `auth rescope-client` does.
    await this.request('/admin/api/rescope-client', 'auth rescope-client', {
      clientId, sourceId: spec.writeSource, federatedRead: federatedReadIds(spec), profile: spec.profile,
    });
  }

  async revokeClient(clientId: string): Promise<void> {
    // Silent when the client is unknown, matching the CLI's tolerance.
    await this.request('/admin/api/revoke-client', 'auth revoke-client', { clientId });
  }

  addSource(id: string, name: string): Promise<void> {
    return this.sourceAdmin.addSource(id, name);
  }

  archiveSource(id: string): Promise<void> {
    return this.sourceAdmin.archiveSource(id);
  }
}

export class CliGbrainAdmin implements GbrainAdmin {
  /** mcpBase is the gbrain origin this process can reach, not MOBRAIN_PUBLIC_URL. */
  constructor(private run: Run = runGbrain, private mcpBase: string) {}

  private mcpUrl(): string {
    return this.mcpBase.endsWith('/mcp') ? this.mcpBase : `${this.mcpBase}/mcp`;
  }

  async createClient(spec: ClientSpec): Promise<IssuedClient> {
    const file = join(tmpdir(), `mb-cred-${crypto.randomUUID()}.json`);
    try {
      assertOk('mcp grant', await this.run(grantArgv(spec, file, this.mcpUrl()), { timeoutMs: 60_000 }));
      return parseCredentials(await Bun.file(file).json());
    } finally {
      await rm(file, { force: true });
    }
  }

  async rescopeClient(clientId: string, spec: ClientSpec): Promise<void> {
    assertOk('auth rescope-client', await this.run(rescopeArgv(clientId, spec)));
  }

  async revokeClient(clientId: string): Promise<void> {
    const r = await this.run(['auth', 'revoke-client', clientId]);
    // Revoking an already-revoked client is success for our purposes.
    if (r.exitCode !== 0 && !/not found|already revoked/i.test(r.stderr + r.stdout)) assertOk('auth revoke-client', r);
  }

  async addSource(id: string, name: string): Promise<void> {
    // Probe P5: `--json` is an unknown flag on `sources add`. No path; DB-only sources have local_path null.
    const r = await this.run(['sources', 'add', id, '--name', name]);
    if (r.exitCode !== 0 && !/already exists/i.test(r.stderr + r.stdout)) assertOk('sources add', r);
  }

  async archiveSource(id: string): Promise<void> {
    // Probe P5: `--yes` is invalid_params on `sources archive` (it takes
    // --request-id/--expected-incarnation/--json/--dry-run); the archive itself
    // is not interactive.
    const r = await this.run(['sources', 'archive', id]);
    if (r.exitCode !== 0 && !/already archived|not found/i.test(r.stderr + r.stdout)) assertOk('sources archive', r);
  }
}
