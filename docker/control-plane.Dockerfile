# syntax=docker/dockerfile:1.7
# One image, two entrypoints (S2): gbrain-ops runs src/ops/server.ts, the
# control plane runs src/control/app.ts. Same image means GBRAIN_VERSION
# guarantees the sidecar binary IS the server binary — version skew between
# wrapper and gbrain is exactly the bug class the exact pin exists to prevent.
ARG GBRAIN_VERSION=0.50.0.0
FROM brainstand/gbrain-base:${GBRAIN_VERSION}
ARG GBRAIN_VERSION

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY contracts ./contracts

RUN test -s "contracts/v${GBRAIN_VERSION}/operations.json" \
 || (echo "operations.json missing for ${GBRAIN_VERSION} — run Slice 0 first" >&2; exit 1)

COPY vite.config.ts ./
RUN bun install --frozen-lockfile && bunx vite build && rm -rf node_modules \
 && bun install --frozen-lockfile --production

ENV NODE_ENV=production
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "/app/src/control/app.ts"]
