# syntax=docker/dockerfile:1.7
# brainstand gbrain base image.
#
# G1: the version is an exact semver ARG. A moving ref in an image build is
# non-reproducible by construction — never default this to latest-stable.
FROM oven/bun:1.3.13

ARG GBRAIN_VERSION
RUN test -n "$GBRAIN_VERSION" || (echo "GBRAIN_VERSION build-arg is required" >&2; exit 1)

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini postgresql-client \
 && rm -rf /var/lib/apt/lists/*

RUN bun install -g "github:garrytan/gbrain#v${GBRAIN_VERSION}"
ENV PATH="/root/.bun/bin:${PATH}"

# MIT obligation: ship the copyright notice and license text.
RUN cp "$(bun pm -g bin)/../install/global/node_modules/gbrain/LICENSE" /opt/gbrain-LICENSE \
 || find / -path /proc -prune -o -name LICENSE -path '*gbrain*' -print -quit \
    | xargs -r -I{} cp {} /opt/gbrain-LICENSE
RUN test -s /opt/gbrain-LICENSE

# Build-time smoke gate: a bad pin fails the BUILD, not the deploy.
RUN gbrain --version | tee /opt/gbrain-version.txt \
 && grep -qx "${GBRAIN_VERSION}" /opt/gbrain-version.txt
RUN gbrain --tools-json | head -c 1 | grep -q '{'

# The product owns the upgrade lane; an unattended in-container self-upgrade
# would desynchronize the image from the running binary.
ENV GBRAIN_SELF_UPGRADE_MODE=off

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
