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
