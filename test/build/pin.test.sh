#!/usr/bin/env bash
# The build-time smoke gate must ACCEPT the pinned version and REJECT a wrong one.
set -uo pipefail
cd "$(dirname "$0")/../.."

PIN="${GBRAIN_VERSION:-0.50.0.0}"
IMAGE="${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE:-mobrain}/gbrain-base"
fail=0

echo "--- expecting SUCCESS at pin ${PIN}"
if docker build -f docker/gbrain-base.Dockerfile \
     --build-arg "GBRAIN_VERSION=${PIN}" \
     -t "${IMAGE}:${PIN}" . ; then
  echo "PASS: pinned build succeeded"
else
  echo "FAIL: pinned build should have succeeded"; fail=1
fi

echo "--- expecting FAILURE at a deliberately wrong pin"
if docker build -f docker/gbrain-base.Dockerfile \
     --build-arg "GBRAIN_VERSION=0.0.0-not-a-real-version" \
     -t "${IMAGE}:bogus" . >/dev/null 2>&1 ; then
  echo "FAIL: bogus pin built successfully — the smoke gate is not a gate"; fail=1
else
  echo "PASS: bogus pin was rejected"
fi

exit $fail
