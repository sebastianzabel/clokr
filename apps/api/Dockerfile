# ── Stage 1: Install dependencies ───────────────────────────────────────────
FROM node:24-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/db/package.json ./packages/db/
COPY packages/types/package.json ./packages/types/

# Install deps — use --ignore-scripts to prevent QEMU crashes with native modules (sharp)
# during cross-platform builds. Native binaries are rebuilt in the runtime stage.
RUN pnpm install --frozen-lockfile --ignore-scripts

# ── Stage 2: Build ──────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app

COPY packages/types/ ./packages/types/
COPY packages/db/ ./packages/db/
COPY apps/api/ ./apps/api/

# Generate Prisma client
RUN cd packages/db && npx prisma generate

# Build API
RUN pnpm --filter @clokr/api build

# ── Stage 3: Production runtime ────────────────────────────────────────────
FROM node:24-alpine AS runtime
RUN apk update && apk upgrade --no-cache && apk add --no-cache su-exec
# Update npm's bundled dependencies to fix CVEs in minimatch/tar
RUN npm install -g npm@latest 2>/dev/null || true
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

# Copy full workspace from build (Prisma db push + seed need all deps at startup)
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/apps/api/ ./apps/api/
COPY --from=build /app/packages/ ./packages/
COPY --from=build /app/package.json ./
COPY --from=build /app/pnpm-workspace.yaml ./
COPY --from=build /app/pnpm-lock.yaml ./

# Rebuild native modules (sharp, prisma) for the runtime platform
# This ensures correct binaries after cross-platform build with --ignore-scripts
RUN pnpm rebuild sharp 2>/dev/null || npm rebuild sharp 2>/dev/null || true

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
