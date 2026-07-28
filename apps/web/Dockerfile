# ── Stage 1: Install dependencies ───────────────────────────────────────────
FROM node:24-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/db/package.json ./packages/db/
COPY packages/types/package.json ./packages/types/

RUN pnpm install --frozen-lockfile

# ── Stage 2: Build ──────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app

COPY packages/types/ ./packages/types/
COPY apps/web/ ./apps/web/

RUN pnpm --filter @clokr/web build

# ── Stage 3: Production runtime ────────────────────────────────────────────
FROM node:24-alpine AS runtime
# apk upgrade pulls the latest Alpine packages; the explicit min-version pins assert the
# openssl/musl CVE fixes and bust any cached layer (CVE-2026-31789 CRIT heap overflow +
# CVE-2026-28387/28388/28389/28390 + CVE-2026-45447 openssl; CVE-2026-40200 musl).
RUN apk update && apk upgrade --no-cache \
    && apk add --no-cache "libcrypto3>=3.5.7-r0" "libssl3>=3.5.7-r0" "musl>=1.2.6-r2"
# Update npm's bundled dependencies to fix CVEs in minimatch/tar
RUN npm install -g npm@latest 2>/dev/null || true
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
  CMD wget -qO- http://127.0.0.1:3000/ || exit 1

CMD ["node", "apps/web/build/index.js"]
