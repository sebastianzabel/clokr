# ── Stage 1: Install dependencies ───────────────────────────────────────────
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/db/package.json ./packages/db/
COPY packages/types/package.json ./packages/types/

RUN pnpm install --frozen-lockfile

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
FROM node:22-alpine AS runtime
RUN apk add --no-cache su-exec
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# Copy full workspace from build (Prisma db push + seed need all deps at startup)
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/apps/api/ ./apps/api/
COPY --from=build /app/packages/ ./packages/
COPY --from=build /app/package.json ./
COPY --from=build /app/pnpm-workspace.yaml ./
COPY --from=build /app/pnpm-lock.yaml ./

# Create non-root user
RUN addgroup -g 1001 -S clokr && adduser -S clokr -u 1001

# Entrypoint: db push → seed → start server
COPY apps/api/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -qO- http://0.0.0.0:4000/health || exit 1

CMD ["/docker-entrypoint.sh"]
