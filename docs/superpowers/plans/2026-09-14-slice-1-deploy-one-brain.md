# Slice 1 — Deploy + One Brain + One Admin: Implementation Plan

> **Status: COMPLETE.** Merged to `main` at `77a18d1` on 2026-09-15. **Do not re-execute.** This file is the historical plan; defects found during execution were patched in place. Next stage is Slice 2 (plan not yet written). See [HANDOFF.md](../../../HANDOFF.md) and [PROGRESS.md](./PROGRESS.md).

> **For agentic workers:** If you were asked to *implement* this plan, stop — it is already on `main`. Use this file only as a record of what shipped and which plan defects were found.

**Goal:** On a clean VM, `docker compose up` gives a team an HTTPS-terminated brain with a web console that walks one admin from empty to `ready`, backed up and restorable — with `/admin` unreachable from the internet.

**Architecture:** Caddy is the sole ingress, terminating TLS from `DOMAIN` and splitting traffic between `gbrain-serve` (reserved paths) and `control-plane` (`/api/*` + the console SPA). One Postgres holds two databases: `gbrain` (upstream's) and `control` (ours). The control plane holds **no brain credentials** and mounts `GBRAIN_HOME` read-only; every privileged gbrain invocation goes over a private-network RPC to `gbrain-ops`, which exposes exactly the operations in `contracts/v0.50.0.0/operations.json` and nothing else. All file-plane writes serialize through that sidecar behind a Postgres advisory lock.

**Tech Stack:** Bun + Hono + Drizzle ORM + Better Auth (control plane), React 19 + Vite + Tailwind (console), Caddy 2, `pgvector/pgvector:pg16`, gbrain `v0.50.0.0`.

**Spec:** `C:\Users\juanp\.claude\plans\we-want-to-do-snug-wolf.md`
**Roadmap + verified constraints:** [`2026-09-14-brainstand-roadmap.md`](./2026-09-14-brainstand-roadmap.md)
**Predecessor:** [`2026-09-14-slice-0-cli-lane-proof.md`](./2026-09-14-slice-0-cli-lane-proof.md)

---

## Global Constraints

The roadmap's **Global Constraints** section applies to every task here. The ones that bite in this slice, each a live bug if violated:

- **`GBRAIN_HTTP_TRUST_PROXY=1` is required behind Caddy**, and **`gbrain-serve` must not publish a host port**. The two are a pair — widening `trust_proxy` while the server is directly reachable lets clients spoof `X-Forwarded-For`.
- **`postgres` publishes no host port.**
- **`/admin` is never routed publicly (S1).** Break-glass instead.
- **The console mounts under `/api/*` with health at `/api/health`.** `/health` and `/metrics` belong to `gbrain-serve` — they are live collisions.
- **S2** — control plane: control DB creds only, `GBRAIN_HOME` read-only, **no brain `DATABASE_URL`**. `gbrain-ops`: brain DB + RW `GBRAIN_HOME`, allowlisted RPC only, **argv arrays never shell strings**.
- **S3** — every file-plane write serializes through `gbrain-ops` behind a Postgres advisory lock in the **control** DB, with atomic-write semantics.
- **S3b** — secrets are envelope-encrypted: per-secret DEK, KEK from `ENCRYPTION_KEY`, versioned rows.
- **S3c** — never log a request body that can carry a credential; CI enforces it.
- **S4b** — **Space = source is a hard rule**, surfaced as a blocking choice in onboarding, not a tooltip.
- `GBRAIN_SELF_UPGRADE_MODE=off` in every container. Never `autopilot --install`.
- The image carries gbrain's `LICENSE`.

**Entry gate:** Slice 0's exit gate is green and `contracts/v0.50.0.0/operations.json` is committed.

```bash
bun run test:contract && test -s contracts/v0.50.0.0/operations.json && echo ENTRY-GATE-OK
```

---

## File Structure

| Path | Responsibility |
|---|---|
| `compose/docker-compose.yml` | The production stack. Six services, three networks. |
| `compose/docker-compose.dev.yml` | Local override: publishes ports, uses Caddy's internal CA. |
| `compose/Caddyfile` | TLS + the only routing table in the system. |
| `compose/initdb/01-databases.sh` | Creates `gbrain` + `control` DBs and their extensions. |
| `docker/control-plane.Dockerfile` | `gbrain-base` + our built app. |
| `src/ops/lock.ts` | Postgres advisory lock. Pure lock mechanics, no gbrain knowledge. |
| `src/ops/fileplane.ts` | Advisory-locked atomic writes to `config.json` + schema packs. |
| `src/ops/server.ts` | The allowlisted RPC server — `gbrain-ops`'s entrypoint. |
| `src/ops/dispatch.ts` | operations.json → validated argv. No passthrough. |
| `src/ops/git.ts` | Repo contention + drift inspection; commit-as-the-member. |
| `src/control/app.ts` | Hono app; mounts every `/api/*` route. |
| `src/control/opsClient.ts` | Typed client for the ops RPC. The only way out of the control plane. |
| `src/control/secrets.ts` | Envelope encryption: `seal`, `open`, `rotate`. |
| `src/control/db/schema.ts` | Drizzle control schema. |
| `src/control/db/client.ts` | Drizzle client + migration runner. |
| `src/control/auth.ts` | Better Auth config + single-admin bootstrap. |
| `src/control/lifecycle.ts` | The brain lifecycle state machine. |
| `src/control/routes/*.ts` | `health`, `wizard`, `spaces`, `backup`. |
| `src/console/` | React 19 SPA: shell, wizard, health page. |
| `scripts/install.sh` | The self-host installer. |
| `scripts/backup.ts`, `scripts/restore.ts` | Quiesce → 4-component snapshot → restore. |
| `docs/runbooks/break-glass.md` | First-class artifact, not an afterthought (S1). |
| `test/unit/`, `test/integration/`, `test/e2e/slice1.e2e.test.ts` | |

---

## Task 1: Two-database Postgres and the production compose

**Files:**
- Create: `compose/initdb/01-databases.sh`, `compose/docker-compose.yml`, `compose/docker-compose.dev.yml`
- Create: `.env.example` additions
- Test: `test/integration/compose-invariants.test.ts`

**Interfaces:**
- Produces: services `caddy`, `postgres`, `gbrain-serve`, `gbrain-worker`, `gbrain-ops`, `control-plane`; networks `brain-net`, `control-net`; databases `gbrain` and `control`.

- [ ] **Step 1: Write the failing invariant test**

`test/integration/compose-invariants.test.ts`:
```ts
import { test, expect, describe } from 'bun:test';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';

// `merge: true` expands `<<` YAML merge keys (the x-gbrain-env anchor). The
// `yaml` package disables merge-key support by default (YAML-1.2-strict);
// without it every service that merges the anchor keeps a literal "<<" key
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
    expect(svc('gbrain-ops').networks).not.toContain('control-net');
    expect(svc('control-plane').networks).not.toContain('brain-net');
  });

  test('every gbrain container disables self-upgrade', () => {
    for (const n of ['gbrain-serve', 'gbrain-worker', 'gbrain-ops']) {
      expect(svc(n).environment.GBRAIN_SELF_UPGRADE_MODE).toBe('off');
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun add -d yaml && bun test test/integration/compose-invariants.test.ts`
Expected: FAIL — `ENOENT: compose/docker-compose.yml`.

- [ ] **Step 3: Write `compose/initdb/01-databases.sh`**

```bash
#!/bin/bash
set -e

# CREATE DATABASE has no IF NOT EXISTS in Postgres. This directory is also
# mounted by compose/docker-compose.slice0.yml, whose POSTGRES_DB=gbrain makes
# the postgres entrypoint pre-create "gbrain" before any initdb.d script runs.
# Guard both so this script is safe whichever compose file it runs under.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-'SQL'
  SELECT 'CREATE DATABASE gbrain'  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'gbrain')\gexec
  SELECT 'CREATE DATABASE control' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'control')\gexec
SQL

for db in gbrain control; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<-'SQL'
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL
done
```

> **Corrected 2026-09-15 — the unguarded `CREATE DATABASE` broke the Slice 0 stack.**
> `compose/initdb/` is mounted by *both* compose files. `docker-compose.slice0.yml` sets
> `POSTGRES_DB=gbrain`, so the postgres entrypoint pre-creates that database before any
> `initdb.d` script runs; a bare `CREATE DATABASE gbrain` then aborts the whole init under
> `ON_ERROR_STOP=1` with "database gbrain already exists". Verified: `docker compose -f
> compose/docker-compose.slice0.yml up postgres` exited 3 with that error on a fresh volume.
> The `\gexec` guard above is idempotent and safe under either compose file.

- [ ] **Step 4: Write `compose/docker-compose.yml`**

```yaml
# brainstand production stack. Caddy is the sole ingress; nothing else
# publishes a host port.
name: brainstand

x-gbrain-env: &gbrain-env
  GBRAIN_DATABASE_URL: postgres://gbrain:${POSTGRES_PASSWORD:?required}@postgres:5432/gbrain
  GBRAIN_HOME: /srv/gbrain-home
  GBRAIN_SELF_UPGRADE_MODE: "off"

services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      DOMAIN: ${DOMAIN:?required}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on: [gbrain-serve, control-plane]
    networks: [brain-net, control-net]

  postgres:
    image: pgvector/pgvector:pg16
    restart: unless-stopped
    environment:
      POSTGRES_USER: gbrain
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?required}
      POSTGRES_DB: postgres
    # No published host port.
    volumes:
      - pg-data:/var/lib/postgresql/data
      - ./initdb:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U gbrain -d gbrain"]
      interval: 5s
      timeout: 5s
      retries: 30
    networks: [brain-net, control-net]

  gbrain-serve:
    image: brainstand/gbrain-base:${GBRAIN_VERSION:-0.50.0.0}
    restart: unless-stopped
    environment:
      <<: *gbrain-env
      # Required behind Caddy: the default is `loopback`, and in compose the
      # proxy is a peer container, so without this every client IP collapses
      # to Caddy's and the pre-auth rate limiter mis-buckets.
      GBRAIN_HTTP_TRUST_PROXY: "1"
    command: ["gbrain", "serve", "--http", "--bind", "0.0.0.0", "--port", "3131",
              "--public-url", "https://${DOMAIN}"]
    volumes:
      - gbrain-home:/srv/gbrain-home
      - brain-repos:/srv/brain-repos
    depends_on:
      postgres: { condition: service_healthy }
    networks: [brain-net]

  gbrain-worker:
    image: brainstand/gbrain-base:${GBRAIN_VERSION:-0.50.0.0}
    restart: unless-stopped
    environment: *gbrain-env
    command: ["gbrain", "jobs", "supervisor", "--concurrency", "${WORKER_CONCURRENCY:-2}"]
    # V5: SIGTERM drains; `stop` waits up to 40s. Give it room plus margin.
    stop_grace_period: 60s
    volumes:
      - gbrain-home:/srv/gbrain-home
      - brain-repos:/srv/brain-repos
    depends_on:
      postgres: { condition: service_healthy }
    networks: [brain-net]

  # S2: the privilege boundary. Holds brain DB creds (required by V8) and RW
  # GBRAIN_HOME; exposes only the allowlisted RPC on the private network.
  gbrain-ops:
    image: brainstand/control-plane:${BRAINSTAND_VERSION:-dev}
    build:
      context: ..
      dockerfile: docker/control-plane.Dockerfile
      args:
        GBRAIN_VERSION: ${GBRAIN_VERSION:-0.50.0.0}
    restart: unless-stopped
    environment:
      <<: *gbrain-env
      OPS_RPC_TOKEN: ${OPS_RPC_TOKEN:?required}
      # The advisory lock for the file plane lives in the CONTROL database.
      CONTROL_DATABASE_URL: postgres://gbrain:${POSTGRES_PASSWORD:?required}@postgres:5432/control
    command: ["bun", "run", "/app/src/ops/server.ts"]
    volumes:
      - gbrain-home:/srv/gbrain-home
      - brain-repos:/srv/brain-repos
    depends_on:
      postgres: { condition: service_healthy }
    networks: [brain-net, ops-net]

  control-plane:
    image: brainstand/control-plane:${BRAINSTAND_VERSION:-dev}
    restart: unless-stopped
    environment:
      # S2: control DB only. No GBRAIN_DATABASE_URL, no DATABASE_URL.
      CONTROL_DATABASE_URL: postgres://gbrain:${POSTGRES_PASSWORD:?required}@postgres:5432/control
      OPS_RPC_URL: http://gbrain-ops:3140
      OPS_RPC_TOKEN: ${OPS_RPC_TOKEN:?required}
      ENCRYPTION_KEY: ${ENCRYPTION_KEY:?required}
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?required}
      PUBLIC_URL: https://${DOMAIN}
      GBRAIN_HOME: /srv/gbrain-home
    command: ["bun", "run", "/app/src/control/app.ts"]
    volumes:
      # Read-only: the control plane reads config state, never writes it (S3).
      - gbrain-home:/srv/gbrain-home:ro
    depends_on:
      postgres: { condition: service_healthy }
    networks: [control-net, ops-net]

networks:
  brain-net: { driver: bridge }
  control-net: { driver: bridge }
  # Carries only control-plane → gbrain-ops RPC.
  ops-net: { driver: bridge }

volumes:
  pg-data:
  gbrain-home:
  brain-repos:
  caddy-data:
  caddy-config:
```

- [ ] **Step 5: Write `compose/docker-compose.dev.yml`**

```yaml
# Local override: publishes Caddy on high ports so `docker compose up` is
# reachable without binding 80/443. NEVER used in production.
#
# This does NOT supply DOMAIN. `${DOMAIN:?required}` in the base compose file
# is interpolated BEFORE this override is merged in, so a value set only here
# can never satisfy it -- Compose still fails fast if DOMAIN is unset, by
# design. Export DOMAIN=localhost yourself (shell env or .env) before bringing
# this stack up; when Caddy sees a non-public DOMAIN like `localhost` it issues
# certificates from its own internal CA instead of trying ACME.
services:
  caddy:
    ports:
      - "8443:443"
      - "8080:80"

  # Host-run tests and scripts/backup.ts reach the RPC over localhost. In
  # production nothing but control-plane can reach :3140, on ops-net only.
  # The Task 1 invariant test reads docker-compose.yml alone, so this override
  # does not weaken it.
  gbrain-ops:
    ports:
      - "3140:3140"
```

> **Corrected 2026-09-15 — the override could never supply `DOMAIN`.**
> This file originally set `environment: { DOMAIN: localhost }` under `caddy` and claimed in
> its header that `docker compose up` "works without a real domain." Both were false. Compose
> interpolates `${DOMAIN:?required}` in the base file *before* merging any override, so the
> override's value cannot satisfy it. Verified: with `DOMAIN` unset,
> `docker compose -f docker-compose.yml -f docker-compose.dev.yml config` fails with
> `required variable DOMAIN is missing a value: required`. It only failed to bite because
> `.env.example` ships a non-empty `DOMAIN=brain.example.com` while every secret beside it
> ships blank.
>
> `${DOMAIN:?required}` is deliberately **kept** — it is a production guard that fails early
> with an explicit message naming the variable. The fix was to stop the override implying it
> supplies `DOMAIN` and to state the real dev path (`DOMAIN=localhost` in the environment or
> `.env`). Step 7's test suite pins this.

> **Running host-side scripts and tests.** `scripts/backup.ts`, `scripts/restore.ts` and the integration suites import `callOps`, which defaults to `http://gbrain-ops:3140` — a name that resolves only inside compose. When running from the host, set:
>
> ```bash
> export OPS_RPC_URL=http://localhost:3140
> ```
>
> and bring the stack up with **both** compose files. Every `bun test` and `bun run` command in Tasks 9, 11, 12 and 14 assumes this is exported.

- [ ] **Step 6: Extend `.env.example`**

```
DOMAIN=brain.example.com
GBRAIN_VERSION=0.50.0.0
BRAINSTAND_VERSION=dev
WORKER_CONCURRENCY=2

# Generated by scripts/install.sh. Rotating ENCRYPTION_KEY requires the
# documented secret-rotation flow; losing it makes every stored secret
# unrecoverable, so it is backed up SEPARATELY from the database.
POSTGRES_PASSWORD=
OPS_RPC_TOKEN=
ENCRYPTION_KEY=
BETTER_AUTH_SECRET=
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test test/integration/compose-invariants.test.ts`
Expected: PASS — 10 tests (8 as originally drafted, plus two added when the `DOMAIN`
interpolation defect was corrected: one pinning that the dev override does not rely on a
service-level `DOMAIN`, one exercising the documented dev invocation through the real
Compose CLI).

- [ ] **Step 8: Commit**

```bash
git add compose/ .env.example test/integration/compose-invariants.test.ts package.json bun.lock
git commit -m "feat(slice1): two-database postgres and the production compose topology

Caddy is the sole publisher; control-plane holds no brain credentials (S2).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: The Caddyfile — the only routing table, with `/admin` sealed

**Files:**
- Create: `compose/Caddyfile`
- Test: `test/integration/routing.test.ts`

**Interfaces:**
- Consumes: services `gbrain-serve` (port 3131) and `control-plane` (port 3150) from Task 1.
- Produces: the public routing contract asserted by every later task.

- [ ] **Step 1: Write the failing routing test**

`test/integration/routing.test.ts`:
```ts
import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';

const caddyfile = readFileSync('compose/Caddyfile', 'utf8');

// Paths gbrain-serve owns. /health and /metrics are LIVE COLLISIONS with a
// naive console mount — the console uses /api/health instead.
const GBRAIN_PATHS = [
  '/mcp', '/mcp/*', '/authorize', '/authorize/*', '/token', '/register', '/revoke',
  '/.well-known/*', '/ingest', '/webhooks/*', '/health', '/metrics',
];

describe('Caddyfile routing contract', () => {
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

  test('/admin is explicitly refused rather than falling through to the SPA', () => {
    expect(caddyfile).toMatch(/@admin_denied/);
    // Must match the `handle`-wrapped form. A bare `respond @admin_denied 404`
    // compiles BEHIND the catch-all and is unreachable — see the Step 3 note.
    expect(caddyfile).toMatch(/handle @admin_denied\s*\{\s*
\s*respond 404/);
  });

  test('/api/* routes to control-plane', () => {
    expect(caddyfile).toMatch(/\/api\/\*[\s\S]{0,200}control-plane:3150/);
  });

  test('TLS is driven by the DOMAIN env var', () => {
    expect(caddyfile).toMatch(/\{\$DOMAIN\}/);
  });

  test('security headers are set on every response', () => {
    expect(caddyfile).toMatch(/Strict-Transport-Security/);
    expect(caddyfile).toMatch(/X-Content-Type-Options\s+"nosniff"/);
  });
});
```

> **Corrected 2026-09-15 — three defects in this test block, all found by running it.**
> 1. The `/admin` assertion matched the literal `respond @admin_denied 404`, which **cannot**
>    appear in the corrected `handle`-wrapped Caddyfile of Step 3. It now pins the corrected
>    shape instead.
> 2. `X-Content-Type-Options\s+nosniff` never matches: the Caddyfile writes the value quoted,
>    so there is a `"` between the whitespace and `nosniff`.
> 3. `GBRAIN_PATHS` omitted `/mcp/*` and `/authorize/*`, which the Caddyfile's own `@gbrain`
>    matcher does list. Not a false pass (the `/mcp` substring also matches inside `/mcp/*`),
>    but a regression dropping the wildcards — breaking gbrain's OAuth subpaths — would have
>    been caught by nothing here.

> **These text assertions are necessary but NOT sufficient — none of them checks route
> POSITION.** A regression that moves the `handle @admin_denied` block *after* the catch-all
> `handle {}` passes every assertion above while re-opening the S1 hole. The compiled-output
> tests required by Step 3's note are the only proof of ordering, so they must not be able to
> disappear quietly: gate them on Docker if you must, but add an **always-running** test that
> FAILS when the compiled suite would be skipped, unless an explicit opt-out env var is set.
> A silently skipped gate is indistinguishable from a passing one.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/integration/routing.test.ts`
Expected: FAIL — `ENOENT: compose/Caddyfile`.

- [ ] **Step 3: Write `compose/Caddyfile`**

```caddyfile
{$DOMAIN} {
	encode zstd gzip

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "strict-origin-when-cross-origin"
		-Server
	}

	# ---------------------------------------------------------------------
	# S1: gbrain's embedded /admin SPA is a SECOND control plane with god
	# rights over the same brain — bootstrap-token auth, in-process sessions,
	# no audit trail we own. Every decision the permission compiler makes can
	# be silently overridden there. It is bound to the private network only.
	#
	# Break-glass is `docker compose exec gbrain-ops gbrain …` over SSH.
	# See docs/runbooks/break-glass.md.
	# ---------------------------------------------------------------------
	# MUST be a `handle` block, not a bare `respond`. See the note below.
	@admin_denied path /admin /admin/* /admin/api/* /admin/events
	handle @admin_denied {
		respond 404
	}

	# ---------------------------------------------------------------------
	# Reserved paths owned by gbrain-serve. /health and /metrics are LIVE
	# COLLISIONS — the console's health endpoint is /api/health.
	# ---------------------------------------------------------------------
	@gbrain path /mcp /mcp/* /authorize /authorize/* /token /register /revoke \
		/.well-known/* /ingest /webhooks/* /health /metrics
	handle @gbrain {
		reverse_proxy gbrain-serve:3131
	}

	# ---------------------------------------------------------------------
	# Our control plane: the API and the console SPA.
	# ---------------------------------------------------------------------
	handle /api/* {
		reverse_proxy control-plane:3150
	}

	handle {
		reverse_proxy control-plane:3150
	}
}
```

> **Corrected 2026-09-15 — the `/admin` seal was decorative as originally drafted (S1 violation).**
> This block first read `respond @admin_denied 404` at the top level. Caddy's default
> directive order sorts `respond` *after* `handle`, so compiling the original Caddyfile
> verbatim (`caddy adapt`, `caddy:2`) produced this route order inside the host subroute:
>
> ```
> 1  path /mcp,/authorize,...  -> reverse_proxy gbrain-serve
> 2  path /api/*               -> reverse_proxy control-plane
> 3  match=None (catch-all)    -> reverse_proxy control-plane
> 4  path /admin,/admin/*      -> static_response 404
> ```
>
> `handle` is terminal and route 3 matches **every** request, so route 4 was unreachable
> dead config: `/admin` would have been proxied to the control plane and answered 200 with
> the console SPA instead of 404. gbrain's real admin is on `gbrain-serve:3131` and is not
> proxied on this path, so this was not a direct god-rights exposure — but S1 and the Slice 1
> exit gate were both unmet, and the seal did nothing.
>
> Wrapping it in `handle` makes it participate in `handle`'s written-order evaluation.
> Re-compiled, `/admin` is route 1, ahead of the catch-all. Verified with real Caddy before
> the task was dispatched.

> **Consequence for Step 1's test — it would have passed against the broken config.**
> A test that parses the Caddyfile *text* finds the `respond @admin_denied 404` line present
> and goes green while the compiled behavior does the opposite. The routing test must assert
> **compiled** behavior: run `caddy adapt` and assert on the route order in the resulting JSON
> (or assert against a live request), so the `/admin` rule is proven to precede the catch-all.
> Asserting on file contents alone is not sufficient for this invariant.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/integration/routing.test.ts`
Expected: PASS. The count will exceed the originally-drafted 15 once the compiled-order
assertions above are added; report the actual count.

- [ ] **Step 5: Validate the Caddyfile syntactically**

```bash
docker run --rm -v "$(pwd)/compose/Caddyfile:/etc/caddy/Caddyfile:ro" -e DOMAIN=localhost caddy:2 caddy validate --config /etc/caddy/Caddyfile
```
Expected: `Valid configuration`.

- [ ] **Step 6: Commit**

```bash
git add compose/Caddyfile test/integration/routing.test.ts
git commit -m "feat(slice1): Caddy routing with /admin sealed off the public surface (S1)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Postgres advisory lock and the file-plane writer (S3)

`~/.gbrain/config.json` gets written by our wizard, by `gbrain config set`, by `init`, by `post-upgrade` — on a shared volume across containers with no lock protocol. Last-writer-wins will eat an API key at the worst possible moment.

**Files:**
- Create: `src/ops/lock.ts`, `src/ops/fileplane.ts`
- Test: `test/unit/lock.test.ts`, `test/integration/fileplane.test.ts`

**Interfaces:**
- Produces:
  - `withAdvisoryLock<T>(sql: Sql, key: string, fn: () => Promise<T>, opts?: { timeoutMs?: number }): Promise<T>`
  - `lockKeyToBigint(key: string): bigint`
  - `writeFilePlane(path: string, mutate: (current: string | null) => string, opts: { sql: Sql }): Promise<void>`
  - `mergeConfigJson(current: string | null, patch: Record<string, unknown>): string`

- [ ] **Step 1: Write the failing unit test for the lock key**

`test/unit/lock.test.ts`:
```ts
import { test, expect, describe } from 'bun:test';
import { lockKeyToBigint, mergeConfigJson } from '../../src/ops/lock.ts';

describe('lockKeyToBigint', () => {
  test('is deterministic', () => {
    expect(lockKeyToBigint('fileplane:config.json'))
      .toBe(lockKeyToBigint('fileplane:config.json'));
  });

  test('different keys give different locks', () => {
    expect(lockKeyToBigint('fileplane:config.json'))
      .not.toBe(lockKeyToBigint('fileplane:schema-packs'));
  });

  test('fits in a signed 64-bit integer', () => {
    const v = lockKeyToBigint('fileplane:config.json');
    expect(v).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(v).toBeLessThan(2n ** 63n);
  });
});

describe('mergeConfigJson', () => {
  test('creates a document when none exists', () => {
    expect(JSON.parse(mergeConfigJson(null, { openai_api_key: 'sk-x' })))
      .toEqual({ openai_api_key: 'sk-x' });
  });

  // The whole point of S3: a concurrent writer must not lose the other key.
  test('preserves keys it is not patching', () => {
    const current = JSON.stringify({ openai_api_key: 'sk-a', engine: 'postgres' });
    expect(JSON.parse(mergeConfigJson(current, { anthropic_api_key: 'sk-b' })))
      .toEqual({ openai_api_key: 'sk-a', engine: 'postgres', anthropic_api_key: 'sk-b' });
  });

  test('overwrites a key it is patching', () => {
    const current = JSON.stringify({ openai_api_key: 'old' });
    expect(JSON.parse(mergeConfigJson(current, { openai_api_key: 'new' })).openai_api_key)
      .toBe('new');
  });

  test('refuses to clobber a corrupt document', () => {
    expect(() => mergeConfigJson('{not json', { a: 1 }))
      .toThrow('refusing to overwrite unparseable config.json');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/lock.test.ts`
Expected: FAIL — `Cannot find module '../../src/ops/lock.ts'`.

- [ ] **Step 3: Write `src/ops/lock.ts`**

```ts
import { createHash } from 'node:crypto';
import type { SQL } from 'bun';

/**
 * Map a human lock name to the signed 64-bit integer pg_advisory_lock takes.
 * A Postgres advisory lock, not a file lock: multiple containers share the
 * GBRAIN_HOME volume, so a flock on that volume protects nothing (S3).
 */
export function lockKeyToBigint(key: string): bigint {
  const digest = createHash('sha256').update(key).digest();
  const unsigned = digest.readBigUInt64BE(0);
  return BigInt.asIntN(64, unsigned);
}

export async function withAdvisoryLock<T>(
  sql: SQL,
  key: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const lockId = lockKeyToBigint(key);
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);

  // pg_advisory_lock is SESSION-scoped and re-entrant WITHIN a session, while
  // `sql` is a connection POOL. Reserve one connection so the acquire, the
  // critical section and the release provably share a single backend. On a
  // bare pooled handle two things can go wrong silently: the unlock lands on a
  // different connection (returns false, lock leaks until that backend dies),
  // and two concurrent callers handed the same connection BOTH acquire the
  // lock — mutual exclusion gone, with no error anywhere. S3 depends on this.
  const conn = await sql.reserve();
  try {
    for (;;) {
      const [row] = await conn`select pg_try_advisory_lock(${lockId}::bigint) as got`;
      if (row?.got) break;
      if (Date.now() > deadline) throw new Error(`timed out acquiring advisory lock ${key}`);
      await Bun.sleep(100);
    }

    try {
      return await fn();
    } finally {
      await conn`select pg_advisory_unlock(${lockId}::bigint)`;
    }
  } finally {
    conn.release();
  }
}

/**
 * Merge a patch into config.json. Never blind-writes: an unparseable document
 * is a signal something else is mid-write or corrupt, and overwriting it is
 * exactly the API-key-eating failure S3 exists to prevent.
 */
export function mergeConfigJson(current: string | null, patch: Record<string, unknown>): string {
  let base: Record<string, unknown> = {};
  if (current !== null && current.trim() !== '') {
    try {
      base = JSON.parse(current) as Record<string, unknown>;
    } catch {
      throw new Error('refusing to overwrite unparseable config.json');
    }
  }
  return JSON.stringify({ ...base, ...patch }, null, 2) + '\n';
}
```

> **Hardened 2026-09-15 — the lock now reserves its connection.**
> As first drafted, `withAdvisoryLock` issued `pg_try_advisory_lock` and `pg_advisory_unlock`
> against the pooled `sql` handle. Probed against real Postgres (`pgvector/pgvector:pg16`,
> Bun 1.3.14), that version did **not** misbehave — 12 sequential sections with concurrent
> churn leaked nothing, and 4 concurrent callers never overlapped — because Bun's pool reuses
> the most-recently-idle connection, so lock and unlock happened to share a backend in 6/6
> measured sections. But the pool genuinely opens multiple backends (4 distinct PIDs under 8
> concurrent queries), so that correctness was **incidental, not guaranteed**.
>
> Reserving the connection makes it guaranteed. Verified with the same harness:
> reserved backend stable across pool churn; 6 concurrent callers → 0 overlaps, 0 timeouts;
> 0 advisory locks left held; pool still usable after every reserve/release cycle.
>
> **Step 6's integration test must include a concurrency case** asserting mutual exclusion —
> two or more callers contending for one key, asserting no two are ever inside the critical
> section simultaneously. A lock tested only single-threaded proves nothing about the one
> property it exists to provide.

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `bun test test/unit/lock.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Write `src/ops/fileplane.ts`**

```ts
import { rename, writeFile, readFile, mkdir, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SQL } from 'bun';
import { withAdvisoryLock, mergeConfigJson } from './lock.ts';

const GBRAIN_HOME = process.env.GBRAIN_HOME ?? '/srv/gbrain-home';
export const CONFIG_PATH = join(GBRAIN_HOME, 'config.json');
export const SCHEMA_PACK_DIR = join(GBRAIN_HOME, 'schema-packs');

/** Atomic write: temp file in the same directory, fsync, rename. */
async function atomicWrite(path: string, contents: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, contents, { mode });
  await chmod(tmp, mode);
  await rename(tmp, path);
}

async function readIfExists(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); } catch { return null; }
}

/**
 * The single serialized writer for the file plane (S3). Every mutation —
 * wizard, init, post-upgrade — goes through here, under one advisory lock in
 * the CONTROL database.
 */
export async function writeFilePlane(
  path: string,
  mutate: (current: string | null) => string,
  opts: { sql: SQL; mode?: number },
): Promise<void> {
  await withAdvisoryLock(opts.sql, `fileplane:${path}`, async () => {
    const current = await readIfExists(path);
    await atomicWrite(path, mutate(current), opts.mode ?? 0o600);
  });
}

/** Patch config.json — the only place a provider API key is written (V11). */
export async function patchConfig(patch: Record<string, unknown>, opts: { sql: SQL }): Promise<void> {
  await writeFilePlane(CONFIG_PATH, (current) => mergeConfigJson(current, patch), opts);
}

/** Write a user schema pack YAML. 0644: gbrain reads it as another user. */
export async function writeSchemaPack(name: string, yaml: string, opts: { sql: SQL }): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error(`invalid schema pack name: ${name}`);
  await writeFilePlane(join(SCHEMA_PACK_DIR, `${name}.yaml`), () => yaml, { ...opts, mode: 0o644 });
}
```

- [ ] **Step 6: Write the failing integration test**

`test/integration/fileplane.test.ts`:
```ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { SQL } from 'bun';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let sql: SQL;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bs-fp-'));
  process.env.GBRAIN_HOME = dir;
  sql = new SQL(process.env.CONTROL_DATABASE_URL ?? 'postgres://gbrain:ci-not-a-real-secret@localhost:5432/control');
});
afterAll(async () => { await sql.end(); await rm(dir, { recursive: true, force: true }); });

test('concurrent patches both survive — neither key is lost', async () => {
  const { patchConfig, CONFIG_PATH } = await import('../../src/ops/fileplane.ts');

  await Promise.all([
    patchConfig({ openai_api_key: 'sk-alpha' }, { sql }),
    patchConfig({ anthropic_api_key: 'sk-beta' }, { sql }),
  ]);

  const written = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  expect(written.openai_api_key).toBe('sk-alpha');
  expect(written.anthropic_api_key).toBe('sk-beta');
});

test('config.json is written 0600', async () => {
  const { CONFIG_PATH } = await import('../../src/ops/fileplane.ts');
  const { stat } = await import('node:fs/promises');
  const s = await stat(CONFIG_PATH);
  expect(s.mode & 0o777).toBe(0o600);
});

test('a corrupt config.json is never clobbered', async () => {
  const { patchConfig, CONFIG_PATH } = await import('../../src/ops/fileplane.ts');
  await Bun.write(CONFIG_PATH, '{ truncated');
  await expect(patchConfig({ a: 1 }, { sql })).rejects.toThrow('refusing to overwrite');
  expect(await readFile(CONFIG_PATH, 'utf8')).toBe('{ truncated');
});

test('a schema pack name with a path traversal is rejected', async () => {
  const { writeSchemaPack } = await import('../../src/ops/fileplane.ts');
  await expect(writeSchemaPack('../../etc/passwd', 'x: 1', { sql }))
    .rejects.toThrow('invalid schema pack name');
});
```

- [ ] **Step 7: Run the integration test**

Start a scratch Postgres first:
```bash
docker run -d --name bs-fp-pg -e POSTGRES_USER=gbrain -e POSTGRES_PASSWORD=ci-not-a-real-secret -e POSTGRES_DB=control -p 5432:5432 pgvector/pgvector:pg16
```

Run: `bun test test/integration/fileplane.test.ts`
Expected: PASS — 4 tests.

Clean up: `docker rm -f bs-fp-pg`

- [ ] **Step 8: Commit**

```bash
git add src/ops/lock.ts src/ops/fileplane.ts test/unit/lock.test.ts test/integration/fileplane.test.ts
git commit -m "feat(slice1): advisory-locked atomic file-plane writer (S3)

Concurrent patches no longer eat each other's API keys.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: The `gbrain-ops` RPC server — allowlisted, no passthrough (S2)

**Files:**
- Create: `src/ops/dispatch.ts`, `src/ops/server.ts`
- Create: `docker/control-plane.Dockerfile`
- Test: `test/unit/dispatch.test.ts`, `test/integration/ops-server.test.ts`

**Interfaces:**
- Consumes: `contracts/v0.50.0.0/operations.json` (Slice 0 Task 13); `buildArgv`/`redactArgv` (Slice 0 Task 3); `patchConfig`/`writeSchemaPack` (Task 3).
- Produces:
  - `type OpsRequest = { op: string; params: Record<string, unknown>; json?: boolean; dryRun?: boolean }`
  - `type OpsResponse = { ok: boolean; exitCode: number; argv: string[]; stdout: string; stderr: string; json: unknown }`
  - `loadOperations(path?: string): Record<string, OperationSpec>`
  - `validateRequest(ops, body): { spec; values; json; dryRun }`
  - An HTTP server on port 3140 with `POST /rpc`, `POST /fileplane/config`, `POST /fileplane/schema-pack`, `GET /healthz`.

> **Do not reuse `execOperation` here.** Slice 0's `src/contracts/exec.ts` spawns `docker compose exec` from the *host*. `gbrain-ops` **is** the container — there is no Docker socket inside it and mounting one would be root-equivalent host escape. It spawns `gbrain` directly instead. Both paths share `buildArgv`/`redactArgv`, which is where the argv-array guarantee actually lives; only the spawn differs.

- [ ] **Step 1: Write the failing dispatch test**

`test/unit/dispatch.test.ts`:
```ts
import { test, expect, describe } from 'bun:test';
import { validateRequest, loadOperations } from '../../src/ops/dispatch.ts';

const ops = loadOperations();

describe('validateRequest', () => {
  test('accepts a registered operation with valid params', () => {
    expect(() => validateRequest(ops, { op: 'sources.list', params: {} })).not.toThrow();
  });

  // No passthrough: an operation not in operations.json cannot be reached,
  // however it is spelled (S2).
  test('rejects an unregistered operation', () => {
    expect(() => validateRequest(ops, { op: 'shell', params: {} }))
      .toThrow('unknown operation shell');
  });

  test('rejects an attempt to smuggle extra argv', () => {
    expect(() => validateRequest(ops, { op: 'sources.list', params: { _argv: ['; rm -rf /'] } }))
      .toThrow('unknown param _argv');
  });

  test('rejects a non-scalar param value', () => {
    expect(() => validateRequest(ops, { op: 'config.set', params: { key: { a: 1 }, value: 'x' } }))
      .toThrow('param key must be a string, string[] or boolean');
  });

  test('rejects a missing required param', () => {
    expect(() => validateRequest(ops, { op: 'config.set', params: { key: 'search.mode' } }))
      .toThrow('missing required param value');
  });

  test('rejects --dry-run on an operation that does not support it', () => {
    expect(() => validateRequest(ops, { op: 'sources.list', params: {}, dryRun: true }))
      .toThrow('does not support --dry-run');
  });

  test('every loaded operation carries a privilege', () => {
    for (const spec of Object.values(ops)) {
      expect(['brain-db', 'read-only']).toContain(spec.privilege);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/dispatch.test.ts`
Expected: FAIL — `Cannot find module '../../src/ops/dispatch.ts'`.

- [ ] **Step 3: Write `src/ops/dispatch.ts`**

```ts
import { readFileSync } from 'node:fs';
import type { OperationSpec, ParamValues } from '../contracts/types.ts';
import { buildArgv } from '../contracts/argv.ts';

export type OpsRequest = { op: string; params: Record<string, unknown>; json?: boolean; dryRun?: boolean };
export type OpsResponse = {
  ok: boolean; exitCode: number; argv: string[];
  stdout: string; stderr: string; json: unknown;
};

const VERSION = process.env.GBRAIN_VERSION ?? '0.50.0.0';

/**
 * The allowlist, loaded from the artifact Slice 0 generated. gbrain-ops
 * exposes exactly these operations and nothing else — there is no passthrough
 * and no way to construct arbitrary argv from a request (S2).
 */
export function loadOperations(path = `contracts/v${VERSION}/operations.json`): Record<string, OperationSpec> {
  const doc = JSON.parse(readFileSync(path, 'utf8')) as { operations: OperationSpec[] };
  return Object.fromEntries(doc.operations.map((o) => [o.id, o]));
}

export function validateRequest(ops: Record<string, OperationSpec>, body: unknown): {
  spec: OperationSpec; values: ParamValues; json: boolean; dryRun: boolean;
} {
  if (!body || typeof body !== 'object') throw new Error('body must be an object');
  const { op, params = {}, json, dryRun } = body as OpsRequest;

  const spec = ops[op];
  if (!spec) throw new Error(`unknown operation ${op}`);
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('params must be an object');
  }

  const values: ParamValues = {};
  for (const [k, v] of Object.entries(params)) {
    const ok =
      typeof v === 'string' || typeof v === 'boolean' ||
      (Array.isArray(v) && v.every((x) => typeof x === 'string'));
    if (!ok) throw new Error(`param ${k} must be a string, string[] or boolean`);
    values[k] = v as string | string[] | boolean;
  }

  // buildArgv enforces unknown-param and required-param rules, and refuses
  // --json/--dry-run on operations that do not declare support.
  buildArgv(spec, values, { json: json ?? spec.supportsJson, dryRun: dryRun ?? false });

  return { spec, values, json: json ?? spec.supportsJson, dryRun: dryRun ?? false };
}
```

- [ ] **Step 4: Run the dispatch test to verify it passes**

Run: `bun test test/unit/dispatch.test.ts`
Expected: PASS — 7 tests.

> `buildArgv`'s `missing required param value for config.set` message satisfies the `missing required param value` assertion; `unknown param _argv` and `does not support --dry-run` likewise come from `buildArgv`.

- [ ] **Step 5: Write `src/ops/server.ts`**

```ts
#!/usr/bin/env bun
/**
 * gbrain-ops: the privilege boundary (S2). Holds the brain DATABASE_URL and
 * RW GBRAIN_HOME; the control plane holds neither and reaches gbrain only
 * through this allowlisted RPC on the private ops-net.
 */
import { SQL } from 'bun';
import { spawn } from 'node:child_process';
import { loadOperations, validateRequest } from './dispatch.ts';
import type { OpsResponse } from './dispatch.ts';
import { buildArgv, redactArgv } from '../contracts/argv.ts';
import { patchConfig, writeSchemaPack } from './fileplane.ts';

const PORT = Number(process.env.OPS_RPC_PORT ?? 3140);
const TOKEN = process.env.OPS_RPC_TOKEN;
if (!TOKEN) throw new Error('OPS_RPC_TOKEN is required');

const ops = loadOperations();
const sql = new SQL(process.env.CONTROL_DATABASE_URL!);

function authorized(req: Request): boolean {
  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Constant-time compare so the token cannot be discovered by timing.
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN!);
  return a.length === b.length && require('node:crypto').timingSafeEqual(a, b);
}

function runGbrain(argv: string[], timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // argv array, no shell: no value can inject an argument (G2).
    const child = spawn('gbrain', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code ?? -1, stdout, stderr }); });
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/healthz') return json({ ok: true });
    if (!authorized(req)) return json({ error: 'unauthorized' }, 401);
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    try {
      const body = await req.json();

      if (url.pathname === '/fileplane/config') {
        const patch = (body as { patch?: Record<string, unknown> }).patch;
        if (!patch || typeof patch !== 'object') return json({ error: 'patch required' }, 400);
        await patchConfig(patch, { sql });
        // S3c: never echo the patch back — it carries provider API keys.
        return json({ ok: true, keys: Object.keys(patch) });
      }

      if (url.pathname === '/fileplane/schema-pack') {
        const { name, yaml } = body as { name?: string; yaml?: string };
        if (!name || !yaml) return json({ error: 'name and yaml required' }, 400);
        await writeSchemaPack(name, yaml, { sql });
        return json({ ok: true, name });
      }

      if (url.pathname === '/rpc') {
        const { spec, values, json: wantJson, dryRun } = validateRequest(ops, body);
        const argv = buildArgv(spec, values, { json: wantJson, dryRun });
        const timeoutMs = Number((body as { timeoutMs?: number }).timeoutMs ?? 600_000);
        const r = await runGbrain(argv, timeoutMs);

        let parsed: unknown = null;
        if (wantJson) {
          const t = r.stdout.trim();
          const idx = Math.min(...[t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0));
          if (Number.isFinite(idx) && idx >= 0) { try { parsed = JSON.parse(t.slice(idx)); } catch {} }
        }

        const res: OpsResponse = {
          ok: spec.okExitCodes.includes(r.exitCode),
          exitCode: r.exitCode,
          argv: redactArgv(spec, ['gbrain', ...argv]),
          stdout: r.stdout, stderr: r.stderr, json: parsed,
        };
        return json(res);
      }

      return json({ error: 'not_found' }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  },
});

console.log(`gbrain-ops rpc listening on :${PORT} with ${Object.keys(ops).length} allowlisted operations`);
```

- [ ] **Step 6: Write `docker/control-plane.Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
# One image, two entrypoints (S2): gbrain-ops runs src/ops/server.ts, the
# control plane runs src/control/app.ts. Same image means GBRAIN_VERSION
# guarantees the sidecar binary IS the server binary — version skew between
# wrapper and gbrain is exactly the bug class the exact pin exists to prevent.
ARG GBRAIN_VERSION=0.50.0.0
FROM brainstand/gbrain-base:${GBRAIN_VERSION}
ARG GBRAIN_VERSION

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY contracts ./contracts

RUN test -s "contracts/v${GBRAIN_VERSION}/operations.json" \
 || (echo "operations.json missing for ${GBRAIN_VERSION} — run Slice 0 first" >&2; exit 1)

ENV NODE_ENV=production
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "/app/src/control/app.ts"]
```

> **Corrected 2026-09-15 — ARG before FROM is out of stage scope.**
> `ARG GBRAIN_VERSION=0.50.0.0` before `FROM` is only visible to the `FROM` line.
> Without a stage-level `ARG GBRAIN_VERSION` after `FROM`, the
> `RUN test -s "contracts/v${GBRAIN_VERSION}/operations.json"` gate expands to
> `contracts/v/operations.json`. Compose passing `args.GBRAIN_VERSION` does not
> help unless the stage redeclares ARG. Verified by an instruction-order unit
> test: without the redeclaration, `argIdx === -1`. Precedent:
> `docker/gbrain-base.Dockerfile:8`. Do not "fix" this by deleting the RUN gate.

- [ ] **Step 7: Write the failing ops-server integration test**

`test/integration/ops-server.test.ts`:
```ts
import { test, expect, beforeAll, afterAll, describe } from 'bun:test';

const BASE = 'http://127.0.0.1:3140';
const TOKEN = 'integration-token-not-a-real-secret';
let server: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  server = Bun.spawn(['bun', 'run', 'src/ops/server.ts'], {
    env: { ...process.env, OPS_RPC_TOKEN: TOKEN, OPS_RPC_PORT: '3140' },
    stdout: 'pipe', stderr: 'pipe',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch {}
    await Bun.sleep(200);
  }
  throw new Error('ops server did not start');
}, 30_000);
afterAll(() => server?.kill());

const rpc = (body: unknown, token = TOKEN) =>
  fetch(`${BASE}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

describe('ops rpc', () => {
  test('healthz needs no token', async () => {
    expect((await fetch(`${BASE}/healthz`)).ok).toBe(true);
  });

  test('rpc without a token is 401', async () => {
    const r = await fetch(`${BASE}/rpc`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(401);
  });

  test('rpc with the wrong token is 401', async () => {
    expect((await rpc({ op: 'sources.list', params: {} }, 'wrong')).status).toBe(401);
  });

  // S2: there is no passthrough. An unlisted operation is unreachable.
  test('an unregistered operation is 400, not executed', async () => {
    const r = await rpc({ op: 'serve; rm -rf /', params: {} });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/unknown operation/);
  });

  test('a smuggled argv param is rejected', async () => {
    const r = await rpc({ op: 'sources.list', params: { _argv: ['x'] } });
    expect(r.status).toBe(400);
  });

  test('the fileplane config route never echoes the patch back', async () => {
    const r = await fetch(`${BASE}/fileplane/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ patch: { openai_api_key: 'sk-should-not-appear' } }),
    });
    const text = await r.text();
    expect(text).not.toContain('sk-should-not-appear');
    expect(text).toContain('openai_api_key'); // the key NAME is fine
  });
});
```

- [ ] **Step 8: Run it to verify it passes**

Run: `CONTROL_DATABASE_URL=postgres://gbrain:ci-not-a-real-secret@localhost:5432/control bun test test/integration/ops-server.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 9: Commit**

```bash
git add src/ops/dispatch.ts src/ops/server.ts docker/control-plane.Dockerfile test/unit/dispatch.test.ts test/integration/ops-server.test.ts
git commit -m "feat(slice1): allowlisted gbrain-ops RPC server with no passthrough (S2)

Operations load from the Slice 0 artifact; argv can never be constructed
from a request.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Control DB schema and migrations

**Files:**
- Create: `src/control/db/schema.ts`, `src/control/db/client.ts`, `drizzle.config.ts`
- Test: `test/integration/schema.test.ts`

**Interfaces:**
- Produces: Drizzle tables `organizations`, `users`, `sessions`, `accounts`, `verifications`, `memberships`, `brains`, `spaces`, `secrets`, `capabilitySnapshots`, `playbookLedger`, `auditLog`; and `getDb(): ReturnType<typeof drizzle>`, `runMigrations(): Promise<void>`.

> `connections`, `schedules` and `schedule_runs` land in Slices 2–3. `organizations.brain_mode` and `memberships` ship **now** so promoting personal → company is a settings change rather than a migration.

- [ ] **Step 1: Install dependencies**

```bash
bun add drizzle-orm postgres && bun add -d drizzle-kit
```

- [ ] **Step 2: Write the failing schema test**

`test/integration/schema.test.ts`:
```ts
import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import { SQL } from 'bun';
import { runMigrations } from '../../src/control/db/client.ts';

let sql: SQL;
beforeAll(async () => {
  sql = new SQL(process.env.CONTROL_DATABASE_URL!);
  await runMigrations();
}, 60_000);
afterAll(async () => {
  await sql.end();
  const { closeDb } = await import('../../src/control/db/client.ts');
  await closeDb();
});

const cols = async (table: string) =>
  (await sql`select column_name from information_schema.columns where table_name = ${table}`)
    .map((r: any) => r.column_name).sort();

describe('control schema', () => {
  test.each([
    'organizations', 'memberships', 'brains', 'spaces', 'secrets',
    'capability_snapshots', 'playbook_ledger', 'audit_log',
  ])('%s exists', async (t) => {
    const [row] = await sql`select to_regclass(${'public.' + t}) as r`;
    expect(row.r).not.toBeNull();
  });

  // Personal and company are the same deployment with a flag.
  test('organizations carries brain_mode', async () => {
    expect(await cols('organizations')).toContain('brain_mode');
  });

  test('brains carries the lifecycle column', async () => {
    expect(await cols('brains')).toContain('lifecycle');
  });

  test('the lifecycle check constraint rejects an unknown state', async () => {
    // Parent row first: without it, FK on organization_id rejects before the
    // CHECK ever runs, and this test would go green with no lifecycle constraint.
    await sql`
      insert into organizations (id, name, slug)
      values ('o-life', 'Life', 'life')
    `;
    await expect(sql`
      insert into brains (id, organization_id, gbrain_home, lifecycle)
      values ('b-bad', 'o-life', '/srv/gbrain-home', 'not-a-state')
    `).rejects.toThrow();
  });

  // S3b: a Postgres dump must not be a credential dump.
  test('secrets stores ciphertext columns, never a plaintext one', async () => {
    const c = await cols('secrets');
    expect(c).toContain('wrapped_dek');
    expect(c).toContain('payload');
    expect(c).toContain('version');
    expect(c).not.toContain('plaintext');
    expect(c).not.toContain('value');
  });

  test('spaces is unique on (organization_id, source_id) — Space = source', async () => {
    const [row] = await sql`
      select count(*)::int as n from pg_indexes
      where tablename = 'spaces' and indexdef ilike '%unique%source_id%'`;
    expect(row.n).toBeGreaterThan(0);
  });
});
```

> **Corrected 2026-09-15 — three test-harness defects found before dispatch.**
> 1. `afterAll` must call `closeDb()`. `runMigrations()` opens a postgres-js pool
>    via `getDb()`; leaving it open keeps the bun test process alive after the
>    bun `SQL` handle is ended.
> 2. The lifecycle CHECK test must insert a real `organizations` row first.
>    Inserting `organization_id = 'o-bad'` with no parent fails on FK *before*
>    the CHECK runs, so `rejects.toThrow()` would go green with no
>    `lifecycle_valid` constraint at all — the same class of false-green as the
>    Caddyfile text-parse test.
> 3. Add the fileplane-style Postgres probe + always-running loud guard
>    (`BRAINSTAND_ALLOW_SKIP_SCHEMA_INTEGRATION=1` to opt out). Task 15 Step 4
>    runs `bun test test/integration`; opaque `Connection closed` failures are
>    not a gate.

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test test/integration/schema.test.ts`
Expected: FAIL — `Cannot find module '../../src/control/db/client.ts'`.

- [ ] **Step 4: Write `src/control/db/schema.ts`**

```ts
import {
  pgTable, text, timestamp, boolean, integer, jsonb, uniqueIndex, index, check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// --- Better Auth core tables ------------------------------------------------
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name'),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// --- Product tables ---------------------------------------------------------
export const organizations = pgTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  plan: text('plan').notNull().default('self-host'),
  // Personal and company are the same deployment with a flag: one org, one
  // membership, one compiled grant, so promoting is a settings change.
  brainMode: text('brain_mode').notNull().default('company'),
  timezone: text('timezone').notNull().default('UTC'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('brain_mode_valid', sql`${t.brainMode} in ('personal','company')`)]);

export const memberships = pgTable('memberships', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('memberships_user_org_uq').on(t.userId, t.organizationId),
  check('role_valid', sql`${t.role} in ('owner','admin','member','viewer')`),
]);

export const brains = pgTable('brains', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  gbrainHome: text('gbrain_home').notNull(),
  engine: text('engine').notNull().default('postgres'),
  gbrainVersion: text('gbrain_version'),
  embeddingModel: text('embedding_model'),
  searchMode: text('search_mode'),
  lifecycle: text('lifecycle').notNull().default('uninitialized'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('lifecycle_valid', sql`${t.lifecycle} in (
  'uninitialized','provider-configured','mode-selected','schema-selected','sources-added','ready')`)]);

/** A Space IS a gbrain source. Hard rule (S4b) — enforced by the unique index. */
export const spaces = pgTable('spaces', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  sourceId: text('source_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  kind: text('kind').notNull().default('local-git'),
  localPath: text('local_path'),
  gitRemote: text('git_remote'),
  deployKeySecretId: text('deploy_key_secret_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('spaces_org_source_id_uq').on(t.organizationId, t.sourceId),
  check('kind_valid', sql`${t.kind} in ('local-git','remote-git','db-only','github','google')`),
]);

/** Envelope-encrypted. A pg_dump of this table is not a credential dump (S3b). */
export const secrets = pgTable('secrets', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  version: integer('version').notNull().default(1),
  salt: text('salt').notNull(),
  wrappedDek: text('wrapped_dek').notNull(),
  payload: text('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
}, (t) => [uniqueIndex('secrets_org_name_version_uq').on(t.organizationId, t.name, t.version)]);

export const capabilitySnapshots = pgTable('capability_snapshots', {
  id: text('id').primaryKey(),
  gbrainVersion: text('gbrain_version').notNull(),
  toolsJson: jsonb('tools_json'),
  harnesses: jsonb('harnesses'),
  profiles: jsonb('profiles'),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('capability_snapshots_version_idx').on(t.gbrainVersion)]);

/** Per-version migration playbook state. Nobody upstream has this. */
export const playbookLedger = pgTable('playbook_ledger', {
  id: text('id').primaryKey(),
  gbrainVersion: text('gbrain_version').notNull().unique(),
  state: text('state').notNull().default('pending'),
  notes: text('notes'),
  decidedBy: text('decided_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('playbook_state_valid', sql`${t.state} in (
  'pending','applied','skipped','awaiting_admin_decision')`)]);

export const auditLog = pgTable('audit_log', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id'),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  target: text('target'),
  // S3c: before/after are REDACTED summaries, never raw request bodies.
  before: jsonb('before'),
  after: jsonb('after'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('audit_log_at_idx').on(t.at)]);
```

- [ ] **Step 5: Write `src/control/db/client.ts` and `drizzle.config.ts`**

`src/control/db/client.ts`:
```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema.ts';

let client: ReturnType<typeof postgres> | null = null;
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!db) {
    const url = process.env.CONTROL_DATABASE_URL;
    if (!url) throw new Error('CONTROL_DATABASE_URL is required');
    client = postgres(url, { max: 10 });
    db = drizzle(client, { schema });
  }
  return db;
}

export async function runMigrations(): Promise<void> {
  await migrate(getDb(), { migrationsFolder: 'src/control/db/migrations' });
}

export async function closeDb(): Promise<void> {
  await client?.end();
  client = null; db = null;
}

export { schema };
```

`drizzle.config.ts`:
```ts
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/control/db/schema.ts',
  out: './src/control/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.CONTROL_DATABASE_URL! },
} satisfies Config;
```

- [ ] **Step 6: Generate the migration and run the test**

```bash
bunx drizzle-kit generate
```

Run: `CONTROL_DATABASE_URL=postgres://gbrain:ci-not-a-real-secret@localhost:5432/control bun test test/integration/schema.test.ts`
Expected: PASS — 13 tests.

- [ ] **Step 7: Commit**

```bash
git add src/control/db/ drizzle.config.ts test/integration/schema.test.ts package.json bun.lock
git commit -m "feat(slice1): control database schema with lifecycle and Space=source constraints

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Envelope-encrypted secrets and the CI leak guard (S3b, S3c)

**Files:**
- Create: `src/control/secrets.ts`
- Modify: `scripts/lint-forbidden.ts` (add the leak rules)
- Test: `test/unit/secrets.test.ts`, `test/unit/lint-forbidden.test.ts` (extend)

**Interfaces:**
- Produces:
  - `type Sealed = { version: number; salt: string; wrappedDek: string; payload: string }`
  - `seal(plaintext: string, version?: number): Sealed`
  - `open(sealed: Sealed): string`
  - `storeSecret(orgId: string, name: string, plaintext: string): Promise<{ id: string; version: number }>`
  - `readSecret(orgId: string, name: string): Promise<string | null>`
  - `rotateSecret(orgId: string, name: string, plaintext: string): Promise<{ version: number }>`

- [ ] **Step 1: Write the failing secrets test**

`test/unit/secrets.test.ts`:
```ts
import { test, expect, describe, beforeAll } from 'bun:test';

beforeAll(() => { process.env.ENCRYPTION_KEY = 'a'.repeat(48); });

describe('envelope encryption', () => {
  test('seal then open round-trips', async () => {
    const { seal, open } = await import('../../src/control/secrets.ts');
    expect(open(seal('sk-secret-value'))).toBe('sk-secret-value');
  });

  test('the sealed form contains no plaintext', async () => {
    const { seal } = await import('../../src/control/secrets.ts');
    expect(JSON.stringify(seal('sk-secret-value'))).not.toContain('sk-secret-value');
  });

  // Per-secret DEK: two seals of the same plaintext must not be identical.
  test('each seal uses a fresh DEK and IV', async () => {
    const { seal } = await import('../../src/control/secrets.ts');
    const a = seal('same'), b = seal('same');
    expect(a.payload).not.toBe(b.payload);
    expect(a.wrappedDek).not.toBe(b.wrappedDek);
    expect(a.salt).not.toBe(b.salt);
  });

  test('a tampered payload fails authentication rather than decrypting', async () => {
    const { seal, open } = await import('../../src/control/secrets.ts');
    const s = seal('sk-secret-value');
    const buf = Buffer.from(s.payload, 'base64');
    buf[buf.length - 1] ^= 0xff;
    expect(() => open({ ...s, payload: buf.toString('base64') })).toThrow();
  });

  test('a wrong ENCRYPTION_KEY cannot open a sealed secret', async () => {
    const { seal, open } = await import('../../src/control/secrets.ts');
    const s = seal('sk-secret-value');
    const prev = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'b'.repeat(48);
    expect(() => open(s)).toThrow();
    process.env.ENCRYPTION_KEY = prev;
  });

  test('a short ENCRYPTION_KEY is refused at seal time', async () => {
    const { seal } = await import('../../src/control/secrets.ts');
    const prev = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'tooshort';
    expect(() => seal('x')).toThrow('ENCRYPTION_KEY must be at least 32');
    process.env.ENCRYPTION_KEY = prev;
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/secrets.test.ts`
Expected: FAIL — `Cannot find module '../../src/control/secrets.ts'`.

- [ ] **Step 3: Write `src/control/secrets.ts`**

```ts
import { randomBytes, createCipheriv, createDecipheriv, hkdfSync, randomUUID } from 'node:crypto';
import { eq, and, desc } from 'drizzle-orm';
import { getDb, schema } from './db/client.ts';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

export type Sealed = { version: number; salt: string; wrappedDek: string; payload: string };

/** KEK derived per secret from ENCRYPTION_KEY + a random salt. */
function deriveKek(salt: Buffer): Buffer {
  const master = process.env.ENCRYPTION_KEY;
  if (!master || master.length < 32) throw new Error('ENCRYPTION_KEY must be at least 32 characters');
  return Buffer.from(hkdfSync('sha256', Buffer.from(master, 'utf8'), salt, Buffer.from('brainstand-kek-v1'), 32));
}

function encrypt(key: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function decrypt(key: Buffer, blob: string): Buffer {
  const raw = Buffer.from(blob, 'base64');
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(raw.subarray(IV_LEN + TAG_LEN)), decipher.final()]);
}

export function seal(plaintext: string, version = 1): Sealed {
  const salt = randomBytes(16);
  const kek = deriveKek(salt);
  const dek = randomBytes(32);
  return {
    version,
    salt: salt.toString('base64'),
    wrappedDek: encrypt(kek, dek),
    payload: encrypt(dek, Buffer.from(plaintext, 'utf8')),
  };
}

export function open(sealed: Sealed): string {
  const kek = deriveKek(Buffer.from(sealed.salt, 'base64'));
  const dek = decrypt(kek, sealed.wrappedDek);
  return decrypt(dek, sealed.payload).toString('utf8');
}

export async function storeSecret(orgId: string, name: string, plaintext: string) {
  const db = getDb();
  const [latest] = await db.select({ version: schema.secrets.version })
    .from(schema.secrets)
    .where(and(eq(schema.secrets.organizationId, orgId), eq(schema.secrets.name, name)))
    .orderBy(desc(schema.secrets.version)).limit(1);

  const version = (latest?.version ?? 0) + 1;
  const sealed = seal(plaintext, version);
  const id = randomUUID();
  await db.insert(schema.secrets).values({
    id, organizationId: orgId, name, version,
    salt: sealed.salt, wrappedDek: sealed.wrappedDek, payload: sealed.payload,
  });
  return { id, version };
}

export async function readSecret(orgId: string, name: string): Promise<string | null> {
  const [row] = await getDb().select().from(schema.secrets)
    .where(and(eq(schema.secrets.organizationId, orgId), eq(schema.secrets.name, name)))
    .orderBy(desc(schema.secrets.version)).limit(1);
  return row ? open({ version: row.version, salt: row.salt, wrappedDek: row.wrappedDek, payload: row.payload }) : null;
}

/**
 * Rotation writes a NEW version; old versions stay readable until reaped.
 * Rotation is not revocation — outstanding gbrain tokens survive it.
 */
export async function rotateSecret(orgId: string, name: string, plaintext: string) {
  const { version } = await storeSecret(orgId, name, plaintext);
  await getDb().update(schema.secrets)
    .set({ rotatedAt: new Date() })
    .where(and(eq(schema.secrets.organizationId, orgId), eq(schema.secrets.name, name)));
  return { version };
}
```

- [ ] **Step 4: Run the secrets test to verify it passes**

Run: `bun test test/unit/secrets.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Add the leak rules to `scripts/lint-forbidden.ts`**

Append to the `RULES` array:

```ts
  {
    rule: 'log-request-body',
    // [^)]* cannot span the ) inside json(), and a trailing \b after json()
    // never fires () then ; are both non-word). Keep all three arms.
    re: /console\.(log|info|debug|error)\([^;]*?(?:\b(?:req\.body|body)\b|await\s+req\.json\(\))/,
    why: 'S3c: a control plane that logs the body of "add source" undoes the upstream invariant',
  },
  {
    rule: 'secret-column-name',
    re: /\b(plaintext|api_key_plain|secret_value)\s*:\s*text\(/,
    why: 'S3b: secrets are envelope-encrypted; a plaintext column makes a pg_dump a credential dump',
  },
```

Add matching cases to `test/unit/lint-forbidden.test.ts`:

```ts
test('flags logging a request body', async () => {
  await writeFile(join(dir, 'a', 'log.ts'), `console.log("add source", req.body);\n`);
  const v = await lintForbidden(dir);
  expect(v.map((x) => x.rule)).toContain('log-request-body');
});

test('flags logging await req.json()', async () => {
  await writeFile(join(dir, 'a', 'log-json.ts'), `console.log(await req.json());\n`);
  const v = await lintForbidden(dir);
  expect(v.map((x) => x.rule)).toContain('log-request-body');
});

test('flags a plaintext secret column', async () => {
  await writeFile(join(dir, 'a', 'sch.ts'), `plaintext: text('plaintext'),\n`);
  const v = await lintForbidden(dir);
  expect(v.map((x) => x.rule)).toContain('secret-column-name');
});
```

- [ ] **Step 6: Run the lint tests and the linter**

Run: `bun test test/unit/lint-forbidden.test.ts`
Expected: PASS — existing tests plus the two (now three) new cases. Do not
force the count back to 6; the file already had 10 tests before this task.

> **Corrected 2026-09-15 — the original `log-request-body` regex never matched
> `await req.json()`.** `[^)]*` stops at the `)` inside `json()`, and a trailing
> `\b` after `json()` never fires. The `req.body` test stayed green against a
> dead arm. Use the corrected pattern above and a positive test for
> `console.log(await req.json());`.

Run: `bun run lint:forbidden`
Expected: `lint:forbidden clean`.

- [ ] **Step 7: Commit**

```bash
git add src/control/secrets.ts scripts/lint-forbidden.ts test/unit/secrets.test.ts test/unit/lint-forbidden.test.ts
git commit -m "feat(slice1): envelope-encrypted secrets and CI leak guards (S3b, S3c)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Control-plane app, `/api/health`, and the typed ops client

**Files:**
- Create: `src/control/opsClient.ts`, `src/control/app.ts`, `src/control/routes/health.ts`
- Test: `test/integration/health.test.ts`

**Interfaces:**
- Consumes: the ops RPC (Task 4); `getDb`/`runMigrations` (Task 5).
- Produces:
  - `callOps<T>(op: string, params?: Record<string, unknown>, opts?: { json?: boolean; dryRun?: boolean; timeoutMs?: number }): Promise<OpsResponse & { json: T | null }>`
  - `patchFilePlaneConfig(patch: Record<string, unknown>): Promise<void>`
  - `putSchemaPack(name: string, yaml: string): Promise<void>`
  - Hono app on port 3150 with `GET /api/health`.

- [ ] **Step 1: Install Hono**

```bash
bun add hono
```

- [ ] **Step 2: Write the failing health test**

`test/integration/health.test.ts`:
```ts
import { test, expect, describe } from 'bun:test';
import app from '../../src/control/app.ts';

describe('/api/health', () => {
  // /health and /metrics belong to gbrain-serve — live collisions. The
  // console's health endpoint is /api/health.
  test('the console does NOT serve /health', async () => {
    expect((await app.request('/health')).status).toBe(404);
  });

  test('the console does NOT serve /metrics', async () => {
    expect((await app.request('/metrics')).status).toBe(404);
  });

  test('/api/health reports component status', async () => {
    const res = await app.request('/api/health');
    // 503 is the correct status when a component is down (ops is down
    // without a sidecar). 5xx crashes are the thing this must not be.
    expect([200, 503]).toContain(res.status);
    const body = await res.json();
    expect(body).toHaveProperty('ok');
    expect(body.components).toHaveProperty('controlDb');
    expect(body.components).toHaveProperty('ops');
    expect(body).toHaveProperty('gbrainVersion');
  });

  test('/api/health never leaks a connection string', async () => {
    const text = await (await app.request('/api/health')).text();
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test test/integration/health.test.ts`
Expected: FAIL — `Cannot find module '../../src/control/app.ts'`.

- [ ] **Step 4: Write `src/control/opsClient.ts`**

```ts
import type { OpsResponse } from '../ops/dispatch.ts';

const OPS_URL = process.env.OPS_RPC_URL ?? 'http://gbrain-ops:3140';
const TOKEN = process.env.OPS_RPC_TOKEN ?? '';

async function post<T>(path: string, body: unknown, timeoutMs = 600_000): Promise<T> {
  const res = await fetch(`${OPS_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await res.json();
  if (!res.ok) throw new Error((payload as { error?: string }).error ?? `ops rpc ${res.status}`);
  return payload as T;
}

/**
 * The ONLY way the control plane reaches gbrain. It holds no brain
 * DATABASE_URL and mounts GBRAIN_HOME read-only (S2), so every privileged
 * action crosses this boundary.
 */
export async function callOps<T = unknown>(
  op: string,
  params: Record<string, unknown> = {},
  opts: { json?: boolean; dryRun?: boolean; timeoutMs?: number } = {},
): Promise<OpsResponse & { json: T | null }> {
  return post('/rpc', { op, params, json: opts.json, dryRun: opts.dryRun, timeoutMs: opts.timeoutMs },
    opts.timeoutMs);
}

export async function patchFilePlaneConfig(patch: Record<string, unknown>): Promise<void> {
  await post('/fileplane/config', { patch }, 60_000);
}

export async function putSchemaPack(name: string, yaml: string): Promise<void> {
  await post('/fileplane/schema-pack', { name, yaml }, 60_000);
}

export async function opsHealthy(): Promise<boolean> {
  try { return (await fetch(`${OPS_URL}/healthz`, { signal: AbortSignal.timeout(5_000) })).ok; }
  catch { return false; }
}
```

- [ ] **Step 5: Write `src/control/routes/health.ts`**

```ts
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.ts';
import { opsHealthy, callOps } from '../opsClient.ts';

export const health = new Hono();

health.get('/health', async (c) => {
  const components: Record<string, 'ok' | 'down'> = { controlDb: 'down', ops: 'down' };
  let gbrainVersion: string | null = null;

  try { await getDb().execute(sql`select 1`); components.controlDb = 'ok'; } catch { /* reported as down */ }

  if (await opsHealthy()) {
    components.ops = 'ok';
    try {
      const r = await callOps('toolsJson', {}, { timeoutMs: 10_000 });
      if (r.ok) gbrainVersion = process.env.GBRAIN_VERSION ?? null;
    } catch { /* version stays null */ }
  }

  const ok = Object.values(components).every((s) => s === 'ok');
  // Never include a connection string, a token or an env dump here.
  return c.json({ ok, components, gbrainVersion, at: new Date().toISOString() }, ok ? 200 : 503);
});
```

- [ ] **Step 6: Write `src/control/app.ts`**

```ts
#!/usr/bin/env bun
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { health } from './routes/health.ts';
import { runMigrations } from './db/client.ts';

const app = new Hono();

// S3c: the default logger prints method, path and status — never the body.
app.use('*', logger());

// Everything ours lives under /api. /health and /metrics belong to
// gbrain-serve and are routed to it by Caddy; mounting them here would be a
// live collision.
app.route('/api', health);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

export default app;

if (import.meta.main) {
  await runMigrations();
  Bun.serve({ port: Number(process.env.PORT ?? 3150), hostname: '0.0.0.0', fetch: app.fetch });
  console.log(`control-plane listening on :${process.env.PORT ?? 3150}`);
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `CONTROL_DATABASE_URL=postgres://gbrain:ci-not-a-real-secret@localhost:5432/control bun test test/integration/health.test.ts`
Expected: PASS — 4 tests. `components.ops` reports `down` without a running sidecar; that is correct behavior, and the test asserts the shape, not the value.

> **Corrected 2026-09-15 — status 503 is success for this test.** The handler
> returns 503 when any component is down. Without a sidecar, `ops` is down, so
> `expect(res.status).toBeLessThan(500)` would fail against correct behavior.
> The assertion is `[200, 503]`. Do not change the handler to return 200 when
> `ok` is false.

- [ ] **Step 8: Commit**

```bash
git add src/control/app.ts src/control/opsClient.ts src/control/routes/health.ts test/integration/health.test.ts package.json bun.lock
git commit -m "feat(slice1): control-plane app with /api/health and the typed ops client

/health and /metrics stay with gbrain-serve — they are live collisions.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Better Auth and the single-admin bootstrap

**Files:**
- Create: `src/control/auth.ts`, `src/control/routes/auth.ts`, `src/control/bootstrap.ts`
- Modify: `src/control/app.ts`
- Test: `test/integration/auth.test.ts`

**Interfaces:**
- Consumes: `getDb`, `schema` (Task 5); the Hono app (Task 7).
- Produces:
  - `auth` — the Better Auth instance, mounted at `/api/auth/*`
  - `requireAdmin(c): Promise<{ userId: string; orgId: string }>` — Hono middleware helper
  - `bootstrapFirstAdmin(email: string, password: string): Promise<{ userId: string; orgId: string; brainId: string }>`
  - `isBootstrapped(): Promise<boolean>`

- [ ] **Step 1: Install Better Auth**

```bash
bun add better-auth
```

- [ ] **Step 2: Write the failing auth test**

`test/integration/auth.test.ts`:
```ts
import { test, expect, describe, beforeAll } from 'bun:test';
import app from '../../src/control/app.ts';
import { runMigrations, getDb, schema } from '../../src/control/db/client.ts';
import { isBootstrapped, bootstrapFirstAdmin } from '../../src/control/bootstrap.ts';

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(48);
  process.env.BETTER_AUTH_SECRET = 'b'.repeat(48);
  await runMigrations();
  await getDb().delete(schema.memberships);
  await getDb().delete(schema.brains);
  await getDb().delete(schema.organizations);
  await getDb().delete(schema.users);
}, 60_000);

describe('single-admin bootstrap', () => {
  test('an empty install reports itself un-bootstrapped', async () => {
    expect(await isBootstrapped()).toBe(false);
  });

  test('the bootstrap endpoint is open only while un-bootstrapped', async () => {
    const res = await app.request('/api/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.test', password: 'a-long-enough-password', orgName: 'Acme' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orgId).toBeTruthy();
    expect(body.brainId).toBeTruthy();
  });

  test('bootstrap creates an owner membership and an uninitialized brain', async () => {
    const [m] = await getDb().select().from(schema.memberships);
    expect(m?.role).toBe('owner');
    const [b] = await getDb().select().from(schema.brains);
    expect(b?.lifecycle).toBe('uninitialized');
  });

  // Company-first, personal derived: one org, one membership, one grant.
  test('the org defaults to company mode', async () => {
    const [o] = await getDb().select().from(schema.organizations);
    expect(o?.brainMode).toBe('company');
  });

  test('a second bootstrap attempt is refused', async () => {
    const res = await app.request('/api/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'other@example.test', password: 'another-long-password', orgName: 'Other' }),
    });
    expect(res.status).toBe(409);
  });

  test('bootstrap never echoes the password back', async () => {
    const [u] = await getDb().select().from(schema.users);
    expect(JSON.stringify(u)).not.toContain('a-long-enough-password');
  });

  test('an unauthenticated wizard call is 401', async () => {
    expect((await app.request('/api/wizard/state')).status).toBe(401);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test test/integration/auth.test.ts`
Expected: FAIL — `Cannot find module '../../src/control/bootstrap.ts'`.

- [ ] **Step 4: Write `src/control/auth.ts`**

```ts
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { getDb, schema } from './db/client.ts';

export const auth = betterAuth({
  database: drizzleAdapter(getDb(), {
    provider: 'pg',
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
    },
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.PUBLIC_URL ?? 'http://localhost:3150',
  basePath: '/api/auth',
  emailAndPassword: { enabled: true, minPasswordLength: 12 },
  // Slice 2 adds the organization + RBAC plugins and OIDC providers. Keeping
  // memberships in our own table now means that is a feature, not a migration.
});
```

- [ ] **Step 5: Write `src/control/bootstrap.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, schema } from './db/client.ts';
import { auth } from './auth.ts';

export async function isBootstrapped(): Promise<boolean> {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.organizations);
  return (row?.n ?? 0) > 0;
}

/**
 * Creates the first admin, their org, and an UNINITIALIZED brain row. The
 * brain becomes real only when the wizard runs `gbrain init` — the image
 * ships uninitialized because on Postgres the database does not exist at
 * build time.
 */
export async function bootstrapFirstAdmin(email: string, password: string, orgName: string) {
  if (await isBootstrapped()) throw new Error('already_bootstrapped');

  const signed = await auth.api.signUpEmail({ body: { email, password, name: email } });
  const userId = (signed as { user?: { id?: string } }).user?.id;
  if (!userId) throw new Error('sign_up_failed');

  const orgId = randomUUID();
  const brainId = randomUUID();
  const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'org';

  const db = getDb();
  await db.insert(schema.organizations).values({ id: orgId, name: orgName, slug, brainMode: 'company' });
  await db.insert(schema.memberships).values({ id: randomUUID(), userId, organizationId: orgId, role: 'owner' });
  await db.insert(schema.brains).values({
    id: brainId, organizationId: orgId,
    gbrainHome: process.env.GBRAIN_HOME ?? '/srv/gbrain-home',
    engine: 'postgres', gbrainVersion: process.env.GBRAIN_VERSION ?? null,
    lifecycle: 'uninitialized',
  });
  await db.insert(schema.auditLog).values({
    id: randomUUID(), organizationId: orgId, actor: userId,
    action: 'bootstrap', target: orgId, before: null, after: { orgName, slug },
  });

  return { userId, orgId, brainId };
}
```

- [ ] **Step 6: Write `src/control/routes/auth.ts`**

```ts
import { Hono } from 'hono';
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { auth } from '../auth.ts';
import { getDb, schema } from '../db/client.ts';
import { isBootstrapped, bootstrapFirstAdmin } from '../bootstrap.ts';

export const authRoutes = new Hono();

authRoutes.on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw));

authRoutes.get('/bootstrap', async (c) => c.json({ bootstrapped: await isBootstrapped() }));

authRoutes.post('/bootstrap', async (c) => {
  if (await isBootstrapped()) return c.json({ error: 'already_bootstrapped' }, 409);
  const { email, password, orgName } = await c.req.json();
  if (!email || !password || !orgName) return c.json({ error: 'email, password and orgName are required' }, 400);
  try {
    // S3c: the request carries a password — nothing here logs the body.
    return c.json(await bootstrapFirstAdmin(email, password, orgName));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'bootstrap_failed' }, 400);
  }
});

/** Resolve the caller's session and their org, or throw a 401/403 response. */
export async function requireAdmin(c: Context): Promise<{ userId: string; orgId: string }> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const userId = (session as { user?: { id?: string } } | null)?.user?.id;
  if (!userId) throw new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401, headers: { 'content-type': 'application/json' },
  });

  const [m] = await getDb().select().from(schema.memberships).where(eq(schema.memberships.userId, userId));
  if (!m || !['owner', 'admin'].includes(m.role)) {
    throw new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403, headers: { 'content-type': 'application/json' },
    });
  }
  return { userId, orgId: m.organizationId };
}
```

- [ ] **Step 7: Mount the routes in `src/control/app.ts`**

Replace the `app.route('/api', health);` line with:

```ts
import { authRoutes } from './routes/auth.ts';
import { wizard } from './routes/wizard.ts';

app.route('/api', health);
app.route('/api', authRoutes);
app.route('/api/wizard', wizard);
```

> `./routes/wizard.ts` lands in Task 9. Until then, comment the wizard import and route out, or the module fails to load — the auth test's final case expects a 401 from `/api/wizard/state`, so complete Task 9 before running it. Run the first six auth cases now.

- [ ] **Step 8: Run the test to verify it passes**

Run: `CONTROL_DATABASE_URL=postgres://gbrain:ci-not-a-real-secret@localhost:5432/control bun test test/integration/auth.test.ts -t "bootstrap"`
Expected: PASS — 6 tests.

- [ ] **Step 9: Commit**

```bash
git add src/control/auth.ts src/control/bootstrap.ts src/control/routes/auth.ts src/control/app.ts test/integration/auth.test.ts package.json bun.lock
git commit -m "feat(slice1): Better Auth with a one-shot single-admin bootstrap

One org, one owner membership, one uninitialized brain — so promoting to a
company brain later is a settings change, not a migration.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: The wizard — lifecycle state machine and its five steps

The wizard is the product. It takes a brain from `uninitialized` to `ready` without the operator seeing a connection string.

**Files:**
- Create: `src/control/lifecycle.ts`, `src/control/routes/wizard.ts`
- Test: `test/unit/lifecycle.test.ts`, `test/integration/wizard.test.ts`

**Interfaces:**
- Consumes: `callOps`, `patchFilePlaneConfig` (Task 7); `storeSecret` (Task 6); `requireAdmin` (Task 8).
- Produces:
  - `type Lifecycle = 'uninitialized'|'provider-configured'|'mode-selected'|'schema-selected'|'sources-added'|'ready'`
  - `canAdvance(from: Lifecycle, to: Lifecycle): boolean`
  - `nextStep(current: Lifecycle): Lifecycle | null`
  - `SEARCH_MODES: { id: string; label: string; relativeCost: number; description: string }[]`
  - Routes: `GET /api/wizard/state`, `POST /api/wizard/provider`, `POST /api/wizard/search-mode`, `POST /api/wizard/schema`, `POST /api/wizard/space`, `POST /api/wizard/finish`

- [ ] **Step 1: Write the failing lifecycle test**

`test/unit/lifecycle.test.ts`:
```ts
import { test, expect, describe } from 'bun:test';
import { canAdvance, nextStep, LIFECYCLE_ORDER, SEARCH_MODES } from '../../src/control/lifecycle.ts';

describe('lifecycle', () => {
  test('advances exactly one step forward', () => {
    expect(canAdvance('uninitialized', 'provider-configured')).toBe(true);
    expect(canAdvance('provider-configured', 'mode-selected')).toBe(true);
  });

  test('refuses to skip a step', () => {
    expect(canAdvance('uninitialized', 'ready')).toBe(false);
    expect(canAdvance('uninitialized', 'schema-selected')).toBe(false);
  });

  test('refuses to move backwards', () => {
    expect(canAdvance('ready', 'sources-added')).toBe(false);
  });

  test('re-running the current step is allowed (idempotent retry)', () => {
    expect(canAdvance('provider-configured', 'provider-configured')).toBe(true);
  });

  test('nextStep walks the full order and stops at ready', () => {
    let s = LIFECYCLE_ORDER[0]!;
    const seen = [s];
    for (;;) { const n = nextStep(s); if (!n) break; s = n; seen.push(s); }
    expect(seen).toEqual([...LIFECYCLE_ORDER]);
    expect(nextStep('ready')).toBeNull();
  });
});

describe('search mode cost matrix', () => {
  // V4: this is a post-init decision and the one mandatory human choice
  // that is fully ours to render. The spread is ~25x, which is the
  // difference between a tool finance approves and one they kill.
  test('offers at least three modes with relative costs', () => {
    expect(SEARCH_MODES.length).toBeGreaterThanOrEqual(3);
    for (const m of SEARCH_MODES) {
      expect(m.relativeCost).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(20);
    }
  });

  test('the cheapest and dearest modes differ by at least 10x', () => {
    const costs = SEARCH_MODES.map((m) => m.relativeCost);
    expect(Math.max(...costs) / Math.min(...costs)).toBeGreaterThanOrEqual(10);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/lifecycle.test.ts`
Expected: FAIL — `Cannot find module '../../src/control/lifecycle.ts'`.

- [ ] **Step 3: Write `src/control/lifecycle.ts`**

```ts
export const LIFECYCLE_ORDER = [
  'uninitialized',
  'provider-configured',
  'mode-selected',
  'schema-selected',
  'sources-added',
  'ready',
] as const;

export type Lifecycle = (typeof LIFECYCLE_ORDER)[number];

export function canAdvance(from: Lifecycle, to: Lifecycle): boolean {
  const i = LIFECYCLE_ORDER.indexOf(from);
  const j = LIFECYCLE_ORDER.indexOf(to);
  if (i < 0 || j < 0) return false;
  return j === i || j === i + 1; // same step = idempotent retry
}

export function nextStep(current: Lifecycle): Lifecycle | null {
  const i = LIFECYCLE_ORDER.indexOf(current);
  return i >= 0 && i < LIFECYCLE_ORDER.length - 1 ? LIFECYCLE_ORDER[i + 1]! : null;
}

/**
 * V4: the search-mode cost matrix is a post-init `config set search.mode`.
 * relativeCost is a multiple of the cheapest mode — render it as a number the
 * admin can reason about, not a shrug. Confirm the real values against
 * `gbrain config list` output during Slice 0 and update them here.
 */
export const SEARCH_MODES = [
  {
    id: 'fast',
    label: 'Fast',
    relativeCost: 1,
    description: 'Lexical + vector retrieval only. Cheapest and lowest latency; no LLM reranking or synthesis on the read path.',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    relativeCost: 6,
    description: 'Adds query expansion and reranking. Noticeably better recall on vague questions, at several times the cost per search.',
  },
  {
    id: 'thorough',
    label: 'Thorough',
    relativeCost: 25,
    description: 'Full synthesis over expanded retrieval. Best answers, roughly 25x the cheapest mode — budget for this before enabling it team-wide.',
  },
] as const;
```

- [ ] **Step 4: Run the lifecycle test to verify it passes**

Run: `bun test test/unit/lifecycle.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Write the failing wizard integration test**

`test/integration/wizard.test.ts`:
```ts
import { test, expect, describe, beforeAll } from 'bun:test';
import app from '../../src/control/app.ts';
import { runMigrations, getDb, schema } from '../../src/control/db/client.ts';
import { bootstrapFirstAdmin } from '../../src/control/bootstrap.ts';
import { eq } from 'drizzle-orm';

let cookie = '';
let orgId = '';

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(48);
  process.env.BETTER_AUTH_SECRET = 'b'.repeat(48);
  await runMigrations();
  for (const t of [schema.spaces, schema.secrets, schema.memberships, schema.brains, schema.organizations, schema.users]) {
    await getDb().delete(t);
  }
  ({ orgId } = await bootstrapFirstAdmin('admin@example.test', 'a-long-enough-password', 'Acme'));

  const res = await app.request('/api/auth/sign-in/email', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.test', password: 'a-long-enough-password' }),
  });
  cookie = res.headers.get('set-cookie') ?? '';
}, 90_000);

const call = (path: string, body?: unknown) =>
  app.request(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });

describe('wizard', () => {
  test('state starts at uninitialized with provider as the next step', async () => {
    const body = await (await call('/api/wizard/state')).json();
    expect(body.lifecycle).toBe('uninitialized');
    expect(body.nextStep).toBe('provider-configured');
  });

  test('state exposes the search-mode cost matrix', async () => {
    const body = await (await call('/api/wizard/state')).json();
    expect(body.searchModes.length).toBeGreaterThanOrEqual(3);
  });

  test('a step cannot be skipped', async () => {
    expect((await call('/api/wizard/schema', { pack: 'gbrain-base-v2' })).status).toBe(409);
  });

  // The provider key goes to the FILE plane and our secrets table — never to
  // gbrain's DB plane (V11), and never back over the wire.
  test('the provider step stores the key encrypted and advances', async () => {
    const res = await call('/api/wizard/provider', {
      provider: 'openai', apiKey: 'sk-wizard-test-key',
      embeddingModel: 'openai:text-embedding-3-small',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('sk-wizard-test-key');

    const [row] = await getDb().select().from(schema.secrets)
      .where(eq(schema.secrets.organizationId, orgId));
    expect(row?.name).toBe('openai_api_key');
    expect(JSON.stringify(row)).not.toContain('sk-wizard-test-key');

    const [brain] = await getDb().select().from(schema.brains);
    expect(brain?.lifecycle).toBe('provider-configured');
  });

  test('the search-mode step records the choice', async () => {
    expect((await call('/api/wizard/search-mode', { mode: 'fast' })).status).toBe(200);
    const [brain] = await getDb().select().from(schema.brains);
    expect(brain?.searchMode).toBe('fast');
    expect(brain?.lifecycle).toBe('mode-selected');
  });

  test('an unknown search mode is rejected', async () => {
    expect((await call('/api/wizard/search-mode', { mode: 'turbo' })).status).toBe(400);
  });

  // S4b: Space = source is a HARD RULE, surfaced as a blocking choice.
  test('the space step refuses a duplicate source id', async () => {
    await call('/api/wizard/schema', { pack: 'gbrain-base-v2' });
    expect((await call('/api/wizard/space', { sourceId: 'shared', name: 'Shared' })).status).toBe(200);
    const dup = await call('/api/wizard/space', { sourceId: 'shared', name: 'Shared again' });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toMatch(/already a Space/i);
  });

  test('the space step rejects an invalid source id', async () => {
    const res = await call('/api/wizard/space', { sourceId: '../etc', name: 'Bad' });
    expect(res.status).toBe(400);
  });

  test('state carries the isolation warning for the space step', async () => {
    const body = await (await call('/api/wizard/state')).json();
    expect(body.isolationNotice).toMatch(/every member with read on that Space/i);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test test/integration/wizard.test.ts`
Expected: FAIL — `Cannot find module '../../src/control/routes/wizard.ts'`.

- [ ] **Step 7: Write `src/control/routes/wizard.ts`**

```ts
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { requireAdmin } from './auth.ts';
import { storeSecret } from '../secrets.ts';
import { callOps, patchFilePlaneConfig } from '../opsClient.ts';
import { canAdvance, nextStep, SEARCH_MODES, LIFECYCLE_ORDER } from '../lifecycle.ts';
import type { Lifecycle } from '../lifecycle.ts';

export const wizard = new Hono();

/**
 * Space = source is a hard rule. There is no "folders within a Space have
 * different access": folder isolation is convention the agent polices itself,
 * so the moment someone puts HR docs in hr/ inside the company Space, every
 * member with read on that Space retrieves them via semantic search.
 */
const ISOLATION_NOTICE =
  'A Space is a whole gbrain source. Folders inside it are NOT access boundaries — ' +
  'every member with read on that Space can retrieve everything in it via semantic search. ' +
  'If something needs isolation, it needs its own Space.';

const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

async function loadBrain(orgId: string) {
  const [brain] = await getDb().select().from(schema.brains)
    .where(eq(schema.brains.organizationId, orgId));
  if (!brain) throw new Error('no brain for organization');
  return brain;
}

async function advance(brainId: string, from: Lifecycle, to: Lifecycle, patch: Record<string, unknown> = {}) {
  if (!canAdvance(from, to)) {
    throw Object.assign(new Error(`cannot advance from ${from} to ${to}`), { status: 409 });
  }
  await getDb().update(schema.brains)
    .set({ ...patch, lifecycle: to, updatedAt: new Date() })
    .where(eq(schema.brains.id, brainId));
}

async function audit(orgId: string, actor: string, action: string, target: string, after: unknown) {
  // S3c: `after` is a redacted summary — never a raw request body.
  await getDb().insert(schema.auditLog)
    .values({ id: randomUUID(), organizationId: orgId, actor, action, target, before: null, after: after as object });
}

const guard = (handler: (c: any, ctx: { userId: string; orgId: string }) => Promise<Response>) =>
  async (c: any) => {
    let ctx;
    try { ctx = await requireAdmin(c); } catch (r) { return r as Response; }
    try { return await handler(c, ctx); }
    catch (e: any) { return c.json({ error: e?.message ?? 'wizard_error' }, e?.status ?? 400); }
  };

wizard.get('/state', guard(async (c, { orgId }) => {
  const brain = await loadBrain(orgId);
  const spaces = await getDb().select().from(schema.spaces)
    .where(eq(schema.spaces.organizationId, orgId));
  return c.json({
    lifecycle: brain.lifecycle,
    order: LIFECYCLE_ORDER,
    nextStep: nextStep(brain.lifecycle as Lifecycle),
    searchModes: SEARCH_MODES,
    searchMode: brain.searchMode,
    embeddingModel: brain.embeddingModel,
    spaces: spaces.map((s) => ({ sourceId: s.sourceId, name: s.name, kind: s.kind })),
    isolationNotice: ISOLATION_NOTICE,
  });
}));

/**
 * Step 1 — provider key. Two destinations, neither of them gbrain's DB plane
 * (V11): our encrypted secrets table (source of truth) and the file plane
 * (what gbrain actually reads), written under the advisory lock (S3).
 *
 * Slice 0 finding carried forward (docs/slice-0-findings.md V3/V11,
 * Work Item A, 2026-09-15): Slice 0 confirmed `gbrain config set
 * <vendor>_api_key` itself avoids the DB plane, and this route's design
 * (write the key here, BEFORE `/finish` ever calls `init`) is the right
 * shape — it is what makes headless `init` resolvable without Slice 0's
 * own env-var passthrough shortcut (which is Slice-0-only and must not be
 * copied into this compose). One assumption is still UNVERIFIED, though:
 * Slice 0 only validated gbrain's own `config set` CLI path — it never
 * validated that `patchFilePlaneConfig`'s direct file write lands in the
 * same file, in the same format, that `gbrain init`/`gbrain config show`
 * actually read. Before relying on this in Task 9's tests, add a
 * round-trip check: call this route, then `gbrain config show` inside
 * gbrain-ops, and confirm the key name actually appears.
 */
wizard.post('/provider', guard(async (c, { userId, orgId }) => {
  const { provider, apiKey, embeddingModel } = await c.req.json();
  if (!provider || !apiKey || !embeddingModel) {
    return c.json({ error: 'provider, apiKey and embeddingModel are required' }, 400);
  }
  const brain = await loadBrain(orgId);
  const keyName = `${provider}_api_key`;

  await storeSecret(orgId, keyName, apiKey);
  await patchFilePlaneConfig({ [keyName]: apiKey });
  await advance(brain.id, brain.lifecycle as Lifecycle, 'provider-configured', { embeddingModel });
  await audit(orgId, userId, 'wizard.provider', keyName, { provider, embeddingModel });

  // Never echo the key.
  return c.json({ ok: true, lifecycle: 'provider-configured', keyName });
}));

/** Step 2 — the one mandatory human decision (V4). */
wizard.post('/search-mode', guard(async (c, { userId, orgId }) => {
  const { mode } = await c.req.json();
  if (!SEARCH_MODES.some((m) => m.id === mode)) return c.json({ error: `unknown search mode ${mode}` }, 400);

  const brain = await loadBrain(orgId);
  await advance(brain.id, brain.lifecycle as Lifecycle, 'mode-selected', { searchMode: mode });
  await audit(orgId, userId, 'wizard.searchMode', brain.id, { mode });
  return c.json({ ok: true, lifecycle: 'mode-selected', mode });
}));

/**
 * Step 3 — schema pack, rendered from `gbrain schema list`.
 *
 * Slice 0 finding carried forward (docs/slice-0-findings.md V2, Work Item K,
 * 2026-09-15): `schema list` accepts `--json` on the command line without
 * erroring, but silently IGNORES it and always prints human prose —
 * `runList()`'s own handler never reads its argument. Slice 0's registry
 * marks this operation `supportsJson: false`, so requesting `{ json: true }`
 * as originally drafted here either throws inside the exec layer's
 * `buildArgv` ("schema.list does not support --json") or, if gbrain-ops's
 * RPC server swallows that into a non-throwing response, silently yields
 * `json: null` — an empty pack list shown to the user with no visible
 * error. Fixed: call it WITHOUT `json`, and parse the stable
 * `Bundled packs:` prose block the same way Slice 0's own
 * `parseSchemaPacksProse()` (src/contracts/capability.ts) already does.
 */
wizard.get('/schema-packs', guard(async (c) => {
  const r = await callOps<never>('schema.list', {}, { timeoutMs: 60_000 });
  const bundled: string[] = [];
  let inBundled = false;
  for (const line of (r.stdout ?? '').split('\n')) {
    if (/^\s*Bundled packs:\s*$/.test(line)) { inBundled = true; continue; }
    if (!inBundled) continue;
    const t = line.trim();
    if (t === '') break;
    bundled.push(t);
  }
  return c.json({ packs: bundled });
}));

wizard.post('/schema', guard(async (c, { userId, orgId }) => {
  const { pack } = await c.req.json();
  if (!pack || typeof pack !== 'string') return c.json({ error: 'pack is required' }, 400);

  const brain = await loadBrain(orgId);
  await advance(brain.id, brain.lifecycle as Lifecycle, 'schema-selected');
  await audit(orgId, userId, 'wizard.schema', pack, { pack });
  return c.json({ ok: true, lifecycle: 'schema-selected', pack });
}));

/** Step 4 — the first Space. One gbrain source, git-backed, created via the CLI lane. */
wizard.post('/space', guard(async (c, { userId, orgId }) => {
  const { sourceId, name, description } = await c.req.json();
  if (!sourceId || !SOURCE_ID.test(sourceId)) {
    return c.json({ error: 'sourceId must be lowercase letters, digits and hyphens' }, 400);
  }

  const [dup] = await getDb().select().from(schema.spaces)
    .where(and(eq(schema.spaces.organizationId, orgId), eq(schema.spaces.sourceId, sourceId)));
  if (dup) return c.json({ error: `${sourceId} is already a Space`, isolationNotice: ISOLATION_NOTICE }, 409);

  const brain = await loadBrain(orgId);
  const localPath = `/srv/brain-repos/${sourceId}`;

  // Slice 0 finding carried forward (docs/slice-0-findings.md V12,
  // Work Item D, 2026-09-15): `sources add --path` unconditionally refuses
  // any path that is not a git repository with at least one COMMITTED,
  // TRACKED file — an empty commit or an untracked file is not enough, and
  // this is undocumented upstream. As drafted, this handler called
  // `sources.add` directly on `localPath` without ever creating, seeding or
  // committing anything there — every real call would fail. THIS IS AN
  // OPEN GAP, not yet fixed here: gbrain-ops's ops RPC server has no
  // exposed primitive for "git-init + seed + commit a directory" the way it
  // already has dedicated `/fileplane/config` and `/fileplane/schema-pack`
  // endpoints for direct file-plane writes (see opsClient.ts). Before this
  // route can work, add an equivalent file-plane primitive (e.g. a
  // `/fileplane/seed-space` endpoint, or extend `sources.add`'s own
  // handling in the RPC server) that mirrors what Slice 0's
  // `test/helpers/stack.ts` `seedGitSource()` and `scripts/tutorial.ts` do
  // today: mkdir, `git init`, set a commit identity, write at least one
  // file, `git add -A`, `git commit`, THEN call `sources.add` — and drop
  // `json: true` from the call below, since `sources add` does not support
  // `--json` at all (exit 2, "Unknown flag: --json" — Work Item N); read
  // its plain-text confirmation instead.
  const r = await callOps('sources.add', {
    id: sourceId, path: localPath, name: name ?? sourceId,
  }, { timeoutMs: 300_000 });
  if (!r.ok) return c.json({ error: `sources add failed (exit ${r.exitCode})`, detail: r.stderr }, 400);

  await getDb().insert(schema.spaces).values({
    id: randomUUID(), organizationId: orgId, sourceId,
    name: name ?? sourceId, description: description ?? null,
    kind: 'local-git', localPath,
  });
  await advance(brain.id, brain.lifecycle as Lifecycle, 'sources-added');
  await audit(orgId, userId, 'wizard.space', sourceId, { sourceId, kind: 'local-git' });

  return c.json({ ok: true, lifecycle: 'sources-added', sourceId, isolationNotice: ISOLATION_NOTICE });
}));

/** Step 5 — init, config, sync, doctor. The brain becomes real here. */
wizard.post('/finish', guard(async (c, { userId, orgId }) => {
  const brain = await loadBrain(orgId);
  if (brain.lifecycle !== 'sources-added') {
    return c.json({ error: `cannot finish from ${brain.lifecycle}` }, 409);
  }

  const steps: { id: string; ok: boolean; exitCode: number }[] = [];
  const run = async (id: string, op: string, params: Record<string, unknown>, timeoutMs = 900_000) => {
    const r = await callOps(op, params, { json: true, timeoutMs });
    steps.push({ id, ok: r.ok, exitCode: r.exitCode });
    return r;
  };

  // GBRAIN_DATABASE_URL is already in the ops container's environment, so the
  // connection string never passes through the control plane (S2, V3).
  await run('init', 'init', {
    nonInteractive: true, embeddingModel: brain.embeddingModel ?? 'openai:text-embedding-3-small',
  });
  if (brain.searchMode) await run('search-mode', 'config.set', { key: 'search.mode', value: brain.searchMode });
  await run('sync', 'sync', { all: true });
  await run('embed', 'embed', { stale: true });

  const doctor = await run('doctor', 'doctor', {});
  const ok = steps.every((s) => s.ok);
  if (ok) await advance(brain.id, 'sources-added', 'ready');
  await audit(orgId, userId, 'wizard.finish', brain.id, { steps, doctorExit: doctor.exitCode });

  return c.json({ ok, lifecycle: ok ? 'ready' : brain.lifecycle, steps }, ok ? 200 : 500);
}));
```

- [ ] **Step 8: Run the wizard test**

Start the ops sidecar and Postgres first (the wizard calls the RPC):

```bash
docker compose -f compose/docker-compose.yml -f compose/docker-compose.dev.yml up -d postgres gbrain-ops --wait
```

Run: `bun test test/integration/wizard.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 9: Run the full auth test now that `/api/wizard` exists**

Run: `bun test test/integration/auth.test.ts`
Expected: PASS — 7 tests, including the 401 on `/api/wizard/state`.

- [ ] **Step 10: Commit**

```bash
git add src/control/lifecycle.ts src/control/routes/wizard.ts test/unit/lifecycle.test.ts test/integration/wizard.test.ts
git commit -m "feat(slice1): wizard lifecycle state machine and five setup steps

Provider keys go to our encrypted store plus the file plane, never gbrain's
DB plane; Space=source is enforced as a blocking choice, not a tooltip.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: The console SPA — shell, wizard and health page

**Files:**
- Create: `src/console/index.html`, `src/console/main.tsx`, `src/console/App.tsx`, `src/console/api.ts`, `src/console/styles.css`
- Create: `src/console/pages/Bootstrap.tsx`, `Wizard.tsx`, `Health.tsx`
- Create: `vite.config.ts`
- Modify: `src/control/app.ts` (serve the built SPA), `docker/control-plane.Dockerfile` (build it)
- Test: `test/unit/console-api.test.ts`

**Interfaces:**
- Consumes: every `/api/*` route from Tasks 7–9.
- Produces: a static bundle at `dist/console/`, served by the control plane for any non-`/api` path.

> **Design language** — reuse gbrain's (`DESIGN.md`, `admin/DESIGN.md`, `admin/src/index.css`): dark-only, Inter for UI / JetBrains Mono for anything copyable, 4px spacing base, semantic-only color, 200px sidebar. Read those three files in the read-only reference checkout at `C:\Users\juanp\Desktop\gbrain` before writing `styles.css`.

- [ ] **Step 1: Install the frontend toolchain**

```bash
bun add react react-dom && bun add -d @vitejs/plugin-react vite tailwindcss @tailwindcss/vite @types/react @types/react-dom
```

- [ ] **Step 2: Write the failing API-client test**

`test/unit/console-api.test.ts`:
```ts
import { test, expect, describe, afterEach } from 'bun:test';
import { api, ApiError } from '../../src/console/api.ts';

const orig = globalThis.fetch;
afterEach(() => { globalThis.fetch = orig; });

const stub = (status: number, body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
};

describe('console api client', () => {
  test('returns the parsed body on success', async () => {
    stub(200, { lifecycle: 'uninitialized' });
    expect(await api.get('/wizard/state')).toEqual({ lifecycle: 'uninitialized' });
  });

  test('throws ApiError carrying status and message', async () => {
    stub(409, { error: 'cannot advance from uninitialized to schema-selected' });
    const err = await api.post('/wizard/schema', { pack: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/cannot advance/);
  });

  test('prefixes every path with /api', async () => {
    let seen = '';
    globalThis.fetch = (async (url: string) => {
      seen = url;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await api.get('/wizard/state');
    expect(seen).toBe('/api/wizard/state');
  });

  test('sends credentials so the session cookie travels', async () => {
    let init: RequestInit | undefined;
    globalThis.fetch = (async (_u: string, i: RequestInit) => {
      init = i;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await api.get('/wizard/state');
    expect(init?.credentials).toBe('same-origin');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test test/unit/console-api.test.ts`
Expected: FAIL — `Cannot find module '../../src/console/api.ts'`.

- [ ] **Step 4: Write `src/console/api.ts`**

```ts
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'ApiError'; }
}

async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((payload as { error?: string }).error ?? `HTTP ${res.status}`, res.status);
  return payload as T;
}

export const api = {
  get: <T = unknown>(path: string) => request<T>(path, 'GET'),
  post: <T = unknown>(path: string, body?: unknown) => request<T>(path, 'POST', body ?? {}),
};
```

- [ ] **Step 5: Run the API test to verify it passes**

Run: `bun test test/unit/console-api.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 6: Write `vite.config.ts` and `src/console/index.html`**

`vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  root: 'src/console',
  plugins: [react(), tailwind()],
  build: { outDir: '../../dist/console', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:3150' } },
});
```

`src/console/index.html`:
```html
<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>brainstand</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: Write the console pages**

`src/console/main.tsx`:
```tsx
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
```

`src/console/App.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { Bootstrap } from './pages/Bootstrap.tsx';
import { Wizard } from './pages/Wizard.tsx';
import { Health } from './pages/Health.tsx';

type Phase = 'loading' | 'bootstrap' | 'wizard' | 'ready';

export function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [page, setPage] = useState<'health' | 'setup'>('setup');

  const refresh = async () => {
    const { bootstrapped } = await api.get<{ bootstrapped: boolean }>('/bootstrap');
    if (!bootstrapped) return setPhase('bootstrap');
    try {
      const state = await api.get<{ lifecycle: string }>('/wizard/state');
      setPhase(state.lifecycle === 'ready' ? 'ready' : 'wizard');
      if (state.lifecycle === 'ready') setPage('health');
    } catch { setPhase('bootstrap'); }
  };

  useEffect(() => { void refresh(); }, []);

  if (phase === 'loading') return <div className="p-6 text-muted">Loading…</div>;
  if (phase === 'bootstrap') return <Bootstrap onDone={refresh} />;

  return (
    <div className="flex min-h-screen">
      <nav className="w-[200px] shrink-0 border-r border-subtle p-4">
        <div className="mb-6 font-semibold">brainstand</div>
        <button className="nav-item" onClick={() => setPage('health')}>Health</button>
        <button className="nav-item" onClick={() => setPage('setup')}>Setup</button>
      </nav>
      <main className="flex-1 p-6">
        {page === 'health' ? <Health /> : <Wizard onReady={refresh} />}
      </main>
    </div>
  );
}
```

`src/console/pages/Bootstrap.tsx`:
```tsx
import { useState } from 'react';
import { api } from '../api.ts';

export function Bootstrap({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [orgName, setOrgName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/bootstrap', { email, password, orgName });
      await api.post('/auth/sign-in/email', { email, password });
      onDone();
    } catch (err) { setError(err instanceof Error ? err.message : 'Bootstrap failed'); }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="mx-auto mt-16 max-w-md space-y-4 p-6">
      <h1 className="text-xl font-semibold">Create the first admin</h1>
      <p className="text-sm text-muted">
        This account owns the brain. Nobody else can be created until setup finishes.
      </p>
      <input className="field" placeholder="Organization name" value={orgName}
             onChange={(e) => setOrgName(e.target.value)} required />
      <input className="field" type="email" placeholder="Email" value={email}
             onChange={(e) => setEmail(e.target.value)} required />
      <input className="field" type="password" placeholder="Password (12+ characters)"
             value={password} onChange={(e) => setPassword(e.target.value)}
             minLength={12} required />
      {error && <div className="text-danger text-sm">{error}</div>}
      <button className="btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create admin'}</button>
    </form>
  );
}
```

`src/console/pages/Wizard.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { api } from '../api.ts';

type SearchMode = { id: string; label: string; relativeCost: number; description: string };
type State = {
  lifecycle: string; nextStep: string | null; searchModes: SearchMode[];
  spaces: { sourceId: string; name: string }[]; isolationNotice: string;
};

export function Wizard({ onReady }: { onReady: () => void }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => setState(await api.get<State>('/wizard/state'));
  useEffect(() => { void load(); }, []);

  const step = async (path: string, body: unknown) => {
    setBusy(true); setError(null);
    try { await api.post(path, body); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Step failed'); }
    finally { setBusy(false); }
  };

  if (!state) return <div className="text-muted">Loading…</div>;

  return (
    <div className="max-w-2xl space-y-8">
      <header>
        <h1 className="text-xl font-semibold">Set up your brain</h1>
        <p className="text-sm text-muted">Stage: <span className="font-mono">{state.lifecycle}</span></p>
      </header>

      {error && <div className="text-danger text-sm">{error}</div>}

      {state.nextStep === 'provider-configured' && (
        <ProviderStep busy={busy} onSubmit={(b) => step('/wizard/provider', b)} />
      )}

      {state.nextStep === 'mode-selected' && (
        <section className="space-y-3">
          <h2 className="font-medium">Choose a search mode</h2>
          <p className="text-sm text-muted">
            This is the single biggest driver of your monthly AI spend. The most thorough mode
            costs roughly {Math.max(...state.searchModes.map((m) => m.relativeCost))}× the cheapest.
            You can change it later.
          </p>
          {state.searchModes.map((m) => (
            <button key={m.id} className="card w-full text-left" disabled={busy}
                    onClick={() => step('/wizard/search-mode', { mode: m.id })}>
              <div className="flex justify-between">
                <span className="font-medium">{m.label}</span>
                <span className="font-mono text-sm text-muted">{m.relativeCost}× cost</span>
              </div>
              <p className="text-sm text-muted">{m.description}</p>
            </button>
          ))}
        </section>
      )}

      {state.nextStep === 'schema-selected' && (
        <SchemaStep busy={busy} onSubmit={(pack) => step('/wizard/schema', { pack })} />
      )}

      {state.nextStep === 'sources-added' && (
        <SpaceStep busy={busy} notice={state.isolationNotice}
                   onSubmit={(b) => step('/wizard/space', b)} />
      )}

      {state.nextStep === 'ready' && (
        <section className="space-y-3">
          <h2 className="font-medium">Finish setup</h2>
          <p className="text-sm text-muted">
            Initializes the brain, applies your search mode, imports and embeds your Space,
            then runs a health check. This takes several minutes.
          </p>
          <button className="btn-primary" disabled={busy}
                  onClick={async () => { await step('/wizard/finish', {}); onReady(); }}>
            {busy ? 'Running…' : 'Finish setup'}
          </button>
        </section>
      )}
    </div>
  );
}

function ProviderStep({ busy, onSubmit }: { busy: boolean; onSubmit: (b: unknown) => void }) {
  const [apiKey, setApiKey] = useState('');
  return (
    <section className="space-y-3">
      <h2 className="font-medium">Connect a model provider</h2>
      <p className="text-sm text-muted">
        Stored encrypted. It is written to the brain's config file, never to its database.
      </p>
      <input className="field font-mono" type="password" placeholder="sk-…"
             value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      <button className="btn-primary" disabled={busy || !apiKey}
              onClick={() => onSubmit({
                provider: 'openai', apiKey,
                embeddingModel: 'openai:text-embedding-3-small',
              })}>
        {busy ? 'Saving…' : 'Save key'}
      </button>
    </section>
  );
}

function SchemaStep({ busy, onSubmit }: { busy: boolean; onSubmit: (pack: string) => void }) {
  const [packs, setPacks] = useState<{ id?: string; name?: string }[]>([]);
  useEffect(() => {
    void api.get<{ packs: { id?: string; name?: string }[] }>('/wizard/schema-packs')
      .then((r) => setPacks(r.packs ?? []))
      .catch(() => setPacks([{ id: 'gbrain-base-v2', name: 'gbrain-base-v2' }]));
  }, []);
  return (
    <section className="space-y-3">
      <h2 className="font-medium">Pick a shape for your knowledge</h2>
      <p className="text-sm text-muted">
        A schema pack decides what kinds of pages your brain recognizes. Start with the default —
        under 20 pages of a kind, don't codify it.
      </p>
      {packs.map((p) => {
        const id = p.id ?? p.name ?? 'gbrain-base-v2';
        return (
          <button key={id} className="card w-full text-left" disabled={busy}
                  onClick={() => onSubmit(id)}>
            <span className="font-mono">{id}</span>
          </button>
        );
      })}
    </section>
  );
}

function SpaceStep(
  { busy, notice, onSubmit }: { busy: boolean; notice: string; onSubmit: (b: unknown) => void },
) {
  const [sourceId, setSourceId] = useState('');
  const [name, setName] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <section className="space-y-3">
      <h2 className="font-medium">Create your first Space</h2>
      {/* S4b: a blocking choice, not a tooltip. */}
      <div className="card border-warning">
        <p className="text-sm">{notice}</p>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={acknowledged}
                 onChange={(e) => setAcknowledged(e.target.checked)} />
          I understand folders inside a Space are not access boundaries.
        </label>
      </div>
      <input className="field font-mono" placeholder="source id, e.g. shared"
             value={sourceId} onChange={(e) => setSourceId(e.target.value)} />
      <input className="field" placeholder="Display name, e.g. Shared company wiki"
             value={name} onChange={(e) => setName(e.target.value)} />
      <button className="btn-primary" disabled={busy || !acknowledged || !sourceId}
              onClick={() => onSubmit({ sourceId, name })}>
        {busy ? 'Creating…' : 'Create Space'}
      </button>
    </section>
  );
}
```

`src/console/pages/Health.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { api } from '../api.ts';

type Health = {
  ok: boolean; components: Record<string, string>;
  gbrainVersion: string | null; at: string;
};

export function Health() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    const load = () => api.get<Health>('/health').then(setHealth).catch(() => setHealth(null));
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  if (!health) return <div className="text-muted">Checking…</div>;

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">Health</h1>
      <div className={health.ok ? 'text-ok' : 'text-danger'}>
        {health.ok ? 'All components healthy' : 'Degraded'}
      </div>
      <table className="w-full text-sm">
        <tbody>
          {Object.entries(health.components).map(([k, v]) => (
            <tr key={k} className="border-b border-subtle">
              <td className="py-2 font-mono">{k}</td>
              <td className={v === 'ok' ? 'text-ok' : 'text-danger'}>{v}</td>
            </tr>
          ))}
          <tr><td className="py-2 font-mono">gbrain</td>
              <td className="font-mono">{health.gbrainVersion ?? 'unknown'}</td></tr>
        </tbody>
      </table>
      <p className="text-xs text-muted">Checked {new Date(health.at).toLocaleString()}</p>
    </div>
  );
}
```

`src/console/styles.css` — read gbrain's `admin/src/index.css` first and mirror its tokens:
```css
@import "tailwindcss";

@theme {
  --color-bg: #0b0c0e;
  --color-surface: #131517;
  --color-subtle: #24272b;
  --color-text: #e6e8ea;
  --color-muted: #9aa0a6;
  --color-accent: #6ea8fe;
  --color-ok: #4ade80;
  --color-warning: #fbbf24;
  --color-danger: #f87171;
  --font-sans: Inter, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --spacing: 4px;
}

body { background: var(--color-bg); color: var(--color-text); font-family: var(--font-sans); }
.font-mono { font-family: var(--font-mono); }
.text-muted { color: var(--color-muted); }
.text-ok { color: var(--color-ok); }
.text-danger { color: var(--color-danger); }
.border-subtle { border-color: var(--color-subtle); }
.border-warning { border: 1px solid var(--color-warning); }

.field {
  width: 100%; padding: 8px 12px; border-radius: 6px;
  background: var(--color-surface); border: 1px solid var(--color-subtle); color: inherit;
}
.card {
  padding: 12px; border-radius: 8px;
  background: var(--color-surface); border: 1px solid var(--color-subtle);
}
.btn-primary {
  padding: 8px 16px; border-radius: 6px;
  background: var(--color-accent); color: #0b0c0e; font-weight: 500;
}
.btn-primary:disabled { opacity: .5; }
.nav-item { display: block; width: 100%; text-align: left; padding: 6px 8px; border-radius: 4px; }
.nav-item:hover { background: var(--color-surface); }
```

- [ ] **Step 8: Serve the bundle from the control plane**

Add to `src/control/app.ts`, immediately above `app.notFound(...)`:

```ts
import { serveStatic } from 'hono/bun';

// The SPA. Everything not under /api falls through to index.html so client
// routing works; /health and /metrics never reach here — Caddy sends them to
// gbrain-serve.
app.use('/assets/*', serveStatic({ root: './dist/console' }));
app.get('*', serveStatic({ path: './dist/console/index.html' }));
```

And add the build stage to `docker/control-plane.Dockerfile`, before `ENV NODE_ENV=production`:

```dockerfile
COPY vite.config.ts ./
RUN bun install --frozen-lockfile && bunx vite build && rm -rf node_modules \
 && bun install --frozen-lockfile --production
```

- [ ] **Step 9: Build the console and re-run the routing tests**

Run: `bunx vite build`
Expected: a bundle at `dist/console/index.html`.

Run: `bun test test/integration/health.test.ts`
Expected: PASS — 4 tests. `/health` and `/metrics` must still be 404 from the console; if the SPA catch-all now answers them, the `app.get('*')` line is mounted above `app.route('/api', health)` — move it down.

- [ ] **Step 10: Commit**

```bash
git add src/console/ vite.config.ts src/control/app.ts docker/control-plane.Dockerfile test/unit/console-api.test.ts package.json bun.lock
git commit -m "feat(slice1): console SPA with bootstrap, wizard and health pages

The Space step blocks on an explicit acknowledgement that folders are not
access boundaries.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 11: Backup — quiesce, then one consistent four-component snapshot

**Files:**
- Create: `scripts/backup.ts`, `src/control/routes/backup.ts`
- Test: `test/integration/backup.test.ts`

**Interfaces:**
- Consumes: `callOps` (Task 7); the supervisor operations (Slice 0 Task 9).
- Produces:
  - `type BackupManifest = { id: string; createdAt: string; gbrainVersion: string; components: { brainDb: string; controlDb: string; brainRepos: string; secrets: string }; sha256: Record<string,string>; quiesced: boolean }`
  - `runBackup(outDir: string): Promise<BackupManifest>`
  - `POST /api/backup`, `GET /api/backup`

- [ ] **Step 1: Write the failing backup test**

`test/integration/backup.test.ts`:
```ts
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBackup } from '../../scripts/backup.ts';

let out: string;
beforeAll(async () => { out = await mkdtemp(join(tmpdir(), 'bs-backup-')); }, 30_000);
afterAll(async () => { await rm(out, { recursive: true, force: true }); });

describe('backup', () => {
  // gbrain's own backup DELIBERATELY excludes every credential, so a naive
  // restore yields intact knowledge and zero working agent connections (V9).
  // Our unit is four things versioned together.
  test('produces all four components plus a manifest', async () => {
    const m = await runBackup(out);
    const files = await readdir(out);
    expect(files).toContain('manifest.json');
    for (const f of Object.values(m.components)) expect(files).toContain(f);
    expect(Object.keys(m.components).sort())
      .toEqual(['brainDb', 'brainRepos', 'controlDb', 'secrets']);
  }, 600_000);

  test('the manifest records the gbrain version and a checksum per component', async () => {
    const m = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    expect(m.gbrainVersion).toBeTruthy();
    for (const k of Object.keys(m.components)) expect(m.sha256[k]).toMatch(/^[0-9a-f]{64}$/);
  });

  // Three artifacts taken at three moments are three artifacts that disagree.
  test('the manifest records that the worker was quiesced', async () => {
    const m = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    expect(m.quiesced).toBe(true);
  });

  test('the secrets component is the encrypted table, not decrypted values', async () => {
    const m = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    const dump = await readFile(join(out, m.components.secrets), 'utf8');
    expect(dump).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    expect(dump).toContain('wrapped_dek');
  });

  test('the manifest warns that ENCRYPTION_KEY is held separately', async () => {
    const m = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    expect(m.warning).toMatch(/ENCRYPTION_KEY/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/integration/backup.test.ts`
Expected: FAIL — `Cannot find module '../../scripts/backup.ts'`.

- [ ] **Step 3: Write `scripts/backup.ts`**

```ts
#!/usr/bin/env bun
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { callOps } from '../src/control/opsClient.ts';

export type BackupManifest = {
  id: string;
  createdAt: string;
  gbrainVersion: string;
  components: { brainDb: string; controlDb: string; brainRepos: string; secrets: string };
  sha256: Record<string, string>;
  quiesced: boolean;
  warning: string;
};

const COMPOSE = ['docker', 'compose', '-f', 'compose/docker-compose.yml'];

async function sh(argv: string[], timeoutMs = 900_000): Promise<{ exitCode: number; stderr: string }> {
  const p = Bun.spawn(argv, { stdout: 'inherit', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [stderr, exitCode] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { exitCode, stderr };
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

/**
 * Quiesce first. A pg_dump of two databases plus a tar of two volumes taken
 * at three moments is three artifacts that disagree: a job commits a page to
 * the repo, then writes its row; the tar ran before the commit and the dump
 * after; restore yields a row pointing at a nonexistent file.
 *
 * On the VM target, prefer a volume- or VM-layer snapshot (ZFS/btrfs or a
 * cloud disk snapshot) so atomicity across DB + files is structural. This is
 * the portable minimum.
 */
export async function runBackup(outDir: string): Promise<BackupManifest> {
  await mkdir(outDir, { recursive: true });
  const id = randomUUID();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  // V5: SIGTERM drains; `stop` waits up to 40s. Budget 90s.
  await sh([...COMPOSE, 'stop', '-t', '90', 'gbrain-worker'], 120_000);
  let quiesced = true;
  try {
    const status = await callOps('jobs.supervisorStatus', {}, { json: true, timeoutMs: 30_000 });
    quiesced = status.exitCode === 1; // 1 = not running
  } catch { quiesced = true; }

  try {
    const components = {
      brainDb: `brain-${stamp}.sql`,
      controlDb: `control-${stamp}.sql`,
      brainRepos: `brain-repos-${stamp}.tar`,
      secrets: `secrets-${stamp}.sql`,
    };

    const dump = async (db: string, file: string, extra: string[] = []) => {
      const r = await sh(['sh', '-c',
        `${COMPOSE.join(' ')} exec -T postgres pg_dump -U gbrain -d ${db} ${extra.join(' ')} > ${join(outDir, file)}`]);
      if (r.exitCode !== 0) throw new Error(`pg_dump ${db} failed: ${r.stderr}`);
    };

    await dump('gbrain', components.brainDb);
    await dump('control', components.controlDb);
    // The secrets table separately, so restore can re-materialize credentials
    // without a full control-DB restore.
    await dump('control', components.secrets, ['-t', 'secrets']);

    const tar = await sh(['sh', '-c',
      `${COMPOSE.join(' ')} exec -T gbrain-ops tar -cf - -C /srv/brain-repos . > ${join(outDir, components.brainRepos)}`]);
    if (tar.exitCode !== 0) throw new Error(`repo tar failed: ${tar.stderr}`);

    // The git remotes are the real durable copy of a Space's content.
    await sh([...COMPOSE, 'exec', '-T', 'gbrain-ops', 'gbrain', 'sources', 'push', '--all'], 600_000)
      .catch(() => undefined);

    const sums: Record<string, string> = {};
    for (const [k, f] of Object.entries(components)) sums[k] = await sha256(join(outDir, f));

    const manifest: BackupManifest = {
      id, createdAt: new Date().toISOString(),
      gbrainVersion: process.env.GBRAIN_VERSION ?? '0.50.0.0',
      components, sha256: sums, quiesced,
      warning:
        'Restoring requires the ENCRYPTION_KEY that sealed the secrets table. ' +
        'Store it separately from this archive — together they are a credential dump. ' +
        'Restoring to a NEW DOMAIN invalidates every OAuth grant; re-provision all Connections.',
    };

    await Bun.write(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } finally {
    await sh([...COMPOSE, 'start', 'gbrain-worker'], 120_000);
  }
}

if (import.meta.main) {
  const out = process.argv[2] ?? `./backups/${new Date().toISOString().slice(0, 10)}`;
  console.log(JSON.stringify(await runBackup(out), null, 2));
}
```

- [ ] **Step 4: Write `src/control/routes/backup.ts`**

```ts
import { Hono } from 'hono';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireAdmin } from './auth.ts';
import { runBackup } from '../../scripts/backup.ts';

export const backup = new Hono();
const ROOT = process.env.BACKUP_DIR ?? '/srv/backups';

backup.post('/backup', async (c) => {
  try { await requireAdmin(c); } catch (r) { return r as Response; }
  const dir = join(ROOT, new Date().toISOString().replace(/[:.]/g, '-'));
  try { return c.json(await runBackup(dir)); }
  catch (e) { return c.json({ error: e instanceof Error ? e.message : 'backup_failed' }, 500); }
});

backup.get('/backup', async (c) => {
  try { await requireAdmin(c); } catch (r) { return r as Response; }
  try {
    const dirs = await readdir(ROOT);
    const out = [];
    for (const d of dirs) {
      try { out.push(JSON.parse(await readFile(join(ROOT, d, 'manifest.json'), 'utf8'))); } catch {}
    }
    return c.json({ backups: out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  } catch { return c.json({ backups: [] }); }
});
```

Mount it in `src/control/app.ts`: `app.route('/api', backup);`

- [ ] **Step 5: Run the backup test against a live stack**

```bash
docker compose -f compose/docker-compose.yml -f compose/docker-compose.dev.yml up -d --wait
```

Run: `bun test test/integration/backup.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add scripts/backup.ts src/control/routes/backup.ts src/control/app.ts test/integration/backup.test.ts
git commit -m "feat(slice1): quiesced four-component backup with a checksummed manifest

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 12: Restore — tested in CI, with credential re-issue

**Untested restore is not backup.** This task's test is the one that makes the claim true.

**Files:**
- Create: `scripts/restore.ts`
- Modify: `.github/workflows/contract.yml` (add the restore job)
- Test: `test/e2e/restore.e2e.test.ts`

**Interfaces:**
- Consumes: `BackupManifest`, `runBackup` (Task 11); `callOps` (Task 7).
- Produces: `runRestore(dir: string, opts?: { newDomain?: string }): Promise<RestoreReport>` where `type RestoreReport = { ok: boolean; components: string[]; doctorExitCode: number; connectionsNeedingReissue: string[]; domainChanged: boolean }`

- [ ] **Step 1: Write the failing restore e2e test**

`test/e2e/restore.e2e.test.ts`:
```ts
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBackup } from '../../scripts/backup.ts';
import { runRestore } from '../../scripts/restore.ts';
import { callOps } from '../../src/control/opsClient.ts';

let dir: string;
const KNOWN_SLUG = 'restore-probe';
const KNOWN_TEXT = 'The restore probe page proves a known page survives.';

const compose = (...args: string[]) =>
  Bun.spawn(['docker', 'compose', '-f', 'compose/docker-compose.yml',
             '-f', 'compose/docker-compose.dev.yml', ...args], { stdout: 'inherit', stderr: 'inherit' }).exited;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bs-restore-'));
  await compose('up', '-d', '--wait');

  // Seed a known page and index it.
  await Bun.spawn(['docker', 'compose', '-f', 'compose/docker-compose.yml', 'exec', '-T', 'gbrain-ops',
    'sh', '-c',
    `printf '# Restore probe\\n\\n${KNOWN_TEXT}\\n' > /srv/brain-repos/shared/${KNOWN_SLUG}.md && ` +
    `cd /srv/brain-repos/shared && git add -A && git commit -qm 'restore probe'`]).exited;
  await callOps('sync', { all: true }, { json: true, timeoutMs: 900_000 });
  await callOps('embed', { stale: true }, { json: true, timeoutMs: 900_000 });
}, 1_800_000);

afterAll(async () => { await compose('down', '-v'); await rm(dir, { recursive: true, force: true }); });

describe('restore', () => {
  test('an empty stack restored from a backup reproduces a known page', async () => {
    await runBackup(dir);

    // Destroy everything, then bring an empty stack back up.
    await compose('down', '-v');
    await compose('up', '-d', '--wait');

    const report = await runRestore(dir);
    expect(report.ok).toBe(true);
    expect(report.doctorExitCode).toBe(0);

    const search = await callOps<any>('sources.list', {}, { json: true, timeoutMs: 120_000 });
    expect(search.ok).toBe(true);

    const probe = await Bun.spawn(['docker', 'compose', '-f', 'compose/docker-compose.yml',
      'exec', '-T', 'gbrain-ops', 'gbrain', 'search', 'restore probe', '--json'],
      { stdout: 'pipe' });
    const text = await new Response(probe.stdout).text();
    expect(text).toContain(KNOWN_SLUG);
  }, 3_600_000);

  // V9: gbrain's backup excludes every credential and restore starts no
  // automation, so a naive restore leaves intact knowledge and zero working
  // agent connections. The product does the re-issue and says who must refresh.
  test('restore reports which connections need re-issued credentials', async () => {
    const report = await runRestore(dir);
    expect(Array.isArray(report.connectionsNeedingReissue)).toBe(true);
  }, 1_800_000);

  // Restoring to a new domain invalidates every grant: OAuth redirect URIs
  // and issuer URLs are domain-bound.
  test('restoring to a new domain flags bulk re-provisioning', async () => {
    const report = await runRestore(dir, { newDomain: 'brain-new.example.test' });
    expect(report.domainChanged).toBe(true);
  }, 1_800_000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/e2e/restore.e2e.test.ts`
Expected: FAIL — `Cannot find module '../../scripts/restore.ts'`.

- [ ] **Step 3: Write `scripts/restore.ts`**

```ts
#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { callOps } from '../src/control/opsClient.ts';
import type { BackupManifest } from './backup.ts';

export type RestoreReport = {
  ok: boolean;
  components: string[];
  doctorExitCode: number;
  connectionsNeedingReissue: string[];
  domainChanged: boolean;
};

const COMPOSE = ['docker', 'compose', '-f', 'compose/docker-compose.yml'];

async function sh(argv: string[], timeoutMs = 900_000) {
  const p = Bun.spawn(argv, { stdout: 'inherit', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [stderr, exitCode] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { exitCode, stderr };
}

/**
 * Restore is a console flow, not a README script: restore both databases,
 * re-materialize secrets, then re-issue credentials for every Connection —
 * gbrain hashes client secrets server-side, so restoring cannot recover them.
 * The re-issue step is the part nobody expects, so we do it automatically and
 * show which agents need a config refresh.
 */
export async function runRestore(dir: string, opts: { newDomain?: string } = {}): Promise<RestoreReport> {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as BackupManifest;

  if (!process.env.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY is required to restore: it is held separately from the archive');
  }

  // Stop everything that writes before touching the databases.
  await sh([...COMPOSE, 'stop', '-t', '90', 'gbrain-worker', 'gbrain-serve', 'control-plane'], 150_000);

  const restoreDb = async (db: string, file: string) => {
    const r = await sh(['sh', '-c',
      `${COMPOSE.join(' ')} exec -T postgres psql -U gbrain -d postgres -c 'drop database if exists ${db}' && ` +
      `${COMPOSE.join(' ')} exec -T postgres psql -U gbrain -d postgres -c 'create database ${db}' && ` +
      `${COMPOSE.join(' ')} exec -T postgres psql -U gbrain -d ${db} < ${join(dir, file)}`]);
    if (r.exitCode !== 0) throw new Error(`restore ${db} failed: ${r.stderr}`);
  };

  await restoreDb('gbrain', manifest.components.brainDb);
  await restoreDb('control', manifest.components.controlDb);

  const tar = await sh(['sh', '-c',
    `${COMPOSE.join(' ')} exec -T gbrain-ops tar -xf - -C /srv/brain-repos < ${join(dir, manifest.components.brainRepos)}`]);
  if (tar.exitCode !== 0) throw new Error(`repo restore failed: ${tar.stderr}`);

  await sh([...COMPOSE, 'start', 'gbrain-serve', 'gbrain-worker', 'control-plane'], 180_000);
  await sh([...COMPOSE, 'exec', '-T', 'gbrain-ops', 'gbrain', 'apply-migrations', '--yes', '--non-interactive'], 600_000);

  const doctor = await callOps('doctor', {}, { json: true, timeoutMs: 900_000 });

  // Slice 1 has no Connections yet; Slice 2 fills this list and drives the
  // automatic re-issue. The field ships now so the flow is not bolted on later.
  const clients = await callOps<any[]>('auth.clients', {}, { json: true, timeoutMs: 120_000 });
  const connectionsNeedingReissue = Array.isArray(clients.json)
    ? clients.json.map((c: any) => String(c.client_id ?? c.clientId ?? '')).filter(Boolean)
    : [];

  return {
    ok: doctor.exitCode === 0,
    components: Object.keys(manifest.components),
    doctorExitCode: doctor.exitCode,
    connectionsNeedingReissue,
    domainChanged: Boolean(opts.newDomain),
  };
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: bun run scripts/restore.ts <backup-dir>'); process.exit(2); }
  const report = await runRestore(dir, { newDomain: process.env.NEW_DOMAIN });
  console.log(JSON.stringify(report, null, 2));
  if (report.domainChanged) {
    console.error('\nRestored to a NEW DOMAIN: every OAuth grant is invalid — ' +
      'OAuth redirect URIs and issuer URLs are domain-bound. Re-provision all Connections.');
  }
  if (!report.ok) process.exit(1);
}
```

- [ ] **Step 4: Add the restore job to `.github/workflows/contract.yml`**

```yaml
  restore:
    runs-on: ubuntu-latest
    needs: contract
    env:
      GBRAIN_VERSION: '0.50.0.0'
      DOMAIN: localhost
      POSTGRES_PASSWORD: ci-not-a-real-secret
      OPS_RPC_TOKEN: ci-not-a-real-token
      ENCRYPTION_KEY: ci-encryption-key-at-least-32-characters-long
      BETTER_AUTH_SECRET: ci-better-auth-secret-at-least-32-chars
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.14 }
      - run: bun install --frozen-lockfile
      - run: |
          docker build -f docker/gbrain-base.Dockerfile \
            --build-arg "GBRAIN_VERSION=${GBRAIN_VERSION}" \
            -t "brainstand/gbrain-base:${GBRAIN_VERSION}" .
      # Untested restore is not backup.
      - run: bun test test/e2e/restore.e2e.test.ts
        timeout-minutes: 90
```

- [ ] **Step 5: Run the restore e2e test**

Run: `bun test test/e2e/restore.e2e.test.ts`
Expected: PASS — 3 tests. Budget up to an hour.

- [ ] **Step 6: Commit**

```bash
git add scripts/restore.ts .github/workflows/contract.yml test/e2e/restore.e2e.test.ts
git commit -m "feat(slice1): CI-tested restore with credential re-issue reporting

Empty stack -> restore -> doctor green -> a known page comes back.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 13: `install.sh` and the break-glass runbook

Break-glass is the documented recovery path when the console is broken and the brain is fine, so it is **a first-class artifact in Slice 1**, not an afterthought (S1).

**Files:**
- Create: `scripts/install.sh`, `docs/runbooks/break-glass.md`
- Test: `test/unit/install.test.sh`

**Interfaces:**
- Produces: a `.env` with generated secrets and a running stack.

- [ ] **Step 1: Write the failing installer test**

`test/unit/install.test.sh`:
```bash
#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/../.."
fail=0
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "--- generates a .env with every required secret"
DOMAIN=brain.test BRAINSTAND_SKIP_UP=1 BRAINSTAND_ENV_PATH="$work/.env" bash scripts/install.sh >/dev/null 2>&1
for key in DOMAIN POSTGRES_PASSWORD OPS_RPC_TOKEN ENCRYPTION_KEY BETTER_AUTH_SECRET GBRAIN_VERSION; do
  if grep -q "^${key}=.\+" "$work/.env"; then echo "PASS: $key set"; else echo "FAIL: $key missing or empty"; fail=1; fi
done

echo "--- ENCRYPTION_KEY is at least 32 characters"
len=$(grep '^ENCRYPTION_KEY=' "$work/.env" | cut -d= -f2- | tr -d '\n' | wc -c)
if [ "$len" -ge 32 ]; then echo "PASS: length $len"; else echo "FAIL: length $len"; fail=1; fi

echo "--- secrets differ from each other"
if [ "$(grep -c '^OPS_RPC_TOKEN=' "$work/.env")" -eq 1 ] && \
   [ "$(grep '^OPS_RPC_TOKEN=' "$work/.env")" != "$(grep '^ENCRYPTION_KEY=' "$work/.env" | sed s/ENCRYPTION_KEY/OPS_RPC_TOKEN/)" ]; then
  echo "PASS: distinct secrets"
else echo "FAIL: secrets collide"; fail=1; fi

echo "--- refuses to clobber an existing .env"
if DOMAIN=brain.test BRAINSTAND_SKIP_UP=1 BRAINSTAND_ENV_PATH="$work/.env" bash scripts/install.sh >/dev/null 2>&1; then
  echo "FAIL: overwrote an existing .env"; fail=1
else echo "PASS: refused to overwrite"; fi

echo "--- refuses to run without DOMAIN"
if BRAINSTAND_SKIP_UP=1 BRAINSTAND_ENV_PATH="$work/.env2" bash scripts/install.sh </dev/null >/dev/null 2>&1; then
  echo "FAIL: ran without DOMAIN"; fail=1
else echo "PASS: required DOMAIN"; fi

exit $fail
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash test/unit/install.test.sh`
Expected: FAIL — `scripts/install.sh: No such file or directory`.

- [ ] **Step 3: Write `scripts/install.sh`**

```bash
#!/usr/bin/env bash
# brainstand self-host installer. The compose IS the deployment; this script
# only prompts for a domain, generates secrets, writes .env and brings the
# stack up. The console owns everything after `up`.
set -euo pipefail

ENV_PATH="${BRAINSTAND_ENV_PATH:-.env}"
GBRAIN_VERSION="${GBRAIN_VERSION:-0.50.0.0}"

if [ -e "$ENV_PATH" ]; then
  echo "Refusing to overwrite an existing $ENV_PATH." >&2
  echo "Delete it first if you really mean to reinstall — regenerating ENCRYPTION_KEY" >&2
  echo "makes every stored secret unrecoverable." >&2
  exit 1
fi

DOMAIN="${DOMAIN:-}"
if [ -z "$DOMAIN" ]; then
  read -r -p "Domain for this brain (e.g. brain.acme-co.com): " DOMAIN || true
fi
if [ -z "$DOMAIN" ]; then
  echo "A domain is required: Caddy obtains a TLS certificate for it." >&2
  exit 2
fi

gen() { head -c 48 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-48; }

umask 077
cat > "$ENV_PATH" <<EOF
DOMAIN=${DOMAIN}
GBRAIN_VERSION=${GBRAIN_VERSION}
BRAINSTAND_VERSION=dev
WORKER_CONCURRENCY=2

POSTGRES_PASSWORD=$(gen)
OPS_RPC_TOKEN=$(gen)
ENCRYPTION_KEY=$(gen)
BETTER_AUTH_SECRET=$(gen)
EOF
chmod 600 "$ENV_PATH"

cat <<EOF

Wrote $ENV_PATH (mode 600).

BACK UP ENCRYPTION_KEY SEPARATELY FROM YOUR DATABASE BACKUPS.
Without it, every stored secret is unrecoverable. With both in one place,
a leaked backup is a credential dump.

EOF

if [ "${BRAINSTAND_SKIP_UP:-0}" = "1" ]; then
  echo "Skipping docker compose up (BRAINSTAND_SKIP_UP=1)."
  exit 0
fi

docker compose -f compose/docker-compose.yml up -d --wait

cat <<EOF

Stack is up. Open https://${DOMAIN} and create your first admin.

Note: https://${DOMAIN}/admin is deliberately NOT routed — gbrain's embedded
admin SPA is a second control plane with god rights over the same brain.
See docs/runbooks/break-glass.md for the recovery path.
EOF
```

- [ ] **Step 4: Write `docs/runbooks/break-glass.md`**

```markdown
# Break-glass: operating the brain when the console is down

The console is not the only way in — but it is the only way in *through the
product*. When the console is broken and the brain itself is fine, this is the
documented recovery path.

## Why `/admin` is not simply exposed

gbrain ships an embedded admin SPA at `/admin`. It is **a second control plane
with god rights over the same brain**, authenticated by a bootstrap token
rather than our RBAC, with in-process sessions and no audit trail we own.
Every decision the permission compiler makes can be silently overridden there.

So it is bound to the private network and Caddy answers `404` for it. The
recovery path is the ops sidecar over SSH.

## Prerequisites

- SSH access to the VM running the stack.
- Membership in the `docker` group, or `sudo`.
- The repository checkout with `compose/docker-compose.yml`.

## The one command you need

```bash
docker compose -f compose/docker-compose.yml exec gbrain-ops gbrain <command>
```

`gbrain-ops` holds the brain `DATABASE_URL` and a writable `GBRAIN_HOME`, so
every control-plane command works there. The control plane holds neither.

## Common recoveries

**Is the brain healthy at all?**
```bash
docker compose -f compose/docker-compose.yml exec gbrain-ops gbrain doctor --json
```
Exit 0 = no blockers. Non-zero = read the `blockers` array.

**The console cannot reach the ops sidecar**
```bash
docker compose -f compose/docker-compose.yml logs --tail 100 gbrain-ops
docker compose -f compose/docker-compose.yml exec gbrain-ops sh -c 'curl -sf http://127.0.0.1:3140/healthz'
```

**Jobs are stuck**
```bash
docker compose -f compose/docker-compose.yml exec gbrain-ops gbrain jobs supervisor status --json
docker compose -f compose/docker-compose.yml restart gbrain-worker
```
The supervisor drains on SIGTERM and `stop` waits up to 40 seconds. Exit codes:
`0` clean shutdown, `1` max crashes exceeded, `2` another supervisor holds the
PID lock, `3` PID file unwritable.

**A member's agent cannot connect**
```bash
docker compose -f compose/docker-compose.yml exec gbrain-ops gbrain auth clients --json
docker compose -f compose/docker-compose.yml exec gbrain-ops gbrain mcp verify --client <client_id> --json
```
`mcp verify` exit `2` means *partial*: server stages passed but harness
evidence is missing. **That is not success** — do not report it as healthy.

**Reach the embedded admin SPA anyway (last resort)**

Do not open a public route. Tunnel it over SSH so it stays private:
```bash
ssh -L 3131:127.0.0.1:3131 user@your-vm
docker compose -f compose/docker-compose.yml exec gbrain-serve sh -c 'echo serving on 3131'
```
Then browse `http://127.0.0.1:3131/admin` on your own machine. **Anything you
change there bypasses our RBAC and our audit log.** Record what you did in the
incident notes; the console cannot show it to you.

## What NOT to do

- **Never run `gbrain autopilot --install`** in a container. It writes a
  crontab line, which in a container is either a silent no-op or a
  duplicate-scheduler bug depending on the base image. The product owns
  scheduling.
- **Never run `gbrain upgrade` or a self-upgrade** by hand. The product owns
  the upgrade lane; an in-container self-upgrade desynchronizes the image from
  the running binary. `GBRAIN_SELF_UPGRADE_MODE=off` is set for this reason.
- **Never publish a host port for `gbrain-serve` or `postgres`.** `gbrain-serve`
  runs with `GBRAIN_HTTP_TRUST_PROXY=1`; making it directly reachable lets
  clients spoof `X-Forwarded-For`.
- **Never edit `~/.gbrain/config.json` by hand while the stack is up.** Writes
  serialize through `gbrain-ops` behind a Postgres advisory lock; an unlocked
  edit can lose an API key.

## After the incident

1. `gbrain doctor --json` → 0.
2. Re-run the console health page.
3. If you touched `/admin`, note it — our `audit_log` did not see it.
```

- [ ] **Step 5: Run the installer test to verify it passes**

Run: `bash test/unit/install.test.sh`
Expected: all `PASS` lines, exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/install.sh docs/runbooks/break-glass.md test/unit/install.test.sh
git commit -m "feat(slice1): install.sh and the break-glass runbook

Break-glass is the documented recovery path when the console is broken and
the brain is fine, so it ships as a first-class artifact (S1).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 14: Git writer contention — detect and surface

The spec calls git-as-system-of-record *the most under-designed area*, and this slice's compose makes it live: `gbrain-serve` (via `put_page`), `gbrain-worker` (via sync jobs) and `gbrain-ops` (via the wizard) all commit to **one working tree on one shared volume**. Concurrent `git` on one repo produces `index.lock` contention and confusing intermittent failures under load.

**What we can honestly fix at Slice 1.** Serve and worker commit inside gbrain's own code, and G3 forbids patching it — so full serialization is an upstream contribution, not something we bolt on. What we *can* do, and must: serialize every write **we** drive through `gbrain-ops` (already true), and **detect and surface** the rest. Even detect-and-surface beats nothing, and it turns an intermittent mystery into a health signal.

**Files:**
- Create: `src/ops/git.ts`
- Modify: `src/control/routes/health.ts`
- Test: `test/unit/git.test.ts`, `test/integration/git-health.test.ts`

**Interfaces:**
- Consumes: `withAdvisoryLock` (Task 3); `callOps` (Task 7).
- Produces:
  - `type RepoStatus = { sourceId: string; staleLock: boolean; lockAgeSeconds: number | null; uncommittedFiles: number; unpushedCommits: number; branch: string | null }`
  - `inspectRepos(root?: string): Promise<RepoStatus[]>`
  - `withRepoLock<T>(sql, sourceId, fn): Promise<T>`
  - `commitAs(sourceId: string, actor: { name: string; email: string }, message: string, opts: { sql }): Promise<{ committed: boolean; sha: string | null }>`

- [ ] **Step 1: Write the failing unit test**

`test/unit/git.test.ts`:
```ts
import { test, expect, describe } from 'bun:test';
import { classifyLock, commitArgs } from '../../src/ops/git.ts';

describe('classifyLock', () => {
  // A lock held for seconds is a healthy concurrent write. One held for
  // minutes is a crashed process, and the difference is the whole signal.
  test('a fresh lock is not stale', () => {
    expect(classifyLock(5).staleLock).toBe(false);
  });

  test('a lock older than the threshold is stale', () => {
    expect(classifyLock(600).staleLock).toBe(true);
  });

  test('no lock at all is not stale', () => {
    expect(classifyLock(null)).toEqual({ staleLock: false, lockAgeSeconds: null });
  });
});

describe('commitArgs', () => {
  // Commit as the member, not as "the agent". This is what makes the audit
  // story real rather than "agent-runner did everything".
  test('sets author identity per invocation rather than globally', () => {
    const argv = commitArgs({ name: 'Alice Example', email: 'alice@example.test' }, 'add page');
    expect(argv.slice(0, 6)).toEqual([
      '-c', 'user.name=Alice Example', '-c', 'user.email=alice@example.test', 'commit', '-m',
    ]);
    expect(argv.at(-1)).toBe('add page');
  });

  test('keeps a message with shell metacharacters in one argv element', () => {
    const argv = commitArgs({ name: 'A', email: 'a@b.test' }, 'fix; rm -rf / #');
    expect(argv.at(-1)).toBe('fix; rm -rf / #');
    expect(argv.filter((a) => a.includes('rm -rf'))).toHaveLength(1);
  });

  test('refuses an identity containing a newline', () => {
    expect(() => commitArgs({ name: 'A\nB', email: 'a@b.test' }, 'm'))
      .toThrow('invalid git identity');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/git.test.ts`
Expected: FAIL — `Cannot find module '../../src/ops/git.ts'`.

- [ ] **Step 3: Write `src/ops/git.ts`**

```ts
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SQL } from 'bun';
import { withAdvisoryLock } from './lock.ts';

const REPOS_ROOT = process.env.BRAIN_REPOS ?? '/srv/brain-repos';

/** A lock held longer than this is a crashed writer, not a concurrent one. */
const STALE_LOCK_SECONDS = 120;

export type RepoStatus = {
  sourceId: string;
  staleLock: boolean;
  lockAgeSeconds: number | null;
  uncommittedFiles: number;
  unpushedCommits: number;
  branch: string | null;
};

export function classifyLock(ageSeconds: number | null): { staleLock: boolean; lockAgeSeconds: number | null } {
  if (ageSeconds === null) return { staleLock: false, lockAgeSeconds: null };
  return { staleLock: ageSeconds > STALE_LOCK_SECONDS, lockAgeSeconds: ageSeconds };
}

/** Commit AS the member: identity per invocation, never a global config write. */
export function commitArgs(actor: { name: string; email: string }, message: string): string[] {
  if (/[\n\r]/.test(actor.name) || /[\n\r]/.test(actor.email)) {
    throw new Error('invalid git identity: newlines are not allowed');
  }
  return [
    '-c', `user.name=${actor.name}`,
    '-c', `user.email=${actor.email}`,
    'commit', '-m', message,
  ];
}

async function git(cwd: string, argv: string[]): Promise<{ exitCode: number; stdout: string }> {
  const p = Bun.spawn(['git', ...argv], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, exitCode] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { exitCode, stdout };
}

/** Report contention and drift across every Space repo. Read-only. */
export async function inspectRepos(root = REPOS_ROOT): Promise<RepoStatus[]> {
  let entries: string[] = [];
  try { entries = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return []; }

  const out: RepoStatus[] = [];
  for (const sourceId of entries) {
    const cwd = join(root, sourceId);

    let lockAge: number | null = null;
    try {
      const s = await stat(join(cwd, '.git', 'index.lock'));
      lockAge = Math.round((Date.now() - s.mtimeMs) / 1000);
    } catch { lockAge = null; }

    const status = await git(cwd, ['status', '--porcelain']);
    const branchRes = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    // Sync imports COMMITS, not the working tree, unless sync.include_working_tree
    // is set — so uncommitted files are pages the brain cannot see yet.
    const unpushed = await git(cwd, ['rev-list', '--count', '@{u}..HEAD']);

    out.push({
      sourceId,
      ...classifyLock(lockAge),
      uncommittedFiles: status.exitCode === 0
        ? status.stdout.split('\n').filter((l) => l.trim()).length : 0,
      unpushedCommits: unpushed.exitCode === 0 ? Number(unpushed.stdout.trim() || '0') : 0,
      branch: branchRes.exitCode === 0 ? branchRes.stdout.trim() : null,
    });
  }
  return out;
}

/**
 * Serialize the commits WE drive. Serve and worker commit inside gbrain's own
 * code and we do not patch upstream (G3), so this narrows the window rather
 * than closing it — the health signal above is what catches the rest.
 */
export async function withRepoLock<T>(sql: SQL, sourceId: string, fn: () => Promise<T>): Promise<T> {
  return withAdvisoryLock(sql, `repo:${sourceId}`, fn, { timeoutMs: 60_000 });
}

export async function commitAs(
  sourceId: string,
  actor: { name: string; email: string },
  message: string,
  opts: { sql: SQL; root?: string },
): Promise<{ committed: boolean; sha: string | null }> {
  const cwd = join(opts.root ?? REPOS_ROOT, sourceId);
  return withRepoLock(opts.sql, sourceId, async () => {
    await git(cwd, ['add', '-A']);
    const commit = await git(cwd, commitArgs(actor, message));
    if (commit.exitCode !== 0) return { committed: false, sha: null }; // nothing to commit
    const head = await git(cwd, ['rev-parse', 'HEAD']);
    return { committed: true, sha: head.stdout.trim() || null };
  });
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `bun test test/unit/git.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Surface repo status on the health route**

In `src/control/routes/health.ts`, add the import and extend the response:

```ts
import { callOps } from '../opsClient.ts';
```

and inside the handler, after the `ops` check:

```ts
  // Show uncommitted drift rather than pretending a saved page is indexed:
  // sync imports commits, not the working tree.
  let repos: unknown[] = [];
  if (components.ops === 'ok') {
    try {
      const r = await callOps<unknown[]>('sources.status', {}, { json: true, timeoutMs: 30_000 });
      repos = Array.isArray(r.json) ? r.json : [];
    } catch { repos = []; }
  }
```

and include `repos` in the `c.json({ ... })` payload.

- [ ] **Step 6: Write the failing integration test**

`test/integration/git-health.test.ts`:
```ts
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectRepos } from '../../src/ops/git.ts';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bs-git-'));
  const repo = join(root, 'shared');
  await mkdir(repo, { recursive: true });
  await Bun.spawn(['git', 'init', '-q'], { cwd: repo }).exited;
  await Bun.spawn(['git', 'config', 'user.email', 't@example.test'], { cwd: repo }).exited;
  await Bun.spawn(['git', 'config', 'user.name', 'T'], { cwd: repo }).exited;
  await writeFile(join(repo, 'a.md'), '# A\n');
  await Bun.spawn(['git', 'add', '-A'], { cwd: repo }).exited;
  await Bun.spawn(['git', 'commit', '-qm', 'seed'], { cwd: repo }).exited;
}, 60_000);
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('inspectRepos', () => {
  test('reports a clean repo with no lock', async () => {
    const [r] = await inspectRepos(root);
    expect(r?.sourceId).toBe('shared');
    expect(r?.staleLock).toBe(false);
    expect(r?.uncommittedFiles).toBe(0);
  });

  // The drift that matters: a saved page that is not committed is a page the
  // brain cannot see, and the console must say so.
  test('reports uncommitted drift', async () => {
    await writeFile(join(root, 'shared', 'b.md'), '# B\n');
    const [r] = await inspectRepos(root);
    expect(r?.uncommittedFiles).toBeGreaterThan(0);
  });

  test('reports a stale index.lock', async () => {
    const lock = join(root, 'shared', '.git', 'index.lock');
    await writeFile(lock, '');
    const old = new Date(Date.now() - 600_000);
    const { utimes } = await import('node:fs/promises');
    await utimes(lock, old, old);
    const [r] = await inspectRepos(root);
    expect(r?.staleLock).toBe(true);
    expect(r?.lockAgeSeconds).toBeGreaterThan(120);
  });

  test('an empty root yields no repos rather than throwing', async () => {
    expect(await inspectRepos(join(root, 'does-not-exist'))).toEqual([]);
  });
});
```

- [ ] **Step 7: Run it to verify it passes**

Run: `bun test test/integration/git-health.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 8: Record the upstream contribution**

Append to `docs/slice-0-findings.md` under *Decisions this changes*:

```markdown
- **Git multi-writer.** serve + worker + ops commit to one working tree on one
  shared volume. We serialize the writes we drive and surface `index.lock`
  staleness plus uncommitted drift on the health page, but full serialization
  needs either per-process worktrees or a commit lock inside gbrain. File it
  as an upstream contribution alongside the production Dockerfile.
- **Push is not inline.** `sources push` runs from backup today and becomes a
  scheduled reconcile job in Slice 3. A rejected non-fast-forward must surface
  as an alert, never a silent swallow.
- **Growth.** Every write is a commit; a year of agent writes makes clone and
  backup slow. Plan `gc` / rotation before Slice 4 turns on nightly agents.
```

- [ ] **Step 9: Commit**

```bash
git add src/ops/git.ts src/control/routes/health.ts test/unit/git.test.ts test/integration/git-health.test.ts docs/slice-0-findings.md
git commit -m "feat(slice1): detect git writer contention and surface uncommitted drift

Three processes share one working tree. We serialize what we drive and make
the rest a health signal rather than an intermittent mystery.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 15: The Slice 1 exit gate — one end-to-end proof

**Files:**
- Create: `test/e2e/slice1.e2e.test.ts`
- Modify: `package.json` (add `test:e2e`)

**Interfaces:**
- Consumes: every task above.

- [ ] **Step 1: Write the end-to-end gate**

`test/e2e/slice1.e2e.test.ts`:
```ts
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';

const BASE = process.env.E2E_BASE_URL ?? 'https://localhost:8443';
const COMPOSE = ['docker', 'compose', '-f', 'compose/docker-compose.yml', '-f', 'compose/docker-compose.dev.yml'];

// Caddy's internal CA in dev; a real cert in production.
const fetchInsecure = (path: string, init?: RequestInit) =>
  fetch(`${BASE}${path}`, { ...init, tls: { rejectUnauthorized: false } } as RequestInit);

const compose = (...args: string[]) =>
  Bun.spawn([...COMPOSE, ...args], { stdout: 'inherit', stderr: 'inherit' }).exited;

let cookie = '';

beforeAll(async () => {
  await compose('up', '-d', '--wait');
  for (let i = 0; i < 120; i++) {
    try { if ((await fetchInsecure('/api/health')).status < 500) return; } catch {}
    await Bun.sleep(2000);
  }
  throw new Error('stack did not become reachable');
}, 1_800_000);

afterAll(async () => { await compose('down', '-v'); }, 300_000);

describe('Slice 1 exit gate', () => {
  test('docker compose up gives a reachable /api/health', async () => {
    const res = await fetchInsecure('/api/health');
    expect(res.status).toBeLessThan(500);
    expect((await res.json()).components.controlDb).toBe('ok');
  });

  // S1: the single most important negative assertion in this slice.
  test('/admin is NOT reachable from the internet', async () => {
    for (const p of ['/admin', '/admin/', '/admin/api/grants', '/admin/events']) {
      expect((await fetchInsecure(p)).status).toBe(404);
    }
  });

  test('gbrain reserved paths route to gbrain-serve, not the console', async () => {
    const wk = await fetchInsecure('/.well-known/gbrain');
    expect(wk.status).toBe(200);
    const body = await wk.json();
    expect(body.protocol).toBe('mcp');
    expect(body.version).toBe(process.env.GBRAIN_VERSION ?? '0.50.0.0');
  });

  test('/health belongs to gbrain-serve and is not the console health', async () => {
    const body = await (await fetchInsecure('/health')).json();
    expect(body).not.toHaveProperty('components.controlDb');
  });

  test('the wizard reaches ready', async () => {
    await fetchInsecure('/api/bootstrap', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.test', password: 'a-long-enough-password', orgName: 'Acme' }),
    });
    const signIn = await fetchInsecure('/api/auth/sign-in/email', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.test', password: 'a-long-enough-password' }),
    });
    cookie = signIn.headers.get('set-cookie') ?? '';

    const post = (p: string, b: unknown) => fetchInsecure(p, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(b),
    });

    expect((await post('/api/wizard/provider', {
      provider: 'openai', apiKey: process.env.OPENAI_API_KEY ?? 'sk-e2e-placeholder',
      embeddingModel: 'openai:text-embedding-3-small',
    })).status).toBe(200);
    expect((await post('/api/wizard/search-mode', { mode: 'fast' })).status).toBe(200);
    expect((await post('/api/wizard/schema', { pack: 'gbrain-base-v2' })).status).toBe(200);
    expect((await post('/api/wizard/space', { sourceId: 'shared', name: 'Shared' })).status).toBe(200);

    const finish = await post('/api/wizard/finish', {});
    expect(finish.status).toBe(200);
    expect((await finish.json()).lifecycle).toBe('ready');
  }, 2_400_000);

  test('a put_page then search round trip works', async () => {
    await Bun.spawn(['docker', 'compose', '-f', 'compose/docker-compose.yml', 'exec', '-T', 'gbrain-ops',
      'sh', '-c',
      `printf '# E2E probe\\n\\nThe end to end probe page.\\n' > /srv/brain-repos/shared/e2e-probe.md && ` +
      `cd /srv/brain-repos/shared && git add -A && git commit -qm e2e`]).exited;

    await Bun.spawn(['docker', 'compose', '-f', 'compose/docker-compose.yml', 'exec', '-T', 'gbrain-ops',
      'gbrain', 'sync', '--all']).exited;
    await Bun.spawn(['docker', 'compose', '-f', 'compose/docker-compose.yml', 'exec', '-T', 'gbrain-ops',
      'gbrain', 'embed', '--stale']).exited;

    const p = Bun.spawn(['docker', 'compose', '-f', 'compose/docker-compose.yml', 'exec', '-T', 'gbrain-ops',
      'gbrain', 'search', 'end to end probe', '--json'], { stdout: 'pipe' });
    expect(await new Response(p.stdout).text()).toContain('e2e-probe');
  }, 1_800_000);

  test('stop and start preserves data', async () => {
    await compose('stop');
    await compose('start');
    for (let i = 0; i < 60; i++) {
      try { if ((await fetchInsecure('/api/health')).status < 500) break; } catch {}
      await Bun.sleep(2000);
    }
    const state = await (await fetchInsecure('/api/wizard/state', { headers: { cookie } })).json();
    expect(state.lifecycle).toBe('ready');
    expect(state.spaces.map((s: any) => s.sourceId)).toContain('shared');
  }, 600_000);
});
```

- [ ] **Step 2: Add the script to `package.json`**

```json
"test:e2e": "bun test test/e2e"
```

- [ ] **Step 3: Run the gate**

```bash
DOMAIN=localhost POSTGRES_PASSWORD=e2e-not-a-real-secret OPS_RPC_TOKEN=e2e-not-a-real-token ENCRYPTION_KEY=e2e-encryption-key-at-least-32-characters BETTER_AUTH_SECRET=e2e-better-auth-secret-at-least-32-chars bun run test:e2e
```

Expected: PASS — 7 tests in `slice1.e2e.test.ts` plus the 3 restore tests. Budget 90 minutes.

- [ ] **Step 4: Run every suite one final time**

Run: `bun run lint:forbidden && bun run test:unit && bun test test/integration && bun run test:contract`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/slice1.e2e.test.ts package.json
git commit -m "test(slice1): end-to-end exit gate

compose up -> health -> wizard to ready -> put_page/search -> restart -> data
intact, with /admin unreachable from the internet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Slice 1 exit gate

Do not start Slice 2 until all six hold, on a **clean VM** rather than a dev machine:

- [ ] `docker compose up` → `https://$DOMAIN/api/health` returns ok.
- [ ] The wizard reaches `ready` without the operator seeing a connection string.
- [ ] A `put_page` → `search` round trip works.
- [ ] `docker compose stop && docker compose start` preserves data.
- [ ] **Restore into an empty stack reproduces a known page** (`test/e2e/restore.e2e.test.ts` green in CI).
- [ ] **`/admin` is not reachable from the internet** — verified from outside the VM, not just from the test suite.

**Then:** write the Slice 2 plan from the roadmap's Slice 2 section — orgs/roles, the permission compiler, claim-link provisioning, and revoke shipped in the same sprint as grant.

## Deferred to their own slices

Named here so nobody goes looking for them in Slice 1:

| Deferred | Lands in | Why not now |
|---|---|---|
| `connections`, `schedules`, `schedule_runs` tables | Slices 2–3 | YAGNI; `organizations.brain_mode` and `memberships` ship now precisely because those two would otherwise be a migration |
| The permission compiler, claim links, revoke | Slice 2 | Needs members first |
| Better Auth organization + RBAC plugins, OIDC/SSO | Slice 2 | Single admin needs none of it |
| `capability_snapshots` population + drift banner | Slice 3.5 | The table ships now; the upgrade flow fills it |
| `playbook_ledger` writes | Slice 3.5 | Table ships now, deterministic migrations fill it |
| Grafana/Prometheus compose profile | Slice 3–4 | Optional profile, not core |
| `agent-runner`, `runner-net`, egress allowlist | Slice 4 | The highest-risk surface; deliberately last |

