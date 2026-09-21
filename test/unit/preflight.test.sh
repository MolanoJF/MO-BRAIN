# test/unit/preflight.test.sh
set -euo pipefail
fail() { echo "FAIL: $1" >&2; exit 1; }
expect_code() {  # $1 expected  $2.. env assignments + command
  local want="$1"; shift
  set +e; ( eval "$@" ) >/dev/null 2>&1; local got=$?; set -e
  [ "$got" = "$want" ] || fail "expected exit $want, got $got from: $*"
}

# Each refusal is a DISTINCT exit code, so the installer can say which one fired.
expect_code 10 "PREFLIGHT_FAKE_DOCKER=missing bash scripts/preflight.sh"
expect_code 11 "PREFLIGHT_FAKE_COMPOSE_VERSION=1.29.2 bash scripts/preflight.sh"
expect_code 12 "PREFLIGHT_FAKE_RAM_MB=1024 bash scripts/preflight.sh"
expect_code 13 "PREFLIGHT_FAKE_DISK_GB=5 bash scripts/preflight.sh"
expect_code 14 "PREFLIGHT_FAKE_PORT_443=busy bash scripts/preflight.sh"
expect_code 15 "DOMAIN=nx.invalid PREFLIGHT_FAKE_DNS=nxdomain bash scripts/preflight.sh"

# And every refusal must say what to DO, not just that it failed.
out=$(PREFLIGHT_FAKE_RAM_MB=1024 bash scripts/preflight.sh 2>&1 || true)
echo "$out" | grep -qi "memory" || fail "the RAM refusal does not name memory"
echo "$out" | grep -qE "[0-9]+ ?(MB|GB)" || fail "the RAM refusal does not state the floor"

# A clean host passes and says nothing alarming.
expect_code 0 "PREFLIGHT_SKIP_DNS=1 bash scripts/preflight.sh"

# MOBRAIN_TLS_MODE=internal implies the DNS check is satisfied even with a
# domain that would otherwise refuse (exit 15) — internal TLS mode exists
# precisely for a domain with no public DNS.
expect_code 0 "DOMAIN=nx.invalid MOBRAIN_TLS_MODE=internal PREFLIGHT_FAKE_DNS=nxdomain bash scripts/preflight.sh"
out=$(DOMAIN=nx.invalid MOBRAIN_TLS_MODE=internal PREFLIGHT_FAKE_DNS=nxdomain bash scripts/preflight.sh 2>&1 || true)
echo "$out" | grep -qi "MOBRAIN_TLS_MODE=internal" || fail "the internal-mode DNS skip does not name the mode that caused it"
echo PASS
