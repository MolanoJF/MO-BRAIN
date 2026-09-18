#!/usr/bin/env bash
# The build-time smoke gate must ACCEPT the pinned harness version and REJECT a
# wrong one -- the same two arms test/build/pin.test.sh runs for gbrain (G1).
#
# The bogus arm must fail because the BUILD reached the harness install with the
# bogus version, not because of a cached failure or a flaky network. Docker
# skips a layer only when its inputs are unchanged, and HARNESS_VERSION is one of
# them -- so the bogus arm is asserted to have failed while naming the version it
# was given.
set -uo pipefail
cd "$(dirname "$0")/../.."

PIN="${HARNESS_VERSION:-2.1.274}"
BOGUS="0.0.0-not-a-real-version"
fail=0

echo "--- expecting SUCCESS at pin ${PIN}"
if docker build -f docker/agent-runner.Dockerfile \
     --build-arg "HARNESS_VERSION=${PIN}" \
     -t "mobrain/agent-runner:${PIN}" . ; then
  echo "PASS: pinned build succeeded"
else
  echo "FAIL: pinned build should have succeeded"; fail=1
fi

echo "--- expecting FAILURE at a deliberately wrong pin"
BOGUS_LOG="$(mktemp)"
if docker build -f docker/agent-runner.Dockerfile \
     --build-arg "HARNESS_VERSION=${BOGUS}" \
     -t mobrain/agent-runner:bogus . >"$BOGUS_LOG" 2>&1 ; then
  echo "FAIL: bogus pin built successfully — the smoke gate is not a gate"; fail=1
  cat "$BOGUS_LOG"
elif grep -q "$BOGUS" "$BOGUS_LOG"; then
  echo "PASS: bogus pin was rejected at the harness install"
else
  echo "FAIL: bogus pin build failed for a reason that never saw the pin"; fail=1
  cat "$BOGUS_LOG"
fi
rm -f "$BOGUS_LOG"

exit $fail
