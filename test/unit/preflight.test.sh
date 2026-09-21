# test/unit/preflight.test.sh
set -euo pipefail
fail() { echo "FAIL: $1" >&2; exit 1; }
expect_code() {  # $1 expected  $2.. env assignments + command
  local want="$1"; shift
  set +e; ( eval "$@" ) >/dev/null 2>&1; local got=$?; set -e
  [ "$got" = "$want" ] || fail "expected exit $want, got $got from: $*"
}

# check_project_identity() now reads real docker state, same as the RAM/disk/
# port checks it sits next to. Those already run against a name no real
# project on this host will ever hold; give it one too, instead of the
# frozen `brainstand` default — a dev host that happens to run an actual
# `brainstand` stack (this repo's own dev stack does) would otherwise fail
# every case below on a real, unrelated collision, not the fake being tested.
export COMPOSE_PROJECT_NAME="preflight-selftest-$$"

# Each refusal is a DISTINCT exit code, so the installer can say which one fired.
expect_code 10 "PREFLIGHT_FAKE_DOCKER=missing bash scripts/preflight.sh"
expect_code 11 "PREFLIGHT_FAKE_COMPOSE_VERSION=1.29.2 bash scripts/preflight.sh"
expect_code 12 "PREFLIGHT_FAKE_RAM_MB=1024 bash scripts/preflight.sh"
expect_code 13 "PREFLIGHT_FAKE_DISK_GB=5 bash scripts/preflight.sh"
expect_code 14 "PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=busy bash scripts/preflight.sh"
expect_code 15 "DOMAIN=nx.invalid PREFLIGHT_FAKE_DNS=nxdomain PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free bash scripts/preflight.sh"
expect_code 17 "PREFLIGHT_FAKE_PROJECT_EXISTS=1 bash scripts/preflight.sh"

# And the project-identity refusal names the actual project, not just "exit 17".
out=$(PREFLIGHT_FAKE_PROJECT_EXISTS=1 COMPOSE_PROJECT_NAME=already-running bash scripts/preflight.sh 2>&1 || true)
echo "$out" | grep -q "already-running" || fail "the project-identity refusal does not name the colliding project"

# And every refusal must say what to DO, not just that it failed.
out=$(PREFLIGHT_FAKE_RAM_MB=1024 bash scripts/preflight.sh 2>&1 || true)
echo "$out" | grep -qi "memory" || fail "the RAM refusal does not name memory"
echo "$out" | grep -qE "[0-9]+ ?(MB|GB)" || fail "the RAM refusal does not state the floor"

# A clean host passes and says nothing alarming. Ports are faked free: this
# suite's own dev host may genuinely run another Mobrain stack on 80/443 (a
# real, correct refusal from check_ports once the project name differs — see
# above), which is not what this assertion is about.
expect_code 0 "PREFLIGHT_SKIP_DNS=1 PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free bash scripts/preflight.sh"

# MOBRAIN_TLS_MODE=internal implies the DNS check is satisfied even with a
# domain that would otherwise refuse (exit 15) — internal TLS mode exists
# precisely for a domain with no public DNS.
expect_code 0 "DOMAIN=nx.invalid MOBRAIN_TLS_MODE=internal PREFLIGHT_FAKE_DNS=nxdomain PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free bash scripts/preflight.sh"
out=$(DOMAIN=nx.invalid MOBRAIN_TLS_MODE=internal PREFLIGHT_FAKE_DNS=nxdomain PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free bash scripts/preflight.sh 2>&1 || true)
echo "$out" | grep -qi "MOBRAIN_TLS_MODE=internal" || fail "the internal-mode DNS skip does not name the mode that caused it"
echo PASS
