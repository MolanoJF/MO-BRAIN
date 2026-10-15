# Phase 7: The `bin/mobrain` CLI

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Read `00-master.md` first.

**Goal:** One bash script that installs and operates the stack (stack host only) and runs collectors, timers, people commands, client issue and skills install (any machine with `curl` and the harness). Every command is tested by running the real script against stub binaries.

**Spec sections:** §7, §8.3, §10, §11, §12.

**Portability:** bash 4+, `curl`, coreutils (`timeout` or `gtimeout`), `sha256sum` or `shasum`, `tar`. No `jq`, no `flock` (locks are `mkdir`), no `openssl` (randomness from `/dev/urandom`). The script never builds a shell string around `gbrain` or `claude`; it runs argv arrays (`"${cmd[@]}"`).

**Server output formats the script relies on (task 7.1):** `?format=env` (lines `key=value`) and `?format=tsv` (tab-separated, no header). The script never parses JSON except one `sed` for `runId`.

---

### Task 7.1: CLI-friendly server formats

**Files:**
- Modify: `src/server/routes/people.ts` (`GET /api/people?format=tsv`, `POST /api/clients/issue?format=env`, `GET /api/clients/me?format=tsv`)
- Modify: `src/server/routes/runner.ts` (`GET /api/runner/due?slug=<s>`)
- Modify: `src/server/collectors/service.ts` (`one(user, slug)`)
- Modify: `src/server/admin-cli.ts` (`--format env`)
- Modify: `compose/docker-compose.yml` (`TZ` on `mobrain` and `autopilot`)
- Test: `test/db/cli-formats.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/db/cli-formats.test.ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { world, type TestWorld } from './app.ts';
import { runAdminCli } from '../../src/server/admin-cli.ts';
import type { McpCaller } from '../../src/server/gbrain/mcp.ts';

let w: TestWorld; let key: string;
beforeAll(async () => {
  w = await world({
    mcp: () => (async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'list_pages') return { pages: [{ slug: 'system/collectors/mail', source_id: 'p-own' }] };
      if (tool === 'get_page') return { slug: args.slug, source_id: 'p-own',
        content: '---\ntype: collector\nkind: email\ncadence: 2h\nallowed_tools: [mcp__g__*]\ntarget_source: p-own\n---\n' };
      return {};
    }) as McpCaller,
  });
  const out = await runAdminCli(['bootstrap', '--email', 'own@x.io', '--format', 'env'], w.deps);
  expect(out).toMatch(/^MOBRAIN_USER_ID=.+\nMOBRAIN_API_KEY=mbk_.+\nMOBRAIN_OWNER_PASSWORD=.+$/);
  key = /MOBRAIN_API_KEY=(.+)/.exec(out)![1]!;
});
afterAll(async () => w.drop());

test('people tsv', async () => {
  const t = await (await w.req('/api/people?format=tsv', { as: key })).text();
  expect(t).toMatch(/^[0-9a-f-]{36}\town@x\.io\towner\tactive\n$/);
});

test('client issue env and clients tsv with days left', async () => {
  const e = await (await w.req('/api/clients/issue?format=env', { method: 'POST', body: '{"purpose":"agent"}', as: key })).text();
  expect(e).toMatch(/^token=tok-.+\nmcp_url=http:\/\/127\.0\.0\.1:8787\/mcp\nname=gbrain\nexpires_at=.+\n$/);
  const t = await (await w.req('/api/clients/me?format=tsv', { as: key })).text();
  expect(t.split('\n').filter(Boolean).map((l) => l.split('\t')[0]).sort()).toEqual(['agent', 'ui']);
  expect(t).toMatch(/agent\tp-own\t\S+\t(89|90)\n/);
});

test('due?slug returns that collector even when not due', async () => {
  await w.req('/api/runner/start', { method: 'POST', body: '{"slug":"system/collectors/mail","source":"p-own"}', as: key });
  const t = await (await w.req('/api/runner/due?slug=system/collectors/mail', { as: key })).text();
  expect(t).toBe('system/collectors/mail\tp-own\temail\tmcp__g__*\t\t1200\tbackfill\n');
});
```

Run: `bun run test:db` — Expected: FAIL.

- [ ] **Step 2: Implement**

In `admin-cli.ts`, `bootstrap`: if `flag(argv, 'format') === 'env'`, return
```ts
`MOBRAIN_USER_ID=${r.userId}\nMOBRAIN_API_KEY=${r.apiKey}\nMOBRAIN_OWNER_PASSWORD=${r.password}`
```
(where `r` is the bootstrap result), else the JSON as before.

In `people.ts`:

```ts
  // inside GET /api/people, before building the JSON:
  if (c.req.query('format') === 'tsv') {
    return c.text(users.map((u) => [u.id, u.email, u.role, u.status].join('\t')).join('\n') + '\n');
  }
```

```ts
  // replace the body of POST /api/clients/issue:
    const user = requireUser(c);
    const { purpose, sourceId } = await jsonBody<{ purpose?: string; sourceId?: string }>(c);
    let issued;
    if (purpose === 'agent') issued = await people.issueAgent(user);
    else if (purpose === 'company_writer' && sourceId) issued = await people.issueCompanyWriter(user, sourceId);
    else throw new HttpError(400, 'invalid_purpose');
    if (c.req.query('format') === 'env') {
      return c.text(`token=${issued.token}\nmcp_url=${issued.mcpUrl}\nname=${issued.registrationName}\nexpires_at=${issued.expiresAt?.toISOString() ?? ''}\n`);
    }
    return c.json(issued);
```

```ts
  // replace GET /api/clients/me:
  r.get('/api/clients/me', async (c) => {
    const clients = await people.myClients(requireUser(c));
    if (c.req.query('format') === 'tsv') {
      const now = deps.now().getTime();
      return c.text(clients.map((k) => [k.purpose, k.writeSource ?? '', k.expiresAt?.toISOString() ?? '-',
        k.expiresAt ? String(Math.floor((k.expiresAt.getTime() - now) / 86400_000)) : '-'].join('\t')).join('\n') + '\n');
    }
    return c.json({ clients });
  });
```

In `collectors/service.ts` add:

```ts
  async one(user: User, slug: string): Promise<{ config: CollectorConfig; mode: 'backfill' | 'incremental' } | null> {
    const sources = await this.runnableSources(user);
    const hit = (await this.collectors(user, sources)).find((e) => e.slug === slug);
    if (!hit || !hit.ok) return null;
    const [ok] = await this.d.sql`select 1 from collector_runs where source_id = ${hit.source} and collector = ${slug} and status = 'ok' limit 1`;
    return { config: hit.config, mode: ok ? 'incremental' : 'backfill' };
  }
```

In `runner.ts`, `GET /api/runner/due`: when `c.req.query('slug')` is set, use `svc.one(...)`; a `null` result is `404 { error: 'collector_not_found' }`; otherwise the same one-line TSV.

In `compose/docker-compose.yml` add `TZ: ${TZ:-UTC}` to the `environment` of `autopilot` and `mobrain`.

- [ ] **Step 3: Run** — `bun run test:db` — Expected: PASS. **Commit:**

```bash
git add src/server compose/docker-compose.yml test/db/cli-formats.test.ts
git commit -m "feat(server): env/tsv formats for the CLI, single-collector lookup, TZ

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7.2: Script skeleton, stub test harness, stack verbs, status

**Files:**
- Create: `bin/mobrain` (executable)
- Create: `test/unit/cli/harness.ts`
- Test: `test/unit/cli/basics.test.ts`

- [ ] **Step 1: Write the test harness**

```ts
// test/unit/cli/harness.ts
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const BIN = join(import.meta.dir, '..', '..', '..', 'bin', 'mobrain');

export type Cli = Awaited<ReturnType<typeof cliWorld>>;

/** A temp HOME, a stub-bin dir first on PATH, and a log of every stub call. */
export async function cliWorld() {
  const root = await mkdtemp(join(tmpdir(), 'mb-cli-'));
  const home = join(root, 'home'); const stubs = join(root, 'stubs'); const log = join(root, 'calls.log');
  await mkdir(home, { recursive: true }); await mkdir(stubs);
  await writeFile(log, '');
  const env: Record<string, string> = {
    HOME: home, PATH: `${stubs}:/usr/bin:/bin`, STUB_LOG: log, USER: 'tester', LANG: 'C',
    // A path with no checkout, so the real repo never leaks into a test. Tests that
    // need a stack host pass their own MOBRAIN_REPO.
    MOBRAIN_REPO: join(root, 'no-repo'),
  };
  return {
    root, home, stubs, env,
    /** Write a stub binary. `body` runs after the call is logged; "$@" holds the args. */
    async stub(name: string, body = 'exit 0') {
      const p = join(stubs, name);
      await writeFile(p, `#!/usr/bin/env bash\n{ printf '%s' "${name}"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\n'; } >> "$STUB_LOG"\n${body}\n`);
      await chmod(p, 0o755);
    },
    async calls(name?: string): Promise<string[][]> {
      const lines = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((l) => l.split('\x1f'));
      return name ? lines.filter((l) => l[0] === name).map((l) => l.slice(1)) : lines;
    },
    async run(args: string[], extraEnv: Record<string, string> = {}) {
      const p = Bun.spawn(['bash', BIN, ...args], { env: { ...env, ...extraEnv }, stdout: 'pipe', stderr: 'pipe', cwd: root });
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { stdout, stderr, code };
    },
    async runnerEnv(url = 'http://mb.test', key = 'mbk_test') {
      await mkdir(join(home, '.config', 'mobrain'), { recursive: true });
      await writeFile(join(home, '.config', 'mobrain', 'runner.env'), `MOBRAIN_URL=${url}\nMOBRAIN_API_KEY=${key}\n`);
    },
  };
}

/** A curl stub body: route on the URL; print body then "\n<code>" like -w '\n%{http_code}'. */
export function curlRoutes(routes: [pattern: string, code: number, body: string][]): string {
  const cases = routes.map(([p, code, body]) => `  *'${p}'*) printf '%s\\n%s' '${body.replaceAll("'", "'\\''")}' ${code}; exit 0;;`).join('\n');
  return `url="\${@: -1}"\ncase "$url" in\n${cases}\n  *) printf 'not routed\\n404'; exit 0;;\nesac`;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// test/unit/cli/basics.test.ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cliWorld, curlRoutes, type Cli } from './harness.ts';

let c: Cli;
beforeEach(async () => { c = await cliWorld(); });
afterEach(async () => rm(c.root, { recursive: true, force: true }));

async function stackHost(project = 'mobrain-dev') {
  const repo = join(c.root, 'repo');
  await mkdir(join(repo, 'compose'), { recursive: true });
  await writeFile(join(repo, 'compose', 'docker-compose.yml'), 'services: {}\n');
  await writeFile(join(repo, 'compose', 'docker-compose.dev.yml'), 'services: {}\n');
  await writeFile(join(repo, '.env'), `COMPOSE_PROJECT_NAME=${project}\nMOBRAIN_PORT=8788\nGBRAIN_VERSION=0.60.230.0\n`);
  return repo;
}

describe('basics', () => {
  test('no command prints usage and exits 64', async () => {
    const r = await c.run([]);
    expect(r.code).toBe(64);
    expect(r.stderr).toContain('usage: mobrain');
  });

  test('stack verbs pass through to docker compose with the dev overlay for mobrain-dev', async () => {
    const repo = await stackHost();
    await c.stub('docker');
    await c.run(['ps'], { MOBRAIN_REPO: repo });
    const [call] = await c.calls('docker');
    expect(call).toEqual(['compose', '--env-file', join(repo, '.env'), '-f', join(repo, 'compose/docker-compose.yml'),
      '-f', join(repo, 'compose/docker-compose.dev.yml'), 'ps']);
  });

  test('down refuses volumes outside mobrain-dev', async () => {
    const repo = await stackHost('mobrain-molior');
    await c.stub('docker');
    const r = await c.run(['down', '-v'], { MOBRAIN_REPO: repo });
    expect(r.code).toBe(17);
    expect(await c.calls('docker')).toEqual([]);
  });

  test('stack commands refuse off a stack host', async () => {
    const r = await c.run(['ps']);
    expect(r.code).toBe(17);
    expect(r.stderr).toContain('stack host');
  });

  test('status: 0 when healthy, 1 when degraded, 2 when unreachable', async () => {
    await c.runnerEnv();
    await c.stub('curl', curlRoutes([['/api/health', 200, '{"ok":true}']]));
    expect((await c.run(['status'])).code).toBe(0);
    await c.stub('curl', curlRoutes([['/api/health', 503, '{"ok":false}']]));
    expect((await c.run(['status'])).code).toBe(1);
    await c.stub('curl', 'exit 7');
    expect((await c.run(['status'])).code).toBe(2);
  });
});
```

Run: `bash scripts/test-isolated.sh test/unit/cli` — Expected: FAIL (no `bin/mobrain`).

- [ ] **Step 3: Write `bin/mobrain` (skeleton; later tasks add `cmd_*` functions above `main`)**

```bash
#!/usr/bin/env bash
# mobrain: install and operate a Mo-brain stack, and run its collectors.
# Stack commands need a Mo-brain checkout (compose/). Runner commands need only
# curl and the agent harness. Argv arrays only; never a shell string.
set -euo pipefail

PIN=0.60.230.0
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
REPO="${MOBRAIN_REPO:-$(cd "$(dirname "$SELF")/.." && pwd)}"
CONF_DIR="${MOBRAIN_CONFIG_DIR:-$HOME/.config/mobrain}"
STATE_DIR="${MOBRAIN_STATE_DIR:-$HOME/.local/state/mobrain}"
RUNNER_ENV="$CONF_DIR/runner.env"
ENV_FILE="${MOBRAIN_ENV_FILE:-$REPO/.env}"

die() { local code="${2:-1}"; echo "mobrain: $1" >&2; exit "$code"; }

usage() {
  cat >&2 <<'EOF'
usage: mobrain <command> [args]
stack host:  install | up | down | ps | logs <svc> | backup | restore <dir> --yes | upgrade --gbrain <v>
             schema edit --out <file> | schema apply <file> | schema exec -- <args> | selftest
anywhere:    status [--detail] | join --url <u> --key <k> | client issue agent|company-writer <src> [--register]
             client rotate-if-expiring [--days n] | collect --due | collect <slug> [--backfill]
             timers install|remove|status | skills install --dir <d> | schema show | schema check
             mode company|personal | member invite <email> --role <r> | member list | member role <email> <r>
             member offboard <email> | source add <name> | source list | source archive <id>
             grant <email> <source> [--no-agent-reads] | revoke <email> <source>
EOF
  exit 64
}

# ---- helpers ---------------------------------------------------------------

is_stack_host() { [ -f "$REPO/compose/docker-compose.yml" ] && [ -f "$ENV_FILE" ]; }
need_stack() { is_stack_host || die "this command runs on the stack host, from a Mo-brain checkout with a .env" 17; }
env_get() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }
project() { env_get COMPOSE_PROJECT_NAME; }

dc() {
  local files=(-f "$REPO/compose/docker-compose.yml")
  [ "$(project)" = mobrain-dev ] && files+=(-f "$REPO/compose/docker-compose.dev.yml")
  docker compose --env-file "$ENV_FILE" "${files[@]}" "$@"
}

load_runner() {
  if [ -f "$RUNNER_ENV" ]; then set -a; . "$RUNNER_ENV"; set +a; fi
  : "${MOBRAIN_URL:=}" "${MOBRAIN_API_KEY:=}"
}

need_runner() {
  load_runner
  [ -n "$MOBRAIN_URL" ] && [ -n "$MOBRAIN_API_KEY" ] || die "no $RUNNER_ENV; run 'mobrain install' or 'mobrain join' first" 17
}

json_str() {
  local s=$1
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\r'/\\r}; s=${s//$'\t'/\\t}
  printf '"%s"' "$s"
}

kv_get() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -1; }

# api METHOD PATH [JSON] -> body on stdout; HTTP >= 400 is an error.
api() {
  local method=$1 path=$2 body=${3:-} out code
  local args=(-sS -X "$method" -H "authorization: Bearer $MOBRAIN_API_KEY" -w $'\n%{http_code}')
  [ -n "$body" ] && args+=(-H 'content-type: application/json' --data-binary "$body")
  out="$(curl "${args[@]}" "${MOBRAIN_URL%/}$path")" || die "cannot reach $MOBRAIN_URL" 2
  code="${out##*$'\n'}"; out="${out%$'\n'*}"
  if [ "$code" -ge 400 ] 2>/dev/null; then printf '%s\n' "$out" >&2; die "$method $path -> HTTP $code" 1; fi
  printf '%s' "$out"
}

rand_hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
rand_b64() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'; }
tmo() { if command -v timeout >/dev/null; then timeout "$@"; else gtimeout "$@"; fi; }
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }

# ---- stack verbs -------------------------------------------------------------

cmd_up() { need_stack; dc up -d --wait "$@"; }
cmd_ps() { need_stack; dc ps "$@"; }
cmd_logs() { need_stack; dc logs "$@"; }
cmd_down() {
  need_stack
  for a in "$@"; do
    case "$a" in
      -v|--volumes)
        case "$(project)" in mobrain-dev|mobrain-selftest) ;;
          *) die "refusing to delete volumes of $(project); only mobrain-dev and mobrain-selftest may be wiped" 17 ;;
        esac ;;
    esac
  done
  dc down "$@"
}

status_url() {
  load_runner
  if [ -n "$MOBRAIN_URL" ]; then printf '%s' "${MOBRAIN_URL%/}"
  elif is_stack_host; then printf 'http://127.0.0.1:%s' "$(env_get MOBRAIN_PORT)"
  else die "no Mo-brain URL configured" 17; fi
}

cmd_status() {
  local detail=0 url out code
  [ "${1:-}" = --detail ] && detail=1
  url="$(status_url)"
  out="$(curl -sS -w $'\n%{http_code}' "$url/api/health" 2>/dev/null)" || { echo '{"ok":false,"error":"unreachable"}'; exit 2; }
  code="${out##*$'\n'}"; out="${out%$'\n'*}"
  printf '%s\n' "$out"
  if [ "$detail" = 1 ]; then need_runner; api GET /api/admin/health; echo; fi
  [ "$code" = 200 ] || exit 1
}

# ---- main ----------------------------------------------------------------------

main() {
  [ $# -ge 1 ] || usage
  local cmd=$1; shift
  case "$cmd" in
    up) cmd_up "$@" ;;
    down) cmd_down "$@" ;;
    ps) cmd_ps "$@" ;;
    logs) cmd_logs "$@" ;;
    status) cmd_status "$@" ;;
    -h|--help|help) usage ;;
    *) if declare -F "cmd_$cmd" >/dev/null; then "cmd_$cmd" "$@"; else usage; fi ;;
  esac
}

main "$@"
```

Run: `chmod +x bin/mobrain && rm -f bin/.gitkeep`

- [ ] **Step 4: Run** — `bash scripts/test-isolated.sh test/unit/cli` — Expected: PASS. Also `bun run lint:forbidden` — clean.

- [ ] **Step 5: Commit**

```bash
git add bin test/unit/cli
git commit -m "feat(cli): bin/mobrain skeleton, stack verbs, status, stub test harness

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7.3: `install`

**Files:**
- Modify: `bin/mobrain` (add `preflight`, `write_env`, `install_packs`, `cmd_install`)
- Test: `test/unit/cli/install.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/cli/install.test.ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cliWorld, type Cli } from './harness.ts';

let c: Cli; let repo: string;
const dockerOk = `case "$1 $2" in
  "compose version") echo 2.29.1;;
  "compose ls") ${'cat "$STUB_LS" 2>/dev/null || true'};;
esac
case "$*" in
  *admin-cli.ts*bootstrap*) printf 'MOBRAIN_USER_ID=u1\\nMOBRAIN_API_KEY=mbk_abc\\nMOBRAIN_OWNER_PASSWORD=pw123\\n';;
esac
exit 0`;

beforeEach(async () => {
  c = await cliWorld();
  repo = join(c.root, 'repo');
  await mkdir(join(repo, 'compose'), { recursive: true });
  await mkdir(join(repo, 'packs'), { recursive: true });
  await writeFile(join(repo, 'compose', 'docker-compose.yml'), 'services: {}\n');
  await writeFile(join(repo, 'compose', 'docker-compose.dev.yml'), 'services: {}\n');
  await writeFile(join(c.root, 'key.txt'), 'sk-test-123456789\n');
  await c.stub('docker', dockerOk);
});
afterEach(async () => rm(c.root, { recursive: true, force: true }));

const install = (extra: string[] = [], env: Record<string, string> = {}) =>
  c.run(['install', '--owner-email', 'ada@x.io', '--openai-key-file', join(c.root, 'key.txt'), '--port', '18999', ...extra],
    { MOBRAIN_REPO: repo, ...env });

describe('install', () => {
  test('refuses when .env exists, touching nothing (Review Focus #5)', async () => {
    await writeFile(join(repo, '.env'), 'COMPOSE_PROJECT_NAME=mobrain\n');
    const r = await install();
    expect(r.code).toBe(17);
    expect(await readFile(join(repo, '.env'), 'utf8')).toBe('COMPOSE_PROJECT_NAME=mobrain\n');
    expect((await c.calls('docker')).filter((a) => a[1] !== 'version' && a[1] !== 'ls')).toEqual([]);
  });

  test('refuses when the compose project already exists', async () => {
    await writeFile(join(c.root, 'ls.txt'), 'mobrain\n');
    const r = await install([], { STUB_LS: join(c.root, 'ls.txt') });
    expect(r.code).toBe(17);
  });

  test('requires a key file or --keyless', async () => {
    const r = await c.run(['install', '--owner-email', 'a@x.io'], { MOBRAIN_REPO: repo });
    expect(r.code).toBe(64);
  });

  test('happy path: 0600 .env, ordered builds, init, packs, bootstrap, runner.env, receipt', async () => {
    const r = await install(['--project', 'mobrain-dev']);
    expect(r.code).toBe(0);
    const env = await readFile(join(repo, '.env'), 'utf8');
    expect(env).toContain('COMPOSE_PROJECT_NAME=mobrain-dev');
    expect(env).toContain('GBRAIN_VERSION=0.60.230.0');
    expect(env).toContain('OPENAI_API_KEY=sk-test-123456789');
    expect(env).toMatch(/ENCRYPTION_KEY=\S{40,}/);
    expect((await stat(join(repo, '.env'))).mode & 0o777).toBe(0o600);
    const cmds = (await c.calls('docker')).map((a) => a.filter((x) => !x.startsWith('-f') && !x.endsWith('.yml') && !x.endsWith('.env') && x !== '--env-file').join(' '));
    const order = ['compose build gbrain', 'compose build mobrain', 'compose up -d --wait postgres',
      'gbrain init --non-interactive --search-mode balanced', 'gbrain config set schema_pack mobrain-brain', 'compose up -d --wait', 'admin-cli.ts bootstrap'];
    let last = -1;
    for (const o of order) {
      const i = cmds.findIndex((x, idx) => idx > last && x.includes(o));
      expect(i).toBeGreaterThan(last);
      last = i;
    }
    expect(await readFile(join(c.home, '.config', 'mobrain', 'runner.env'), 'utf8')).toBe('MOBRAIN_URL=http://127.0.0.1:18999\nMOBRAIN_API_KEY=mbk_abc\n');
    expect(r.stdout).toContain('owner_password=pw123');
    expect(r.stdout).toContain('ui_url=http://127.0.0.1:18999');
  });

  test('--keyless installs without a key and without the embedding flag', async () => {
    const r = await c.run(['install', '--owner-email', 'a@x.io', '--keyless', '--port', '18998'], { MOBRAIN_REPO: repo });
    expect(r.code).toBe(0);
    const init = (await c.calls('docker')).find((a) => a.includes('init'))!;
    expect(init).not.toContain('--embedding-model');
  });
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Add to `bin/mobrain` (above `main`)**

```bash
# ---- install -------------------------------------------------------------------

host_tz() {
  if command -v timedatectl >/dev/null && timedatectl show -p Timezone --value >/dev/null 2>&1; then timedatectl show -p Timezone --value
  elif [ -f /etc/timezone ]; then cat /etc/timezone
  else echo UTC; fi
}

preflight() {
  local proj=$1 port=$2 v
  v="$(docker compose version --short 2>/dev/null)" || die "docker compose v2 is required" 17
  version_ge "${v#v}" 2.20.0 || die "docker compose >= 2.20 is required (found $v)" 17
  [ "$(nproc 2>/dev/null || echo 2)" -ge 2 ] || die "at least 2 CPUs are required" 17
  local mem; mem="$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 9999999)"
  [ "$mem" -ge 3800000 ] || die "at least 4 GB of RAM is required" 17
  if docker compose ls --all -q 2>/dev/null | grep -qx "$proj"; then die "compose project $proj already exists; refusing to reuse it" 17; fi
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then die "port $port is already in use" 17; fi
}

write_env() {
  local proj=$1 port=$2 url=$3 key=$4
  ( umask 077
    cat > "$ENV_FILE" <<EOF
COMPOSE_PROJECT_NAME=$proj
GBRAIN_VERSION=$PIN
MOBRAIN_PORT=$port
MOBRAIN_PUBLIC_URL=$url
POSTGRES_PASSWORD=$(rand_hex 16)
ENCRYPTION_KEY=$(rand_b64 32)
GBRAIN_ADMIN_BOOTSTRAP_TOKEN=$(rand_hex 32)
OPENAI_API_KEY=$key
TZ=$(host_tz)
EOF
  )
}

PACK_DIR=/srv/gbrain-home/.gbrain/schema-packs

install_packs() {
  local name
  for name in mobrain-core mobrain-personal mobrain-brain; do
    dc run --rm --no-deps gbrain mkdir -p "$PACK_DIR/$name"
  done
  dc run --rm --no-deps -v "$REPO/packs:/packs:ro" gbrain cp /packs/mobrain-core.json "$PACK_DIR/mobrain-core/pack.json"
  dc run --rm --no-deps -v "$REPO/packs:/packs:ro" gbrain cp /packs/mobrain-personal.json "$PACK_DIR/mobrain-personal/pack.json"
  # The brain layer is the agent's; create it once, never overwrite it.
  dc run --rm --no-deps -v "$REPO/packs:/packs:ro" gbrain cp -n /packs/mobrain-brain.template.json "$PACK_DIR/mobrain-brain/pack.json"
}

write_runner_env() {
  mkdir -p "$CONF_DIR"
  ( umask 077; printf 'MOBRAIN_URL=%s\nMOBRAIN_API_KEY=%s\n' "$1" "$2" > "$RUNNER_ENV" )
}

cmd_install() {
  local email="" name="" keyfile="" keyless=0 port=8787 url="" proj=mobrain key=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --owner-email) email=$2; shift 2 ;;
      --name) name=$2; shift 2 ;;
      --openai-key-file) keyfile=$2; shift 2 ;;
      --keyless) keyless=1; shift ;;
      --port) port=$2; shift 2 ;;
      --public-url) url=$2; shift 2 ;;
      --project) proj=$2; shift 2 ;;
      *) usage ;;
    esac
  done
  [ -f "$REPO/compose/docker-compose.yml" ] || die "install runs from a Mo-brain checkout" 17
  [ -n "$email" ] || usage
  { [ -n "$keyfile" ] || [ "$keyless" = 1 ]; } || usage
  [ -e "$ENV_FILE" ] && die "$ENV_FILE exists; refusing to overwrite an install" 17
  if [ -n "$keyfile" ]; then key="$(tr -d '\r\n' < "$keyfile")"; [ -n "$key" ] || die "$keyfile is empty" 64; fi
  url="${url:-http://127.0.0.1:$port}"
  preflight "$proj" "$port"
  write_env "$proj" "$port" "$url" "$key"

  echo "building images (gbrain $PIN first)..." >&2
  dc build gbrain
  dc build mobrain
  dc up -d --wait postgres
  # Probe P1: these flags are accepted. `--search-mode balanced` is not stored; do not invent a flag.
  # Init finishes only after compose/initdb/01-dbs.sh grants BYPASSRLS and pre-creates
  # auto_enable_rls (owned by gbrain) plus the auto_rls_on_create_table event trigger.
  local init=(gbrain init --non-interactive --search-mode balanced --json)
  [ -n "$key" ] && init+=(--embedding-model openai:text-embedding-3-small)
  dc run --rm --no-deps gbrain "${init[@]}"
  install_packs
  dc run --rm --no-deps gbrain gbrain config set schema_pack mobrain-brain
  dc up -d --wait

  local boot=(bun src/server/admin-cli.ts bootstrap --email "$email" --format env)
  [ -n "$name" ] && boot+=(--name "$name")
  local out; out="$(dc exec -T mobrain "${boot[@]}")" || die "owner bootstrap failed" 1
  local api_key password
  api_key="$(kv_get "$out" MOBRAIN_API_KEY)"; password="$(kv_get "$out" MOBRAIN_OWNER_PASSWORD)"
  write_runner_env "http://127.0.0.1:$port" "$api_key"

  printf 'ui_url=%s\nlocal_url=http://127.0.0.1:%s\nowner_email=%s\nowner_password=%s\nrunner_env=%s\nnext=mobrain client issue agent --register\n' \
    "$url" "$port" "$email" "$password" "$RUNNER_ENV"
}
```

(Probe P1 accepted these flags. `--search-mode balanced` is not stored. Init still depends on `compose/initdb/01-dbs.sh` for `BYPASSRLS` and the v35 function owned by `gbrain`.)

- [ ] **Step 3: Run** — `bash scripts/test-isolated.sh test/unit/cli` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add bin/mobrain test/unit/cli/install.test.ts
git commit -m "feat(cli): install with preflight refusals, packs, bootstrap, receipt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7.4: People, source and mode commands

**Files:**
- Modify: `bin/mobrain`
- Test: `test/unit/cli/people.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/cli/people.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { cliWorld, curlRoutes, type Cli } from './harness.ts';

let c: Cli;
beforeEach(async () => {
  c = await cliWorld();
  await c.runnerEnv();
  await c.stub('curl', curlRoutes([
    ['/api/people?format=tsv', 200, 'u-1\town@x.io\towner\tactive\nu-2\tm@x.io\tmember\tactive'],
    ['/api/people/invite', 200, '{"userId":"u-3","claimUrl":"http://mb.test/claim/abc"}'],
    ['/api/people/u-2/grants/c-company', 200, '{"ok":true}'],
    ['/api/people/u-2/offboard', 200, '{"ok":true}'],
    ['/api/people/mode', 200, '{"ok":true}'],
    ['/api/sources/company', 200, '{"id":"c-eng"}'],
  ]));
});
afterEach(async () => rm(c.root, { recursive: true, force: true }));

const bodies = async () => (await c.calls('curl')).map((a) => {
  const i = a.indexOf('--data-binary');
  return [a[a.indexOf('-X') + 1], a[a.length - 1], i >= 0 ? a[i + 1] : null];
});

test('invite prints the claim url', async () => {
  const r = await c.run(['member', 'invite', 'n@x.io', '--role', 'member']);
  expect(r.stdout.trim()).toBe('http://mb.test/claim/abc');
  expect((await bodies())[0]).toEqual(['POST', 'http://mb.test/api/people/invite', '{"email":"n@x.io","role":"member"}']);
});

test('grant resolves the email to an id and sends agentReads', async () => {
  await c.run(['grant', 'm@x.io', 'c-company', '--no-agent-reads']);
  const b = await bodies();
  expect(b[1]).toEqual(['PUT', 'http://mb.test/api/people/u-2/grants/c-company', '{"agentReads":false}']);
});

test('an unknown email is an error', async () => {
  const r = await c.run(['member', 'offboard', 'nobody@x.io']);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('no such member');
});

test('mode and source add', async () => {
  await c.run(['mode', 'company']);
  const r = await c.run(['source', 'add', 'Engineering']);
  expect(r.stdout.trim()).toBe('c-eng');
  const b = await bodies();
  expect(b[0]).toEqual(['POST', 'http://mb.test/api/people/mode', '{"mode":"company"}']);
  expect(b[1]).toEqual(['POST', 'http://mb.test/api/sources/company', '{"name":"Engineering"}']);
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Add to `bin/mobrain`**

```bash
# ---- people, sources, mode -------------------------------------------------------

user_id() {
  local id; id="$(api GET '/api/people?format=tsv' | awk -F'\t' -v e="$1" 'tolower($2) == tolower(e) {print $1}')"
  [ -n "$id" ] || die "no such member: $1" 1
  printf '%s' "$id"
}

cmd_mode() {
  need_runner
  case "${1:-}" in company|personal) ;; *) usage ;; esac
  api POST /api/people/mode "{\"mode\":\"$1\"}" >/dev/null && echo "mode: $1"
}

cmd_member() {
  need_runner
  local sub=${1:-}; shift || true
  case "$sub" in
    list) api GET '/api/people?format=tsv'; echo ;;
    invite)
      local email=${1:-} role=member; shift || true
      [ "${1:-}" = --role ] && role=${2:-member}
      [ -n "$email" ] || usage
      api POST /api/people/invite "{\"email\":$(json_str "$email"),\"role\":$(json_str "$role")}" \
        | sed -n 's/.*"claimUrl":"\([^"]*\)".*/\1/p' ;;
    role) [ $# -eq 2 ] || usage; api POST "/api/people/$(user_id "$1")/role" "{\"role\":$(json_str "$2")}" >/dev/null && echo ok ;;
    offboard) [ $# -eq 1 ] || usage; api POST "/api/people/$(user_id "$1")/offboard" '{}' >/dev/null && echo "offboarded $1" ;;
    *) usage ;;
  esac
}

cmd_grant() {
  need_runner
  [ $# -ge 2 ] || usage
  local reads=true; [ "${3:-}" = --no-agent-reads ] && reads=false
  api PUT "/api/people/$(user_id "$1")/grants/$2" "{\"agentReads\":$reads}" >/dev/null && echo "granted $2 to $1"
}

cmd_revoke() {
  need_runner
  [ $# -eq 2 ] || usage
  api DELETE "/api/people/$(user_id "$1")/grants/$2" >/dev/null && echo "revoked $2 from $1"
}

cmd_source() {
  need_runner
  local sub=${1:-}; shift || true
  case "$sub" in
    add) [ $# -ge 1 ] || usage; api POST /api/sources/company "{\"name\":$(json_str "$*")}" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' ;;
    list) api GET /api/sources; echo ;;
    archive) [ $# -eq 1 ] || usage; api POST "/api/sources/$1/archive" '{}' >/dev/null && echo "archived $1" ;;
    *) usage ;;
  esac
}
```

- [ ] **Step 3: Run** — Expected: PASS. **Commit:**

```bash
git add bin/mobrain test/unit/cli/people.test.ts
git commit -m "feat(cli): people, grants, sources and mode commands

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7.5: `client issue`, harness registration, rotation

**Files:**
- Modify: `bin/mobrain`
- Test: `test/unit/cli/client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/cli/client.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cliWorld, curlRoutes, type Cli } from './harness.ts';

let c: Cli;
const issued = 'token=tok-SECRET\nmcp_url=http://mb.test/mcp\nname=gbrain\nexpires_at=2027-01-12T00:00:00.000Z';
beforeEach(async () => { c = await cliWorld(); await c.runnerEnv(); await c.stub('claude'); });
afterEach(async () => rm(c.root, { recursive: true, force: true }));

test('issue agent --register adds the MCP server to Claude Code and never prints the token', async () => {
  await c.stub('curl', curlRoutes([['/api/clients/issue?format=env', 200, issued]]));
  const r = await c.run(['client', 'issue', 'agent', '--register']);
  expect(r.code).toBe(0);
  expect(r.stdout + r.stderr).not.toContain('tok-SECRET');
  const calls = await c.calls('claude');
  expect(calls[0]).toEqual(['mcp', 'remove', '--scope', 'user', 'gbrain']);
  expect(calls[1]).toEqual(['mcp', 'add', '--scope', 'user', '--transport', 'http', 'gbrain', 'http://mb.test/mcp',
    '--header', 'Authorization: Bearer tok-SECRET']);
  expect(await readFile(join(c.home, '.config/mobrain/runner.env'), 'utf8')).toContain('MOBRAIN_REGISTERED=1');
});

test('issue agent without --register prints the env lines', async () => {
  await c.stub('curl', curlRoutes([['/api/clients/issue?format=env', 200, issued]]));
  expect((await c.run(['client', 'issue', 'agent'])).stdout).toContain('token=tok-SECRET');
});

test('rotate-if-expiring re-issues only inside the window, and only when registered', async () => {
  await c.stub('curl', curlRoutes([
    ['/api/clients/me?format=tsv', 200, 'agent\tp-own\t2026-10-20T00:00:00.000Z\t6\nui\tp-own\t2027-01-01T00:00:00.000Z\t79'],
    ['/api/clients/issue?format=env', 200, issued],
  ]));
  const r1 = await c.run(['client', 'rotate-if-expiring']);
  expect(r1.stderr).toContain('not registered');
  expect(await c.calls('claude')).toEqual([]);
  await c.run(['client', 'issue', 'agent', '--register']);
  const before = (await c.calls('claude')).length;
  await c.run(['client', 'rotate-if-expiring', '--days', '14']);
  expect((await c.calls('claude')).length).toBe(before + 2);
  await c.run(['client', 'rotate-if-expiring', '--days', '3']);
  expect((await c.calls('claude')).length).toBe(before + 2);
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Add to `bin/mobrain`**

```bash
# ---- clients and the harness ------------------------------------------------------

runner_set() {
  local k=$1 v=$2
  mkdir -p "$CONF_DIR"; touch "$RUNNER_ENV"; chmod 600 "$RUNNER_ENV"
  local tmp; tmp="$(mktemp)"
  grep -v "^$k=" "$RUNNER_ENV" > "$tmp" || true
  printf '%s=%s\n' "$k" "$v" >> "$tmp"
  mv "$tmp" "$RUNNER_ENV"; chmod 600 "$RUNNER_ENV"
}

harness_register() {
  local name=$1 url=$2 token=$3
  case "${MOBRAIN_HARNESS:-claude-code}" in
    claude-code)
      ( cd "${MOBRAIN_WORKDIR:-$HOME}"
        claude mcp remove --scope "${MOBRAIN_MCP_SCOPE:-user}" "$name" >/dev/null 2>&1 || true
        claude mcp add --scope "${MOBRAIN_MCP_SCOPE:-user}" --transport http "$name" "$url" --header "Authorization: Bearer $token" >/dev/null ) ;;
    *) die "harness ${MOBRAIN_HARNESS} is not supported yet" 64 ;;
  esac
}

cmd_client() {
  need_runner
  local sub=${1:-}; shift || true
  case "$sub" in
    issue)
      local what=${1:-} source="" register=0 body; shift || true
      if [ "$what" = company-writer ]; then source=${1:-}; shift || true; [ -n "$source" ] || usage; fi
      [ "${1:-}" = --register ] && register=1
      case "$what" in
        agent) body='{"purpose":"agent"}' ;;
        company-writer) body="{\"purpose\":\"company_writer\",\"sourceId\":$(json_str "$source")}" ;;
        *) usage ;;
      esac
      local out; out="$(api POST '/api/clients/issue?format=env' "$body")"
      if [ "$register" = 1 ]; then
        harness_register "$(kv_get "$out" name)" "$(kv_get "$out" mcp_url)" "$(kv_get "$out" token)"
        [ "$what" = agent ] && runner_set MOBRAIN_REGISTERED 1
        echo "registered $(kv_get "$out" name) in ${MOBRAIN_HARNESS:-claude-code}; expires $(kv_get "$out" expires_at)"
      else
        printf '%s\n' "$out"
      fi ;;
    rotate-if-expiring)
      local days=14; [ "${1:-}" = --days ] && days=${2:-14}
      local left; left="$(api GET '/api/clients/me?format=tsv' | awk -F'\t' '$1 == "agent" {print $4}' | head -1)"
      if [ -n "$left" ] && [ "$left" != - ] && [ "$left" -gt "$days" ]; then return 0; fi
      if [ "${MOBRAIN_REGISTERED:-0}" != 1 ]; then echo "mobrain: agent token expires in ${left:-?} days but is not registered by mobrain; run 'mobrain client issue agent --register'" >&2; return 0; fi
      cmd_client issue agent --register ;;
    *) usage ;;
  esac
}
```

- [ ] **Step 3: Run** — Expected: PASS. **Commit:**

```bash
git add bin/mobrain test/unit/cli/client.test.ts
git commit -m "feat(cli): client issue with harness registration and token rotation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7.6: `schema` commands

**Files:**
- Modify: `bin/mobrain`
- Test: `test/unit/cli/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/cli/schema.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cliWorld, curlRoutes, type Cli } from './harness.ts';

let c: Cli; let repo: string;
beforeEach(async () => {
  c = await cliWorld(); await c.runnerEnv();
  repo = join(c.root, 'repo');
  await mkdir(join(repo, 'compose'), { recursive: true });
  await writeFile(join(repo, 'compose', 'docker-compose.yml'), '');
  await writeFile(join(repo, '.env'), 'COMPOSE_PROJECT_NAME=mobrain-dev\nMOBRAIN_PORT=8788\n');
});
afterEach(async () => rm(c.root, { recursive: true, force: true }));

test('check exits 0 when the core lock holds and 1 with the problems when it does not', async () => {
  await c.stub('curl', curlRoutes([['/api/admin/health', 200, '{"coreLock":{"ok":true,"problems":[]}}']]));
  expect((await c.run(['schema', 'check'])).code).toBe(0);
  await c.stub('curl', curlRoutes([['/api/admin/health', 200, '{"coreLock":{"ok":false,"problems":["shadowed_type:person"]}}']]));
  const r = await c.run(['schema', 'check']);
  expect(r.code).toBe(1);
  expect(r.stdout).toContain('shadowed_type:person');
});

test('exec allows only listed gbrain schema subcommands', async () => {
  await c.stub('docker');
  expect((await c.run(['schema', 'exec', '--', 'use', 'gbrain-base'], { MOBRAIN_REPO: repo })).code).toBe(64);
  expect((await c.run(['schema', 'exec', '--', 'review-orphans', '--json'], { MOBRAIN_REPO: repo })).code).toBe(0);
  const call = (await c.calls('docker')).at(-1)!;
  expect(call.slice(-5)).toEqual(['gbrain', 'gbrain', 'schema', 'review-orphans', '--json']);
});

test('apply restores the previous pack when validation fails', async () => {
  await c.stub('docker', 'case "$*" in *"schema validate"*) exit 3;; esac; exit 0');
  await c.stub('curl', curlRoutes([['/api/admin/health', 200, '{"coreLock":{"ok":true,"problems":[]}}']]));
  const f = join(c.root, 'brain.json'); await writeFile(f, '{}');
  const r = await c.run(['schema', 'apply', f], { MOBRAIN_REPO: repo });
  expect(r.code).toBe(1);
  const calls = (await c.calls('docker')).map((a) => a.join(' '));
  expect(calls.some((x) => x.includes('pack.json.bak /srv/gbrain-home/.gbrain/schema-packs/mobrain-brain/pack.json'))).toBe(true);
  expect(calls.some((x) => x.includes('restart'))).toBe(false);
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Add to `bin/mobrain`**

```bash
# ---- schema ---------------------------------------------------------------------

BRAIN_PACK="$PACK_DIR/mobrain-brain/pack.json"
SCHEMA_EXEC_ALLOWED=" active show stats lint validate explain graph sync review-orphans review-candidates detect suggest unify-types "

schema_lock_ok() {
  local h; h="$(api GET /api/admin/health)"
  if printf '%s' "$h" | grep -q '"coreLock":{"ok":true'; then return 0; fi
  printf '%s\n' "$h" | grep -o '"problems":\[[^]]*\]' || true
  return 1
}

cmd_schema() {
  local sub=${1:-}; shift || true
  case "$sub" in
    show) need_runner; api GET /api/schema; echo ;;
    check) need_runner; schema_lock_ok && echo "core lock ok" ;;
    edit)
      need_stack; [ "${1:-}" = --out ] && [ -n "${2:-}" ] || usage
      dc exec -T gbrain cat "$BRAIN_PACK" > "$2"; echo "wrote $2; edit it, then: mobrain schema apply $2" ;;
    apply)
      need_stack; need_runner; [ -f "${1:-}" ] || usage
      dc exec -T gbrain cp "$BRAIN_PACK" "$BRAIN_PACK.bak"
      dc cp "$1" "gbrain:$BRAIN_PACK"
      if dc exec -T gbrain gbrain schema validate mobrain-brain \
         && dc exec -T gbrain gbrain schema lint mobrain-brain \
         && schema_lock_ok; then
        dc restart gbrain autopilot
        echo "applied; gbrain reloaded"
      else
        dc exec -T gbrain cp "$BRAIN_PACK.bak" "$BRAIN_PACK"
        die "rejected; the previous mobrain-brain pack is restored" 1
      fi ;;
    exec)
      need_stack; [ "${1:-}" = -- ] && shift
      [ $# -ge 1 ] && [[ "$SCHEMA_EXEC_ALLOWED" == *" $1 "* ]] || { echo "allowed: $SCHEMA_EXEC_ALLOWED" >&2; exit 64; }
      dc exec -T gbrain gbrain schema "$@" ;;
    *) usage ;;
  esac
}
```

- [ ] **Step 3: Run** — Expected: PASS. **Commit:**

```bash
git add bin/mobrain test/unit/cli/schema.test.ts
git commit -m "feat(cli): schema show/check/edit/apply/exec with rollback on failure

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7.7: `collect`

**Files:**
- Modify: `bin/mobrain`
- Test: `test/unit/cli/collect.test.ts`

The prompt contract with the `mobrain-collect` skill (phase 9): the run's output contains a line `MOBRAIN_STATUS: ok|partial|error` and a line `MOBRAIN_SUMMARY: <one line>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/cli/collect.test.ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cliWorld, curlRoutes, type Cli } from './harness.ts';

let c: Cli;
const due = (mode = 'incremental', slug = 'system/collectors/mail', source = 'p-own') =>
  `${slug}\t${source}\temail\tmcp__claude_ai_Gmail__*\tsonnet\t1200\t${mode}`;
const routes = (dueBody: string) => curlRoutes([
  ['/api/clients/me?format=tsv', 200, 'agent\tp-own\t2027-01-01T00:00:00.000Z\t80'],
  ['/api/runner/due', 200, dueBody],
  ['/api/runner/start', 200, '{"runId":"run-1"}'],
  ['/api/runner/finish', 200, '{"ok":true}'],
]);
const finishBody = async () => {
  const call = (await c.calls('curl')).filter((a) => a.at(-1)!.endsWith('/api/runner/finish')).at(-1)!;
  return JSON.parse(call[call.indexOf('--data-binary') + 1]!);
};

beforeEach(async () => { c = await cliWorld(); await c.runnerEnv(); });
afterEach(async () => rm(c.root, { recursive: true, force: true }));

describe('collect', () => {
  test('nothing due', async () => {
    await c.stub('curl', routes(''));
    const r = await c.run(['collect', '--due']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('nothing due');
  });

  test('runs claude headless with gbrain + the collector tools, then reports ok and the summary', async () => {
    await c.stub('curl', routes(due()));
    await c.stub('claude', 'echo "working"; echo "MOBRAIN_STATUS: ok"; echo "MOBRAIN_SUMMARY: read 3, wrote 2"');
    const r = await c.run(['collect', '--due']);
    expect(r.code).toBe(0);
    const [call] = await c.calls('claude');
    expect(call![0]).toBe('-p');
    expect(call![1]).toContain('mobrain-collect');
    expect(call![1]).toContain('system/collectors/mail');
    expect(call!.slice(2)).toEqual(['--allowedTools', 'mcp__gbrain__*,mcp__claude_ai_Gmail__*', '--output-format', 'text', '--model', 'sonnet']);
    expect(await finishBody()).toMatchObject({ runId: 'run-1', status: 'ok', exitCode: 0, summary: 'read 3, wrote 2' });
  });

  test('no status line, a non-zero exit, and a timeout are reported as error, error, timeout', async () => {
    await c.stub('curl', routes(due()));
    await c.stub('claude', 'echo "forgot the contract"');
    await c.run(['collect', '--due']);
    expect((await finishBody()).status).toBe('error');

    await c.stub('claude', 'echo boom; exit 3');
    await c.run(['collect', '--due']);
    expect((await finishBody()).status).toBe('error');

    await c.stub('curl', routes(due().replace('\t1200\t', '\t1\t')));
    await c.stub('claude', 'sleep 5');
    await c.run(['collect', '--due']);
    expect((await finishBody()).status).toBe('timeout');
  });

  test('a company collector also allows that source\'s company MCP server', async () => {
    await c.stub('curl', routes(due('incremental', 'system/collectors/drive', 'c-company')));
    await c.stub('claude', 'echo "MOBRAIN_STATUS: ok"');
    await c.run(['collect', '--due']);
    const [call] = await c.calls('claude');
    expect(call![call!.indexOf('--allowedTools') + 1]).toBe('mcp__gbrain__*,mcp__gbrain-company-c-company__*,mcp__claude_ai_Gmail__*');
  });

  test('a held lock skips the collector without starting a run', async () => {
    await c.stub('curl', routes(due()));
    await c.stub('claude', 'echo "MOBRAIN_STATUS: ok"');
    const lock = join(c.home, '.local/state/mobrain/locks/system_collectors_mail.lock.d');
    await Bun.spawn(['mkdir', '-p', lock]).exited;
    const r = await c.run(['collect', '--due']);
    expect(r.stdout).toContain('already running');
    expect((await c.calls('curl')).some((a) => a.at(-1)!.endsWith('/api/runner/start'))).toBe(false);
  });

  test('one collector by slug, forced into backfill, keeps a log file', async () => {
    await c.stub('curl', routes(due()));
    await c.stub('claude', 'echo "MOBRAIN_STATUS: partial"');
    await c.run(['collect', 'system/collectors/mail', '--backfill']);
    const [call] = await c.calls('claude');
    expect(call![1]).toContain('mode: backfill');
    expect((await c.calls('curl')).some((a) => a.at(-1)!.includes('/api/runner/due?slug=system%2Fcollectors%2Fmail'))).toBe(true);
    expect((await readdir(join(c.home, '.local/state/mobrain/collect/system_collectors_mail'))).length).toBe(1);
    expect((await finishBody()).status).toBe('partial');
  });
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Add to `bin/mobrain`**

```bash
# ---- collect ------------------------------------------------------------------------

urlenc() { local s=$1 out="" c i; for ((i = 0; i < ${#s}; i++)); do c=${s:i:1}; case "$c" in [a-zA-Z0-9._~-]) out+=$c ;; *) out+=$(printf '%%%02X' "'$c") ;; esac; done; printf '%s' "$out"; }

acquire_lock() {
  local d=$1 ttl=$2
  mkdir -p "$(dirname "$d")"
  mkdir "$d" 2>/dev/null && return 0
  # A lock older than the timeout belongs to a run that died.
  if [ -n "$(find "$d" -maxdepth 0 -mmin "+$(( ttl / 60 + 1 ))" 2>/dev/null)" ]; then rm -rf "$d"; mkdir "$d" && return 0; fi
  return 1
}

harness_run() {
  local slug=$1 source=$2 mode=$3 tools=$4 model=$5 timeout=$6
  local allowed="mcp__gbrain__*" via="gbrain"
  if [[ "$source" == c-* ]]; then allowed+=",mcp__gbrain-company-${source}__*"; via="gbrain-company-$source"; fi
  [ -n "$tools" ] && allowed+=",$tools"
  local prompt="Use the mobrain-collect skill to run collector $slug in source $source (mode: $mode). Write through the $via MCP server. Finish with the MOBRAIN_STATUS and MOBRAIN_SUMMARY lines the skill specifies."
  case "${MOBRAIN_HARNESS:-claude-code}" in
    claude-code)
      # Probe P4: systemd user PATH does not include ~/.local/bin. Bare `claude` is exit 127.
      local claude_bin="${CLAUDE_BIN:-$(command -v claude || true)}"
      [ -n "$claude_bin" ] || { echo "claude not found; set CLAUDE_BIN or PATH (systemd user PATH omits ~/.local/bin)" >&2; return 127; }
      local cmd=("$claude_bin" -p "$prompt" --allowedTools "$allowed" --output-format text)
      [ -n "$model" ] && cmd+=(--model "$model")
      ( cd "${MOBRAIN_WORKDIR:-$HOME}" && tmo "${timeout}s" "${cmd[@]}" ) ;;
    stub)
      tmo "${timeout}s" "${MOBRAIN_STUB_HARNESS:?MOBRAIN_STUB_HARNESS is required for the stub harness}" "$slug" "$source" "$mode" ;;
    *) echo "unsupported harness ${MOBRAIN_HARNESS}"; return 2 ;;
  esac
}

run_one() {
  local slug=$1 source=$2 kind=$3 tools=$4 model=$5 timeout=$6 mode=$7
  [ "$mode" = backfill ] && [ "$timeout" -lt 7200 ] && timeout=7200
  local safe=${slug//\//_}
  local lock="$STATE_DIR/locks/$safe.lock.d" logdir="$STATE_DIR/collect/$safe"
  if ! acquire_lock "$lock" "$timeout"; then echo "$slug: already running here"; return 0; fi
  mkdir -p "$logdir"
  local log; log="$logdir/$(date -u +%Y%m%dT%H%M%SZ).log"
  local start run_id rc=0 status summary tailtxt
  start="$(api POST /api/runner/start "{\"slug\":$(json_str "$slug"),\"source\":$(json_str "$source"),\"timeoutS\":$timeout}")" \
    || { rm -rf "$lock"; return 1; }
  run_id="$(printf '%s' "$start" | sed -n 's/.*"runId":"\([^"]*\)".*/\1/p')"
  harness_run "$slug" "$source" "$mode" "$tools" "$model" "$timeout" > "$log" 2>&1 || rc=$?
  status="$(sed -n 's/^.*MOBRAIN_STATUS: *\(ok\|partial\|error\).*$/\1/p' "$log" | tail -1)"
  if [ "$rc" = 124 ]; then status=timeout; elif [ "$rc" != 0 ] || [ -z "$status" ]; then status=error; fi
  summary="$(sed -n 's/^.*MOBRAIN_SUMMARY: *//p' "$log" | tail -1)"
  tailtxt="$(tail -c 4096 "$log" | tr -d '\000-\010\013\014\016-\037')"
  api POST /api/runner/finish "{\"runId\":$(json_str "$run_id"),\"status\":\"$status\",\"exitCode\":$rc,\"summary\":$(json_str "$summary"),\"logTail\":$(json_str "$tailtxt")}" >/dev/null || true
  ls -1t "$logdir" | tail -n +51 | while read -r old; do rm -f "$logdir/$old"; done
  rm -rf "$lock"
  echo "$slug: $status${summary:+ ($summary)}"
  [ "$status" = ok ] || [ "$status" = partial ]
}

cmd_collect() {
  need_runner
  local mode_due=0 backfill=0 slug="" list
  while [ $# -gt 0 ]; do
    case "$1" in --due) mode_due=1 ;; --backfill) backfill=1 ;; -*) usage ;; *) slug=$1 ;; esac; shift
  done
  { [ "$mode_due" = 1 ] || [ -n "$slug" ]; } || usage
  [ "$mode_due" = 1 ] && cmd_client rotate-if-expiring || true
  if [ -n "$slug" ]; then list="$(api GET "/api/runner/due?slug=$(urlenc "$slug")")"; else list="$(api GET /api/runner/due)"; fi
  [ -n "${list//[$'\n\t ']/}" ] || { echo "nothing due"; return 0; }
  local rc=0 s src kind tools model timeout mode
  while IFS=$'\t' read -r s src kind tools model timeout mode; do
    [ -n "$s" ] || continue
    [ "$backfill" = 1 ] && mode=backfill
    run_one "$s" "$src" "$kind" "$tools" "$model" "$timeout" "$mode" || rc=1
  done <<< "$list"
  return "$rc"
}
```

- [ ] **Step 3: Run** — Expected: PASS. **Commit:**

```bash
git add bin/mobrain test/unit/cli/collect.test.ts
git commit -m "feat(cli): collect runs the harness headless and reports every outcome

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7.8: `timers`

**Files:**
- Modify: `bin/mobrain`
- Test: `test/unit/cli/timers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/cli/timers.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cliWorld, type Cli } from './harness.ts';

let c: Cli;
beforeEach(async () => { c = await cliWorld(); await c.runnerEnv(); });
afterEach(async () => rm(c.root, { recursive: true, force: true }));

test('systemd user timers when the user bus works and lingering is on', async () => {
  await c.stub('systemctl');
  await c.stub('loginctl', 'echo yes');
  const r = await c.run(['timers', 'install']);
  expect(r.stdout).toContain('systemd');
  const unit = await readFile(join(c.home, '.config/systemd/user/mobrain-collect.service'), 'utf8');
  expect(unit).toMatch(/ExecStart=.*bin\/mobrain collect --due/);
  expect(unit).toContain('Environment=PATH=');
  expect(unit).toContain('.local/bin');
  expect(await readFile(join(c.home, '.config/systemd/user/mobrain-collect.timer'), 'utf8')).toContain('OnCalendar=*:0/15');
  expect((await c.calls('systemctl')).map((a) => a.join(' '))).toContain('--user enable --now mobrain-collect.timer');
});

test('crontab fallback replaces only mobrain lines', async () => {
  await c.stub('systemctl', 'exit 1');
  await c.stub('loginctl', 'echo no');
  await c.stub('crontab', `if [ "$1" = -l ]; then printf '0 1 * * * other-job\\n*/15 * * * * old # mobrain\\n'; else cat > "$STUB_LOG.cron"; fi`);
  const r = await c.run(['timers', 'install']);
  expect(r.stdout).toContain('crontab');
  const cron = await readFile(`${c.env.STUB_LOG}.cron`, 'utf8');
  expect(cron).toContain('0 1 * * * other-job');
  expect(cron).not.toContain('old # mobrain');
  expect(cron).toMatch(/\*\/15 \* \* \* \* .*collect --due .* # mobrain/);
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Add to `bin/mobrain`**

```bash
# ---- timers -----------------------------------------------------------------------------

UNIT_DIR="$HOME/.config/systemd/user"

systemd_ok() {
  command -v systemctl >/dev/null || return 1
  systemctl --user show-environment >/dev/null 2>&1 || return 1
  local linger; linger="$(loginctl show-user "${USER:-$(id -un)}" -p Linger --value 2>/dev/null || true)"
  if [ "$linger" != yes ]; then loginctl enable-linger "${USER:-$(id -un)}" >/dev/null 2>&1 || true
    linger="$(loginctl show-user "${USER:-$(id -un)}" -p Linger --value 2>/dev/null || true)"; fi
  [ "$linger" = yes ]
}

timer_path() {
  # Probe P4: user-manager PATH omits ~/.local/bin. Include it, and the directory of claude if found.
  local p="$HOME/.local/bin:${PATH:-/usr/bin:/bin}" bin
  bin="$(command -v claude 2>/dev/null || true)"
  [ -n "$bin" ] && p="$(dirname "$bin"):$p"
  printf '%s' "$p"
}

write_unit() { # name description exec calendar
  mkdir -p "$UNIT_DIR"
  printf '[Unit]\nDescription=%s\n\n[Service]\nType=oneshot\nEnvironment=PATH=%s\nEnvironment=HOME=%s\nExecStart=%s\n' \
    "$2" "$(timer_path)" "$HOME" "$3" > "$UNIT_DIR/$1.service"
  printf '[Unit]\nDescription=%s\n\n[Timer]\nOnCalendar=%s\nPersistent=true\nRandomizedDelaySec=60\n\n[Install]\nWantedBy=timers.target\n' \
    "$2" "$4" > "$UNIT_DIR/$1.timer"
}

cmd_timers() {
  local sub=${1:-}
  mkdir -p "$STATE_DIR"
  case "$sub" in
    install)
      if systemd_ok; then
        write_unit mobrain-collect "Mo-brain collectors" "$SELF collect --due" '*:0/15'
        is_stack_host && write_unit mobrain-backup "Mo-brain daily backup" "$SELF backup --prune" '*-*-* 03:30'
        systemctl --user daemon-reload
        systemctl --user enable --now mobrain-collect.timer
        is_stack_host && systemctl --user enable --now mobrain-backup.timer
        echo "timers installed (systemd user units)"
      else
        { crontab -l 2>/dev/null | grep -v '# mobrain$' || true
          echo "*/15 * * * * PATH=$(timer_path) $SELF collect --due >> $STATE_DIR/cron.log 2>&1 # mobrain"
          if is_stack_host; then echo "30 3 * * * PATH=$(timer_path) $SELF backup --prune >> $STATE_DIR/cron.log 2>&1 # mobrain"; fi
        } | crontab -
        echo "timers installed (crontab)"
      fi ;;
    remove)
      if command -v systemctl >/dev/null; then
        systemctl --user disable --now mobrain-collect.timer mobrain-backup.timer >/dev/null 2>&1 || true
        rm -f "$UNIT_DIR"/mobrain-collect.* "$UNIT_DIR"/mobrain-backup.*
      fi
      if command -v crontab >/dev/null; then { crontab -l 2>/dev/null | grep -v '# mobrain$' || true; } | crontab -; fi
      echo "timers removed" ;;
    status)
      systemctl --user list-timers 'mobrain-*' 2>/dev/null || crontab -l 2>/dev/null | grep '# mobrain$' || echo "no timers" ;;
    *) usage ;;
  esac
}
```

- [ ] **Step 3: Run** — Expected: PASS. **Commit:**

```bash
git add bin/mobrain test/unit/cli/timers.test.ts
git commit -m "feat(cli): collector and backup timers (systemd user units or crontab)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7.9: `skills install`

**Files:**
- Modify: `bin/mobrain`
- Test: `test/unit/cli/skills.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/cli/skills.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cliWorld, type Cli } from './harness.ts';

let c: Cli; let bundle: string; let dest: string;
async function makeBundle(files: Record<string, string>) {
  const src = join(c.root, `b-${Math.random()}`);
  for (const [p, t] of Object.entries(files)) { await mkdir(join(src, p, '..'), { recursive: true }); await writeFile(join(src, p), t); }
  await Bun.spawn(['tar', '-czf', bundle, '-C', src, '.']).exited;
}
beforeEach(async () => {
  c = await cliWorld(); await c.runnerEnv();
  bundle = join(c.root, 'skills.tgz'); dest = join(c.home, 'skills');
  await c.stub('curl', `out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done; cp "${bundle}" "$out"`);
});
afterEach(async () => rm(c.root, { recursive: true, force: true }));

test('first install copies everything and writes a manifest', async () => {
  await makeBundle({ 'RESOLVER.md': 'r1', 'mobrain-collect/SKILL.md': 's1' });
  expect((await c.run(['skills', 'install', '--dir', dest])).code).toBe(0);
  expect(await readFile(join(dest, 'mobrain-collect/SKILL.md'), 'utf8')).toBe('s1');
  expect(await readFile(join(dest, '.mobrain-skills.tsv'), 'utf8')).toContain('\tmobrain-collect/SKILL.md');
});

test('re-install updates untouched files and keeps edited ones, naming them', async () => {
  await makeBundle({ 'RESOLVER.md': 'r1', 'a/SKILL.md': 'a1' });
  await c.run(['skills', 'install', '--dir', dest]);
  await writeFile(join(dest, 'a/SKILL.md'), 'my edit');
  await makeBundle({ 'RESOLVER.md': 'r2', 'a/SKILL.md': 'a2' });
  const r = await c.run(['skills', 'install', '--dir', dest]);
  expect(await readFile(join(dest, 'RESOLVER.md'), 'utf8')).toBe('r2');
  expect(await readFile(join(dest, 'a/SKILL.md'), 'utf8')).toBe('my edit');
  expect(r.stdout).toContain('kept your edited a/SKILL.md');
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Add to `bin/mobrain`**

```bash
# ---- skills ---------------------------------------------------------------------------

cmd_skills() {
  [ "${1:-}" = install ] && [ "${2:-}" = --dir ] && [ -n "${3:-}" ] || usage
  need_runner
  local dest=$3 tmp; tmp="$(mktemp -d)"
  curl -fsS -H "authorization: Bearer $MOBRAIN_API_KEY" "${MOBRAIN_URL%/}/install/skills.tar.gz" -o "$tmp/s.tgz" || die "cannot download skills" 2
  mkdir -p "$tmp/x" "$dest"; tar -xzf "$tmp/s.tgz" -C "$tmp/x"
  local manifest="$dest/.mobrain-skills.tsv" rel src dst new old have
  : > "$tmp/m.tsv"
  while IFS= read -r rel; do
    rel=${rel#./}; src="$tmp/x/$rel"; dst="$dest/$rel"; new="$(sha256 "$src")"
    if [ ! -e "$dst" ]; then
      mkdir -p "$(dirname "$dst")"; cp "$src" "$dst"; printf '%s\t%s\n' "$new" "$rel" >> "$tmp/m.tsv"; continue
    fi
    have="$(sha256 "$dst")"
    old="$( [ -f "$manifest" ] && awk -F'\t' -v p="$rel" '$2 == p {print $1}' "$manifest" || true)"
    if [ "$have" = "$new" ]; then printf '%s\t%s\n' "$new" "$rel" >> "$tmp/m.tsv"
    elif [ -n "$old" ] && [ "$have" = "$old" ]; then cp "$src" "$dst"; printf '%s\t%s\n' "$new" "$rel" >> "$tmp/m.tsv"
    else echo "kept your edited $rel"; printf '%s\t%s\n' "${old:-$have}" "$rel" >> "$tmp/m.tsv"; fi
  done < <(cd "$tmp/x" && find . -type f | sort)
  mv "$tmp/m.tsv" "$manifest"; rm -rf "$tmp"
  echo "skills installed in $dest"
}
```

- [ ] **Step 3: Run** — Expected: PASS. **Commit:**

```bash
git add bin/mobrain test/unit/cli/skills.test.ts
git commit -m "feat(cli): skills install with an edit-preserving manifest

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7.10: `backup`, `restore`, `upgrade`

**Files:**
- Modify: `bin/mobrain`
- Test: `test/unit/cli/ops.test.ts`

Use the dump and restore commands recorded by probe P8 if they differ from below.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/cli/ops.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cliWorld, curlRoutes, type Cli } from './harness.ts';

let c: Cli; let repo: string; let backups: string;
beforeEach(async () => {
  c = await cliWorld();
  repo = join(c.root, 'repo'); backups = join(c.root, 'backups');
  await mkdir(join(repo, 'compose'), { recursive: true });
  await writeFile(join(repo, 'compose', 'docker-compose.yml'), '');
  await writeFile(join(repo, '.env'), 'COMPOSE_PROJECT_NAME=mobrain-dev\nMOBRAIN_PORT=8788\nGBRAIN_VERSION=0.60.230.0\n');
  // pg_dump prints a fake dump; the volume tar creates the archive in the mounted /b dir.
  await c.stub('docker', `case "$*" in
  *pg_dump*) echo DUMP;;
  *"-czf /b/gbrain-home.tgz"*) for a in "$@"; do case "$a" in *:/b) : > "\${a%:/b}/gbrain-home.tgz";; esac; done;;
esac
exit 0`);
  await c.stub('git', 'echo abc123');
  await c.stub('curl', curlRoutes([['/api/health', 200, '{"ok":true}']]));
});
afterEach(async () => rm(c.root, { recursive: true, force: true }));
const env = () => ({ MOBRAIN_REPO: repo, MOBRAIN_BACKUP_DIR: backups });

test('backup writes both dumps, the volume tar, version, commit and a manifest', async () => {
  const r = await c.run(['backup'], env());
  expect(r.code).toBe(0);
  const dir = r.stdout.trim().split('\n').at(-1)!;
  expect((await readdir(dir)).sort()).toEqual(['COMMIT', 'GBRAIN_VERSION', 'MANIFEST.sha256', 'env.sha256', 'gbrain-home.tgz', 'gbrain.dump', 'mobrain.dump']);
  expect(await readFile(join(dir, 'gbrain.dump'), 'utf8')).toBe('DUMP\n');
  const tar = (await c.calls('docker')).find((a) => a.includes('tar'))!;
  expect(tar).toContain('mobrain-dev_gbrain-home:/v:ro');
});

test('backup --prune keeps the newest 7', async () => {
  const base = join(backups, 'mobrain-dev');
  for (let i = 0; i < 9; i++) await mkdir(join(base, `2026010${i}T000000Z`), { recursive: true });
  await c.run(['backup', '--prune'], env());
  expect((await readdir(base)).length).toBe(7);
});

test('restore refuses without --yes and on a version mismatch', async () => {
  const r = await c.run(['backup'], env());
  const dir = r.stdout.trim().split('\n').at(-1)!;
  expect((await c.run(['restore', dir], env())).code).toBe(64);
  await writeFile(join(dir, 'GBRAIN_VERSION'), '0.60.200.0\n');
  expect((await c.run(['restore', dir, '--yes'], env())).code).toBe(17);
});

test('restore ignores the probe P8 pg_restore errors and fails on any other', async () => {
  const ignored = `case "$*" in
  *pg_dump*) echo DUMP;;
  *"-czf /b/gbrain-home.tgz"*) for a in "$@"; do case "$a" in *:/b) : > "\${a%:/b}/gbrain-home.tgz";; esac; done;;
  *pg_restore*)
    echo 'pg_restore: error: could not execute query: ERROR:  must be owner of extension vector' >&2
    echo 'pg_restore: error: could not execute query: ERROR:  permission denied to create event trigger "auto_rls_on_create_table"' >&2
    echo 'pg_restore: error: could not execute query: ERROR:  must be owner of extension citext' >&2
    echo 'pg_restore: warning: errors ignored on restore: 2' >&2
    exit 1;;
  esac
  exit 0`;
  await c.stub('docker', ignored);
  const r = await c.run(['backup'], env());
  const dir = r.stdout.trim().split('\n').at(-1)!;
  expect((await c.run(['restore', dir, '--yes'], env())).code).toBe(0);
  await c.stub('docker', ignored.replace('must be owner of extension vector', 'relation "pages" already exists'));
  expect((await c.run(['restore', dir, '--yes'], env())).code).not.toBe(0);
});

test('upgrade backs up first, sets the pin, migrates, reinstalls packs', async () => {
  await mkdir(join(repo, 'packs'), { recursive: true });
  const r = await c.run(['upgrade', '--gbrain', '0.60.240.0'], env());
  expect(r.code).toBe(0);
  expect(await readFile(join(repo, '.env'), 'utf8')).toContain('GBRAIN_VERSION=0.60.240.0');
  const cmds = (await c.calls('docker')).map((a) => a.join(' '));
  const i = (s: string) => cmds.findIndex((x) => x.includes(s));
  expect(i('pg_dump')).toBeLessThan(i('build gbrain'));
  expect(i('apply-migrations')).toBeGreaterThan(i('build mobrain'));
  expect(i('mobrain-core.json')).toBeGreaterThan(i('apply-migrations'));
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Add to `bin/mobrain`**

```bash
# ---- backup, restore, upgrade -----------------------------------------------------------

backup_base() { printf '%s/%s' "${MOBRAIN_BACKUP_DIR:-$HOME/backups/mobrain}" "$(project)"; }
vol() { printf '%s_gbrain-home' "$(project)"; }
gbrain_image() { printf 'mobrain-gbrain:%s' "$(env_get GBRAIN_VERSION)"; }

# Probe P8: pg_restore exits 1 and ignores these. They are not a failed restore.
pg_restore_ok() {
  local line
  while IFS= read -r line; do
    case "$line" in
      'pg_restore: error:'*)
        case "$line" in
          *'must be owner of extension vector'*|*'must be owner of extension citext'*|*'permission denied to create event trigger "auto_rls_on_create_table"'*) ;;
          *) return 1 ;;
        esac ;;
    esac
  done
  return 0
}

restore_db() {
  local db=$1 dump=$2 log
  log="$(mktemp)"
  set +e
  dc exec -T postgres pg_restore -U postgres -d "$db" --no-owner --role="$db" < "$dump" >"$log" 2>&1
  set -e
  if ! pg_restore_ok < "$log"; then cat "$log" >&2; rm -f "$log"; die "pg_restore $db failed" 1; fi
  rm -f "$log"
}

cmd_backup() {
  need_stack
  local prune=0; [ "${1:-}" = --prune ] && prune=1
  local dest; dest="$(backup_base)/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$dest"
  dc exec -T postgres pg_dump -U postgres -Fc gbrain > "$dest/gbrain.dump"
  dc exec -T postgres pg_dump -U postgres -Fc mobrain > "$dest/mobrain.dump"
  docker run --rm -v "$(vol):/v:ro" -v "$dest:/b" "$(gbrain_image)" tar -C /v -czf /b/gbrain-home.tgz .
  env_get GBRAIN_VERSION > "$dest/GBRAIN_VERSION"
  git -C "$REPO" rev-parse HEAD > "$dest/COMMIT" 2>/dev/null || echo unknown > "$dest/COMMIT"
  sha256 "$ENV_FILE" > "$dest/env.sha256"
  ( cd "$dest" && for f in gbrain.dump mobrain.dump gbrain-home.tgz GBRAIN_VERSION COMMIT; do printf '%s  %s\n' "$(sha256 "$f")" "$f"; done > MANIFEST.sha256 )
  if [ "$prune" = 1 ]; then
    ls -1d "$(backup_base)"/*/ 2>/dev/null | sort | head -n -7 | while read -r old; do rm -rf "$old"; done
  fi
  echo "$dest"
}

cmd_restore() {
  need_stack
  local dir=${1:-} yes=0 allow=0; shift || true
  for a in "$@"; do case "$a" in --yes) yes=1 ;; --allow-version-change) allow=1 ;; *) usage ;; esac; done
  [ -d "$dir" ] && [ "$yes" = 1 ] || usage
  [ -f "$dir/gbrain.dump" ] && [ -f "$dir/mobrain.dump" ] && [ -f "$dir/gbrain-home.tgz" ] || die "$dir is not a Mo-brain backup" 17
  local bv; bv="$(tr -d '\n' < "$dir/GBRAIN_VERSION")"
  [ "$bv" = "$(env_get GBRAIN_VERSION)" ] || [ "$allow" = 1 ] || die "backup is gbrain $bv, .env pins $(env_get GBRAIN_VERSION); pass --allow-version-change" 17
  [ "$(sha256 "$ENV_FILE")" = "$(cat "$dir/env.sha256" 2>/dev/null)" ] || echo "mobrain: warning: .env differs from the one at backup time; stored tokens may not open" >&2
  dc stop autopilot gbrain mobrain
  local db
  for db in gbrain mobrain; do
    dc exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -c "drop database if exists $db with (force)" -c "create database $db owner $db"
    restore_db "$db" "$dir/$db.dump"
  done
  docker run --rm -v "$(vol):/v" "$(gbrain_image)" find /v -mindepth 1 -delete
  docker run --rm -v "$(vol):/v" -v "$dir:/b:ro" "$(gbrain_image)" tar -C /v -xzf /b/gbrain-home.tgz
  dc up -d --wait
  cmd_status
}

cmd_upgrade() {
  need_stack
  [ "${1:-}" = --gbrain ] && [ -n "${2:-}" ] || usage
  local to=$2 from; from="$(env_get GBRAIN_VERSION)"
  local b; b="$(cmd_backup | tail -1)"
  echo "backup: $b" >&2
  sed -i.bak "s/^GBRAIN_VERSION=.*/GBRAIN_VERSION=$to/" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  if ! { dc build gbrain && dc build mobrain && dc stop autopilot mobrain && dc up -d --wait gbrain \
         && dc exec -T gbrain gbrain apply-migrations --yes --non-interactive && install_packs && dc up -d --wait; }; then
    echo "mobrain: upgrade $from -> $to failed. To roll back:" >&2
    echo "  sed -i 's/^GBRAIN_VERSION=.*/GBRAIN_VERSION=$from/' $ENV_FILE && mobrain restore $b --yes" >&2
    exit 1
  fi
  echo "upgraded gbrain $from -> $to. Read gbrain's skills/migrations notes for every version crossed, then re-run 'mobrain skills install'." >&2
  cmd_status
}
```

(`install_packs` copies `mobrain-core` and `mobrain-personal` over the installed ones, which is the point after an upgrade; `mobrain-brain` is `cp -n`.)

- [ ] **Step 3: Run** — Expected: PASS. **Commit:**

```bash
git add bin/mobrain test/unit/cli/ops.test.ts
git commit -m "feat(cli): backup with manifest and pruning, guarded restore, upgrade with rollback hint

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7.11: `join`

**Files:**
- Modify: `bin/mobrain`
- Test: `test/unit/cli/join.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/cli/join.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cliWorld, curlRoutes, type Cli } from './harness.ts';

let c: Cli;
beforeEach(async () => {
  c = await cliWorld();
  await c.stub('claude'); await c.stub('systemctl', 'exit 1'); await c.stub('loginctl', 'echo no');
  await c.stub('crontab', 'if [ "$1" = -l ]; then exit 1; else cat > /dev/null; fi');
  await c.stub('tar'); // skills bundle contents are covered by skills.test.ts
});
afterEach(async () => rm(c.root, { recursive: true, force: true }));

test('join writes runner.env, registers the agent, installs skills and timers', async () => {
  await c.stub('curl', curlRoutes([
    ['/api/clients/issue?format=env', 200, 'token=tok-1\nmcp_url=https://b.ts.net/mcp\nname=gbrain\nexpires_at=2027-01-01T00:00:00.000Z'],
  ]).replace('url="${@: -1}"', 'url="${@: -1}"; for a in "$@"; do [ "$prev" = -o ] && : > "$a"; prev=$a; done'));
  const r = await c.run(['join', '--url', 'https://b.ts.net', '--key', 'mbk_join']);
  expect(r.code).toBe(0);
  const env = await readFile(join(c.home, '.config/mobrain/runner.env'), 'utf8');
  expect(env).toContain('MOBRAIN_URL=https://b.ts.net');
  expect(env).toContain('MOBRAIN_API_KEY=mbk_join');
  expect(env).toContain('MOBRAIN_REGISTERED=1');
  expect((await c.calls('claude'))[1]).toContain('https://b.ts.net/mcp');
  expect(r.stdout).toContain('timers installed');
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Add to `bin/mobrain`**

```bash
# ---- join (a member's machine) ------------------------------------------------------------

cmd_join() {
  local url="" key="" skills="$HOME/.claude/skills"
  while [ $# -gt 0 ]; do
    case "$1" in --url) url=$2; shift 2 ;; --key) key=$2; shift 2 ;; --skills-dir) skills=$2; shift 2 ;; *) usage ;; esac
  done
  [ -n "$url" ] && [ -n "$key" ] || usage
  write_runner_env "${url%/}" "$key"
  cmd_client issue agent --register
  cmd_skills install --dir "$skills"
  cmd_timers install
  echo "joined ${url%/}. Restart your agent session once so it loads the gbrain MCP server and skills."
}
```

- [ ] **Step 3: Run every suite** — `bun run lint:forbidden && bun run typecheck && bun run test:unit && bun run test:db` — Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add bin/mobrain test/unit/cli/join.test.ts
git commit -m "feat(cli): join for members

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
