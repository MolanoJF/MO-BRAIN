# syntax=docker/dockerfile:1.7
# Built FROM the pinned gbrain image so the server can run gbrain's CLI.
# bin/mobrain builds the gbrain image first; compose builds are not ordered.
ARG GBRAIN_VERSION
FROM mobrain-gbrain:${GBRAIN_VERSION}

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src/server src/server
COPY packs packs
COPY skills skills
COPY bin bin

ENV PORT=3000 MOBRAIN_UI_DIR=/app/dist/ui
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --retries=30 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:3000/api/health'); process.exit(r.status < 500 ? 0 : 1)"
CMD ["bun", "src/server/main.ts"]
