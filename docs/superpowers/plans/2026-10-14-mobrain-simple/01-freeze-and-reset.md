# Phase 1: Freeze v1 and reset the repo

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Read `00-master.md` (Global Constraints, Shared interfaces) first.

**Goal:** Preserve v1 exactly (WIP committed, tag `v1-final`), then delete v1 code and leave a minimal skeleton whose lint, typecheck and unit tests pass.

**Spec sections:** §14 (kept, ported, deleted), §13 (CI), §17 step 1.

---

### Task 1.1: Commit the in-progress onboarding work and tag v1

**Files:**
- Commit as is: `docs/runbooks/onboarding.md`, `skills/RESOLVER.md`, `skills/mobrain-onboard-setup/SKILL.md`, `skills/mobrain-onboard-import/` (untracked)

- [ ] **Step 1: Confirm the working tree holds only the expected changes**

Run: `git -C ~/MO-BRAIN status --short`
Expected: exactly these four lines (order may differ):
```
 M docs/runbooks/onboarding.md
 M skills/RESOLVER.md
 M skills/mobrain-onboard-setup/SKILL.md
?? skills/mobrain-onboard-import/
```
If anything else is listed, stop and ask the user what it is.

- [ ] **Step 2: Commit them on `main`**

```bash
cd ~/MO-BRAIN
git add docs/runbooks/onboarding.md skills/RESOLVER.md skills/mobrain-onboard-setup/SKILL.md skills/mobrain-onboard-import
git commit -m "wip(onboarding): stage-4 import skill and onboarding edits (v1 final state)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Tag the frozen v1 and record the commit**

```bash
git tag -a v1-final -m "Mo-brain v1, frozen before the simplification (spec 2026-10-14)"
git rev-parse v1-final^{commit}
```
Expected: a sha. Do not push the tag; pushing is the user's call.

- [ ] **Step 4: Create the work branch**

```bash
git switch -c simplify
```

---

### Task 1.2: Delete v1 code

**Files:**
- Delete: everything listed in spec §14 "Deleted"
- Move: `skills/mobrain-onboard-import/` → `skills/mobrain-import/`
- Move: repo-root `.env` (v1 dev env, untracked) → `.env.v1-dev`

- [ ] **Step 1: Move the untracked v1 dev env out of the way**

```bash
cd ~/MO-BRAIN
test -f .env && mv .env .env.v1-dev
```
`.gitignore` gains `.env.*` with `!.env.example` in Task 1.4, so `.env.v1-dev` stays untracked.

- [ ] **Step 2: Remove v1 code and docs with git**

```bash
cd ~/MO-BRAIN
git rm -r -q src contracts drizzle.config.ts vite.config.ts \
  compose docker \
  test/integration test/contract test/e2e test/build test/helpers \
  docs/runbooks docs/specs \
  .github/workflows/release.yml .github/workflows/release-verify.yml \
  skills/mobrain-operator skills/mobrain-onboard-setup skills/mobrain-schema-designer skills/query \
  INSTALL_FOR_AGENTS.md CHANGELOG.md
git rm -q $(git ls-files scripts | grep -v -E '^scripts/(lint-forbidden\.ts|test-isolated\.sh)$')
git rm -q $(git ls-files test/unit | grep -v -E '^test/unit/(lint-forbidden|workflows)\.test\.ts$')
git mv skills/mobrain-onboard-import skills/mobrain-import
rm -rf dist
```

- [ ] **Step 3: Check what is left**

Run: `git ls-files | sort`
Expected, exactly (plus `docs/superpowers/**` and `docs/archive/**` and `docs/README.md` if present):
```
.gitattributes
.github/workflows/ci.yml
.github/workflows/stack.yml
.gitignore
.env.example
CLAUDE.md
HANDOFF.md
LICENSE
README.md
SECURITY.md
bun.lock
package.json
scripts/lint-forbidden.ts
scripts/test-isolated.sh
skills/RESOLVER.md
skills/mobrain-import/SKILL.md
test/unit/lint-forbidden.test.ts
test/unit/workflows.test.ts
tsconfig.json
```
(`skills/mobrain-import/` may hold more files than `SKILL.md`; keep them all.)

`docs/archive/` stays: it is history the repo rules already fence off.

---

### Task 1.3: New package.json and dependencies

**Files:**
- Rewrite: `package.json`
- Regenerate: `bun.lock`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "mobrain",
  "private": true,
  "type": "module",
  "engines": { "bun": ">=1.4.2" },
  "scripts": {
    "test:unit": "bash scripts/test-isolated.sh test/unit && bash scripts/test-isolated.sh test/unit/cli",
    "test:db": "bash scripts/test-db.sh",
    "lint:forbidden": "bun run scripts/lint-forbidden.ts",
    "typecheck": "tsc --noEmit",
    "ui:build": "vite build",
    "ui:dev": "vite"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.3.3",
    "@types/bun": "latest",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^6.1.1",
    "tailwindcss": "^4.3.3",
    "typescript": "^5.6.0",
    "vite": "^8.3.0"
  },
  "dependencies": {
    "dompurify": "^3.2.0",
    "hono": "^4.13.8",
    "lucide-react": "^1.47.0",
    "marked": "^15.0.0",
    "postgres": "^3.4.9",
    "react": "^19.3.0",
    "react-dom": "^19.3.0",
    "yaml": "^2.9.1"
  }
}
```

Removed on purpose: `better-auth`, `drizzle-orm`, `drizzle-kit`, every `@codemirror/*` and `@lezer/*` package.

- [ ] **Step 2: Install and refresh the lockfile**

Run: `cd ~/MO-BRAIN && rm -rf node_modules && bun install`
Expected: exit 0; `bun.lock` changes.

- [ ] **Step 3: Point `tsconfig.json` at the new layout**

Replace the `include` line with:
```json
  "include": ["src", "scripts", "test"]
```
(unchanged text; confirm it is still exactly this, and that `"types": ["bun-types"]` is present.)

---

### Task 1.4: `.gitignore`, `.env.example`

**Files:**
- Modify: `.gitignore`
- Rewrite: `.env.example`

- [ ] **Step 1: Write `.gitignore`**

```gitignore
node_modules/
.env
.env.*
!.env.example
dist/
.superpowers/
.worktrees/
.mobrain-tmp/
```

- [ ] **Step 2: Write `.env.example`**

```bash
# Written by `bin/mobrain install` with mode 0600. Never regenerate it:
# ENCRYPTION_KEY seals stored gbrain client tokens.
COMPOSE_PROJECT_NAME=mobrain
# Exact gbrain pin. Never a moving tag.
GBRAIN_VERSION=0.60.230.0
MOBRAIN_PORT=8787
MOBRAIN_PUBLIC_URL=http://127.0.0.1:8787
POSTGRES_PASSWORD=
ENCRYPTION_KEY=
GBRAIN_ADMIN_BOOTSTRAP_TOKEN=
OPENAI_API_KEY=
```

---

### Task 1.5: Prune `lint:forbidden`

**Files:**
- Modify: `scripts/lint-forbidden.ts`
- Modify: `test/unit/lint-forbidden.test.ts`

- [ ] **Step 1: Write the failing tests for the new shape**

In `test/unit/lint-forbidden.test.ts`:

1. Delete these tests (by name): `flags a harness ref that is a dist-tag or missing entirely`, `does not flag the exact harness pin or the platform sub-packages`, `flags any edit to the gateway token salt or info`, and the whole `describe('production-compose-build (D2)', ...)` block.
2. Replace the body of `flags a plaintext secret column` with:

```ts
  test('flags a plaintext secret column', async () => {
    await writeFile(join(dir, 'a', '001.sql'), `  plaintext text not null,\n`);
    const v = await lintForbidden(dir);
    expect(v.map((x) => x.rule)).toContain('secret-column-name');
  });
```

3. Add, inside `describe('lintForbidden', ...)`:

```ts
  // bin/mobrain has no extension; the walker must still read it.
  test('lints extensionless scripts under bin/', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bs-bin-'));
    await mkdir(join(root, 'bin'), { recursive: true });
    await writeFile(join(root, 'bin', 'mobrain'), '#!/usr/bin/env bash\ngbrain autopilot --install\n');
    const v = await lintForbidden(root);
    expect(v.map((x) => x.rule)).toContain('autopilot-install');
    await rm(root, { recursive: true, force: true });
  });

  test('flags a shell-string gbrain invocation in bash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bs-bash-'));
    await mkdir(join(root, 'bin'), { recursive: true });
    await writeFile(join(root, 'bin', 'x'), `#!/usr/bin/env bash\nbash -c "gbrain init --url $u"\n`);
    const v = await lintForbidden(root);
    expect(v.map((x) => x.rule)).toContain('shell-string-gbrain-bash');
    await rm(root, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test test/unit/lint-forbidden.test.ts`
Expected: FAIL on `flags a plaintext secret column`, `lints extensionless scripts under bin/`, `flags a shell-string gbrain invocation in bash`.

- [ ] **Step 3: Update the rules and the walker**

In `scripts/lint-forbidden.ts`:

1. Delete the rules `moving-harness-pin` and `production-compose-build`.
2. Replace the `secret-column-name` rule with:

```ts
  {
    rule: 'secret-column-name',
    re: /\b(plaintext|api_key_plain|secret_value)\s+text\b/i,
    why: 'secrets and tokens are sealed; a plaintext column makes a pg_dump a credential dump',
  },
```

3. Replace the `frozen-crypto-domain` rule's `re` and comment with:

```ts
  {
    rule: 'frozen-crypto-domain',
    // 'mobrain-kek-v1' is an HKDF domain separator. Changing it makes every
    // sealed token permanently undecryptable.
    re: /Buffer\.from\(\s*['"`](?!mobrain-kek-v1['"`])[\w-]*-kek-v\d+['"`]/,
    why: 'the HKDF domain separator is frozen forever; renaming it destroys every sealed token',
  },
```

4. Add after `shell-string-harness`:

```ts
  {
    rule: 'shell-string-gbrain-bash',
    re: /\b(sh|bash)\s+-c\s+["'][^"']*(?<![\w\/-])(gbrain|claude)\s/,
    why: 'argv arrays only, in bash too: build an array and run "${cmd[@]}"',
  },
```

5. In `walk`, replace the final `else if` with:

```ts
    } else if (EXTS.some((x) => e.name.endsWith(x)) || dir.endsWith('/bin') || e.name.endsWith('.sql')) {
      yield join(dir, e.name);
    }
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/unit/lint-forbidden.test.ts && bun run lint:forbidden`
Expected: all pass; `lint:forbidden clean`.

- [ ] **Step 5: Commit**

```bash
git add -A scripts/lint-forbidden.ts test/unit/lint-forbidden.test.ts
git commit -m "chore(lint): prune v1-only rules, lint bin/ and SQL

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1.6: CI workflows

**Files:**
- Rewrite: `.github/workflows/ci.yml`
- Rewrite: `.github/workflows/stack.yml`
- Modify: `test/unit/workflows.test.ts`

- [ ] **Step 1: Update the workflow test first**

In `test/unit/workflows.test.ts`:
1. Delete the tests `release.yml pushes only on v* tags, never on branches` and `release.yml publishes only after the stack suite passes`.
2. Replace the body of `only ci.yml runs on push or pull_request` with:

```ts
    const automatic = Object.entries(workflows())
      .filter(([, wf]) => triggers(wf).some((t) => t === 'push' || t === 'pull_request'))
      .map(([name]) => name);
    expect(automatic).toEqual(['ci.yml']);
```

3. Replace the `stack.yml runs only on demand...` test with:

```ts
  test('stack.yml runs only on demand', () => {
    expect(triggers(workflows()['stack.yml']!)).toEqual(['workflow_dispatch']);
  });

  test('the workflow set is exactly ci.yml and stack.yml', () => {
    expect(Object.keys(workflows()).sort()).toEqual(['ci.yml', 'stack.yml']);
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test test/unit/workflows.test.ts`
Expected: FAIL on `stack.yml runs only on demand` (stack.yml still has `workflow_call`).

- [ ] **Step 3: Write `ci.yml`**

```yaml
name: ci

# The only workflow that runs on its own: lint, typecheck and the unit suite
# (no Docker, ~1 billed minute). Budget and rules: CLAUDE.md.
on:
  push:
    branches: [main]
    paths-ignore: ['docs/**', '*.md']
  pull_request:
    paths-ignore: ['docs/**', '*.md']
  workflow_dispatch:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  unit:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.4.2 }
      - run: bun install --frozen-lockfile
      - run: bun run lint:forbidden
      - run: bun run typecheck
      - run: bun run test:unit
```

- [ ] **Step 4: Write `stack.yml`**

```yaml
name: stack

# The Docker self-test (bin/mobrain selftest, keyless, stub harness). Never on
# push or pull_request. Run by hand, at most once per finished change:
#   gh workflow run stack.yml --ref <branch>
on:
  workflow_dispatch: {}

concurrency:
  group: stack-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  selftest:
    runs-on: ubuntu-latest
    timeout-minutes: 40
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.4.2 }
      - run: bun install --frozen-lockfile
      - run: bin/mobrain selftest
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/unit/workflows.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows test/unit/workflows.test.ts
git commit -m "ci: lint+typecheck+unit on push; manual selftest; drop release lanes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1.7: Skeleton directories and the DB test runner

**Files:**
- Create: `src/server/.gitkeep`, `src/ui/.gitkeep`, `bin/.gitkeep`, `packs/.gitkeep`, `test/unit/cli/.gitkeep`, `test/db/.gitkeep`
- Create: `scripts/test-db.sh`
- Modify: `HANDOFF.md` (banner only; full rewrite in phase 9)

- [ ] **Step 1: Create the directories**

```bash
cd ~/MO-BRAIN
mkdir -p src/server src/ui bin packs test/unit/cli test/db
touch src/server/.gitkeep src/ui/.gitkeep bin/.gitkeep packs/.gitkeep test/unit/cli/.gitkeep test/db/.gitkeep
```

- [ ] **Step 2: Write `scripts/test-db.sh`**

```bash
#!/usr/bin/env bash
# Run test/db against a throwaway Postgres in a container named mobrain-test-pg
# on 127.0.0.1:55432. Local only; CI never runs this.
set -euo pipefail

name=mobrain-test-pg
if ! docker ps --format '{{.Names}}' | grep -qx "$name"; then
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --rm --name "$name" -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 \
    pgvector/pgvector:pg16 >/dev/null
  for _ in $(seq 1 60); do
    docker exec "$name" pg_isready -U postgres >/dev/null 2>&1 && break
    sleep 1
  done
fi
export TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres
exec bash scripts/test-isolated.sh test/db
```

Run: `chmod +x scripts/test-db.sh`

- [ ] **Step 3: Make `test-isolated.sh` tolerate an empty directory**

In `scripts/test-isolated.sh`, after the `mapfile` line add:

```bash
if [ "${#files[@]}" -eq 0 ]; then echo "no tests in $dir"; exit 0; fi
```

- [ ] **Step 4: Put a banner at the top of `HANDOFF.md`**

Insert as the first lines:

```markdown
> **Rebuild in progress (2026-10-14).** v1 is frozen at tag `v1-final`. The new shape is
> `docs/superpowers/specs/2026-10-14-mobrain-simple-design.md`, built by
> `docs/superpowers/plans/2026-10-14-mobrain-simple/`. Everything below describes v1.
```

- [ ] **Step 5: Verify the whole skeleton**

Run: `bun run lint:forbidden && bun run typecheck && bun run test:unit`
Expected: `lint:forbidden clean`; tsc exit 0 (it may warn about no inputs; if tsc errors with "No inputs were found", add `test/unit/lint-forbidden.test.ts` is already an input, so it should not); unit summary `0 failed`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: v2 skeleton (server, ui, bin, packs, db test runner)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
