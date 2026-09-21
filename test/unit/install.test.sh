#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/../.."
fail=0
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "--- generates a .env with every required secret"
# PREFLIGHT_SKIP_DNS: this case is about .env generation, not DNS; the host's
# own preflight must still run (unlike SKIP_PREFLIGHT, which would hide it).
# Ports are faked free: this suite may run on a dev host that already runs
# another Mobrain stack on 80/443 (a real, correct refusal — see
# preflight.test.sh), which is not what these cases are about.
DOMAIN=brain.test PREFLIGHT_SKIP_DNS=1 PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free BRAINSTAND_SKIP_UP=1 BRAINSTAND_ENV_PATH="$work/.env" bash scripts/install.sh >/dev/null 2>&1
for key in DOMAIN POSTGRES_PASSWORD OPS_RPC_TOKEN ENCRYPTION_KEY BETTER_AUTH_SECRET GBRAIN_VERSION; do
  if grep -q "^${key}=.\+" "$work/.env"; then echo "PASS: $key set"; else echo "FAIL: $key missing or empty"; fail=1; fi
done

echo "--- ENCRYPTION_KEY is at least 32 characters"
len=$(grep '^ENCRYPTION_KEY=' "$work/.env" | cut -d= -f2- | tr -d '\n' | wc -c)
if [ "$len" -ge 32 ]; then echo "PASS: length $len"; else echo "FAIL: length $len"; fail=1; fi

echo "--- secrets differ from each other"
if [ "$(grep -c '^OPS_RPC_TOKEN=' "$work/.env")" -eq 1 ] && \
   [ "$(grep '^OPS_RPC_TOKEN=' "$work/.env")" != "$(grep '^ENCRYPTION_KEY=' "$work/.env" | sed s/ENCRYPTION_KEY/OPS_RPC_TOKEN/)" ]; then
  echo "PASS: distinct secrets"
else echo "FAIL: secrets collide"; fail=1; fi

echo "--- MOBRAIN_TLS_MODE=internal writes tls internal into MOBRAIN_CADDY_TLS_DIRECTIVE"
DOMAIN=brain-internal.test MOBRAIN_TLS_MODE=internal PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free MOBRAIN_SKIP_UP=1 MOBRAIN_ENV_PATH="$work/.env.internal" bash scripts/install.sh >/dev/null 2>&1
if grep -q '^MOBRAIN_TLS_MODE=internal$' "$work/.env.internal" && grep -q '^MOBRAIN_CADDY_TLS_DIRECTIVE=tls internal$' "$work/.env.internal"; then
  echo "PASS: internal mode written"
else
  echo "FAIL: internal mode not written as expected"; fail=1
fi

echo "--- MOBRAIN_TLS_MODE=internal does not require DOMAIN to resolve"
# No PREFLIGHT_SKIP_DNS here on purpose: MOBRAIN_TLS_MODE=internal alone must
# be enough to satisfy preflight's DNS check for a domain with no public DNS.
if DOMAIN=nx.invalid MOBRAIN_TLS_MODE=internal PREFLIGHT_FAKE_DNS=nxdomain PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free MOBRAIN_SKIP_UP=1 MOBRAIN_ENV_PATH="$work/.env.nodns" bash scripts/install.sh >/dev/null 2>&1; then
  echo "PASS: internal mode bypassed the DNS refusal"
else
  echo "FAIL: internal mode still hit the DNS refusal"; fail=1
fi

echo "--- rejects an unrecognized MOBRAIN_TLS_MODE"
if DOMAIN=brain.test MOBRAIN_TLS_MODE=bogus PREFLIGHT_SKIP_DNS=1 MOBRAIN_SKIP_UP=1 MOBRAIN_ENV_PATH="$work/.env.bogus" bash scripts/install.sh >/dev/null 2>&1; then
  echo "FAIL: accepted an invalid MOBRAIN_TLS_MODE"; fail=1
else
  echo "PASS: rejected invalid MOBRAIN_TLS_MODE"
fi

echo "--- refuses to clobber an existing .env"
if DOMAIN=brain.test BRAINSTAND_SKIP_UP=1 BRAINSTAND_ENV_PATH="$work/.env" bash scripts/install.sh >/dev/null 2>&1; then
  echo "FAIL: overwrote an existing .env"; fail=1
else echo "PASS: refused to overwrite"; fi

echo "--- a blank DOMAIN answer installs in local mode against the detected LAN IP"
# MOBRAIN_FAKE_LAN_IP pins detection: this suite runs on hosts where neither
# `hostname -I` nor `ip route` exists (Git Bash on Windows), and the case is
# about what local mode WRITES, not about how the address was found.
printf '\n' | MOBRAIN_FAKE_LAN_IP=192.168.1.50 PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free \
  MOBRAIN_SKIP_UP=1 MOBRAIN_ENV_PATH="$work/.env.local" bash scripts/install.sh >/dev/null 2>&1
if grep -q '^DOMAIN=192\.168\.1\.50$' "$work/.env.local" && \
   grep -q '^MOBRAIN_TLS_MODE=internal$' "$work/.env.local" && \
   grep -q '^MOBRAIN_CADDY_TLS_DIRECTIVE=tls internal$' "$work/.env.local"; then
  echo "PASS: local mode wrote the LAN IP and internal TLS"
else
  echo "FAIL: local mode did not write the LAN IP / internal TLS"; fail=1
fi

echo "--- INSTALL_MODE=local skips the prompt entirely (no stdin needed)"
INSTALL_MODE=local MOBRAIN_FAKE_LAN_IP=10.0.0.7 PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free \
  MOBRAIN_SKIP_UP=1 MOBRAIN_ENV_PATH="$work/.env.local2" bash scripts/install.sh </dev/null >/dev/null 2>&1
if grep -q '^DOMAIN=10\.0\.0\.7$' "$work/.env.local2"; then
  echo "PASS: INSTALL_MODE=local needs no stdin"
else
  echo "FAIL: INSTALL_MODE=local did not skip the prompt"; fail=1
fi

echo "--- local mode never refuses on DNS, with no PREFLIGHT_SKIP_DNS and a faked NXDOMAIN"
if INSTALL_MODE=local MOBRAIN_FAKE_LAN_IP=192.168.1.51 PREFLIGHT_FAKE_DNS=nxdomain \
   PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free \
   MOBRAIN_SKIP_UP=1 MOBRAIN_ENV_PATH="$work/.env.local3" bash scripts/install.sh </dev/null >/dev/null 2>&1; then
  echo "PASS: local mode bypassed the DNS refusal"
else
  echo "FAIL: local mode still hit the DNS refusal"; fail=1
fi

echo "--- LAN detection falls back to a usable address with no fake set"
printf '\n' | PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free \
  MOBRAIN_SKIP_UP=1 MOBRAIN_ENV_PATH="$work/.env.local4" bash scripts/install.sh >/dev/null 2>&1
detected=$(grep '^DOMAIN=' "$work/.env.local4" | cut -d= -f2-)
# Either a real address off this host, or the documented `localhost` fallback —
# never empty, which is what would silently produce a Caddyfile with no site.
if echo "$detected" | grep -qE '^(([0-9]{1,3}\.){3}[0-9]{1,3}|localhost)$'; then
  echo "PASS: detection produced '$detected'"
else
  echo "FAIL: detection produced '${detected:-<empty>}'"; fail=1
fi

echo "--- a non-blank DOMAIN answer is still domain mode, unchanged"
printf 'brain.typed.test\n' | PREFLIGHT_SKIP_DNS=1 PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free \
  MOBRAIN_SKIP_UP=1 MOBRAIN_ENV_PATH="$work/.env.typed" bash scripts/install.sh >/dev/null 2>&1
if grep -q '^DOMAIN=brain\.typed\.test$' "$work/.env.typed" && \
   grep -q '^MOBRAIN_TLS_MODE=public$' "$work/.env.typed"; then
  echo "PASS: a typed domain still takes the public-TLS domain path"
else
  echo "FAIL: a typed domain did not take the domain path"; fail=1
fi

echo "--- refuses INSTALL_MODE=local with an explicit MOBRAIN_TLS_MODE=public"
# Let's Encrypt does not issue for a bare LAN IP. Defaulting quietly to
# internal would hide the contradiction; refusing names it.
if INSTALL_MODE=local MOBRAIN_TLS_MODE=public MOBRAIN_FAKE_LAN_IP=192.168.1.52 \
   PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free \
   MOBRAIN_SKIP_UP=1 MOBRAIN_ENV_PATH="$work/.env.contradiction" bash scripts/install.sh </dev/null >/dev/null 2>&1; then
  echo "FAIL: accepted local mode with public TLS"; fail=1
else
  echo "PASS: refused local mode with public TLS"
fi

echo "--- rejects an unrecognized INSTALL_MODE"
if INSTALL_MODE=sideways PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free \
   MOBRAIN_SKIP_UP=1 MOBRAIN_ENV_PATH="$work/.env.badmode" bash scripts/install.sh </dev/null >/dev/null 2>&1; then
  echo "FAIL: accepted an invalid INSTALL_MODE"; fail=1
else
  echo "PASS: rejected invalid INSTALL_MODE"
fi

echo "--- INSTALL_MODE=domain with no DOMAIN still refuses"
if INSTALL_MODE=domain PREFLIGHT_SKIP_DNS=1 PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free \
   MOBRAIN_SKIP_UP=1 MOBRAIN_ENV_PATH="$work/.env.nodomain" bash scripts/install.sh </dev/null >/dev/null 2>&1; then
  echo "FAIL: domain mode ran without a DOMAIN"; fail=1
else
  echo "PASS: domain mode still requires a DOMAIN"
fi

echo "--- ENABLE_RUNNER=n skips the prompt and leaves the runner off"
DOMAIN=brain.test PREFLIGHT_SKIP_DNS=1 PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free ENABLE_RUNNER=n BRAINSTAND_SKIP_UP=1 BRAINSTAND_ENV_PATH="$work/.env3" bash scripts/install.sh </dev/null >/dev/null 2>&1
if grep -q '^RUNNER_TOKEN=$' "$work/.env3" && ! grep -q '^COMPOSE_PROFILES=runner$' "$work/.env3"; then
  echo "PASS: runner left off"
else
  echo "FAIL: ENABLE_RUNNER=n did not leave the runner off"; fail=1
fi

echo "--- ENABLE_RUNNER=y skips the prompt and enables the runner"
DOMAIN=brain.test PREFLIGHT_SKIP_DNS=1 PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free ENABLE_RUNNER=y BRAINSTAND_SKIP_UP=1 BRAINSTAND_ENV_PATH="$work/.env4" bash scripts/install.sh </dev/null >/dev/null 2>&1
if grep -q '^RUNNER_TOKEN=.\+' "$work/.env4" && grep -q '^COMPOSE_PROFILES=runner$' "$work/.env4"; then
  echo "PASS: runner enabled"
else
  echo "FAIL: ENABLE_RUNNER=y did not enable the runner"; fail=1
fi

# Parse the script source — BRAINSTAND_SKIP_UP must not skip this check.
# Without --env-file, Compose loads .env from the project dir of the first -f
# (compose/), so the secrets install.sh just wrote never reach interpolation.
echo "--- compose up argv includes --env-file (parse script; no Docker)"
up_line=$(grep -E 'docker[[:space:]]+compose[[:space:]].*up[[:space:]]+-d[[:space:]]+--wait' scripts/install.sh | head -n1)
if echo "$up_line" | grep -q -- '--env-file'; then
  echo "PASS: up argv includes --env-file"
else
  echo "FAIL: up argv missing --env-file: ${up_line:-<no up line>}"
  fail=1
fi

# Parse the script source the way the --env-file case does, so a runtime
# BRAINSTAND_SKIP_UP=1 cannot hide the ordering. Preflight must run before the
# first `$(gen)`: a host that cannot run the stack must never hold an
# ENCRYPTION_KEY.
echo "--- preflight precedes the first gen() call (parse script; no Docker)"
preflight_line=$(grep -nE 'preflight\.sh' scripts/install.sh | head -n1 | cut -d: -f1)
gen_line=$(grep -nE '\$\(gen\)' scripts/install.sh | head -n1 | cut -d: -f1)
if [ -n "$preflight_line" ] && [ -n "$gen_line" ] && [ "$preflight_line" -lt "$gen_line" ] && \
   grep -q 'SKIP_PREFLIGHT' scripts/install.sh; then
  echo "PASS: preflight (line $preflight_line) precedes first gen() (line $gen_line)"
else
  echo "FAIL: preflight line '${preflight_line:-<none>}' does not precede gen() line '${gen_line:-<none>}'"
  fail=1
fi

# The pull leg must exist and precede `up -d --wait`, and its failure path must
# name the air-gapped build fallback rather than leave a bare manifest unknown.
echo "--- pull leg exists and precedes up (parse script; no Docker)"
pull_line=$(grep -nE 'docker[[:space:]]+compose[[:space:]].*pull' scripts/install.sh | head -n1 | cut -d: -f1)
up_line_num=$(grep -nE 'docker[[:space:]]+compose[[:space:]].*up[[:space:]]+-d[[:space:]]+--wait' scripts/install.sh | head -n1 | cut -d: -f1)
if [ -n "$pull_line" ] && [ -n "$up_line_num" ] && [ "$pull_line" -lt "$up_line_num" ] && \
   grep -q 'docker-compose.build.yml' scripts/install.sh; then
  echo "PASS: pull (line $pull_line) precedes up (line $up_line_num) and names the build fallback"
else
  echo "FAIL: pull line '${pull_line:-<none>}' does not precede up line '${up_line_num:-<none>}'"
  fail=1
fi

echo "--- COMPOSE_PROJECT_NAME: derived by default, deterministic, printed, and written to .env"
rm -f "$work/.env3" "$work/.env4"
out1=$(DOMAIN=brain.test PREFLIGHT_SKIP_DNS=1 PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free \
  BRAINSTAND_SKIP_UP=1 BRAINSTAND_ENV_PATH="$work/.env3" bash scripts/install.sh 2>&1)
name1=$(grep '^COMPOSE_PROJECT_NAME=' "$work/.env3" | cut -d= -f2)
if [ -n "$name1" ]; then echo "PASS: COMPOSE_PROJECT_NAME written to .env ($name1)"; else echo "FAIL: COMPOSE_PROJECT_NAME missing from .env"; fail=1; fi
if echo "$out1" | grep -qF "$name1"; then echo "PASS: chosen name printed, not silent"; else echo "FAIL: chosen name never printed"; fail=1; fi
# Same checkout dir (this repo, run from the same cwd) -> same derived name,
# so a re-run/upgrade of the same install always targets the same project.
DOMAIN=brain.test PREFLIGHT_SKIP_DNS=1 PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free \
  BRAINSTAND_SKIP_UP=1 BRAINSTAND_ENV_PATH="$work/.env4" bash scripts/install.sh >/dev/null 2>&1
name2=$(grep '^COMPOSE_PROJECT_NAME=' "$work/.env4" | cut -d= -f2)
if [ "$name1" = "$name2" ]; then echo "PASS: derived name is deterministic ($name1)"; else echo "FAIL: derived name changed ($name1 vs $name2)"; fail=1; fi

echo "--- COMPOSE_PROJECT_NAME: an explicit value always wins over the derived default"
rm -f "$work/.env5"
DOMAIN=brain.test COMPOSE_PROJECT_NAME=my-custom-project PREFLIGHT_SKIP_DNS=1 \
  PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free \
  BRAINSTAND_SKIP_UP=1 BRAINSTAND_ENV_PATH="$work/.env5" bash scripts/install.sh >/dev/null 2>&1
if grep -q '^COMPOSE_PROJECT_NAME=my-custom-project$' "$work/.env5"; then
  echo "PASS: explicit COMPOSE_PROJECT_NAME respected"
else
  echo "FAIL: explicit COMPOSE_PROJECT_NAME not honored"; fail=1
fi

echo "--- COMPOSE_PROJECT_NAME is exported before preflight runs (parse script; no Docker)"
export_line=$(grep -n '^export COMPOSE_PROJECT_NAME' scripts/install.sh | head -n1 | cut -d: -f1)
if [ -n "$export_line" ] && [ -n "$preflight_line" ] && [ "$export_line" -lt "$preflight_line" ]; then
  echo "PASS: COMPOSE_PROJECT_NAME exported (line $export_line) before preflight (line $preflight_line)"
else
  echo "FAIL: COMPOSE_PROJECT_NAME export does not precede the preflight call"
  fail=1
fi

echo "--- INSTALL_MODE is exported before preflight runs (parse script; no Docker)"
mode_export=$(grep -n '^export INSTALL_MODE' scripts/install.sh | head -n1 | cut -d: -f1)
if [ -n "$mode_export" ] && [ -n "$preflight_line" ] && [ "$mode_export" -lt "$preflight_line" ]; then
  echo "PASS: INSTALL_MODE exported (line $mode_export) before preflight (line $preflight_line)"
else
  echo "FAIL: INSTALL_MODE export does not precede the preflight call"; fail=1
fi

exit $fail
