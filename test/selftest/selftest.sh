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
