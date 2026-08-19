# ── Stage 1: Install dependencies ───────────────────────────────────────────
FROM node:24-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/db/package.json ./packages/db/
COPY packages/types/package.json ./packages/types/

# Install deps. pnpm 10 blocks ALL dependency build scripts by default; the
# onlyBuiltDependencies allowlist in pnpm-workspace.yaml permits exactly the Prisma
# packages (@prisma/engines, prisma), which is what materializes the schema-engine
# binary at install time. sharp deliberately stays OFF that allowlist — its postinstall
# crashes under QEMU on this cross-platform (linux/amd64,linux/arm64) build.
RUN pnpm install --frozen-lockfile

# Build gate: Prisma's schema-engine binary MUST be materialized at install time.
# pnpm 10 blocks dependency build scripts by default; without the onlyBuiltDependencies
# allowlist in pnpm-workspace.yaml, @prisma/engines' postinstall never runs, the binary is
# missing, and `prisma migrate deploy` tries to download it from binaries.prisma.sh at
# container start. That is what crash-looped release 1.9.15 on int (no cluster egress,
# ECONNRESET). Do not remove this check — it is the only thing that catches the regression
# before the image ships.
RUN test -n "$(find /app/node_modules -name 'schema-engine*' -type f -print -quit)" \
    || (echo "FATAL: no Prisma schema-engine binary in /app/node_modules — check onlyBuiltDependencies in pnpm-workspace.yaml" >&2; exit 1)

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
# apk upgrade pulls the latest Alpine packages; the explicit min-version pins assert the
# openssl/musl CVE fixes and bust any cached layer (CVE-2026-31789 CRIT heap overflow +
# CVE-2026-28387/28388/28389/28390 + CVE-2026-45447 openssl; CVE-2026-40200 musl).
RUN apk update && apk upgrade --no-cache \
    && apk add --no-cache su-exec "libcrypto3>=3.5.7-r0" "libssl3>=3.5.7-r0" "musl>=1.2.6-r2"
# Update npm to latest (fixes bundled tar/minimatch CVEs) and clean old cache
RUN npm install -g npm@latest 2>/dev/null || true \
    && npm cache clean --force 2>/dev/null || true \
    && rm -rf /tmp/* /root/.npm/_cacache
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app

# Copy full workspace from build (Prisma db push + seed need all deps at startup).
# IMPORTANT: dev deps (tsx, prisma CLI) are retained in node_modules because the
# `deps` stage runs `pnpm install` BEFORE NODE_ENV=production is set. This is
# intentional and required by:
#   - docker-entrypoint.sh (uses prisma CLI for db push / migrate deploy)
#   - apps/api/scripts/anonymize-dump.ts (Phase 72 k3s CronJob, invokes `pnpm tsx`)
# If you later switch to `pnpm install --prod`, ensure tsx + prisma stay available
# (either move to dependencies or pre-compile scripts/anonymize-dump.ts).
COPY --from=build /app/node_modules/ ./node_modules/

# Build gate (see the identical check in the deps stage): assert the schema-engine binary
# actually survived the COPY into the runtime stage. The container has no egress to
# binaries.prisma.sh, so a missing binary here = crash loop at `prisma migrate deploy`.
RUN test -n "$(find /app/node_modules -name 'schema-engine*' -type f -print -quit)" \
    || (echo "FATAL: Prisma schema-engine binary missing in runtime node_modules" >&2; exit 1)

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
