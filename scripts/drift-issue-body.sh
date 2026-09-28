#!/bin/sh
# Body for the nightly pinned-next drift issue. Reads log excerpts from the
# current directory. Never calls gh.
set -eu
version=${1:?gbrain version}
run_url=${2:?run url}
pinned=${3:?pinned-current}

excerpt() {
  file=$1
  pattern=$2
  if [ ! -f "$file" ]; then
    return 1
  fi
  # grep exits 1 when nothing matches. That is "try the next source", not an error.
  hit=$(grep -E "$pattern" "$file" | head -50 || true)
  if [ -n "$hit" ]; then
    printf '%s\n' "$hit"
    return 0
  fi
  return 1
}

detail=$(excerpt contract-output.txt '^\(fail\)' || true)
if [ -z "$detail" ]; then
  detail=$(excerpt bootstrap-output.txt 'error:|/wizard/finish' || true)
fi
if [ -z "$detail" ]; then
  detail=$(excerpt build-output.txt 'ERROR:|operations.json missing|error:' || true)
fi
if [ -z "$detail" ]; then
  detail='no failure excerpt was captured; the job failed before the contract suite'
fi

cat <<EOF
Nightly pinned-next run failed against gbrain \`$version\`.

Run: $run_url
Pinned-current (\`$pinned\`) is unaffected; this is a tripwire, not an outage.

Failing tests:
\`\`\`
$detail
\`\`\`

G1 holds: do not move the pin to make this pass. Fix the seam or widen the contract test.
EOF
