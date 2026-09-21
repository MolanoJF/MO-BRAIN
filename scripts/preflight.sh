#!/usr/bin/env bash
# Mobrain install preflight.
#
# Runs before scripts/install.sh generates any secret: a host that cannot run
# the stack must not end up holding an ENCRYPTION_KEY it will never use.
#
# Exit codes — one per failure, and each refusal prints exactly one line
# saying what to do next:
#   0   every check passed
#   10  Docker is missing or its daemon is unreachable
#   11  Docker Compose is older than v2.20
#   12  host memory is below 4096 MB
#   13  free space on the Docker data root is below 20 GB
#   14  TCP port 80 or 443 is already in use
#   15  $DOMAIN does not resolve to one of this host's addresses
#   16  the pinned images cannot be pulled
#   17  COMPOSE_PROJECT_NAME already names a project with containers on this host
#
# Every check reads the real host unless the matching PREFLIGHT_FAKE_* variable
# is set. Those variables are TEST-ONLY: they exist so the refusals can be
# exercised without breaking the host, and must never be set in production.
#   PREFLIGHT_FAKE_DOCKER=missing
#   PREFLIGHT_FAKE_COMPOSE_VERSION=<version>
#   PREFLIGHT_FAKE_RAM_MB=<mb>
#   PREFLIGHT_FAKE_DISK_GB=<gb>
#   PREFLIGHT_FAKE_PORT_80=busy   /  PREFLIGHT_FAKE_PORT_443=busy
#   PREFLIGHT_FAKE_DNS=nxdomain
#   PREFLIGHT_FAKE_PULL=missing
#   PREFLIGHT_FAKE_PROJECT_EXISTS=1
# PREFLIGHT_SKIP_DNS=1 skips the DNS check for a private-network install; it
# prints a warning rather than passing silently. The image-pull check is
# network-bound, so it is off unless explicitly enabled with
# PREFLIGHT_SKIP_PULL=0.
set -uo pipefail

MIN_COMPOSE_MAJOR=2
MIN_COMPOSE_MINOR=20
MIN_RAM_MB=4096
MIN_DISK_GB=20

refuse() { local code="$1"; shift; echo "PREFLIGHT: $*" >&2; exit "$code"; }
warn()   { echo "PREFLIGHT: $*" >&2; }

ENV_PATH="${MOBRAIN_ENV_PATH:-${BRAINSTAND_ENV_PATH:-.env}}"

check_docker() {
  if [ "${PREFLIGHT_FAKE_DOCKER:-}" = "missing" ]; then
    refuse 10 "Docker is not installed; install Docker Engine 24+ (or Docker Desktop) and re-run."
  fi
  if ! command -v docker >/dev/null 2>&1; then
    refuse 10 "Docker is not installed; install Docker Engine 24+ (or Docker Desktop) and re-run."
  fi
  if ! docker info >/dev/null 2>&1; then
    refuse 10 "the Docker daemon is unreachable; start Docker (or Docker Desktop) and re-run."
  fi
}

check_compose() {
  local v major minor
  if [ -n "${PREFLIGHT_FAKE_COMPOSE_VERSION:-}" ]; then
    v="$PREFLIGHT_FAKE_COMPOSE_VERSION"
  else
    v="$(docker compose version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n1)"
  fi
  if [ -z "${v:-}" ]; then
    refuse 11 "could not determine the Docker Compose version; install the Compose v2 plugin (floor v${MIN_COMPOSE_MAJOR}.${MIN_COMPOSE_MINOR}) and re-run."
  fi
  major="${v%%.*}"; minor="${v#*.}"; minor="${minor%%.*}"
  case "$major" in '' | *[!0-9]*) major=0 ;; esac
  case "$minor" in '' | *[!0-9]*) minor=0 ;; esac
  if [ "$major" -lt "$MIN_COMPOSE_MAJOR" ] ||
     { [ "$major" -eq "$MIN_COMPOSE_MAJOR" ] && [ "$minor" -lt "$MIN_COMPOSE_MINOR" ]; }; then
    refuse 11 "Docker Compose ${v} is too old; Mobrain needs v${MIN_COMPOSE_MAJOR}.${MIN_COMPOSE_MINOR} or newer — upgrade the Compose plugin and re-run."
  fi
}

ram_mb() {
  local bytes kb
  if [ -n "${PREFLIGHT_FAKE_RAM_MB:-}" ]; then printf '%s' "$PREFLIGHT_FAKE_RAM_MB"; return; fi
  bytes="$(docker info --format '{{.MemTotal}}' 2>/dev/null | tr -dc '0-9')"
  if [ -n "$bytes" ]; then printf '%s' "$(( bytes / 1024 / 1024 ))"; return; fi
  if [ -r /proc/meminfo ]; then
    kb="$(grep -i '^MemTotal:' /proc/meminfo 2>/dev/null | grep -oE '[0-9]+' | head -n1)"
    if [ -n "$kb" ]; then printf '%s' "$(( kb / 1024 ))"; return; fi
  fi
  bytes="$(powershell.exe -NoProfile -Command '(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory' 2>/dev/null | tr -dc '0-9')"
  if [ -n "$bytes" ]; then printf '%s' "$(( bytes / 1024 / 1024 ))"; return; fi
  printf ''
}

check_ram() {
  local mb
  mb="$(ram_mb)"
  if [ -z "$mb" ]; then warn "could not measure memory; skipping the RAM check."; return; fi
  if [ "$mb" -lt "$MIN_RAM_MB" ]; then
    refuse 12 "Mobrain needs at least ${MIN_RAM_MB} MB of memory; this host reports ${mb} MB — add RAM or move to a larger host before installing."
  fi
}

disk_gb() {
  local root kb
  if [ -n "${PREFLIGHT_FAKE_DISK_GB:-}" ]; then printf '%s' "$PREFLIGHT_FAKE_DISK_GB"; return; fi
  root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)"
  # Docker Desktop (Windows/macOS) reports the in-VM path /var/lib/docker,
  # which the host shell cannot stat; fall back to the host filesystem.
  if [ -z "$root" ] || [ ! -d "$root" ]; then root="."; fi
  kb="$(df -Pk "$root" 2>/dev/null | awk 'NR==2 {print $4}')"
  if [ -z "$kb" ]; then printf ''; return; fi
  printf '%s' "$(( kb / 1024 / 1024 ))"
}

check_disk() {
  local gb
  gb="$(disk_gb)"
  if [ -z "$gb" ]; then warn "could not measure free disk; skipping the disk check."; return; fi
  if [ "$gb" -lt "$MIN_DISK_GB" ]; then
    refuse 13 "Mobrain needs at least ${MIN_DISK_GB} GB free on the Docker data root; this host reports ${gb} GB — free space before installing."
  fi
}

project_name() { printf '%s' "${COMPOSE_PROJECT_NAME:-brainstand}"; }

# A port held by a container of THIS project is not a conflict — the stack is
# already running. A port held by anything else is.
port_busy() {
  local port="$1" owners foreign hex f
  owners="$(docker ps --filter "publish=${port}" --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | grep -v '^[[:space:]]*$' || true)"
  if [ -n "$owners" ]; then
    foreign="$(printf '%s\n' "$owners" | grep -vxF "$(project_name)" || true)"
    [ -z "$foreign" ] && return 1
    return 0
  fi
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | awk 'NR > 1 { print $4 }' | grep -qE "[:.]${port}$"; then
      return 0
    fi
  fi
  if command -v netstat >/dev/null 2>&1; then
    if netstat -ano 2>/dev/null | grep -E "[:.]${port}[[:space:]]" | grep -qi LISTENING; then
      return 0
    fi
  fi
  # /proc/net/tcp{,6}: only the LOCAL address field, and only a LISTEN state
  # (0A). The previous check matched the port anywhere in the file — including
  # an outbound connection's REMOTE port — so any live HTTPS connection made
  # this refuse 443. Measured on a stock GitHub Actions runner, 2026-09-19.
  printf -v hex '%04X' "$port"
  for f in /proc/net/tcp /proc/net/tcp6; do
    [ -r "$f" ] || continue
    if awk -v h="$hex" 'NR > 1 && $2 ~ (":" h "$") && $4 == "0A" { found = 1 } END { exit(found ? 0 : 1) }' "$f"; then
      return 0
    fi
  done
  return 1
}

check_ports() {
  local p fakevar fakeval
  for p in 80 443; do
    fakevar="PREFLIGHT_FAKE_PORT_${p}"
    fakeval="${!fakevar:-}"
    if [ -n "$fakeval" ]; then
      [ "$fakeval" = "busy" ] &&
        refuse 14 "port ${p} is already in use; stop the process or container bound to ${p} before installing."
      continue
    fi
    if port_busy "$p"; then
      refuse 14 "port ${p} is already in use; stop the process or container bound to ${p} before installing."
    fi
  done
}

host_ips() {
  {
    hostname -I 2>/dev/null || true
    ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1
    ipconfig 2>/dev/null | grep -iE 'IPv4' | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}'
  } | grep -E '^[0-9.]+$' | sort -u
}

resolve_ips() {
  local d="$1" out=""
  if command -v getent >/dev/null 2>&1; then
    out="$(getent ahosts "$d" 2>/dev/null | awk '{print $1}')"
  fi
  if [ -z "$out" ] && command -v dig >/dev/null 2>&1; then
    out="$(dig +short "$d" A 2>/dev/null)"
  fi
  if [ -z "$out" ] && command -v nslookup >/dev/null 2>&1; then
    out="$(nslookup "$d" 2>/dev/null | sed -n '/Name:/,$p' | awk '/Address/{for (i=2; i<=NF; i++) print $i}')"
    if [ -z "$out" ]; then
      out="$(nslookup "$d" 2>/dev/null | awk '/^[[:space:]]*Address/{for (i=2; i<=NF; i++) print $i}')"
    fi
  fi
  printf '%s\n' "$out" | grep -E '^[0-9.]+$' | sort -u
}

check_dns() {
  local domain="${DOMAIN:-}" resolved local_ips ip
  if [ "${PREFLIGHT_SKIP_DNS:-0}" = "1" ]; then
    warn "skipping the DNS check for ${domain:-<unset DOMAIN>} (PREFLIGHT_SKIP_DNS=1); make sure it resolves to this host before exposing 443."
    return
  fi
  if [ -n "${PREFLIGHT_FAKE_DNS:-}" ]; then
    refuse 15 "DOMAIN ${domain:-nx.invalid} does not resolve to this host; point its A/AAAA record here before installing."
  fi
  if [ -z "$domain" ]; then
    warn "DOMAIN is not set yet; skipping the DNS check."
    return
  fi
  resolved="$(resolve_ips "$domain")"
  if [ -z "$resolved" ]; then
    refuse 15 "DOMAIN ${domain} does not resolve to this host; point its A/AAAA record here before installing."
  fi
  local_ips="$(host_ips)"
  while IFS= read -r ip; do
    [ -z "$ip" ] && continue
    [ "$ip" = "127.0.0.1" ] && return 0
    if [ -n "$local_ips" ] && printf '%s\n' "$local_ips" | grep -qxF "$ip"; then
      return 0
    fi
  done <<< "$resolved"
  refuse 15 "DOMAIN ${domain} does not resolve to this host; point its A/AAAA record here before installing."
}

# check_ports() below only refuses on 80/443, and only catches the collision
# when the pre-existing project also happens to be up (holding those ports).
# The install.sh-generated default now makes two checkouts collide only by
# coincidence, but an explicit COMPOSE_PROJECT_NAME (or a stopped project
# whose ports are free right now) would sail past that check — and reusing a
# name that already has containers is exactly how a second install silently
# recreated a first install's containers with mismatched secrets. `-a`
# because a STOPPED container of that project still means its volumes likely
# already exist, and `up` would reattach them the same way.
check_project_identity() {
  local name containers
  name="$(project_name)"
  if [ "${PREFLIGHT_FAKE_PROJECT_EXISTS:-0}" = "1" ]; then
    refuse 17 "a Compose project named '${name}' already has containers on this host (fake); choose a different COMPOSE_PROJECT_NAME or remove that project first."
  fi
  command -v docker >/dev/null 2>&1 || return 0
  containers="$(docker ps -a --filter "label=com.docker.compose.project=${name}" --format '{{.Names}}' 2>/dev/null || true)"
  if [ -n "$containers" ]; then
    refuse 17 "a Compose project named '${name}' already has containers on this host ($(printf '%s' "$containers" | tr '\n' ' ' | sed 's/ $//')); installing here would recreate them in place with THIS install's freshly generated secrets, likely breaking whatever is already using them. Choose a different COMPOSE_PROJECT_NAME, or remove that project first if it's really yours to replace."
  fi
}

check_images() {
  if [ -n "${PREFLIGHT_FAKE_PULL:-}" ]; then
    refuse 16 "the pinned Mobrain images cannot be pulled; check ${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE:-molanojf} credentials, or build them locally with 'docker compose -f compose/docker-compose.yml -f compose/docker-compose.build.yml build'."
  fi
  if [ "${PREFLIGHT_SKIP_PULL:-1}" = "1" ]; then
    warn "skipping the image-pull check (PREFLIGHT_SKIP_PULL=1); the installer pulls the images itself."
    return 0
  fi
  if ! docker compose --env-file "$ENV_PATH" -f compose/docker-compose.yml pull >/dev/null 2>&1; then
    refuse 16 "the pinned Mobrain images cannot be pulled; on an air-gapped or registry-less host build them with 'docker compose -f compose/docker-compose.yml -f compose/docker-compose.build.yml build'."
  fi
}

check_docker
check_compose
check_ram
check_disk
check_project_identity
check_ports
check_dns
check_images

echo "PREFLIGHT: all checks passed."
exit 0
