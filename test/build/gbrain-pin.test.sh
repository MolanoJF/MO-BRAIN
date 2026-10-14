#!/usr/bin/env bash
# The pinned build succeeds and reports the pin; a wrong pin fails the build.
set -euo pipefail
cd "$(dirname "$0")/../.."
pin=0.60.230.0
docker build -q -f docker/gbrain.Dockerfile --build-arg GBRAIN_VERSION="$pin" -t mobrain-gbrain:"$pin" . >/dev/null
out="$(docker run --rm mobrain-gbrain:"$pin" gbrain --version)"
[ "${out##* }" = "$pin" ] || { echo "version mismatch: $out"; exit 1; }
if docker build -q -f docker/gbrain.Dockerfile --build-arg GBRAIN_VERSION=0.0.0.1 -t mobrain-gbrain:bad . >/dev/null 2>&1; then
  echo "a bad pin built"; exit 1
fi
echo "gbrain pin gate OK"
