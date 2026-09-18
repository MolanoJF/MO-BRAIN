#!/usr/bin/env bash
# G1: three images, three exact pins, no moving tags, ever.
set -euo pipefail
REGISTRY="${IMAGE_REGISTRY:-ghcr.io}"
NS="${IMAGE_NAMESPACE:-mobrain}"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1

exact() {  # refuse anything that is not x.y.z[.w]
  case "$1" in
    [0-9]*.[0-9]*.[0-9]*) : ;;
    *) echo "G1: '$1' is not an exact version" >&2; exit 2 ;;
  esac
}
exact "${GBRAIN_VERSION:?}"; exact "${HARNESS_VERSION:?}"; exact "${APP_VERSION:?}"

build_and_push() {  # $1 image  $2 tag  $3 dockerfile  $4.. build args
  local ref="${REGISTRY}/${NS}/$1:$2"
  echo "--- $ref"
  if [ "$DRY" = 1 ]; then echo "would build $3 -> $ref"; return; fi
  docker build -f "$3" "${@:4}" -t "$ref" .
  docker push "$ref"
  docker image inspect "$ref" --format '{{index .RepoDigests 0}}'
}

build_and_push gbrain-base   "$GBRAIN_VERSION"  docker/gbrain-base.Dockerfile   --build-arg "GBRAIN_VERSION=${GBRAIN_VERSION}"
build_and_push control-plane "$APP_VERSION"     docker/control-plane.Dockerfile --build-arg "GBRAIN_VERSION=${GBRAIN_VERSION}"
build_and_push agent-runner  "$HARNESS_VERSION" docker/agent-runner.Dockerfile  --build-arg "HARNESS_VERSION=${HARNESS_VERSION}"
