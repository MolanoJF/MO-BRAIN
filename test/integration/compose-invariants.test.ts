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
const buildOverlay = parse(readFileSync('compose/docker-compose.build.yml', 'utf8')) as any;
const dockerAvailable = Bun.which('docker') !== null;

// If Docker is unavailable, the Docker-dependent test below vanishes
// silently (test.skipIf emits no failure), and it is the only proof that
// the documented dev invocation actually resolves DOMAIN via real Compose.
// This guard converts that silent hole into a loud, deliberate one: it
// always runs, and fails unless either Docker ran the real check, or a
// human explicitly opted into skipping it.
const SKIP_COMPOSE_DOCKER_CHECK_ENV = 'BRAINSTAND_ALLOW_SKIP_COMPOSE_DOCKER_CHECK';

describe('compose invariants', () => {
  test('serve and the worker start through the pause-file gate', () => {
    expect(svc('gbrain-serve').command[0]).toBe('/opt/mobrain/gbrain-gated-entrypoint.sh');
    expect(svc('gbrain-serve').command[1]).toBe('gbrain');
    expect(svc('gbrain-serve').command[2]).toBe('serve');
    expect(svc('gbrain-worker').command[0]).toBe('/opt/mobrain/gbrain-gated-entrypoint.sh');
    expect(svc('gbrain-worker').command.slice(1, 4)).toEqual(['gbrain', 'jobs', 'supervisor']);
  });

  test('caddy is the only service publishing host ports', () => {
    // Iterates every service in the file, so the profile-gated `agent-runner`
    // (present in the parsed object even though a plain `up` never starts it)
    // is covered here as well as by its own block below.
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

  test('neither compose file defaults GBRAIN_VERSION — a bump must be explicit or compose refuses to start', () => {
    const rawBase = readFileSync('compose/docker-compose.yml', 'utf8');
    const rawSlice0 = readFileSync('compose/docker-compose.slice0.yml', 'utf8');
    expect(rawBase).not.toMatch(/\$\{GBRAIN_VERSION:-/);
    expect(rawSlice0).not.toMatch(/\$\{GBRAIN_VERSION:-/);
  });

  test('gbrain-ops and control-plane both receive GBRAIN_VERSION as a real runtime env var', () => {
    expect(svc('gbrain-ops').environment.GBRAIN_VERSION).toBeDefined();
    expect(svc('control-plane').environment.GBRAIN_VERSION).toBeDefined();
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

describe('agent runner service invariants', () => {
  // D6/D12/U14: the agent runner is the stack's FIRST hardened service, and
  // it is profile-gated — a profile-gated service is still present in the
  // parsed YAML, so every assertion here is structural and none is skipped.
  test('runner-net is internal — the network is the fence, the tool flags are not (D6, honesty rule 2)', () => {
    expect(compose.networks['runner-net'].driver).toBe('bridge');
    expect(compose.networks['runner-net'].internal).toBe(true);
  });

  test('agent-runner is on runner-net and on nothing else', () => {
    expect(svc('agent-runner').networks).toEqual(['runner-net']);
  });

  test('caddy and control-plane join runner-net, and caddy answers to ${DOMAIN} there', () => {
    expect(svc('control-plane').networks).toContain('runner-net');
    // Caddy keeps every network it already had, plus the alias the runner
    // dials: https://${DOMAIN}/mcp has to resolve inside the internal network,
    // so gbrain is reached through Caddy (and X-Forwarded-For stays Caddy's
    // job) rather than over a direct route the runner could spoof.
    expect(Object.keys(svc('caddy').networks).sort()).toEqual(['brain-net', 'control-net', 'runner-net']);
    expect(svc('caddy').networks['runner-net'].aliases).toEqual(['${DOMAIN}']);
  });

  test('the runner profile is off by default, so a plain up omits the service (D12)', () => {
    expect(svc('agent-runner').profiles).toEqual(['runner']);
  });

  test('agent-runner mounts NO volumes, and no compose file publishes a port for it', () => {
    expect(svc('agent-runner').volumes ?? []).toEqual([]);
    expect(svc('agent-runner').ports).toBeUndefined();
    expect(devOverride.services['agent-runner'].ports).toBeUndefined();
  });

  test('agent-runner holds no credential but its bearer (S2)', () => {
    const env = svc('agent-runner').environment as Record<string, string>;
    for (const key of Object.keys(env)) {
      expect(key, `agent-runner must hold no credential, but its environment has ${key}`)
        .not.toMatch(/(^|_)DATABASE_URL$/);
      expect(key, `agent-runner must hold no credential, but its environment has ${key}`)
        .not.toMatch(/_API_KEY$/);
    }
    expect(env.GBRAIN_DATABASE_URL).toBeUndefined();
    expect(env.CONTROL_DATABASE_URL).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.GBRAIN_HOME).toBeUndefined();
    expect(env.OPS_RPC_TOKEN).toBeUndefined();
    expect(env.ENCRYPTION_KEY).toBeUndefined();
    // What it does hold: its own bearer, and where to spend it.
    expect(env.CONTROL_URL).toBe('http://control-plane:3150');
    expect(env.HARNESS_VERSION).toBeDefined();
  });

  test('a missing RUNNER_TOKEN cannot break a runner-less deployment — the runtime guards own it (D12)', () => {
    // Compose interpolates this whole file before profiles resolve, so
    // `${RUNNER_TOKEN:?required}` would fail `docker compose stop scheduler`
    // on a deployment that never enables the runner. The control plane
    // authenticates the same value, with the same optionality: empty means
    // `503 runner_disabled`, because an empty bearer must never authenticate.
    expect((svc('agent-runner').environment as Record<string, string>).RUNNER_TOKEN).toBe('${RUNNER_TOKEN:-}');
    expect(svc('control-plane').environment.RUNNER_TOKEN).toBe('${RUNNER_TOKEN:-}');
    // Every RUNNER_TOKEN *assignment* is the optional form. Checked on
    // assignment lines rather than on the raw file, because the comment above
    // each one documents the `${RUNNER_TOKEN:?required}` shape it forbids.
    const assignments = readFileSync('compose/docker-compose.yml', 'utf8')
      .split('\n')
      .filter((line) => /^\s*RUNNER_TOKEN:/.test(line))
      .map((line) => line.trim());
    expect(assignments).toEqual(['RUNNER_TOKEN: ${RUNNER_TOKEN:-}', 'RUNNER_TOKEN: ${RUNNER_TOKEN:-}']);
  });

  test('every hardening directive is present — this service is where they were all introduced (U14)', () => {
    expect(svc('agent-runner').read_only).toBe(true);
    expect(svc('agent-runner').user).toBe('10001:10001');
    expect(svc('agent-runner').user).not.toMatch(/^(0|root)(:.*)?$/);
    expect(svc('agent-runner').security_opt).toEqual(['no-new-privileges:true']);
    expect(svc('agent-runner').cap_drop).toEqual(['ALL']);
    expect(svc('agent-runner').pids_limit).toBe(256);
    expect(svc('agent-runner').mem_limit).toBe('2g');
    expect(svc('agent-runner').cpus).toBe(1);
    expect(svc('agent-runner').stop_grace_period).toBe('60s');
  });

  test('the only tmpfs is /tmp — a tmpfs at $HOME hides the harness (P5, Task 1)', () => {
    expect(svc('agent-runner').tmpfs).toEqual(['/tmp']);
  });

  test('the image is pinned to HARNESS_VERSION (G1)', () => {
    expect(svc('agent-runner').image).toContain('${HARNESS_VERSION');
  });

  // D2: the production file pulls; it never builds. Every build stanza lives in
  // compose/docker-compose.build.yml, which CI and the build gates merge in.
  test('production compose carries NO build stanza — the build overlay does (D2)', () => {
    for (const [name, service] of Object.entries(compose.services) as [string, any][]) {
      expect(service.build, `${name} must not build in the production file (D2)`).toBeUndefined();
    }
    expect(buildOverlay.services['control-plane'].build.dockerfile).toBe('docker/control-plane.Dockerfile');
    expect(buildOverlay.services['scheduler'].build.dockerfile).toBe('docker/control-plane.Dockerfile');
    expect(buildOverlay.services['agent-runner'].build.dockerfile).toBe('docker/agent-runner.Dockerfile');
  });

  test('neither compose file defaults HARNESS_VERSION — a version move must be explicit or compose refuses to start', () => {
    expect(readFileSync('compose/docker-compose.yml', 'utf8')).not.toMatch(/\$\{HARNESS_VERSION:-/);
    expect(readFileSync('compose/docker-compose.dev.yml', 'utf8')).not.toMatch(/\$\{HARNESS_VERSION:-/);
  });

  test('NODE_EXTRA_CA_CERTS is dev-only — production validates against the public roots (D6)', () => {
    expect((svc('agent-runner').environment as Record<string, string>).NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(devOverride.services['agent-runner'].environment.NODE_EXTRA_CA_CERTS)
      .toBe('/etc/ssl/caddy-root.crt');
  });

  test('the dev CA lane reads Caddy\'s own CA read-only and hands Node a real file, not a directory', () => {
    const exporter = devOverride.services['caddy-ca-export'];
    const caSource = exporter.volumes.find((v: string) => String(v).includes('caddy-data'));
    expect(caSource).toMatch(/:ro$/);
    const mount = devOverride.services['agent-runner'].volumes[0];
    expect(mount.type).toBe('volume');
    expect(mount.source).toBe('runner-ca');
    expect(mount.target).toBe('/etc/ssl/caddy-root.crt');
    expect(mount.read_only).toBe(true);
    // A named volume mounted onto a file path is created as a DIRECTORY (the
    // subpath mount is what makes it a file Node can actually load).
    expect(mount.volume.subpath).toBe('caddy-root.crt');
  });
});

describe('upgrade reconciliation invariants', () => {
  test('control-plane mounts the upgrade directory read-only, separate from GBRAIN_HOME', () => {
    const mounts: string[] = svc('control-plane').volumes;
    const home = mounts.find((m) => m.includes('gbrain-home'));
    const upgrade = mounts.find((m) => m.includes('/srv/upgrades'));
    expect(upgrade).toBeDefined();
    expect(upgrade).toMatch(/:ro$/);
    expect(upgrade).not.toBe(home);
  });

  test('no container mounts the upgrade directory writable — only the host CLI writes it (D1)', () => {
    for (const name of Object.keys(compose.services)) {
      const mounts: string[] = svc(name).volumes ?? [];
      const upgrade = mounts.find((m) => m.includes('/srv/upgrades'));
      if (upgrade) expect(upgrade).toMatch(/:ro$/);
    }
  });
});
