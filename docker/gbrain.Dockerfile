# syntax=docker/dockerfile:1.7
# Pinned gbrain. The version is an exact ARG; never a moving ref.
FROM oven/bun:1.4.2

ARG GBRAIN_VERSION
RUN test -n "$GBRAIN_VERSION" || (echo "GBRAIN_VERSION build-arg is required" >&2; exit 1)

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini postgresql-client \
 && rm -rf /var/lib/apt/lists/*

RUN bun install -g "github:garrytan/gbrain#v${GBRAIN_VERSION}"
ENV PATH="/root/.bun/bin:${PATH}"

# MIT obligation: ship the license text.
RUN cp /root/.bun/install/global/node_modules/gbrain/LICENSE /opt/gbrain-LICENSE && test -s /opt/gbrain-LICENSE

# Build gate: the binary reports the pin (version is the last token).
RUN gbrain --version | tee /opt/gbrain-version.txt \
 && awk -v v="${GBRAIN_VERSION}" '$NF == v { ok = 1 } END { exit !ok }' /opt/gbrain-version.txt

# Build gate: the tool catalog is real JSON. Bun.file().json() rather than a
# require() eval, which can swallow a later exception and fake a pass.
RUN gbrain --tools-json > /tmp/tools.json \
 && bun -e 'const d = await Bun.file("/tmp/tools.json").json(); if (typeof d !== "object" || d === null) process.exit(1)' \
 && rm -f /tmp/tools.json

# The skills bundle the instance serves (phase 9) is copied from here.
RUN ln -s /root/.bun/install/global/node_modules/gbrain /opt/gbrain

# Upgrades go through bin/mobrain; an in-container self-upgrade would
# desynchronize the image from the binary.
ENV GBRAIN_SELF_UPGRADE_MODE=off \
    GBRAIN_NO_AUTOPILOT_INSTALL=1 \
    GBRAIN_NO_ONBOARD_NUDGE=1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
