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

const devOverride = parse(readFileSync('compose/docker-compose.dev.yml', 'utf8')) as any;
const dockerAvailable = Bun.which('docker') !== null;

// If Docker is unavailable, the Docker-dependent test below vanishes
// silently (test.skipIf emits no failure), and it is the only proof that
// the documented dev invocation actually resolves DOMAIN via real Compose.
// This guard converts that silent hole into a loud, deliberate one: it
// always runs, and fails unless either Docker ran the real check, or a
// human explicitly opted into skipping it.
const SKIP_COMPOSE_DOCKER_CHECK_ENV = 'BRAINSTAND_ALLOW_SKIP_COMPOSE_DOCKER_CHECK';

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
    expect(svc('gbrain-ops').networks).not.toContain('control-net');
    expect(svc('control-plane').networks).not.toContain('brain-net');
  });

  test('every gbrain container disables self-upgrade', () => {
    for (const n of ['gbrain-serve', 'gbrain-worker', 'gbrain-ops']) {
      expect(svc(n).environment.GBRAIN_SELF_UPGRADE_MODE).toBe('off');
    }
  });

  // Finding 1 (Task 1 review): docker-compose.dev.yml used to set
  // caddy.environment.DOMAIN=localhost, which looked like it supplied the
  // dev DOMAIN but never could: Compose interpolates each file's `${...}`
  // expressions against the shell/.env context as it parses that file,
  // BEFORE merging in any override, so a value set only in the override
  // arrives too late to satisfy the base file's `${DOMAIN:?required}`. Pin
  // the fix structurally: the dev override must never again carry a
  // service-level DOMAIN meant to rescue that interpolation.
  test('the dev override does not set DOMAIN on caddy (cannot satisfy the base file\'s required check)', () => {
    const caddyEnv = devOverride.services.caddy.environment;
    expect(caddyEnv?.DOMAIN).toBeUndefined();
  });

  // Same finding, proved end-to-end against the real Compose CLI: the
  // documented dev path (export DOMAIN=localhost, bring up both files)
  // must actually resolve. Skipped cleanly when docker isn't on PATH.
  test.skipIf(!dockerAvailable)(
    'the documented dev invocation resolves DOMAIN from the environment',
    () => {
      const proc = Bun.spawnSync(
        ['docker', 'compose', '-f', 'compose/docker-compose.yml', '-f', 'compose/docker-compose.dev.yml', 'config'],
        {
          env: {
            ...process.env,
            DOMAIN: 'localhost',
            POSTGRES_PASSWORD: 'x',
            OPS_RPC_TOKEN: 'x',
            ENCRYPTION_KEY: 'x',
            BETTER_AUTH_SECRET: 'x',
          },
        },
      );
      const stdout = proc.stdout.toString();
      const stderr = proc.stderr.toString();
      expect(proc.exitCode, `docker compose config failed: ${stderr}`).toBe(0);
      expect(stdout).toContain('DOMAIN: localhost');
    },
  );

  // Always runs — see the block comment above `SKIP_COMPOSE_DOCKER_CHECK_ENV`.
  test('the Docker-dependent dev-invocation check above is not silently skipped', () => {
    if (dockerAvailable) return; // the real check above actually ran
    if (process.env[SKIP_COMPOSE_DOCKER_CHECK_ENV] === '1') return; // explicit human opt-out

    throw new Error(
      'Docker is unavailable, so "the documented dev invocation resolves DOMAIN from the ' +
        'environment" was skipped rather than run against real Compose. If skipping is ' +
        'genuinely intended for this run (e.g. a Docker-less CI runner), set ' +
        `${SKIP_COMPOSE_DOCKER_CHECK_ENV}=1 to acknowledge it explicitly.`,
    );
  });
});

describe('scheduler service invariants', () => {
  test('caddy is STILL the only service publishing host ports', () => {
    const publishers = Object.entries(compose.services)
      .filter(([, s]: [string, any]) => Array.isArray(s.ports) && s.ports.length > 0)
      .map(([n]) => n);
    expect(publishers).toEqual(['caddy']);
  });

  // S2, tightened: the scheduler is strictly less privileged than the control
  // plane. It reaches gbrain only through the ops RPC.
  test('scheduler holds no brain credentials of any kind', () => {
    const env = svc('scheduler').environment as Record<string, string>;
    expect(env.GBRAIN_DATABASE_URL).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.CONTROL_DATABASE_URL).toBeDefined();
    expect(env.OPS_RPC_URL).toBeDefined();
    expect(env.OPS_RPC_TOKEN).toBeDefined();
  });

  test('scheduler mounts NO volumes — not GBRAIN_HOME, not brain-repos', () => {
    expect(svc('scheduler').volumes).toBeUndefined();
  });

  test('scheduler is on control-net and ops-net, never brain-net', () => {
    expect(svc('scheduler').networks).toEqual(['control-net', 'ops-net']);
  });

  test('scheduler drains fast — a clean gbrain drain is ~1150ms, not 40s', () => {
    // Slice 0 measured `jobs supervisor stop` at 1150ms. The worker keeps its
    // 60s grace because it hosts gbrain's own supervisor; the scheduler does
    // not, so a long grace only delays every deploy.
    expect(svc('scheduler').stop_grace_period).toBe('20s');
    expect(svc('gbrain-worker').stop_grace_period).toBe('60s');
  });

  test('scheduler runs the scheduler entrypoint, not the control-plane app', () => {
    expect(svc('scheduler').command).toEqual(['bun', 'run', '/app/src/scheduler/main.ts']);
  });

  test('self-upgrade stays off everywhere gbrain env is merged', () => {
    for (const name of ['gbrain-serve', 'gbrain-worker', 'gbrain-ops']) {
      expect(svc(name).environment.GBRAIN_SELF_UPGRADE_MODE).toBe('off');
    }
  });
});
