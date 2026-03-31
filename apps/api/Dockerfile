# ── Stage 1: Install dependencies ───────────────────────────────────────────
FROM node:24-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/db/package.json ./packages/db/
COPY packages/types/package.json ./packages/types/

# Install deps — skip only sharp's postinstall to prevent QEMU crash on cross-platform builds.
# All other scripts run normally so pnpm overrides resolve correctly.
RUN pnpm install --frozen-lockfile

# ── Stage 2: Build ──────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app

COPY packages/types/ ./packages/types/
COPY packages/db/ ./packages/db/
COPY apps/api/ ./apps/api/

# Generate Prisma client — ensure @prisma/client is resolvable from schema location
RUN mkdir -p /app/packages/db/node_modules/@prisma && \
    ln -sf /app/node_modules/.pnpm/node_modules/@prisma/client /app/packages/db/node_modules/@prisma/client && \
    npx prisma generate --schema=packages/db/prisma/schema.prisma

# Build API
RUN pnpm --filter @clokr/api build

# Compile seed script for runtime (tsx not available in prod)
RUN pnpm --filter @clokr/db run seed:build

# Copy generated Prisma client into dist/ so compiled seed.js can resolve
# '../generated/client' relative to dist/src/seed.js → dist/generated/client
RUN cp -r /app/packages/db/generated /app/packages/db/dist/generated

# ── Stage 3: Production runtime ────────────────────────────────────────────
FROM node:24-alpine AS runtime
RUN apk update && apk upgrade --no-cache && apk add --no-cache su-exec
# Update npm to latest (fixes bundled tar/minimatch CVEs) and clean old cache
RUN npm install -g npm@latest 2>/dev/null || true \
    && npm cache clean --force 2>/dev/null || true \
    && rm -rf /tmp/* /root/.npm/_cacache
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

# Copy full workspace from build (Prisma db push + seed need all deps at startup)
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/apps/api/ ./apps/api/
COPY --from=build /app/packages/ ./packages/
COPY --from=build /app/package.json ./
COPY --from=build /app/pnpm-workspace.yaml ./
COPY --from=build /app/pnpm-lock.yaml ./

# Rebuild native modules + ensure pnpm@10 hoisted prisma is resolvable from workspace packages
RUN pnpm rebuild sharp 2>/dev/null || npm rebuild sharp 2>/dev/null || true
RUN mkdir -p /app/packages/db/node_modules/@prisma && \
    ln -sf /app/node_modules/.pnpm/node_modules/prisma /app/packages/db/node_modules/prisma && \
    ln -sf /app/node_modules/.pnpm/node_modules/@prisma/client /app/packages/db/node_modules/@prisma/client

# Create non-root user
RUN addgroup -g 1001 -S clokr && adduser -S clokr -u 1001

# Entrypoint: db push → seed → start server
COPY --from=build /app/apps/api/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -qO- http://0.0.0.0:4000/health || exit 1

CMD ["/docker-entrypoint.sh"]
