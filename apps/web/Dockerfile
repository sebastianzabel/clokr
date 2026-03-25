# ── Stage 1: Install dependencies ───────────────────────────────────────────
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/types/package.json ./packages/types/

RUN pnpm install --frozen-lockfile

# ── Stage 2: Build ──────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app

COPY packages/types/ ./packages/types/
COPY apps/web/ ./apps/web/

RUN pnpm --filter @clokr/web build

# ── Stage 3: Production runtime ────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# Copy full workspace (adapter-node needs external deps like date-fns)
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/apps/web/node_modules/ ./apps/web/node_modules/
COPY --from=build /app/apps/web/build/ ./apps/web/build/
COPY --from=build /app/apps/web/package.json ./apps/web/
COPY --from=build /app/package.json ./
COPY --from=build /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages/types/package.json ./packages/types/

# Create non-root user
RUN addgroup -g 1001 -S clokr && adduser -S clokr -u 1001

ENV NODE_ENV=production
ENV PORT=3000
ENV API_URL=http://api:4000

USER clokr
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/ || exit 1

CMD ["node", "apps/web/build/index.js"]
