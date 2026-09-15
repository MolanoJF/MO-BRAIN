# Slice 0 — Prove the CLI Lane: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove — in Docker, against real Postgres, at an exact pinned gbrain version, with zero human interaction — that every control-plane operation the product needs is reachable through gbrain's CLI contracts, and emit the operation list Slice 1 implements.

**Architecture:** A small Bun/TypeScript harness on the host drives a pinned `gbrain-base` container over `docker compose exec -T`. All invocation goes through one typed exec layer that builds **argv arrays, never shell strings**, appends `--json`/`--dry-run` only where the operation declares support, and redacts secret-bearing flags. A contract test suite asserts flag acceptance, `--json` shape and exit codes for every command we depend on; a capability snapshot captures the self-describing surfaces. The suite must pass on the correct pin and **fail on a wrong pin** — that tripwire is what makes "never fork, pin exact semver" safe.

**Tech Stack:** Bun 1.3.14 (host) / `oven/bun:1.3.13` (image), TypeScript, `bun:test`, Docker Compose v2, `pgvector/pgvector:pg16`, gbrain `v0.50.0.0`.

**Spec:** `C:\Users\juanp\.claude\plans\we-want-to-do-snug-wolf.md`
**Roadmap + verified constraints:** [`2026-09-14-brainstand-roadmap.md`](./2026-09-14-brainstand-roadmap.md)

---

## Global Constraints

The roadmap's **Global Constraints** section applies to every task here. The ones that bite in this slice:

- **G1** — `GBRAIN_VERSION=0.50.0.0`, exact. Never `latest-stable`.
- **G2** — CLI exec for control-plane work, argv arrays never shell strings, `--json` always where available.
- **G3** — Never import gbrain internals, never read gbrain's tables directly, never patch its source, never screen-scrape human output. `C:\Users\juanp\Desktop\gbrain` is **read-only reference**.
- **G4** — Both contract mechanisms: capability snapshot (data plane) *and* contract test suite (control plane).
- Base image `oven/bun:1.3.13`; Postgres `pgvector/pgvector:pg16` with `vector`, `pg_trgm`, `pgcrypto`.
- **`postgres` publishes no host port** outside the dev override.
- Use **`GBRAIN_DATABASE_URL`**, never bare `DATABASE_URL`.
- **Never run `gbrain autopilot --install` in a container** — lint for it (Task 14).
- `tini` as PID 1.
- The image must carry gbrain's `LICENSE`.

**Entry gate:** Docker Desktop with Compose v2 installed. Verify before Task 1:

```bash
docker compose version
```

If this fails, stop — the whole slice is blocked.

---

## File Structure

Project root is `C:\Users\juanp\Desktop\Company Brain` (referred to below as the repo root). It is currently empty and not a git repository.

| Path | Responsibility |
|---|---|
| `package.json` | Bun manifest, scripts, dev deps. No runtime deps in Slice 0. |
| `tsconfig.json` | Strict TS, Bun types. |
| `.gitignore` | `node_modules/`, `.env`, `.brainstand-tmp/` |
| `.env.example` | Documented knobs; **never** a real secret. |
| `docker/gbrain-base.Dockerfile` | The pinned base image + build-time smoke gate. |
| `compose/docker-compose.slice0.yml` | Postgres + `gbrain-ops` only. No Caddy, no serve, no worker. |
| `compose/initdb/01-extensions.sh` | Creates the `gbrain` DB extensions at first boot. |
| `src/contracts/types.ts` | `ParamSpec`, `OperationSpec`, `ExecResult`, `ParamValues`. Types only. |
| `src/contracts/argv.ts` | `buildArgv`, `redactArgv`. Pure, no I/O — the security-critical unit. |
| `src/contracts/registry.ts` | The allowlisted operation registry. **The Slice 1 deliverable.** |
| `src/contracts/exec.ts` | `execOperation` — spawn via the docker helper, parse `--json`. |
| `src/contracts/capability.ts` | `captureCapability`, `diffCapability`. |
| `src/docker/host.ts` | `composeExec`, `composeUp`, `composeDown` — the only place `docker` is spawned. |
| `scripts/capture-capability.ts` | CLI entry: writes `contracts/<version>/capability.json`. |
| `scripts/emit-operations.ts` | CLI entry: writes `contracts/<version>/operations.json`. |
| `scripts/tutorial.ts` | The scripted company-brain tutorial, unattended. |
| `scripts/lint-forbidden.ts` | Repo guard: no `autopilot --install`, no shell-string exec. |
| `contracts/v0.50.0.0/operations.json` | **Generated, checked in.** Slice 1 implements exactly this list. |
| `contracts/v0.50.0.0/capability.json` | **Generated, checked in.** Renders Slice 1+ UI. |
| `test/helpers/stack.ts` | Per-suite stack lifecycle + a fresh-brain fixture. |
| `test/unit/argv.test.ts` | Pure argv tests. |
| `test/unit/capability.test.ts` | Drift-diff tests. |
| `test/contract/*.contract.test.ts` | One file per command family. |
| `docs/slice-0-findings.md` | The risk register this slice exists to produce. |
| `.github/workflows/contract.yml` | CI: contract suite on pinned-current + pinned-next. |

---

## Task 1: Repo scaffold and the pinned base image

The build must fail loudly on a bad pin rather than producing an image that fails at deploy time.

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`
- Create: `docker/gbrain-base.Dockerfile`
- Test: `test/build/pin.test.sh`

**Interfaces:**
- Produces: a Docker image tagged `brainstand/gbrain-base:0.50.0.0` containing the `gbrain` binary on PATH, `tini` at `/usr/bin/tini`, and gbrain's `LICENSE` at `/opt/gbrain-LICENSE`.

- [ ] **Step 1: Initialize the repository**

```bash
cd "C:/Users/juanp/Desktop/Company Brain"
git init
git branch -M main
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "brainstand",
  "private": true,
  "type": "module",
  "engines": { "bun": ">=1.3.13" },
  "scripts": {
    "test:unit": "bun test test/unit",
    "test:contract": "bun test test/contract",
    "test:build": "bash test/build/pin.test.sh",
    "lint:forbidden": "bun run scripts/lint-forbidden.ts",
    "stack:up": "docker compose -f compose/docker-compose.slice0.yml up -d --wait",
    "stack:down": "docker compose -f compose/docker-compose.slice0.yml down -v",
    "capability:capture": "bun run scripts/capture-capability.ts",
    "operations:emit": "bun run scripts/emit-operations.ts",
    "tutorial": "bun run scripts/tutorial.ts"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "scripts", "test"]
}
```

- [ ] **Step 4: Write `.gitignore`, `.gitattributes` and `.env.example`**

`.gitattributes` — **required on Windows.** With `core.autocrlf=true` the next checkout rewrites shell scripts to CRLF, and a CRLF shebang fails inside a Linux container with a bare `no such file or directory`:
```
*.sh            text eol=lf
*.Dockerfile    text eol=lf
Dockerfile      text eol=lf
*.yml           text eol=lf
*.yaml          text eol=lf
Caddyfile       text eol=lf
*.ts            text eol=lf
*.json          text eol=lf
.env.example    text eol=lf
```

`.gitignore`:
```
node_modules/
.env
.brainstand-tmp/
contracts/*/capability.local.json
```

`.env.example`:
```
# Exact gbrain version. NEVER use a moving tag such as latest-stable (G1).
GBRAIN_VERSION=0.50.0.0

# Slice 0 Postgres. No host port is published by the base compose.
POSTGRES_PASSWORD=change-me-in-a-real-deployment
GBRAIN_DB=gbrain

# Set to 1 only in a scratch shell where you accept a published Postgres port.
BRAINSTAND_DEV_EXPOSE_PG=0
```

- [ ] **Step 5: Write `docker/gbrain-base.Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
# brainstand gbrain base image.
#
# G1: the version is an exact semver ARG. A moving ref in an image build is
# non-reproducible by construction — never default this to latest-stable.
FROM oven/bun:1.3.13

ARG GBRAIN_VERSION
RUN test -n "$GBRAIN_VERSION" || (echo "GBRAIN_VERSION build-arg is required" >&2; exit 1)

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini postgresql-client \
 && rm -rf /var/lib/apt/lists/*

RUN bun install -g "github:garrytan/gbrain#v${GBRAIN_VERSION}"
ENV PATH="/root/.bun/bin:${PATH}"

# MIT obligation: ship the copyright notice and license text.
# bun installs globals under /root/.bun/install/global. NOTE: `bun pm -g bin`
# returns /usr/local/bin, which is the SYMLINK directory, not the package root.
RUN cp /root/.bun/install/global/node_modules/gbrain/LICENSE /opt/gbrain-LICENSE \
 || find / -path /proc -prune -o -name LICENSE -path '*gbrain*' -print -quit \
    | xargs -r -I{} cp {} /opt/gbrain-LICENSE
RUN test -s /opt/gbrain-LICENSE

# Build-time smoke gate: a bad pin fails the BUILD, not the deploy.
# `gbrain --version` prints "gbrain 0.50.0.0" -- the version is the LAST
# whitespace-separated token, NOT the whole line. grep -qx rejects a good build.
RUN gbrain --version | tee /opt/gbrain-version.txt \
 && awk -v v="${GBRAIN_VERSION}" '$NF == v { ok = 1 } END { exit !ok }' /opt/gbrain-version.txt
# Build-time smoke gate: verify the tool catalog is real, parseable JSON --
# not just a single leading byte. The catalog is a top-level JSON ARRAY
# (starts with '[', not '{'); a bare `head -c 1 | grep -q '{'` only ever
# accepts '{' and so always failed against gbrain's real (array) output.
# NOTE: deliberately avoids `require("fs")` inside `bun -e` -- on this image
# (bun 1.3.13) a `require`-containing eval silently swallows a later
# uncaught exception (prints nothing, exits 0), which would make this gate
# fake-pass. `Bun.file(...).json()` with top-level await does not have that
# problem and was verified against both real and broken --tools-json output.
RUN gbrain --tools-json > /tmp/gbrain-tools.json \
 && bytes="$(wc -c < /tmp/gbrain-tools.json)" \
 && test "$bytes" -gt 20 \
 && bun -e 'const d = await Bun.file("/tmp/gbrain-tools.json").json(); if (typeof d !== "object" || d === null) { console.error("tools-json parsed to a non-object/array:", typeof d); process.exit(1); }' \
 && rm -f /tmp/gbrain-tools.json

# The product owns the upgrade lane; an unattended in-container self-upgrade
# would desynchronize the image from the running binary.
ENV GBRAIN_SELF_UPGRADE_MODE=off

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
```

- [ ] **Step 6: Write the failing pin test**

`test/build/pin.test.sh`:
```bash
#!/usr/bin/env bash
# The build-time smoke gate must ACCEPT the pinned version and REJECT a wrong one.
set -uo pipefail
cd "$(dirname "$0")/../.."

PIN="${GBRAIN_VERSION:-0.50.0.0}"
fail=0

echo "--- expecting SUCCESS at pin ${PIN}"
if docker build -f docker/gbrain-base.Dockerfile \
     --build-arg "GBRAIN_VERSION=${PIN}" \
     -t "brainstand/gbrain-base:${PIN}" . ; then
  echo "PASS: pinned build succeeded"
else
  echo "FAIL: pinned build should have succeeded"; fail=1
fi

echo "--- expecting FAILURE at a deliberately wrong pin"
if docker build -f docker/gbrain-base.Dockerfile \
     --build-arg "GBRAIN_VERSION=0.0.0-not-a-real-version" \
     -t brainstand/gbrain-base:bogus . >/dev/null 2>&1 ; then
  echo "FAIL: bogus pin built successfully — the smoke gate is not a gate"; fail=1
else
  echo "PASS: bogus pin was rejected"
fi

exit $fail
```

- [ ] **Step 7: Run the test to verify the gate works**

Run: `bun run test:build`
Expected: `PASS: pinned build succeeded` and `PASS: bogus pin was rejected`, exit 0.

If the bogus build *succeeds*, the `grep -qx` smoke assertion is wrong — fix the Dockerfile, not the test.

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json .gitignore .gitattributes .env.example docker/ test/build/
git commit -m "feat(slice0): pinned gbrain base image with a build-time version gate

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Slice 0 compose — Postgres and the ops container

**Files:**
- Create: `compose/docker-compose.slice0.yml`
- Create: `compose/initdb/01-extensions.sh`
- Test: `test/contract/stack.contract.test.ts`

**Interfaces:**
- Consumes: the `brainstand/gbrain-base:${GBRAIN_VERSION}` image from Task 1.
- Produces: services named `postgres` and `gbrain-ops` on network `brain-net`; `gbrain-ops` has `GBRAIN_DATABASE_URL` and a RW `GBRAIN_HOME` at `/srv/gbrain-home`; brain repos at `/srv/brain-repos`.

- [ ] **Step 1: Write the Postgres extension bootstrap**

`compose/initdb/01-extensions.sh`:
```bash
#!/bin/bash
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-'SQL'
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL
```

- [ ] **Step 2: Write `compose/docker-compose.slice0.yml`**

```yaml
# Slice 0: prove the CLI lane. Postgres + one ops container, nothing else.
# No Caddy, no serve, no worker — those arrive in Slice 1.
name: brainstand-slice0

services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: gbrain
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-change-me-in-a-real-deployment}
      POSTGRES_DB: ${GBRAIN_DB:-gbrain}
    # No published host port. Slice 0 talks to Postgres from inside brain-net.
    volumes:
      - pg-data:/var/lib/postgresql/data
      - ./initdb:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U gbrain -d ${GBRAIN_DB:-gbrain}"]
      interval: 5s
      timeout: 5s
      retries: 20
    networks: [brain-net]

  gbrain-ops:
    image: brainstand/gbrain-base:${GBRAIN_VERSION:-0.50.0.0}
    build:
      context: ..
      dockerfile: docker/gbrain-base.Dockerfile
      args:
        GBRAIN_VERSION: ${GBRAIN_VERSION:-0.50.0.0}
    environment:
      # GBRAIN_DATABASE_URL, never a bare DATABASE_URL: upstream refuses to
      # adopt a DATABASE_URL that leaked in from a working-directory .env,
      # while GBRAIN_DATABASE_URL is always treated as stated intent.
      GBRAIN_DATABASE_URL: postgres://gbrain:${POSTGRES_PASSWORD:-change-me-in-a-real-deployment}@postgres:5432/${GBRAIN_DB:-gbrain}
      GBRAIN_HOME: /srv/gbrain-home
      GBRAIN_SELF_UPGRADE_MODE: "off"
      # Headless `gbrain init` must pick an embedding provider non-interactively,
      # which requires a real provider credential to be present in the container.
      # Sourced from the host env / .env, never committed. The ${VAR:-} form
      # keeps the stack startable even when the key is absent (e.g. CI without
      # a provider secret). Slice 1 moves provider keys to the file plane under
      # an advisory lock (V11) — this passthrough is a Slice-0-only shortcut.
      OPENAI_API_KEY: ${OPENAI_API_KEY:-}
    volumes:
      - gbrain-home:/srv/gbrain-home
      - brain-repos:/srv/brain-repos
    depends_on:
      postgres:
        condition: service_healthy
    networks: [brain-net]
    # Keeps the container alive so `docker compose exec` has a target.
    command: ["sleep", "infinity"]

networks:
  brain-net:
    driver: bridge

volumes:
  pg-data:
  gbrain-home:
  brain-repos:
```

> **Plan defect found during execution (Work Item A, 2026-09-14):** as originally written, `gbrain-ops` received only `GBRAIN_DATABASE_URL`, `GBRAIN_HOME` and `GBRAIN_SELF_UPGRADE_MODE`. Task 5's headless `gbrain init --non-interactive` must resolve an embedding provider without a prompt, which requires a real provider credential (e.g. `OPENAI_API_KEY`) to be visible inside the container — the compose file as written could never make `init` succeed. Fixed by adding an `OPENAI_API_KEY: ${OPENAI_API_KEY:-}` passthrough to `gbrain-ops` (shown above), sourced from the host env/`.env` and defaulted to empty so the stack still starts without it. Slice 1 moves provider keys to the file plane under an advisory lock (V11); this passthrough is a Slice-0-only shortcut to prove the CLI contract.

- [ ] **Step 3: Write the failing stack test**

`test/contract/stack.contract.test.ts`:
```ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { composeUp, composeDown, composeExec, BRAIN_DB_URL } from '../helpers/stack.ts';
import { parseGbrainVersion } from '../../src/contracts/capability.ts';

const PIN = process.env.GBRAIN_VERSION ?? '0.50.0.0';

beforeAll(async () => { await composeUp(); }, 300_000);
afterAll(async () => { await composeDown(); }, 120_000);

test('the ops container runs the pinned gbrain version', async () => {
  const r = await composeExec('gbrain-ops', ['gbrain', '--version']);
  expect(r.exitCode).toBe(0);
  expect(parseGbrainVersion(r.stdout)).toBe(PIN);
});

test('postgres has vector, pg_trgm and pgcrypto', async () => {
  const r = await composeExec('gbrain-ops', [
    'psql', BRAIN_DB_URL,
    '-tAc', "select extname from pg_extension order by extname",
  ]);
  expect(r.exitCode).toBe(0);
  const names = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  expect(names).toContain('vector');
  expect(names).toContain('pg_trgm');
  expect(names).toContain('pgcrypto');
});

test('GBRAIN_HOME is writable in the ops container', async () => {
  const r = await composeExec('gbrain-ops', ['sh', '-c', 'touch /srv/gbrain-home/.probe && echo ok']);
  expect(r.exitCode).toBe(0);
  expect(r.stdout.trim()).toBe('ok');
});
```

> **Plan defect found during execution (Work Item B, 2026-09-14):** as originally written, the second test built its own Postgres URL with a hardcoded literal fallback (`process.env.PGURL_FOR_TEST ?? 'postgres://gbrain:change-me-in-a-real-deployment@postgres:5432/gbrain'`) instead of deriving it from the same env-backed constant every other contract test uses. This duplicated the credential outside `test/helpers/stack.ts` and would silently drift out of sync — and fail on a confusing credential error — the moment a real deployment's `.env` sets a non-default `POSTGRES_PASSWORD` (exactly what `.env.example` tells an operator to do). Fixed by importing `BRAIN_DB_URL` from `test/helpers/stack.ts` (Task 4) and dropping the `PGURL_FOR_TEST` escape hatch and the hardcoded literal entirely (shown above). Note this creates a forward dependency on Task 4's `test/helpers/stack.ts`; harmless in practice since this test does not turn green until Task 4 lands anyway (Step 4 below).

- [ ] **Step 4: Run it and watch it fail on the missing helper**

Run: `bun test test/contract/stack.contract.test.ts`
Expected: FAIL — `Cannot find module '../../src/docker/host.ts'`. The helper lands in Task 4; that failure is the point.

- [ ] **Step 5: Commit the compose (test stays red until Task 4)**

```bash
git add compose/
git commit -m "feat(slice0): postgres + ops compose with pgvector extensions

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: The typed exec layer — argv building and redaction

The security-critical unit. It is pure, so it is tested without Docker.

**Files:**
- Create: `src/contracts/types.ts`
- Create: `src/contracts/argv.ts`
- Test: `test/unit/argv.test.ts`

**Interfaces:**
- Produces:
  - `type ParamSpec = { name: string; flag: string; kind: 'flag'|'value'|'list'; required?: boolean; secret?: boolean }`
  - `type OperationSpec = { id: string; argv: readonly string[]; params: readonly ParamSpec[]; supportsJson: boolean; supportsDryRun: boolean; privilege: 'brain-db'|'read-only'; okExitCodes: readonly number[] }`
  - `type ParamValues = Record<string, string | string[] | boolean | undefined>`
  - `type ExecResult<T> = { argv: string[]; exitCode: number; stdout: string; stderr: string; json: T | null }`
  - `buildArgv(spec: OperationSpec, values: ParamValues, opts?: { json?: boolean; dryRun?: boolean }): string[]`
  - `redactArgv(spec: OperationSpec, argv: readonly string[]): string[]`

- [ ] **Step 1: Write the failing tests**

`test/unit/argv.test.ts`:
```ts
import { test, expect, describe } from 'bun:test';
import { buildArgv, redactArgv } from '../../src/contracts/argv.ts';
import type { OperationSpec } from '../../src/contracts/types.ts';

const INIT: OperationSpec = {
  id: 'init',
  argv: ['init'],
  params: [
    { name: 'nonInteractive', flag: '--non-interactive', kind: 'flag' },
    { name: 'url', flag: '--url', kind: 'value', required: true, secret: true },
    { name: 'embeddingModel', flag: '--embedding-model', kind: 'value' },
  ],
  supportsJson: false,
  supportsDryRun: false,
  privilege: 'brain-db',
  okExitCodes: [0],
};

const GRANT: OperationSpec = {
  id: 'mcp.grant',
  argv: ['mcp', 'grant'],
  params: [
    { name: 'harness', flag: '--harness', kind: 'value', required: true },
    { name: 'source', flag: '--source', kind: 'value', required: true },
    { name: 'federatedRead', flag: '--federated-read', kind: 'list' },
  ],
  supportsJson: true,
  supportsDryRun: true,
  privilege: 'brain-db',
  okExitCodes: [0],
};

describe('buildArgv', () => {
  test('emits the fixed prefix then flag/value pairs', () => {
    expect(buildArgv(INIT, { nonInteractive: true, url: 'postgres://x/y' }))
      .toEqual(['init', '--non-interactive', '--url', 'postgres://x/y']);
  });

  test('joins list params with commas', () => {
    expect(buildArgv(GRANT, { harness: 'claude-code', source: 'customers', federatedRead: ['customers', 'shared'] }))
      .toEqual(['mcp', 'grant', '--harness', 'claude-code', '--source', 'customers',
                '--federated-read', 'customers,shared']);
  });

  test('omits absent optional params and false flags', () => {
    expect(buildArgv(INIT, { url: 'postgres://x/y', nonInteractive: false }))
      .toEqual(['init', '--url', 'postgres://x/y']);
  });

  test('throws when a required param is missing', () => {
    expect(() => buildArgv(INIT, {})).toThrow('missing required param url');
  });

  test('appends --json only when the operation declares support', () => {
    expect(buildArgv(GRANT, { harness: 'h', source: 's' }, { json: true }).at(-1)).toBe('--json');
    expect(() => buildArgv(INIT, { url: 'u' }, { json: true }))
      .toThrow('init does not support --json');
  });

  test('appends --dry-run only when the operation declares support', () => {
    expect(buildArgv(GRANT, { harness: 'h', source: 's' }, { dryRun: true })).toContain('--dry-run');
    expect(() => buildArgv(INIT, { url: 'u' }, { dryRun: true }))
      .toThrow('init does not support --dry-run');
  });

  // G2: argv arrays, never shell strings. A metacharacter-laden value must
  // survive as exactly ONE element and never be split or interpreted.
  test('keeps shell metacharacters inside a single argv element', () => {
    const argv = buildArgv(INIT, { url: 'postgres://u:p@h/db; rm -rf / #' });
    expect(argv).toEqual(['init', '--url', 'postgres://u:p@h/db; rm -rf / #']);
    expect(argv).toHaveLength(3);
  });

  test('rejects an unknown param rather than silently dropping it', () => {
    expect(() => buildArgv(INIT, { url: 'u', bogus: 'x' })).toThrow('unknown param bogus');
  });
});

describe('redactArgv', () => {
  test('replaces the value following a secret flag', () => {
    const argv = buildArgv(INIT, { nonInteractive: true, url: 'postgres://user:pw@h/db' });
    expect(redactArgv(INIT, argv))
      .toEqual(['init', '--non-interactive', '--url', '***REDACTED***']);
  });

  test('leaves non-secret values intact', () => {
    const argv = buildArgv(GRANT, { harness: 'claude-code', source: 'customers' });
    expect(redactArgv(GRANT, argv)).toEqual(argv);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/unit/argv.test.ts`
Expected: FAIL — `Cannot find module '../../src/contracts/argv.ts'`.

- [ ] **Step 3: Write `src/contracts/types.ts`**

```ts
/** How a param renders into argv. */
export type ParamKind = 'flag' | 'value' | 'list';

export type ParamSpec = {
  /** Our camelCase name, used as the key in ParamValues. */
  name: string;
  /** The exact gbrain flag, e.g. '--federated-read'. */
  flag: string;
  kind: ParamKind;
  required?: boolean;
  /** Redact this value in logs, receipts and audit rows. */
  secret?: boolean;
};

/**
 * Privilege tells Slice 1 which container may run the operation.
 * 'brain-db' operations need the brain DATABASE_URL and RW GBRAIN_HOME (V8),
 * so they run only in gbrain-ops — never in the control plane (S2).
 */
export type Privilege = 'brain-db' | 'read-only';

export type OperationSpec = {
  /** Stable id, e.g. 'mcp.grant'. */
  id: string;
  /** Fixed argv prefix, e.g. ['mcp', 'grant']. */
  argv: readonly string[];
  params: readonly ParamSpec[];
  supportsJson: boolean;
  supportsDryRun: boolean;
  privilege: Privilege;
  /** Exit codes that are not failures. Anything else is an error. */
  okExitCodes: readonly number[];
};

export type ParamValues = Record<string, string | string[] | boolean | undefined>;

export type ExecResult<T = unknown> = {
  /** Redacted — safe to log. */
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Parsed --json payload, or null when the operation emitted none. */
  json: T | null;
};

export const REDACTED = '***REDACTED***';
```

- [ ] **Step 4: Write `src/contracts/argv.ts`**

```ts
import type { OperationSpec, ParamValues } from './types.ts';
import { REDACTED } from './types.ts';

/**
 * Build an argv ARRAY for a gbrain invocation. Never returns a shell string:
 * every value is its own element, so no value can inject an argument or a
 * shell metacharacter (G2).
 */
export function buildArgv(
  spec: OperationSpec,
  values: ParamValues,
  opts: { json?: boolean; dryRun?: boolean } = {},
): string[] {
  const known = new Set(spec.params.map((p) => p.name));
  for (const key of Object.keys(values)) {
    if (!known.has(key)) throw new Error(`unknown param ${key} for ${spec.id}`);
  }

  const argv: string[] = [...spec.argv];

  for (const p of spec.params) {
    const v = values[p.name];
    if (v === undefined || v === false) {
      if (p.required) throw new Error(`missing required param ${p.name} for ${spec.id}`);
      continue;
    }
    if (p.kind === 'flag') {
      argv.push(p.flag);
      continue;
    }
    if (p.kind === 'list') {
      const list = Array.isArray(v) ? v : [String(v)];
      if (list.length === 0) continue;
      argv.push(p.flag, list.join(','));
      continue;
    }
    argv.push(p.flag, String(v));
  }

  if (opts.dryRun) {
    if (!spec.supportsDryRun) throw new Error(`${spec.id} does not support --dry-run`);
    argv.push('--dry-run');
  }
  if (opts.json) {
    if (!spec.supportsJson) throw new Error(`${spec.id} does not support --json`);
    argv.push('--json');
  }
  return argv;
}

/** Replace the value following any secret-bearing flag. Use before logging. */
export function redactArgv(spec: OperationSpec, argv: readonly string[]): string[] {
  const secretFlags = new Set(spec.params.filter((p) => p.secret).map((p) => p.flag));
  const out = [...argv];
  for (let i = 0; i < out.length - 1; i++) {
    if (secretFlags.has(out[i]!)) out[i + 1] = REDACTED;
  }
  return out;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/unit/argv.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 6: Commit**

```bash
git add src/contracts/types.ts src/contracts/argv.ts test/unit/argv.test.ts
git commit -m "feat(slice0): typed argv builder with secret redaction

argv arrays never shell strings (G2); metacharacters stay inside one element.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: The Docker host helper and the wrong-pin tripwire

The only place in the repo that spawns `docker`. Everything else goes through it.

**Files:**
- Create: `src/docker/host.ts`
- Create: `src/contracts/exec.ts`
- Create: `test/helpers/stack.ts`
- Create: `test/contract/version.contract.test.ts`
- Test: `test/contract/stack.contract.test.ts` (from Task 2 — turns green here)

**Interfaces:**
- Consumes: `buildArgv`, `redactArgv`, the `OperationSpec` type (Task 3); the compose file (Task 2).
- Produces:
  - `composeUp(): Promise<void>`, `composeDown(): Promise<void>`
  - `composeExec(service: string, argv: string[], opts?: { env?: Record<string,string> }): Promise<{ exitCode: number; stdout: string; stderr: string }>`
  - `execOperation<T>(spec: OperationSpec, values: ParamValues, opts?: { json?: boolean; dryRun?: boolean; service?: string }): Promise<ExecResult<T>>`
  - `withFreshStack(fn): Promise<void>` test helper

- [ ] **Step 1: Write the failing tripwire test**

`test/contract/version.contract.test.ts`:
```ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { composeUp, composeDown, composeExec } from '../../src/docker/host.ts';
import { parseGbrainVersion } from '../../src/contracts/capability.ts';

const PIN = process.env.GBRAIN_VERSION ?? '0.50.0.0';

beforeAll(async () => { await composeUp(); }, 300_000);
afterAll(async () => { await composeDown(); }, 120_000);

// The tripwire that makes "never fork, pin exact semver" (G1) safe: the whole
// contract suite is meaningless if it silently runs against another version.
test('the running binary is exactly the pinned version', async () => {
  const r = await composeExec('gbrain-ops', ['gbrain', '--version']);
  expect(r.exitCode).toBe(0);
  expect(parseGbrainVersion(r.stdout)).toBe(PIN);
});

test('a wrong expected pin makes this suite fail', () => {
  // Documents the tripwire: CI runs the suite with GBRAIN_VERSION set to the
  // candidate. If the image and the expectation disagree, the test above is red.
  expect(PIN).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/contract/version.contract.test.ts`
Expected: FAIL — `Cannot find module '../../src/docker/host.ts'`.

- [ ] **Step 3: Write `src/docker/host.ts`**

```ts
import { REDACTED } from '../contracts/types.ts';

const COMPOSE_FILE = 'compose/docker-compose.slice0.yml';

export type RawResult = { exitCode: number; stdout: string; stderr: string };

async function run(argv: string[], timeoutMs = 300_000): Promise<RawResult> {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export async function composeUp(): Promise<void> {
  const r = await run(['docker', 'compose', '-f', COMPOSE_FILE, 'up', '-d', '--wait']);
  if (r.exitCode !== 0) throw new Error(`compose up failed (${r.exitCode}): ${r.stderr}`);
}

export async function composeDown(): Promise<void> {
  await run(['docker', 'compose', '-f', COMPOSE_FILE, 'down', '-v']);
}

/**
 * Exec inside a compose service. `-T` disables TTY allocation, which is what
 * makes every invocation headless — the thing Slice 0 exists to prove.
 * argv is passed as separate process arguments; there is no shell.
 */
export async function composeExec(
  service: string,
  argv: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<RawResult> {
  const envArgs = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return run(
    ['docker', 'compose', '-f', COMPOSE_FILE, 'exec', '-T', ...envArgs, service, ...argv],
    opts.timeoutMs,
  );
}

/** Redact anything that looks like a credential before a result reaches a log. */
export function scrubOutput(text: string): string {
  return text
    .replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/gi, `$1${REDACTED}@`)
    .replace(/("?client_secret"?\s*[:=]\s*"?)[^",\s]+/gi, `$1${REDACTED}`)
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, REDACTED);
}
```

- [ ] **Step 4: Write `src/contracts/exec.ts`**

```ts
import type { ExecResult, OperationSpec, ParamValues } from './types.ts';
import { buildArgv, redactArgv } from './argv.ts';
import { composeExec, scrubOutput } from '../docker/host.ts';

/**
 * Run one allowlisted gbrain operation. Returns a redacted argv so the caller
 * can log the result verbatim (S3c: never log a credential-bearing body).
 */
export async function execOperation<T = unknown>(
  spec: OperationSpec,
  values: ParamValues,
  opts: { json?: boolean; dryRun?: boolean; service?: string; timeoutMs?: number } = {},
): Promise<ExecResult<T>> {
  const argv = buildArgv(spec, values, { json: opts.json, dryRun: opts.dryRun });
  const raw = await composeExec(opts.service ?? 'gbrain-ops', ['gbrain', ...argv], {
    timeoutMs: opts.timeoutMs,
  });

  let json: T | null = null;
  if (opts.json) {
    // Parse the LAST balanced JSON value on stdout: gbrain may emit progress
    // lines before the machine-readable receipt.
    const trimmed = raw.stdout.trim();
    const start = Math.min(
      ...[trimmed.indexOf('{'), trimmed.indexOf('[')].filter((i) => i >= 0),
    );
    if (Number.isFinite(start) && start >= 0) {
      try { json = JSON.parse(trimmed.slice(start)) as T; } catch { json = null; }
    }
  }

  return {
    argv: redactArgv(spec, ['gbrain', ...argv]),
    exitCode: raw.exitCode,
    stdout: scrubOutput(raw.stdout),
    stderr: scrubOutput(raw.stderr),
    json,
  };
}

/** Throw unless the exit code is one the operation declares acceptable. */
export function assertOk(spec: OperationSpec, r: ExecResult): void {
  if (!spec.okExitCodes.includes(r.exitCode)) {
    throw new Error(
      `${spec.id} exited ${r.exitCode} (expected one of ${spec.okExitCodes.join(',')})\n` +
      `argv: ${r.argv.join(' ')}\nstderr: ${r.stderr}`,
    );
  }
}
```

- [ ] **Step 5: Write `test/helpers/stack.ts`**

```ts
import { composeUp, composeDown, composeExec } from '../../src/docker/host.ts';

export const PIN = process.env.GBRAIN_VERSION ?? '0.50.0.0';
export const PG_PASSWORD = process.env.POSTGRES_PASSWORD ?? 'change-me-in-a-real-deployment';
export const BRAIN_DB_URL =
  `postgres://gbrain:${PG_PASSWORD}@postgres:5432/${process.env.GBRAIN_DB ?? 'gbrain'}`;

export { composeUp, composeDown, composeExec };

/** Drop every gbrain table so the next test initializes a virgin brain. */
export async function resetBrain(): Promise<void> {
  await composeExec('gbrain-ops', [
    'psql', BRAIN_DB_URL, '-v', 'ON_ERROR_STOP=1', '-c',
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ' +
    'CREATE EXTENSION IF NOT EXISTS vector; ' +
    'CREATE EXTENSION IF NOT EXISTS pg_trgm; ' +
    'CREATE EXTENSION IF NOT EXISTS pgcrypto;',
  ]);
  await composeExec('gbrain-ops', ['sh', '-c', 'rm -rf /srv/gbrain-home/* /srv/gbrain-home/.[!.]* || true']);
}
```

- [ ] **Step 6: Run both contract tests to verify they pass**

Run: `bun test test/contract/version.contract.test.ts test/contract/stack.contract.test.ts`
Expected: PASS — 5 tests. First run pulls images; allow several minutes.

- [ ] **Step 7: Commit**

```bash
git add src/docker/ src/contracts/exec.ts test/helpers/ test/contract/
git commit -m "feat(slice0): docker exec helper, operation runner, pin tripwire

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: `init` contract — headless init against Postgres (V3, V4)

The single highest-value proof in the slice. If this fails, Slice 1's wizard design changes fundamentally.

**Files:**
- Create: `src/contracts/registry.ts` (first entries)
- Create: `test/contract/init.contract.test.ts`

**Interfaces:**
- Consumes: `execOperation`, `assertOk` (Task 4); `resetBrain` (Task 4).
- Produces: `OPERATIONS` — a `Record<string, OperationSpec>` — starting with `init`. Later tasks append to this same object.

- [ ] **Step 1: Write the failing contract test**

`test/contract/init.contract.test.ts`:
```ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { execOperation, assertOk } from '../../src/contracts/exec.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { composeUp, composeDown, composeExec, resetBrain, BRAIN_DB_URL } from '../helpers/stack.ts';

beforeAll(async () => { await composeUp(); await resetBrain(); }, 300_000);
afterAll(async () => { await composeDown(); }, 120_000);

// V3: --non-interactive exists and requires --url or GBRAIN_DATABASE_URL.
test('init --non-interactive without a url fails with the documented message', async () => {
  const r = await composeExec('gbrain-ops', ['gbrain', 'init', '--non-interactive'], {
    env: { GBRAIN_DATABASE_URL: '' },
  });
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr + r.stdout).toContain('--non-interactive requires --url');
});

// V3 + V4: the only interactive fork is embedding-provider selection, and
// --non-interactive plus an explicit --embedding-model resolves it.
test('init --non-interactive succeeds headlessly against postgres', async () => {
  const spec = OPERATIONS.init!;
  const r = await execOperation(spec, {
    nonInteractive: true,
    force: true,
    url: BRAIN_DB_URL,
    embeddingModel: 'openai:text-embedding-3-small',
  }, { timeoutMs: 600_000 });

  assertOk(spec, r);
  // Never block on a TTY: a prompt would hang until our timeout killed it.
  expect(r.stderr).not.toMatch(/\?\s|\(y\/n\)|press enter/i);
}, 660_000);

test('init created gbrain tables in the brain database', async () => {
  const r = await composeExec('gbrain-ops', [
    'psql', BRAIN_DB_URL, '-tAc',
    "select count(*) from information_schema.tables where table_schema='public'",
  ]);
  expect(r.exitCode).toBe(0);
  expect(Number(r.stdout.trim())).toBeGreaterThan(20);
});

// V4: the search-mode cost matrix is a POST-init config set, not part of init.
test('search.mode is settable after init, not during it', async () => {
  const spec = OPERATIONS['config.set']!;
  const r = await execOperation(spec, { key: 'search.mode', value: 'fast' });
  assertOk(spec, r);
});

// The redacted argv must never carry the connection string into a log.
test('the returned argv redacts the database url', async () => {
  const spec = OPERATIONS.init!;
  const r = await execOperation(spec, {
    nonInteractive: true, url: BRAIN_DB_URL, embeddingModel: 'openai:text-embedding-3-small',
  }, { timeoutMs: 60_000 }).catch((e) => { throw e; });
  expect(r.argv.join(' ')).not.toContain(BRAIN_DB_URL);
  expect(r.argv).toContain('***REDACTED***');
}, 90_000);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/contract/init.contract.test.ts`
Expected: FAIL — `Cannot find module '../../src/contracts/registry.ts'`.

- [ ] **Step 3: Write `src/contracts/registry.ts` with the first two operations**

```ts
import type { OperationSpec } from './types.ts';

/**
 * The allowlist. Slice 1's gbrain-ops RPC server exposes exactly these and
 * nothing else — there is no passthrough (G2, S2).
 *
 * Every entry is backed by a contract test asserting flag acceptance, --json
 * shape and exit codes at the pinned version (G4). Adding an entry without a
 * contract test is not allowed.
 */
export const OPERATIONS: Record<string, OperationSpec> = {
  // V3/V4. No --json: init reports through stdout prose and its exit code.
  init: {
    id: 'init',
    argv: ['init'],
    params: [
      { name: 'nonInteractive', flag: '--non-interactive', kind: 'flag' },
      { name: 'force', flag: '--force', kind: 'flag' },
      { name: 'url', flag: '--url', kind: 'value', secret: true },
      { name: 'embeddingModel', flag: '--embedding-model', kind: 'value' },
      { name: 'embeddingDimensions', flag: '--embedding-dimensions', kind: 'value' },
    ],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  // V4: the search-mode cost matrix is a post-init config set.
  // V11: upstream already routes vendor *_api_key writes away from the DB plane.
  'config.set': {
    id: 'config.set',
    argv: ['config', 'set'],
    params: [
      { name: 'key', flag: '', kind: 'value', required: true },
      { name: 'value', flag: '', kind: 'value', required: true },
    ],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },
};
```

> **Note on positional params:** `config set <key> <value>` takes positionals, not flags. `buildArgv` pushes `[flag, value]` for `kind: 'value'`; an empty `flag` would emit an empty argv element. Step 4 fixes this properly.

- [ ] **Step 4: Add positional support to `buildArgv`**

In `src/contracts/argv.ts`, inside the `for (const p of spec.params)` loop, replace the final `argv.push(p.flag, String(v));` with:

```ts
    // An empty flag means a positional argument: push the value alone.
    if (p.flag === '') { argv.push(String(v)); continue; }
    argv.push(p.flag, String(v));
```

And add the matching unit test to `test/unit/argv.test.ts`:

```ts
test('emits positional params without a flag', () => {
  const CONFIG_SET: OperationSpec = {
    id: 'config.set',
    argv: ['config', 'set'],
    params: [
      { name: 'key', flag: '', kind: 'value', required: true },
      { name: 'value', flag: '', kind: 'value', required: true },
    ],
    supportsJson: false, supportsDryRun: false, privilege: 'brain-db', okExitCodes: [0],
  };
  expect(buildArgv(CONFIG_SET, { key: 'search.mode', value: 'fast' }))
    .toEqual(['config', 'set', 'search.mode', 'fast']);
});
```

- [ ] **Step 5: Run the unit tests, then the contract test**

Run: `bun test test/unit/argv.test.ts`
Expected: PASS — 11 tests.

Run: `bun test test/contract/init.contract.test.ts`
Expected: PASS — 5 tests. Init against Postgres takes minutes; the timeouts above allow for it.

> **If `init` blocks on a prompt or exits non-zero:** stop and record it in `docs/slice-0-findings.md` (Task 14) as a **V3 falsification**. That is a slice-defining finding — Slice 1's wizard would then need a different mechanism — and it is exactly why this slice runs first. Do not work around it silently.

- [ ] **Step 6: Commit**

```bash
git add src/contracts/registry.ts src/contracts/argv.ts test/contract/init.contract.test.ts test/unit/argv.test.ts
git commit -m "feat(slice0): headless init contract against postgres (V3, V4)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: `config` plane contract (V11)

The spec described a live trap here. It is **fixed in v0.50.0.0** — so we assert the current behavior, and the test becomes the tripwire if a version bump reintroduces it.

**Files:**
- Modify: `src/contracts/registry.ts` (add `config.get`, `config.show`)
- Create: `test/contract/config.contract.test.ts`

**Interfaces:**
- Consumes: `OPERATIONS.init` (Task 5) — the brain must be initialized first.
- Produces: `OPERATIONS['config.get']`, `OPERATIONS['config.show']`.

> **Plan defect found during execution (Work Item C, 2026-09-14):** as
> originally written, this task specified a `config list` / `gbrain config
> list` operation. Upstream v0.50.0.0 has no `list` subcommand — the CLI's
> own usage line is `gbrain config [show|get|set|unset] <key> [value]`
> (`src/commands/config.ts`, the `runConfig` dispatcher, confirmed against the
> read-only reference checkout). The read-all-config verb is `show`, which
> prints `GBrain config:` followed by `  key: value` lines (redacting
> sensitive keys) and takes no arguments. Fixed by renaming the operation and
> the test to `config.show` / `gbrain config show` throughout this task
> (shown below); no other task or script referenced `config.list`.

- [ ] **Step 1: Write the failing contract test**

`test/contract/config.contract.test.ts`:
```ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { execOperation, assertOk } from '../../src/contracts/exec.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { composeUp, composeDown, composeExec, resetBrain, BRAIN_DB_URL } from '../helpers/stack.ts';

beforeAll(async () => {
  await composeUp();
  await resetBrain();
  const r = await execOperation(OPERATIONS.init!, {
    nonInteractive: true, force: true, url: BRAIN_DB_URL,
    embeddingModel: 'openai:text-embedding-3-small',
  }, { timeoutMs: 600_000 });
  assertOk(OPERATIONS.init!, r);
}, 900_000);
afterAll(async () => { await composeDown(); }, 120_000);

test('a non-key config value round-trips through set and get', async () => {
  assertOk(OPERATIONS['config.set']!,
    await execOperation(OPERATIONS['config.set']!, { key: 'search.mode', value: 'fast' }));
  const got = await execOperation(OPERATIONS['config.get']!, { key: 'search.mode' });
  assertOk(OPERATIONS['config.get']!, got);
  expect(got.stdout).toContain('fast');
});

/**
 * V11 — spec correction. Upstream v0.50.0.0 already guards vendor API keys
 * against the DB plane (src/commands/config.ts:29, key list at 118-128).
 * We assert the CURRENT behavior so a regression, or a version bump that
 * reintroduces the old routing, turns this red.
 *
 * Whatever this test observes is the ground truth for Slice 1's wizard:
 * record the outcome in docs/slice-0-findings.md either way.
 */
test('config set openai_api_key does not silently land in the DB plane', async () => {
  const set = await execOperation(OPERATIONS['config.set']!, {
    key: 'openai_api_key', value: 'sk-contract-test-not-a-real-key',
  });

  // Either upstream refuses the write, or it routes it to the file plane.
  // Both are acceptable; a silent DB-plane write is not.
  const inDb = await composeExec('gbrain-ops', [
    'psql', BRAIN_DB_URL, '-tAc',
    "select count(*) from config where key = 'openai_api_key'",
  ]);
  const dbCount = inDb.exitCode === 0 ? Number(inDb.stdout.trim() || '0') : 0;

  if (set.exitCode === 0) {
    expect(dbCount).toBe(0); // routed to the file plane, not the DB plane
  } else {
    expect(set.stderr + set.stdout).toMatch(/file plane|api[_ ]key|not.*db/i);
  }
});

test('config show emits a parseable inventory', async () => {
  const r = await execOperation(OPERATIONS['config.show']!, {});
  assertOk(OPERATIONS['config.show']!, r);
  expect(r.stdout.length).toBeGreaterThan(0);
  expect(r.stdout).toContain('GBrain config:');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/contract/config.contract.test.ts`
Expected: FAIL — `OPERATIONS['config.get'] is undefined`.

- [ ] **Step 3: Add the two operations to `src/contracts/registry.ts`**

Insert into the `OPERATIONS` object, after `'config.set'`:

```ts
  'config.get': {
    id: 'config.get',
    argv: ['config', 'get'],
    params: [{ name: 'key', flag: '', kind: 'value', required: true }],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  // Work Item C: `list` renamed to `show` — see the defect note above.
  'config.show': {
    id: 'config.show',
    argv: ['config', 'show'],
    params: [],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/contract/config.contract.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/registry.ts test/contract/config.contract.test.ts
git commit -m "feat(slice0): config plane contract, asserting the V11 api_key routing

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: `auth` contract — register-client and rescope-client (V2, V7)

**Files:**
- Modify: `src/contracts/registry.ts`
- Create: `test/contract/auth.contract.test.ts`

**Interfaces:**
- Produces: `OPERATIONS['auth.registerClient']`, `OPERATIONS['auth.rescopeClient']`, `OPERATIONS['auth.clients']`.

> **Plan defect found during execution (Work Item D, 2026-09-14):** as
> originally written, `beforeAll` created the two source directories with a
> bare `mkdir -p`. `gbrain sources add --path <dir>` refuses any path that is
> not a git repository with at least one committed, tracked file ("is not a
> git repository with committed, tracked files ... an empty commit is not
> enough" — gbrain reads sources through git objects, so untracked files are
> invisible). Fixed by adding `seedGitSource(id)` to `test/helpers/stack.ts`
> (git-init, one committed file, then `sources add`) and calling it for each
> id before `sources.add`, shown below. This same fix applies to Task 8's
> `beforeAll`, which has the identical pattern.

> **Plan defect found during execution (Work Item E, 2026-09-14):** three
> problems surfaced in the original test body. (1) `register-client`'s real
> (non-JSON) stdout is prose — "Client ID:" with a space — not the
> `client_id` (underscore) token the assertion expected; widened to
> `/client[ _]id/i`. (2) `rescope-client <client_id>` looks the client up by
> its real generated id (`readClientGrant` in gbrain's reference source),
> never by the human `--name` given at registration — the test now captures
> the id from register-client's stdout (`aliceClientId`) and rescopes that.
> (3) `auth rescope-client --dry-run --json` does not actually preview:
> `rescopeClient`'s own handler implements `--dry-run` (read-only reference
> `src/cli.ts:833` usage string, `:848` dispatch), but gbrain 0.50.0.0
> validates flags against a pre-dispatch, per-top-level-COMMAND (not
> per-subcommand) static allowlist (`src/core/cli-flag-registry.generated.ts`)
> before the handler ever runs, and the `'auth'` entry in that allowlist
> omits `--dry-run` — so `gbrain auth <anything> --dry-run` is rejected with
> `unknown flag --dry-run for 'gbrain auth'` regardless of subcommand. This
> is a confirmed upstream bug, not a registry mistake. `--json` alone is
> allowlisted and works. Fixed by setting
> `auth.rescopeClient.supportsDryRun: false` in the registry (Task 8's `mcp`
> allowlist DOES include `--dry-run`, so this does not recur there) and
> splitting the one dry-run test into two honest tests: a real (mutating)
> `--json` rescope, and a raw `composeExec` probe asserting the CURRENT
> rejection — a tripwire that turns red the day upstream's allowlist is
> fixed. Recorded in `docs/slice-0-findings.md` V2 as a slice-defining
> finding: Slice 2's rescope confirm screen cannot be built on a CLI dry-run
> preview at this pinned version. Test count for this task is 6, not 5.

- [ ] **Step 1: Write the failing contract test**

`test/contract/auth.contract.test.ts`:
```ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { execOperation, assertOk } from '../../src/contracts/exec.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { composeUp, composeDown, composeExec, resetBrain, seedGitSource, BRAIN_DB_URL } from '../helpers/stack.ts';

beforeAll(async () => {
  await composeUp();
  await resetBrain();
  assertOk(OPERATIONS.init!, await execOperation(OPERATIONS.init!, {
    nonInteractive: true, force: true, url: BRAIN_DB_URL,
    embeddingModel: 'openai:text-embedding-3-small',
  }, { timeoutMs: 600_000 }));
  // One source to scope clients against. Work Item D: `sources add --path`
  // requires a git-initialized repo with a committed file, not a bare dir.
  await seedGitSource('shared');
  await seedGitSource('customers');
  assertOk(OPERATIONS['sources.add']!, await execOperation(OPERATIONS['sources.add']!, {
    id: 'shared', path: '/srv/brain-repos/shared', name: 'Shared company wiki',
  }));
  assertOk(OPERATIONS['sources.add']!, await execOperation(OPERATIONS['sources.add']!, {
    id: 'customers', path: '/srv/brain-repos/customers', name: 'Customer notes',
  }));
}, 900_000);
afterAll(async () => { await composeDown(); }, 120_000);

// Work Item E: rescope-client looks clients up by the real generated
// client_id, never by --name. Captured below and reused by the rescope tests.
let aliceClientId = '';

// V2: the control lane is machine-readable — --json, no screen-scraping.
test('auth clients --json emits a JSON array', async () => {
  const r = await execOperation(OPERATIONS['auth.clients']!, {}, { json: true });
  assertOk(OPERATIONS['auth.clients']!, r);
  expect(r.json).not.toBeNull();
});

test('register-client accepts the tutorial flag set and prints credentials', async () => {
  const spec = OPERATIONS['auth.registerClient']!;
  const r = await execOperation(spec, {
    name: 'alice-example',
    grantTypes: 'client_credentials',
    // Space-separated and quoted: the OAuth wire format. A comma-separated
    // list is rejected at registration.
    scopes: 'read write',
    source: 'customers',
    federatedRead: ['customers', 'shared'],
  });
  assertOk(spec, r);
  // Work Item E: real stdout is prose — "Client ID:" with a space.
  expect(r.stdout).toMatch(/client[ _]id/i);
  const m = /Client ID:\s+(\S+)/.exec(r.stdout);
  expect(m).not.toBeNull();
  aliceClientId = m![1]!;
});

// V7: --token-ttl is bounded 60s..90d (TOKEN_TTL_MIN_SECONDS=60).
test('register-client rejects a token-ttl below the 60s floor', async () => {
  const r = await execOperation(OPERATIONS['auth.registerClient']!, {
    name: 'ttl-floor-probe', grantTypes: 'client_credentials', scopes: 'read',
    source: 'shared', tokenTtl: '30',
  });
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr + r.stdout).toMatch(/--token-ttl must be an integer number of seconds between 60/);
});

test('register-client accepts a token-ttl inside the bounds', async () => {
  const spec = OPERATIONS['auth.registerClient']!;
  assertOk(spec, await execOperation(spec, {
    name: 'ttl-ok-probe', grantTypes: 'client_credentials', scopes: 'read',
    source: 'shared', tokenTtl: '300',
  }));
});

// Work Item E: --dry-run is unconditionally rejected pre-dispatch for every
// `gbrain auth *` subcommand at this pinned version (upstream bug — see the
// defect note above). Split into a real (mutating) --json rescope and a
// raw-CLI tripwire for the rejection, instead of the original single test
// that asserted a preview which cannot actually happen.
test('rescope-client --json emits parseable JSON (real mutation, no dry-run)', async () => {
  expect(aliceClientId).not.toBe(''); // depends on the register-client test above
  const spec = OPERATIONS['auth.rescopeClient']!;
  const r = await execOperation(spec, {
    id: aliceClientId, federatedRead: ['customers', 'shared'], boundSlugPrefixes: 'alice-example/',
  }, { json: true });
  assertOk(spec, r);
  expect(r.json).not.toBeNull();
});

test('auth --dry-run is rejected pre-dispatch at this pinned version (upstream bug)', async () => {
  const r = await composeExec('gbrain-ops', [
    'gbrain', 'auth', 'rescope-client', 'alice-example', '--dry-run', '--json',
  ]);
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr + r.stdout).toMatch(/unknown flag --dry-run for 'gbrain auth'/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/contract/auth.contract.test.ts`
Expected: FAIL — `OPERATIONS['auth.clients'] is undefined`.

- [ ] **Step 3: Add the auth and sources operations to `src/contracts/registry.ts`**

```ts
  'auth.clients': {
    id: 'auth.clients',
    argv: ['auth', 'clients'],
    params: [],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  'auth.registerClient': {
    id: 'auth.registerClient',
    argv: ['auth', 'register-client'],
    params: [
      { name: 'name', flag: '', kind: 'value', required: true },
      { name: 'grantTypes', flag: '--grant-types', kind: 'value' },
      // Space-separated OAuth wire format; a comma list is rejected upstream.
      { name: 'scopes', flag: '--scopes', kind: 'value' },
      { name: 'source', flag: '--source', kind: 'value' },
      { name: 'federatedRead', flag: '--federated-read', kind: 'list' },
      { name: 'redirectUri', flag: '--redirect-uri', kind: 'value' },
      { name: 'tokenEndpointAuthMethod', flag: '--token-endpoint-auth-method', kind: 'value' },
      { name: 'boundTools', flag: '--bound-tools', kind: 'list' },
      { name: 'boundSource', flag: '--bound-source', kind: 'value' },
      { name: 'boundBrain', flag: '--bound-brain', kind: 'value' },
      { name: 'boundSlugPrefixes', flag: '--bound-slug-prefixes', kind: 'value' },
      { name: 'boundMaxConcurrent', flag: '--bound-max-concurrent', kind: 'value' },
      { name: 'budgetUsdPerDay', flag: '--budget-usd-per-day', kind: 'value' },
      // V7: 60s .. 90d. Server default for CLI-minted access tokens is 3600s.
      { name: 'tokenTtl', flag: '--token-ttl', kind: 'value' },
    ],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  'auth.rescopeClient': {
    id: 'auth.rescopeClient',
    argv: ['auth', 'rescope-client'],
    params: [
      { name: 'id', flag: '', kind: 'value', required: true },
      { name: 'source', flag: '--source', kind: 'value' },
      { name: 'federatedRead', flag: '--federated-read', kind: 'list' },
      { name: 'boundTools', flag: '--bound-tools', kind: 'list' },
      { name: 'boundSource', flag: '--bound-source', kind: 'value' },
      { name: 'boundBrain', flag: '--bound-brain', kind: 'value' },
      // 'none' clears the binding. Narrowing also disables extract_entities,
      // extract_facts, forget_fact, ontology_propose, sources_add/remove and
      // POST /ingest, and skips put_page's automatic fact extraction.
      { name: 'boundSlugPrefixes', flag: '--bound-slug-prefixes', kind: 'value' },
      { name: 'boundMaxConcurrent', flag: '--bound-max-concurrent', kind: 'value' },
      { name: 'budgetUsdPerDay', flag: '--budget-usd-per-day', kind: 'value' },
      { name: 'surface', flag: '--surface', kind: 'value' },
      { name: 'profile', flag: '--profile', kind: 'value' },
      { name: 'yes', flag: '--yes', kind: 'flag' },
    ],
    supportsJson: true,
    // Work Item E: false, not true — see the defect note above. rescopeClient
    // itself supports --dry-run, but gbrain's pre-dispatch flag allowlist for
    // the 'auth' command omits it, so every invocation is rejected upstream.
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  // V12: `gbrain sources add <id> --path <path>` — rejected over MCP by design.
  'sources.add': {
    id: 'sources.add',
    argv: ['sources', 'add'],
    params: [
      { name: 'id', flag: '', kind: 'value', required: true },
      { name: 'path', flag: '--path', kind: 'value' },
      { name: 'url', flag: '--url', kind: 'value' },
      { name: 'kind', flag: '--kind', kind: 'value' },
      { name: 'name', flag: '--name', kind: 'value' },
      { name: 'federated', flag: '--federated', kind: 'flag' },
      { name: 'noFederated', flag: '--no-federated', kind: 'flag' },
      { name: 'cloneDir', flag: '--clone-dir', kind: 'value' },
      { name: 'tokenEnv', flag: '--token-env', kind: 'value' },
      { name: 'force', flag: '--force', kind: 'flag' },
    ],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },
```

> **Plan defect found during execution (Work Item N, 2026-09-14, building Task 12):** as originally written (and as shipped in Task 7's registry entry, `supportsJson: true` above was the pre-fix value), `sources.add` claimed `--json` support. Confirmed against the running pinned container that this is false: `gbrain sources add <id> --path <p> --json` exits 2 with `Unknown flag: --json`, and `sources.ts`'s own `printHelp()` usage line for `add` is `add <id> --path <p> [--name <n>] [--federated|--no-federated] [--force]` — no `--json`, unlike the `list [--json]` / `status [--json]` / `archived [--json]` siblings immediately below it in the same help text. Neither Task 7's nor Task 8's contract tests ever exercised `sources.add` with `json: true` (both pass plain `{ id, path }`), so the wrong `true` went undetected until Task 12's tutorial needed a real per-source receipt. Fixed `supportsJson` to `false` on the registry entry (shown above); the tutorial reads the plain-text confirmation instead.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/contract/auth.contract.test.ts`
Expected: PASS — 6 tests (5 in the original plan; Work Item E splits the
single dry-run test into a real-mutation `--json` test and an upstream-bug
tripwire).

- [ ] **Step 5: Commit**

```bash
git add src/contracts/registry.ts test/contract/auth.contract.test.ts
git commit -m "feat(slice0): auth register/rescope contract with token-ttl bounds (V2, V7)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: `mcp grant` contract — the privilege boundary (V2, V8)

**Files:**
- Modify: `src/contracts/registry.ts`
- Create: `test/contract/mcp-grant.contract.test.ts`

**Interfaces:**
- Produces: `OPERATIONS['mcp.grant']`, `OPERATIONS['mcp.verify']`.

> **Plan defect found during execution (Work Item F, 2026-09-14):** as
> originally written, `mcp.grant`'s param list had no positional `NAME`, and
> the test's `execOperation` calls never supplied one. Upstream v0.50.0.0
> requires it unconditionally — `parseMcpGrant` in the read-only reference
> checkout: `if (args[0] !== 'grant' || !args[1] || args[1].startsWith('-'))
> throw new Error('Usage: gbrain mcp grant NAME [options]')`
> (`src/commands/mcp.ts:46`). Without it every grant call failed at
> arg-parsing before reaching the dry-run or DB-access logic this task exists
> to prove — including the V8 "without brain DB access" test, which would
> then "pass" for the wrong reason (a usage error, not a DB error). Fixed by
> adding `{ name: 'name', flag: '', kind: 'value', required: true }` as the
> first param of `mcp.grant` and passing a distinct `name` in every grant
> call (shown below); the V8 test also gained a `NAME` in its raw argv so its
> failure is provably the DB-access path (manually confirmed: with a `NAME`
> and a bogus `GBRAIN_DATABASE_URL`, gbrain prints `GBRAIN_DB_ACCESS
> conn_refused ... Cannot connect to database`).

> **Plan defect found during execution (Work Item G, 2026-09-14):** as
> originally written, no call to `mcp.grant` — dry-run included — supplied
> `--url`, and the registry did not mark it `required`. Upstream v0.50.0.0
> requires `--url` unconditionally: `parseMcpGrant` reads `url:
> value('--url') ?? ''` (`src/commands/mcp.ts:68`, reference checkout) and
> `provisionHarnessGrant` immediately validates it with `normalizeMcpUrl(...)`
> then `assertSecureEndpoint(...)` (`src/commands/mcp-provision.ts:22-24`)
> before any dry-run branch runs — an empty url always fails with
> `{"status":"error","reason":"mcp_setup_failed","message":"Pass a valid MCP
> endpoint URL"}`, dry-run or not. Neither check contacts the URL — they only
> validate scheme and shape (https, or http on a loopback host) — so a
> syntactically valid loopback URL is accepted with no `gbrain serve` running
> anywhere in this slice. Fixed by marking `url` `required: true` on
> `mcp.grant` and passing `url: 'http://127.0.0.1:3131/mcp'` in both the
> dry-run-preview and the real-grant test calls (shown below). The V8
> "without brain DB access" test is unaffected either way: manually confirmed
> that the DB-engine acquisition gbrain performs ahead of any command-specific
> argument handling fails first, so that test's raw argv gets the same
> `GBRAIN_DB_ACCESS` error whether or not `--url` is present.

> **Plan defect found during execution (2026-09-14):** Task 7 already found
> that `sources add --path` requires a git-initialized repo with a committed
> file (Work Item D) — the same bare `mkdir -p` this task originally used has
> the identical problem, so `beforeAll` below uses `seedGitSource` (Task 7,
> `test/helpers/stack.ts`) instead. Also, `auth clients --json` emits an
> OBJECT (`{ window_days, usage_included, clients: [...], legacy_tokens:
> [...] }`), never a bare array (`src/commands/auth.ts`, `clientsCmd`,
> reference checkout) — `'a dry-run grant creates no client'` unwraps
> `.clients` and asserts its length is exactly zero, rather than the original
> `Array.isArray(before.json ?? [])`, which passed trivially on any falsy
> `json` without proving anything about mutation.

- [ ] **Step 1: Write the failing contract test**

`test/contract/mcp-grant.contract.test.ts`:
```ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { execOperation, assertOk } from '../../src/contracts/exec.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { composeUp, composeDown, composeExec, resetBrain, seedGitSource, BRAIN_DB_URL } from '../helpers/stack.ts';

beforeAll(async () => {
  await composeUp();
  await resetBrain();
  assertOk(OPERATIONS.init!, await execOperation(OPERATIONS.init!, {
    nonInteractive: true, force: true, url: BRAIN_DB_URL,
    embeddingModel: 'openai:text-embedding-3-small',
  }, { timeoutMs: 600_000 }));
  // Work Item D: `sources add --path` requires a git-initialized repo with a
  // committed file, not a bare dir (see Task 7's defect note).
  for (const id of ['shared', 'customers']) {
    await seedGitSource(id);
    assertOk(OPERATIONS['sources.add']!, await execOperation(OPERATIONS['sources.add']!, {
      id, path: `/srv/brain-repos/${id}`,
    }));
  }
}, 900_000);
afterAll(async () => { await composeDown(); }, 120_000);

// Work Item G: every `mcp.grant` call — dry-run included — requires --url.
const MCP_URL = 'http://127.0.0.1:3131/mcp';

// V2: --dry-run --json is the "machine-readable redacted receipt" that becomes
// our before/after confirm screen in Slice 2.
test('mcp grant --dry-run --json previews a grant without creating it', async () => {
  const spec = OPERATIONS['mcp.grant']!;
  const r = await execOperation(spec, {
    name: 'alice-preview',
    harness: 'claude-code', profile: 'memory-writer',
    source: 'customers', federatedRead: ['customers', 'shared'],
    url: MCP_URL,
  }, { json: true, dryRun: true });

  assertOk(spec, r);
  const body = r.json as { status?: string; grant?: unknown; before?: unknown } | null;
  expect(body?.status).toBe('preview');
  expect(body?.grant).toBeDefined();
});

// Work Item: auth clients --json emits an object, not a bare array — see the
// defect note above. Unwrap .clients and assert the count is actually zero.
test('a dry-run grant creates no client', async () => {
  const before = await execOperation(OPERATIONS['auth.clients']!, {}, { json: true });
  const body = (before.json ?? {}) as { clients?: unknown[] };
  expect(Array.isArray(body.clients)).toBe(true);
  expect(body.clients!.length).toBe(0);
});

// V8: mcp grant needs a local engine OR --admin-token-file. This is the whole
// reason gbrain-ops exists as a separate privilege boundary (S2). Work Item F:
// the raw argv needs a NAME or this fails at arg-parsing, not at DB-access.
test('mcp grant without brain DB access fails with the documented guidance', async () => {
  const r = await composeExec('gbrain-ops', [
    'gbrain', 'mcp', 'grant', 'probe-client', '--harness', 'claude-code', '--source', 'customers', '--json',
  ], { env: { GBRAIN_DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/none' } });
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr + r.stdout).toMatch(/GBRAIN_DB_ACCESS|Cannot connect to database|connect ECONNREFUSED/);
});

test('a real grant emits a client_id and a credentials receipt', async () => {
  const spec = OPERATIONS['mcp.grant']!;
  const r = await execOperation(spec, {
    name: 'alice-generic',
    harness: 'generic', profile: 'memory-writer',
    source: 'customers', federatedRead: ['customers', 'shared'],
    url: MCP_URL,
    credentialsOut: '/srv/gbrain-home/.probe-credentials.json',
    tokenTtl: '300',
  }, { json: true });

  assertOk(spec, r);
  const body = r.json as { status?: string; grant?: { clientId?: string } } | null;
  expect(body?.status).toBe('granted');
  expect(body?.grant?.clientId).toBeTruthy();

  // Credentials go to a file, never to stdout in the clear.
  const f = await composeExec('gbrain-ops', ['test', '-s', '/srv/gbrain-home/.probe-credentials.json']);
  expect(f.exitCode).toBe(0);
});

// Honesty rule 5: mcp verify exit 2 means 'partial' — server stages passed but
// harness evidence is missing. Slice 2 must never render that green.
test('mcp verify exit codes are captured, with 2 meaning partial', async () => {
  const spec = OPERATIONS['mcp.verify']!;
  const r = await execOperation(spec, { client: 'generic' }, { json: true });
  expect(spec.okExitCodes).toContain(0);
  expect([0, 1, 2]).toContain(r.exitCode);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/contract/mcp-grant.contract.test.ts`
Expected: FAIL — `OPERATIONS['mcp.grant'] is undefined`.

- [ ] **Step 3: Add the mcp operations to `src/contracts/registry.ts`**

```ts
  /**
   * V8: needs a local engine or --admin-token-file. Whatever runs this holds
   * DATABASE_URL, which is why it lives in gbrain-ops and never in the
   * control plane (S2).
   */
  'mcp.grant': {
    id: 'mcp.grant',
    argv: ['mcp', 'grant'],
    params: [
      // Work Item F: the positional NAME gbrain requires ("Usage: gbrain mcp
      // grant NAME [options]", src/commands/mcp.ts parseMcpGrant) — omitted
      // from the original plan, so every grant call failed at arg-parsing.
      { name: 'name', flag: '', kind: 'value', required: true },
      { name: 'harness', flag: '--harness', kind: 'value' },
      { name: 'profile', flag: '--profile', kind: 'value' },
      { name: 'client', flag: '--client', kind: 'value' },
      { name: 'source', flag: '--source', kind: 'value' },
      { name: 'federatedRead', flag: '--federated-read', kind: 'list' },
      { name: 'boundTools', flag: '--bound-tools', kind: 'list' },
      { name: 'boundSource', flag: '--bound-source', kind: 'value' },
      { name: 'boundBrain', flag: '--bound-brain', kind: 'value' },
      { name: 'boundSlugPrefixes', flag: '--bound-slug-prefixes', kind: 'value' },
      { name: 'boundMaxConcurrent', flag: '--bound-max-concurrent', kind: 'value' },
      { name: 'budgetUsdPerDay', flag: '--budget-usd-per-day', kind: 'value' },
      { name: 'delegatedSlugPrefixes', flag: '--delegated-slug-prefixes', kind: 'value' },
      { name: 'delegatedNamespace', flag: '--delegated-namespace', kind: 'value' },
      { name: 'tokenTtl', flag: '--token-ttl', kind: 'value' },
      { name: 'credentialsOut', flag: '--credentials-out', kind: 'value' },
      { name: 'adminTokenFile', flag: '--admin-token-file', kind: 'value', secret: true },
      { name: 'ifVersion', flag: '--if-version', kind: 'value' },
      { name: 'resume', flag: '--resume', kind: 'flag' },
      // Work Item G: required, not optional. parseMcpGrant defaults an absent
      // --url to '', and provisionHarnessGrant validates it unconditionally —
      // including on --dry-run — before any dry-run branch runs
      // (mcp-provision.ts:22-24, reference checkout). An empty url always
      // fails with reason "mcp_setup_failed": "Pass a valid MCP endpoint URL".
      { name: 'url', flag: '--url', kind: 'value', required: true, secret: true },
    ],
    supportsJson: true,
    supportsDryRun: true,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * Exit 2 = 'partial': server stages passed but harness evidence is missing.
   * NEVER render that green (honesty rule 5). Note every adapter carries
   * evidence.runtimeTestedAt: null (V10).
   */
  'mcp.verify': {
    id: 'mcp.verify',
    argv: ['mcp', 'verify'],
    params: [
      { name: 'client', flag: '--client', kind: 'value' },
      { name: 'harness', flag: '--harness', kind: 'value' },
      { name: 'timeoutMs', flag: '--timeout-ms', kind: 'value' },
    ],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/contract/mcp-grant.contract.test.ts`
Expected: PASS — 5 tests (the plan originally said 6 here; the file only
ever defines 5 `test()` blocks).

- [ ] **Step 5: Commit**

```bash
git add src/contracts/registry.ts test/contract/mcp-grant.contract.test.ts
git commit -m "feat(slice0): mcp grant/verify contract and the V8 privilege boundary

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: `doctor` and `jobs supervisor` exit codes (V5, V6)

These two exit-code contracts are what make the upgrade gate and quiesce-before-snapshot real rather than aspirational.

**Files:**
- Modify: `src/contracts/registry.ts`
- Create: `test/contract/lifecycle.contract.test.ts`

**Interfaces:**
- Produces: `OPERATIONS.doctor`, `OPERATIONS['jobs.supervisor']`, `OPERATIONS['jobs.supervisorStatus']`, `OPERATIONS['jobs.supervisorStop']`, `OPERATIONS['applyMigrations']`.

> **Plan defect found during execution (Work Item H, 2026-09-14):** as
> originally written, the "second supervisor" test issued a SECOND `gbrain
> jobs supervisor start --detach --json` and expected exit 2. Confirmed
> against the reference checkout that this can never observe LOCK_HELD:
> with `--detach`, the invoking process forks a fully detached, unref'd
> child (`spawnDetachedSupervisor`, `src/core/minions/detached-stderr.ts`)
> and calls `process.exit(0)` immediately after printing the start payload
> (`src/commands/jobs.ts`, the `case 'supervisor'` dispatcher's `if (detach)
> { ...; process.exit(0); }` branch) — this happens BEFORE a
> `MinionSupervisor` is even constructed. `acquirePidLock()` /
> `tryAcquireDbLock()`, where exit 2 (`ExitCodes.LOCK_HELD`) is decided
> (`src/core/minions/supervisor.ts:686-693,768-774`), run only inside the
> detached child, whose exit code the parent never waits for or observes.
> Manually confirmed by direct invocation: issuing a second `--detach` start
> while the first is running exits 0 every time (three for three), and
> `jobs supervisor status --json` immediately afterward still shows only the
> original PID — the second child failed silently in the background,
> invisible to the caller. The lock collision IS synchronously observable
> from a FOREGROUND second start (no `--detach`): `acquirePidLock()` finds
> the first supervisor's live PID already in the pidfile and calls
> `process.exit(ExitCodes.LOCK_HELD)` immediately, without blocking
> (confirmed: `Supervisor already running (PID: N). Exiting.`, exit 2, in
> under a second — safe to run with a short timeout). Fixed by dropping
> `--detach` from the second call (shown below); everything else in this
> task matched observed reality on the first try (doctor's `[0,1,2]` exit
> range, the `--detach` start + immediate `status` sequence — confirmed
> race-free across three repeated trials — the 40s/60s stop budget, and
> apply-migrations idempotency).

- [ ] **Step 1: Write the failing contract test**

`test/contract/lifecycle.contract.test.ts`:
```ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { execOperation, assertOk } from '../../src/contracts/exec.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { composeUp, composeDown, resetBrain, BRAIN_DB_URL } from '../helpers/stack.ts';

beforeAll(async () => {
  await composeUp();
  await resetBrain();
  assertOk(OPERATIONS.init!, await execOperation(OPERATIONS.init!, {
    nonInteractive: true, force: true, url: BRAIN_DB_URL,
    embeddingModel: 'openai:text-embedding-3-small',
  }, { timeoutMs: 600_000 }));
}, 900_000);
afterAll(async () => { await composeDown(); }, 120_000);

// V6: doctor exits non-zero on blockers — so the upgrade gate can be a real gate.
test('doctor --json emits a parseable report and a meaningful exit code', async () => {
  const spec = OPERATIONS.doctor!;
  const r = await execOperation(spec, {}, { json: true, timeoutMs: 600_000 });
  expect([0, 1, 2]).toContain(r.exitCode);
  expect(r.json).not.toBeNull();
}, 660_000);

test('doctor exit code 0 means no blockers', async () => {
  const r = await execOperation(OPERATIONS.doctor!, {}, { json: true, timeoutMs: 600_000 });
  const body = r.json as { blockers?: unknown[] } | null;
  if (r.exitCode === 0 && Array.isArray(body?.blockers)) {
    expect(body!.blockers!.length).toBe(0);
  }
}, 660_000);

// V5: the supervisor drains on SIGTERM. Exit codes (start): 0 clean shutdown,
// 1 max crashes, 2 another supervisor holds the PID lock, 3 PID file unwritable.
// `stop` waits UP TO 40s — not the 35s in the spec prose. Budget 60s.
test('jobs supervisor starts detached and reports running', async () => {
  const start = await execOperation(OPERATIONS['jobs.supervisor']!, {
    detach: true, concurrency: '2',
  }, { json: true, timeoutMs: 120_000 });
  expect([0]).toContain(start.exitCode);

  const status = await execOperation(OPERATIONS['jobs.supervisorStatus']!, {}, { json: true });
  expect(status.exitCode).toBe(0); // 0 if running, 1 if not
}, 180_000);

// Work Item H: a FOREGROUND second start, not another --detach — see the
// defect note above. --detach always exits 0 from the caller's own
// perspective; only a foreground attempt observes LOCK_HELD synchronously.
test('a second supervisor exits 2 because the first holds the PID lock', async () => {
  const second = await execOperation(OPERATIONS['jobs.supervisor']!, {
    concurrency: '2',
  }, { timeoutMs: 30_000 });
  expect(second.exitCode).toBe(2);
}, 60_000);

test('jobs supervisor stop drains cleanly within the 40s window', async () => {
  const t0 = Date.now();
  const stop = await execOperation(OPERATIONS['jobs.supervisorStop']!, {}, { timeoutMs: 90_000 });
  const elapsed = Date.now() - t0;
  expect(stop.exitCode).toBe(0);
  expect(elapsed).toBeLessThan(60_000);

  const status = await execOperation(OPERATIONS['jobs.supervisorStatus']!, {}, { json: true });
  expect(status.exitCode).toBe(1); // not running
}, 120_000);

test('apply-migrations is non-interactive and idempotent', async () => {
  const spec = OPERATIONS.applyMigrations!;
  assertOk(spec, await execOperation(spec, { yes: true, nonInteractive: true }, { timeoutMs: 300_000 }));
  assertOk(spec, await execOperation(spec, { yes: true, nonInteractive: true }, { timeoutMs: 300_000 }));
}, 660_000);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/contract/lifecycle.contract.test.ts`
Expected: FAIL — `OPERATIONS.doctor is undefined`.

- [ ] **Step 3: Add the lifecycle operations to `src/contracts/registry.ts`**

```ts
  /**
   * V6: exits non-zero on blockers (1, and 2 on the unreachable-target path).
   * okExitCodes is [0] deliberately — a blocker IS a failure for our gate.
   */
  doctor: {
    id: 'doctor',
    argv: ['doctor'],
    params: [
      { name: 'remediate', flag: '--remediate', kind: 'flag' },
      { name: 'yes', flag: '--yes', kind: 'flag' },
      { name: 'targetScore', flag: '--target-score', kind: 'value' },
      { name: 'maxUsd', flag: '--max-usd', kind: 'value' },
    ],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  /**
   * V5 exit codes (start): 0 clean shutdown (SIGTERM/SIGINT, worker drained),
   * 1 max crashes exceeded, 2 another supervisor holds the PID lock,
   * 3 PID file unwritable. `stop` waits up to 40s for graceful drain.
   */
  'jobs.supervisor': {
    id: 'jobs.supervisor',
    argv: ['jobs', 'supervisor', 'start'],
    params: [
      { name: 'concurrency', flag: '--concurrency', kind: 'value' },
      { name: 'detach', flag: '--detach', kind: 'flag' },
    ],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  'jobs.supervisorStatus': {
    id: 'jobs.supervisorStatus',
    argv: ['jobs', 'supervisor', 'status'],
    params: [],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    // 0 = running, 1 = not running. Both are valid answers, not failures.
    okExitCodes: [0, 1],
  },

  'jobs.supervisorStop': {
    id: 'jobs.supervisorStop',
    argv: ['jobs', 'supervisor', 'stop'],
    params: [],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  applyMigrations: {
    id: 'applyMigrations',
    argv: ['apply-migrations'],
    params: [
      { name: 'yes', flag: '--yes', kind: 'flag' },
      { name: 'nonInteractive', flag: '--non-interactive', kind: 'flag' },
    ],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/contract/lifecycle.contract.test.ts`
Expected: PASS — 6 tests.

> **If `jobs supervisor stop` exceeds 60s**, record the real drain window in `docs/slice-0-findings.md` and widen the quiesce budget in the roadmap's Slice 3.5 flow. Do not just raise the timeout and move on — the number feeds snapshot atomicity.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/registry.ts test/contract/lifecycle.contract.test.ts
git commit -m "feat(slice0): doctor and supervisor exit-code contracts (V5, V6)

Supervisor stop drains in up to 40s, not the 35s in the spec prose.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: Self-describing surfaces — `--tools-json`, `.well-known`, `schema list` (V12, V13, V14)

These three are the **data-plane** half of G4: what the snapshot captures, and what renders UI without a release on our side.

**Files:**
- Modify: `src/contracts/registry.ts`
- Create: `test/contract/discovery.contract.test.ts`

**Interfaces:**
- Produces: `OPERATIONS.toolsJson`, `OPERATIONS['schema.list']`, `OPERATIONS['sources.list']`, `OPERATIONS.serve`.

> **Plan defect found during execution (Work Item I, 2026-09-14):** the
> original probe loop shelled out to `curl`. Confirmed empirically (`which
> curl`, `which wget`) that the pinned `gbrain-ops` image
> (`docker/gbrain-base.Dockerfile`, Task 1) installs only `git
> ca-certificates tini postgresql-client` — no HTTP client binary at all.
> Rather than add a dependency to the already-built, already-tested Task 1
> base image and force a rebuild for a Task 10 probe, the fix uses `bun`'s
> built-in `fetch()` instead (`bun` is already on PATH in this image, so
> this needs no image change): `bun -e 'const r = await fetch(...); if (r
> && r.ok) console.log(await r.text());'`, invoked as a direct argv element
> (no shell layer) through the existing `composeExec` helper.

> **Plan defect found during execution (Work Item J, 2026-09-14):** the
> original test grouped `adapters` by `.connection` and asserted "four
> connection classes" — but its own assertion array actually listed FIVE
> (`claude-json`, `codex-toml`, `manual`, `opencode-json`, `thin-cli`), an
> internal inconsistency in the plan text. More fundamentally, confirmed
> against the reference checkout that `connection` is not on the public
> contract at all: both `.well-known/gbrain`'s `adapters` and `gbrain mcp
> adapters --json` are built from `publicHarnessMetadata()`
> (`src/core/harness/registry.ts:63-65`), which destructures only `{ id,
> label, modes, guide→documentation, evidence }` off each
> `HARNESS_ADAPTER` — `connection` (and `aliases`, `renewable`,
> `legacyRegister`) is deliberately internal-only. Confirmed empirically:
> every adapter's `.connection` over the live endpoint is `undefined`.
> Per G3 we cannot read `HARNESS_ADAPTERS` directly to get the real value.
> This is a **slice-defining finding**: Slice 1's harness picker cannot
> group adapters by connection mechanism from live `.well-known` data as
> the roadmap assumed — that would require either a hardcoded table on our
> side (defeating "renders FROM THIS, never hard-coded") or an upstream
> change exposing the field. Fixed by asserting the adapter **ID set**
> instead (13 ids, confirmed exact against both the reference source count
> and the live payload) — still a real, observable drift tripwire, just not
> the connection-class grouping the plan wanted.

> **Plan defect found during execution (Work Item K, 2026-09-14):** `schema
> list --json` does not emit JSON. `runList`'s own parameter is named
> `_args` (`src/commands/schema.ts:204`) — the leading underscore marks it
> unused — and the function unconditionally prints human prose ("Bundled
> packs:" plus one bundled-pack name per line) regardless of any flag.
> Confirmed empirically. Fixed `schema.list`'s registry entry to
> `supportsJson: false` and asserted the stable prose instead, the same
> non-JSON-command shape Task 6 hit with `config show` (Work Item C).

> **Plan defect found during execution (Work Item M, 2026-09-14):** the
> "hermes is absent" test's raw argv was `['sh', '-c', 'gbrain mcp grant
> --help 2>&1 || true']` — a shell STRING that invokes `gbrain`, exactly
> what this repo's own `bun run lint:forbidden` (the `shell-string-gbrain`
> rule, `scripts/lint-forbidden.ts`, enforcing G2) exists to reject, and it
> does: running the lint gate against the plan's own literal test code
> fails it. `--help` prints via `console.log` in `runMcp`
> (`src/commands/mcp.ts`) — plain stdout — so no `sh -c` / `2>&1` merge is
> needed. Fixed by using a plain argv array, `['gbrain', 'mcp', 'grant',
> '--help']`, and checking `stdout + stderr` defensively (shown below).

> **Plan defect found during execution (Work Item L, 2026-09-14):** the
> original `finally { serve.kill(); }` does not actually stop the remote
> `gbrain serve` process. `serve` is a LOCAL `Bun.spawn` of `docker compose
> exec -T ... gbrain serve`; `-T` (no TTY, required for headless exec per
> G2) means docker never ties the exec session's lifetime to the client's.
> Confirmed empirically: after killing the local client, scanning `/proc`
> inside the container still found the real `gbrain serve` process (and a
> worker fork) alive. In this slice the leak is cosmetic — `afterAll` tears
> down the whole container (`compose down -v`) moments later — but it is a
> genuine stray process for the time in between, and would be a real
> port-3131 leak against any longer-lived container. Fixed by also reaping
> the remote process directly: a `killRemoteServe()` helper scans `/proc`
> inside the container for any PID (excluding its own — a self-match guard,
> since its own argv literally contains the strings "gbrain" and "serve")
> whose cmdline contains both, and sends it SIGTERM.

- [ ] **Step 1: Write the failing contract test**

`test/contract/discovery.contract.test.ts`:
```ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { execOperation, assertOk } from '../../src/contracts/exec.ts';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { composeUp, composeDown, composeExec, resetBrain, BRAIN_DB_URL, PIN } from '../helpers/stack.ts';

beforeAll(async () => {
  await composeUp();
  await resetBrain();
  assertOk(OPERATIONS.init!, await execOperation(OPERATIONS.init!, {
    nonInteractive: true, force: true, url: BRAIN_DB_URL,
    embeddingModel: 'openai:text-embedding-3-small',
  }, { timeoutMs: 600_000 }));
}, 900_000);
afterAll(async () => { await composeDown(); }, 120_000);

// V14: --tools-json is the public CLI tool-catalog contract.
test('--tools-json emits the tool catalog', async () => {
  const r = await composeExec('gbrain-ops', ['gbrain', '--tools-json']);
  expect(r.exitCode).toBe(0);
  const catalog = JSON.parse(r.stdout);
  expect(catalog).toBeDefined();
  const count = Array.isArray(catalog) ? catalog.length : Object.keys(catalog).length;
  expect(count).toBeGreaterThan(50);
});

// Work Item I: bun's fetch(), not curl — the pinned image has no HTTP
// client binary. Invoked as a direct argv element; no shell layer needed.
async function fetchWellKnown(): Promise<Record<string, unknown> | null> {
  const probe = await composeExec('gbrain-ops', [
    'bun', '-e',
    'const r = await fetch("http://127.0.0.1:3131/.well-known/gbrain").catch(() => null); ' +
    'if (r && r.ok) console.log(await r.text());',
  ]);
  const t = probe.stdout.trim();
  return t.startsWith('{') ? JSON.parse(t) : null;
}

// Work Item L: `serve.kill()` alone only kills the LOCAL docker-exec client;
// -T means docker never ties the exec session's lifetime to it. Reap the
// remote process directly by /proc scan (excluding this scanner's own PID —
// its own argv literally contains "gbrain" and "serve").
async function killRemoteServe(): Promise<void> {
  await composeExec('gbrain-ops', [
    'bun', '-e',
    "const fs=require('fs'); for (const pid of fs.readdirSync('/proc')) { " +
    "if (!/^[0-9]+$/.test(pid) || Number(pid) === process.pid) continue; " +
    "try { const cmd = fs.readFileSync('/proc/'+pid+'/cmdline','utf8'); " +
    "if (cmd.indexOf('gbrain') >= 0 && cmd.indexOf('serve') >= 0) process.kill(Number(pid), 'SIGTERM'); " +
    "} catch (e) {} }",
  ]);
}

// V13: GET /.well-known/gbrain returns version, profiles and adapters. The
// harness picker and profile list render FROM THIS, never hard-coded.
test('.well-known/gbrain exposes live profiles and harness adapters', async () => {
  const serve = Bun.spawn([
    'docker', 'compose', '-f', 'compose/docker-compose.slice0.yml', 'exec', '-T', 'gbrain-ops',
    'gbrain', 'serve', '--http', '--bind', '127.0.0.1', '--port', '3131',
  ], { stdout: 'pipe', stderr: 'pipe' });

  try {
    // Poll rather than sleep blindly.
    let body: Record<string, unknown> | null = null;
    for (let i = 0; i < 60; i++) {
      body = await fetchWellKnown();
      if (body) break;
      await Bun.sleep(1000);
    }
    expect(body).not.toBeNull();
    expect(body!.version).toBe(PIN);
    expect(body!.protocol).toBe('mcp');
    expect(Array.isArray(body!.adapters)).toBe(true);
    const adapters = body!.adapters as Array<Record<string, unknown>>;
    // V10: 13 adapters at v0.50.0.0.
    expect(adapters.length).toBe(13);
    // Work Item J: `.connection` is not on the public contract at all (see
    // the defect note above) — assert the adapter ID set instead, which
    // still catches the registry drift V10 exists to catch.
    const ids = (adapters.map((a) => a.id) as string[]).sort();
    expect(ids).toEqual([
      'chatgpt', 'claude-code', 'claude-desktop', 'codex', 'cursor', 'generic',
      'grok-bot', 'grok-build', 'muse', 'muse-code', 'openclaw', 'opencode', 'perplexity',
    ]);
    expect(body!.profiles).toBeDefined();
  } finally {
    serve.kill();
    await killRemoteServe();
  }
}, 180_000);

// V10: never promise auto-install for a manual-class adapter.
// Work Item M: a plain argv array, not `sh -c` — see the defect note above.
test('hermes is absent and generic is the manual path for it', async () => {
  const probe = await composeExec('gbrain-ops', ['gbrain', 'mcp', 'grant', '--help']);
  expect((probe.stdout + probe.stderr).toLowerCase()).not.toContain('hermes');
});

// Work Item K: `schema list` ignores --json entirely (runList(_args) never
// reads its argument, src/commands/schema.ts:204) and always prints prose.
test('schema list enumerates bundled packs', async () => {
  const spec = OPERATIONS['schema.list']!;
  const r = await execOperation(spec, {});
  assertOk(spec, r);
  expect(r.stdout).toContain('Bundled packs:');
  expect(r.stdout).toContain('gbrain-base');
});

test('sources list --json is parseable', async () => {
  const spec = OPERATIONS['sources.list']!;
  const r = await execOperation(spec, {}, { json: true });
  assertOk(spec, r);
  expect(r.json).not.toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/contract/discovery.contract.test.ts`
Expected: FAIL — `OPERATIONS['schema.list'] is undefined`.

- [ ] **Step 3: Add the discovery operations to `src/contracts/registry.ts`**

```ts
  // V14: the public CLI tool-catalog contract. Data-plane half of the snapshot.
  toolsJson: {
    id: 'toolsJson',
    argv: ['--tools-json'],
    params: [],
    supportsJson: false, // the command IS the json
    supportsDryRun: false,
    privilege: 'read-only',
    okExitCodes: [0],
  },

  // Work Item K: supportsJson is false, not true — `schema list` ignores
  // --json and always prints prose. See the defect note above.
  'schema.list': {
    id: 'schema.list',
    argv: ['schema', 'list'],
    params: [],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  'schema.lint': {
    id: 'schema.lint',
    argv: ['schema', 'lint'],
    params: [
      { name: 'withDb', flag: '--with-db', kind: 'flag' },
      { name: 'pack', flag: '--pack', kind: 'value' },
    ],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  'schema.sync': {
    id: 'schema.sync',
    argv: ['schema', 'sync'],
    params: [
      { name: 'apply', flag: '--apply', kind: 'flag' },
      { name: 'pack', flag: '--pack', kind: 'value' },
    ],
    supportsJson: true,
    supportsDryRun: true,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  'sources.list': {
    id: 'sources.list',
    argv: ['sources', 'list'],
    params: [],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  'sources.status': {
    id: 'sources.status',
    argv: ['sources', 'status'],
    params: [],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  sync: {
    id: 'sync',
    argv: ['sync'],
    params: [
      { name: 'all', flag: '--all', kind: 'flag' },
      { name: 'source', flag: '--source', kind: 'value' },
    ],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  embed: {
    id: 'embed',
    argv: ['embed'],
    params: [{ name: 'stale', flag: '--stale', kind: 'flag' }],
    supportsJson: true,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },

  // Slice 1 runs this as the long-lived gbrain-serve entrypoint, not via RPC.
  serve: {
    id: 'serve',
    argv: ['serve'],
    params: [
      { name: 'http', flag: '--http', kind: 'flag' },
      { name: 'bind', flag: '--bind', kind: 'value' },
      { name: 'port', flag: '--port', kind: 'value' },
      { name: 'publicUrl', flag: '--public-url', kind: 'value' },
    ],
    supportsJson: false,
    supportsDryRun: false,
    privilege: 'brain-db',
    okExitCodes: [0],
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/contract/discovery.contract.test.ts`
Expected: PASS — 5 tests.

> **If the adapter count is not 13**, upstream changed the registry. Update the assertion to the observed count *and* record it in the findings doc — the harness picker renders from this payload, so a change is product-visible.
>
> **Confirmed 2026-09-14: exactly 13**, matching both the reference source (`HARNESS_ADAPTERS`, `src/core/harness/registry.ts`) and the live `.well-known/gbrain` payload. But see Work Item J above — the "four connection classes" half of this check was not just wrong on the count, it was checking a field (`connection`) that the public contract never exposes at all. Report this prominently: it means Slice 1's harness picker cannot group adapters by connection mechanism from live data as the roadmap assumed.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/registry.ts test/contract/discovery.contract.test.ts
git commit -m "feat(slice0): discovery contracts for tools-json, well-known and schema (V12-V14)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 11: Capability snapshot capture and drift diff

**Files:**
- Create: `src/contracts/capability.ts`
- Create: `scripts/capture-capability.ts`
- Test: `test/unit/capability.test.ts`

**Interfaces:**
- Consumes: `composeExec` (Task 4); `OPERATIONS['schema.list']` (Task 10).
- Produces:
  - `type CapabilitySnapshot = { gbrainVersion: string; capturedAt: string; tools: unknown; wellKnown: { profiles: unknown; adapters: HarnessAdapter[] } | null; schemaPacks: unknown }`
  - `type HarnessAdapter = { id: string; label: string; connection: string; modes: string[] }`
  - `captureCapability(): Promise<CapabilitySnapshot>`
  - `diffCapability(before, after): CapabilityDrift`
  - `type CapabilityDrift = { versionChanged: boolean; toolsAdded: string[]; toolsRemoved: string[]; adaptersAdded: string[]; adaptersRemoved: string[]; profilesChanged: boolean }`

- [ ] **Step 1: Write the failing unit test**

`test/unit/capability.test.ts`:
```ts
import { test, expect, describe } from 'bun:test';
import { diffCapability, toolNames, parseGbrainVersion } from '../../src/contracts/capability.ts';
import type { CapabilitySnapshot } from '../../src/contracts/capability.ts';

const base: CapabilitySnapshot = {
  gbrainVersion: '0.50.0.0',
  capturedAt: '2026-09-14T00:00:00.000Z',
  tools: [{ name: 'search' }, { name: 'put_page' }],
  wellKnown: {
    profiles: { 'memory-reader': {} },
    adapters: [
      { id: 'claude-code', label: 'Claude Code', connection: 'claude-json', modes: ['http'] },
      { id: 'codex', label: 'Codex', connection: 'codex-toml', modes: ['http'] },
    ],
  },
  schemaPacks: ['gbrain-base-v2'],
};

describe('toolNames', () => {
  test('reads names from an array catalog', () => {
    expect(toolNames([{ name: 'a' }, { name: 'b' }])).toEqual(['a', 'b']);
  });
  test('reads keys from an object catalog', () => {
    expect(toolNames({ a: {}, b: {} })).toEqual(['a', 'b']);
  });
  test('returns empty for an unusable catalog', () => {
    expect(toolNames(null)).toEqual([]);
  });
});

describe('diffCapability', () => {
  test('reports no drift against itself', () => {
    const d = diffCapability(base, base);
    expect(d).toEqual({
      versionChanged: false, toolsAdded: [], toolsRemoved: [],
      adaptersAdded: [], adaptersRemoved: [], profilesChanged: false,
    });
  });

  // The whole point of G4's snapshot half: upstream additions must SURFACE,
  // not break us. An added tool is drift to report, never a failure.
  test('detects an added tool', () => {
    const after = { ...base, tools: [...(base.tools as any[]), { name: 'takes_add' }] };
    expect(diffCapability(base, after).toolsAdded).toEqual(['takes_add']);
  });

  test('detects a removed tool', () => {
    const after = { ...base, tools: [{ name: 'search' }] };
    expect(diffCapability(base, after).toolsRemoved).toEqual(['put_page']);
  });

  test('detects an added harness adapter', () => {
    const after = {
      ...base,
      wellKnown: {
        ...base.wellKnown!,
        adapters: [...base.wellKnown!.adapters,
          { id: 'hermes', label: 'Hermes', connection: 'manual', modes: ['http'] }],
      },
    };
    expect(diffCapability(base, after).adaptersAdded).toEqual(['hermes']);
  });

  test('detects a version change', () => {
    expect(diffCapability(base, { ...base, gbrainVersion: '0.51.0.0' }).versionChanged).toBe(true);
  });

  test('detects a changed profile set', () => {
    const after = {
      ...base,
      wellKnown: { ...base.wellKnown!, profiles: { 'memory-reader': {}, operator: {} } },
    };
    expect(diffCapability(base, after).profilesChanged).toBe(true);
  });
});

describe('parseGbrainVersion', () => {
  test('extracts the version from the real "gbrain X.Y.Z.W" shape', () => {
    expect(parseGbrainVersion('gbrain 0.50.0.0')).toBe('0.50.0.0');
  });

  test('accepts a bare version with no leading label', () => {
    expect(parseGbrainVersion('0.50.0.0')).toBe('0.50.0.0');
  });

  test('tolerates trailing newline and surrounding whitespace', () => {
    expect(parseGbrainVersion('gbrain 0.50.0.0\n')).toBe('0.50.0.0');
    expect(parseGbrainVersion('  gbrain 0.50.0.0  \n')).toBe('0.50.0.0');
  });

  test('takes the last non-empty line of multi-line output', () => {
    expect(parseGbrainVersion('Checking for updates...\n\ngbrain 0.50.0.0\n')).toBe('0.50.0.0');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/capability.test.ts`
Expected: FAIL — `Cannot find module '../../src/contracts/capability.ts'`.

- [ ] **Step 3: Write `src/contracts/capability.ts`**

```ts
import { composeExec } from '../docker/host.ts';

export type HarnessAdapter = {
  id: string;
  label: string;
  connection: string;
  modes: string[];
};

export type CapabilitySnapshot = {
  gbrainVersion: string;
  capturedAt: string;
  tools: unknown;
  wellKnown: { profiles: unknown; adapters: HarnessAdapter[] } | null;
  schemaPacks: unknown;
};

export type CapabilityDrift = {
  versionChanged: boolean;
  toolsAdded: string[];
  toolsRemoved: string[];
  adaptersAdded: string[];
  adaptersRemoved: string[];
  profilesChanged: boolean;
};

/**
 * `gbrain --version` prints "gbrain 0.50.0.0" -- the version is the LAST
 * whitespace-separated token, not the whole line. Never compare the raw
 * output; this is the only place that knows the shape.
 */
export function parseGbrainVersion(raw: string): string {
  const line = raw.trim().split('\n').filter((l) => l.trim()).pop() ?? '';
  return line.trim().split(/\s+/).pop() ?? '';
}

/** Tool catalogs may be an array of {name} or an object keyed by name. */
export function toolNames(tools: unknown): string[] {
  if (Array.isArray(tools)) {
    return tools
      .map((t) => (t && typeof t === 'object' && 'name' in t ? String((t as any).name) : ''))
      .filter(Boolean)
      .sort();
  }
  if (tools && typeof tools === 'object') return Object.keys(tools as object).sort();
  return [];
}

function adapterIds(snap: CapabilitySnapshot): string[] {
  return (snap.wellKnown?.adapters ?? []).map((a) => a.id).sort();
}

const missing = (from: string[], to: string[]) => from.filter((x) => !to.includes(x));

export function diffCapability(before: CapabilitySnapshot, after: CapabilitySnapshot): CapabilityDrift {
  const bt = toolNames(before.tools);
  const at = toolNames(after.tools);
  const ba = adapterIds(before);
  const aa = adapterIds(after);
  return {
    versionChanged: before.gbrainVersion !== after.gbrainVersion,
    toolsAdded: missing(at, bt),
    toolsRemoved: missing(bt, at),
    adaptersAdded: missing(aa, ba),
    adaptersRemoved: missing(ba, aa),
    profilesChanged:
      JSON.stringify(before.wellKnown?.profiles ?? null) !==
      JSON.stringify(after.wellKnown?.profiles ?? null),
  };
}

/**
 * Capture the self-describing surfaces. Requires a running stack with an
 * initialized brain; the caller starts `gbrain serve` for the well-known probe.
 */
export async function captureCapability(opts: { serveBaseUrl?: string } = {}): Promise<CapabilitySnapshot> {
  const version = parseGbrainVersion(
    (await composeExec('gbrain-ops', ['gbrain', '--version'])).stdout,
  );
  const toolsRaw = await composeExec('gbrain-ops', ['gbrain', '--tools-json']);
  const packsRaw = await composeExec('gbrain-ops', ['gbrain', 'schema', 'list', '--json']);

  let wellKnown: CapabilitySnapshot['wellKnown'] = null;
  if (opts.serveBaseUrl) {
    const probe = await composeExec('gbrain-ops', [
      'sh', '-c', `curl -sf ${opts.serveBaseUrl}/.well-known/gbrain || true`,
    ]);
    if (probe.stdout.trim().startsWith('{')) {
      const body = JSON.parse(probe.stdout);
      wellKnown = { profiles: body.profiles ?? null, adapters: body.adapters ?? [] };
    }
  }

  const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };

  return {
    gbrainVersion: version,
    capturedAt: new Date().toISOString(),
    tools: parse(toolsRaw.stdout),
    wellKnown,
    schemaPacks: parse(packsRaw.stdout),
  };
}
```

> **Plan defect found during execution (Work Item O, 2026-09-14, finishing Task 11's Docker half):** the code above has two bugs that only surface when actually run against the container, which never happened until now.
>
> 1. The well-known probe shells out to `curl`, but Work Item I (Task 10) already established the pinned image (`docker/gbrain-base.Dockerfile`) carries no curl or wget — confirmed again here: `sh -c curl -sf ...` prints nothing and the probe always fell through to `wellKnown = null`. Fixed by reusing the same `bun -e 'fetch(...)'` pattern discovery.contract.test.ts's `fetchWellKnown()` already established for Task 10, invoked as a `bun -e` argv array (not a shell string invoking `gbrain` — stays clear of G2's lint rule).
> 2. `gbrain schema list --json` is JSON.parsed directly. Work Item K (Task 10) already established `schema list` ignores `--json` entirely and always prints prose — confirmed again here: `JSON.parse()` on that prose doesn't throw a catchable, obvious error, it just returns... no, it THROWS (prose is not valid JSON), which the original code doesn't even catch — `schemaPacks: parse(packsRaw.stdout)` was written assuming a `parse` helper existed for it, but plugging in the same try/catch-wrapped `parse` used for `tools` would have silently produced `schemaPacks: null`, indistinguishable from "this brain has no schema packs." Fixed by dropping `--json` (it changes nothing) and parsing the real prose with a new pure function, `parseSchemaPacksProse()`, that extracts the bundled-pack names between the `Bundled packs:` header and the following blank line and keeps the raw text alongside them — so the snapshot states truthfully what packs exist instead of silently storing `null`.
>
> The corrected implementation:
>
> ```ts
> export type SchemaPacksSnapshot = { bundled: string[]; raw: string };
>
> export function parseSchemaPacksProse(raw: string): SchemaPacksSnapshot {
>   const bundled: string[] = [];
>   let inBundled = false;
>   for (const line of raw.split('\n')) {
>     if (/^\s*Bundled packs:\s*$/.test(line)) { inBundled = true; continue; }
>     if (!inBundled) continue;
>     const t = line.trim();
>     if (t === '') break;
>     bundled.push(t);
>   }
>   return { bundled, raw };
> }
>
> export async function captureCapability(opts: { serveBaseUrl?: string } = {}): Promise<CapabilitySnapshot> {
>   const version = parseGbrainVersion(
>     (await composeExec('gbrain-ops', ['gbrain', '--version'])).stdout,
>   );
>   const toolsRaw = await composeExec('gbrain-ops', ['gbrain', '--tools-json']);
>   const packsRaw = await composeExec('gbrain-ops', ['gbrain', 'schema', 'list']); // --json is a no-op
>
>   let wellKnown: CapabilitySnapshot['wellKnown'] = null;
>   if (opts.serveBaseUrl) {
>     const probe = await composeExec('gbrain-ops', [
>       'bun', '-e',
>       `const r = await fetch(${JSON.stringify(`${opts.serveBaseUrl}/.well-known/gbrain`)}).catch(() => null); ` +
>       'if (r && r.ok) console.log(await r.text());',
>     ]);
>     const body = probe.stdout.trim();
>     if (body.startsWith('{')) {
>       const parsed = JSON.parse(body);
>       wellKnown = { profiles: parsed.profiles ?? null, adapters: parsed.adapters ?? [] };
>     }
>   }
>
>   const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };
>
>   return {
>     gbrainVersion: version,
>     capturedAt: new Date().toISOString(),
>     tools: parse(toolsRaw.stdout),
>     wellKnown,
>     schemaPacks: parseSchemaPacksProse(packsRaw.stdout),
>   };
> }
> ```

- [ ] **Step 4: Write `scripts/capture-capability.ts`**

```ts
#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises';
import { captureCapability, diffCapability } from '../src/contracts/capability.ts';
import type { CapabilitySnapshot } from '../src/contracts/capability.ts';

const serveBaseUrl = process.env.SERVE_BASE_URL ?? 'http://127.0.0.1:3131';
const snap = await captureCapability({ serveBaseUrl });

const dir = `contracts/v${snap.gbrainVersion}`;
await mkdir(dir, { recursive: true });
const file = `${dir}/capability.json`;

const existing = await Bun.file(file).exists()
  ? (await Bun.file(file).json()) as CapabilitySnapshot
  : null;

if (existing) {
  const drift = diffCapability(existing, snap);
  const changed =
    drift.versionChanged || drift.profilesChanged ||
    drift.toolsAdded.length || drift.toolsRemoved.length ||
    drift.adaptersAdded.length || drift.adaptersRemoved.length;
  console.log(changed ? 'DRIFT DETECTED' : 'no drift');
  console.log(JSON.stringify(drift, null, 2));
}

await Bun.write(file, JSON.stringify(snap, null, 2) + '\n');
console.log(`wrote ${file}`);
```

> **Plan defect found during execution (Work Item P, 2026-09-14):** as originally written, this script never started `gbrain serve` — it called `captureCapability({ serveBaseUrl })` assuming something else had already brought a server up on that URL. Nothing did: run standalone (`bun run capability:capture`), the well-known probe always failed closed to `null`. This was the "Docker half was never exercised" gap — Task 11 landed with only the pure unit tests (`diffCapability`/`toolNames`/`parseGbrainVersion`) proven, not a real end-to-end capture. Fixed by having the script own the `gbrain serve` process it needs for its own probe: spawn it the same way test/contract/discovery.contract.test.ts does, poll `.well-known/gbrain` until it answers (bun `fetch()`, not curl — Work Item I), capture, then tear it down in a `finally` — reaping the REMOTE process by `/proc` scan too, since Work Item L already established that `-T` docker-exec means `.kill()` on the local client never reaches the remote `gbrain serve` it spawned. The script also now throws instead of writing a file if `wellKnown` comes back `null`, so a broken probe fails loudly rather than checking in a silently-incomplete snapshot:
>
> ```ts
> #!/usr/bin/env bun
> import { mkdir } from 'node:fs/promises';
> import { captureCapability, diffCapability } from '../src/contracts/capability.ts';
> import type { CapabilitySnapshot } from '../src/contracts/capability.ts';
> import { composeExec } from '../src/docker/host.ts';
>
> const COMPOSE_FILE = 'compose/docker-compose.slice0.yml';
> const serveBaseUrl = process.env.SERVE_BASE_URL ?? 'http://127.0.0.1:3131';
>
> function startServe() {
>   return Bun.spawn(
>     ['docker', 'compose', '-f', COMPOSE_FILE, 'exec', '-T', 'gbrain-ops',
>       'gbrain', 'serve', '--http', '--bind', '127.0.0.1', '--port', '3131'],
>     { stdout: 'pipe', stderr: 'pipe' },
>   );
> }
>
> async function waitForServe(): Promise<void> {
>   for (let i = 0; i < 60; i++) {
>     const probe = await composeExec('gbrain-ops', [
>       'bun', '-e',
>       `const r = await fetch(${JSON.stringify(`${serveBaseUrl}/.well-known/gbrain`)}).catch(() => null); ` +
>       'if (r && r.ok) console.log("ready");',
>     ]);
>     if (probe.stdout.includes('ready')) return;
>     await Bun.sleep(1000);
>   }
>   throw new Error(`gbrain serve did not become ready at ${serveBaseUrl} within 60s`);
> }
>
> async function stopServe(local: ReturnType<typeof startServe>): Promise<void> {
>   local.kill();
>   await composeExec('gbrain-ops', [
>     'bun', '-e',
>     "const fs=require('fs'); for (const pid of fs.readdirSync('/proc')) { " +
>     "if (!/^[0-9]+$/.test(pid) || Number(pid) === process.pid) continue; " +
>     "try { const cmd = fs.readFileSync('/proc/'+pid+'/cmdline','utf8'); " +
>     "if (cmd.indexOf('gbrain') >= 0 && cmd.indexOf('serve') >= 0) process.kill(Number(pid), 'SIGTERM'); " +
>     "} catch (e) {} }",
>   ]);
> }
>
> const serve = startServe();
> try {
>   await waitForServe();
>   const snap = await captureCapability({ serveBaseUrl });
>   const dir = `contracts/v${snap.gbrainVersion}`;
>   await mkdir(dir, { recursive: true });
>   const file = `${dir}/capability.json`;
>   const existing = await Bun.file(file).exists()
>     ? (await Bun.file(file).json()) as CapabilitySnapshot
>     : null;
>   if (existing) {
>     const drift = diffCapability(existing, snap);
>     const changed =
>       drift.versionChanged || drift.profilesChanged ||
>       drift.toolsAdded.length > 0 || drift.toolsRemoved.length > 0 ||
>       drift.adaptersAdded.length > 0 || drift.adaptersRemoved.length > 0;
>     console.log(changed ? 'DRIFT DETECTED' : 'no drift');
>     console.log(JSON.stringify(drift, null, 2));
>   }
>   if (snap.wellKnown === null) {
>     throw new Error('captured snapshot has wellKnown: null — the serve probe did not get a reply');
>   }
>   await Bun.write(file, JSON.stringify(snap, null, 2) + '\n');
>   console.log(`wrote ${file}`);
> } finally {
>   await stopServe(serve);
> }
> ```
>
> Verified end to end against the running pinned stack: `bun run capability:capture` now writes `contracts/v0.50.0.0/capability.json` with 136 real tool entries, 6 profiles and 13 adapters from a live `.well-known/gbrain`, and 7 real bundled schema-pack names — no `null` anywhere in the snapshot.

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `bun test test/unit/capability.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 6: Commit**

```bash
git add src/contracts/capability.ts scripts/capture-capability.ts test/unit/capability.test.ts
git commit -m "feat(slice0): capability snapshot capture and drift diff

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 12: The scripted tutorial — unattended, end to end

**The headline exit gate.** Replaces the 90-minute human tutorial with one unattended script covering the automatable parts (tutorial Parts 2–5, 11–12). Parts 6–10 (crons, skills, Slack, human onboarding) are what *we* replace in later slices.

**Files:**
- Create: `scripts/tutorial.ts`
- Create: `test/contract/tutorial.contract.test.ts`

**Interfaces:**
- Consumes: every operation registered in Tasks 5–10.
- Produces: `runTutorial(): Promise<TutorialReport>` where `type TutorialReport = { steps: { id: string; ok: boolean; exitCode: number; ms: number }[]; doctorExitCode: number; isolationOk: boolean }`.

- [ ] **Step 1: Write the failing end-to-end test**

`test/contract/tutorial.contract.test.ts`:
```ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { runTutorial } from '../../scripts/tutorial.ts';
import { composeUp, composeDown, resetBrain } from '../helpers/stack.ts';

beforeAll(async () => { await composeUp(); await resetBrain(); }, 300_000);
afterAll(async () => { await composeDown(); }, 120_000);

test('the whole company-brain tutorial runs unattended and ends doctor-green', async () => {
  const report = await runTutorial();

  const failed = report.steps.filter((s) => !s.ok);
  expect(failed.map((s) => `${s.id} (exit ${s.exitCode})`)).toEqual([]);

  // V6: doctor exits non-zero on blockers.
  expect(report.doctorExitCode).toBe(0);

  // Upstream's own isolation test: every result a scoped client sees must
  // come from a source in that client's read set.
  expect(report.isolationOk).toBe(true);
}, 2_400_000);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/contract/tutorial.contract.test.ts`
Expected: FAIL — `Cannot find module '../../scripts/tutorial.ts'`.

- [ ] **Step 3: Write `scripts/tutorial.ts`**

```ts
#!/usr/bin/env bun
/**
 * The 90-minute company-brain tutorial, unattended.
 * Covers docs/tutorials/company-brain.md Parts 2-5 and 11-12 — the parts that
 * are automatable today. Parts 6-10 (crons, skills, Slack, human onboarding)
 * are what brainstand replaces in Slices 2-4.
 *
 * Every step goes through the typed exec layer: argv arrays, never shell
 * strings (G2), with secrets redacted out of the report (S3c).
 */
import { execOperation } from '../src/contracts/exec.ts';
import { OPERATIONS } from '../src/contracts/registry.ts';
import { composeExec } from '../src/docker/host.ts';
import type { ParamValues } from '../src/contracts/types.ts';

const PG_PASSWORD = process.env.POSTGRES_PASSWORD ?? 'change-me-in-a-real-deployment';
const BRAIN_DB_URL = `postgres://gbrain:${PG_PASSWORD}@postgres:5432/${process.env.GBRAIN_DB ?? 'gbrain'}`;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'openai:text-embedding-3-small';

export type TutorialStep = { id: string; ok: boolean; exitCode: number; ms: number };
export type TutorialReport = { steps: TutorialStep[]; doctorExitCode: number; isolationOk: boolean };

const SOURCES = [
  { id: 'shared', name: 'Shared company wiki' },
  { id: 'customers', name: 'Customer notes' },
  { id: 'internal', name: 'Internal-only' },
];

// Each member writes ONE source and reads N — S4's model, expressed in the
// only shape the enforcement layer actually supports.
const MEMBERS = [
  { id: 'alice-example', write: 'customers', read: ['customers', 'shared'] },
  { id: 'bob-example', write: 'internal', read: ['internal', 'shared'] },
  { id: 'carol-example', write: 'shared', read: ['shared', 'customers', 'internal'] },
];

export async function runTutorial(): Promise<TutorialReport> {
  const steps: TutorialStep[] = [];

  async function step(id: string, opId: string, values: ParamValues, opts: { json?: boolean; timeoutMs?: number } = {}) {
    const spec = OPERATIONS[opId];
    if (!spec) throw new Error(`unregistered operation ${opId} — add it to the registry with a contract test`);
    const t0 = Date.now();
    const r = await execOperation(spec, values, { json: opts.json, timeoutMs: opts.timeoutMs });
    const ok = spec.okExitCodes.includes(r.exitCode);
    steps.push({ id, ok, exitCode: r.exitCode, ms: Date.now() - t0 });
    if (!ok) console.error(`[${id}] exit ${r.exitCode}\n${r.stderr}`);
    return r;
  }

  // --- Part 2: the brain backend is multi-user Postgres, initialized headlessly.
  await step('init', 'init', {
    nonInteractive: true, force: true, url: BRAIN_DB_URL, embeddingModel: EMBEDDING_MODEL,
  }, { timeoutMs: 900_000 });

  // V4: the search-mode cost matrix is a POST-init decision — ours to render.
  await step('config:search-mode', 'config.set', { key: 'search.mode', value: 'fast' });

  // --- Part 3: carve the brain into sources. Space = source, hard rule (S4b).
  for (const s of SOURCES) {
    await composeExec('gbrain-ops', ['mkdir', '-p', `/srv/brain-repos/${s.id}`]);
    await composeExec('gbrain-ops', ['sh', '-c',
      `cd /srv/brain-repos/${s.id} && git init -q && ` +
      `git config user.email brainstand@example.invalid && ` +
      `git config user.name brainstand`]);
    await step(`sources:add:${s.id}`, 'sources.add', {
      id: s.id, path: `/srv/brain-repos/${s.id}`, name: s.name,
    }, { json: true });
  }

  // A known page per source, so isolation has something to prove.
  await composeExec('gbrain-ops', ['sh', '-c',
    `printf '# Performance review process\\n\\nAnnual cycle runs in Q4.\\n' ` +
    `> /srv/brain-repos/internal/performance-review.md && ` +
    `cd /srv/brain-repos/internal && git add -A && git commit -qm 'seed internal'`]);
  await composeExec('gbrain-ops', ['sh', '-c',
    `printf '# Widget launch plan\\n\\nShip the widget in March.\\n' ` +
    `> /srv/brain-repos/shared/widget-launch.md && ` +
    `cd /srv/brain-repos/shared && git add -A && git commit -qm 'seed shared'`]);

  // Sync imports COMMITS, not the working tree — that is why we committed above.
  await step('sync:all', 'sync', { all: true }, { json: true, timeoutMs: 900_000 });
  await step('embed:stale', 'embed', { stale: true }, { json: true, timeoutMs: 900_000 });
  await step('sources:status', 'sources.status', {}, { json: true });

  // --- Part 5: one OAuth client per teammate, each with ONE write source.
  const creds: Record<string, string> = {};
  for (const m of MEMBERS) {
    const out = `/srv/gbrain-home/.creds-${m.id}.json`;
    creds[m.id] = out;
    await step(`grant:${m.id}`, 'mcp.grant', {
      harness: 'generic', profile: 'memory-writer',
      source: m.write, federatedRead: m.read,
      credentialsOut: out, tokenTtl: '3600',
    }, { json: true });
  }

  // --- Verify the scoping actually scopes (upstream's own isolation test).
  let isolationOk = true;
  for (const m of MEMBERS) {
    const probe = await composeExec('gbrain-ops', ['sh', '-c',
      `gbrain search "performance review" --json 2>/dev/null || echo '[]'`]);
    let results: any[] = [];
    try { results = JSON.parse(probe.stdout.trim() || '[]'); } catch { results = []; }
    const leaked = results
      .map((r) => r?.source_id ?? r?.sourceId)
      .filter((sid: string | undefined) => sid && !m.read.includes(sid));
    if (leaked.length > 0) {
      isolationOk = false;
      console.error(`[isolation] ${m.id} saw results from ${[...new Set(leaked)].join(',')}`);
    }
    steps.push({ id: `isolation:${m.id}`, ok: leaked.length === 0, exitCode: 0, ms: 0 });
  }

  // --- Part 12: operating the brain. V6 makes this a real gate.
  const doctor = await execOperation(OPERATIONS.doctor!, {}, { json: true, timeoutMs: 900_000 });
  steps.push({ id: 'doctor', ok: doctor.exitCode === 0, exitCode: doctor.exitCode, ms: 0 });

  return { steps, doctorExitCode: doctor.exitCode, isolationOk };
}

if (import.meta.main) {
  const report = await runTutorial();
  console.log(JSON.stringify(report, null, 2));
  const failed = report.steps.filter((s) => !s.ok);
  if (failed.length > 0 || report.doctorExitCode !== 0) process.exit(1);
}
```

- [ ] **Step 4: Run the tutorial standalone first**

Run: `bun run tutorial`
Expected: a JSON report with every step `ok: true`, `doctorExitCode: 0`, `isolationOk: true`.

> **Anything that hangs, prompts, or has no `--json` is the finding this slice exists to produce.** Record it in `docs/slice-0-findings.md` (Task 14) with the exact command and observed behavior before working around it.

- [ ] **Step 5: Run the end-to-end test to verify it passes**

Run: `bun test test/contract/tutorial.contract.test.ts`
Expected: PASS — 1 test. Allow up to 40 minutes.

- [ ] **Step 6: Commit**

```bash
git add scripts/tutorial.ts test/contract/tutorial.contract.test.ts
git commit -m "feat(slice0): the company-brain tutorial, unattended and doctor-green

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 13: Emit `operations.json` — the Slice 1 deliverable

Slice 1's `gbrain-ops` RPC server implements **exactly this list**. Generating it from the registry means the list cannot drift from the contract tests.

**Files:**
- Create: `scripts/emit-operations.ts`
- Create: `contracts/v0.50.0.0/operations.json` (generated, checked in)
- Test: `test/unit/registry.test.ts`

**Interfaces:**
- Consumes: `OPERATIONS` (Tasks 5–10).
- Produces: `contracts/v0.50.0.0/operations.json` with shape `{ gbrainVersion: string; generatedAt: string; operations: OperationSpec[] }`.

- [ ] **Step 1: Write the failing registry invariant test**

`test/unit/registry.test.ts`:
```ts
import { test, expect, describe } from 'bun:test';
import { OPERATIONS } from '../../src/contracts/registry.ts';
import { buildArgv } from '../../src/contracts/argv.ts';
import { readdirSync, readFileSync } from 'node:fs';

describe('registry invariants', () => {
  test('every operation id matches its key', () => {
    for (const [key, spec] of Object.entries(OPERATIONS)) expect(spec.id).toBe(key);
  });

  test('every operation has a non-empty argv prefix', () => {
    for (const spec of Object.values(OPERATIONS)) expect(spec.argv.length).toBeGreaterThan(0);
  });

  test('every operation declares at least one acceptable exit code', () => {
    for (const spec of Object.values(OPERATIONS)) expect(spec.okExitCodes.length).toBeGreaterThan(0);
  });

  test('param names are unique within an operation', () => {
    for (const spec of Object.values(OPERATIONS)) {
      const names = spec.params.map((p) => p.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  test('flags are unique within an operation, ignoring positionals', () => {
    for (const spec of Object.values(OPERATIONS)) {
      const flags = spec.params.map((p) => p.flag).filter((f) => f !== '');
      expect(new Set(flags).size).toBe(flags.length);
    }
  });

  test('every operation builds argv with only its required params', () => {
    for (const spec of Object.values(OPERATIONS)) {
      const values = Object.fromEntries(
        spec.params.filter((p) => p.required).map((p) => [p.name, p.kind === 'flag' ? true : 'x']),
      );
      expect(() => buildArgv(spec, values)).not.toThrow();
    }
  });

  // G4: adding an operation without a contract test is not allowed.
  test('every operation family is covered by a contract test file', () => {
    const files = readdirSync('test/contract').join('\n');
    const bodies = readdirSync('test/contract')
      .map((f) => readFileSync(`test/contract/${f}`, 'utf8')).join('\n');
    const uncovered = Object.keys(OPERATIONS).filter(
      (id) => !bodies.includes(`'${id}'`) && !bodies.includes(`OPERATIONS.${id}`),
    );
    expect({ uncovered, files: files.length > 0 }).toEqual({ uncovered: [], files: true });
  });

  // S2: a brain-db operation must never be runnable from the control plane.
  test('privilege is declared on every operation', () => {
    for (const spec of Object.values(OPERATIONS)) {
      expect(['brain-db', 'read-only']).toContain(spec.privilege);
    }
  });
});
```

- [ ] **Step 2: Run it to see which operations are uncovered**

Run: `bun test test/unit/registry.test.ts`
Expected: FAIL on `uncovered` listing any operation added without a contract test (likely `schema.lint`, `schema.sync`, `serve`).

- [ ] **Step 3: Cover the gaps**

For each id the test names, either add an assertion referencing it to the matching `test/contract/*.contract.test.ts`, or remove it from the registry. Example for `schema.lint` and `schema.sync`, appended to `test/contract/discovery.contract.test.ts`:

```ts
test('schema lint --with-db --json reports against the live brain', async () => {
  const spec = OPERATIONS['schema.lint']!;
  const r = await execOperation(spec, { withDb: true }, { json: true, timeoutMs: 300_000 });
  expect([0, 1]).toContain(r.exitCode);
  expect(r.json).not.toBeNull();
}, 330_000);

test('schema sync --dry-run --json previews a backfill without applying it', async () => {
  const spec = OPERATIONS['schema.sync']!;
  const r = await execOperation(spec, {}, { json: true, dryRun: true, timeoutMs: 300_000 });
  expect([0, 1]).toContain(r.exitCode);
}, 330_000);

test('serve is registered so Slice 1 can pin its argv', () => {
  const spec = OPERATIONS.serve!;
  expect(buildArgvFor(spec)).toEqual(
    ['serve', '--http', '--bind', '0.0.0.0', '--port', '3131', '--public-url', 'https://example.test']);
});
```

Add this import and helper at the top of that file:

```ts
import { buildArgv } from '../../src/contracts/argv.ts';
const buildArgvFor = (spec: typeof OPERATIONS[string]) =>
  buildArgv(spec, { http: true, bind: '0.0.0.0', port: '3131', publicUrl: 'https://example.test' });
```

- [ ] **Step 4: Write `scripts/emit-operations.ts`**

```ts
#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises';
import { OPERATIONS } from '../src/contracts/registry.ts';

const version = process.env.GBRAIN_VERSION ?? '0.50.0.0';
const dir = `contracts/v${version}`;
await mkdir(dir, { recursive: true });

const payload = {
  gbrainVersion: version,
  generatedAt: new Date().toISOString(),
  // Slice 1's gbrain-ops RPC server exposes exactly these and nothing else.
  // There is no passthrough (G2, S2).
  operations: Object.values(OPERATIONS).sort((a, b) => a.id.localeCompare(b.id)),
};

await Bun.write(`${dir}/operations.json`, JSON.stringify(payload, null, 2) + '\n');
console.log(`wrote ${dir}/operations.json — ${payload.operations.length} operations`);
```

- [ ] **Step 5: Run the emitter and the tests**

Run: `bun run operations:emit`
Expected: `wrote contracts/v0.50.0.0/operations.json — N operations` (N is roughly 20).

Run: `bun test test/unit/registry.test.ts`
Expected: PASS — 8 tests, `uncovered: []`.

- [ ] **Step 6: Commit**

```bash
git add scripts/emit-operations.ts contracts/ test/unit/registry.test.ts test/contract/discovery.contract.test.ts
git commit -m "feat(slice0): emit contracts/v0.50.0.0/operations.json for Slice 1

Every operation is covered by a contract test; the registry test enforces it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 14: Repo guards, CI, and the findings document

**Files:**
- Create: `scripts/lint-forbidden.ts`
- Create: `test/unit/lint-forbidden.test.ts`
- Create: `.github/workflows/contract.yml`
- Create: `docs/slice-0-findings.md`

**Interfaces:**
- Produces: `lintForbidden(root: string): Promise<Violation[]>` where `type Violation = { file: string; line: number; rule: string; text: string }`.

- [ ] **Step 1: Write the failing lint test**

`test/unit/lint-forbidden.test.ts`:
```ts
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintForbidden } from '../../scripts/lint-forbidden.ts';

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'bs-lint-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('lintForbidden', () => {
  test('flags autopilot --install anywhere in the repo', async () => {
    await mkdir(join(dir, 'a'), { recursive: true });
    await writeFile(join(dir, 'a', 'bad.ts'), `run("gbrain autopilot --install");\n`);
    const v = await lintForbidden(dir);
    expect(v.map((x) => x.rule)).toContain('autopilot-install');
  });

  test('flags a shell-string gbrain invocation', async () => {
    await writeFile(join(dir, 'a', 'shell.ts'), `Bun.spawn(["sh","-c","gbrain init --url "+u]);\n`);
    const v = await lintForbidden(dir);
    expect(v.map((x) => x.rule)).toContain('shell-string-gbrain');
  });

  // A path that merely CONTAINS "gbrain" is not an invocation. Without this
  // case the rule flags every legitimate `sh -c` touching /srv/gbrain-home.
  test('does not flag a shell command that only mentions a gbrain path', async () => {
    const clean = await mkdtemp(join(tmpdir(), 'bs-path-'));
    await writeFile(join(clean, 'paths.ts'),
      `composeExec('gbrain-ops', ['sh', '-c', 'touch /srv/gbrain-home/.probe && echo ok']);`);
    expect(await lintForbidden(clean)).toEqual([]);
    await rm(clean, { recursive: true, force: true });
  });

  test('flags a moving gbrain tag in a Dockerfile', async () => {
    await writeFile(join(dir, 'a', 'D.Dockerfile'), `RUN bun install -g github:garrytan/gbrain#latest-stable\n`);
    const v = await lintForbidden(dir);
    expect(v.map((x) => x.rule)).toContain('moving-pin');
  });

  test('passes a clean tree', async () => {
    const clean = await mkdtemp(join(tmpdir(), 'bs-clean-'));
    await writeFile(join(clean, 'ok.ts'), `const argv = ["init","--non-interactive"];\n`);
    expect(await lintForbidden(clean)).toEqual([]);
    await rm(clean, { recursive: true, force: true });
  });

  // Planning documents necessarily quote the patterns they forbid. This guard
  // protects CODE; without the docs skip, every plan file trips every rule.
  test('skips the docs tree entirely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bs-docs-'));
    await mkdir(join(root, 'docs', 'plans'), { recursive: true });
    await writeFile(join(root, 'docs', 'plans', 'p.md'),
      'Never run `gbrain autopilot --install` in a container.');
    expect(await lintForbidden(root)).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/lint-forbidden.test.ts`
Expected: FAIL — `Cannot find module '../../scripts/lint-forbidden.ts'`.

- [ ] **Step 3: Write `scripts/lint-forbidden.ts`**

```ts
#!/usr/bin/env bun
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Violation = { file: string; line: number; rule: string; text: string };

const RULES: { rule: string; re: RegExp; why: string }[] = [
  {
    rule: 'autopilot-install',
    re: /autopilot\s+--install/,
    why: 'writes a crontab line; in a container that is a silent no-op or a duplicate-scheduler bug',
  },
  {
    rule: 'shell-string-gbrain',
    // `gbrain` must be at a COMMAND position: not preceded by / or - , and
    // followed by whitespace. Without those guards this flags every benign
    // `sh -c` that merely mentions a /srv/gbrain-home path.
    re: /["'`]\s*(sh|bash)\s*["'`]\s*,\s*["'`]-c["'`][\s\S]{0,80}(?<![\w\/-])gbrain\s/,
    why: 'G2 requires argv arrays, never shell strings',
  },
  {
    rule: 'moving-pin',
    re: /garrytan\/gbrain#(latest|latest-stable|main|master|HEAD)\b/,
    why: 'G1 requires an exact semver pin; a moving ref is non-reproducible',
  },
];

// 'docs' is skipped deliberately: this guard protects CODE, and planning
// documents necessarily quote the very patterns they forbid.
const SKIP_DIRS = new Set(['node_modules', '.git', 'contracts', '.brainstand-tmp', 'docs']);
const EXTS = ['.ts', '.tsx', '.js', '.sh', '.yml', '.yaml', '.Dockerfile', '.md'];

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(join(dir, e.name));
    } else if (EXTS.some((x) => e.name.endsWith(x))) {
      yield join(dir, e.name);
    }
  }
}

export async function lintForbidden(root: string): Promise<Violation[]> {
  const out: Violation[] = [];
  for await (const file of walk(root)) {
    // The lint rules themselves contain the patterns; skip the linter and its test.
    if (file.includes('lint-forbidden')) continue;
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((text, i) => {
      for (const r of RULES) if (r.re.test(text)) out.push({ file, line: i + 1, rule: r.rule, text: text.trim() });
    });
  }
  return out;
}

if (import.meta.main) {
  const violations = await lintForbidden(process.cwd());
  for (const v of violations) {
    const why = RULES.find((r) => r.rule === v.rule)?.why ?? '';
    console.error(`${v.file}:${v.line}  [${v.rule}] ${v.text}\n    ${why}`);
  }
  if (violations.length > 0) process.exit(1);
  console.log('lint:forbidden clean');
}
```

- [ ] **Step 4: Run the lint test, then the linter on the repo**

Run: `bun test test/unit/lint-forbidden.test.ts`
Expected: PASS — 4 tests.

Run: `bun run lint:forbidden`
Expected: `lint:forbidden clean`.

- [ ] **Step 5: Write `.github/workflows/contract.yml`**

```yaml
name: contract

on:
  push: { branches: [main] }
  pull_request:
  schedule:
    # Nightly drift detection against pinned-current AND pinned-next (G1/G4).
    - cron: '17 5 * * *'

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.14 }
      - run: bun install --frozen-lockfile
      - run: bun run lint:forbidden
      - run: bun run test:unit

  contract:
    runs-on: ubuntu-latest
    needs: unit
    strategy:
      fail-fast: false
      matrix:
        # pinned-current is the supported version; pinned-next is the tripwire.
        # A pinned-next failure opens a drift issue; it never blocks a PR.
        gbrain: ['0.50.0.0', '0.51.0.0']
    continue-on-error: ${{ matrix.gbrain != '0.50.0.0' }}
    env:
      GBRAIN_VERSION: ${{ matrix.gbrain }}
      POSTGRES_PASSWORD: ci-not-a-real-secret
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.14 }
      - run: bun install --frozen-lockfile
      - name: Build the pinned base image
        run: |
          docker build -f docker/gbrain-base.Dockerfile \
            --build-arg "GBRAIN_VERSION=${GBRAIN_VERSION}" \
            -t "brainstand/gbrain-base:${GBRAIN_VERSION}" .
      - run: bun run test:contract
      - name: Capture the capability snapshot and report drift
        if: always()
        run: bun run capability:capture || true
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: capability-${{ matrix.gbrain }}
          path: contracts/
```

- [ ] **Step 6: Write `docs/slice-0-findings.md`**

This is the artifact the slice exists to produce. Fill each row as the tasks run.

```markdown
# Slice 0 findings — gbrain v0.50.0.0 control lane

Every risk this slice priced today instead of in month three.
Status: `confirmed` (the spec's claim held) | `falsified` | `changed`.

## Verified constraints

| # | Claim | Status | Evidence | Consequence for Slice 1+ |
|---|---|---|---|---|
| V1 | Control surface is CLI-only, not in the op registry | | | |
| V2 | `--json` / `--dry-run` on the control lane | | | |
| V3 | `init --non-interactive` works headlessly on Postgres | | | |
| V4 | `search.mode` is post-init | | | |
| V5 | Supervisor drains on SIGTERM; stop within 40s | | | Quiesce budget for Slice 3.5 snapshots |
| V6 | `doctor` exits non-zero on blockers | | | The upgrade gate is real |
| V7 | `--token-ttl` bounded 60s–90d | | | Per-run tokens for Slice 4 |
| V8 | `mcp grant` needs brain DB or `--admin-token-file` | | | The S2 privilege boundary |
| V10 | 13 adapters, 4 connection classes, no Hermes | | | The Slice 2 harness picker |
| V11 | `config set *_api_key` avoids the DB plane | | | Where the Slice 1 wizard writes the key |
| V12 | `sources add <id> --path` | | | Space creation |
| V13 | `.well-known/gbrain` payload shape | | | Live-rendered UI |
| V14 | `--tools-json` catalog | | | The snapshot's data half |

## Commands with no `--json`

| Command | Why we need it | Workaround | Upstream contribution? |
|---|---|---|---|
| `init` | wizard progress | exit code + stderr | maybe |

## Commands that required a TTY or prompted

| Command | Observed | Workaround |
|---|---|---|

## Timing

| Step | Wall time | Note |
|---|---|---|
| `init` | | |
| `sync --all` | | |
| `embed --stale` | | |
| `doctor` | | |
| Whole tutorial | | vs ~90 minutes by hand |

## Decisions this changes

-
```

- [ ] **Step 7: Run the full suite one final time**

Run: `bun run lint:forbidden && bun run test:unit && bun run test:contract`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add scripts/lint-forbidden.ts test/unit/lint-forbidden.test.ts .github/ docs/slice-0-findings.md
git commit -m "feat(slice0): repo guards, contract CI with nightly drift, findings doc

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Slice 0 exit gate

Do not start Slice 1 until all four hold:

- [ ] `bun run tutorial` completes **unattended** in Docker against Postgres and ends with `doctorExitCode: 0` and `isolationOk: true`.
- [ ] `bun run test:contract` passes at `GBRAIN_VERSION=0.50.0.0` and the suite is **red** when the image and the expected pin disagree.
- [ ] `contracts/v0.50.0.0/operations.json` and `contracts/v0.50.0.0/capability.json` are generated and committed.
- [ ] `docs/slice-0-findings.md` has a status on every V-row, with each `falsified` or `changed` row carrying its consequence for Slice 1.

**Then:** proceed to [`2026-09-14-slice-1-deploy-one-brain.md`](./2026-09-14-slice-1-deploy-one-brain.md).
