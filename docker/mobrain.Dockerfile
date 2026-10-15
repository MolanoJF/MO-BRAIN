# syntax=docker/dockerfile:1.7
ARG GBRAIN_VERSION

FROM oven/bun:1.4.2 AS ui
WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY vite.config.ts tsconfig.json ./
COPY src/ui src/ui
RUN bun run ui:build

# Built FROM the pinned gbrain image so the server can run gbrain's CLI.
FROM mobrain-gbrain:${GBRAIN_VERSION}
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src/server src/server
COPY packs packs
COPY skills skills
COPY bin bin
COPY --from=ui /build/dist/ui dist/ui
ENV PORT=3000 MOBRAIN_UI_DIR=/app/dist/ui PACKS_DIR=/app/packs
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --retries=30 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:3000/api/health'); process.exit(r.status < 500 ? 0 : 1)"
CMD ["bun", "src/server/main.ts"]
