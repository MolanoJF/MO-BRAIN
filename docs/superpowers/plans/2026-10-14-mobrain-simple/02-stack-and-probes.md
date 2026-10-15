# Phase 2: The stack, the packs, and the probes

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Read `00-master.md` first.

**Goal:** A pinned gbrain image at `0.60.230.0`, a compose file with `postgres`, `gbrain` and `autopilot` (the `mobrain` service is added in phase 3), the two shipped schema packs with their fixes, and recorded answers to probes P1–P8. The phase ends by amending the spec and the later phase files with what the probes found.

**Spec sections:** §4.1, §4.2, §6.1, §16.

All Docker work in this phase uses compose project `mobrain-dev`. Define this shell helper once per terminal:

```bash
cd ~/MO-BRAIN
dc() { docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml "$@"; }
```

---

### Task 2.1: The gbrain image

**Files:**
- Create: `docker/gbrain.Dockerfile`
- Create: `test/build/gbrain-pin.test.sh`

- [ ] **Step 1: Write the build gate test**

```bash
#!/usr/bin/env bash
# The pinned build succeeds and reports the pin; a wrong pin fails the build.
set -euo pipefail
cd "$(dirname "$0")/../.."
pin=0.60.230.0
docker build -q -f docker/gbrain.Dockerfile --build-arg GBRAIN_VERSION="$pin" -t mobrain-gbrain:"$pin" . >/dev/null
out="$(docker run --rm mobrain-gbrain:"$pin" gbrain --version)"
[ "${out##* }" = "$pin" ] || { echo "version mismatch: $out"; exit 1; }
if docker build -q -f docker/gbrain.Dockerfile --build-arg GBRAIN_VERSION=0.0.0.1 -t mobrain-gbrain:bad . >/dev/null 2>&1; then
  echo "a bad pin built"; exit 1
fi
echo "gbrain pin gate OK"
```

Run: `mkdir -p test/build && chmod +x test/build/gbrain-pin.test.sh && bash test/build/gbrain-pin.test.sh`
Expected: FAIL (`docker/gbrain.Dockerfile` does not exist).

- [ ] **Step 2: Write `docker/gbrain.Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
# Pinned gbrain. The version is an exact ARG; never a moving ref.
FROM oven/bun:1.4.2

ARG GBRAIN_VERSION
RUN test -n "$GBRAIN_VERSION" || (echo "GBRAIN_VERSION build-arg is required" >&2; exit 1)

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini postgresql-client \
 && rm -rf /var/lib/apt/lists/*

RUN bun install -g "github:garrytan/gbrain#v${GBRAIN_VERSION}"
ENV PATH="/root/.bun/bin:${PATH}"

# MIT obligation: ship the license text.
RUN cp /root/.bun/install/global/node_modules/gbrain/LICENSE /opt/gbrain-LICENSE && test -s /opt/gbrain-LICENSE

# Build gate: the binary reports the pin (version is the last token).
RUN gbrain --version | tee /opt/gbrain-version.txt \
 && awk -v v="${GBRAIN_VERSION}" '$NF == v { ok = 1 } END { exit !ok }' /opt/gbrain-version.txt

# Build gate: the tool catalog is real JSON. Bun.file().json() rather than a
# require() eval, which can swallow a later exception and fake a pass.
RUN gbrain --tools-json > /tmp/tools.json \
 && bun -e 'const d = await Bun.file("/tmp/tools.json").json(); if (typeof d !== "object" || d === null) process.exit(1)' \
 && rm -f /tmp/tools.json

# The skills bundle the instance serves (phase 9) is copied from here.
RUN ln -s /root/.bun/install/global/node_modules/gbrain /opt/gbrain

# Upgrades go through bin/mobrain; an in-container self-upgrade would
# desynchronize the image from the binary.
ENV GBRAIN_SELF_UPGRADE_MODE=off \
    GBRAIN_NO_AUTOPILOT_INSTALL=1 \
    GBRAIN_NO_ONBOARD_NUDGE=1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
```

- [ ] **Step 3: Run the gate**

Run: `bash test/build/gbrain-pin.test.sh`
Expected: `gbrain pin gate OK` (the first build takes several minutes on this host).

- [ ] **Step 4: Commit**

```bash
git add docker/gbrain.Dockerfile test/build/gbrain-pin.test.sh
git commit -m "build: pinned gbrain 0.60.230.0 image with build gates

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.2: Compose (postgres, gbrain, autopilot)

**Files:**
- Create: `compose/docker-compose.yml`
- Create: `compose/docker-compose.dev.yml`
- Create: `compose/initdb/01-dbs.sh`
- Create: `.env` (dev, untracked)

- [ ] **Step 1: Write `compose/initdb/01-dbs.sh`**

```bash
#!/usr/bin/env bash
# Runs once, on an empty pg-data volume. Two databases, two roles, one password.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<SQL
CREATE ROLE gbrain LOGIN PASSWORD '${POSTGRES_PASSWORD}';
CREATE ROLE mobrain LOGIN PASSWORD '${POSTGRES_PASSWORD}';
CREATE DATABASE gbrain OWNER gbrain;
CREATE DATABASE mobrain OWNER mobrain;
\c gbrain
CREATE EXTENSION IF NOT EXISTS vector;
ALTER SCHEMA public OWNER TO gbrain;
\c mobrain
CREATE EXTENSION IF NOT EXISTS citext;
ALTER SCHEMA public OWNER TO mobrain;
SQL
```

Run: `chmod +x compose/initdb/01-dbs.sh`

- [ ] **Step 2: Write `compose/docker-compose.yml`**

```yaml
name: ${COMPOSE_PROJECT_NAME:-mobrain}

x-gbrain-env: &gbrain-env
  GBRAIN_HOME: /srv/gbrain-home
  GBRAIN_DATABASE_URL: postgres://gbrain:${POSTGRES_PASSWORD:?required}@postgres:5432/gbrain
  OPENAI_API_KEY: ${OPENAI_API_KEY:-}
  GBRAIN_ADMIN_BOOTSTRAP_TOKEN: ${GBRAIN_ADMIN_BOOTSTRAP_TOKEN:?required}

x-gbrain-image: &gbrain-image
  image: mobrain-gbrain:${GBRAIN_VERSION:?required}
  build:
    context: ..
    dockerfile: docker/gbrain.Dockerfile
    args:
      GBRAIN_VERSION: ${GBRAIN_VERSION:?required}

services:
  postgres:
    image: pgvector/pgvector:pg16
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?required}
    volumes:
      - pg-data:/var/lib/postgresql/data
      - ./initdb:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
      interval: 5s
      timeout: 5s
      retries: 30
    networks: [internal]

  gbrain:
    <<: *gbrain-image
    restart: unless-stopped
    environment:
      <<: *gbrain-env
      # The proxy (mobrain) is a peer container; without this every client IP
      # collapses to the proxy's and the pre-auth rate limiter mis-buckets.
      GBRAIN_HTTP_TRUST_PROXY: "1"
    command: ["gbrain", "serve", "--http", "--bind", "0.0.0.0", "--port", "3131",
              "--public-url", "${MOBRAIN_PUBLIC_URL:-http://127.0.0.1:8787}"]
    volumes:
      - gbrain-home:/srv/gbrain-home
    depends_on:
      postgres: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "bun", "-e", "const r = await fetch('http://127.0.0.1:3131/health'); process.exit(r.ok ? 0 : 1)"]
      interval: 10s
      timeout: 5s
      retries: 30
    stop_grace_period: 60s
    mem_limit: 1g
    networks: [internal]

  autopilot:
    <<: *gbrain-image
    restart: unless-stopped
    environment:
      <<: *gbrain-env
    # Foreground daemon; it spawns its own job worker. Never --install.
    command: ["gbrain", "autopilot", "--interval", "${AUTOPILOT_INTERVAL:-300}"]
    volumes:
      - gbrain-home:/srv/gbrain-home
    depends_on:
      gbrain: { condition: service_healthy }
    stop_grace_period: 60s
    mem_limit: 1536m
    networks: [internal]

volumes:
  pg-data:
  gbrain-home:

networks:
  internal: {}
```

- [ ] **Step 3: Write `compose/docker-compose.dev.yml`**

```yaml
# Development overrides. Use only with COMPOSE_PROJECT_NAME=mobrain-dev.
services:
  gbrain:
    # Lets host-side probes and the selftest reach MCP directly.
    ports:
      - "127.0.0.1:${GBRAIN_DEV_PORT:-3139}:3131"
  autopilot:
    environment:
      AUTOPILOT_INTERVAL: "60"
    command: ["gbrain", "autopilot", "--interval", "60"]
```

- [ ] **Step 4: Write the dev `.env` (untracked)**

```bash
cd ~/MO-BRAIN
test ! -e .env || { echo ".env exists; stop"; false; }
umask 077
cat > .env <<EOF
COMPOSE_PROJECT_NAME=mobrain-dev
GBRAIN_VERSION=0.60.230.0
MOBRAIN_PORT=8788
MOBRAIN_PUBLIC_URL=http://127.0.0.1:8788
POSTGRES_PASSWORD=$(openssl rand -hex 16)
ENCRYPTION_KEY=$(openssl rand -base64 32)
GBRAIN_ADMIN_BOOTSTRAP_TOKEN=$(openssl rand -hex 32)
OPENAI_API_KEY=
EOF
```

- [ ] **Step 5: Validate the compose files**

Run: `dc config --quiet && echo ok`
Expected: `ok`.

- [ ] **Step 6: Commit**

```bash
git add compose
git commit -m "compose: postgres, gbrain serve, autopilot; dev overrides

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.3: The shipped schema packs

**Files:**
- Create: `packs/mobrain-core.json` (from `v1-final:src/ops/packs/mobrain-core.json`)
- Create: `packs/mobrain-personal.json` (from `v1-final:src/ops/packs/mobrain-personal.json`)
- Create: `packs/mobrain-brain.template.json`
- Create: `packs/SHA256SUMS`
- Create: `test/unit/packs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/packs.test.ts
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dir, '..', '..', 'packs');
const read = (n: string) => JSON.parse(readFileSync(join(dir, n), 'utf8'));
type Pack = {
  name: string; version: string; extends: string | null; gbrain_min_version: string;
  page_types: { name: string; path_prefixes: string[] }[];
  link_types: { name: string; inference?: { regex?: string; ner_only?: boolean } }[];
};

describe('shipped packs', () => {
  const core = read('mobrain-core.json') as Pack;
  const personal = read('mobrain-personal.json') as Pack;
  const brain = read('mobrain-brain.template.json') as Pack;

  test('the chain is core <- personal <- brain', () => {
    expect(core.extends).toBeNull();
    expect(personal.extends).toBe('mobrain-core');
    expect(brain.extends).toBe('mobrain-personal');
    expect(brain.page_types).toEqual([]);
  });

  test('core 1.1.0 declares the collector type', () => {
    expect(core.version).toBe('1.1.0');
    const t = core.page_types.find((p) => p.name === 'collector');
    expect(t?.path_prefixes).toEqual(['system/collectors/']);
  });

  test('both shipped packs require gbrain 0.60.230', () => {
    expect(core.gbrain_min_version).toBe('0.60.230');
    expect(personal.gbrain_min_version).toBe('0.60.230');
  });

  test('every regex-inferred personal link type is ner_only', () => {
    for (const name of ['founded', 'works_at', 'advises']) {
      const l = personal.link_types.find((x) => x.name === name);
      expect(l?.inference?.ner_only).toBe(true);
    }
  });

  test('SHA256SUMS matches the shipped files', () => {
    const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n');
    for (const line of sums) {
      const [hash, file] = line.split(/\s+/);
      const actual = createHash('sha256').update(readFileSync(join(dir, file!))).digest('hex');
      expect(actual).toBe(hash!);
    }
    expect(sums.map((l) => l.split(/\s+/)[1]).sort()).toEqual(['mobrain-core.json', 'mobrain-personal.json']);
  });
});
```

Run: `bun test test/unit/packs.test.ts`
Expected: FAIL (files missing).

- [ ] **Step 2: Restore the v1 packs**

```bash
cd ~/MO-BRAIN
git show v1-final:src/ops/packs/mobrain-core.json > packs/mobrain-core.json
git show v1-final:src/ops/packs/mobrain-personal.json > packs/mobrain-personal.json
```

- [ ] **Step 3: Apply the three fixes with a one-off script**

```bash
bun -e '
const p = (n) => `packs/${n}`;
const core = await Bun.file(p("mobrain-core.json")).json();
core.version = "1.1.0";
core.gbrain_min_version = "0.60.230";
if (!core.page_types.some((t) => t.name === "collector")) {
  core.page_types.push({ name: "collector", primitive: "annotation", path_prefixes: ["system/collectors/"],
    aliases: [], extractable: false, expert_routing: false });
}
await Bun.write(p("mobrain-core.json"), JSON.stringify(core, null, 2) + "\n");
const personal = await Bun.file(p("mobrain-personal.json")).json();
personal.gbrain_min_version = "0.60.230";
for (const l of personal.link_types) {
  if (["founded", "works_at", "advises"].includes(l.name) && l.inference) l.inference.ner_only = true;
}
await Bun.write(p("mobrain-personal.json"), JSON.stringify(personal, null, 2) + "\n");
'
```

If `annotation` is not a valid primitive at 0.60.230 (P1 checks it with `gbrain schema validate`), use the primitive gbrain's bundled packs use for administrative pages and record the choice in the probes file.

- [ ] **Step 4: Write `packs/mobrain-brain.template.json`**

```json
{
  "api_version": "gbrain-schema-pack-v1",
  "name": "mobrain-brain",
  "version": "1.0.0",
  "description": "This brain's own schema layer. Extend it through gbrain's schema tools and the mobrain-schema skill; never redefine a mobrain-core or mobrain-personal entry.",
  "gbrain_min_version": "0.60.230",
  "extends": "mobrain-personal",
  "borrow_from": [],
  "page_types": [],
  "link_types": []
}
```

- [ ] **Step 5: Write `SHA256SUMS`**

Run: `cd packs && sha256sum mobrain-core.json mobrain-personal.json > SHA256SUMS && cd ..`

- [ ] **Step 6: Run the test**

Run: `bun test test/unit/packs.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packs test/unit/packs.test.ts
git commit -m "packs: mobrain-core 1.1.0 (collector type), personal ner_only, brain template

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.4: Probes P1–P8

**Files:**
- Create: `docs/superpowers/specs/2026-10-14-mobrain-simple-probes.md`

This task is investigation, not TDD. For each probe, run the commands, paste the relevant output (secrets redacted) into the probes file under a heading `## P<n>`, and write one line `Result: PASS` or `Result: FAIL -> fallback taken: <what>`. Where a command's flag is rejected, find the right one with `gbrain <cmd> --help` and record the command that worked.

Start the probe file with:

```markdown
# Probe results, gbrain 0.60.230.0 (2026-10-14)

Stack: compose project mobrain-dev, Postgres engine. Commands are the ones that worked.
```

- [ ] **Step 1: P1 — init, packs, activation**

```bash
dc up -d postgres
dc run --rm gbrain gbrain init --non-interactive --search-mode balanced --json
# with a key only: add --embedding-model openai:text-embedding-3-small
dc run --rm gbrain mkdir -p /srv/gbrain-home/.gbrain/schema-packs/mobrain-core /srv/gbrain-home/.gbrain/schema-packs/mobrain-personal /srv/gbrain-home/.gbrain/schema-packs/mobrain-brain
dc run --rm -v "$PWD/packs:/packs:ro" gbrain cp /packs/mobrain-core.json /srv/gbrain-home/.gbrain/schema-packs/mobrain-core/pack.json
dc run --rm -v "$PWD/packs:/packs:ro" gbrain cp /packs/mobrain-personal.json /srv/gbrain-home/.gbrain/schema-packs/mobrain-personal/pack.json
dc run --rm -v "$PWD/packs:/packs:ro" gbrain cp /packs/mobrain-brain.template.json /srv/gbrain-home/.gbrain/schema-packs/mobrain-brain/pack.json
dc run --rm gbrain gbrain schema validate mobrain-brain
dc run --rm gbrain gbrain config set schema_pack mobrain-brain
dc run --rm gbrain gbrain schema active --json
dc run --rm gbrain gbrain doctor --json
dc up -d gbrain autopilot && dc ps
```

Pass: `schema active` names `mobrain-brain` and its chain reaches `mobrain-core`; `doctor` reports no errors; `gbrain` is healthy. Record: the exact `init` flags that worked, the embedding flag syntax, whether `serve` needed anything else on first start.

- [ ] **Step 2: P5 — DB-only sources**

```bash
dc exec -T gbrain gbrain sources add p-probe-a --name "Probe A" --json
dc exec -T gbrain gbrain sources add p-probe-b --name "Probe B" --json
dc exec -T gbrain gbrain sources add c-company --name "Company" --json
dc exec -T gbrain gbrain sources list --json
```

Pass: the three sources exist without a filesystem path. Record whether a path was created under `/srv/gbrain-home` (`dc exec -T gbrain ls -R /srv/gbrain-home | head -50`). Keep these sources for P2, P3, P6, P7.

- [ ] **Step 3: P2 — clients**

```bash
dc exec -T gbrain gbrain mcp profiles --json
dc exec -T gbrain gbrain mcp grant probe-a --source p-probe-a --federated-read c-company \
  --profile memory-writer --token-ttl 7776000 --credentials-out /tmp/probe-a.json \
  --url http://127.0.0.1:8788/mcp --json
dc exec -T gbrain cat /tmp/probe-a.json
```

Record: every profile name with its scopes; the receipt JSON shape (field holding the client id); the credentials file shape (field holding the bearer and its expiry); the maximum `--token-ttl` accepted. Then, with `TOKEN_A` set from the credentials file:

```bash
mcp() { curl -sS http://127.0.0.1:3139/mcp -H "authorization: Bearer $1" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$2\",\"arguments\":$3}}"; }
mcp "$TOKEN_A" whoami '{}'
dc exec -T gbrain gbrain auth rescope-client <client-id> --federated-read '' --json
mcp "$TOKEN_A" whoami '{}'
dc exec -T gbrain gbrain auth revoke-client <client-id>
mcp "$TOKEN_A" whoami '{}'   # expect 401
```

Then mint a second client with each profile that carries `admin` scope and check, with that client: `put_page` of `notes/probe-admin` into its write source works without a namespace fence (the slug is not forced under `agents/`), and `get_health` and `list_jobs` succeed. Record the profile that gives `read,write,admin` with an unfenced write, or record that none does.

Finally check a harness can use a bearer:

```bash
mkdir -p /tmp/claude-probe && cd /tmp/claude-probe
claude mcp add --scope local --transport http gbrain-probe http://127.0.0.1:3139/mcp --header "Authorization: Bearer $TOKEN_B"
claude mcp list
claude mcp remove --scope local gbrain-probe
cd ~/MO-BRAIN
```

Pass: grant, rescope, revoke all work; revoked token gets 401; `claude mcp list` shows `gbrain-probe` connected.

- [ ] **Step 4: P3 — isolation**

Mint clients: `A` (memory-writer, writes `p-probe-a`, reads `c-company`), `B` (memory-writer, writes `p-probe-b`, no federated read), `ADM` (the admin-scope profile from P2, writes `p-probe-a`, reads `c-company`), `W` (memory-writer, writes `c-company`). Then:

```bash
mcp "$TOKEN_B" put_page '{"slug":"notes/secret-b","content":"---\ntype: note\n---\nzebracorn-b only in B"}'
mcp "$TOKEN_W" put_page '{"slug":"notes/company-x","content":"---\ntype: note\n---\nzebracorn-c in company"}'
for t in "$TOKEN_A" "$TOKEN_ADM"; do
  mcp "$t" search '{"query":"zebracorn-b"}'
  mcp "$t" get_page '{"slug":"notes/secret-b"}'
  mcp "$t" list_pages '{"limit":100}'
  mcp "$t" search '{"query":"zebracorn-c"}'
done
mcp "$TOKEN_ADM" get_stats '{}'
mcp "$TOKEN_ADM" sources_list '{}'
```

Pass: neither A nor ADM sees any slug or text from `p-probe-b`; both find `zebracorn-c`. Record what `sources_list` and `get_stats` reveal to ADM (names and counts of other sources are acceptable; page content is not).

- [ ] **Step 5: P6 — autopilot covers remote writes**

```bash
mcp "$TOKEN_A" put_page '{"slug":"people/ada-probe","content":"---\ntype: person\n---\nAda Probe."}'
mcp "$TOKEN_A" put_page '{"slug":"notes/meets-ada","content":"---\ntype: note\n---\nMet [[people/ada-probe]] today."}'
sleep 150
mcp "$TOKEN_A" get_page '{"slug":"people/ada-probe","include_content":true}'
dc logs --since 5m autopilot | tail -50
```

Pass: within two 60-second ticks the backlink from `notes/meets-ada` is visible (in `get_page` links/backlinks or `graph-query`), and, if a key is set, the page has an embedding (`gbrain doctor` embed coverage). Record which.

- [ ] **Step 6: P7 — what the UI can read**

```bash
mcp "$TOKEN_A" put_page '{"slug":"system/collectors/probe","content":"---\ntype: collector\nkind: fixture\nenabled: true\ncadence: 1h\n---\nprobe"}'
mcp "$TOKEN_A" list_pages '{"prefix":"system/collectors/","limit":50}'
mcp "$TOKEN_A" get_page '{"slug":"system/collectors/probe","include_content":true}'
dc run --rm --no-deps -v mobrain-dev_gbrain-home:/srv/gbrain-home:ro gbrain gbrain schema show --json | head -c 2000
dc exec -T gbrain gbrain --tools-json | bun -e 'const t = await new Response(Bun.stdin).json(); for (const x of t) if (["list_pages","get_page","schema_stats","schema_review_orphans","list_jobs","run_doctor","get_health","get_stats","sources_status"].includes(x.name)) console.log(x.name, JSON.stringify(x.inputSchema ?? x.input_schema ?? x.parameters))'
```

Then check the trusted local write path the server uses for collector pages (phase 9, task 9.1):

```bash
dc exec -T gbrain gbrain put --help | head -30
printf -- '---\ntype: collector\nkind: fixture\nenabled: false\ncadence: 1h\n---\nvia cli\n' \
  | dc exec -T gbrain gbrain put system/collectors/probe-cli --source p-probe-a
mcp "$TOKEN_A" get_page '{"slug":"system/collectors/probe-cli","include_content":true}'
```

Pass: `list_pages` accepts a prefix (record the exact argument name) and returns frontmatter or at least slugs; `get_page` returns content and frontmatter; `schema show --json` works with a read-only home mount; `gbrain put` writes into a named source from stdin (record the flag that names the source). Record the input schema of each listed tool; phase 3 and 6 code uses these argument names.

- [ ] **Step 7: P4 — headless harness from a user timer**

```bash
loginctl show-user "$USER" -p Linger
systemctl --user status >/dev/null && echo user-bus-ok
claude mcp add --scope user --transport http gbrain-probe http://127.0.0.1:3139/mcp --header "Authorization: Bearer $TOKEN_A"
cat > /tmp/claude-probe/run.sh <<'EOF'
#!/usr/bin/env bash
cd /tmp/claude-probe
exec claude -p "Call the gbrain-probe MCP tool whoami and print its JSON. Then list the names of any MCP tools you have whose names begin with mcp__claude_ai_." \
  --allowedTools "mcp__gbrain-probe__*" --output-format json > /tmp/claude-probe/out.json 2> /tmp/claude-probe/err.txt
EOF
chmod +x /tmp/claude-probe/run.sh
systemd-run --user --unit mobrain-probe --on-active=5s --property=RuntimeMaxSec=600 /tmp/claude-probe/run.sh
sleep 120; cat /tmp/claude-probe/out.json; cat /tmp/claude-probe/err.txt
claude mcp remove --scope user gbrain-probe
```

Pass: `out.json` holds a `whoami` result for client A and the run exited 0 under systemd. Record: whether lingering is on (if off, whether `loginctl enable-linger` works without sudo); whether claude.ai connector tools are present headless; the JSON output fields (`result`, `is_error`, `total_cost_usd`); behaviour when a tool outside `--allowedTools` is requested. If the user bus is unavailable, repeat with a crontab line and record that.

- [ ] **Step 8: P8 — backup and restore**

```bash
ts=$(date -u +%Y%m%dT%H%M%SZ); b=/tmp/mobrain-probe-backup/$ts; mkdir -p "$b"
dc exec -T postgres pg_dump -U postgres -Fc gbrain > "$b/gbrain.dump"
dc exec -T postgres pg_dump -U postgres -Fc mobrain > "$b/mobrain.dump"
docker run --rm -v mobrain-dev_gbrain-home:/v:ro -v "$b:/b" alpine tar -C /v -czf /b/gbrain-home.tgz .
dc down -v
dc up -d postgres
dc exec -T postgres pg_restore -U postgres -d gbrain --no-owner --role=gbrain < "$b/gbrain.dump"
dc exec -T postgres pg_restore -U postgres -d mobrain --no-owner --role=mobrain < "$b/mobrain.dump"
docker run --rm -v mobrain-dev_gbrain-home:/v -v "$b:/b" alpine tar -C /v -xzf /b/gbrain-home.tgz
dc up -d gbrain autopilot
mcp "$TOKEN_A" get_page '{"slug":"notes/meets-ada"}'
```

Pass: the page survives (and token A still works, since its client row is in the restored DB). Record the exact restore commands, and any errors from `pg_restore` about the vector extension or ownership.

- [ ] **Step 9: Stop the dev stack**

Run: `dc down`

- [ ] **Step 10: Commit the probe results**

```bash
git add docs/superpowers/specs/2026-10-14-mobrain-simple-probes.md
git commit -m "docs(probes): gbrain 0.60.230.0 probe results P1-P8

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.5: Amend the spec and the later phases

**Files:**
- Modify: `docs/superpowers/specs/2026-10-14-mobrain-simple-design.md`
- Modify: phase files 03–10 where the probes changed a value

- [ ] **Step 1: Apply each probe result**

For every probe, make exactly these edits when the recorded value differs from what the plans assume:

| Probe | Assumed in plans | Where to edit |
|---|---|---|
| P1 | `gbrain init --non-interactive --search-mode balanced [--embedding-model openai:text-embedding-3-small] --json` | `07-cli.md` task 7.3 (`install_gbrain_init`) |
| P2 | profiles `memory-reader`, `memory-writer`, `coding-agent`; the credentials file holds `client_id`, `access_token` and `expires_at`; TTL max `7776000` | `03-server-foundation.md` task 3.6 (`parseCredentials`, `CLIENT_TTL_SECONDS`), `04-people-and-company.md` task 4.1 (`PROFILES`) |
| P2 | admin profile for owner/admin agents = `memory-writer` (no unfenced admin profile) | `04` task 4.1: set `ADMIN_AGENT_PROFILE` to the profile P2 found, or keep `memory-writer` and leave admin work to the instance client and `bin/mobrain schema exec` |
| P3 | admin-scope clients do not see other sources' content | if FAIL: `04` task 4.1 sets `ADMIN_AGENT_PROFILE = 'memory-writer'` and spec §5.2 says so |
| P4 | `claude -p ... --allowedTools ... --output-format json`; systemd user timers with lingering | `07-cli.md` tasks 7.7, 7.8 (`harness_claude_code`, `timers_install`) |
| P5 | `gbrain sources add <id> --name <n>` with no path | `03` task 3.6 (`addSource`); if a path is needed, `compose` mounts `gbrain-home` rw on `mobrain` (phase 3, task 3.10) |
| P6 | autopilot alone sweeps remote writes | if FAIL: `autopilot` runs `compose/autopilot-loop.sh` as in spec §8.5; do not put the loop in an `sh -c` string |
| P7 | `list_pages` takes `prefix` and `source`; returns `frontmatter`; `get_page` takes `include_content` | `06` task 6.1 (the `A` constant in `src/server/gbrain/pages.ts`) |
| P7 | `gbrain put <slug> --source <id>` reads the page from stdin | `09-skills-and-docs.md` task 9.1 (`putPageArgv`) |
| P8 | restore commands as in step 8 | `07` task 7.10 |

- [ ] **Step 2: Mark the spec**

In spec §16, add a line under the table: `Results: docs/superpowers/specs/2026-10-14-mobrain-simple-probes.md (<date>). Fallbacks taken: <list or "none">.`

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers
git commit -m "docs: apply probe results to spec and plans

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
