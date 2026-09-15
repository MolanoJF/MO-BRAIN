import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const caddyfile = readFileSync('compose/Caddyfile', 'utf8');

// Paths gbrain-serve owns. /health and /metrics are LIVE COLLISIONS with a
// naive console mount — the console uses /api/health instead.
const GBRAIN_PATHS = [
  '/mcp', '/authorize', '/token', '/register', '/revoke',
  '/.well-known/*', '/ingest', '/webhooks/*', '/health', '/metrics',
];

describe('Caddyfile routing contract (text)', () => {
  test.each(GBRAIN_PATHS)('%s routes to gbrain-serve', (p) => {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(caddyfile).toMatch(new RegExp(escaped));
  });

  // S1: gbrain's embedded admin SPA is a second control plane with god rights
  // over the same brain, authenticated by a bootstrap token rather than our
  // RBAC. It is never routed publicly. Break-glass is the recovery path.
  test('no /admin route exists', () => {
    expect(caddyfile).not.toMatch(/^\s*(handle|route|reverse_proxy).*\/admin/m);
  });

  // Text can only prove the *shape* is present, not that it wins at compile
  // time — see the "compiled" describe block below for that proof. This
  // pins the textual form the S1 fix requires: /admin must be refused from
  // inside a `handle` block, never a bare top-level `respond`. Caddy's
  // default directive order sorts `respond` after `handle`, so a bare
  // top-level `respond @admin_denied 404` would be unreachable dead config
  // — the catch-all `handle {}` (written last, but also a `handle`) would
  // win first. That was the original drafted form of this Caddyfile, and it
  // is why this assertion checks for the `handle`-wrapped form specifically
  // rather than merely for the string "respond ... 404" appearing anywhere.
  test('/admin is refused via a `handle` block, not a bare top-level `respond`', () => {
    expect(caddyfile).toMatch(/@admin_denied/);
    expect(caddyfile).toMatch(/handle @admin_denied\s*\{\s*\n\s*respond 404/);
  });

  test('/api/* routes to control-plane', () => {
    expect(caddyfile).toMatch(/\/api\/\*[\s\S]{0,200}control-plane:3150/);
  });

  test('TLS is driven by the DOMAIN env var', () => {
    expect(caddyfile).toMatch(/\{\$DOMAIN\}/);
  });

  test('security headers are set on every response', () => {
    expect(caddyfile).toMatch(/Strict-Transport-Security/);
    // The header directive quotes its value (`X-Content-Type-Options
    // "nosniff"`); the value itself has no surrounding whitespace to match.
    expect(caddyfile).toMatch(/X-Content-Type-Options\s+"nosniff"/);
  });
});

// ---------------------------------------------------------------------------
// Compiled-behavior assertions.
//
// The Caddyfile's /admin seal was first drafted as a bare top-level
// `respond @admin_denied 404`. Caddy's default directive order sorts
// `respond` *after* `handle`, so compiling that draft put the catch-all
// `handle {}` block ahead of it — route 3 (match=None, terminal) proxied
// every request to control-plane, including /admin, before route 4 (the
// 404) was ever reached. A test that only reads the Caddyfile's *text*
// would have found the string `respond @admin_denied 404` present and gone
// green, even though compiled behavior served /admin as 200 from the
// console SPA — proving nothing about what Caddy actually does.
//
// These tests compile the real Caddyfile with real Caddy (`caddy adapt`)
// and assert on the resulting route order, so the /admin seal is proven
// against compiled behavior, not file contents. Skipped cleanly when
// Docker isn't available, matching compose-invariants.test.ts.
// ---------------------------------------------------------------------------
const dockerAvailable = Bun.which('docker') !== null;

function adaptCaddyfile(): any {
  // Resolved to an absolute host path and handed straight to Bun's
  // spawnSync (not through a shell), so Git Bash's MSYS path-mangling
  // (which only rewrites args a POSIX shell parses before exec) does not
  // apply here — unlike invoking `docker` from a bash command line.
  const dir = resolve('compose');
  const proc = Bun.spawnSync([
    'docker', 'run', '--rm',
    '-e', 'DOMAIN=example.test',
    '-v', `${dir}:/w`,
    '-w', '/w',
    'caddy:2',
    'caddy', 'adapt', '--config', '/w/Caddyfile',
  ]);
  if (proc.exitCode !== 0) {
    throw new Error(`caddy adapt failed (exit ${proc.exitCode}): ${proc.stderr.toString()}`);
  }
  return JSON.parse(proc.stdout.toString());
}

describe('Caddyfile compiled routing contract (real caddy adapt)', () => {
  test.skipIf(!dockerAvailable)('the Caddyfile adapts cleanly to valid Caddy JSON', () => {
    expect(() => adaptCaddyfile()).not.toThrow();
  });

  test.skipIf(!dockerAvailable)(
    '/admin compiles to a 404 seal positioned ahead of the catch-all route',
    () => {
      const compiled = adaptCaddyfile();
      const hostRoutes = compiled.apps.http.servers.srv0.routes[0].handle[0].routes as any[];

      const adminIdx = hostRoutes.findIndex((r) =>
        r.match?.some((m: any) => Array.isArray(m.path) && m.path.includes('/admin')),
      );
      // The catch-all is the route with no `match` whose action is a
      // reverse_proxy. Route 0 (headers + encode setup) also has no
      // `match`, but isn't a reverse_proxy, so it's excluded here.
      const catchAllIdx = hostRoutes.findIndex(
        (r) => !r.match && r.handle?.[0]?.routes?.[0]?.handle?.[0]?.handler === 'reverse_proxy',
      );

      expect(adminIdx).toBeGreaterThanOrEqual(0);
      expect(catchAllIdx).toBeGreaterThanOrEqual(0);
      // This is the actual seal: if this were false, /admin would fall
      // through to the catch-all and be proxied to the control plane's
      // console SPA — exactly the defect in the original draft.
      expect(adminIdx).toBeLessThan(catchAllIdx);

      const adminAction = hostRoutes[adminIdx].handle[0].routes[0].handle[0];
      expect(adminAction.handler).toBe('static_response');
      expect(adminAction.status_code).toBe(404);
    },
  );

  test.skipIf(!dockerAvailable)(
    'compiled route order is admin, then gbrain-serve paths, then /api/*, then the catch-all',
    () => {
      const compiled = adaptCaddyfile();
      const hostRoutes = compiled.apps.http.servers.srv0.routes[0].handle[0].routes as any[];

      const dialOf = (r: any) => r.handle?.[0]?.routes?.[0]?.handle?.[0]?.upstreams?.[0]?.dial;
      const pathsOf = (r: any): string[] | undefined => r.match?.[0]?.path;

      const kinds = hostRoutes.map((r) => {
        const paths = pathsOf(r);
        if (paths?.includes('/admin')) return 'admin';
        if (paths?.includes('/api/*')) return 'api';
        if (paths?.includes('/mcp')) return 'gbrain';
        if (!r.match && dialOf(r) === 'control-plane:3150') return 'catch-all';
        return 'other'; // the header/encode setup route, which has no path match
      });

      expect(kinds.filter((k) => k !== 'other')).toEqual(['admin', 'gbrain', 'api', 'catch-all']);
    },
  );
});
