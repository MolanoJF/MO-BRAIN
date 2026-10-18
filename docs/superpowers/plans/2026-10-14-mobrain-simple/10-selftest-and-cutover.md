# Phase 10: Self-test, acceptance, cutover

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Read `00-master.md` first. Tasks 10.5 onward touch the live brain: every step marked **ASK** stops for the user's explicit yes.

**Goal:** One command that proves the whole product on a throwaway stack; an acceptance run with the user's real agent on `mobrain-dev`; then the cutover of Molior's live brain (`mobrain-molior`) from v1 to the new stack.

**Spec sections:** §1 (success criteria), §13, §17.

---

### Task 10.1: `mobrain selftest`

**Files:**
- Create: `test/selftest/selftest.sh`, `test/selftest/stub-harness.sh`
- Modify: `bin/mobrain` (`cmd_selftest`)

The self-test uses its own compose project (`mobrain-selftest`), env file (`.env.selftest`, git-ignored by `.env.*`), port 8790, and temp config and state dirs, so it never touches `mobrain-dev` or the person's real harness configuration.

- [ ] **Step 1: Write `test/selftest/stub-harness.sh`**

```bash
#!/usr/bin/env bash
# Stands in for the agent in `mobrain selftest`: writes each fixture file as a
# note through gbrain MCP, then prints the two lines the runner reads.
set -euo pipefail
n=0
for f in "$SELFTEST_FIXTURE"/*.md; do
  name="$(basename "$f" .md)"
  body="$(sed 's/\\/\\\\/g; s/"/\\"/g' "$f" | awk '{printf "%s\\n", $0}')"
  curl -sS "$SELFTEST_URL/mcp" -H "authorization: Bearer $SELFTEST_TOKEN" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"put_page\",\"arguments\":{\"slug\":\"notes/fixture/$name\",\"content\":\"---\\ntype: note\\n---\\n$body\"}}}" >/dev/null
  n=$((n + 1))
done
echo "MOBRAIN_STATUS: ok"
echo "MOBRAIN_SUMMARY: read $n, created $n, updated 0, skipped 0, errors 0"
```

- [ ] **Step 2: Write `test/selftest/selftest.sh`**

```bash
#!/usr/bin/env bash
# Mo-brain self-test: a fresh keyless stack (project mobrain-selftest), end to end.
#   bin/mobrain selftest [--keep] [--real-harness]
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MB="$REPO/bin/mobrain"
KEEP=0 REAL=0
for a in "$@"; do case "$a" in --keep) KEEP=1 ;; --real-harness) REAL=1 ;; *) echo "usage: mobrain selftest [--keep] [--real-harness]" >&2; exit 64 ;; esac; done

WORK="$(mktemp -d)"; PORT=8790; URL="http://127.0.0.1:$PORT"
export MOBRAIN_ENV_FILE="$REPO/.env.selftest" MOBRAIN_CONFIG_DIR="$WORK/owner" MOBRAIN_STATE_DIR="$WORK/state"
if [ -e "$MOBRAIN_ENV_FILE" ]; then
  echo "a previous selftest left $MOBRAIN_ENV_FILE. Clean up with: MOBRAIN_ENV_FILE=$MOBRAIN_ENV_FILE $MB down -v && rm $MOBRAIN_ENV_FILE" >&2
  exit 17
fi

pass=0 fail=0
check() { local name=$1; shift; if "$@" >/dev/null 2>&1; then echo "ok   $name"; pass=$((pass + 1)); else echo "FAIL $name"; fail=$((fail + 1)); fi; }
teardown() { if [ "$KEEP" = 0 ]; then "$MB" down -v >/dev/null 2>&1 || true; rm -f "$MOBRAIN_ENV_FILE"; rm -rf "$WORK"; else echo "kept: $MOBRAIN_ENV_FILE, $WORK"; fi; }
trap teardown EXIT

mcp() { curl -sS "$URL/mcp" -H "authorization: Bearer $1" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$2\",\"arguments\":$3}}"; }
http() { curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $1" "$URL$2"; }
kv() { sed -n "s/^$2=//p" <<< "$1" | head -1; }
lacks() { ! grep -q "$1" <<< "$2"; }

echo "== install"
"$MB" install --owner-email owner@selftest.local --keyless --project mobrain-selftest --port "$PORT" > "$WORK/receipt"
OKEY="$(sed -n 's/^MOBRAIN_API_KEY=//p' "$WORK/owner/runner.env")"
check "status ok" "$MB" status
check "core lock ok" "$MB" schema check

echo "== owner agent"
OWNER_TOKEN="$(kv "$("$MB" client issue agent)" token)"
mcp "$OWNER_TOKEN" put_page '{"slug":"notes/selftest-private","content":"---\ntype: note\n---\nselftest-private-marker"}' > /dev/null
check "owner reads own page" grep -q selftest-private-marker <<< "$(mcp "$OWNER_TOKEN" get_page '{"slug":"notes/selftest-private","include_content":true}')"

echo "== company mode and isolation"
"$MB" mode company > /dev/null
"$MB" source add "Selftest Secret" > /dev/null
claim="$("$MB" member invite member@selftest.local --role member)"
claimed="$(curl -sS -X POST "$URL/api/claim/${claim##*/claim/}" -H 'content-type: application/json' -d '{"password":"selftest-member-pw"}')"
MKEY="$(sed -n 's/.*"joinKey":"\([^"]*\)".*/\1/p' <<< "$claimed")"
mkdir -p "$WORK/member" && printf 'MOBRAIN_URL=%s\nMOBRAIN_API_KEY=%s\n' "$URL" "$MKEY" > "$WORK/member/runner.env"
"$MB" grant member@selftest.local c-company > /dev/null
MEMBER_TOKEN="$(kv "$(MOBRAIN_CONFIG_DIR="$WORK/member" "$MB" client issue agent)" token)"
W1="$(kv "$("$MB" client issue company-writer c-company)" token)"
W2="$(kv "$("$MB" client issue company-writer c-selftest-secret)" token)"
mcp "$W1" put_page '{"slug":"notes/shared","content":"---\ntype: note\n---\nzebrashared"}' > /dev/null
mcp "$W2" put_page '{"slug":"notes/secret","content":"---\ntype: note\n---\nzebrasecret"}' > /dev/null
sleep 5
check "member finds the granted company page" grep -q notes/shared <<< "$(mcp "$MEMBER_TOKEN" search '{"query":"zebrashared"}')"
check "member cannot find an ungranted company page" lacks notes/secret "$(mcp "$MEMBER_TOKEN" search '{"query":"zebrasecret"}')"
check "member cannot read the owner's private page" lacks selftest-private-marker "$(mcp "$MEMBER_TOKEN" get_page '{"slug":"notes/selftest-private","include_content":true}')"
check "member's page list has no owner pages" lacks selftest-private "$(mcp "$MEMBER_TOKEN" list_pages '{"limit":500}')"

echo "== collector"
mkdir -p "$WORK/fixture"
printf '# Alpha\nfixture-alpha-marker\n' > "$WORK/fixture/alpha.md"
printf '# Beta\nfixture-beta\n' > "$WORK/fixture/beta.md"
slug="$("$MB" collector add --title Fixture --kind fixture --cadence 1h --notes "$WORK/fixture")"
if [ "$REAL" = 1 ]; then
  export MOBRAIN_WORKDIR="$WORK/agent" MOBRAIN_MCP_SCOPE=local
  mkdir -p "$MOBRAIN_WORKDIR"
  "$MB" client issue agent --register > /dev/null
  "$MB" skills install --dir "$MOBRAIN_WORKDIR/.claude/skills" > /dev/null
  check "fixture collector through claude -p" "$MB" collect "$slug" --backfill
else
  export MOBRAIN_HARNESS=stub MOBRAIN_STUB_HARNESS="$REPO/test/selftest/stub-harness.sh" \
    SELFTEST_URL="$URL" SELFTEST_TOKEN="$(kv "$("$MB" client issue agent)" token)" SELFTEST_FIXTURE="$WORK/fixture"
  check "fixture collector through the stub harness" "$MB" collect "$slug" --backfill
fi
check "fixture page is in the brain" grep -q fixture-alpha-marker <<< "$(curl -s -H "authorization: Bearer $OKEY" "$URL/api/pages/p-owner/notes/fixture/alpha")"
check "the run is recorded ok" grep -q '"status":"ok"' <<< "$("$MB" collector list)"
check "nothing is due right after" grep -q 'nothing due' <<< "$("$MB" collect --due)"

echo "== UI API by role"
check "owner admin health 200" test "$(http "$OKEY" /api/admin/health)" = 200
check "member admin health 403" test "$(http "$MKEY" /api/admin/health)" = 403
check "member schema 200" test "$(http "$MKEY" /api/schema)" = 200
check "member sees own and granted sources only" test "$(curl -s -H "authorization: Bearer $MKEY" "$URL/api/sources" | grep -o '"id":"[^"]*"' | tr '\n' ' ')" = '"id":"p-member" "id":"c-company" '
check "UI is served" grep -q 'id="root"' <<< "$(curl -s "$URL/pages")"
check "skills bundle is served" test "$(http "$OKEY" /install/skills.tar.gz)" = 200
check "CLI is served without a key" grep -q '^#!/usr/bin/env bash' <<< "$(curl -s "$URL/install/mobrain")"

echo "== offboard and backup"
"$MB" member offboard member@selftest.local > /dev/null
check "offboarded member's agent token is rejected" test "$(curl -s -o /dev/null -w '%{http_code}' "$URL/mcp" -H "authorization: Bearer $MEMBER_TOKEN" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}')" = 401
b="$(MOBRAIN_BACKUP_DIR="$WORK/backups" "$MB" backup | tail -1)"
check "backup has both dumps and the volume" test -s "$b/gbrain.dump" -a -s "$b/mobrain.dump" -a -s "$b/gbrain-home.tgz"

echo "== $pass passed, $fail failed"
[ "$fail" = 0 ]
```

Run: `chmod +x test/selftest/*.sh`

- [ ] **Step 3: Add `cmd_selftest` to `bin/mobrain`**

```bash
cmd_selftest() {
  [ -f "$REPO/test/selftest/selftest.sh" ] || die "selftest runs from a Mo-brain checkout" 17
  exec bash "$REPO/test/selftest/selftest.sh" "$@"
}
```

- [ ] **Step 4: Run it**

Run: `cd ~/MO-BRAIN && bin/mobrain selftest`
Expected: every line `ok`, last line `== N passed, 0 failed`, exit 0, and afterwards `docker compose ls -a` shows no `mobrain-selftest` project.

For each `FAIL`, re-run with `--keep`, inspect (`MOBRAIN_ENV_FILE=.env.selftest bin/mobrain logs mobrain`), fix the cause in code with a unit or DB test that reproduces it first, then run `bun run test:unit && bun run test:db` and the self-test again.

- [ ] **Step 5: Commit**

```bash
git add test/selftest bin/mobrain
git commit -m "test: end-to-end selftest on a throwaway stack

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10.2: Size and suite check (success criteria 6 and 7)

- [ ] **Step 1: Count**

```bash
cd ~/MO-BRAIN
find src bin -type f \( -name '*.ts' -o -name '*.tsx' -o -name 'mobrain' \) -not -path 'src/ui/ui/*' -print0 | xargs -0 wc -l | tail -1
find src/ui/ui -type f -print0 | xargs -0 wc -l | tail -1
```

Expected: the first total under 10,000 (target 6,000 to 8,000). The second is the ported design-system primitives, reported separately. If the first is over 10,000, list the largest files and raise it with the user before going on.

- [ ] **Step 2: Every suite green**

Run: `bun run lint:forbidden && bun run typecheck && bun run test:unit && bun run test:db && bash test/build/gbrain-pin.test.sh`
Expected: all pass. Record the counts in the task's commit message.

---

### Task 10.3: Acceptance with the real agent on `mobrain-dev`

This is the user's acceptance run of the actual product path, on dev.

- [ ] **Step 1: ASK** — "I'm ready to run the real install path on the dev stack, using your Claude Code headless with your own connectors, and an OpenAI key for embeddings. It registers an MCP server named `gbrain-dev` (not `gbrain`) at user scope so it doesn't clash with the live one later. OK to proceed, and which OpenAI key should I use?"

- [ ] **Step 2: Wipe and install dev**

```bash
cd ~/MO-BRAIN
bin/mobrain down -v 2>/dev/null || true
rm -f .env
umask 077; printf '%s' "<key>" > /tmp/mobrain-key
bin/mobrain install --owner-email <user email> --openai-key-file /tmp/mobrain-key --project mobrain-dev --port 8788
rm -f /tmp/mobrain-key
```

- [ ] **Step 3: Follow `skills/mobrain-install/SKILL.md` Phases 4–8 exactly as written**, with one change for dev: register the MCP server as `gbrain-dev` by running `bin/mobrain client issue agent` and then `claude mcp add --scope user --transport http gbrain-dev http://127.0.0.1:8788/mcp --header "Authorization: Bearer <token>"`, and pass `--tools` patterns for the user's real connectors (for example `mcp__claude_ai_Gmail__*`). Connect at least email and calendar, and one docs source if the user has one.

Record, in `docs/superpowers/specs/2026-10-14-mobrain-simple-acceptance.md`: the human touchpoints counted, time taken, pages per source, each collector's first-run status and summary, and every defect.

- [ ] **Step 4: Unattended run** — leave the timer running for at least one cadence of the shortest collector; then check `bin/mobrain collector list` shows a second, timer-driven `ok` run, and the UI's Sources page shows it.

- [ ] **Step 5: UI walk** — repeat task 8.10 step 2 on the populated brain, as the owner and as an invited member (use the browser skill).

- [ ] **Step 6: Fix and re-verify** each defect (test first), then run the self-test again.

- [ ] **Step 7: Clean up dev registrations** — `claude mcp remove --scope user gbrain-dev`; `bin/mobrain timers remove`; `bin/mobrain down` (keep the dev data for comparison until cutover is done).

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/specs/2026-10-14-mobrain-simple-acceptance.md
git commit -m "docs: acceptance run on mobrain-dev

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10.4: Merge to `main`

- [ ] **Step 1: Review the whole branch** — dispatch the final whole-branch review (superpowers:requesting-code-review) against `v1-final..simplify`; fix findings with tests.

- [ ] **Step 2: Fast-forward `main`**

```bash
cd ~/MO-BRAIN
git switch main
git merge --ff-only simplify
```

- [ ] **Step 3: ASK** before pushing: "`main` now holds the new Mo-brain. Push it (one CI run: lint, typecheck, unit), and push the `v1-final` tag?" Push only on yes: `git push origin main` and, if approved, `git push origin v1-final`.

---

### Task 10.5: Cutover of the live brain (`mobrain-molior`)

Live paths (from `CLAUDE.local.md`): worktree `~/mobrain-molior` on branch `molior`, compose project `mobrain-molior`, live URL `https://molior-vps.meerkat-kingsnake.ts.net:8443` via `tailscale serve` to Caddy on `127.0.0.1:19443`.

- [ ] **Step 1: Look before touching**

```bash
cd ~/mobrain-molior && git status --short && git log --oneline -1
docker compose ls -a
tailscale serve status
```

Report what you see to the user (including the live brain's page count from the old console's health or `docker compose -p mobrain-molior exec -T gbrain-ops gbrain stats`, read-only).

- [ ] **Step 2: Back up v1** — `cd ~/mobrain-molior && ./molior.sh backup`. Record the backup path. Confirm it contains both databases.

- [ ] **Step 3: ASK** — "v1 is backed up at <path> (<page count> pages). I'll now stop the v1 live stack (volumes kept, nothing deleted), fast-forward `molior` to the new `main`, install the new stack as project `mobrain-molior` on port 19443, and then ask you before switching `tailscale serve`. The v1 volumes stay until you tell me to remove them. Go ahead?

  This also replaces the live `.env`: `ENCRYPTION_KEY` changes, so secrets sealed by v1 stay readable only with `.env.v1`. `CLAUDE.local.md` forbids regenerating `.env`; the user's yes here is the explicit override, so say so in the question."

- [ ] **Step 4: Stop v1, keep its volumes**

```bash
cd ~/mobrain-molior
./molior.sh down          # no -v
docker compose ls -a      # mobrain-molior shows exited or is gone; volumes remain (docker volume ls | grep mobrain-molior)
```

v1's volume names (`mobrain-molior_pg-data`, `mobrain-molior_gbrain-home`, `mobrain-molior_brain-repos`; the last holds the live brain git repo and owner credential files, so it must be copied, never just removed) collide with the new stack's names. Rename them out of the way so the new install starts empty and v1's data stays intact:

```bash
for v in pg-data gbrain-home brain-repos; do
  docker volume create "mobrain-molior-v1_$v"
  docker run --rm -v "mobrain-molior_$v:/from:ro" -v "mobrain-molior-v1_$v:/to" mobrain-gbrain:0.60.230.0 cp -a /from/. /to/
done
```

**ASK** before the next command, showing `docker volume ls | grep mobrain-molior` output: "The v1 volumes (pg-data, gbrain-home, brain-repos) are copied to `mobrain-molior-v1_*`; verify with `docker run --rm -v mobrain-molior-v1_brain-repos:/d:ro alpine ls -A /d` first. Remove the originals so the new stack can use the names?" On yes: `docker volume rm mobrain-molior_pg-data mobrain-molior_gbrain-home mobrain-molior_brain-repos mobrain-molior_caddy-data mobrain-molior_caddy-config`.

- [ ] **Step 5: Move `molior` forward and install**

```bash
cd ~/mobrain-molior
git merge --ff-only main
mv .env .env.v1
umask 077; printf '%s' "<the live OpenAI key, from .env.v1's OPENAI key line or the user>" > /tmp/mobrain-key
bin/mobrain install --owner-email <user email> --openai-key-file /tmp/mobrain-key --project mobrain-molior \
  --port 19443 --public-url https://molior-vps.meerkat-kingsnake.ts.net:8443
rm -f /tmp/mobrain-key
bin/mobrain status
```

(`.env.v1` is never read again; it stays beside the new `.env` as the spec says.)

- [ ] **Step 6: ASK, then switch Tailscale** — "The new stack is healthy on 127.0.0.1:19443 (plain HTTP). Switch `tailscale serve` on 8443 from the old Caddy target to it?" On yes:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:19443
curl -s https://molior-vps.meerkat-kingsnake.ts.net:8443/api/health
```

- [ ] **Step 7: The user's agent onboards** — follow `skills/mobrain-install/SKILL.md` Phases 4–8 against the live install, from `~/mobrain-molior`. **ASK** first: "Your Claude Code has an old `mobrain` MCP entry (it fails with 401). Remove it, and register the live brain as `gbrain`?" On yes: `claude mcp remove mobrain` (in the scope it lives in), then Phase 4 as written.

If the user wants their old brain imported, create a `notes-import` collector for it (Phase 5) per the user's memory notes: refile into `mobrain-core`, through gbrain, never a raw copy.

- [ ] **Step 8: Verify live** — the install skill's contract checks, plus the UI at the live URL.

- [ ] **Step 9: Update `CLAUDE.local.md`** (local, not committed):
  - Live: `~/mobrain-molior` on `molior`, project `mobrain-molior`, port 19443, public URL unchanged.
  - Ship a change: commit on `main` in `~/MO-BRAIN`; in `~/mobrain-molior`: `bin/mobrain backup`, `git merge --ff-only main`, `bin/mobrain up --build`, `bin/mobrain status`.
  - Keep every existing rule (never edit files there, never `down -v`, never regenerate `.env`, ask before reset or restore). Replace `molior.sh` references with `bin/mobrain`.
  - v1 data: volumes `mobrain-molior-v1_*` and `.env.v1`, kept until the user says to remove them.

- [ ] **Step 10: Update memory** — in `/home/ubuntu/.claude/projects/-home-ubuntu-MO-BRAIN/memory/`: mark `mobrain-live-first-onboarding.md` and `mobrain-skills-installed-by-agent.md` as superseded by the 2026-10-14 rebuild (skills now ship in the instance's bundle; the live brain was reinstalled), keep `ingest-through-gbrain-into-core-schema.md` and `mirror-gbrain-skills-exactly.md` (still true), and add one project memory: the new shape, the spec path, and where v1 data is kept. Update `MEMORY.md` lines to match.

- [ ] **Step 11: Report to the user** — what changed, the live URL, what was ingested, the collector schedule, where v1 data and its backup are, and the one cleanup still open (removing v1 volumes when they are sure).
