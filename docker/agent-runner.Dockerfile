# syntax=docker/dockerfile:1.7
# brainstand agent-runner image: the model harness, exactly pinned, plus the
# runner's own entrypoint. No gbrain, no ops sidecar, no control-plane server.
#
# G1: HARNESS_VERSION is an exact semver ARG. A moving ref in an image build is
# non-reproducible by construction -- never default this to latest-stable.
FROM oven/bun:1.3.13

ARG HARNESS_VERSION
RUN test -n "$HARNESS_VERSION" || (echo "HARNESS_VERSION build-arg is required" >&2; exit 1)

# tini: PID 1 for a process the runner SIGTERMs (D12's drain). ca-certificates:
# the harness talks TLS to the gateway and to gbrain's /mcp (D5/D6).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# `bun install -g` as root lands the binary under /root/.bun, and /root is mode
# 0700 -- so the non-root USER below gets `sh: 1: claude: Permission denied`.
# Relocating the global install prefix to /opt/harness is the whole fix, and
# BUN_INSTALL_BIN has to be pinned too: the base image sets it to /usr/local/bin,
# so without this line bun's global SYMLINK lands there while /opt/harness/bin
# never exists (measured, not assumed) and the PATH line below is dead weight.
ENV BUN_INSTALL=/opt/harness
ENV BUN_INSTALL_BIN=/opt/harness/bin
ENV PATH="/opt/harness/bin:${PATH}"

# World-readable in the SAME layer, so the non-root USER below can exec it. A
# separate `chmod -R` step re-snapshots the whole 230MB harness tree on every
# cold build (measured: 66s) to change nothing but mode bits.
RUN bun install -g "@anthropic-ai/claude-code@${HARNESS_VERSION}" \
 && chmod -R a+rX /opt/harness

# The installed package ships a proprietary notice (© Anthropic PBC, "SEE
# LICENSE IN LICENSE.md") -- not the MIT text gbrain carries. Ship what it
# ships, at a fixed path, and fail the build rather than ship nothing: same
# obligation, same gate as gbrain-base.Dockerfile.
RUN cp /opt/harness/install/global/node_modules/@anthropic-ai/claude-code/LICENSE.md /opt/harness-LICENSE \
 || find / -path /proc -prune -o -name LICENSE.md -path '*claude-code*' -print -quit \
    | xargs -r -I{} cp {} /opt/harness-LICENSE
RUN test -s /opt/harness-LICENSE

# Build-time smoke gate: a bad pin fails the BUILD, not the deploy.
# `claude --version` prints "2.1.274 (Claude Code)" -- the version is the FIRST
# whitespace-separated token, where gbrain's is the LAST. $1, not $NF.
RUN claude --version | tee /opt/harness-version.txt \
 && awk -v v="${HARNESS_VERSION}" '$1 == v { ok = 1 } END { exit !ok }' /opt/harness-version.txt

# D4: a harness that updates itself at 3am is a moving pin with extra steps, and
# telemetry from a container holding an org's keys is an egress the fence (D6)
# would otherwise have to explain. Every name below was read out of the pinned
# binary itself, never guessed: `DISABLE_AUTOUPDATER`/`DISABLE_UPDATES` are the
# updater guards, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` forces the
# "essential-traffic" privacy mode, and `DISABLE_TELEMETRY` / `DISABLE_ERROR_REPORTING`
# / `DO_NOT_TRACK` are the telemetry and error-reporting guards.
ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_UPDATES=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_TELEMETRY=1 \
    DO_NOT_TRACK=1 \
    DISABLE_ERROR_REPORTING=1

# Asserted at build: deleting one of those lines is a silent regression that no
# runtime check would ever catch, because the harness would simply phone home.
RUN test "$DISABLE_AUTOUPDATER" = 1 \
 && test "$DISABLE_UPDATES" = 1 \
 && test "$CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" = 1 \
 && test "$DISABLE_TELEMETRY" = 1 \
 && test "$DO_NOT_TRACK" = 1 \
 && test "$DISABLE_ERROR_REPORTING" = 1

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# The whole src tree, not just src/runner: the runner's runtime closure already
# crosses out of its own directory (Task 8 redacts frames with `scrubOutput`
# from src/docker/host.ts, and the run vocabulary lives in src/agent/types.ts).
# A COPY list would break this image the first time a sibling adds an import,
# and it would break it silently -- the container would die at claim time, not
# at build time. Same choice control-plane.Dockerfile makes.
COPY src ./src

# Non-root, agreeing with Task 3's `user: "10001:10001"`. /opt/harness is
# already world-readable from the install layer above, which is what lets this
# USER exec the harness at all.
RUN groupadd --gid 10001 runner \
 && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/runner --shell /usr/sbin/nologin runner
# Explicit, and deliberately unwritable at runtime: the runner's only tmpfs is
# /tmp (D6/Task 3), so /home/runner sits on the read-only rootfs. P5 measured
# that a `claude -p` run does not need a writable HOME, and the harness itself is
# under /opt/harness -- which is what makes a tmpfs at $HOME harmless rather than
# fatal (the P5 failure mode).
ENV HOME=/home/runner
USER 10001:10001

# The gate above ran as root. This one proves the USER the compose file runs as
# can exec the harness -- the /root/.bun failure mode is a permission error at
# exec time, not a version mismatch, and only a non-root gate catches it.
RUN claude --version | awk -v v="${HARNESS_VERSION}" '$1 == v { ok = 1 } END { exit !ok }'

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "/app/src/runner/main.ts"]
