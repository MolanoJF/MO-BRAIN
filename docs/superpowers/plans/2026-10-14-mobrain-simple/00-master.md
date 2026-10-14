# Mo-brain Simplified: Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute the phase files in order; each phase ends with working, tested software and a commit.

**Goal:** Replace the 55k-line Mo-brain v1 with a small product: gbrain in a four-container stack, an install skill, collector skills run by the person's own agent on a host timer, a read-mostly review UI, and a thin people layer for company mode.

**Architecture:** `postgres` + `gbrain` (serve --http) + `autopilot` (gbrain autopilot, foreground) + `mobrain` (Bun/Hono API + React UI, built FROM the gbrain image). People, invites, grants and collector run history live in a small `mobrain` database; every access decision about brain data is pushed down to gbrain clients (`mcp grant` / `auth rescope-client` / `auth revoke-client`). A bash CLI, `bin/mobrain`, drives the stack and the collectors.

**Tech Stack:** Bun 1.4.x, TypeScript, Hono 4, `postgres` (porsager) 3, React 19, Vite 8, Tailwind 4, `marked` + `dompurify`, bash, Docker Compose 2.20+, gbrain `0.60.230.0`, Postgres 16 + pgvector.

**Spec:** `docs/superpowers/specs/2026-10-14-mobrain-simple-design.md` (read it before any task; section numbers below refer to it).

## Phase files

| # | File | Produces | Depends on |
|---|---|---|---|
| 1 | `01-freeze-and-reset.md` | WIP committed, `v1-final` tag, old code deleted, new skeleton, lint and unit tests green | — |
| 2 | `02-stack-and-probes.md` | gbrain image at 0.60.230.0, compose (postgres, gbrain, autopilot), packs, probes P1–P8 recorded, spec amended | 1 |
| 3 | `03-server-foundation.md` | `mobrain` service: env, DB + migrations, crypto, auth, gbrain adapters, HTTP errors and role table, health, proxy | 2 |
| 4 | `04-people-and-company.md` | compile, rules, people service and routes, invites and claim, clients issue and rotation, offboarding | 3 |
| 5 | `05-schema.md` | core lock, schema view route, pack files and the `mobrain-brain` layer | 3 |
| 6 | `06-collectors.md` | cadence, collector page validation, runner API, pages and sources read routes | 4 |
| 7 | `07-cli.md` | `bin/mobrain` complete (install, stack verbs, people, schema, skills, collect, timers, backup, restore, upgrade) with stub-based tests | 4, 5, 6 |
| 8 | `08-ui.md` | React SPA: Pages, Sources, Schema, Activity, Health, People & access, Connect your agent, login and claim | 4, 5, 6 |
| 9 | `09-skills-and-docs.md` | the five Mo-brain skills, skills bundle and resolver merge, README, INSTALL_FOR_AGENTS, HANDOFF, CLAUDE.md, runbooks | 7 |
| 10 | `10-selftest-and-cutover.md` | `mobrain selftest`, real-harness acceptance on `mobrain-dev`, cutover of `mobrain-molior` | 1–9 |

## Global Constraints

- gbrain pin is exactly `0.60.230.0`. Never a moving ref. Never fork gbrain, import past its `exports`, or read its tables.
- gbrain CLI is always invoked with an argv array (`Bun.spawn([...])`), never through a shell string. `lint:forbidden` enforces this.
- Never run `gbrain autopilot --install` in a container.
- Never mount the Docker socket into any container.
- Only `mobrain` publishes a host port, and only on `127.0.0.1`.
- `.env` is written once with mode `0600` and never regenerated. `git add .env` is forbidden.
- The HKDF domain separator `mobrain-kek-v1` is frozen.
- No `schedule:` triggers and no new push/PR workflows. Only `ci.yml` runs on push/PR. Do not iterate on CI; run suites locally, push once (`CLAUDE.md`).
- Develop and test only against compose projects `mobrain-dev` and `mobrain-selftest`. Never run tests, `down -v`, restore or anything destructive against `mobrain-molior` (`CLAUDE.local.md`). `bin/mobrain down -v` refuses any other project; `selftest` always uses its own `mobrain-selftest` project and env file.
- The VPS has 2 vCPUs: stop the dev stack when not in use (`bin/mobrain down` from `~/MO-BRAIN`, whose `.env` names `mobrain-dev`).
- Every people/access mutation writes an `audit_log` row.
- Client tokens of purpose `agent` and `company_writer` are shown once and never stored. `ui` and `instance` tokens are stored sealed.
- Commit after every task. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Shared interfaces (every phase uses these exact names)

```ts
// src/server/types.ts  (created in phase 3, task 3.1)
export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export type Mode = 'personal' | 'company';
export type UserStatus = 'invited' | 'active' | 'offboarding' | 'disabled';
export type SourceKind = 'private' | 'company';
export type ClientPurpose = 'agent' | 'ui' | 'instance' | 'company_writer';

export type User = { id: string; email: string; name: string | null; role: Role; status: UserStatus; createdAt: Date };
export type Source = { id: string; kind: SourceKind; ownerUserId: string | null; name: string; status: 'active' | 'archived' };
export type Grant = { userId: string; sourceId: string; agentReads: boolean };

export type ClientSpec = {
  purpose: ClientPurpose;
  userId: string | null;
  name: string;            // gbrain client name, deterministic (compile.ts clientName)
  profile: string;         // gbrain grant profile
  writeSource: string;     // gbrain source id
  readSources: string[];   // federated read, sorted, excludes writeSource
};

export type IssuedClient = { clientId: string; token: string; expiresAt: Date | null };
```

```ts
// src/server/gbrain/admin.ts  (phase 3, task 3.6)
export interface GbrainAdmin {
  createClient(spec: ClientSpec): Promise<IssuedClient>;
  rescopeClient(clientId: string, spec: ClientSpec): Promise<void>;
  revokeClient(clientId: string): Promise<void>;
  addSource(id: string, name: string): Promise<void>;
  archiveSource(id: string): Promise<void>;
}

// src/server/gbrain/mcp.ts  (phase 3, task 3.5)
export type McpCaller = <T = unknown>(tool: string, args: Record<string, unknown>) => Promise<T>;
export function mcpCaller(url: string, token: string, fetchImpl?: typeof fetch): McpCaller;

// src/server/gbrain/cli.ts  (phase 3, task 3.4)
export type CliResult = { exitCode: number; stdout: string; stderr: string };
export function runGbrain(argv: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }): Promise<CliResult>;
export function scrub(text: string): string;
export function lastJson(stdout: string): unknown;
```

```ts
// src/server/app.ts  (phase 3, task 3.9) — dependency container passed to every router
export type Deps = {
  sql: import('postgres').Sql;
  env: import('./env.ts').Env;
  admin: GbrainAdmin;
  mcp: (token: string) => McpCaller;
  cli: typeof runGbrain;
  fetch: typeof fetch;     // used for gbrain /health and the proxy; tests pass a fake
  now: () => Date;
};
export function createApp(deps: Deps): import('hono').Hono;
```

## Review Focus

These are the five failure modes most likely to bite a person that no single task's happy-path test covers. Each has a pinned test in the task named.

1. **A rescope that fails halfway leaves a person with wider access than their grants.** Expected: the DB change and the gbrain rescope are ordered so a failure leaves access narrower, never wider, and the next reconcile converges. Test: phase 4, task 4.5 (`reconcile narrows before it widens`).
2. **An agent token expires after 90 days and collectors silently stop.** Expected: `mobrain collect --due` rotates the agent token when it is within 14 days of expiry and re-registers the harness MCP; the UI shows the expiry. Tests: phase 4, task 4.7 (issue rotates); phase 7, task 7.5 (`rotate-if-expiring` re-issues inside the window, only when registered).
3. **A collector that crashes or times out leaves a `running` row forever and is never retried.** Expected: a run older than its timeout counts as finished (`timeout`) for due computation, and the UI shows it. Test: phase 6, task 6.2 (`stale running row is due again`).
4. **Someone edits `mobrain-brain` with gbrain directly and shadows a core type.** Expected: Health and `mobrain status` report `coreLock.ok=false` with the offending names. Test: phase 5, task 5.1.
5. **A second `mobrain install` on a host with an existing stack or `.env` clobbers it.** Expected: install refuses (exit 17) without touching anything. Test: phase 7, task 7.3.

## Execution notes

- Phase 2 can change constants and fallbacks used by phases 3–7. Its last task amends the spec and lists the exact edits to later phase files; do those edits before starting phase 3.
- Unit tests: `bun run test:unit` (pure, no Docker, runs in CI). DB tests: `bun run test:db` (needs the throwaway Postgres from `scripts/test-db.sh`; local only). CLI tests live in `test/unit/cli/` and use stub binaries.
- After each phase: `bun run lint:forbidden && bun run test:unit` (and `bun run test:db` from phase 3 on) must be green before the phase commit.
