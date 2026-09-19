#!/usr/bin/env bash
# Run each test file in its own `bun` process.
#
# `mock.module()` is process-global in Bun, so in one process a sibling file's
# partial module mock answers another file's import. Two measured leaks:
#   * test/integration: upgrades.test.ts's drift mock answered capability.test.ts,
#     so a `driftBetween` that must throw resolved instead.
#   * test/contract: usage.contract.ts read a bogus ops RPC URL its own file
#     never set.
# A fresh process per file is the isolation both suites need, and it also bounds
# peak memory to one file's module graph instead of the whole directory's.
set -uo pipefail

dir="${1:?usage: test-isolated.sh <test-dir>}"
mapfile -t files < <(find "$dir" -maxdepth 1 -name '*.test.ts' | sort)

failed=()
for f in "${files[@]}"; do
  echo "::group::bun test $f"
  if bun test "$f"; then
    echo "OK $f"
  else
    echo "FAIL $f"
    failed+=("$f")
  fi
  echo "::endgroup::"
done

echo "----- isolated test summary: ${#failed[@]} failed of ${#files[@]} -----"
if [ "${#failed[@]}" -gt 0 ]; then
  printf 'FAILED %s\n' "${failed[@]}"
  exit 1
fi
