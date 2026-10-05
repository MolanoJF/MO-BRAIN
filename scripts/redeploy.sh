#!/usr/bin/env bash
# Mobrain dev redeploy — the tight loop for console work.
#
# DEV STACK ONLY. Every invocation merges compose/docker-compose.dev.yml, which
# publishes Caddy on 8080/8443 and exists nowhere in production. The production
# lane is scripts/upgrade.ts, which journals and can roll back; this script does
# neither. Never point it at a deployment anyone depends on.
#
# Two lanes, because a full image rebuild for a one-line CSS change re-runs
# `bun install` TWICE around its own `vite build` (docker/control-plane.Dockerfile),
# and that is minutes for a change the browser could have had in seconds.
#
#   (default) CONSOLE LANE — `vite build` on the HOST (measured: 1.4s), then
#   `docker compose cp` of dist/console into the RUNNING control-plane.
#   src/control/app.ts:61-62 serves ./dist/console through serveStatic, which
#   reads off disk per request, so the process needs no restart at all.
#
#     EPHEMERAL BY CONSTRUCTION. The image is untouched, so the console reverts
#     the moment the container is replaced — `up -d --force-recreate`, a `down`,
#     a daemon restart. Anything meant to survive goes through --full or CI.
#     The script says so on every successful run rather than letting a patched
#     container quietly pass for a build (honesty rule 5: a partial success is
#     not rounded up to a green one).
#
#   --full — rebuild the control-plane image through the build overlay (D2) and
#   recreate the three services that share it: control-plane, scheduler and
#   gbrain-ops. Use it for anything under src/control, src/ops, src/scheduler,
#   or a dependency change.
#
# Exit codes — one per failure, and each refusal prints exactly one line saying
# what to do next:
#   0   redeployed
#   2   bad usage
#   10  the Docker daemon is unreachable
#   11  the host console build failed
#   12  the control-plane container is not running
#   13  the image build failed
#   14  the served console is not the one that was just built
#   15  the control plane did not come back healthy
set -uo pipefail

# Git Bash on Windows rewrites any argument that looks like a POSIX path before
# the process ever sees it. Measured on this host: `exec -e REDEPLOY_PATH=/api/health`
# is delivered as `C:/Program Files/Git/api/health`, and a bare `/app/dist/console`
# as `C:/Program Files/Git/app/dist/console`. EVERY path in this script is a path
# inside a Linux container, so that conversion is always wrong — it silently
# retargets the `rm -rf` and `cp` of the console lane, and it made the health
# probe fetch an invalid URL and time out on a control plane that was serving
# perfectly well. Both variables are inert on Linux and macOS.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

# Compose paths in the -f flags are relative, so every run must start from the
# repo root no matter where the caller invoked this from.
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2

FULL=0
case "${1:-}" in
  --full) FULL=1 ;;
  '') : ;;
  -h|--help)
    # Derive the range rather than hard-coding it: print from line 2 to the
    # first non-comment line, so the help cannot drift as the header grows.
    sed -n '2,/^[^#]/p' "${BASH_SOURCE[0]}" | sed -n 's/^# \{0,1\}//p'
    exit 0 ;;
  *) echo "redeploy: unknown argument '$1' (expected --full or nothing)" >&2; exit 2 ;;
esac

refuse() { local code=$1; shift; echo "REDEPLOY: $*" >&2; exit "$code"; }
step()   { echo "--- $*"; }

COMPOSE=(docker compose --env-file .env
         -f compose/docker-compose.yml
         -f compose/docker-compose.dev.yml)

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
docker info >/dev/null 2>&1 \
  || refuse 10 "the Docker daemon is unreachable; start Docker Desktop, wait for it to report running, and retry."

# `ps -q` prints an id for a container that exists in any state, so the state
# has to be read separately — copying into a stopped container succeeds and
# then serves nothing, which is exactly the silent half-success to refuse.
cid="$("${COMPOSE[@]}" ps -q control-plane 2>/dev/null)"
if [ -z "$cid" ] || [ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null)" != "true" ]; then
  if [ "$FULL" = 0 ]; then
    refuse 12 "the control-plane container is not running, and the console lane needs a live target; bring the stack up with 'docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml up -d' (or rerun as '$0 --full')."
  fi
fi

# Reads the container's own console over HTTP rather than off its disk: that
# proves serveStatic is answering with the new bytes, not merely that a file
# landed somewhere in the image. 3150 is the control plane's in-container port
# (CONTROL_URL in compose/docker-compose.yml); nothing publishes it to the host.
# The origin is joined to the path HERE and the whole URL is handed over as one
# value: something starting with `http://` is never mistaken for a POSIX path,
# so the probe stays correct even somewhere MSYS_NO_PATHCONV above is ignored.
CONTROL_ORIGIN='http://localhost:3150'

serve_body() {  # $1 path -> body on stdout
  "${COMPOSE[@]}" exec -T -e "REDEPLOY_URL=${CONTROL_ORIGIN}$1" control-plane bun -e '
    const r = await fetch(process.env.REDEPLOY_URL);
    process.stdout.write(await r.text());
  '
}

serve_status() {  # $1 path -> numeric HTTP status on stdout, or 0 if unreachable
  "${COMPOSE[@]}" exec -T -e "REDEPLOY_URL=${CONTROL_ORIGIN}$1" control-plane bun -e '
    try {
      const r = await fetch(process.env.REDEPLOY_URL);
      console.log(r.status);
    } catch { console.log(0); }
  ' 2>/dev/null | tr -d '\r'
}

# Caddy is the stack's ONLY ingress: compose/docker-compose.dev.yml publishes
# 8443/8080 on it and nothing publishes the control plane's 3150 at all. So the
# console URL is only true while Caddy is up, and the verification above cannot
# see that — it probes the control plane from inside its own container, which
# keeps answering perfectly with Caddy dead. Printing the URL unconditionally
# advertises a link that does not work.
console_url_line() {  # $1 optional suffix for the working case
  local ccid state
  ccid="$("${COMPOSE[@]}" ps -aq caddy 2>/dev/null | head -1)"
  state="$(docker inspect -f '{{.State.Status}}' "$ccid" 2>/dev/null)"
  if [ "$state" = "running" ]; then
    echo "  console     -> https://localhost:8443/${1:-}"
  else
    echo "  console     -> UNREACHABLE from the host: the caddy container is '${state:-absent}'"
    echo "                 and it is this stack's only ingress. The console IS deployed —"
    echo "                 start caddy to see it:"
    echo "                   docker compose --env-file .env -f compose/docker-compose.yml \\"
    echo "                     -f compose/docker-compose.dev.yml up -d --force-recreate caddy"
    echo "                 (--force-recreate, not a plain up: \`name:\` in the compose file is"
    echo "                  a fixed literal, so a checkout in ANY directory drives the same"
    echo "                  project. A container created from a checkout that has since moved"
    echo "                  or been deleted keeps that dead path in its config and exits 127"
    echo "                  at 'not a directory'; recreating repoints it at this tree.)"
  fi
}

wait_healthy() {  # polls until the control plane answers below 500, or gives up
  local deadline=$((SECONDS + 90)) status
  while [ "$SECONDS" -lt "$deadline" ]; do
    status="$(serve_status /api/health)"
    case "$status" in
      ''|0|5*) : ;;
      *) echo "$status"; return 0 ;;
    esac
    sleep 2
  done
  return 1
}

# ---------------------------------------------------------------------------
# Lane: --full
# ---------------------------------------------------------------------------
if [ "$FULL" = 1 ]; then
  GBRAIN_VERSION="$(grep -E '^GBRAIN_VERSION=' .env | head -1 | cut -d= -f2- | tr -d '\r')"
  [ -n "$GBRAIN_VERSION" ] || refuse 2 "GBRAIN_VERSION is not set in .env; the image build is pinned to it and has no safe default here."

  REGISTRY="${IMAGE_REGISTRY:-ghcr.io}"
  NS="${IMAGE_NAMESPACE:-molioros}"

  # docker/control-plane.Dockerfile:7 resolves its base from the local daemon
  # under the BARE `mobrain/gbrain-base:<pin>` name, which is not a registry
  # reference and can never be pulled. CI mirrors the tag before every build
  # (.github/workflows/stack.yml) and scripts/publish-images.sh does the
  # same; without it this lane dies at `pull access denied`.
  if ! docker image inspect "mobrain/gbrain-base:${GBRAIN_VERSION}" >/dev/null 2>&1; then
    step "mirroring the pinned base as mobrain/gbrain-base:${GBRAIN_VERSION}"
    docker tag "${REGISTRY}/${NS}/gbrain-base:${GBRAIN_VERSION}" "mobrain/gbrain-base:${GBRAIN_VERSION}" \
      || refuse 13 "the pinned base ${REGISTRY}/${NS}/gbrain-base:${GBRAIN_VERSION} is not on this host; pull it first with 'docker pull ${REGISTRY}/${NS}/gbrain-base:${GBRAIN_VERSION}'."
  fi

  # D2: build stanzas live only in the overlay, so the overlay is merged HERE
  # and nowhere else in this script. Building `control-plane` alone is enough —
  # scheduler and gbrain-ops carry the identical `image:` tag and pick the new
  # image up when they are recreated below.
  step "building the control-plane image (this is the slow lane)"
  docker compose --env-file .env \
    -f compose/docker-compose.yml \
    -f compose/docker-compose.dev.yml \
    -f compose/docker-compose.build.yml \
    build --build-arg "GBRAIN_VERSION=${GBRAIN_VERSION}" control-plane \
    || refuse 13 "the image build failed; fix the error above and retry."

  step "recreating control-plane, scheduler and gbrain-ops"
  "${COMPOSE[@]}" up -d --force-recreate control-plane scheduler gbrain-ops \
    || refuse 13 "the services did not come up; check 'docker compose ... ps' and the logs above."

  step "waiting for the control plane"
  health="$(wait_healthy)" || refuse 15 "the control plane did not answer /api/health below 500 within 90s; check 'docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml logs --tail 50 control-plane'."

  # The image built its own console from the same source, so there is no host
  # artifact to compare against byte-for-byte. Assert the weaker true thing:
  # the SPA is served and references a built asset bundle.
  body="$(serve_body /)"
  case "$body" in
    *"/assets/"*) : ;;
    *) refuse 14 "the control plane is up but '/' does not reference a built asset bundle; the image may have been built from an unexpected tree." ;;
  esac

  echo
  echo "REDEPLOYED (full): image rebuilt, control-plane + scheduler + gbrain-ops recreated."
  echo "  /api/health -> HTTP ${health}"
  console_url_line
  exit 0
fi

# ---------------------------------------------------------------------------
# Lane: console (default)
# ---------------------------------------------------------------------------
step "building the console on the host"
bunx vite build || refuse 11 "the console build failed; fix the error above and retry."

[ -f dist/console/index.html ] \
  || refuse 11 "vite reported success but dist/console/index.html is missing; check build.outDir in vite.config.ts."

# vite.config.ts sets emptyOutDir, and asset names are content-hashed — so a
# merge-copy into the container would leave every previous build's orphaned
# assets behind forever. Replace the tree rather than merging into it.
step "replacing /app/dist/console in the running container"
"${COMPOSE[@]}" exec -T control-plane rm -rf /app/dist/console \
  || refuse 12 "could not clear /app/dist/console in the container; is it still running?"
"${COMPOSE[@]}" cp dist/console control-plane:/app/dist/console \
  || refuse 12 "the copy into the control-plane container failed."

# The proof: what the server ANSWERS with has to be byte-identical to what was
# just built. A copy that landed in the wrong path would still pass a file
# check and fail this one.
step "verifying the served console"
served="$(serve_body /)"
built="$(cat dist/console/index.html)"
if [ "$served" != "$built" ]; then
  refuse 14 "the control plane is not serving the console that was just built; run '$0 --full' to rebuild the image instead."
fi

health="$(serve_status /api/health)"

echo
echo "REDEPLOYED (console only) in the running container."
echo "  /api/health -> HTTP ${health}"
console_url_line "  (hard-reload: Ctrl+Shift+R)"
echo
echo "  EPHEMERAL: the control-plane IMAGE still carries the old console. This"
echo "  patch is lost on any container replacement (--force-recreate, down,"
echo "  daemon restart). Run '$0 --full' to bake it in."
