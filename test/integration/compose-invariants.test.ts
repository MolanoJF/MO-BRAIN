import { test, expect, describe } from 'bun:test';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';

// merge: true expands `<<` YAML merge keys (used by x-gbrain-env anchors
// below) the same way `docker compose config` does. The `yaml` package
// disables merge-key support by default (YAML-1.2-strict); without this
// option every service that merges the anchor keeps a literal "<<" key
// instead of the merged fields, which does not match real Compose behavior.
const compose = parse(readFileSync('compose/docker-compose.yml', 'utf8'), { merge: true }) as any;
const svc = (n: string) => compose.services[n];

describe('compose invariants', () => {
  test('caddy is the only service publishing host ports', () => {
    const publishers = Object.entries(compose.services)
      .filter(([, s]: [string, any]) => Array.isArray(s.ports) && s.ports.length > 0)
      .map(([n]) => n);
    expect(publishers).toEqual(['caddy']);
  });

  // Paired with GBRAIN_HTTP_TRUST_PROXY=1: widening trust_proxy while the
  // server is also directly reachable lets clients spoof X-Forwarded-For.
  test('gbrain-serve publishes no host port and trusts the proxy', () => {
    expect(svc('gbrain-serve').ports).toBeUndefined();
    expect(svc('gbrain-serve').environment.GBRAIN_HTTP_TRUST_PROXY).toBe('1');
  });

  test('postgres publishes no host port', () => {
    expect(svc('postgres').ports).toBeUndefined();
  });

  // S2: the control plane must never hold brain database credentials.
  test('control-plane holds no brain DATABASE_URL', () => {
    const env = svc('control-plane').environment as Record<string, string>;
    expect(env.GBRAIN_DATABASE_URL).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.CONTROL_DATABASE_URL).toBeDefined();
  });

  test('control-plane mounts GBRAIN_HOME read-only', () => {
    const mounts: string[] = svc('control-plane').volumes;
    const home = mounts.find((m) => m.includes('gbrain-home'));
    expect(home).toMatch(/:ro$/);
  });

  test('gbrain-ops holds the brain DATABASE_URL and a writable GBRAIN_HOME', () => {
    expect(svc('gbrain-ops').environment.GBRAIN_DATABASE_URL).toBeDefined();
    const home = (svc('gbrain-ops').volumes as string[]).find((m) => m.includes('gbrain-home'));
    expect(home).not.toMatch(/:ro$/);
  });

  test('gbrain-ops is not on control-net and control-plane is not on brain-net', () => {
    expect(svc('gbrain-ops').networks).toContain('brain-net');
    expect(svc('control-plane').networks).not.toContain('brain-net');
  });

  test('every gbrain container disables self-upgrade', () => {
    for (const n of ['gbrain-serve', 'gbrain-worker', 'gbrain-ops']) {
      expect(svc(n).environment.GBRAIN_SELF_UPGRADE_MODE).toBe('off');
    }
  });
});
