# syntax=docker/dockerfile:1.7
# Mo-brain gbrain base image.
#
# G1: the version is an exact semver ARG. A moving ref in an image build is
# non-reproducible by construction — never default this to latest-stable.
FROM oven/bun:1.4.2

ARG GBRAIN_VERSION
RUN test -n "$GBRAIN_VERSION" || (echo "GBRAIN_VERSION build-arg is required" >&2; exit 1)

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini postgresql-client \
 && rm -rf /var/lib/apt/lists/*

RUN bun install -g "github:garrytan/gbrain#v${GBRAIN_VERSION}"
ENV PATH="/root/.bun/bin:${PATH}"

# MIT obligation: ship the copyright notice and license text.
# bun installs globals under /root/.bun/install/global. NOTE: `bun pm -g bin`
# returns /usr/local/bin, which is the SYMLINK directory, not the package root.
RUN cp /root/.bun/install/global/node_modules/gbrain/LICENSE /opt/gbrain-LICENSE \
 || find / -path /proc -prune -o -name LICENSE -path '*gbrain*' -print -quit \
    | xargs -r -I{} cp {} /opt/gbrain-LICENSE
RUN test -s /opt/gbrain-LICENSE

# Build-time smoke gate: a bad pin fails the BUILD, not the deploy.
# `gbrain --version` prints "gbrain 0.50.0.0" -- the version is the LAST
# whitespace-separated token, NOT the whole line. grep -qx rejects a good build.
RUN gbrain --version | tee /opt/gbrain-version.txt \
 && awk -v v="${GBRAIN_VERSION}" '$NF == v { ok = 1 } END { exit !ok }' /opt/gbrain-version.txt
# Build-time smoke gate: verify the tool catalog is real, parseable JSON --
# not just a single leading byte. The catalog is a top-level JSON ARRAY
# (starts with '[', not '{'); a bare `head -c 1 | grep -q '{'` only ever
# accepts '{' and so always failed against gbrain's real (array) output.
# NOTE: deliberately avoids `require("fs")` inside `bun -e` -- on this image
# (bun 1.3.13) a `require`-containing eval silently swallows a later
# uncaught exception (prints nothing, exits 0), which would make this gate
# fake-pass. `Bun.file(...).json()` with top-level await does not have that
# problem and was verified against both real and broken --tools-json output.
RUN gbrain --tools-json > /tmp/gbrain-tools.json \
 && bytes="$(wc -c < /tmp/gbrain-tools.json)" \
 && test "$bytes" -gt 20 \
 && bun -e 'const d = await Bun.file("/tmp/gbrain-tools.json").json(); if (typeof d !== "object" || d === null) { console.error("tools-json parsed to a non-object/array:", typeof d); process.exit(1); }' \
 && rm -f /tmp/gbrain-tools.json

# The product owns the upgrade lane; an unattended in-container self-upgrade
# would desynchronize the image from the running binary.
ENV GBRAIN_SELF_UPGRADE_MODE=off

COPY docker/gbrain-gated-entrypoint.sh /opt/mobrain/gbrain-gated-entrypoint.sh
RUN chmod 0755 /opt/mobrain/gbrain-gated-entrypoint.sh

COPY docker/quiesce-gbrain-procs.sh /opt/mobrain/quiesce-gbrain-procs.sh
RUN chmod 0755 /opt/mobrain/quiesce-gbrain-procs.sh

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
